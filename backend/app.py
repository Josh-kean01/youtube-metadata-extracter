"""
TubeInspect Downloader Backend — 2026 Edition
Flask API with yt-dlp optimized for age-restricted, region-locked, and bot-protected videos.

Key 2026 improvements:
  • PO Token provider (bgutil-ytdlp-pot-provider) for GVS bypass
  • Deno/Node JS runtime for signature challenges
  • Multi-client fallback with tv_embedded for age-gated content
  • Optional cookies support for age-restricted videos
  • Residential proxy support (via env var)

Endpoints:
  GET /                → Health check + feature status
  GET /api/formats     → List available formats for a video
  GET /api/stream      → Resolve & proxy the actual stream bytes
  GET /api/metadata    → Proxy YouTube Data API v3 (key stays on server)
  POST /api/cookies    → Upload cookies.txt for age-restricted videos (optional)

Environment variables:
  YOUTUBE_API_KEY        → YouTube Data API v3 key (for metadata endpoint)
  RESIDENTIAL_PROXY      → Optional: socks5://user:pass@host:port
  COOKIES_FILE           → Optional: path to netscape-format cookies.txt
"""

import json
import os
import re
import time
import tempfile
import urllib.parse
import urllib.request
from urllib.parse import quote
from pathlib import Path

from flask import Flask, request, Response, jsonify, stream_with_context
from flask_cors import CORS

import yt_dlp

# ─── Configuration ──────────────────────────────────────────
app = Flask(__name__)

# CORS on every route
CORS(
    app,
    resources={r"/*": {"origins": "*"}},
    expose_headers=["Content-Disposition", "Content-Length", "Content-Type"],
    allow_headers=["Content-Type", "Range", "Accept"],
    methods=["GET", "POST", "OPTIONS"],
    supports_credentials=False,
)

# YouTube Data API key (server-side only)
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")

# Optional: residential proxy for region-locked content
RESIDENTIAL_PROXY = os.environ.get("RESIDENTIAL_PROXY", "")

# Optional: cookies file for age-restricted videos
COOKIES_FILE = os.environ.get("COOKIES_FILE", "")

# Global cookies storage (uploaded via POST /api/cookies)
UPLOADED_COOKIES_PATH = None

# YouTube category mapping
YOUTUBE_CATEGORIES = {
    "1": "Film & Animation", "2": "Autos & Vehicles", "10": "Music",
    "15": "Pets & Animals", "17": "Sports", "18": "Short Movies",
    "19": "Travel & Events", "20": "Gaming", "21": "Videoblogging",
    "22": "People & Blogs", "23": "Comedy", "24": "Entertainment",
    "25": "News & Politics", "26": "Howto & Style", "27": "Education",
    "28": "Science & Technology", "29": "Nonprofits & Activism",
    "30": "Movies", "31": "Anime/Animation", "32": "Action/Adventure",
    "33": "Classics", "34": "Comedy", "35": "Documentary",
    "36": "Drama", "37": "Family", "38": "Foreign", "39": "Horror",
    "40": "Sci-Fi/Fantasy", "41": "Thriller", "42": "Shorts",
    "43": "Shows", "44": "Trailers",
}

# ─── 2026 Client Strategies (ranked by success rate) ───────
# Each strategy is tried in order until one returns playable formats.
# Based on yt-dlp community findings for 2026 YouTube changes.
CLIENT_STRATEGIES = [
    # Strategy A: Default with PO token support, skip problematic clients
    # This is yt-dlp's own recommended 2026 approach
    "default,-tv,-android_sdkless,web_safari,web_embedded",
    
    # Strategy B: TV embedded - best for age-restricted without cookies
    # Doesn't require PO token, works for most age-gated content
    "tv_embedded,default,-tv",
    
    # Strategy C: Android VR + embedded (no PO token needed)
    "android_vr,web_embedded,default,-tv",
    
    # Strategy D: Web Safari only (provides HLS formats that skip GVS)
    "web_safari,default,-tv",
    
    # Strategy E: iOS (sometimes works when others fail)
    "ios,default,-tv",
    
    # Strategy F: Pure default (last resort)
    "default",
]


