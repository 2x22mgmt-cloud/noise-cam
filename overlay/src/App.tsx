import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Aperture, Camera, CircleDot, Clapperboard, Copy, Crosshair, Download, Eye, EyeOff,
  Film, Move3d, Pause, Play, Plug, RefreshCw, Route, Search, Send, SquareTerminal,
  Trash2, Video, Wrench, X,
} from "lucide-react";
import { useBridge, isTauri, TICKRATE, type Bridge, type DemoInfo, type Keyframe } from "./useBridge";
import { fmtFocal, fovToFocal, focalToFov } from "./lens";
import { computeDof, F_STOPS } from "./dof";

const f = (n: unknown, d = 1) =>
  typeof n === "number" && isFinite(n) ? n.toFixed(d) : "–";

/* shared squared B&W controls */
const btn =
  "flex items-center justify-center gap-1.5 border border-line px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-sub transition hover:border-muted hover:text-text disabled:opacity-40";
const btnActive = "border-accent! text-accent hover:text-accent!";
const btnDanger = "border-danger/50! text-danger hover:bg-danger/10!";
const input =
  "w-full border border-line bg-black px-2 py-1.5 text-[11px] text-text outline-none placeholder:text-muted focus:border-accent";
const label = "px-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted";

type TabKey = "demos" | "path" | "camera" | "dof" | "hud" | "console";
const TABS: { key: TabKey; label: string; Icon: typeof Route }[] = [
  { key: "demos", label: "Demos", Icon: Film },
  { key: "path", label: "Path", Icon: Route },
  { key: "camera", label: "Cam", Icon: Video },
  { key: "dof", label: "DoF", Icon: Aperture },
  { key: "hud", label: "HUD", Icon: Eye },
  { key: "console", label: "", Icon: SquareTerminal },
];

