# Noise Cam

A real-time, visual keyframe **camera-path (dolly) editor for CS2 demos**, built
entirely on HLAE's sanctioned scripting interface — . Think "Airyz T7 Advanced Dolly, but real-time, visual, and for CS2."

Personal tool, local only. (Shareable with a few friends — packaging to a single
`.exe` is a planned step so they won't need Node.)

---

## Quick start (the GUI)

1. **Double-click `NoiseCam.bat`** → installs deps on first run, starts the server, and
   opens the control panel in your browser (http://localhost:31337).
2. **Launch CS2 through HLAE** (AvoidVac / `-insecure`), load a demo (`playdemo …`).
3. In the **CS2 console**, load the bridge:
   ```
   mirv_script_load "C:\Users\User\Downloads\Transfer-to-CA\Projects\cs2-dolly\bridge\noisecam-bridge.js"
   ```
4. The panel's status dot turns green ("CS2 connected"). Fly the cam, hit **Capture**,
   build a path, **Enable**, scrub, preview — all from the browser.

> Run only one server on port 31337 at a time. Close the old Phase-1/2
> `start-server.bat` console (if open) before launching `NoiseCam.bat`.

The GUI lives in **`app/`** (`app/server.mjs` serves the UI in `app/public/` and
relays browser ↔ CS2). The console server in `server/` still works for debugging.

---

## Project layout
```
cs2-dolly/
├─ README.md            ← you are here (setup + Phase 1 test)
├─ NoiseCam.bat         ← double-click to launch the app (server + browser UI)
├─ start-server.bat     ← double-click to launch the legacy console server
├─ bridge/
│  └─ noisecam-bridge.js ← runs inside CS2 via HLAE (mirv_script_load)
├─ server/
│  ├─ server.mjs        ← editor-side WebSocket server (Phase 1 console)
│  └─ package.json
├─ docs/
│  ├─ ARCHITECTURE.md         ← design, message protocol, channel model, stack
│  ├─ HLAE-API.md             ← verified CS2 mirv-script API we build on
│  ├─ ROADMAP.md              ← phases 0–4 + what's out of scope (and why)
│  ├─ PRIOR-ART.md            ← what exists + why CS2 is greenfield
│  └─ COMMANDS-AND-CHANNELS.md← DoF cvars, auto-focus, your workflow mapping
└─ reference/
   └─ cs2-cmd-reference.txt   ← your personal CS2/HLAE command list
```

New here? Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the big picture, then
[docs/ROADMAP.md](docs/ROADMAP.md) for where things stand.

---

## How it works

```
┌──────────────────────────────┐      WebSocket (localhost)       ┌───────────────────────────┐
│  Editor (this repo)          │  ◀── cam pose, demo tick/time ── │  HLAE bridge (noisecam-    │
│  Phase 1: Node console        │                                  │  bridge.js) running inside  │
│  Later:   Tauri + React/TS    │  ─── exec, keyframe ops ──────▶  │  CS2 via mirv-script        │
└──────────────────────────────┘                                  └───────────────────────────┘
```

- **bridge/noisecam-bridge.js** — runs *inside* CS2 through HLAE (`mirv_script_load`).
  Streams the live camera + demo time out, and executes commands sent in.
- **server/** — the editor side. Phase 1 is a tiny Node server that prints the
  camera stream and lets you fire console commands back, to prove the round trip.

The architecture (in-game agent + external editor over a socket) mirrors Airyz's
T7 dolly (C++ DLL + C# tool over a named pipe) — but HLAE gives us the camera
hook, demo tick, and campath storage *officially*, so there's nothing to inject.

---

## Requirements

- **HLAE** 2.183+ (2.189.5+ recommended) — https://github.com/advancedfx/advancedfx
- **CS2 launched through HLAE** with AvoidVac on (this starts CS2 `-insecure`, so
  you are never on a VAC-secured server — demo/movie work only).
- **Node.js** 18+ (you have v24).

---

## Phase 1 — prove the live link

### 1. Start the editor server
```powershell
cd C:\Users\User\Downloads\Transfer-to-CA\Projects\cs2-dolly\server
npm install
npm start
```
You should see: `listening on ws://localhost:31337/mirv`.

### 2. Launch CS2 via HLAE and play a demo
- HLAE → Launch CS2 (AvoidVac enabled).
- In CS2, load a demo: `playdemo <name>`.

### 3. Load the bridge (in the CS2 console)
```
mirv_script_load "C:\Users\User\Downloads\Transfer-to-CA\Projects\cs2-dolly\bridge\noisecam-bridge.js"
```
Within ~1 second the server console should print **"HLAE connected."** and start
showing a live line like:
```
tick=2480 t=38.75s pos=(120.4, -880.1, 64.0) ang=(2.1, 178.4, 0.0) fov=90.0
```
Fly the spectator/free camera around — the numbers should move in real time.

### 4. Test the control channel (editor → game)
In the **server** console, type a command and press Enter, e.g.:
```
demo_pause
```
…then `demo_resume`, or `echo hello_from_editor`. It runs in CS2. That's the full
round trip working — the foundation everything else builds on.

---

## Message protocol (v0)

HLAE → editor:
```jsonc
{ "type": "cam",
  "demoTick": 2480, "demoTime": 38.75, "curTime": 38.75, "paused": false,
  "view": { "x": .., "y": .., "z": .., "rX": .., "rY": .., "rZ": .., "fov": .. },
  "width": 1920, "height": 1080 }
```
Editor → HLAE:
```jsonc
{ "type": "exec", "cmd": "demo_pause" }
```
> Note: live view angles are **euler** (`rX/rY/rZ`). HLAE campath keyframes prefer
> **quaternion** — the euler→quaternion conversion happens when we start writing
> keyframes (Phase 2).

---

## Roadmap

- **Phase 1 — hello-bridge** ✅ (this) — live camera stream + command round trip.
- **Phase 2 — capture & apply** — "drop keyframe at playhead" via
  `mirv.getMainCampath().add()`, list keyframes, enable path, live preview.
- **Phase 3 — timeline UI** (Tauri + React/TS) — scrub bound to demo tick
  (`demo_gototick`), draggable keyframes, transport controls.
- **Phase 4 — easing-curve graphs + 3D preview** (`campath.eval`), plus
  Airyz-style extras: keyframed **depth of field** (focus distance + aperture)
  and **follow-player** auto-keyframing via the entity API.
