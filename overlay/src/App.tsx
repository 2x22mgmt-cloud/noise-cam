import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useBridge, isTauri, TICKRATE, type Bridge, type Keyframe } from "./useBridge";
import { fmtFocal, fovToFocal, focalToFov } from "./lens";
import { computeDof, F_STOPS } from "./dof";

const f = (n: unknown, d = 1) =>
  typeof n === "number" && isFinite(n) ? n.toFixed(d) : "–";

const btn =
  "px-2.5 py-1.5 rounded-md border border-line bg-card/80 hover:border-accent/60 hover:bg-card text-xs font-semibold transition disabled:opacity-40";
const btnActive = "border-accent! bg-accent/15! text-accent";
const btnDanger = "border-danger/40! text-danger hover:bg-danger/10!";
const input =
  "px-2 py-1.5 rounded-md border border-line bg-bg/60 text-xs outline-none focus:border-accent/60 w-full";

type TabKey = "path" | "camera" | "dof" | "record" | "console";
const TABS: { key: TabKey; label: string }[] = [
  { key: "path", label: "Path" },
  { key: "camera", label: "Camera" },
  { key: "dof", label: "DoF" },
  { key: "record", label: "Rec" },
  { key: "console", label: "Console" },
];

export default function App() {
  const b = useBridge();
  const [tab, setTab] = useState<TabKey>("path");

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-line bg-[#12151b]/92 backdrop-blur-md">
      <TitleBar status={b.status} />
      <Readout b={b} />
      <nav className="flex gap-1 border-b border-line px-2 pb-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs font-bold transition ${
              tab === t.key
                ? "bg-accent/15 text-accent"
                : "text-muted hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-2.5">
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
    <header
      data-tauri-drag-region
      className="flex items-center gap-2 border-b border-line px-3 py-2"
    >
      <img src="/logo.png" alt="" className="h-4 w-auto pointer-events-none" />
      <span className="text-sm font-extrabold tracking-wide">
        Noise <span className="text-accent">Cam</span>
      </span>
      <div className="ml-auto flex items-center gap-1.5 rounded-full border border-line bg-card/70 px-2 py-0.5 text-[11px] font-semibold text-muted">
        <span
          className={`h-2 w-2 rounded-full ${
            status.hlae ? "bg-accent-2" : "bg-muted/50"
          }`}
        />
        {status.text}
      </div>
      {isTauri() && (
        <button
          onClick={() => getCurrentWindow().hide()}
          title="Hide overlay (Alt+Shift+D)"
          className="rounded-md px-1.5 py-0.5 text-muted hover:bg-danger/15 hover:text-danger"
        >
          ✕
        </button>
      )}
    </header>
  );
}

