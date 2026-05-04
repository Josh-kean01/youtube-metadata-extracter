/**
 * Download service.
 *
 * The Python backend (api/formats, api/stream) is hosted separately because
 * Vercel's serverless IPs are aggressively blocked by YouTube. By default we
 * point at the localStorage-saved backend URL, then env var, then same-origin.
 *
 * To configure: open the Configure panel in the Downloader UI and paste your
 * backend URL (e.g. https://tubeinspect-api.onrender.com).
 */

const ENV_API_BASE = (import.meta as any).env?.VITE_API_BASE || "";
const LS_KEY       = "tubeinspect_api_base";

export function getApiBase(): string {
  // 1. localStorage override (lets the user change without a redeploy)
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
  if (stored) return stored.replace(/\/$/, "");
  // 2. compile-time env var
  if (ENV_API_BASE) return ENV_API_BASE.replace(/\/$/, "");
  // 3. same-origin (works only if hosting backend together with frontend)
  return "";
}

export function setApiBase(url: string) {
  const cleaned = url.trim().replace(/\/$/, "");
  if (cleaned) localStorage.setItem(LS_KEY, cleaned);
  else         localStorage.removeItem(LS_KEY);
}

/* ─── Types ─────────────────────────────────────────────── */
export interface VideoFormat {
  format_id:    string;
  height:       number;
  label:        string;
  resolution:   string;
  ext:          string;
  vcodec:       string;
  acodec:       string;
  filesize?:    number;
  fps?:         number;
  ytdlp_format: string;
  client?:      string;
}

export interface AudioFormat {
  label:        string;
  sub:          string;
  ext:          string;
  ytdlp_format: string;
  mode:         "audio";
  client?:      string;
}

export interface VideoInfo {
  id:        string;
  title:     string;
  duration:  number;
  thumbnail: string;
  uploader:  string;
  video:     VideoFormat[];
  audio:     AudioFormat[];
}

/* ─── API health check ──────────────────────────────────── */
export async function isApiAvailable(): Promise<boolean> {
  const base = getApiBase();
  if (!base) {
    // No backend URL configured — try same-origin /api/formats as a fallback test
    try {
      const res = await fetch("/api/formats?id=test", { signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      try { JSON.parse(text); return true; } catch { return false; }
    } catch {
      return false;
    }
  }
  // Custom backend configured — try root health endpoint with generous timeout
  // Render's free tier can take 30-60s to wake from sleep, so we give it 45s.
  try {
    const res = await fetch(`${base}/`, {
      signal: AbortSignal.timeout(45000),
      mode: "cors",
    });
    // Accept any 2xx response — the backend is alive
    if (res.ok) return true;
    // 502/503 from a sleeping Render server still means the URL is correct
    if (res.status === 502 || res.status === 503) return false;
    return false;
  } catch (e: any) {
    // CORS failure or network error
    console.warn("Backend health check failed:", e?.message);
    return false;
  }
}

/* ─── Format extraction ─────────────────────────────────── */
export async function fetchFormats(videoId: string): Promise<VideoInfo> {
  const base = getApiBase();
  const url  = `${base}/api/formats?id=${encodeURIComponent(videoId)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });

  let data: any;
  try {
    data = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    throw new Error(
      text.toLowerCase().startsWith("not found") || res.status === 404
        ? "API_UNAVAILABLE"
        : `Server returned unexpected response (${res.status})`
    );
  }

  if (!data.ok) {
    throw new Error(data.error || "Failed to fetch formats.");
  }
  return data as VideoInfo;
}

/* ─── Stream URL builder ────────────────────────────────── */
export function getStreamUrl(
  videoId:     string,
  ytdlpFormat: string,
  ext:         string,
  title:       string,
  client:      string = "android_vr,web_embedded"
): string {
  const base   = getApiBase();
  const params = new URLSearchParams({ id: videoId, fmt: ytdlpFormat, ext, title, client });
  return `${base}/api/stream?${params}`;
}

/* ─── Helpers ───────────────────────────────────────────── */
export function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes > 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes > 1_000_000)     return `~${(bytes / 1_000_000).toFixed(0)} MB`;
  return `~${(bytes / 1_000).toFixed(0)} KB`;
}

export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
