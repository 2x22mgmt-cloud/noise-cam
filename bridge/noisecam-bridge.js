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
const keyframes = [];          // editor-side list: {tick,time,pos,fov,ang:{roll}}
let enabledState = false;      // our view of campath enabled (toggled by enable/disable)
let lastView = null;           // latest free-cam view {x,y,z,rX,rY,rZ,fov}

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
		ang: v ? { roll: v.rZ } : null, // roll from the live euler rZ
	});
	keyframes.sort((a, b) => ((a.tick ?? 0) - (b.tick ?? 0)));
	pushKeyframes();
}

// Push our editor-side list (no JS campath read-back).
function pushKeyframes() {
	send({ type: 'keyframes', count: keyframes.length, enabled: enabledState, items: keyframes.slice() });
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
			// CS2 keyframes are stored in GAME time, which only moves forward — so once it
			// passes the keyframes you can't play into them. `offset current#0` re-maps the
			// path to START at the current moment, which is what makes playback actually work.
			if (obj.on) mirv.exec('mirv_campath offset current#0;mirv_campath enabled 1');
			else mirv.exec('mirv_campath enabled 0');
			enabledState = !!obj.on;
			pushKeyframes();
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

	// We never override the view here — return undefined so native campath
	// playback (mirv_campath enabled) controls the camera.
	return undefined;
});

// (No campath onChanged hook — we track keyframes editor-side; the JS read-back
//  path crashed CS2 on capture, so we don't touch the campath read API at all.)

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
		try { mirv.events.cViewRenderSetupView.off(VIEW_ID); } catch (_) {}
	}
};

mirv.message('[dolly] bridge v12 LOADED (events API view hook — native campath playback now works) — look for v12');
} // end wrapper block (keeps declarations out of the persistent global scope)