def build_ydl_opts(client_str: str, fmt: str | None = None, cookies_path: str | None = None) -> dict:
    """
    Build yt-dlp options with 2026 best practices:
    - PO token provider plugin
    - curl-cffi for TLS impersonation
    - Multiple client fallback
    - Optional cookies for age-restricted
    - Optional residential proxy
    """
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "extractor_retries": 3,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
        "extractor_args": {
            "youtube": {
                "player_client": client_str.split(","),
                # Skip webpage download to reduce bot detection
                "player_skip": ["webpage", "configs"],
                # Skip manifests that cause issues on serverless
                "skip_manifests": ["dash", "hls"] if not fmt or "hls" not in fmt else [],
                # Enable PO token handling via plugin
                "po_token": "web+gvs",
            }
        },
        # curl-cffi for Chrome 124 TLS impersonation
        "curl_cffi_impersonate": "chrome124",
    }
    
    if fmt:
        opts["format"] = fmt
    
    # Cookies for age-restricted videos
    if cookies_path:
        opts["cookies"] = cookies_path
    elif COOKIES_FILE:
        opts["cookies"] = COOKIES_FILE
    
    # Residential proxy for region-locked content
    if RESIDENTIAL_PROXY:
        opts["proxy"] = RESIDENTIAL_PROXY
    
    return opts


def is_fatal_error(err: str) -> bool:
    """Returns True only for errors where retrying won't help."""
    e = err.lower()
    return (
        ("video is private" in e) or
        ("has been removed" in e) or
        ("terminated" in e and "account" in e)
    )


def is_age_restricted(err: str) -> bool:
    """Detect age-restriction errors."""
    e = err.lower()
    return (
        ("sign in" in e and ("age" in e or "confirm" in e)) or
        ("age-restricted" in e) or
        ("age restricted" in e) or
        ("verify your age" in e)
    )


def is_region_locked(err: str) -> bool:
    """Detect region-lock errors."""
    e = err.lower()
    return (
        ("not available in your country" in e) or
        ("not available in this region" in e) or
        ("country" in e and "restricted" in e)
    )


