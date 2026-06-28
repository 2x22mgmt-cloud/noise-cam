# HLAE CS2 (mirv-script) API reference — verified

All of this was verified against the advancedfx source (June 2026). CS2's hook is
**AfxHookSource2**, which embeds a JS/TS engine ("mirv-script", since HLAE 2.162).
Official type defs: `advancedfx/advancedfx → misc/mirv-script/src/types/*.d.ts`.

> Note: CS2 does **not** use the old CS:GO `mirv_pgl` binary protocol. It uses this
> JS engine instead. Scripts are loaded with `mirv_script_load "<path>.mjs"`.

## Connection / transport
- `mirv.connect_async(address): Promise<{in: WsIn, out: WsOut}>` — open a WS client
  connection (HLAE dials out). `WsIn.next()` (await for message), `WsOut.send()`,
  `feed()`, `flush()`, `close()`, `drop()`. Strict async-ordering: don't start a new
  op while one is pending (our `MirvWsConnection` helper handles this).

## Console / cvars
- `mirv.exec(cmd: string)` — run any console command (chain with `;`).
- `mirv.message(s)` / `mirv.warning(s)` — write to game console.
- `AdvancedfxCVar` — read/write **any** cvar: `AdvancedfxCVar.getIndexFromName(name)`,
  `new AdvancedfxCVar(idx)`, `.value` (get/set), `.getType()`, `.min/max/defaultValue`,
  `.helpString`. Use `mirv.exec('mirv_cvar_unhide_all')` first to access hidden cvars.

## Camera (read + override) — the capture/preview core
- `mirv.onCViewRenderSetupView = (e) => {...}` (deprecated callback, since 2.162) OR
  `mirv.events.cViewRenderSetupView.on(id, fn)` (since 2.190).
- Event `e` provides: `curTime`, `absTime`, `lastAbsTime`, `width`, `height`, and
  `currentView` / `gameView` / `lastView`, each `{x, y, z, rX, rY, rZ, fov}` (**euler**).
- **Return** `{x?,y?,z?,rX?,rY?,rZ?,fov?}` to **override** the camera that frame;
  return `undefined` to leave it untouched.
- `mirv.onClientFrameStageNotify` / `mirv.events.clientFrameStageNotify` — per-frame pump.

## Demo time / playback
- `mirv.getDemoTime(): number|undefined`, `mirv.getDemoTick(): number|undefined`
  (since 2.183), `mirv.getCurTime()`, `mirv.isPlayingDemo()`, `mirv.isDemoPaused()`.
- Scrub via `mirv.exec("demo_gototick N")`, `demo_pause`, `demo_resume`, `demo_timescale`.

## Campath (programmatic) — `mirv.getMainCampath(): AdvancedfxCampath`
- Props: `enabled`, `offset`, `hold`, `positionInterp`, `rotationInterp`, `fovInterp`.
- `add(time, AdvancedfxCampathValue)`, `remove(time)`, `clear()`, `size`, `duration`,
  `lowerBound`, `upperBound`, `canEval`, `eval(time) → CampathValue|undefined`.
- `load(filePath)`, `save(filePath)` (XML, see below).
- Editing: `setStart`, `setDuration`, `setPosition`, `setAngles(yPitch,zYaw,xRoll)`,
  `setFov`, `rotate`, `anchorTransform`.
- Selection: `selectAll/None/Invert`, `selectAddIdx/MinCount/MinMax`.
- `AdvancedfxCampathValue { pos: Vector3, rot: Quaternion, fov, selected }`.
- Interp enums:
  - position & fov → `DoubleInterp { Default=0, Linear=1, Cubic=2 }`
  - rotation → `QuaternionInterp { Default=0, SLinear=1, SCubic=2 }`
  - rotation does **not** accept plain "cubic". UI dropdowns must enforce per-channel sets.

## Entities — powers auto-focus & follow-cam
- `mirv.getHighestEntityIndex()`, `mirv.getEntityFromIndex(i): Entity|null`, handle helpers.
- `Entity`: `getOrigin()` (x,y,z), `getRenderEyeOrigin()`, `getRenderEyeAngles()`,
  `getHealth()`, `getTeam()`, `isPlayerPawn()`, `isPlayerController()`, `getPlayerName()`,
  `getSanitizedPlayerName()`, `getSteamId()`, `getObserverTargetHandle()`,
  `getActiveWeaponHandle()`, `getAttachment(name) → {position, angles}|null`.

## Custom console commands — powers aliases/binds
- `AdvancedfxConCommand` + the `SubCommand` wrapper (example `3-command-snippet`) let
  the script register real console commands (e.g. a `mirv_dolly` family) with typed,
  nested subcommands and `onSet` callbacks. Users then `alias`/`bind` to them.

## Campath XML schema (save/load) — documented & current for CS2
```xml
<campath positionInterp="..." rotationInterp="..." fovInterp="..." offset="..." hold="...">
  <points>
    <p t="" x="" y="" z="" fov="" rx="" ry="" rz="" qw="" qx="" qy="" qz="" selected=""/>
  </points>
</campath>
```
- Rotation stored as **both** euler (`rx/ry/rz`) and quaternion (`qw/qx/qy/qz`);
  **quaternion takes precedence on load**.
- ≥4 keyframes to enable under cubic; 2 suffice if all channels set to linear.

## The euler↔quaternion bridge (highest-risk correctness spot)
Live view + override are **euler** (`rX/rY/rZ`); `CampathValue.rot` is a **quaternion**;
`campath.setAngles()` takes euler. So **capture-from-live must convert euler→quaternion**,
and always emit both forms when writing XML (to match HLAE). `math.d.ts` provides
`AdvancedfxMathVector3` / `AdvancedfxMathQuaternion` — confirm the euler→quat helper.

## Version notes
- `connect_async`, `exec`, `onCViewRenderSetupView`, entity API: since **2.162**.
- `getMainCampath`: since **2.169**. `getDemoTime/Tick`: since **2.183**.
- `mirv.events.*` API: since **2.190** (use the deprecated `mirv.onX` callbacks below that).
- Current installed build target: **2.189.5+** → use `mirv.onCViewRenderSetupView`.
