"""
TubeInspect Downloader Backend
Standalone Flask API designed to run on Render.com (or any Python host)
that supports yt-dlp with full JS runtime + curl-cffi TLS impersonation.

Endpoints:
  GET /              → Health check
  GET /api/formats   → List available formats for a video
  GET /api/stream    → Resolve & proxy the actual stream bytes
"""

import json
import os
import re
import time
import urllib.request
from urllib.parse import quote

from flask import Flask, request, Response, jsonify, stream_with_context
from flask_cors import CORS

import yt_dlp

app = Flask(__name__)
# CORS on every route, including the root health check.
# We allow all origins because the API has no auth and is read-only.
CORS(
    app,
    resources={r"/*": {"origins": "*"}},
    expose_headers=["Content-Disposition", "Content-Length", "Content-Type"],
    allow_headers=["Content-Type", "Range", "Accept"],
    methods=["GET", "POST", "OPTIONS"],
    supports_credentials=False,
)

# ─── Constants ─────────────────────────────────────────────
CHUNK = 64 * 1024  # 64 KB

VIDEO_LABELS = {
    "4320": "8K Ultra HD",
    "2160": "4K Ultra HD",
    "1440": "2K QHD",
    "1080": "Full HD",
    "720":  "HD",
    "480":  "Standard",
    "360":  "Low",
    "240":  "Very Low",
    "144":  "Minimum",
}

CLIENT_STRATEGIES = [
    "android_vr,web_embedded",
    "default,-tv,web_safari,web_embedded",
    "default,-tv",
    "web_embedded,default,-tv,web_safari",
    "android,web_embedded,default",
    "ios,default",
]

# ─── yt-dlp helpers ────────────────────────────────────────
def build_opts(client_str: str, fmt: str | None = None) -> dict:
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
                "player_skip": ["webpage", "configs"],
                "skip_manifests": ["dash", "hls"],
            }
        },
    }
    if fmt:
        opts["format"] = fmt
    return opts


def is_fatal(err: str) -> bool:
    e = err.lower()
    return "video is private" in e or "has been removed" in e


# ─── Format extraction ─────────────────────────────────────
def extract_formats(video_id: str) -> dict:
    url = f"https://www.youtube.com/watch?v={video_id}"
    last_error = "Unknown"

    for i, client_str in enumerate(CLIENT_STRATEGIES):
        if i > 0:
            time.sleep(0.5 * (i + 1))
        try:
            with yt_dlp.YoutubeDL(build_opts(client_str)) as ydl:
                info = ydl.extract_info(url, download=False)

            title     = info.get("title", f"video-{video_id}")
            duration  = info.get("duration", 0) or 0
            thumbnail = info.get("thumbnail", "")
            uploader  = info.get("uploader") or info.get("channel", "Unknown")
            raw       = info.get("formats", [])

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
                    "label":        VIDEO_LABELS.get(hs, f"{hs}p"),
                    "resolution":   f"{hs}p",
                    "ext":          f.get("ext", "mp4"),
                    "vcodec":       (f.get("vcodec") or "mp4").split(".")[0],
                    "acodec":       f.get("acodec", "none"),
                    "filesize":     f.get("filesize") or f.get("filesize_approx"),
                    "fps":          f.get("fps"),
                    "ytdlp_format": f"bv[height={h}]+ba/bv[height<={h}]+ba/best",
                    "client":       client_str,
                })

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
                }
            last_error = f"Client '{client_str}' returned no video formats."

        except yt_dlp.utils.DownloadError as e:
            last_error = str(e)
            if is_fatal(last_error):
                break
            continue
        except Exception as e:
            last_error = str(e)
            continue

    raise Exception(last_error)


# ─── Stream resolver ────────────────────────────────────────
def resolve_stream(video_id: str, fmt: str, preferred_client: str):
    url = f"https://www.youtube.com/watch?v={video_id}"
    strategies = [preferred_client] + [c for c in CLIENT_STRATEGIES if c != preferred_client]
    last_error = "Unknown"

    for i, client_str in enumerate(strategies):
        if i > 0:
            time.sleep(0.5 * (i + 1))
        try:
            with yt_dlp.YoutubeDL(build_opts(client_str, fmt)) as ydl:
                info = ydl.extract_info(url, download=False)

            title = re.sub(r'[\\/*?:"<>|]', "", info.get("title", f"video-{video_id}"))[:100]
            ext   = info.get("ext", "mp4")

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
            if is_fatal(last_error):
                break
            continue
        except Exception as e:
            last_error = str(e)
            continue

    raise Exception(last_error)


# ─── Routes ─────────────────────────────────────────────────
@app.route("/", methods=["GET", "OPTIONS"])
def health():
    response = jsonify({
        "service": "TubeInspect Downloader",
        "status":  "online",
        "yt_dlp":  yt_dlp.version.__version__,
    })
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.after_request
def add_cors_headers(response):
    """Belt-and-suspenders CORS — ensures every response gets the headers."""
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Range, Accept"
    response.headers["Access-Control-Expose-Headers"] = "Content-Disposition, Content-Length, Content-Type"
    return response


@app.route("/api/formats", methods=["GET"])
def formats():
    video_id = (request.args.get("id") or "").strip()
    if not video_id or not re.match(r"^[a-zA-Z0-9_-]{11}$", video_id):
        return jsonify({"ok": False, "error": "Invalid or missing video ID."}), 400

    try:
        return jsonify(extract_formats(video_id))
    except Exception as e:
        err = str(e).lower()
        if "private" in err or "removed" in err:
            return jsonify({"ok": False, "error": "This video is private or has been removed.", "code": "PRIVATE"}), 404
        if "age-restricted" in err or "age restricted" in err:
            return jsonify({"ok": False, "error": "This video is age-restricted.", "code": "AGE_RESTRICTED"}), 403
        if "not available" in err and "sign in" not in err:
            return jsonify({"ok": False, "error": "This video is not available in our region.", "code": "UNAVAILABLE"}), 404
        return jsonify({"ok": False, "error": f"Could not extract formats: {str(e)[:200]}"}), 500


@app.route("/api/stream", methods=["GET"])
def stream():
    video_id = (request.args.get("id")     or "").strip()
    fmt      = (request.args.get("fmt")    or "bv[height<=1080]+ba/best")
    client   = (request.args.get("client") or "android_vr,web_embedded")

    if not video_id or not re.match(r"^[a-zA-Z0-9_-]{11}$", video_id):
        return jsonify({"ok": False, "error": "Invalid video ID."}), 400

    try:
        stream_url, ext, title = resolve_stream(video_id, fmt, client)
    except Exception as e:
        err = str(e).lower()
        if "private" in err or "removed" in err:
            return jsonify({"ok": False, "error": "Video is private or removed."}), 404
        return jsonify({"ok": False, "error": "Could not stream this video."}), 500

    if not stream_url:
        return jsonify({"ok": False, "error": "Could not resolve stream URL."}), 500

    filename  = f"{title}.{ext}"
    safe_name = quote(filename, safe="")

    # Stream the bytes from YouTube CDN through Render to the browser
    yt_req = urllib.request.Request(
        stream_url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
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
                chunk = upstream.read(CHUNK)
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


# ─── Local dev runner ─────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=False)
