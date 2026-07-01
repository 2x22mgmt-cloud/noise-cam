// =============================================================================
//  Noise Cam — HLAE bridge (Phase 2: capture & apply)
// =============================================================================
//  Runs INSIDE CS2 via HLAE's sanctioned mirv-script engine. No injection.
//
//  Load it in the CS2 console (CS2 launched through HLAE) — adjust the path to
//  wherever this repo lives on your machine:
//      mirv_script_load "D:\Projects\cs2-dolly\bridge\noisecam-bridge.js"
//
//  What it does:
//    - streams the live camera pose + demo time/tick to the editor (every frame)
//    - registers a `mirv_dolly` console command so you can BIND keys:
//        mirv_dolly capture | clear | enable | disable | draw | drawoff
//    - applies editor commands: capture/remove/clear/enable/draw/interp/exec
//    - pushes the live keyframe list to the editor whenever the campath changes
//
//  Capture uses HLAE's own `mirv_campath add`, so the current view + correct
//  quaternion rotation are stored by HLAE (no manual euler->quat needed).
//
//  Compat: deprecated `mirv.onCViewRenderSetupView` + `campath.onChanged`
//  (both available on HLAE 2.18x). getDemoTime/Tick need 2.183+.
// =============================================================================

// Wrap the whole script in a block so its top-level const/let are block-scoped. That
// lets `mirv_script_load` re-run this file without "duplicate lexical declaration"
// errors (persistent state lives on globalThis.__cs2_dolly).
{
const WS_ADDRESS = 'ws://localhost:31337/mirv';

// Clean up a previous load so re-running mirv_script_load doesn't duplicate
// connections or fail to re-register the command.
if (globalThis.__cs2_dolly && typeof globalThis.__cs2_dolly.cleanup === 'function') {
	try { globalThis.__cs2_dolly.cleanup(); } catch (_) {}
}

// --- WebSocket connection helper (TS->JS, from advancedfx example 0) ----------
class MirvWsConnection {
	constructor(onException) {
		this.wsIn = null;
		this.wsOut = null;
		this.wsInBuffer = [];
		this.exception = null;
		this.onException = onException || null;
		this.isClosed = false;
		this._isConnecting = false;
		this.readNext = this.readNext.bind(this);
	}
	async connect(address) {
		if (this.isConnecting || this.isConnected()) return;
		this._isConnecting = true;
		this.wsIn = null; this.wsOut = null; this.exception = null; this.wsInBuffer = [];
		try {
			const ws = await mirv.connect_async(address);
			this.wsIn = ws.in; this.wsOut = ws.out;
			this._isConnecting = false; this.isClosed = false;
			this.readNext();
		} catch (e) {
			this._isConnecting = false; this.setException(e);
		}
	}
	get isConnecting() { return this._isConnecting; }
	isConnected() { return null === this.exception && null !== this.wsOut && !this.isClosed; }
	setException(e) { if (this.exception === null) { this.exception = e; if (this.onException) this.onException(e); } }
	next() { if (0 < this.wsInBuffer.length) return this.wsInBuffer.shift(); return null; }
	async readNext() {
		if (!this.wsIn) return;
		try {
			while (true) {
				const message = await this.wsIn.next();
				if (message === null) {
					this.wsIn.drop(); this.wsIn = null;
					if (this.wsOut) { this.wsOut.drop(); this.wsOut = null; }
					this.isClosed = true; break;
				}
				switch (typeof message) {
					case 'string': this.wsInBuffer.push(message); break;
					case 'object': this.wsInBuffer.push(message.consume()); break;
					default: throw 'MirvWsConnection: unknown incoming message type.';
				}
			}
		} catch (e) {
			this.setException(e);
			try { if (this.wsIn) this.wsIn.drop(); } catch (_) {}
			try { if (this.wsOut) this.wsOut.drop(); } catch (_) {}
		}
	}
	async withOut(fn) { try { if (this.wsOut) await fn(this.wsOut); } catch (e) { this.setException(e); } }
	async send(msg) { return await this.withOut((out) => out.send(msg)); }
	async close() { return await this.withOut((out) => out.close()); }
}

// --- State ------------------------------------------------------------------
const conn = new MirvWsConnection((e) => mirv.warning('[dolly] ws error: ' + e));
let frame = 0;
let sending = false;        // at most one WS send in flight (async-ordering safety)
let wasConnected = false;
const outQueue = [];        // control messages (priority over the cam stream)
let pushCountdown = 0;      // frames to wait after a path-changing command, then push the list
                            // (mirv.exec is deferred, so we can't read the campath on the same frame)
// We DON'T read HLAE's campath back in JS — the read path (AdvancedfxCampathIterator
// + quaternion->euler) is not a real/stable API on this build and crashed CS2 on
// capture. Instead we track the keyframe list ourselves from the live view stream;
// HLAE's own campath still stores the points for playback (mirv_campath add/enable).
// Persist the editor-side list across script reloads (it lives on globalThis), so
// reloading the bridge to ship a fix no longer blanks the overlay's keyframe list.
const keyframes = (globalThis.__cs2_dolly && Array.isArray(globalThis.__cs2_dolly.keyframes))
	? globalThis.__cs2_dolly.keyframes
	: [];          // editor-side list: {tick,time,pos,fov,ang:{roll}}
let enabledState = false;      // our view of campath enabled (toggled by enable/disable)
let playMode = false;          // when true, the BRIDGE drives the camera along the path
let playOffset = null;          // (continuous game time − quantized demo time), sampled once per enable
let playGt0 = 0;               // render-clock value sampled at the moment playback (re)starts
let playDt0 = 0;               // demo time sampled at that same moment (where the playhead begins)
let playRate = 1;              // CAMERA traversal speed multiplier (independent of demo_timescale).
                               //   1 = real-time, 0.5 = half-speed camera, etc. Set by preview.
let easeMode = true;           // ease-in/out across the whole shot (smooth start/stop)
let lastView = null;           // latest free-cam view {x,y,z,rX,rY,rZ,fov}
let dofFocus = 0;              // current live focus distance (units); captured into keyframes
let dofFstop = 2.8;            // shot-wide aperture; focus DISTANCE is what gets keyframed
let selectedKf = -1;           // last keyframe the UI selected (for "set focus on this kf")

// --- Live lock-on (bone/follow cam) -----------------------------------------
let followMode = false;        // when true, the bridge rides a player's eye every frame
let followTarget = -1;         // entity index of the followed player pawn
let followAnchor = null;       // smoothed eye position {x,y,z} (kills tick-step jitter)
let followLook = null;         // smoothed eye facing {pitch,yaw} (kills aim-flick jitter)
let followOpts = { mode: 'third', dist: 120, height: 14, side: 0, smooth: 0.6, fov: 90 };
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
// Pull x/y/z out of whatever shape HLAE returns: {x,y,z}, {X,Y,Z}, [x,y,z], or getX().
function vec(v) {
	if (!v || typeof v !== 'object') return null;
	let x = v.x, y = v.y, z = v.z;
	if (typeof x !== 'number') { x = v[0]; y = v[1]; z = v[2]; }
	if (typeof x !== 'number') { x = v.X; y = v.Y; z = v.Z; }
	if (typeof x !== 'number' && typeof v.getX === 'function') { x = v.getX(); y = v.getY(); z = v.getZ(); }
	if (typeof x !== 'number') return null;
	return { x: num(x), y: num(y), z: num(z) };
}
// Verbose shape probe for diagnostics.
function probe(v) {
	if (v == null) return String(v);
	try {
		let s = 'type=' + typeof v + ' arr=' + Array.isArray(v) +
			' idx=' + v[0] + ',' + v[1] + ',' + v[2] + ' xyz=' + v.x + ',' + v.y + ',' + v.z;
		try { s += ' keys=' + Object.keys(v).join('|'); } catch (_) {}
		try { if (typeof v.getX === 'function') s += ' getXYZ=' + v.getX() + ',' + v.getY() + ',' + v.getZ(); } catch (_) {}
		return '{' + s + '}';
	} catch (e) { return 'probe-err:' + e; }
}

// --- Path interpolation (bridge-driven playback) ----------------------------
// Native campath can't drive the camera while our script holds the view hook, so
// we interpolate the captured keyframes ourselves and return the view each frame.
function lerp(a, b, f) { return a + (b - a) * f; }
function lerpAngle(a, b, f) { const d = ((((b - a) % 360) + 540) % 360) - 180; return a + d * f; }
// Catmull-Rom spline through p1→p2 using neighbours p0,p3 — smooth curves through
// the keyframes (no hard corners). Used for position so the dolly arcs naturally.
function catmull(p0, p1, p2, p3, f) {
	const f2 = f * f, f3 = f2 * f;
	return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}
// Catmull-Rom on ANGLES: unwrap the control points around p1 first so the spline
// doesn't blow up across the ±180° seam, then spline normally.
function catmullAngle(p0, p1, p2, p3, f) {
	const u = (ref, a) => ref + (((a - ref + 540) % 360) - 180);
	const q0 = u(p1, p0), q2 = u(p1, p2), q3 = u(q2, p3);
	return catmull(q0, p1, q2, q3, f);
}
// Smoothstep ease-in/out across the whole shot (slow start, slow stop).
function smoothstep(g) { g = g < 0 ? 0 : g > 1 ? 1 : g; return g * g * (3 - 2 * g); }

// --- Depth of field (ports of the overlay's lens.ts + dof.ts, so the DoF applied
//     during playback matches the DoF tab exactly). Focus distance is keyframed →
//     the bridge racks focus along the path; aperture (f-stop) is shot-wide.
const DOF_FILM_BACK = 36, DOF_COC = 0.029, DOF_BLUR_MULT = 4, DOF_UPM = 1 / 25.4, DOF_FAR = 100000;
function fovToFocalMm(fovDeg) {
	const fv = (typeof fovDeg === 'number' && fovDeg > 0 && fovDeg < 179) ? fovDeg : 90;
	return (DOF_FILM_BACK / 2) / Math.tan((fv * Math.PI / 180) / 2);
}
function dofLimits(focusUnits, focalMm, fstop, cocMm) {
	const H = ((focalMm * focalMm) / (fstop * cocMm) + focalMm) * DOF_UPM;
	const s = Math.max(focusUnits, 0.001);
	const near = (H * s) / (H + s);
	const far = s >= H ? Infinity : (H * s) / (H - s);
	return { near, far };
}
function computeDofPlanes(focusUnits, fstop, focalMm) {
	const sharp = dofLimits(focusUnits, focalMm, fstop, DOF_COC);
	const blur = dofLimits(focusUnits, focalMm, fstop, DOF_COC * DOF_BLUR_MULT);
	const cf = (v) => (isFinite(v) ? Math.max(v, 0) : DOF_FAR);
	return { nb: Math.round(cf(blur.near)), nc: Math.round(cf(sharp.near)),
	         fc: Math.round(cf(sharp.far)), fb: Math.round(cf(blur.far)) };
}
function evalPath(t) {
	// Interpolate by CONTINUOUS demo time (seconds), not the integer demo tick —
	// the tick only advances 64/s, which makes the camera step (very visible in
	// slow-mo); demo time is sub-tick so the move is smooth per render frame.
	if (keyframes.length < 2 || typeof t !== 'number') return null;
	const ks = keyframes; // sorted by tick, i.e. also by time
	if (t < ks[0].time || t > ks[ks.length - 1].time) return null; // outside the path
	for (let i = 0; i < ks.length - 1; i++) {
		const a = ks[i], b = ks[i + 1];
		if (t >= a.time && t <= b.time) {
			if (!a.pos || !b.pos || !a.ang || typeof a.ang.rX !== 'number' || typeof b.ang.rX !== 'number') return null;
			const span = (b.time - a.time) || 1e-6;
			const f = (t - a.time) / span;
			// Catmull-Rom on position, angles AND fov; clamp neighbours at the ends.
			const k0 = ks[i - 1] || a, k3 = ks[i + 2] || b;
			const p0 = k0.pos || a.pos, p3 = k3.pos || b.pos;
			const g0 = k0.ang || a.ang, g3 = k3.ang || b.ang;
			const fov0 = typeof k0.fov === 'number' ? k0.fov : a.fov;
			const fov3 = typeof k3.fov === 'number' ? k3.fov : b.fov;
			// Focus distance racks LINEARLY between set keyframes (distances shouldn't
			// catmull-overshoot). 0 = no focus set on this segment → no DoF applied.
			const fa = num(a.focus), fb = num(b.focus);
			let focus = 0;
			if (fa > 0 && fb > 0) focus = lerp(fa, fb, f);
			else if (fa > 0) focus = fa;
			else if (fb > 0) focus = fb;
			return {
				x: catmull(p0.x, a.pos.x, b.pos.x, p3.x, f),
				y: catmull(p0.y, a.pos.y, b.pos.y, p3.y, f),
				z: catmull(p0.z, a.pos.z, b.pos.z, p3.z, f),
				rX: catmullAngle(g0.rX, a.ang.rX, b.ang.rX, g3.rX, f),
				rY: catmullAngle(g0.rY, a.ang.rY, b.ang.rY, g3.rY, f),
				rZ: catmullAngle(g0.rZ, a.ang.rZ, b.ang.rZ, g3.rZ, f),
				fov: catmull(fov0, a.fov, b.fov, fov3, f),
				focus: focus,
			};
		}
	}
	return null;
}

function demoTickNow() {
	const t = (typeof mirv.getDemoTick === 'function') ? mirv.getDemoTick() : null;
	return (typeof t === 'number' && isFinite(t) && t >= 0) ? t : null; // guard undefined/negative
}

function send(obj) { outQueue.push(JSON.stringify(obj)); }

// Capture: tell HLAE to store the point (for playback) AND record it editor-side
// from the live view. We bracket the HLAE command with breadcrumbs so that, if it
// ever crashes CS2, the relay log shows exactly how far we got.
function captureKeyframe() {
	const tick = demoTickNow();
	send({ type: 'log', msg: '[capture] before mirv_campath add (tick=' + tick + ')' });
	mirv.exec('mirv_campath add'); // HLAE stores the keyframe for playback
	send({ type: 'log', msg: '[capture] after mirv_campath add' });

	const v = lastView;
	keyframes.push({
		tick: (typeof tick === 'number') ? tick : null,
		time: (typeof tick === 'number') ? tick / 64 : null,
		pos: v ? { x: v.x, y: v.y, z: v.z } : null,
		fov: v ? v.fov : null,
		focus: dofFocus > 0 ? dofFocus : null, // keyframed rack-focus distance (units)
		// Store FULL euler (rX/rY/rZ) so the bridge can drive the camera itself on
		// playback; `roll` (=rZ) is kept for the UI's roll column.
		ang: v ? { rX: v.rX, rY: v.rY, rZ: v.rZ, roll: v.rZ } : null,
	});
	keyframes.sort((a, b) => ((a.tick ?? 0) - (b.tick ?? 0)));
	pushKeyframes();
}

// Push our editor-side list (no JS campath read-back).
function pushKeyframes() {
	send({ type: 'keyframes', count: keyframes.length, enabled: enabledState, items: keyframes.slice() });
}

// One-tap preview: enable bridge-driven playback, seek to the first keyframe, set a
// watchable slow-mo, and play — the whole "show me the shot" sequence in one go.
function previewShot(ts) {
	if (keyframes.length < 2 || typeof keyframes[0].tick !== 'number') {
		send({ type: 'log', msg: '[preview] need at least 2 keyframes' });
		return;
	}
	playMode = true;
	enabledState = true;
	followMode = false; // preview drives the dolly, not the lock-on
	playOffset = null; // re-sample the game↔demo offset after the seek
	const speed = (typeof ts === 'number' && ts > 0) ? ts : 0.5;
	playRate = speed;  // slow the CAMERA itself, not just the world
	// demo_timescale slows the WORLD by the same factor so the two stay matched.
	mirv.exec('mirv_campath enabled 0;demo_timescale ' + speed + ';demo_gototick ' + keyframes[0].tick + ';demo_resume');
	send({ type: 'log', msg: '[preview] playing at ' + speed + '×' });
	pushKeyframes();
}

// --- Handle commands from the editor ----------------------------------------
function handleIncoming(msg) {
	if (typeof msg !== 'string') return;
	let obj;
	try { obj = JSON.parse(msg); } catch (_) { return; }
	switch (obj.type) {
		case 'exec':    if (typeof obj.cmd === 'string') { mirv.exec(obj.cmd); } break;
		case 'capture': captureKeyframe(); break;
		case 'clear':   mirv.exec('mirv_campath clear'); keyframes.length = 0; pushKeyframes(); break;
		case 'remove':  if (Number.isInteger(obj.index)) { keyframes.splice(obj.index, 1); mirv.exec('mirv_campath remove ' + obj.index); pushKeyframes(); } break;
		case 'enable':
			// BRIDGE-DRIVEN playback. Native campath can't drive the camera while our
			// script owns the view hook, so the bridge interpolates the keyframes and
			// returns the view itself (see evalPath + the view listener). Works whether
			// the demo is paused or playing — the camera sits on the path at the current
			// tick. Make sure native campath isn't also fighting for the view.
			playMode = !!obj.on;
			enabledState = !!obj.on;
			if (playMode) { playOffset = null; playRate = 1; followMode = false; } // manual play = real-time camera
			try { mirv.exec('mirv_campath enabled 0'); } catch (_) {}
			pushKeyframes();
			break;
		case 'preview': previewShot(typeof obj.timescale === 'number' ? obj.timescale : undefined); break;
		case 'players': pushPlayers(); break;
		case 'follow':
			// Live lock-on: ride this player's eye. Stops dolly playback.
			if (Number.isInteger(obj.idx)) {
				followTarget = obj.idx;
				if (obj.opts) followOpts = Object.assign({}, followOpts, obj.opts);
				followMode = true; followAnchor = null; followLook = null; playMode = false;
				send({ type: 'log', msg: '[follow] locked onto entity ' + obj.idx });
			}
			break;
		case 'followSet': if (obj.opts) followOpts = Object.assign({}, followOpts, obj.opts); break;
		case 'followStop': followMode = false; followAnchor = null; followLook = null; send({ type: 'log', msg: '[follow] released' }); break;
		case 'ease': easeMode = !!obj.on; pushKeyframes(); break;
		case 'draw':
			// Richer, more-visible draw: path + camera icons + axes + big index labels.
			// (CS2's drawer has no line-thickness option; these markers help most.)
			if (obj.on) mirv.exec('mirv_campath draw enabled 1;mirv_campath draw keyCam 1;mirv_campath draw keyAxis 1;mirv_campath draw keyIndex 16');
			else mirv.exec('mirv_campath draw enabled 0');
			pushCountdown = 3;
			break;
		case 'interp':
			if (typeof obj.channel === 'string' && typeof obj.mode === 'string') {
				mirv.exec('mirv_campath edit interp ' + obj.channel + ' ' + obj.mode);
				pushCountdown = 3;
			}
			break;
		case 'select':
			// Select a single keyframe (so HLAE highlights it when drawing, and so the
			// `edit ... current` commands below target it). Remember it for setKfFocus.
			if (Number.isInteger(obj.index)) { selectedKf = obj.index; mirv.exec('mirv_campath select #' + obj.index + ' #' + obj.index); }
			break;
		case 'dof':
			// The DoF tab reports its current focus + aperture so captures grab the focus
			// and playback can rack it. (The tab still applies live DoF itself.)
			if (typeof obj.focus === 'number') dofFocus = obj.focus;
			if (typeof obj.fstop === 'number') dofFstop = obj.fstop;
			break;
		case 'setKfFocus':
			// Set the focus distance on the currently-selected keyframe.
			if (selectedKf >= 0 && keyframes[selectedKf] && typeof obj.focus === 'number') {
				keyframes[selectedKf].focus = obj.focus > 0 ? obj.focus : null;
				send({ type: 'log', msg: '[dof] focus ' + Math.round(obj.focus) + ' -> kf #' + selectedKf });
				pushKeyframes();
			} else {
				send({ type: 'log', msg: '[dof] select a keyframe first' });
			}
			break;
		case 'editKf':
			// Move/retime an existing keyframe to the CURRENT camera. Select it first,
			// then set whichever channels were requested to "current", and mirror the
			// change into our editor-side list so the UI updates.
			if (Number.isInteger(obj.index) && keyframes[obj.index]) {
				const i = obj.index, v = lastView, cmds = ['mirv_campath select #' + i + ' #' + i];
				if (obj.pos) { cmds.push('mirv_campath edit position current'); if (v) keyframes[i].pos = { x: v.x, y: v.y, z: v.z }; }
				if (obj.ang) { cmds.push('mirv_campath edit angles current'); if (v) keyframes[i].ang = { roll: v.rZ }; }
				if (obj.fov) { cmds.push('mirv_campath edit fov current'); if (v) keyframes[i].fov = v.fov; }
				mirv.exec(cmds.join(';'));
				pushKeyframes();
			}
			break;
		case 'list':    pushKeyframes(); break;
		default: break;
	}
}

// --- Per-frame: read camera (no override), pump the socket -------------------
// Use the modern events API (HLAE 2.190+), NOT the deprecated
// `mirv.onCViewRenderSetupView`. The deprecated single-slot callback takes over
// view control and SUPPRESSES native campath playback (returning undefined falls
// back to the raw spectator view). The events listener is additive: we only
// observe for streaming and return undefined, so `mirv_campath enabled 1` still
// drives the camera. This is what HLAE's own example snippets use.
const VIEW_ID = 'noisecam/cViewRenderSetupView';
mirv.events.cViewRenderSetupView.on(VIEW_ID, (e) => {
	frame++;
	const cv0 = e.currentView;
	lastView = { x: cv0.x, y: cv0.y, z: cv0.z, rX: cv0.rX, rY: cv0.rY, rZ: cv0.rZ, fov: cv0.fov };

	if (!conn.isConnected() && !conn.isConnecting && frame % 64 === 0) {
		mirv.message('[dolly] connecting to ' + WS_ADDRESS + ' ...');
		conn.connect(WS_ADDRESS);
	}

	if (conn.isConnected()) {
		if (!wasConnected) {
			wasConnected = true;
			mirv.message('[dolly] connected to editor!');
			pushKeyframes(); // initial sync
		}

		for (let m = conn.next(); m !== null; m = conn.next()) {
			try { handleIncoming(m); } catch (err) { mirv.warning('[dolly] ' + err); }
		}

		// A few frames after a path-changing command, push the refreshed list
		// (mirv.exec is deferred, so the change isn't visible on the same frame).
		if (pushCountdown > 0) {
			pushCountdown--;
			if (pushCountdown === 0) pushKeyframes();
		}

		if (!sending) {
			let msg;
			if (outQueue.length) {
				msg = outQueue.shift(); // control messages first
			} else {
				const v = e.currentView;
				msg = JSON.stringify({
					type: 'cam',
					curTime: e.curTime,
					demoTime: typeof mirv.getDemoTime === 'function' ? mirv.getDemoTime() : undefined,
					demoTick: typeof mirv.getDemoTick === 'function' ? mirv.getDemoTick() : undefined,
					paused: typeof mirv.isDemoPaused === 'function' ? mirv.isDemoPaused() : undefined,
					view: { x: v.x, y: v.y, z: v.z, rX: v.rX, rY: v.rY, rZ: v.rZ, fov: v.fov },
					width: e.width, height: e.height
				});
			}
			sending = true;
			conn.send(msg).finally(() => { sending = false; });
		}
	} else {
		wasConnected = false;
	}

	// Live lock-on: ride the followed player's eye. Takes precedence over dolly
	// playback (the two are mutually exclusive).
	if (followMode) {
		const view = evalFollow();
		if (view) return view;
	}

	// Bridge-driven playback: when enabled, override the camera with the path view
	// interpolated at the current demo tick. Returning a view here overrides the
	// camera (same mechanism as HLAE's own mirv_script_view/fov snippets).
	if (playMode) {
		// Build a CONTINUOUS demo time from the continuous render clock (e.curTime).
		// getDemoTime()/getDemoTick() are both tick-quantized (64/s) → steppy in
		// slow-mo. e.curTime is sub-tick. Sample the (game − demo) offset once, then
		// continuousDemoTime = e.curTime − offset, which matches keyframe.time.
		const gt = e.curTime;
		const dt = (typeof mirv.getDemoTime === 'function') ? mirv.getDemoTime() : null;
		// Sample the start clocks once. The render clock (gt) advances at WALL-CLOCK
		// rate during playback — it does NOT follow demo_timescale — so to actually
		// slow the camera down we scale the elapsed render time by playRate. demo_
		// timescale still slows the WORLD; playRate slows the CAMERA, matched in preview.
		if (playOffset === null && typeof gt === 'number') {
			playGt0 = gt;
			playDt0 = (typeof dt === 'number') ? dt : (keyframes[0] ? keyframes[0].time : 0);
			playOffset = gt - playDt0;
		}
		let t = (typeof gt === 'number' && playOffset !== null)
			? (playDt0 + (gt - playGt0) * playRate)
			: dt;
		// Ease-in/out: remap the playhead's progress across the whole shot with a
		// smoothstep so the camera accelerates from rest and decelerates to a stop.
		if (easeMode && typeof t === 'number' && keyframes.length >= 2) {
			const t0 = keyframes[0].time, t1 = keyframes[keyframes.length - 1].time;
			if (t1 > t0) t = t0 + smoothstep((t - t0) / (t1 - t0)) * (t1 - t0);
		}
		const view = evalPath(t);
		if (view) {
			// Breadcrumb logs both clocks so we can confirm gt is continuous.
			if (frame % 16 === 0) send({ type: 'log', msg: '[play] gt=' + (typeof gt === 'number' ? gt.toFixed(3) : gt) + ' dt=' + (typeof dt === 'number' ? dt.toFixed(3) : dt) + ' t=' + (typeof t === 'number' ? t.toFixed(3) : t) + ' pos=' + Math.round(view.x) + ',' + Math.round(view.y) + ',' + Math.round(view.z) });
			if (view.focus > 0) {
					const p = computeDofPlanes(view.focus, dofFstop, fovToFocalMm(view.fov));
					mirv.exec('r_dof_override 1;r_dof_override_near_blurry ' + p.nb + ';r_dof_override_near_crisp ' + p.nc + ';r_dof_override_far_crisp ' + p.fc + ';r_dof_override_far_blurry ' + p.fb);
				}
				return view; // <-- drives the camera along the dolly
		}
	}
	return undefined;
});

// --- Live lock-on: ride a player's eye, smoothed. HLAE returns eye origin/angles
// as [x,y,z] / [pitch,yaw,roll] arrays (vec() handles that).
function evalFollow() {
	if (typeof mirv.getEntityFromIndex !== 'function') return null;
	let ent;
	try { ent = mirv.getEntityFromIndex(followTarget); } catch (_) { return null; }
	if (!ent) return null;
	let oRaw, aRaw;
	try {
		oRaw = ent.getRenderEyeOrigin ? ent.getRenderEyeOrigin() : (ent.getOrigin ? ent.getOrigin() : null);
		aRaw = ent.getRenderEyeAngles ? ent.getRenderEyeAngles() : null;
	} catch (_) { return null; }
	const oV = vec(oRaw);
	if (!oV) return null; // can't read the eye → leave the camera put
	const aV = vec(aRaw) || { x: 0, y: 0, z: 0 };
	const opt = followOpts;

	// Smooth the eye anchor + facing at the SOURCE — turns the tick-stepped data and
	// aim flicks into a smooth signal before it ever reaches the camera.
	const sm = Math.max(0, Math.min(1, typeof opt.smooth === 'number' ? opt.smooth : 0.6));
	const alpha = Math.max(0.05, (1 - sm) * (1 - sm)); // 0% → 1 (locked), 100% → 0.05 (floaty)
	if (!followAnchor) followAnchor = { x: oV.x, y: oV.y, z: oV.z };
	else {
		followAnchor.x = lerp(followAnchor.x, oV.x, alpha);
		followAnchor.y = lerp(followAnchor.y, oV.y, alpha);
		followAnchor.z = lerp(followAnchor.z, oV.z, alpha);
	}
	if (!followLook) followLook = { pitch: aV.x, yaw: aV.y };
	else {
		followLook.pitch = lerpAngle(followLook.pitch, aV.x, alpha);
		followLook.yaw = lerpAngle(followLook.yaw, aV.y, alpha);
	}
	const A = followAnchor;
	const fov = num(opt.fov) || 90;

	if (opt.mode === 'eye') {
		// First-person: smoothed eye + smoothed look — a "lazy" POV, far calmer than raw.
		return { x: A.x, y: A.y, z: A.z, rX: followLook.pitch, rY: followLook.yaw, rZ: 0, fov };
	}

	// Third-person: orbit behind the smoothed facing, then LOOK AT the player — so
	// their aim flicks never shake the camera, it just keeps them framed.
	const yr = followLook.yaw * Math.PI / 180;
	const cy = Math.cos(yr), sy = Math.sin(yr);
	const d = num(opt.dist), h = num(opt.height), s = num(opt.side);
	const cx = A.x - cy * d + sy * s;
	const cyp = A.y - sy * d - cy * s;
	const cz = A.z + h;
	const dx = A.x - cx, dy = A.y - cyp, dz = A.z - cz;
	const yaw = Math.atan2(dy, dx) * 180 / Math.PI;
	const pitch = -Math.atan2(dz, Math.sqrt(dx * dx + dy * dy)) * 180 / Math.PI;
	return { x: cx, y: cyp, z: cz, rX: pitch, rY: yaw, rZ: 0, fov };
}

let playerDiagLeft = 1; // dump entity method lists once, to learn the controller↔pawn link
function entName(ent) {
	try { const n = ent.getSanitizedPlayerName ? ent.getSanitizedPlayerName() : ''; if (n) return n; } catch (_) {}
	try { const n = ent.getPlayerName ? ent.getPlayerName() : ''; if (n) return n; } catch (_) {}
	return '';
}
function entSteam(ent) {
	try { const s = ent.getSteamId ? ent.getSteamId() : ''; return s ? String(s) : ''; } catch (_) { return ''; }
}
// Build the follow list: pawns carry the eye to ride; names live on the controller,
// so match them by SteamID.
function pushPlayers() {
	const items = [];
	if (typeof mirv.getHighestEntityIndex === 'function' && typeof mirv.getEntityFromIndex === 'function') {
		let max = 0;
		try { max = mirv.getHighestEntityIndex(); } catch (_) { max = 0; }

		// Pass 1: controllers → name keyed by SteamID.
		const nameBySteam = {};
		let firstCtrl = null;
		for (let i = 0; i <= max; i++) {
			let ent; try { ent = mirv.getEntityFromIndex(i); } catch (_) { continue; }
			if (!ent) continue;
			let isCtrl = false; try { isCtrl = ent.isPlayerController && ent.isPlayerController(); } catch (_) {}
			if (!isCtrl) continue;
			if (!firstCtrl) firstCtrl = ent;
			const sid = entSteam(ent), nm = entName(ent);
			if (sid && nm) nameBySteam[sid] = nm;
		}

		// Pass 2: pawns → follow targets, named via the SteamID map (fallback to its own).
		let firstPawn = null;
		for (let i = 0; i <= max; i++) {
			let ent; try { ent = mirv.getEntityFromIndex(i); } catch (_) { continue; }
			if (!ent) continue;
			let isPawn = false; try { isPawn = ent.isPlayerPawn && ent.isPlayerPawn(); } catch (_) {}
			if (!isPawn) continue;
			if (!firstPawn) firstPawn = ent;
			const sid = entSteam(ent);
			let name = (sid && nameBySteam[sid]) || entName(ent);
			let team = 0, health = 0;
			try { team = ent.getTeam ? ent.getTeam() : 0; } catch (_) {}
			try { health = ent.getHealth ? ent.getHealth() : 0; } catch (_) {}
			items.push({ idx: i, name: name || ('Player ' + i), team: num(team), alive: num(health) > 0 });
		}

		// One-shot: dump the methods on a controller + a pawn so we can see the real link.
		if (playerDiagLeft > 0) {
			playerDiagLeft--;
			const dump = (label, ent) => {
				if (!ent) { send({ type: 'log', msg: '[players.dbg] ' + label + ' = none' }); return; }
				let methods = '';
				try { methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ent)).join(','); } catch (e) { methods = 'err:' + e; }
				send({ type: 'log', msg: '[players.dbg] ' + label + ' name="' + entName(ent) + '" steam=' + entSteam(ent) + ' methods=' + methods });
			};
			dump('controller', firstCtrl);
			dump('pawn', firstPawn);
		}
	}
	send({ type: 'players', items });
}

