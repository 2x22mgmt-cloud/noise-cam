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
			return {
				x: catmull(p0.x, a.pos.x, b.pos.x, p3.x, f),
				y: catmull(p0.y, a.pos.y, b.pos.y, p3.y, f),
				z: catmull(p0.z, a.pos.z, b.pos.z, p3.z, f),
				rX: catmullAngle(g0.rX, a.ang.rX, b.ang.rX, g3.rX, f),
				rY: catmullAngle(g0.rY, a.ang.rY, b.ang.rY, g3.rY, f),
				rZ: catmullAngle(g0.rZ, a.ang.rZ, b.ang.rZ, g3.rZ, f),
				fov: catmull(fov0, a.fov, b.fov, fov3, f),
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
			if (playMode) { playOffset = null; playRate = 1; } // manual play = real-time camera
			try { mirv.exec('mirv_campath enabled 0'); } catch (_) {}
			pushKeyframes();
			break;
		case 'preview': previewShot(typeof obj.timescale === 'number' ? obj.timescale : undefined); break;
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
			// `edit ... current` commands below target it).
			if (Number.isInteger(obj.index)) mirv.exec('mirv_campath select #' + obj.index + ' #' + obj.index);
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
			return view; // <-- drives the camera along the dolly
		}
	}
	return undefined;
});

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

mirv.message('[dolly] bridge v19 LOADED (adjustable preview speed via playRate) — look for v19');
} // end wrapper block (keeps declarations out of the persistent global scope)
