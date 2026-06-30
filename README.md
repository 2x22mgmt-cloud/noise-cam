# Noise Cam

A real-time, visual **camera-path (dolly) editor for CS2 demos**. Fly a free-cam,
drop keyframes, and it splines a smooth cinematic path you can preview and record —
like Airyz Advanced Dolly, but live, visual, and for CS2.

Built entirely on HLAE's official mirv-script API, so **nothing gets injected into
the game.** Personal tool, still in beta (a one-click `.exe` for friends is on the list).

---

## What you need

- **CS2 + HLAE** ([advancedfx](https://github.com/advancedfx/advancedfx)), launched
  with **AvoidVac** on. That runs CS2 `-insecure`, so this is demo/movie work only —
  you're never on a VAC server.
- Windows 10/11.

## Get it running

1. **Open Noise Cam.** A little panel docks to the top-right. Show/hide it anytime
   with **Alt+Shift+D**.
2. **Launch CS2 through HLAE** and load a demo: `playdemo <name>`.
3. **Load the bridge** in the CS2 console:
   ```
   mirv_script_load "D:\Projects\cs2-dolly\bridge\noisecam-bridge.js"
   ```
   Or drop `cfg\noisecam.cfg` into your CS2 cfg folder and run `exec noisecam` —
   that loads the bridge *and* sets up the F7/F8/F9 + numpad binds in one go.
4. The panel's status dot turns **amber** when it connects. You're good.

**Phone as a remote (optional):** on a phone/tablet on the same wifi, open
`http://<your-PC-IP>:31337` in a browser for the same controls, touch-friendly.
(`ipconfig` gives you the IPv4.)

## Making a shot

- **Cam tab** → hit **Cam** to drop into the free camera and fly around.
- **Capture** a keyframe at each spot to build the path (numpad `+` does the same).
- **Preview shot** plays it back smooth and eased — pick the speed (0.1×–1×) right
  under the button.
- **DoF tab** → set a focus distance + aperture (f-stop) for that shallow cinematic blur.
- **HUD tab** → one tap for **Cinematic** (totally clean), **Clip** (keeps killfeed,
  crosshair and weapon), or **Full HUD**, plus per-element toggles to fine-tune.
- **Rec tab** → record the shot straight out (HLAE `mirv_streams`; needs FFmpeg on PATH).

**Keys:** F7 pause · F8 reload bridge · F9 preview · numpad `+` capture ·
`Enter` enable · `-` clear · `*` draw path

---

## How it works

The **bridge** (`bridge/noisecam-bridge.js`) runs *inside* CS2 through HLAE. It
streams the live camera + demo time out, and on playback it drives the camera along
your keyframes itself — a Catmull-Rom spline on position, angles and FOV, with
ease-in/out. The **overlay** is a separate app that talks to it over a local
WebSocket. Same idea as Airyz's dolly (in-game agent + external editor), except HLAE
hands us the camera hook and campath officially — so there's nothing to inject.

## Layout

```
cs2-dolly/
├─ bridge/    ← runs inside CS2 (mirv_script_load)
├─ overlay/   ← the control panel (Tauri + React)
├─ cfg/       ← noisecam.cfg loader + binds
├─ docs/      ← architecture, HLAE API, roadmap
└─ release/   ← packaged beta build
```

**Running from source:** `cd overlay && npm install && npm run tauri dev`.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.