// (No campath onChanged hook — we track keyframes editor-side; the JS read-back
//  path crashed CS2 on capture, so we don't touch the campath read API at all.)

// --- Register the `mirv_dolly` console command (for binds) -------------------
const dollyCmd = new AdvancedfxConCommand((args) => {
	const sub = args.argC() > 1 ? args.argV(1) : '';
	switch (sub) {
		case 'capture': captureKeyframe(); break;
		case 'preview': previewShot(); break;
		case 'clear':   mirv.exec('mirv_campath clear'); keyframes.length = 0; break;
		case 'enable':  playMode = true; enabledState = true; playOffset = null; playRate = 1; break;
		case 'disable': playMode = false; enabledState = false; break;
		case 'draw':    mirv.exec('mirv_campath draw enabled 1;mirv_campath draw keyCam 1;mirv_campath draw keyAxis 1;mirv_campath draw keyIndex 16'); break;
		case 'drawoff': mirv.exec('mirv_campath draw enabled 0'); break;
		default: mirv.message('[dolly] usage: mirv_dolly capture|preview|clear|enable|disable|draw|drawoff');
	}
});
try { dollyCmd.register('mirv_dolly', 'Noise Cam editor commands'); }
catch (e) { mirv.warning('[dolly] command register failed: ' + e); }

// --- Expose cleanup so re-loading the script is safe ------------------------
globalThis.__cs2_dolly = {
	cleanup: () => {
		try { conn.close(); } catch (_) {}
		try { dollyCmd.unregister(); } catch (_) {}
		try { mirv.events.cViewRenderSetupView.off(VIEW_ID); } catch (_) {}
	},
	keyframes, // persisted so a reload keeps the editor-side keyframe list
};

mirv.message('[dolly] bridge v25 LOADED (keyframed rack focus / DoF tied to keyframes) — look for v25');
} // end wrapper block (keeps declarations out of the persistent global scope)