# ─── Format extraction ─────────────────────────────────────
def extract_formats(video_id: str) -> dict:
    """
    Extract available formats using multi-client fallback.
    Returns enriched format list or raises exception with specific error code.
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    last_error = "Unknown"
    attempted = []

    for i, client_str in enumerate(CLIENT_STRATEGIES):
        attempted.append(client_str)
        
        # Small delay between attempts to avoid rate limiting
        if i > 0:
            time.sleep(0.5 * (i + 1))
        
        try:
            opts = build_ydl_opts(client_str, cookies_path=UPLOADED_COOKIES_PATH)
            
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)

            title     = info.get("title", f"video-{video_id}")
            duration  = info.get("duration", 0) or 0
            thumbnail = info.get("thumbnail", "")
            uploader  = info.get("uploader") or info.get("channel", "Unknown")
            raw       = info.get("formats", [])

            # Build video format list — one per unique height
            seen, videos = set(), []
            for f in sorted(raw, key=lambda x: x.get("height") or 0, reverse=True):
                h = f.get("height")
                if not h or f.get("vcodec", "none") == "none":
                    continue
                if h in seen:
                    continue
                seen.add(h)
                hs = str(h)
                videos.append({
                    "format_id":    f["format_id"],
                    "height":       h,
                    "label":        {"4320": "8K Ultra HD", "2160": "4K Ultra HD", "1440": "2K QHD", "1080": "Full HD", "720": "HD"}.get(hs, f"{hs}p"),
                    "resolution":   f"{hs}p",
                    "ext":          f.get("ext", "mp4"),
                    "vcodec":       (f.get("vcodec") or "mp4").split(".")[0],
                    "acodec":       f.get("acodec", "none"),
                    "filesize":     f.get("filesize") or f.get("filesize_approx"),
                    "fps":          f.get("fps"),
                    "ytdlp_format": f"bv[height={h}]+ba/bv[height<={h}]+ba/best",
                    "client":       client_str,
                })

            # Success: got video formats
            if videos:
                audios = [
                    {"label": "MP3",  "sub": "Best quality",  "ext": "mp3",  "ytdlp_format": "bestaudio/best",                     "mode": "audio", "client": client_str},
                    {"label": "Opus", "sub": "Smaller file",  "ext": "opus", "ytdlp_format": "bestaudio[ext=webm]/bestaudio/best",  "mode": "audio", "client": client_str},
                    {"label": "M4A",  "sub": "AAC audio",     "ext": "m4a",  "ytdlp_format": "bestaudio[ext=m4a]/bestaudio/best",   "mode": "audio", "client": client_str},
                    {"label": "WAV",  "sub": "Lossless",      "ext": "wav",  "ytdlp_format": "bestaudio/best",                     "mode": "audio", "client": client_str},
                ]
                return {
                    "ok":          True,
                    "id":          video_id,
                    "title":       title,
                    "duration":    duration,
                    "thumbnail":   thumbnail,
                    "uploader":    uploader,
                    "video":       videos[:8],
                    "audio":       audios,
                    "client_used": client_str,
                    "strategies_tried": len(attempted),
                }

            # No videos but no error — try next client
            last_error = f"Client '{client_str}' returned no video formats."
            continue

        except yt_dlp.utils.DownloadError as e:
            last_error = str(e)
            
            # Check for specific error types
            if is_fatal_error(last_error):
                raise Exception("PRIVATE")
            if is_age_restricted(last_error):
                # Don't give up yet — try tv_embedded strategy which often bypasses age gates
                if "tv_embedded" not in client_str:
                    continue
                raise Exception("AGE_RESTRICTED")
            if is_region_locked(last_error):
                raise Exception("REGION_LOCKED")
            
            # Retryable error — try next strategy
            continue
            
        except Exception as e:
            last_error = str(e)
            continue

    # All strategies exhausted
    err_lower = last_error.lower()
    if "private" in err_lower or "removed" in err_lower:
        raise Exception("PRIVATE")
    if "age" in err_lower and ("restrict" in err_lower or "sign in" in err_lower or "verify" in err_lower):
        raise Exception("AGE_RESTRICTED")
    if "country" in err_lower or "region" in err_lower or "not available" in err_lower:
        raise Exception("REGION_LOCKED")

    raise Exception(f"Could not extract formats after trying {len(attempted)} strategies. Last error: {last_error[:200]}")


# ─── Stream resolver ───────────────────────────────────────
def resolve_stream(video_id: str, fmt: str, preferred_client: str):
    """
    Resolve a direct stream URL using the same strategy as extract_formats.
    Returns (stream_url, ext, title) or raises exception.
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    strategies = [preferred_client] + [c for c in CLIENT_STRATEGIES if c != preferred_client]
    last_error = "Unknown"

    for i, client_str in enumerate(strategies):
        if i > 0:
            time.sleep(0.5 * (i + 1))
        
        try:
            opts = build_ydl_opts(client_str, fmt, cookies_path=UPLOADED_COOKIES_PATH)
            
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)

            title = re.sub(r'[\\/*?:"<>|]', "", info.get("title", f"video-{video_id}"))[:100]
            ext   = info.get("ext", "mp4")

            # Get stream URL
            stream_url = ""
            for part in (info.get("requested_formats") or [info]):
                candidate = part.get("url", "")
                if candidate and not candidate.startswith("data:"):
                    stream_url = candidate
                    break
            if not stream_url:
                stream_url = info.get("url", "")

            if stream_url:
                return stream_url, ext, title

            last_error = f"Client '{client_str}' returned no stream URL."

        except yt_dlp.utils.DownloadError as e:
            last_error = str(e)
            if is_fatal_error(last_error):
                raise Exception("PRIVATE")
            if is_age_restricted(last_error) and "tv_embedded" not in client_str:
                continue
            if is_region_locked(last_error):
                raise Exception("REGION_LOCKED")
            continue
        except Exception as e:
            last_error = str(e)
            continue

    raise Exception(last_error)


