# TubeInspect Downloader Backend

A standalone Flask API that powers the in-app downloader for the TubeInspect frontend.
It uses **yt-dlp** with **curl-cffi** TLS impersonation and a multi-client fallback strategy
so most YouTube videos work — including ones that fail on Vercel's serverless functions.

## Deploy to Render.com (free, recommended)

Render uses different IP ranges than Vercel and is far less likely to be blocked by YouTube.

### Option A — One-click via Blueprint

1. Push this entire repo to GitHub
2. Go to **[render.com/dashboard](https://dashboard.render.com)** → **New** → **Blueprint**
3. Pick your GitHub repo
4. Render reads `backend/render.yaml` and deploys automatically
5. Copy the live URL (e.g. `https://tubeinspect-api.onrender.com`)
6. Set it as `VITE_API_BASE` in your frontend `.env`

### Option B — Manual setup

1. **[render.com/dashboard](https://dashboard.render.com)** → **New** → **Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Root directory:** `backend`
   - **Runtime:** Python
   - **Build command:** `pip install -r requirements.txt`
   - **Start command:** `gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120`
   - **Instance type:** Free
4. Click **Create Web Service**
5. Copy the live URL

## Deploy elsewhere

The same `app.py` works on any Python host:

| Platform   | Free tier | Notes |
|-----------|-----------|-------|
| Render    | ✅ Yes    | Free tier sleeps after 15 min inactivity |
| Koyeb     | ✅ Yes    | Always-on free tier |
| Railway   | ⚠️ $5 trial | $5/month after trial |
| Fly.io    | ❌ Paid   | $5/month |
| Replit    | ✅ Yes    | Always-on with paid plan |
| PythonAnywhere | ✅ Yes | Has YouTube blocked on free tier |
| **Local** | ✅ Always free | `python app.py` runs on `localhost:8000` |

## Local development

```bash
cd backend
pip install -r requirements.txt
python app.py
# API live at http://localhost:8000
```

Then in the frontend's `.env`:
```
VITE_API_BASE=http://localhost:8000
```

## Endpoints

- `GET /` — Health check
- `GET /api/formats?id=VIDEO_ID` — Returns available video/audio formats
- `GET /api/stream?id=VIDEO_ID&fmt=YT_DLP_FORMAT&client=CLIENT_STR` — Streams the file to the browser

## Free tier limitations

Render's free tier **sleeps after 15 min of inactivity**. The first request after sleep
takes ~30-60 seconds while it spins back up. For always-on hosting either upgrade to a
paid Render plan ($7/month) or try Koyeb's free tier.
