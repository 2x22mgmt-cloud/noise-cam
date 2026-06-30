import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Aperture, Camera, CircleDot, Clapperboard, Crosshair, Disc, Move3d,
  Pause, Play, Radio, Route, Send, Square, SquareTerminal, Trash2, Video, Wrench, X,
} from "lucide-react";
import { useBridge, isTauri, TICKRATE, type Bridge, type Keyframe } from "./useBridge";
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

type TabKey = "path" | "camera" | "dof" | "record" | "console";
const TABS: { key: TabKey; label: string; Icon: typeof Route }[] = [
  { key: "path", label: "Path", Icon: Route },
  { key: "camera", label: "Cam", Icon: Video },
  { key: "dof", label: "DoF", Icon: Aperture },
  { key: "record", label: "Rec", Icon: Disc },
  { key: "console", label: "", Icon: SquareTerminal },
];

export default function App() {
  const b = useBridge();
  const [tab, setTab] = useState<TabKey>("path");

  return (
    <div className="flex h-screen flex-col overflow-hidden border border-line bg-[#0a0a0a]/95">
      <TitleBar status={b.status} />
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
      <div className="flex-1 overflow-y-auto p-3">
        {tab === "path" && <PathTab b={b} />}
        {tab === "camera" && <CameraTab b={b} />}
        {tab === "dof" && <DofTab b={b} />}
        {tab === "record" && <RecordTab b={b} />}
        {tab === "console" && <ConsoleTab b={b} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- titlebar */
function TitleBar({ status }: { status: Bridge["status"] }) {
  return (
    <header data-tauri-drag-region className="flex items-center gap-2 border-b border-line px-3 py-2">
      <Radio size={17} strokeWidth={1.75} className="pointer-events-none" />
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

function PathTab({ b }: { b: Bridge }) {
  const [drawOn, setDrawOn] = useState(false);
  const [name, setName] = useState("myshot");
  const [sel, setSel] = useState<number | null>(null);
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
        onClick={() => send({ type: "preview" })}
        disabled={keyframes.items.length < 2}
        className="flex w-full items-center justify-center gap-2 border border-muted py-2 text-[12px] font-semibold uppercase tracking-wide text-text transition hover:border-text disabled:opacity-40"
      >
        <Play size={15} strokeWidth={2} /> Preview shot
      </button>

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
      className={`grid cursor-pointer grid-cols-[20px_48px_1fr_auto] items-center gap-2 border-b border-line-soft px-2.5 py-2 text-[11px] last:border-b-0 ${
        selected ? "border-l-2 border-l-accent bg-accent/[0.07]" : "hover:bg-white/[0.03]"
      }`}
    >
      <span className={selected ? "text-accent" : "text-muted"}>{i}</span>
      <span className="font-mono tabular-nums">{f(k.time, 2)}s</span>
      <span className="truncate font-mono text-muted">
        {f(p.x)}, {f(p.y)}, {f(p.z)}
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
                "sv_cheats 1;mirv_cvar_unhide_all;mirv_fix animations 1;cl_drawhud 0;cl_draw_only_deathnotices 1;cl_demo_predict 0;cl_trueview_show_status 0;r_show_build_info false",
              )
            }
          >
            <Clapperboard size={13} /> Setup
          </button>
        </div>
      </div>
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

  const focusN = Math.max(Number(focus) || 0, 0);
  const p = computeDof(focusN, fstop, focalMm);
  const r = (n: number) => Math.round(n);
  const apply = () =>
    b.exec(
      `r_dof_override 1;` +
        `r_dof_override_near_blurry ${r(p.nearBlurry)};` +
        `r_dof_override_near_crisp ${r(p.nearCrisp)};` +
        `r_dof_override_far_crisp ${r(p.farCrisp)};` +
        `r_dof_override_far_blurry ${r(p.farBlurry)}`,
    );
  const farTxt = (n: number) => (n >= 100000 ? "∞" : String(r(n)));

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className={label}>focus distance</span>
          <span className="font-mono text-text">{r(focusN)} u</span>
        </div>
        <input
          type="range" min={16} max={4000} step={4} value={focusN}
          onChange={(e) => setFocus(e.target.value)}
          className="w-full accent-[var(--color-accent)]"
        />
      </div>

      <div>
        <div className={`mb-1 ${label}`}>aperture · shallow → deep</div>
        <div className="grid grid-cols-4 gap-1">
          {F_STOPS.map((n) => (
            <button
              key={n}
              onClick={() => setFstop(n)}
              className={`${btn} ${fstop === n ? btnActive : ""}`}
            >
              f/{n}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button className={`${btn} ${btnActive}`} onClick={apply}><Aperture size={13} /> Apply</button>
        <button className={btn} onClick={() => b.exec("r_dof_override 0")}>DoF off</button>
      </div>

      <div className="border border-line p-2.5 font-mono text-[11px] text-muted">
        <div className={`mb-1 ${label} px-0`}>
          @ {fmtFocal(b.cam?.view?.fov ?? focalToFov(focalMm))} · f/{fstop}
        </div>
        <div className="flex justify-between"><span>sharp from</span><span className="text-text">{r(p.nearCrisp)}</span></div>
        <div className="flex justify-between"><span>sharp to</span><span className="text-text">{farTxt(p.farCrisp)}</span></div>
        <div className="flex justify-between"><span>full blur</span><span>&lt;{r(p.nearBlurry)} · &gt;{farTxt(p.farBlurry)}</span></div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Set where the subject is sharp and how shallow the look is — the engine
        planes are computed from lens optics.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- Record */
function RecordTab({ b }: { b: Bridge }) {
  const { keyframes, send, exec } = b;
  const [folder, setFolder] = useState("D:\\noisecam\\recordings");
  const [fps, setFps] = useState("60");
  const [crf, setCrf] = useState("16");
  const [recording, setRecording] = useState(false);
  const endTick = useRef<number | null>(null);

  const ticks = keyframes.items
    .map((k) => (typeof k.tick === "number" ? k.tick : undefined))
    .filter((t): t is number => typeof t === "number");
  const startTick = ticks.length ? Math.min(...ticks) : null;
  const lastTick = ticks.length ? Math.max(...ticks) : null;

  const applySettings = () => {
    const preset = "noisecam_h264";
    exec(
      [
        `mirv_streams record name "${folder}"`,
        `host_framerate ${fps}`,
        `mirv_streams settings add ffmpeg ${preset} ` +
          `"-c:v libx264 -preset slow -crf ${crf} -pix_fmt yuv420p {QUOTE}{AFX_STREAM_PATH}.mp4{QUOTE}"`,
        `mirv_streams edit afxDefault settings ${preset}`,
      ].join(";"),
    );
  };
  const start = () => {
    exec("mirv_streams record start");
    setRecording(true);
    endTick.current = null;
  };
  const stop = () => {
    exec("mirv_streams record end;host_framerate 0");
    setRecording(false);
    endTick.current = null;
  };
  const recordCampath = () => {
    if (startTick == null || lastTick == null) {
      b.exec("// no keyframes to record — capture a path first");
      return;
    }
    send({ type: "enable", on: true });
    exec("demo_gototick " + startTick);
    exec("mirv_streams record start");
    exec("demo_resume");
    endTick.current = lastTick;
    setRecording(true);
  };

  const liveTick = b.cam?.demoTick;
  useEffect(() => {
    if (recording && endTick.current != null && typeof liveTick === "number") {
      if (liveTick >= endTick.current) stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  const field = (lbl: string, value: string, set: (v: string) => void, type = "text") => (
    <label className="flex flex-col gap-1">
      <span className={label}>{lbl}</span>
      <input className={input} type={type} value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <div className="space-y-2.5">
      {field("output folder", folder, setFolder)}
      <div className="grid grid-cols-2 gap-2">
        {field("fps", fps, setFps, "number")}
        {field("quality (crf)", crf, setCrf, "number")}
      </div>
      <button className={`${btn} w-full`} onClick={applySettings}>Apply recording settings</button>

      <button
        onClick={recordCampath}
        disabled={!keyframes.items.length}
        className="flex w-full items-center justify-center gap-2 border border-danger py-2.5 text-[12px] font-semibold uppercase tracking-wide text-danger transition hover:bg-danger/10 disabled:opacity-40"
      >
        <Disc size={15} strokeWidth={2} /> Record this campath
      </button>

      <div className="grid grid-cols-2 gap-1.5">
        <button className={`${btn} ${recording ? btnActive : ""}`} onClick={start}><Disc size={13} /> Start</button>
        <button className={`${btn} ${btnDanger}`} onClick={stop}><Square size={13} /> Stop</button>
      </div>

      <div className="border border-line p-2.5 text-[11px] leading-relaxed text-muted">
        {recording ? (
          <span className="text-danger">
            ● recording{endTick.current != null ? ` → auto-stop at tick ${endTick.current}` : ""}
          </span>
        ) : startTick != null ? (
          <>Path spans tick {startTick} → {lastTick}. FFmpeg must be on PATH / in HLAE.</>
        ) : (
          <>Capture a path first, then record it. Needs FFmpeg (HLAE).</>
        )}
      </div>
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