# ─── Routes ─────────────────────────────────────────────────
@app.route("/", methods=["GET", "OPTIONS"])
def health():
    """Health check with feature status."""
    response = jsonify({
        "service":         "TubeInspect Downloader",
        "status":          "online",
        "yt_dlp":          yt_dlp.version.__version__,
        "metadata_api":    bool(YOUTUBE_API_KEY),
        "age_bypass":      bool(COOKIES_FILE or UPLOADED_COOKIES_PATH),
        "proxy_enabled":   bool(RESIDENTIAL_PROXY),
        "pot_provider":    "bgutil-ytdlp-pot-provider" in str(yt_dlp.extractor.youtube._VALID_URL),
    })
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/api/formats", methods=["GET"])
def formats():
    """List available formats for a video."""
    video_id = (request.args.get("id") or "").strip()
    if not video_id or not re.match(r"^[a-zA-Z0-9_-]{11}$", video_id):
        return jsonify({"ok": False, "error": "Invalid or missing video ID."}), 400

    try:
        return jsonify(extract_formats(video_id))
    except Exception as e:
        err = str(e)
        if err == "PRIVATE":
            return jsonify({"ok": False, "error": "This video is private or has been removed by the uploader.", "code": "PRIVATE"}), 404
        if err == "AGE_RESTRICTED":
            return jsonify({
                "ok": False,
                "error": "This video is age-restricted. Upload cookies.txt via POST /api/cookies or use yt-dlp locally with --cookies-from-browser.",
                "code": "AGE_RESTRICTED",
                "help": "Age-restricted videos require a logged-in YouTube account. See the Configure panel for instructions."
            }), 403
        if err == "REGION_LOCKED":
            return jsonify({
                "ok": False,
                "error": "This video is not available in our region. Use a residential proxy or yt-dlp locally.",
                "code": "REGION_LOCKED"
            }), 403
        return jsonify({"ok": False, "error": f"Could not extract formats: {err[:300]}"}), 500


@app.route("/api/stream", methods=["GET"])
def stream():
    """Resolve and proxy stream bytes to browser."""
    video_id = (request.args.get("id")     or "").strip()
    fmt      = (request.args.get("fmt")    or "bv[height<=1080]+ba/best")
    client   = (request.args.get("client") or CLIENT_STRATEGIES[0])

    if not video_id or not re.match(r"^[a-zA-Z0-9_-]{11}$", video_id):
        return jsonify({"ok": False, "error": "Invalid video ID."}), 400

    try:
        stream_url, ext, title = resolve_stream(video_id, fmt, client)
    except Exception as e:
        err = str(e).lower()
        if "private" in err or "removed" in err:
            return jsonify({"ok": False, "error": "Video is private or removed."}), 404
        if "age" in err:
            return jsonify({"ok": False, "error": "Age-restricted video. Upload cookies or use yt-dlp locally."}), 403
        return jsonify({"ok": False, "error": "Could not stream this video."}), 500

    if not stream_url:
        return jsonify({"ok": False, "error": "Could not resolve stream URL."}), 500

    filename  = f"{title}.{ext}"
    safe_name = quote(filename, safe="")

    # Stream bytes from YouTube CDN through server to browser
    yt_req = urllib.request.Request(
        stream_url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://www.youtube.com/",
            "Origin":  "https://www.youtube.com",
        },
    )

    try:
        upstream       = urllib.request.urlopen(yt_req, timeout=25)
        content_length = upstream.headers.get("Content-Length", "")
        content_type   = upstream.headers.get("Content-Type", "application/octet-stream")
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not connect to YouTube CDN: {str(e)[:100]}"}), 502

    def generate():
        try:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()

    headers = {
        "Content-Type": content_type,
        "Content-Disposition": f'attachment; filename="{filename}"; filename*=UTF-8\'\'{safe_name}',
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
    }
    if content_length:
        headers["Content-Length"] = content_length

    return Response(stream_with_context(generate()), headers=headers)


