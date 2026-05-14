# TubeInspect Monorepo

This repository is now organized into two main folders:

- `frontend/` — all React/Vite frontend code, assets, and Vercel deployment config.
- `backend/` — all Python backend code, API helpers, and backend deployment config.

## Frontend

The frontend lives in `frontend/`.

Key files:

- `frontend/package.json` — frontend dependencies and scripts
- `frontend/vite.config.ts` — Vite config
- `frontend/vercel.json` — Vercel build settings for the frontend
- `frontend/src/` — React application source code
- `frontend/public/` — static assets

Deploy this folder as a separate frontend project in Vercel, or set the Vercel root directory to `frontend/`.

## Backend

The backend lives in `backend/`.

Key files:

- `backend/app.py` — Flask backend API
- `backend/requirements.txt` — Python dependencies
- `backend/runtime.txt` — Python runtime config for deployments
- `backend/render.yaml` — example Render deployment config
- `backend/api/download.py` — optional serverless downloader helper moved under backend

This backend can be hosted separately (for example with Render.com), and the frontend should use `VITE_API_BASE` or localStorage to point to the backend URL.

## Notes

- `frontend/src/services/downloader.ts` uses `VITE_API_BASE` or localStorage to find the backend.
- Keep the backend service running separately from the frontend for reliable downloader and metadata proxy behavior.

If you want, I can also update the repo with a simple monorepo root `package.json` or set up a `frontend/`-only Vercel project configuration.
