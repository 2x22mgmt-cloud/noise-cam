# Roadmap

## Phase 0 — Protocol de-risk ✅ DONE
Verified the CS2 live link exists and is sufficient: HLAE's mirv-script engine gives
camera read/override, demo tick/time, campath manipulation, entity data, cvar
read/write, and custom console commands — all sanctioned, no injection. See HLAE-API.md.

## Phase 1 — Hello-bridge ✅ BUILT (awaiting live test in CS2)
Prove the round trip end to end.
- `bridge/dolly-bridge.js` streams camera + demo tick to the editor every frame and
  runs `exec` commands sent back.
- `server/server.mjs` prints the live stream and forwards typed commands.
- Editor-side round trip **verified without CS2** (simulated client, both directions OK).
- **TODO:** run it live in CS2 (`mirv_script_load` the bridge) and confirm the stream
  moves + a command (e.g. `demo_pause`) works. Check for `async ordering` warnings.

## Phase 2 — Capture & apply ✅ BUILT (awaiting live test)
The first interactive value.
- ✅ `mirv_dolly` command registered (capture/clear/enable/disable/draw/drawoff) +
  starter `cfg/dolly.cfg` binds. Capture uses HLAE's `mirv_campath add` (HLAE stores
  the correct quaternion — no manual euler→quat needed).
- ✅ Server REPL: capture/list/clear/remove/enable/disable/draw/interp + raw exec.
- ✅ Live keyframe list pushed to the editor on every campath change (`onChanged`).
- ✅ Reload-safe bridge (`globalThis.__cs2_dolly.cleanup`); `connected!` log; `undefined` gone.
- ✅ Server roundtrip verified on alt port (keyframe table + capture/remove commands).
- **TODO (live):** capture a few keyframes at different ticks in CS2, confirm the list
  populates, `enable`, unpause, watch the move play.
- **Phase 2b (next):** auto-focus channel via camera→entity distance → `r_dof_override`.

## Phase 3 — GUI app ✅ v1 BUILT (browser-based)
- `app/` — Node server serves the web UI (`app/public/`) and relays browser ↔ CS2.
- Control panel: live readout, capture/enable/draw/clear, save/load, keyframe list
  (go/delete), transport (pause/resume/gototick/timescale), macros, raw console.
- `Dolly.bat` one-click launcher (auto-opens browser). Bridge unchanged.
- Verified: renders clean, no console errors, /ui relay works. Live CS2 test pending.

## Phase 3.5 — React rebuild (planned, AFTER smoke-testing vanilla v1)
Once the vanilla GUI is confirmed working live with CS2, rebuild the UI on
**React + Tailwind + shadcn/ui (Vite)** as the real foundation.
- Still packages fine: Vite builds to static files our Node server serves (and wraps
  to a single `.exe` later). Build step is dev-time only.
- shadcn gives polished tabs, sliders, dialogs, etc. for free — ideal for sections,
  the timeline, and DoF/recording controls.
- The `ui-ux-pro-max-skill` (if installed via `uipro init --ai claude`) pairs with
  this stack to guide the design system.

## Phase 3.6 — Sections + two modes (planned)
- **Sectioned, camera-focused layout:** Camera / Path / Recording / Setup tabs.
- **Top-level MODE switch — the product split:**
  - **Cinematics mode** (current focus): crafted dolly shots — keyframe campath,
    DoF, easing, timeline. Build path → enable → preview → record.
  - **Clips mode** (later): grab highlights fast — follow-cam a player, set in/out
    points, one-click record the segment to mp4. Speed-first, stripped-down UI.
  - Both modes share the same bridge + FFmpeg recording engine (Phase 5); Clips
    mode leans on recording heavily.
- Visual timeline/dope-sheet (Cinematics), playhead bound to demo tick
  (`demo_gototick`), draggable keyframes, multi-channel tracks.
- **Risk to watch:** `demo_gototick` latency on long demos — debounce, seek on release.

## Phase 5 — FFmpeg recording section (planned, high value for editors)
Streamline HLAE's recording so a shot goes campath → `.mp4` in a click.
- HLAE pipes frames directly to FFmpeg (no TGA dumps):
  `mirv_streams settings add ffmpeg <preset> "-c:v libx264 -preset slow -crf <n> {QUOTE}{AFX_STREAM_PATH}\\video.mp4{QUOTE}"`,
  `host_framerate <fps>`, `mirv_streams record start` / `mirv_streams record end`.
- UI: output folder, fps, codec/CRF/format preset, Start/Stop — and the killer button
  **"Record this campath"**: enable path → gototick start → record → play → stop at end.
- Gotchas: FFmpeg must be installed (HLAE installer option / ffmpeg subfolder);
  audio is captured via `startmovie`, so muxing audio is a separate step to handle.
- **Recording (CS2-accurate):** in practice `mirv_streams` on CS2 is used for the
  **beauty pass** (+ **HUD separation** via alpha or white/black). True high-fps +
  native resolution come for free.
  - ⚠ **No usable depth PASS on CS2** (Source-1 only) → depth/DoF is done **LIVE**:
    native **`r_dof_override`** (real-time, what the user uses) or **ReShade** CinematicDOF
    (depth-buffer access). For a depth *map* in post, no native pass → **AI depth (DA3)**.
  - ⚠ **No per-entity green-screen / matte on CS2** (Source-1 only) → clean SUBJECT
    isolation isn't native → **AI segmentation** (Phase 6).
  → CS2 native = beauty + HUD-sep + true fps + native res. **Depth-map and isolation are
    the two real gaps**, both filled by AI in post.

## Phase 6 — Post / Enhance (optional external)
CS2 native = beauty + HUD-sep + true fps + native res — but **no depth pass and no
green screen**. So AI fills two real gaps (depth map, subject isolation). All optional
CLI shell-outs ("use if installed") — NOT bundled; GPU + separate install.
- **Depth — Depth Anything 3** (bytedance-seed/depth-anything-3, `da3`): genuinely
  useful on CS2 since there's no native depth pass — generate a **depth map** for post
  DoF / fog / relight, plus its **3D reconstruction / Gaussian splats / novel view**.
  (Live DoF can still be baked in-engine via `r_dof_override` / ReShade; DA3 is for
  depth-based POST work and 3D effects.)
- **Segmentation — the other primary need** (CS2 can't green-screen): isolate a player /
  subject for compositing. **SAM 2** (Meta, video segmentation) strongest; TAS seg is an
  alternative. Redundant IF/when HLAE2 ships native entity matte.
- **DROPPED — AI upscale & frame interpolation:** unnecessary. HLAE renders native
  resolution and records true high-fps with real motion blur — AI is redundant + worse.

## Phase 4 — Curves, preview & extras
- Per-channel easing-curve (bezier) graphs.
- 3D path preview using `campath.eval()`.
- Timescale (slow-mo) channel; follow-cam / auto-keyframe a target via entity API.
- Stretch: ReShade focus-bridge addon for live CinematicDOF auto-focus.

---

## Out of scope (deliberate)
- **Skin changing** — would require memory injection into `cs2.exe` (VAC/ToS cheat
  category, regardless of framing). Do skins in **post-production** instead: record the
  weapon with `mirv_streams` (matte pass) and retexture in After Effects/Blender. The
  skin only ever renders on your own screen, so post loses nothing and risks nothing.
- **Campath sharing / cloud** — personal, local-only tool by design.