export default function App() {
  const b = useBridge();
  const [tab, setTab] = useState<TabKey>("path");
  const [gateOff, setGateOff] = useState(false);

  // Capture toast: flash a popup when the keyframe count ticks up by one (from
  // the UI button OR the in-game numpad bind). Bulk loads / clears don't fire.
  const [toast, setToast] = useState<string | null>(null);
  const prevKf = useRef<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const c = b.keyframes.count;
    if (prevKf.current !== null && c === prevKf.current + 1) {
      setToast("Keyframe captured");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 1600);
    }
    prevKf.current = c;
  }, [b.keyframes.count]);

  return (
    <div className="flex h-full flex-col overflow-hidden border border-line bg-[#0a0a0a]/95">
      <TitleBar status={b.status} />
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <Readout b={b} />
        <nav className="flex border-b border-line">
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-2 text-[11px] font-medium uppercase tracking-wide transition ${
                  on ? "border-accent text-text" : "border-transparent text-muted hover:text-sub"
                }`}
              >
                <t.Icon size={15} strokeWidth={1.75} />
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-y-auto overscroll-contain p-3">
          {tab === "demos" && <DemosTab b={b} />}
          {tab === "path" && <PathTab b={b} />}
          {tab === "camera" && <CameraTab b={b} />}
          {tab === "dof" && <DofTab b={b} />}
          {tab === "hud" && <HudTab b={b} />}
          {tab === "console" && <ConsoleTab b={b} />}
        </div>
        {!b.status.hlae && !gateOff && <BridgeGate b={b} onDismiss={() => setGateOff(true)} />}

        {toast && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
            <div className="toast-in flex items-center gap-2 border border-accent bg-accent px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-bg">
              <CircleDot size={13} strokeWidth={2.5} /> {toast}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- bridge gate */
// Shown until CS2/HLAE actually connects — so nobody forgets to load the bridge.
// Clears itself the instant `status.hlae` flips true (i.e. after `exec noisecam`).
function BridgeGate({ b, onDismiss }: { b: Bridge; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const [install, setInstall] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [installMsg, setInstallMsg] = useState("");
  const [installed, setInstalled] = useState<boolean | null>(null); // null = checking
  const desktop = isTauri();

  // Don't prompt to install if the cfg + bridge are already in CS2's cfg folder.
  useEffect(() => {
    if (!desktop) {
      setInstalled(false);
      return;
    }
    b.bridgeInstalled().then(setInstalled);
  }, [b.bridgeInstalled, desktop]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText("exec noisecam");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be blocked (e.g. phone over http) — command is shown anyway */
    }
  };
  const doInstall = async () => {
    setInstall("busy");
    try {
      const dir = await b.installBridge();
      setInstallMsg(dir);
      setInstall("done");
      setInstalled(true);
    } catch (e) {
      setInstallMsg(String(e instanceof Error ? e.message : e));
      setInstall("error");
    }
  };
  const isInstalled = installed === true || install === "done";
  const checking = installed === null;
  // Only surface real messages (errors, relay notes) — not the "» command" echoes.
  const recent = b.log.filter((l) => !l.msg.startsWith("»")).slice(-3);
  const Step = ({ n }: { n: number }) => (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center bg-line text-[9px] font-bold text-text">
      {n}
    </span>
  );

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3.5 overflow-y-auto bg-[#0a0a0a]/97 px-5 py-6 text-center backdrop-blur-sm">
      <button
        onClick={onDismiss}
        className="absolute right-2 top-2 text-muted transition hover:text-text"
        title="Dismiss (you can set up later)"
      >
        <X size={15} />
      </button>

      <img src="/logo.png" alt="" className="pointer-events-none h-6 w-auto opacity-90" />
      <div className="flex items-center justify-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-text">
        <Plug size={15} strokeWidth={2} /> Set up Noise Cam
      </div>

      {/* Step 1 — desktop only: write the cfg + bridge into CS2 for them.
          If it's already installed we show a quiet ✓ instead of an install prompt. */}
      {desktop && (
        <div className="w-full max-w-[280px] space-y-1.5">
          <div className="flex items-center gap-1.5 text-left text-[11px] text-sub">
            <Step n={1} /> {isInstalled ? "Bridge installed in CS2" : "Install the bridge into CS2 (one click)"}
          </div>
          <button
            onClick={doInstall}
            disabled={install === "busy" || checking}
            className={
              isInstalled
                ? "flex w-full items-center justify-center gap-2 border border-line py-2.5 text-[12px] font-medium uppercase tracking-wide text-sub transition hover:border-muted hover:text-text disabled:opacity-50"
                : "flex w-full items-center justify-center gap-2 bg-accent py-2.5 text-[12px] font-semibold uppercase tracking-wide text-bg transition hover:bg-white disabled:opacity-50"
            }
          >
            <Download size={14} strokeWidth={2.5} />
            {checking
              ? "checking…"
              : install === "busy"
                ? "installing…"
                : isInstalled
                  ? "Installed ✓ — re-install"
                  : "Install to CS2"}
          </button>
          {install === "done" && (
            <p className="break-all text-left text-[10px] leading-relaxed text-muted">
              wrote bridge + cfg to <span className="text-sub">{installMsg}</span>
            </p>
          )}
          {install === "error" && (
            <p className="text-left text-[10px] leading-relaxed text-danger">
              {installMsg} — drop <span className="font-mono">noisecam.cfg</span> into{" "}
              <span className="font-mono">csgo\cfg</span> manually instead.
            </p>
          )}
        </div>
      )}

      {/* Step 2 — run the loader once in CS2 (works at the main menu). */}
      <div className="w-full max-w-[280px] space-y-1.5">
        <div className="flex items-center gap-1.5 text-left text-[11px] text-sub">
          {desktop && <Step n={2} />}
          {desktop ? "In the CS2 console (menu is fine), run:" : "On the PC, in the CS2 console, run:"}
        </div>
        <button
          onClick={copy}
          className="flex w-full items-center justify-between gap-2 border border-accent/60 bg-black px-3 py-2.5 font-mono text-[12px] text-accent transition hover:border-accent"
          title="Copy command"
        >
          <span>exec noisecam</span>
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
            {copied ? "copied" : <><Copy size={12} /> copy</>}
          </span>
        </button>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-sub">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 bg-accent" />
        </span>
        {b.status.text}
      </div>

      {recent.length > 0 && (
        <div className="w-full max-w-[280px] border border-line bg-black/60 p-2 text-left font-mono text-[10px] leading-relaxed text-muted">
          {recent.map((l, i) => (
            <div key={i} className="truncate">{l.msg}</div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-muted">Closes automatically once CS2 connects.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- titlebar */
function TitleBar({ status }: { status: Bridge["status"] }) {
  return (
    <header data-tauri-drag-region className="flex items-center gap-2 border-b border-line px-3 py-2">
      <img src="/logo.png" alt="" className="pointer-events-none h-5 w-auto" />
      <span className="text-[13px] font-semibold uppercase tracking-[0.15em]">Noise Cam</span>
      <div
        className="ml-auto flex items-center gap-1.5 border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
        style={{
          borderColor: status.hlae ? "#6b5200" : "var(--color-line)",
          color: status.hlae ? "var(--color-accent)" : "var(--color-muted)",
        }}
      >
        <span
          className="h-1.5 w-1.5"
          style={{ background: status.hlae ? "var(--color-accent)" : "var(--color-muted)" }}
        />
        {status.text}
      </div>
      {isTauri() && (
        <button
          onClick={() => getCurrentWindow().hide()}
          title="Hide overlay (Alt+Shift+D)"
          className="text-muted transition hover:text-danger"
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      )}
    </header>
  );
}

/* ----------------------------------------------------------- live readout */
function Readout({ b }: { b: Bridge }) {
  const v = b.cam?.view || {};
  const playing = b.cam && !b.cam.paused;
  return (
    <div className="grid grid-cols-4 border-b border-line">
      <Stat label="tick" value={b.cam?.demoTick ?? "–"} />
      <Stat label="time" value={b.cam?.demoTime != null ? f(b.cam.demoTime, 2) : "–"} />
      <Stat label="lens" value={fmtFocal(v.fov)} />
      <Stat
        label="state"
        last
        value={
          playing ? (
            <Play size={13} className="mx-auto text-accent" fill="currentColor" />
          ) : (
            <Pause size={13} className="mx-auto text-muted" fill="currentColor" />
          )
        }
      />
    </div>
  );
}
function Stat({ label, value, last }: { label: string; value: React.ReactNode; last?: boolean }) {
  return (
    <div className={`px-1 py-1.5 text-center ${last ? "" : "border-r border-line-soft"}`}>
      <div className="text-[9px] uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[13px] font-medium tabular-nums">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Path */
function CaptureButton({ b }: { b: Bridge }) {
  return (
    <button
      onClick={() => b.send({ type: "capture" })}
      className="flex w-full items-center justify-center gap-2 bg-text py-2.5 text-[12px] font-semibold uppercase tracking-wide text-bg transition hover:bg-white"
    >
      <CircleDot size={16} strokeWidth={2} /> Capture keyframe
    </button>
  );
}

/* ----------------------------------------------------------------- Demos */
function DemosTab({ b }: { b: Bridge }) {
  const [demos, setDemos] = useState<DemoInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    b.listDemos().then((d) => {
      setDemos(d);
      setLoading(false);
    });
  };
  useEffect(() => {
    let alive = true;
    setLoading(true);
    b.listDemos().then((d) => {
      if (alive) {
        setDemos(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [b.listDemos]);

  const load = (d: DemoInfo) => {
    b.exec(`playdemo "${d.arg}"`);
    setLoaded(d.arg);
  };

  const fmtDate = (s: number) =>
    s ? new Date(s * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
  const fmtSize = (mb: number) =>
    mb >= 1000 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";

  const list = (demos ?? []).filter(
    (d) => !q || (d.map + " " + d.file).toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter demos…"
            className={`${input} pl-7`}
          />
        </div>
        <button className={btn} onClick={refresh} disabled={loading} title="Rescan">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {!b.status.hlae && (
        <p className="border border-line bg-black/40 p-2 text-[11px] leading-relaxed text-muted">
          Loading runs <span className="text-sub">playdemo</span> in CS2 — connect the bridge first.
          You can <span className="text-sub">exec noisecam</span> at the CS2 main menu, then pick a
          demo here.
        </p>
      )}

      <div className={`px-0.5 ${label}`}>
        {loading ? "scanning…" : `${list.length} demo${list.length === 1 ? "" : "s"}`}
      </div>

      <div className="space-y-1">
        {list.map((d) => {
          const on = loaded === d.arg;
          return (
            <button
              key={d.arg}
              onClick={() => load(d)}
              className={`flex w-full items-center gap-2 border px-2.5 py-2 text-left transition ${
                on
                  ? "border-accent! text-text"
                  : "border-line text-sub hover:border-muted hover:text-text"
              }`}
            >
              <Play size={13} className={on ? "text-accent" : "text-muted"} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[12px] font-medium uppercase tracking-wide">
                    {d.map || "demo"}
                  </span>
                  {on && (
                    <span className="text-[9px] uppercase tracking-wide text-accent">loaded</span>
                  )}
                </div>
                <div className="truncate font-mono text-[10px] text-muted">{d.file}</div>
              </div>
              <div className="shrink-0 text-right font-mono text-[10px] text-muted">
                <div>{fmtDate(d.modified)}</div>
                <div>{fmtSize(d.size_mb)}</div>
              </div>
            </button>
          );
        })}
        {demos !== null && !loading && list.length === 0 && (
          <p className="px-0.5 py-4 text-center text-[11px] leading-relaxed text-muted">
            {demos.length === 0
              ? "No demos found. Demos live in csgo\\replays — is CS2 installed via Steam?"
              : "No demos match that filter."}
          </p>
        )}
      </div>
    </div>
  );
}

const PREVIEW_SPEEDS = [0.1, 0.25, 0.5, 1] as const;

// Live lock-on (follow / bone cam) is shelved — CS2's demo entity data made it too
// jittery/unreliable to ship. The bridge + UI code stays parked; flip this to revive.
const SHOW_LOCKON = false;

function PathTab({ b }: { b: Bridge }) {
  const [drawOn, setDrawOn] = useState(false);
  const [name, setName] = useState("myshot");
  const [sel, setSel] = useState<number | null>(null);
  const [previewSpeed, setPreviewSpeed] = useState(0.5);
  const { keyframes, send, exec } = b;

  const selectKf = (i: number) => {
    setSel(i);
    send({ type: "select", index: i });
  };
  const selValid = sel != null && sel < keyframes.items.length;

  return (
    <div className="space-y-2.5">
      <CaptureButton b={b} />

      <button
        onClick={() => send({ type: "preview", timescale: previewSpeed })}
        disabled={keyframes.items.length < 2}
        className="flex w-full items-center justify-center gap-2 border border-muted py-2 text-[12px] font-semibold uppercase tracking-wide text-text transition hover:border-text disabled:opacity-40"
      >
        <Play size={15} strokeWidth={2} /> Preview shot
      </button>

      <div>
        <div className={`mb-1 ${label}`}>preview speed</div>
        <div className="grid grid-cols-4 border border-line">
          {PREVIEW_SPEEDS.map((s, i) => (
            <button
              key={s}
              onClick={() => setPreviewSpeed(s)}
              className={`py-1.5 text-[11px] font-medium uppercase tracking-wide transition ${
                i < PREVIEW_SPEEDS.length - 1 ? "border-r border-line" : ""
              } ${previewSpeed === s ? "bg-accent text-bg" : "text-sub hover:text-text"}`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 border border-line">
        <button
          onClick={() => send({ type: "enable", on: !keyframes.enabled })}
          className={`border-r border-line py-2 text-[11px] font-medium uppercase tracking-wide transition ${
            keyframes.enabled ? "text-accent" : "text-sub hover:text-text"
          }`}
        >
          {keyframes.enabled ? "Disable" : "Enable"}
        </button>
        <button
          onClick={() => {
            const next = !drawOn;
            setDrawOn(next);
            send({ type: "draw", on: next });
          }}
          className={`border-r border-line py-2 text-[11px] font-medium uppercase tracking-wide transition ${
            drawOn ? "text-accent" : "text-sub hover:text-text"
          }`}
        >
          Draw
        </button>
        <button
          onClick={() => confirm("Clear all keyframes?") && send({ type: "clear" })}
          className="py-2 text-[11px] font-medium uppercase tracking-wide text-danger transition hover:bg-danger/10"
        >
          Clear
        </button>
      </div>

      <div className="flex gap-1.5">
        <input
          className={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="shot name"
        />
        <button className={btn} onClick={() => exec("mirv_campath save " + (name || "myshot"))}>Save</button>
        <button className={btn} onClick={() => exec("mirv_campath load " + (name || "myshot"))}>Load</button>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className={label}>Keyframes</span>
          <span className="font-mono text-[11px] text-muted">{keyframes.count}</span>
        </div>
        <div className="border border-line">
          {keyframes.items.length === 0 ? (
            <div className="px-2 py-4 text-center text-[11px] text-muted">
              No keyframes yet — fly the cam and Capture.
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {keyframes.items.map((k, i) => (
                <KfRow key={i} i={i} k={k} b={b} selected={sel === i} onSelect={() => selectKf(i)} />
              ))}
            </div>
          )}
        </div>

        {selValid && <EditBar b={b} index={sel as number} />}
      </div>
    </div>
  );
}

function KfRow({
  i, k, b, selected, onSelect,
}: { i: number; k: Keyframe; b: Bridge; selected: boolean; onSelect: () => void }) {
  const p = k.pos || ({} as NonNullable<Keyframe["pos"]>);
  const tick = typeof k.tick === "number" ? k.tick : Math.round((k.time || 0) * TICKRATE);
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      onClick={onSelect}
      className={`grid cursor-pointer grid-cols-[18px_42px_1fr_auto_auto] items-center gap-2 border-b border-line-soft px-2.5 py-2 text-[11px] last:border-b-0 ${
        selected ? "border-l-2 border-l-accent bg-accent/[0.07]" : "hover:bg-white/[0.03]"
      }`}
    >
      <span className={selected ? "text-accent" : "text-muted"}>{i}</span>
      <span className="font-mono tabular-nums">{f(k.time, 2)}s</span>
      <span className="truncate font-mono text-muted">
        {f(p.x)}, {f(p.y)}, {f(p.z)}
      </span>
      <span
        className="shrink-0 font-mono text-[10px] text-accent"
        title="rack-focus distance on this keyframe"
      >
        {typeof k.focus === "number" && k.focus > 0 ? `◉${Math.round(k.focus)}` : ""}
      </span>
      <span className="flex gap-2.5">
        <button
          title={`demo_gototick ${tick}`}
          onClick={stop(() => b.exec("demo_gototick " + tick))}
          className="text-muted transition hover:text-accent"
        >
          <Crosshair size={15} strokeWidth={1.75} />
        </button>
        <button
          onClick={stop(() => b.send({ type: "remove", index: i }))}
          className="text-muted transition hover:text-danger"
        >
          <Trash2 size={15} strokeWidth={1.75} />
        </button>
      </span>
    </div>
  );
}

function EditBar({ b, index }: { b: Bridge; index: number }) {
  const editBtn =
    "flex items-center justify-center border border-line py-1.5 text-[10px] font-medium uppercase tracking-wide text-sub transition hover:border-muted hover:text-text";
  return (
    <div className="mt-2 border border-accent/40 bg-accent/[0.06] p-2.5">
      <div className="mb-2 text-[11px] text-muted">
        Editing <span className="font-semibold text-accent">keyframe {index}</span> — fly the cam, then:
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <button
          className="flex items-center justify-center gap-1 border border-accent/60 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent transition hover:bg-accent/10"
          onClick={() => b.send({ type: "editKf", index, pos: true, ang: true })}
        >
          <Move3d size={13} /> Here
        </button>
        <button className={editBtn} onClick={() => b.send({ type: "editKf", index, pos: true })}>Pos</button>
        <button className={editBtn} onClick={() => b.send({ type: "editKf", index, ang: true })}>Angle</button>
        <button className={editBtn} onClick={() => b.send({ type: "editKf", index, fov: true })}>Lens</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Camera */
function CameraTab({ b }: { b: Bridge }) {
  const { cam, exec } = b;
  const v = cam?.view || {};
  const [goto, setGoto] = useState("");
  const speeds = ["0.01", "0.1", "0.25", "0.5", "1"];
  return (
    <div className="space-y-2.5">
      <CaptureButton b={b} />

      <div className="border border-line p-2.5 font-mono text-[11px] leading-relaxed">
        <Row label="pos" value={`${f(v.x)}, ${f(v.y)}, ${f(v.z)}`} />
        <Row label="ang" value={`${f(v.rX)}, ${f(v.rY)}, ${f(v.rZ)}`} />
        <Row
          label="lens"
          value={typeof v.fov === "number" ? `${fmtFocal(v.fov)} · ${f(v.fov)}°` : "–"}
        />
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button className={btn} onClick={() => exec("demo_pause")}><Pause size={13} /> Pause</button>
        <button className={btn} onClick={() => exec("demo_resume")}><Play size={13} /> Resume</button>
      </div>

      <div className="flex gap-1.5">
        <input
          className={input}
          type="number"
          value={goto}
          onChange={(e) => setGoto(e.target.value)}
          placeholder="tick"
        />
        <button className={btn} onClick={() => goto !== "" && exec("demo_gototick " + goto)}>Go to tick</button>
      </div>

      <div>
        <div className={`mb-1 ${label}`}>speed</div>
        <div className="grid grid-cols-5 gap-1">
          {speeds.map((s) => (
            <button key={s} className={btn} onClick={() => exec("demo_timescale " + s)}>{s}×</button>
          ))}
        </div>
      </div>

      <div>
        <div className={`mb-1 ${label}`}>lens (focal length)</div>
        <div className="grid grid-cols-5 gap-1">
          {[18, 24, 35, 50, 85].map((mm) => (
            <button
              key={mm}
              className={btn}
              title={`${focalToFov(mm).toFixed(1)}° FOV`}
              onClick={() => exec("mirv_input fov " + focalToFov(mm).toFixed(2))}
            >
              {mm}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className={`mb-1 ${label}`}>camera</div>
        <div className="grid grid-cols-3 gap-1">
          <button className={btn} onClick={() => exec("mirv_input camera")}><Camera size={13} /> Cam</button>
          <button className={btn} onClick={() => exec("mirv_fix animations 1")}><Wrench size={13} /> Anims</button>
          <button
            className={btn}
            onClick={() =>
              exec(
                "sv_cheats 1;mirv_cvar_unhide_all;mirv_fix animations 1;cl_demo_predict 0;cl_trueview_show_status 0;r_show_build_info false",
              )
            }
          >
            <Clapperboard size={13} /> Setup
          </button>
        </div>
      </div>

      {SHOW_LOCKON && <FollowSection b={b} />}
    </div>
  );
}

function RangeRow({
  lbl, val, set, min, max, step = 1, unit = "",
}: {
  lbl: string; val: number; set: (n: number) => void;
  min: number; max: number; step?: number; unit?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className={label}>{lbl}</span>
        <span className="font-mono text-text">{val}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={val}
        onChange={(e) => set(Number(e.target.value))}
        className="w-full accent-[var(--color-accent)]"
      />
    </div>
  );
}

/* ------------------------------------------------- live lock-on (follow cam) */
function FollowSection({ b }: { b: Bridge }) {
  const { players, send } = b;
  const [target, setTarget] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [mode, setMode] = useState<"third" | "eye">("third");
  const [dist, setDist] = useState(120);
  const [height, setHeight] = useState(14);
  const [side, setSide] = useState(0);
  const [smooth, setSmooth] = useState(60); // percent
  const [fov, setFov] = useState(90);

  const opts = { mode, dist, height, side, smooth: smooth / 100, fov };

  // Pull the player list on mount, then refresh every 2s so alive/dead stays current.
  useEffect(() => {
    send({ type: "players" });
    const id = setInterval(() => send({ type: "players" }), 2000);
    return () => clearInterval(id);
  }, [send]);

  // Push live tweaks to the bridge while locked on.
  useEffect(() => {
    if (locked && target !== null) send({ type: "followSet", opts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dist, height, side, smooth, fov]);

  const pick = (idx: number) => {
    setTarget(idx);
    setLocked(true);
    send({ type: "follow", idx, opts });
  };
  const toggleLock = () => {
    if (locked) {
      setLocked(false);
      send({ type: "followStop" });
    } else if (target !== null) {
      setLocked(true);
      send({ type: "follow", idx: target, opts });
    }
  };

  return (
    <div className="space-y-2 border-t border-line pt-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sub">
          <Crosshair size={13} /> Live lock-on
        </div>
        <button
          className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted transition hover:text-text"
          onClick={() => send({ type: "players" })}
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      <div className="max-h-36 space-y-1 overflow-y-auto">
        {players.map((p) => {
          const on = target === p.idx;
          const teamTag = p.team === 3 ? "CT" : p.team === 2 ? "T" : "–";
          return (
            <button
              key={p.idx}
              onClick={() => pick(p.idx)}
              className={`flex w-full items-center gap-2 border px-2.5 py-2 text-left transition ${
                on ? "border-accent! text-text" : "border-line text-sub hover:border-muted hover:text-text"
              }`}
            >
              <span className={`w-4 shrink-0 text-[9px] font-bold ${p.team === 3 ? "text-sky-400" : p.team === 2 ? "text-amber-400" : "text-muted"}`}>
                {teamTag}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px]">{p.name}</span>
              {!p.alive && <span className="text-[9px] uppercase text-danger">dead</span>}
              {on && (
                <span className="text-[9px] uppercase tracking-wide text-accent">
                  {locked ? "locked" : "picked"}
                </span>
              )}
            </button>
          );
        })}
        {players.length === 0 && (
          <p className="px-0.5 py-3 text-center text-[11px] text-muted">
            No players — load a demo, then Refresh.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 border border-line">
        {(["third", "eye"] as const).map((m, i) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`py-1.5 text-[11px] font-medium uppercase tracking-wide transition ${
              i === 0 ? "border-r border-line" : ""
            } ${mode === m ? "bg-accent text-bg" : "text-sub hover:text-text"}`}
          >
            {m === "third" ? "3rd person" : "Eye / 1st"}
          </button>
        ))}
      </div>

      {mode === "third" && (
        <>
          <RangeRow lbl="distance" val={dist} set={setDist} min={30} max={400} unit="u" />
          <RangeRow lbl="height" val={height} set={setHeight} min={-30} max={90} unit="u" />
          <RangeRow lbl="side" val={side} set={setSide} min={-90} max={90} unit="u" />
        </>
      )}
      <RangeRow lbl="smoothing" val={smooth} set={setSmooth} min={0} max={100} step={5} unit="%" />

      <div>
        <div className={`mb-1 ${label}`}>lens (focal length)</div>
        <div className="grid grid-cols-5 gap-1">
          {[18, 24, 35, 50, 85].map((mm) => {
            const f2 = +focalToFov(mm).toFixed(1);
            const on = Math.abs(fov - f2) < 0.5;
            return (
              <button
                key={mm}
                className={`${btn} ${on ? btnActive : ""}`}
                onClick={() => setFov(f2)}
              >
                {mm}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={toggleLock}
        disabled={target === null}
        className={`flex w-full items-center justify-center gap-2 border py-2.5 text-[12px] font-semibold uppercase tracking-wide transition disabled:opacity-40 ${
          locked ? "border-accent! bg-accent text-bg" : "border-muted text-text hover:border-text"
        }`}
      >
        <Crosshair size={14} strokeWidth={2.5} />
        {target === null ? "Pick a player" : locked ? "Locked — tap to release" : "Lock on"}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------- DoF */
function DofTab({ b }: { b: Bridge }) {
  const focalMm = fovToFocal(b.cam?.view?.fov) ?? 50;
  const [focus, setFocus] = useState("512");
  const [fstop, setFstop] = useState(2.8);
  const [on, setOn] = useState(false);

  const focusN = Math.max(Number(focus) || 0, 0);
  const p = computeDof(focusN, fstop, focalMm);
  const r = (n: number) => Math.round(n);
  const farTxt = (n: number) => (n >= 100000 ? "∞" : String(r(n)));

  // Keep the bridge in sync with focus + aperture, so captured keyframes grab this
  // focus and playback can rack it along the path.
  useEffect(() => {
    b.send({ type: "dof", focus: focusN, fstop });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusN, fstop]);

  // Live DoF — push the override planes as the slider / aperture move so focus
  // racks in real time. Throttled (~25/s) with a trailing send, so dragging
  // doesn't flood the socket but always lands on the value you let go on.
  const lastSent = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendDof = (fcs: number, fst: number) => {
    const q = computeDof(Math.max(fcs, 0), fst, focalMm);
    b.exec(
      `r_dof_override 1;` +
        `r_dof_override_near_blurry ${r(q.nearBlurry)};` +
        `r_dof_override_near_crisp ${r(q.nearCrisp)};` +
        `r_dof_override_far_crisp ${r(q.farCrisp)};` +
        `r_dof_override_far_blurry ${r(q.farBlurry)}`,
    );
    setOn(true);
  };
  const liveDof = (fcs: number, fst: number) => {
    if (trailing.current) clearTimeout(trailing.current);
    const gap = 40;
    const now = Date.now();
    if (now - lastSent.current >= gap) {
      lastSent.current = now;
      sendDof(fcs, fst);
    } else {
      trailing.current = setTimeout(() => {
        lastSent.current = Date.now();
        trailing.current = null;
        sendDof(fcs, fst);
      }, gap);
    }
  };
  const disableDof = () => {
    if (trailing.current) clearTimeout(trailing.current);
    b.exec("r_dof_override 0");
    setOn(false);
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className={label}>focus distance</span>
          <span className="font-mono text-text">{r(focusN)} u</span>
        </div>
        <input
          type="range" min={16} max={4000} step={4} value={focusN}
          onChange={(e) => { setFocus(e.target.value); liveDof(Number(e.target.value), fstop); }}
          className="w-full accent-[var(--color-accent)]"
        />
      </div>

      <div>
        <div className={`mb-1 ${label}`}>aperture · shallow → deep</div>
        <div className="grid grid-cols-4 gap-1">
          {F_STOPS.map((n) => (
            <button
              key={n}
              onClick={() => { setFstop(n); if (on) liveDof(focusN, n); }}
              className={`${btn} ${fstop === n ? btnActive : ""}`}
            >
              f/{n}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          className={`${btn} ${on ? btnActive : ""}`}
          onClick={() => (on ? disableDof() : liveDof(focusN, fstop))}
        >
          <Aperture size={13} /> {on ? "DoF on" : "Enable DoF"}
        </button>
        <button className={btn} onClick={disableDof}>DoF off</button>
      </div>

      <button
        className={`${btn} w-full`}
        onClick={() => b.send({ type: "setKfFocus", focus: focusN })}
        title="Store this focus distance on the keyframe selected in the Path tab"
      >
        <Route size={13} /> Set focus on selected keyframe
      </button>

      <div className="border border-line p-2.5 font-mono text-[11px] text-muted">
        <div className={`mb-1 ${label} px-0`}>
          @ {fmtFocal(b.cam?.view?.fov ?? focalToFov(focalMm))} · f/{fstop}
        </div>
        <div className="flex justify-between"><span>sharp from</span><span className="text-text">{r(p.nearCrisp)}</span></div>
        <div className="flex justify-between"><span>sharp to</span><span className="text-text">{farTxt(p.farCrisp)}</span></div>
        <div className="flex justify-between"><span>full blur</span><span>&lt;{r(p.nearBlurry)} · &gt;{farTxt(p.farBlurry)}</span></div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Drag the slider and focus racks live in-game. The focus distance is{" "}
        <span className="text-sub">saved into each keyframe you capture</span>, so on
        playback the focus pulls along the path (aperture stays fixed for the shot).
        To retune one point: select it in the Path tab, set focus here, hit{" "}
        <span className="text-sub">Set focus on selected keyframe</span>.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------- HUD */
type HudElement = { key: string; label: string; on: string; off: string; def: boolean };
const HUD_ELEMENTS: HudElement[] = [
  { key: "hud", label: "HUD", on: "cl_drawhud 1", off: "cl_drawhud 0", def: true },
  { key: "crosshair", label: "Crosshair", on: "crosshair 1", off: "crosshair 0", def: true },
  { key: "weapon", label: "Weapon", on: "r_drawviewmodel 1", off: "r_drawviewmodel 0", def: true },
  { key: "killfeed", label: "Kill feed", on: "cl_draw_only_deathnotices 1", off: "cl_draw_only_deathnotices 0", def: true },
  { key: "radar", label: "Radar", on: "cl_drawhud_force_radar -1", off: "cl_drawhud_force_radar 0", def: true },
  { key: "xray", label: "X-ray", on: "spec_show_xray 1", off: "spec_show_xray 0", def: true },
];

// One-tap filming modes. Each sets a coherent HUD combo and a matching
// element-visibility snapshot so the toggles below stay in sync.
type HudMode = {
  key: string;
  label: string;
  Icon: typeof Route;
  hint: string;
  cmd: string;
  vis: Record<string, boolean>;
};
const HUD_MODES: HudMode[] = [
  {
    key: "cinematic",
    label: "Cinematic",
    Icon: Clapperboard,
    hint: "Totally clean frame — no HUD, no kill feed, no crosshair or weapon. Pure camera shot.",
    cmd: "sv_cheats 1;cl_drawhud 0;cl_draw_only_deathnotices 0;crosshair 0;r_drawviewmodel 0;spec_show_xray 0",
    vis: { hud: false, crosshair: false, weapon: false, killfeed: false, radar: false, xray: false },
  },
  {
    key: "clip",
    label: "Clip",
    Icon: Video,
    hint: "Gameplay clip look — HUD clutter gone, but kill feed, crosshair and weapon stay on.",
    cmd: "sv_cheats 1;cl_drawhud 0;cl_draw_only_deathnotices 1;crosshair 1;r_drawviewmodel 1;spec_show_xray 0",
    vis: { hud: false, crosshair: true, weapon: true, killfeed: true, radar: false, xray: false },
  },
  {
    key: "full",
    label: "Full HUD",
    Icon: Eye,
    hint: "Normal in-game HUD — everything drawn, back to default.",
    cmd: "cl_drawhud 1;cl_draw_only_deathnotices 0;crosshair 1;r_drawviewmodel 1",
    vis: { hud: true, crosshair: true, weapon: true, killfeed: true, radar: true, xray: false },
  },
];

function HudTab({ b }: { b: Bridge }) {
  const { exec } = b;
  const [vis, setVis] = useState<Record<string, boolean>>(
    Object.fromEntries(HUD_ELEMENTS.map((e) => [e.key, e.def])),
  );
  const [mode, setMode] = useState<string | null>(null);

  const applyMode = (m: HudMode) => {
    exec(m.cmd);
    setVis(m.vis);
    setMode(m.key);
  };
  const toggle = (e: HudElement) => {
    const next = !vis[e.key];
    exec(next ? e.on : e.off);
    setVis((v) => ({ ...v, [e.key]: next }));
    setMode(null); // manual tweak breaks the clean preset
  };

  const activeHint = HUD_MODES.find((m) => m.key === mode)?.hint;

  return (
    <div className="space-y-2.5">
      <div className={label}>mode</div>
      <div className="grid grid-cols-3 gap-1.5">
        {HUD_MODES.map((m) => {
          const on = mode === m.key;
          return (
            <button
              key={m.key}
              onClick={() => applyMode(m)}
              className={`flex flex-col items-center gap-1.5 border px-1 py-2.5 text-[10px] font-semibold uppercase tracking-wide transition ${
                on
                  ? "border-accent! bg-accent text-bg"
                  : "border-line text-sub hover:border-muted hover:text-text"
              }`}
            >
              <m.Icon size={16} strokeWidth={1.75} />
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="min-h-[28px] text-[11px] leading-relaxed text-muted">
        {activeHint ?? "Pick a filming mode, then fine-tune individual elements below."}
      </p>

      <div className={`${label} pt-0.5`}>elements</div>
      <div className="grid grid-cols-2 gap-1.5">
        {HUD_ELEMENTS.map((e) => {
          const on = vis[e.key];
          return (
            <button
              key={e.key}
              onClick={() => toggle(e)}
              className={`flex items-center justify-between border px-2.5 py-2 text-[11px] font-medium uppercase tracking-wide transition ${
                on ? "border-line text-sub hover:border-muted hover:text-text" : "border-accent! text-accent"
              }`}
            >
              {e.label}
              {on ? <Eye size={14} strokeWidth={1.75} /> : <EyeOff size={14} strokeWidth={1.75} />}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Most toggles need <span className="text-sub">sv_cheats 1</span> — the modes set
        it for you. Kill feed / radar only show with the full HUD off.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- Console */
function ConsoleTab({ b }: { b: Bridge }) {
  const [cmd, setCmd] = useState("");
  const [blockName, setBlockName] = useState("");
  const run = () => {
    const c = cmd.trim();
    if (c) {
      b.exec(c);
      setCmd("");
    }
  };
  const blockKills = () => {
    const n = blockName.trim();
    if (!n) return b.exec("// enter your player name first");
    if (
      confirm(
        `Block other kills\n\nYou must be spectating "${n}". This keeps only kill-feed entries involving "${n}" and blocks the rest.\n\nApply?`,
      )
    ) {
      b.exec(`mirv_deathmsg filter add attackerMatch=!${n} victimMatch=!${n} block=1 lastRule=1`);
    }
  };
  return (
    <div className="space-y-2.5">
      <div className="flex gap-1.5">
        <input
          className={`${input} font-mono`}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="any CS2 / HLAE command…"
        />
        <button className={btn} onClick={run}><Send size={13} /></button>
      </div>

      <div className="flex gap-1.5">
        <input
          className={input}
          value={blockName}
          onChange={(e) => setBlockName(e.target.value)}
          placeholder="your name"
        />
        <button className={`${btn} ${btnDanger}`} onClick={blockKills}>Block kills</button>
      </div>

      <pre className="h-48 overflow-y-auto border border-line bg-black p-2 font-mono text-[11px] leading-relaxed text-muted">
        {b.log.map((l, i) => (
          <div key={i}>
            <span className="text-line">{l.t}</span> {l.msg}
          </div>
        ))}
      </pre>
    </div>
  );
}
