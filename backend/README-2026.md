# TubeInspect Downloader Backend — 2026 Edition

## What's New in 2026

YouTube has significantly increased bot detection and now requires **PO Tokens** (Proof of Origin) for most video downloads. This backend has been updated with the latest tools and strategies to handle:

| Issue | Solution |
|-------|----------|
| **Age-restricted videos** | `tv_embedded` client + optional cookies upload |
| **Region-locked videos** | Residential proxy support (env var) |
| **PO Token requirement** | `bgutil-ytdlp-pot-provider` plugin |
| **JS signature challenges** | Deno/Node runtime auto-detected |
| **SABR streaming blocks** | Multi-client fallback with `default,-tv,-android_sdkless` |

---

## Quick Start

### 1. Deploy to Render (free)

```bash
# Push to GitHub first
git add .
git commit -m "Deploy 2026 downloader backend"
git push
```

Then on [render.com](https://render.com):
1. **New** → **Web Service** → connect your repo
2. **Root Directory:** `backend`
3. **Build:** `pip install -r requirements.txt`
4. **Start:** `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120`
5. **Plan:** Free
6. Click **Create**

### 2. Set Environment Variables (optional but recommended)

In Render dashboard → **Environment**:

| Variable | Value | Purpose |
|----------|-------|---------|
| `YOUTUBE_API_KEY` | `AIzaSy...` | Enables metadata endpoint (full stats, tags, view counts) |
| `RESIDENTIAL_PROXY` | `socks5://user:pass@host:port` | Bypass region locks |
| `COOKIES_FILE` | `/path/to/cookies.txt` | Auto-bypass age restrictions |

### 3. Test It

```bash
# Health check
curl https://your-app.onrender.com/

# Get formats
curl "https://your-app.onrender.com/api/formats?id=dQw4w9WgXcQ"

# Upload cookies (for age-restricted videos)
curl -X POST -F "file=@cookies.txt" https://your-app.onrender.com/api/cookies
```

---

## Handling Problematic Videos

### Age-Restricted Videos

**Option A: Upload cookies via UI**
1. Install a browser extension like "Get cookies.txt LOCALLY" (Chrome/Firefox)
2. Go to YouTube, sign in to your account
3. Click extension → Export as Netscape format → save as `cookies.txt`
4. In the app's Configure panel, use the **Upload Cookies** button

**Option B: Set cookies on server**
1. Export cookies as above
2. In Render → **Files** (or use SFTP), upload `cookies.txt` to `/app/`
3. Set env var: `COOKIES_FILE=/app/cookies.txt`
4. Redeploy

**Option C: Use tv_embedded client** (works for ~70% of age-gated videos without cookies)
- Already built into the fallback chain — no action needed

### Region-Locked Videos

Set a residential proxy env var:
```
RESIDENTIAL_PROXY=socks5://username:password@residential-proxy.example.com:1080
```

Free options:
- **Windscribe** (free tier, 10GB/month)
- **ProtonVPN** (free tier, 3 countries)
- **Bright Data** (paid, but has free trial)

### "Sign in to confirm you're not a bot"

This means YouTube flagged the server IP. Solutions in order:

1. **Wait 4-12 hours** — temporary IP block
2. **Upload cookies** — proves you're a real user
3. **Use residential proxy** — different IP range
4. **Use yt-dlp locally** — your home IP is less likely to be flagged

---

## API Reference

### `GET /`
Health check with feature flags.

```json
{
  "service": "TubeInspect Downloader",
  "status": "online",
  "yt_dlp": "2026.2.21",
  "metadata_api": true,
  "age_bypass": true,
  "proxy_enabled": false,
  "pot_provider": true
}
```

### `GET /api/formats?id=VIDEO_ID`
Returns all available formats.

```json
{
  "ok": true,
  "video": [
    {"label": "4K Ultra HD", "height": 2160, "filesize": 524288000, ...}
  ],
  "audio": [...],
  "client_used": "default,-tv,-android_sdkless,web_safari,web_embedded"
}
```

**Error codes:**
- `PRIVATE` — Video is private/removed
- `AGE_RESTRICTED` — Requires cookies or logged-in account
- `REGION_LOCKED` — Not available in server's region
- `QUOTA` — YouTube API quota exhausted (metadata endpoint only)

### `GET /api/stream?id=VIDEO_ID&fmt=FORMAT&client=CLIENT_STR`
Streams the video/audio bytes to the browser.

### `POST /api/cookies`
Upload Netscape-format cookies for age-restricted videos.

```bash
curl -X POST -F "file=@cookies.txt" https://your-api/api/cookies
```

---

## Why Some Videos Still Fail

| Error | Why | Fix |
|-------|-----|-----|
| "Verify your age" | YouTube requires a logged-in account | Upload cookies |
| "Not available in your country" | Region lock | Use residential proxy |
| "Request format is not available" | PO token missing or IP flagged | Wait 4-12h, upload cookies, or use local yt-dlp |
| "SABR streaming" | YouTube forcing new protocol | Already handled — backend falls back to clients that don't use SABR |

---

## Local Development

```bash
cd backend
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
python app.py
```

Test with:
```bash
curl http://localhost:8000/api/formats?id=dQw4w9WgXcQ
```

---

## Credits & Resources

- [yt-dlp GitHub](https://github.com/yt-dlp/yt-dlp)
- [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [bgutil-ytdlp-pot-provider](https://pypi.org/project/bgutil-ytdlp-pot-provider/)
- [Export YouTube Cookies](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)

---

## Troubleshooting

**Q: "ModuleNotFoundError: No module named 'yt_dlp'"**
- Make sure you ran `pip install -r requirements.txt`
- On Render, check the build logs for pip errors

**Q: "gunicorn: command not found"**
- Add `gunicorn>=23.0.0` to requirements.txt
- Redeploy

**Q: "PO token failed"**
- Ensure Deno is installed on the server (Render auto-installs it)
- Update yt-dlp: `yt-dlp -U`

**Q: "Age-restricted even with cookies"**
- Cookies may be expired — re-export them
- Make sure you exported from a browser where you're logged into YouTube
- Try the `tv_embedded` client fallback (automatic)

---

**Last updated:** March 2026  
**yt-dlp version:** 2026.2.21+  
**Tested on:** Render.com free tier
