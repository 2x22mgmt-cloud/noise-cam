# Prior art & the CS2 gap

Researched June 2026. Short version: **nobody has publicly built a real-time, visual
timeline campath editor for CS2 on the mirv-script engine.** The old live-link tools
can't even be ported, because CS2 changed the interface.

## What exists today

| Tool / workflow | Real-time? | Works on CS2? | Notes |
|---|---|---|---|
| **Blender round-trip** (`afx-blender-scripts`, CamIO) | no (offline) | yes | The de-facto "visual" editor: export → edit curves in Blender → re-import. Heavyweight, learning curve, not live. **Main precedent / competition.** |
| `xNWP/HLAELiveLink` (Cinema 4D) | yes | no (CS:GO only) | Closest cousin: drives HLAE camera from C4D — but `mirv_pgl` (Source 1), C4D as UI, animate→push direction. |
| `xNWP/HLAE-Server` (C#), `FlowingSPDG/HLAE-Server-GO`, `FIVESCUP/HLAE_Server_TypeScript` | n/a (transport) | no (CS:GO only) | `mirv_pgl` wrappers. Reusable references, not editors. |
| `dtugend/advancedfx-gui` | — | — | Maintainer's own Electron+native GUI experiment, **dormant since 2023**. |
| `One-Studio/HLAE-Studio` | — | partial | HLAE+FFmpeg *manager*, not a campath editor. |
| `mccadecortez/cs2-demo-parse-mirv` | — | yes (mirv-script) | Uses the CS2 JS engine — for AI demo parsing, not cameras. Proof the engine is usable in the wild. |
| **A real-time visual campath editor for CS2** | yes | — | **Nobody. This project.** |

## Why it's greenfield (the moat)
Every live-link tool was built on **`mirv_pgl`**, the CS:GO/Source-1 binary protocol.
`mirv_pgl` **doesn't exist in CS2** — CS2 replaced it with the mirv-script JS engine.
So the entire CS:GO live-link ecosystem (C4D link, Go/C#/TS servers) **can't carry
forward without a rewrite against the new API.** We'd be first to do real-time visual
campath editing on CS2, and early on an API the incumbents predate.

## Honest positioning
Blender already satisfies people willing to climb its curve, and the official HLAE 3
GUI (issue #52) was closed "not planned." So the wedge is **speed and immediacy** —
fly the shot, drop keyframes, scrub, preview, in seconds, in-game — not out-featuring
Blender's graph editor. Win on "30 seconds from idea to dialed-in dolly."

## The Airyz bar (reference quality)
Airyz (COD movie-tool maker) `Airyzz/t7-advanced-dolly` (BO3): C++ DLL + C# tool over
a named pipe; augments position-only markers with `{roll, fov, focalDistance, aperture}`;
interp Linear/Cosine/Cubic(4-pt). Same architecture, harder road (injection, hand-found
addresses). We match/exceed it via HLAE's sanctioned API. Ideas adopted: keyframed DoF
(focus distance + aperture) and follow-player auto-keyframing.
