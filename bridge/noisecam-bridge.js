// =============================================================================
//  Noise Cam — HLAE bridge (Phase 2: capture & apply)
// =============================================================================
//  Runs INSIDE CS2 via HLAE's sanctioned mirv-script engine. No injection.
//
//  Load it in the CS2 console (CS2 launched through HLAE) — adjust the path to
//  wherever this repo lives on your machine:
//      mirv_script_load "C:\Users\User\Downloads\Transfer-to-CA\Projects\cs2-dolly\bridge\noisecam-bridge.js"
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
const tickByTime = new Map(); // campath keyframe time -> the ACTUAL demo tick it was captured at
let previewEnabled = false;    // when true, the BRIDGE drives the camera along the path (JS view override)
let lastView = null;           // latest free-cam view {x,y,z,rX,rY,rZ,fov}
let pendingCaptureTick = null; // demo tick recorded at capture, assigned to the new keyframe

function demoTickNow() {
	const t = (typeof mirv.getDemoTick === 'function') ? mirv.getDemoTick() : null;
	return (typeof t === 'number' && isFinite(t) && t >= 0) ? t : null; // guard undefined/negative
}

// Create a keyframe with HLAE's OWN command. The JS campath-write API
// (Quaternion.fromQREulerAngles / new CampathValue / campath.add) HARD-CRASHES CS2 on
// this build, so we don't touch it. We record the demo tick so "Go" still seeks correctly.
function captureKeyframe() {
	pendingCaptureTick = demoTickNow();
	mirv.exec('mirv_campath add');
	pushCountdown = 3; // read the campath back a few frames after the deferred add
}
function send(obj) { outQueue.push(JSON.stringify(obj)); }

// --- Read the current campath as a plain list -------------------------------
function getKeyframes() {
	const cp = mirv.getMainCampath();
	const raw = [];
	try {
		const it = new AdvancedfxCampathIterator(cp);
		while (it.valid) {
			const v = it.value;
			let ang = null;
			try {
				const e = v.rot.toQREulerAngles().toQEulerAngles(); // quaternion -> degrees
				ang = { pitch: e.pitch, yaw: e.yaw, roll: e.roll };
			} catch (_) {}
			raw.push({
				time: it.time,
				pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z },
				fov: v.fov,
				ang
			});
			it.next();
		}
	} catch (e) { mirv.warning('[dolly] keyframe read: ' + e); }

	// Assign the captured demo tick to the newly-added keyframe (the one without a tick yet),
	// so "Go" seeks to where you actually were (not the engine-clock keyframe time).
	if (typeof pendingCaptureTick === 'number') {
		let assigned = false;
		for (const r of raw) {
			if (!tickByTime.has(r.time)) { tickByTime.set(r.time, pendingCaptureTick); assigned = true; break; }
		}
		if (assigned) pendingCaptureTick = null;
	}
	// drop ticks for keyframes that no longer exist
	const liveTimes = new Set(raw.map((r) => r.time));
	for (const k of [...tickByTime.keys()]) if (!liveTimes.has(k)) tickByTime.delete(k);

	// Demo↔game clock offset (CS2: keyframe times are GAME time; demo navigation is DEMO time).
	// Fallback to convert a keyframe's game time → demo tick when we lack an exact captured tick.
	const curDemo = (typeof mirv.getDemoTime === 'function') ? mirv.getDemoTime() : undefined;
	const curGame = (typeof mirv.getCurTime === 'function') ? mirv.getCurTime() : undefined;
	const offsetSec = (typeof curDemo === 'number' && typeof curGame === 'number') ? (curGame - curDemo) : null;

	const items = raw.map((r) => {
		let tick = tickByTime.has(r.time) ? tickByTime.get(r.time) : null;
		if (typeof tick !== 'number') {
			// No exact captured tick: convert the GAME-time keyframe to a DEMO tick via the live
			// offset (right as long as the offset hasn't changed since capture). Never raw game*64.
			tick = (offsetSec !== null) ? Math.round((r.time - offsetSec) * 64) : Math.round(r.time * 64);
		}
		return { pos: r.pos, fov: r.fov, ang: r.ang, tick, time: tick / 64 };
	});
	return { type: 'keyframes', count: cp.size, enabled: cp.enabled, items };
}
function pushKeyframes() { try { send(getKeyframes()); } catch (_) {} }

// --- Handle commands from the editor ----------------------------------------
function handleIncoming(msg) {
	if (typeof msg !== 'string') return;
	let obj;
	try { obj = JSON.parse(msg); } catch (_) { return; }
	switch (obj.type) {
		case 'exec':    if (typeof obj.cmd === 'string') { mirv.exec(obj.cmd); pushCountdown = 3; } break;
		case 'capture': captureKeyframe(); break;
		case 'clear':   mirv.exec('mirv_campath clear'); pushCountdown = 3; break;
		case 'remove':  if (Number.isInteger(obj.index)) { mirv.exec('mirv_campath remove ' + obj.index); pushCountdown = 3; } break;
		case 'enable':
			// CS2 keyframes are stored in GAME time, which only moves forward — so once it
			// passes the keyframes you can't play into them. `offset current#0` re-maps the
			// path to START at the current moment, which is what makes playback actually work.
			if (obj.on) mirv.exec('mirv_campath offset current#0;mirv_campath enabled 1');
			else mirv.exec('mirv_campath enabled 0');
			pushCountdown = 3;
			break;
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
		case 'list':    pushKeyframes(); break;
		default: break;
	}
}

// --- Per-frame: read camera (no override), pump the socket -------------------
mirv.onCViewRenderSetupView = (e) => {
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

	// (JS camera-driving via eval()/view-override was removed — the campath-write/eval math
	// path hard-crashes CS2 on this build. Playback uses native `mirv_campath enabled`.)
	return undefined;
};

// --- Auto-sync the editor whenever the campath changes ----------------------
try {
	mirv.getMainCampath().onChanged = () => pushKeyframes();
} catch (_) {}

// --- Register the `mirv_dolly` console command (for binds) -------------------
const dollyCmd = new AdvancedfxConCommand((args) => {
	const sub = args.argC() > 1 ? args.argV(1) : '';
	switch (sub) {
		case 'capture': captureKeyframe(); break;
		case 'clear':   mirv.exec('mirv_campath clear'); break;
		case 'enable':  mirv.exec('mirv_campath enabled 1'); break;
		case 'disable': mirv.exec('mirv_campath enabled 0'); break;
		case 'draw':    mirv.exec('mirv_campath draw enabled 1;mirv_campath draw keyCam 1;mirv_campath draw keyAxis 1;mirv_campath draw keyIndex 16'); break;
		case 'drawoff': mirv.exec('mirv_campath draw enabled 0'); break;
		default: mirv.message('[dolly] usage: mirv_dolly capture|clear|enable|disable|draw|drawoff');
	}
});
try { dollyCmd.register('mirv_dolly', 'Noise Cam editor commands'); }
catch (e) { mirv.warning('[dolly] command register failed: ' + e); }

// --- Expose cleanup so re-loading the script is safe ------------------------
globalThis.__cs2_dolly = {
	cleanup: () => {
		try { conn.close(); } catch (_) {}
		try { dollyCmd.unregister(); } catch (_) {}
		try { const cp = mirv.getMainCampath(); if (cp.onChanged) cp.onChanged = undefined; } catch (_) {}
		try { mirv.onCViewRenderSetupView = undefined; } catch (_) {}
	}
};

mirv.message('[dolly] bridge v9 LOADED (Go fix + offset-align on enable) — look for v9');
} // end wrapper block (keeps declarations out of the persistent global scope)
