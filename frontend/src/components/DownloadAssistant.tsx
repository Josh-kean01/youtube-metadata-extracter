import { useState, useEffect } from "react";
import {
  Download, Loader2, Music, Video, Sparkles,
  Clock, User, ExternalLink, AlertTriangle,
  Copy, Check, Terminal, Info, Rocket, RefreshCw,
  Server, Settings, Save,
} from "lucide-react";
import { extractVideoId } from "../services/youtube";
import {
  fetchFormats, getStreamUrl, formatFileSize, formatDuration,
  isApiAvailable, getApiBase, setApiBase,
  VideoInfo, VideoFormat, AudioFormat,
} from "../services/downloader";

type Tab = "video" | "audio";
type ApiState = "checking" | "available" | "unavailable";

/* ─── Quality badges ─────────────────────────────────────── */
const HEIGHT_BADGE: Record<number, { label: string; color: string }> = {
  4320: { label: "8K",  color: "bg-violet-500/20 text-violet-300 border-violet-500/30" },
  2160: { label: "4K",  color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  1440: { label: "2K",  color: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
  1080: { label: "FHD", color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  720:  { label: "HD",  color: "bg-green-500/20 text-green-300 border-green-500/30" },
};

const AUDIO_BADGE: Record<string, { label: string; color: string }> = {
  mp3:  { label: "MP3",  color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  opus: { label: "OPUS", color: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30" },
  wav:  { label: "WAV",  color: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
  m4a:  { label: "M4A",  color: "bg-pink-500/20 text-pink-300 border-pink-500/30" },
};

/* ─── yt-dlp terminal commands ───────────────────────────── */
const YT_DLP_CMDS = (id: string) => [
  { label: "Best quality (auto)",  cmd: `yt-dlp -f "bv+ba/best" -o "%(title)s.%(ext)s" "https://www.youtube.com/watch?v=${id}"` },
  { label: "4K MP4",               cmd: `yt-dlp -f "bv[height<=2160]+ba" -o "%(title)s.%(ext)s" "https://www.youtube.com/watch?v=${id}"` },
  { label: "1080p MP4",            cmd: `yt-dlp -f "bv[height<=1080]+ba" -o "%(title)s.%(ext)s" "https://www.youtube.com/watch?v=${id}"` },
  { label: "MP3 320kbps",          cmd: `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "%(title)s.%(ext)s" "https://www.youtube.com/watch?v=${id}"` },
];

const INSTALL_CMDS = [
  { os: "macOS",   cmd: "brew install yt-dlp" },
  { os: "Windows", cmd: "winget install yt-dlp" },
  { os: "Linux",   cmd: "pip install yt-dlp" },
];

/* ─── Format Card ────────────────────────────────────────── */
function FormatCard({
  title, videoId, ytdlpFormat, ext,
  label, sub, badge, badgeColor, filesize, client,
}: {
  title: string; videoId: string; ytdlpFormat: string; ext: string;
  label: string; sub: string; badge?: string; badgeColor?: string; filesize?: number; client?: string;
}) {
  const [status, setStatus] = useState<"idle" | "starting" | "done">("idle");

  const handleDownload = () => {
    setStatus("starting");
    const streamUrl = getStreamUrl(videoId, ytdlpFormat, ext, title, client ?? "android_vr");
    const a = document.createElement("a");
    a.href = streamUrl;
    a.download = `${title}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give a short delay then show done
    setTimeout(() => setStatus("done"), 1200);
    setTimeout(() => setStatus("idle"), 8000);
  };

  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-3 transition-colors duration-300 ${
      status === "done" ? "border-emerald-500/30 bg-emerald-500/5" : "border-[#1a1e2a] bg-[#0d0f14]"
    }`}>
      <div>
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          <span className="text-sm font-extrabold text-white">{label}</span>
          {badge && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${badgeColor}`}>
              {badge}
            </span>
          )}
        </div>
        <p className="text-[10px] text-[#4f566b] leading-snug">{sub}</p>
        {filesize && (
          <p className="text-[10px] text-[#4f566b] mt-0.5">{formatFileSize(filesize)}</p>
        )}
      </div>

      {status === "done" && (
        <p className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1">
          <Check className="h-3 w-3" /> Download started — check your downloads folder.
        </p>
      )}

      <button
        onClick={handleDownload}
        disabled={status === "starting"}
        className={`mt-auto w-full flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-bold transition active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed ${
          status === "done"
            ? "bg-emerald-600 hover:bg-emerald-500 text-white"
            : "bg-rose-600 hover:bg-rose-500 text-white shadow-sm shadow-rose-900/30"
        }`}
      >
        {status === "starting" ? (
          <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting…</>
        ) : status === "done" ? (
          <><Check className="h-3.5 w-3.5" /> Done</>
        ) : (
          <><Download className="h-3.5 w-3.5" /> Download</>
        )}
      </button>
    </div>
  );
}

/* ─── "API not on Vercel" banner ─────────────────────────── */
function ConfigureBackendPanel({
  apiState, currentBase, onSaved,
}: {
  apiState: "checking" | "available" | "unavailable";
  currentBase: string;
  onSaved: () => void;
}) {
  const [input, setInput] = useState(currentBase);
  const [saved, setSaved] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");

  const handleSave = () => {
    setApiBase(input);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onSaved();
  };

  const handleClear = () => {
    setInput("");
    setApiBase("");
    onSaved();
  };

  const handleWake = async () => {
    if (!input.trim()) return;
    setWaking(true);
    setWakeMsg("Pinging server… Render free tier can take 30–60s to wake from sleep.");
    const start = Date.now();
    try {
      const res = await fetch(`${input.trim().replace(/\/$/, "")}/`, {
        signal: AbortSignal.timeout(90000),
        mode: "cors",
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (res.ok) {
        setWakeMsg(`✓ Server is awake (${elapsed}s). Click Save above to connect.`);
        setApiBase(input);
        setTimeout(onSaved, 500);
      } else {
        setWakeMsg(`✗ Server responded with HTTP ${res.status}. Check the URL.`);
      }
    } catch (e: any) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        setWakeMsg(`✗ Timed out after ${elapsed}s. Server may be down or URL is wrong.`);
      } else {
        setWakeMsg(`✗ Could not reach server (${elapsed}s). This is usually CORS — make sure your backend allows all origins.`);
      }
    } finally {
      setWaking(false);
    }
  };

  return (
    <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 border border-rose-500/20 flex-shrink-0">
          <Server className="h-5 w-5 text-rose-400" />
        </div>
        <div>
          <h4 className="text-sm font-bold text-white">Configure Backend API</h4>
          <p className="text-xs text-[#8b92a9] mt-1 leading-relaxed">
            The downloader needs a Python backend hosted on a server YouTube doesn't block.
            Vercel's IPs are flagged — use <strong className="text-white">Render.com</strong> instead (free).
          </p>
        </div>
      </div>

      {/* Backend URL input */}
      <div className="space-y-2">
        <label className="text-xs font-bold text-white">Backend API URL</label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://tubeinspect-api.onrender.com"
            className="flex-1 rounded-xl border border-[#23283a] bg-[#0d0f14] py-2.5 px-4 text-sm font-mono text-white placeholder-[#4f566b] focus:border-rose-500/50 focus:outline-none transition"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={waking}
              className="flex items-center gap-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 px-4 py-2.5 text-xs font-bold text-white transition active:scale-95"
            >
              {saved ? <><Check className="h-3.5 w-3.5" /> Saved</> : <><Save className="h-3.5 w-3.5" /> Save</>}
            </button>
            <button
              onClick={handleWake}
              disabled={waking || !input.trim()}
              className="flex items-center gap-1.5 rounded-xl border border-[#23283a] bg-[#181c25] hover:bg-[#1e2230] disabled:opacity-50 px-4 py-2.5 text-xs font-bold text-[#8b92a9] hover:text-white transition"
            >
              {waking ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Waking…</> : "Test / Wake"}
            </button>
            {currentBase && (
              <button
                onClick={handleClear}
                disabled={waking}
                className="rounded-xl border border-[#23283a] bg-[#181c25] hover:bg-[#1e2230] disabled:opacity-50 px-4 py-2.5 text-xs font-bold text-[#8b92a9] hover:text-white transition"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Wake/test result message */}
        {wakeMsg && (
          <p className={`text-xs flex items-start gap-1 leading-relaxed ${
            wakeMsg.startsWith("✓") ? "text-emerald-400" :
            wakeMsg.startsWith("✗") ? "text-red-400" :
                                      "text-[#8b92a9]"
          }`}>
            {wakeMsg.startsWith("Pinging") && <Loader2 className="h-3 w-3 animate-spin flex-shrink-0 mt-0.5" />}
            {wakeMsg}
          </p>
        )}

        {/* Connection status */}
        {!wakeMsg && currentBase && apiState === "available" && (
          <p className="text-xs text-emerald-400 flex items-center gap-1">
            <Check className="h-3 w-3" /> Connected to {currentBase}
          </p>
        )}
        {!wakeMsg && currentBase && apiState === "unavailable" && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-1">
            <p className="text-xs text-amber-300 flex items-start gap-1.5">
              <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" />
              <span>Could not reach <code className="font-mono">{currentBase}</code></span>
            </p>
            <ul className="text-[11px] text-[#8b92a9] pl-4 space-y-0.5 list-disc">
              <li>If on Render free tier, server may be sleeping — click <strong className="text-white">Test / Wake</strong> (takes 30–60s)</li>
              <li>Check the URL is correct (no trailing slash, includes <code>https://</code>)</li>
              <li>Make sure your backend has CORS enabled for all origins</li>
              <li>Check the server logs in Render for any deploy errors</li>
            </ul>
          </div>
        )}
      </div>

      {/* Setup guide */}
      <details className="rounded-xl border border-[#1a1e2a] bg-[#0d0f14] p-4 group">
        <summary className="cursor-pointer flex items-center justify-between text-xs font-bold text-white">
          <span className="flex items-center gap-2">
            <Rocket className="h-3.5 w-3.5 text-rose-400" /> How to deploy your backend (5 minutes, free)
          </span>
          <span className="text-[#4f566b] group-open:rotate-180 transition">▼</span>
        </summary>
        <div className="mt-4 space-y-3 text-xs text-[#8b92a9]">
          <ol className="space-y-3">
            {[
              <>
                <strong className="text-white">Push this project to GitHub</strong> — the <code className="text-[#8b92a9] font-mono text-[10px]">backend/</code> folder
                contains everything needed (Flask + yt-dlp + render.yaml).
              </>,
              <>
                Go to <a href="https://render.com/dashboard" target="_blank" rel="noopener noreferrer" className="text-rose-400 hover:underline">render.com/dashboard</a> →
                click <strong className="text-white">New</strong> → <strong className="text-white">Web Service</strong>.
              </>,
              <>
                Connect your GitHub repo. Render will detect <code className="text-[#8b92a9] font-mono text-[10px]">backend/render.yaml</code> automatically.
                If not, set <strong className="text-white">Root Directory</strong> to <code className="text-emerald-400 font-mono text-[10px]">backend</code>,
                Build: <code className="text-emerald-400 font-mono text-[10px]">pip install -r requirements.txt</code>,
                Start: <code className="text-emerald-400 font-mono text-[10px]">gunicorn app:app</code>.
              </>,
              <>
                Pick the <strong className="text-emerald-400">Free</strong> plan and click <strong className="text-white">Create Web Service</strong>.
                Wait ~3-5 minutes for the first build.
              </>,
              <>
                Copy your live URL (e.g. <code className="text-emerald-400 font-mono text-[10px]">https://tubeinspect-api.onrender.com</code>) and
                paste it in the field above. Hit <strong className="text-white">Save</strong>.
              </>,
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500/10 border border-rose-500/20 text-[10px] font-extrabold text-rose-400 mt-0.5">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-4 pt-3 border-t border-[#1a1e2a] space-y-2">
            <p className="text-[10px] text-[#4f566b] font-bold uppercase tracking-wide">Why Render and not Vercel?</p>
            <p className="leading-relaxed text-xs">
              YouTube aggressively blocks Vercel's serverless function IPs as bots.
              Render uses different IP ranges that work reliably with yt-dlp. The free tier
              sleeps after 15 minutes of inactivity, so the first request after a pause may
              take ~30 seconds while the server wakes up.
            </p>
          </div>

          <div className="pt-3 border-t border-[#1a1e2a]">
            <p className="text-[10px] text-[#4f566b] font-bold uppercase tracking-wide mb-2">Run locally instead</p>
            <code className="block text-[11px] font-mono text-[#8b92a9] bg-[#0a0c10] rounded-lg p-3 leading-relaxed">
              cd backend{"\n"}
              pip install -r requirements.txt{"\n"}
              python app.py
            </code>
            <p className="text-[10px] text-[#4f566b] mt-2">Then set the URL above to <code className="text-emerald-400 font-mono">http://localhost:8000</code></p>
          </div>
        </div>
      </details>

      {/* Bottom note */}
      <p className="text-xs text-[#4f566b]">
        💡 The <strong className="text-[#8b92a9]">yt-dlp terminal commands</strong> below always work — no backend needed.
      </p>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────── */
export default function DownloadAssistant() {
  const [url, setUrl]             = useState("");
  const [info, setInfo]           = useState<VideoInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]         = useState("");
  const [tab, setTab]             = useState<Tab>("video");
  const [copiedCmd, setCopiedCmd] = useState("");
  const [apiState, setApiState]         = useState<ApiState>("checking");
  const [showConfig, setShowConfig]     = useState(false);
  const [apiBaseValue, setApiBaseValue] = useState(getApiBase());

  // Check if the backend API is reachable on mount
  useEffect(() => {
    isApiAvailable().then((ok) => setApiState(ok ? "available" : "unavailable"));
  }, []);

  const handleLoad = async (idOverride?: string) => {
    const rawId = idOverride || extractVideoId(url);
    if (!rawId) { setError("Please paste a valid YouTube link."); return; }

    setError("");
    setInfo(null);
    setIsLoading(true);

    try {
      const result = await fetchFormats(rawId);
      setInfo(result);
      setTab("video");
    } catch (e: any) {
      if (e.message === "API_UNAVAILABLE") {
        setApiState("unavailable");
        setError("The download API isn't available in this environment. Deploy to Vercel to enable it.");
      } else {
        setError(e.message || "Failed to load formats. The video may be private or unavailable.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const copyCmd = (cmd: string, key: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCmd(key);
    setTimeout(() => setCopiedCmd(""), 2000);
  };

  /* ── Only show the URL input section if API is available or still checking ── */
  const showDownloadUi = apiState === "available";
  const currentVideoId = info?.id ?? "";

  return (
    <div className="space-y-5">

      {/* ── Header ───────────────────────────────────────── */}
      <div className="card-dark p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 border border-rose-500/20">
            <Download className="h-5 w-5 text-rose-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-white">Downloader</h3>
            <p className="text-xs text-[#8b92a9]">
              Paste a link → pick a format → download starts in-app.
            </p>
          </div>
          {/* API status pill + Configure */}
          <div className="flex-shrink-0 flex items-center gap-2">
            <button
              onClick={() => setShowConfig(!showConfig)}
              title="Configure backend API URL"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#23283a] bg-[#181c25] hover:bg-[#1e2230] text-[#8b92a9] hover:text-white transition"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
            <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-bold border ${
              apiState === "checking"   ? "bg-[#1a1e2a] border-[#23283a] text-[#4f566b]" :
              apiState === "available"  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" :
                                          "bg-amber-500/10 border-amber-500/20 text-amber-400"
            }`}>
              {apiState === "checking" ? (
                <><Loader2 className="h-3 w-3 animate-spin" /> Checking…</>
              ) : apiState === "available" ? (
                <><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> API Ready</>
              ) : (
                <><AlertTriangle className="h-3 w-3" /> API Offline</>
              )}
            </div>
          </div>
        </div>

        {/* URL input — always visible */}
        <div className="flex flex-col md:flex-row gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(""); }}
            onKeyDown={(e) => e.key === "Enter" && showDownloadUi && handleLoad()}
            placeholder="https://www.youtube.com/watch?v=..."
            className="flex-1 rounded-xl border border-[#23283a] bg-[#0d0f14] py-3 px-4 text-sm text-white placeholder-[#4f566b] focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/20 focus:outline-none transition"
          />
          <button
            onClick={() => handleLoad()}
            disabled={isLoading || !showDownloadUi}
            className="flex items-center justify-center gap-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 text-sm font-bold text-white transition shadow-lg shadow-rose-900/30 active:scale-95"
          >
            {isLoading
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>
              : "Get Formats"}
          </button>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-3">
            <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-300 leading-relaxed">{error}</p>
          </div>
        )}

        {/* Demo presets */}
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-xs text-[#4f566b] self-center flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-amber-500" /> Try:
          </span>
          {[
            { id: "dQw4w9WgXcQ", label: "Rick Astley" },
            { id: "9bZkp7q19f0", label: "Gangnam Style" },
            { id: "jNQXAC9IVRw", label: "First YouTube Video" },
          ].map(({ id, label }) => (
            <button
              key={id}
              disabled={isLoading || !showDownloadUi}
              onClick={() => {
                setUrl(`https://www.youtube.com/watch?v=${id}`);
                handleLoad(id);
              }}
              className="rounded-lg border border-[#23283a] bg-[#181c25] hover:bg-[#1e2230] px-3 py-1.5 text-xs font-semibold text-[#8b92a9] hover:text-white disabled:opacity-40 transition"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── API Unavailable Banner ────────────────────────── */}
      {(apiState === "unavailable" || showConfig) && (
        <ConfigureBackendPanel
          apiState={apiState}
          currentBase={apiBaseValue}
          onSaved={() => {
            setApiBaseValue(getApiBase());
            setApiState("checking");
            isApiAvailable().then((ok) => setApiState(ok ? "available" : "unavailable"));
          }}
        />
      )}

      {/* ── Loading ───────────────────────────────────────── */}
      {isLoading && (
        <div className="card-dark p-10 flex flex-col items-center gap-4">
          <div className="h-9 w-9 animate-spin rounded-full border-2 border-[#23283a] border-t-rose-500" />
          <div className="text-center">
            <p className="text-sm font-bold text-white">Scanning available formats…</p>
            <p className="text-xs text-[#8b92a9] mt-1">yt-dlp is extracting all available qualities from YouTube</p>
          </div>
        </div>
      )}

      {/* ── Format Results ────────────────────────────────── */}
      {info && !isLoading && (
        <div className="space-y-5 animate-slideUp">

          {/* Video info card */}
          <div className="card-dark p-5 flex flex-col sm:flex-row items-start gap-4">
            <div className="flex-shrink-0 w-full sm:w-44 aspect-video rounded-xl overflow-hidden border border-[#1a1e2a] bg-[#0a0c10]">
              <img src={info.thumbnail} alt={info.title} className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 space-y-2 min-w-0">
              <h3 className="text-sm font-bold text-white leading-snug line-clamp-2">{info.title}</h3>
              <div className="flex flex-wrap gap-3 text-xs text-[#8b92a9]">
                {info.uploader && (
                  <span className="flex items-center gap-1"><User className="h-3.5 w-3.5" /> {info.uploader}</span>
                )}
                {info.duration > 0 && (
                  <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {formatDuration(info.duration)}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`https://www.youtube.com/watch?v=${info.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-rose-400 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" /> Open on YouTube
                </a>
                <button
                  onClick={() => handleLoad(info.id)}
                  className="inline-flex items-center gap-1 text-xs text-[#4f566b] hover:text-white transition"
                >
                  <RefreshCw className="h-3 w-3" /> Refresh Formats
                </button>
              </div>
            </div>
          </div>

          {/* Info notice */}
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3.5 flex items-start gap-2.5">
            <Info className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-[#8b92a9] leading-relaxed">
              Formats are resolved by <strong className="text-white">yt-dlp</strong> on our Vercel serverless function.
              Click <strong className="text-white">Download</strong> — the file streams directly to your browser.
              Large files (1080p+) may take a few seconds before the download dialog appears.
            </p>
          </div>

          {/* Format tabs + grid */}
          <div className="card-dark overflow-hidden">
            <div className="flex border-b border-[#1a1e2a]">
              <button onClick={() => setTab("video")}
                className={`flex-1 flex items-center justify-center gap-2 py-4 text-sm font-bold border-b-2 transition ${tab === "video" ? "border-rose-500 text-white bg-rose-500/5" : "border-transparent text-[#4f566b] hover:text-[#8b92a9]"}`}>
                <Video className="h-4 w-4" /> Video ({info.video.length})
              </button>
              <button onClick={() => setTab("audio")}
                className={`flex-1 flex items-center justify-center gap-2 py-4 text-sm font-bold border-b-2 transition ${tab === "audio" ? "border-rose-500 text-white bg-rose-500/5" : "border-transparent text-[#4f566b] hover:text-[#8b92a9]"}`}>
                <Music className="h-4 w-4" /> Audio ({info.audio.length})
              </button>
            </div>

            <div className="p-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {tab === "video" && info.video.map((fmt: VideoFormat) => {
                const badge = HEIGHT_BADGE[fmt.height];
                return (
                  <FormatCard
                    key={fmt.format_id}
                    title={info.title}
                    videoId={info.id}
                    ytdlpFormat={fmt.ytdlp_format}
                    ext={fmt.ext}
                    label={fmt.label}
                    sub={`${fmt.resolution} · ${fmt.vcodec?.split(".")[0] ?? "mp4"}`}
                    badge={badge?.label}
                    badgeColor={badge?.color}
                    filesize={fmt.filesize}
                    client={fmt.client}
                  />
                );
              })}

              {tab === "audio" && info.audio.map((fmt: AudioFormat) => {
                const badge = AUDIO_BADGE[fmt.ext];
                return (
                  <FormatCard
                    key={`${fmt.ext}-${fmt.ytdlp_format}`}
                    title={info.title}
                    videoId={info.id}
                    ytdlpFormat={fmt.ytdlp_format}
                    ext={fmt.ext}
                    label={fmt.label}
                    sub={fmt.sub}
                    badge={badge?.label}
                    badgeColor={badge?.color}
                    client={fmt.client}
                  />
                );
              })}
            </div>
          </div>

          {/* Terminal fallback (always shown below results) */}
          <TerminalSection videoId={currentVideoId} copiedCmd={copiedCmd} copyCmd={copyCmd} />
        </div>
      )}

      {/* Terminal always visible even without formats (helpful if API is offline) */}
      {!info && !isLoading && url && extractVideoId(url) && (
        <TerminalSection videoId={extractVideoId(url)!} copiedCmd={copiedCmd} copyCmd={copyCmd} />
      )}
    </div>
  );
}

/* ─── Terminal Section (reusable) ────────────────────────── */
function TerminalSection({
  videoId, copiedCmd, copyCmd,
}: { videoId: string; copiedCmd: string; copyCmd: (cmd: string, key: string) => void }) {
  const [copiedInstall, setCopiedInstall] = useState("");

  const copyInstall = (cmd: string, key: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedInstall(key);
    setTimeout(() => setCopiedInstall(""), 2000);
  };

  return (
    <div className="card-dark p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-indigo-400" />
        <h4 className="text-sm font-bold text-white">Terminal Download (yt-dlp)</h4>
        <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
          Always Works
        </span>
      </div>
      <p className="text-xs text-[#8b92a9] leading-relaxed">
        Install yt-dlp once and download any video in any quality — no browser, no servers, no rate limits.
      </p>

      {/* Install commands */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {INSTALL_CMDS.map(({ os, cmd }) => (
          <div key={os} className="rounded-xl border border-[#1a1e2a] bg-[#0d0f14] p-3">
            <p className="text-[10px] font-bold text-[#4f566b] uppercase tracking-wide mb-1.5">{os}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] font-mono text-[#8b92a9] truncate">{cmd}</code>
              <button onClick={() => copyInstall(cmd, os)} className="flex-shrink-0 p-1 text-[#4f566b] hover:text-white transition">
                {copiedInstall === os ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Download commands */}
      <div className="space-y-2">
        {YT_DLP_CMDS(videoId).map(({ label, cmd }) => (
          <div key={label} className="flex items-start gap-3 rounded-xl border border-[#1a1e2a] bg-[#0d0f14] p-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-[#4f566b] uppercase tracking-wide mb-1">{label}</p>
              <p className="text-[11px] font-mono text-[#8b92a9] break-all leading-relaxed">{cmd}</p>
            </div>
            <button
              onClick={() => copyCmd(cmd, label)}
              className="flex-shrink-0 flex items-center gap-1 rounded-lg border border-[#23283a] bg-[#181c25] hover:bg-[#1e2230] px-2.5 py-1.5 text-[10px] font-bold text-[#8b92a9] hover:text-white transition"
            >
              {copiedCmd === label ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              {copiedCmd === label ? "Copied" : "Copy"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
