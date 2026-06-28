# Architecture

## One-liner
A real-time, visual keyframe **camera-path (dolly) editor for CS2 demos**, built
**only** on HLAE's sanctioned `mirv-script` interface. No game-memory injection,
no cheats. Local/personal tool. "Airyz T7 Advanced Dolly, but real-time, visual,
and for CS2."

## Two halves, one socket

```
┌──────────────────────────────┐      WebSocket (localhost:31337)      ┌───────────────────────────┐
│  Editor                      │  ◀── cam pose, demo tick/time,        │  HLAE bridge               │
│  Phase 1: Node console        │       entities, events                │  (bridge/noisecam-bridge.js)  │
│  Later:   Tauri + React/TS    │  ─── exec, keyframe ops, cvars ────▶  │  runs inside CS2 via        │
│                               │                                       │  mirv_script_load           │
└──────────────────────────────┘                                       └───────────────────────────┘
```

- **HLAE bridge** (`bridge/noisecam-bridge.js`) — runs *inside CS2* through HLAE's JS
  engine. Reads the live camera + demo time, manipulates the campath, runs console
  commands / sets cvars. This is the only part that touches the game, and it does so
  through HLAE's official API.
- **Editor** (`server/` for now) — hosts the WebSocket server HLAE connects to. The
  UI lives here. Phase 1 is a console that prints the cam stream and sends commands;
  later it becomes the Tauri timeline editor.

This mirrors **Airyz's T7 dolly** (a C++ DLL injected into BO3 + a C# tool over a
named pipe) — except HLAE gives us the camera hook, demo tick, and campath storage
*officially*, so there is nothing to inject and no addresses to reverse-engineer.

## Why HLAE is the client, not the server
HLAE's `mirv.connect_async()` makes the in-game script a WebSocket **client** that
dials out to our editor. So the **editor hosts the server** on `ws://localhost:31337/mirv`.

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
JSON by design — we own both ends (both TypeScript), so we never reverse a binary
protocol the way the old CS:GO `mirv_pgl` tools had to.

## The channel model (the important idea)
A keyframe is **multi-channel**, each channel independently eased:

| Channel | Stored where | Applied how |
|---|---|---|
| Position (x/y/z) | HLAE campath (native) | HLAE interpolates via `getMainCampath()` |
| Rotation incl. **roll** | HLAE campath (native, quaternion) | HLAE interpolates |
| FOV / focal length | HLAE campath (native) | HLAE interpolates |
| **DoF / focus** (near/far planes) | our project file (extra) | bridge sets `r_dof_override*` cvars per frame |
| **Timescale** (slow-mo) | our project file (extra) | bridge sets `demo_timescale` per frame |
| Exposure, etc. (future) | our project file (extra) | cvar/exec per frame |

Native channels ride HLAE's own campath interpolation. "Extra" channels are ours —
we interpolate them (Linear/Cosine/Cubic, same as Airyz's `Math.h`) and apply via
cvar/exec. This is exactly Airyz's `CustomMarkerData {roll, fov, focalDistance,
aperture}` side-map pattern, on a sanctioned API and with more channels.

## Tech stack decision
**Tauri + React + TypeScript** for the editor.
- The HLAE bridge *must* be TypeScript (it runs in HLAE's JS engine, with official
  `.d.ts` files) → building the editor in TS too means **one shared type/message
  schema across both sides**, no drift.
- Mature timeline/curve canvas libs (Konva) and native WebSocket.
- Tauri over Electron: smaller/lighter bundle for a snappy real-time tool.
- Avalonia/C# is a viable fallback but duplicates the message types.

## Safety / scope
- CS2 is always launched through HLAE with **AvoidVac (`-insecure`)** → never on a
  VAC-secured server; demo/movie work only.
- The bridge uses only documented `mirv.*` APIs. No memory writes to `cs2.exe`.
- Skins are intentionally **out of scope** (would require injection) — handled in
  post-production instead. See ROADMAP.