/* ----------------------------------------------------------- live readout */
function Readout({ b }: { b: Bridge }) {
  const v = b.cam?.view || {};
  return (
    <div className="grid grid-cols-4 gap-px border-b border-line bg-line/40 text-center">
      <Stat label="tick" value={b.cam?.demoTick ?? "–"} />
      <Stat
        label="time"
        value={b.cam?.demoTime != null ? f(b.cam.demoTime, 2) + "s" : "–"}
      />
      <Stat label="lens" value={fmtFocal(v.fov)} />
      <Stat label="state" value={b.cam?.paused ? "⏸" : "▶"} />
    </div>
  );
}
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-bg/50 px-1 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-mono text-xs font-bold tabular-nums">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Path */
function PathTab({ b }: { b: Bridge }) {
  const [drawOn, setDrawOn] = useState(false);
  const [name, setName] = useState("myshot");
  const [sel, setSel] = useState<number | null>(null);
  const { keyframes, send, exec } = b;

  const selectKf = (i: number) => {
    setSel(i);
    send({ type: "select", index: i }); // highlights it in-game (with draw on)
  };
  const selValid = sel != null && sel < keyframes.items.length;

  return (
    <div className="space-y-2.5">
      <button
        onClick={() => send({ type: "capture" })}
        className="w-full rounded-lg border border-accent/50 bg-accent/15 py-2.5 text-sm font-extrabold text-accent hover:bg-accent/25"
      >
        ● Capture keyframe
      </button>

      <div className="grid grid-cols-3 gap-1.5">
        <button
          onClick={() => send({ type: "enable", on: !keyframes.enabled })}
          className={`${btn} ${keyframes.enabled ? btnActive : ""}`}
        >
          {keyframes.enabled ? "Disable" : "Enable"}
        </button>
        <button
          onClick={() => {
            const next = !drawOn;
            setDrawOn(next);
            send({ type: "draw", on: next });
          }}
          className={`${btn} ${drawOn ? btnActive : ""}`}
        >
          Show path
        </button>
        <button
          onClick={() => confirm("Clear all keyframes?") && send({ type: "clear" })}
          className={`${btn} ${btnDanger}`}
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
        <button className={btn} onClick={() => exec("mirv_campath save " + (name || "myshot"))}>
          Save
        </button>
        <button className={btn} onClick={() => exec("mirv_campath load " + (name || "myshot"))}>
          Load
        </button>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between px-0.5">
          <span className="text-xs font-bold text-muted">Keyframes</span>
          <span className="text-xs text-muted">({keyframes.count})</span>
        </div>
        <div className="grid grid-cols-[1.4rem_3rem_1fr_2.2rem_2.6rem] gap-1 px-1 pb-1 text-[10px] uppercase tracking-wide text-muted">
          <span>#</span><span>time</span><span>pos</span><span>fov</span><span>roll</span>
        </div>
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {keyframes.items.length === 0 ? (
            <div className="rounded-md border border-dashed border-line px-2 py-3 text-center text-[11px] text-muted">
              No keyframes yet — fly the cam and hit Capture.
            </div>
          ) : (
            keyframes.items.map((k, i) => (
              <KfRow key={i} i={i} k={k} b={b} selected={sel === i} onSelect={() => selectKf(i)} />
            ))
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
  const a = k.ang || {};
  const tick = typeof k.tick === "number" ? k.tick : Math.round((k.time || 0) * TICKRATE);
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      onClick={onSelect}
      className={`grid cursor-pointer grid-cols-[1.4rem_3rem_1fr_2.2rem_2.6rem_auto] items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] ${
        selected ? "border-accent bg-accent/15" : "border-line bg-card/50 hover:border-accent/40"
      }`}
    >
      <span className="text-muted">{i}</span>
      <span className="font-mono tabular-nums">{f(k.time, 2)}s</span>
      <span className="truncate font-mono text-muted">
        {f(p.x)}, {f(p.y)}, {f(p.z)}
      </span>
      <span className="font-mono tabular-nums">{f(k.fov)}</span>
      <span className="font-mono tabular-nums">{f(a.roll)}</span>
      <span className="flex gap-1">
        <button
          title={`demo_gototick ${tick}`}
          onClick={stop(() => b.exec("demo_gototick " + tick))}
          className="rounded border border-line px-1.5 py-0.5 hover:border-accent/60 hover:text-accent"
        >
          Go
        </button>
        <button
          onClick={stop(() => b.send({ type: "remove", index: i }))}
          className="rounded border border-danger/40 px-1.5 py-0.5 text-danger hover:bg-danger/10"
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/* Edit the selected keyframe: fly the cam to a new spot, then move the keyframe
   to it (position / angle / lens), via mirv_campath select + edit ... current. */
function EditBar({ b, index }: { b: Bridge; index: number }) {
  const editBtn =
    "flex-1 rounded-md border border-line bg-card/70 px-1.5 py-1.5 text-[11px] font-semibold hover:border-accent/60 hover:bg-card";
  return (
    <div className="mt-2 rounded-lg border border-accent/40 bg-accent/5 p-2">
      <div className="mb-1.5 text-[11px] text-muted">
        Editing <span className="font-bold text-accent">keyframe #{index}</span> — fly the cam where
        you want it, then:
      </div>
      <div className="flex gap-1.5">
        <button
          className="flex-[1.4] rounded-md border border-accent/50 bg-accent/15 px-1.5 py-1.5 text-[11px] font-extrabold text-accent hover:bg-accent/25"
          onClick={() => b.send({ type: "editKf", index, pos: true, ang: true })}
        >
          ⟳ Move here
        </button>
        <button className={editBtn} onClick={() => b.send({ type: "editKf", index, pos: true })}>
          pos
        </button>
        <button className={editBtn} onClick={() => b.send({ type: "editKf", index, ang: true })}>
          angle
        </button>
        <button className={editBtn} onClick={() => b.send({ type: "editKf", index, fov: true })}>
          lens
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Camera */
function CameraTab({ b }: { b: Bridge }) {
  const { cam, exec, send } = b;
  const v = cam?.view || {};
  const [goto, setGoto] = useState("");
  const speeds = ["0.01", "0.1", "0.25", "0.5", "1"];
  return (
    <div className="space-y-2.5">
      <button
        onClick={() => send({ type: "capture" })}
        className="w-full rounded-lg border border-accent/50 bg-accent/15 py-2 text-sm font-extrabold text-accent hover:bg-accent/25"
      >
        ● Capture keyframe
      </button>

      <div className="rounded-lg border border-line bg-card/40 p-2 font-mono text-[11px] leading-relaxed">
        <Row label="pos" value={`${f(v.x)}, ${f(v.y)}, ${f(v.z)}`} />
        <Row label="ang" value={`${f(v.rX)}, ${f(v.rY)}, ${f(v.rZ)}`} />
        <Row
          label="lens"
          value={
            typeof v.fov === "number"
              ? `${fmtFocal(v.fov)}  ·  ${f(v.fov)}°`
              : "–"
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button className={btn} onClick={() => exec("demo_pause")}>⏸ Pause</button>
        <button className={btn} onClick={() => exec("demo_resume")}>▶ Resume</button>
      </div>

      <div className="flex gap-1.5">
        <input
          className={input}
          type="number"
          value={goto}
          onChange={(e) => setGoto(e.target.value)}
          placeholder="tick"
        />
        <button
          className={btn}
          onClick={() => goto !== "" && exec("demo_gototick " + goto)}
        >
          Go to tick
        </button>
      </div>

      <div>
        <div className="mb-1 px-0.5 text-[10px] uppercase tracking-wide text-muted">speed</div>
        <div className="grid grid-cols-5 gap-1">
          {speeds.map((s) => (
            <button key={s} className={btn} onClick={() => exec("demo_timescale " + s)}>
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 px-0.5 text-[10px] uppercase tracking-wide text-muted">lens (focal length)</div>
        <div className="grid grid-cols-5 gap-1">
          {[18, 24, 35, 50, 85].map((mm) => (
            <button
              key={mm}
              className={btn}
              title={`${focalToFov(mm).toFixed(1)}° FOV`}
              onClick={() => exec("mirv_input fov " + focalToFov(mm).toFixed(2))}
            >
              {mm}mm
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 px-0.5 text-[10px] uppercase tracking-wide text-muted">camera</div>
        <div className="grid grid-cols-3 gap-1">
          <button className={btn} onClick={() => exec("mirv_input camera")}>🎥 Cam mode</button>
          <button className={btn} onClick={() => exec("mirv_fix animations 1")}>Fix anims</button>
          <button
            className={btn}
            onClick={() =>
              exec(
                "sv_cheats 1;mirv_cvar_unhide_all;mirv_fix animations 1;cl_drawhud 0;cl_draw_only_deathnotices 1;cl_demo_predict 0;cl_trueview_show_status 0;r_show_build_info false",
              )
            }
          >
            🎬 Scene setup
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
  // Focal length comes from the live lens (FOV); fall back to 50mm if no stream.
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
      {/* focus distance */}
      <div>
        <div className="mb-1 flex items-center justify-between px-0.5 text-[11px] text-muted">
          <span>focus distance</span>
          <span className="font-mono text-text">{r(focusN)} u</span>
        </div>
        <input
          type="range"
          min={16}
          max={4000}
          step={4}
          value={focusN}
          onChange={(e) => setFocus(e.target.value)}
          className="w-full accent-[var(--color-accent)]"
        />
      </div>

      {/* aperture */}
      <div>
        <div className="mb-1 px-0.5 text-[11px] text-muted">aperture · shallower ← → deeper</div>
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
        <button className={`${btn} ${btnActive}`} onClick={apply}>🔵 Apply DoF</button>
        <button className={btn} onClick={() => b.exec("r_dof_override 0")}>⚪ DoF off</button>
      </div>

      {/* transparency: show the computed engine planes so it isn't a black box */}
      <div className="rounded-lg border border-line bg-card/40 p-2 font-mono text-[11px] text-muted">
        <div className="mb-1 font-sans text-[10px] uppercase tracking-wide">
          computed @ {fmtFocal(b.cam?.view?.fov ?? focalToFov(focalMm))} · f/{fstop}
        </div>
        <div className="flex justify-between"><span>sharp from</span><span className="text-text">{r(p.nearCrisp)}</span></div>
        <div className="flex justify-between"><span>sharp to</span><span className="text-text">{farTxt(p.farCrisp)}</span></div>
        <div className="flex justify-between"><span>full blur &lt;</span><span>{r(p.nearBlurry)} · &gt; {farTxt(p.farBlurry)}</span></div>
      </div>

      <p className="px-0.5 text-[11px] leading-relaxed text-muted">
        Set where the subject is sharp and how shallow the look is — the four engine
        planes are computed from lens optics. CS2 has no depth pass, so this is the
        real-time path.
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
  // when recording a campath, auto-stop once the demo tick passes this
  const endTick = useRef<number | null>(null);

  const ticks = keyframes.items
    .map((k) => (typeof k.tick === "number" ? k.tick : undefined))
    .filter((t): t is number => typeof t === "number");
  const startTick = ticks.length ? Math.min(...ticks) : null;
  const lastTick = ticks.length ? Math.max(...ticks) : null;

  // Build the HLAE mirv_streams setup: pipe the beauty pass through FFmpeg to mp4.
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

  // Killer button: enable path -> seek to start -> record -> play, then auto-stop
  // when the live tick reaches the last keyframe.
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

  // Watch the live tick; stop recording when the campath reaches its end.
  const liveTick = b.cam?.demoTick;
  useEffect(() => {
    if (recording && endTick.current != null && typeof liveTick === "number") {
      if (liveTick >= endTick.current) stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick]);

  const field = (label: string, value: string, set: (v: string) => void, type = "text") => (
    <label className="flex flex-col gap-1 text-[11px] text-muted">
      {label}
      <input className={input} type={type} value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <div className="space-y-2.5">
      {field("output folder", folder, setFolder)}
      <div className="grid grid-cols-2 gap-2">
        {field("fps", fps, setFps, "number")}
        {field("quality (CRF, lower = better)", crf, setCrf, "number")}
      </div>
      <button className={btn + " w-full"} onClick={applySettings}>
        Apply recording settings
      </button>

      <button
        onClick={recordCampath}
        disabled={!keyframes.items.length}
        className="w-full rounded-lg border border-danger/50 bg-danger/15 py-2.5 text-sm font-extrabold text-danger hover:bg-danger/25 disabled:opacity-40"
      >
        ⏺ Record this campath
      </button>

      <div className="grid grid-cols-2 gap-1.5">
        <button className={`${btn} ${recording ? btnActive : ""}`} onClick={start}>
          ● Start
        </button>
        <button className={`${btn} ${btnDanger}`} onClick={stop}>
          ■ Stop
        </button>
      </div>

      <div className="rounded-lg border border-line bg-card/40 p-2 text-[11px] leading-relaxed text-muted">
        {recording ? (
          <span className="text-danger">
            ⏺ recording{endTick.current != null ? ` → auto-stop at tick ${endTick.current}` : ""}
          </span>
        ) : startTick != null ? (
          <>Path spans tick {startTick} → {lastTick}. FFmpeg must be on PATH / in HLAE.</>
        ) : (
          <>Capture a path first, then “Record this campath”. Needs FFmpeg (HLAE).</>
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
        <button className={btn} onClick={run}>Send</button>
      </div>

      <div className="flex gap-1.5">
        <input
          className={input}
          value={blockName}
          onChange={(e) => setBlockName(e.target.value)}
          placeholder="your name"
        />
        <button className={`${btn} ${btnDanger}`} onClick={blockKills}>
          Block other kills
        </button>
      </div>

      <pre className="h-48 overflow-y-auto rounded-lg border border-line bg-bg/60 p-2 font-mono text-[11px] leading-relaxed text-muted">
        {b.log.map((l, i) => (
          <div key={i}>
            <span className="text-line">{l.t}</span> {l.msg}
          </div>
        ))}
      </pre>
    </div>
  );
}