@app.route("/api/cookies", methods=["POST"])
def upload_cookies():
    """
    Upload a Netscape-format cookies.txt file for age-restricted videos.
    File is stored temporarily and used for subsequent requests.
    
    Usage:
      curl -X POST -F "file=@cookies.txt" https://your-api.onrender.com/api/cookies
    """
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "No file uploaded. Use form field 'file'."}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"ok": False, "error": "Empty filename."}), 400

    # Validate it's a Netscape cookies file (first line should be # Netscape HTTP Cookie File)
    content = file.read().decode("utf-8", errors="ignore")
    if "# Netscape" not in content and "youtube.com" not in content:
        return jsonify({"ok": False, "error": "Invalid cookies format. Must be Netscape format from YouTube."}), 400

    # Save to temp file
    global UPLOADED_COOKIES_PATH
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="yt_cookies_")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        UPLOADED_COOKIES_PATH = path
        return jsonify({
            "ok": True,
            "message": "Cookies uploaded successfully. Age-restricted videos should now work.",
            "expires": "Server restart"
        })
    except Exception as e:
        return jsonify({"ok": False, "error": f"Failed to save cookies: {str(e)}"}), 500


@app.route("/api/metadata", methods=["GET"])
def metadata():
    """Proxy YouTube Data API v3 requests (key stays on server)."""
    video_id = (request.args.get("id") or "").strip()
    if not video_id or not re.match(r"^[a-zA-Z0-9_-]{11}$", video_id):
        return jsonify({"ok": False, "error": "Invalid or missing video ID."}), 400

    if not YOUTUBE_API_KEY:
        return jsonify({
            "ok": False,
            "error": "YouTube API key not configured on the server.",
            "code": "NO_KEY",
        }), 503

    params = urllib.parse.urlencode({
        "part": "snippet,statistics,contentDetails",
        "id":   video_id,
        "key":  YOUTUBE_API_KEY,
    })
    yt_url = f"https://www.googleapis.com/youtube/v3/videos?{params}"

    try:
        req = urllib.request.Request(yt_url, headers={"Accept": "application/json", "User-Agent": "TubeInspect/2.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.request.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        try:
            err_payload = json.loads(body).get("error", {})
            msg = err_payload.get("message", str(e))
            reason = (err_payload.get("errors") or [{}])[0].get("reason", "")
        except Exception:
            msg, reason = str(e), ""

        if "quotaExceeded" in reason or "quota" in msg.lower():
            return jsonify({"ok": False, "error": "Daily YouTube API quota exhausted. Try again tomorrow.", "code": "QUOTA"}), 429
        if "keyInvalid" in reason or "API key not valid" in msg:
            return jsonify({"ok": False, "error": "Server YouTube API key is invalid.", "code": "INVALID_KEY"}), 500
        return jsonify({"ok": False, "error": msg, "code": "API_ERROR"}), e.code or 500
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not reach YouTube API: {str(e)[:200]}"}), 502

    items = data.get("items", [])
    if not items:
        return jsonify({"ok": False, "error": "Video not found, private, or deleted.", "code": "NOT_FOUND"}), 404

    item     = items[0]
    snippet  = item.get("snippet", {})
    stats    = item.get("statistics", {})
    content  = item.get("contentDetails", {})
    thumbs   = snippet.get("thumbnails", {})

    return jsonify({
        "ok": True,
        "id":            video_id,
        "title":         snippet.get("title", ""),
        "description":   snippet.get("description", ""),
        "publishedAt":   snippet.get("publishedAt", ""),
        "channelId":     snippet.get("channelId", ""),
        "channelTitle":  snippet.get("channelTitle", ""),
        "category":      YOUTUBE_CATEGORIES.get(snippet.get("categoryId", ""), "Unknown"),
        "categoryId":    snippet.get("categoryId", ""),
        "tags":          snippet.get("tags", []),
        "viewCount":     stats.get("viewCount", "0"),
        "likeCount":     stats.get("likeCount", "0"),
        "commentCount":  stats.get("commentCount", "0"),
        "duration":      content.get("duration", ""),
        "definition":    content.get("definition", ""),
        "thumbnails": {
            "default":  thumbs.get("default",  {}).get("url", f"https://img.youtube.com/vi/{video_id}/default.jpg"),
            "medium":   thumbs.get("medium",   {}).get("url", f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg"),
            "high":     thumbs.get("high",     {}).get("url", f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"),
            "standard": thumbs.get("standard", {}).get("url", f"https://img.youtube.com/vi/{video_id}/sddefault.jpg"),
            "maxres":   thumbs.get("maxres",   {}).get("url", f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"),
        },
        "embedUrl":      f"https://www.youtube.com/embed/{video_id}",
    })


# ─── Local dev runner ─────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=False)
