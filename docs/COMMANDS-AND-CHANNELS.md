# Commands, cvars & channels

Distilled from your own workflow (`reference/cs2-cmd-reference.txt`) + verified HLAE API.

## Depth of field (CONFIRMED working in CS2)
CS2 exposes DoF via cvars (from your cmd file):
```
r_dof_override 1
r_dof_override_near_blurry <dist>   ; near objects fully blurred beyond here
r_dof_override_near_crisp  <dist>   ; near edge of the in-focus band
r_dof_override_far_crisp   <dist>   ; far edge of the in-focus band
r_dof_override_far_blurry  <dist>   ; far objects fully blurred beyond here  (set a value!)
```
**Focus band = between `near_crisp` and `far_crisp`.** Blur ramps outward to the
`*_blurry` planes. Rack focus = animate these over time.

The bridge sets these live via `AdvancedfxCVar`, so DoF becomes a keyframable channel.

### Auto-focus — the headline feature
HLAE DoF is manual-focus only (you must know the world distance). We don't have to:
the editor knows the **camera position** (`cViewRenderSetupView.currentView`) and every
**entity position** (`entity.getOrigin()` / `getRenderEyeOrigin()` / `getAttachment()`),
so `focusDistance = |camera − target|` each frame.
- **Click-to-focus** — pick a player → planes set around their distance.
- **Follow-focus** — lock to a player/bomb/spectated target; focus tracks them.
- **Rack focus** — keyframe the *target* (player A → player B) → auto focus pull.
- **Manual** slider override + an **aperture/blur-amount** slider (band tightness).

### DoF quality tiers
> CS2 has **no usable depth pass** in HLAE2, so depth/DoF is done LIVE or via AI depth —
> not from a native depth-map render.
1. **Native `r_dof_override`** — fully tool-controlled, real-time, uses the game's own
   depth. Where auto-focus lives now.
2. **ReShade CinematicDOF** (via `advancedfx/ReShade_advancedfx`, which feeds ReShade the
   depth buffer) — much better bokeh; has its own autofocus + manual-focus-plane.
   Driving its focus uniform live from us isn't a clean path → use ReShade's own
   autofocus, or a future custom addon, or export our focus curve.
3. **Post DoF via AI depth** — no native depth pass on CS2, so generate a depth map with
   **Depth Anything 3** (`da3`) → DoF in AE/Nuke. Most flexible; not real-time.

## Channels (one timeline, each independently eased)
| Channel | Source | Apply |
|---|---|---|
| Position x/y/z | native campath | `getMainCampath()` |
| Rotation + **roll** (your Z/C tilt) | native campath (quaternion) | `getMainCampath()` |
| FOV / focal length (your `mirv_input fov`, `fov35/55/75`) | native campath | `getMainCampath()` |
| **DoF / focus** | extra | `r_dof_override*` cvars |
| **Timescale** (your `01/001/1` = `demo_timescale`) | extra | `demo_timescale` |

## Your workflow → tool mapping
| Manual now | In the tool |
|---|---|
| `cam0-5` select / `del0-5` delete (hardcoded 6) | click keyframe / Delete — unlimited |
| `movecam` (`edit position/angles current`) | select → "update to current view" / drag |
| `add` + `enable` + `draw` | capture button/hotkey; auto-enable; draw toggle |
| `fov35/55/75` | FOV channel on the timeline |
| `01/001/1` (`demo_timescale`) | timescale channel (slow-mo ramps) |
| `start`, `block`, `mirv_fix animations 1` | one "Scene setup" button |

## Scene-setup commands (fire once, from your file)
```
drdemoui; sv_cheats 1; mirv_cvar_unhide_all
mirv_fix animations 1
cl_drawhud 0; cl_draw_only_deathnotices 1; cl_demo_predict 0; cl_trueview_show_status 0
r_show_build_info false
host_framerate 600        ; set to target fps when recording
; block other kills:
mirv_deathmsg filter add attackerMatch=!<you> victimMatch=!<you> block=1 lastRule=1
```

## Camera control (HLAE freecam, your binds)
```
mirv_input camera     ; take camera control
WASD move ; arrows/mouse turn ; F/R up-down ; Z/C roll
```

## Launch (your command line)
```
-steam -insecure +sv_lan 1 -console -novid -sw -w 2560 -h 1440
```
`-insecure` = AvoidVac (required for HLAE; never on a VAC server).
