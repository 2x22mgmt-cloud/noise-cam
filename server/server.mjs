// =============================================================================
//  Noise Cam — editor-side server (Phase 2: capture & apply)
// =============================================================================
//  Run with:   npm start     (or double-click ..\start-server.bat)
//
//  HLAE (running noisecam-bridge.js inside CS2) connects OUT to this server.
//  This console build lets you build a campath without alt-tabbing into CS2:
//    - shows the live camera + demo tick/time
//    - shows the live keyframe list (auto-updates when the path changes)
//    - type commands here to capture/list/clear/remove/enable/draw/interp
//    - anything unrecognized is sent to CS2 as a raw console command
//
//  Later this is replaced by the Tauri + React/TS timeline UI; the protocol stays.
// =============================================================================

import { WebSocketServer } from 'ws';
import readline from 'node:readline';

const PORT = process.env.DOLLY_PORT ? Number(process.env.DOLLY_PORT) : 31337;
const PATH = '/mirv';

const wss = new WebSocketServer({ port: PORT, path: PATH });
const clients = new Set();
let lastPrint = 0;

console.log(`[dolly-server] listening on ws://localhost:${PORT}${PATH}`);
console.log('[dolly-server] In CS2 (via HLAE): mirv_script_load "C:\\Users\\User\\Downloads\\Transfer-to-CA\\Projects\\cs2-dolly\\bridge\\noisecam-bridge.js"');
console.log('[dolly-server] Commands:');
console.log('    capture            drop a keyframe at the current view + demo time');
console.log('    list               re-print the keyframe list');
console.log('    remove <i>         delete keyframe #i');
console.log('    clear              delete all keyframes');
console.log('    enable | disable   turn the campath on/off');
console.log('    draw   | drawoff   show/hide the path in-game');
console.log('    interp <position|rotation|fov> <mode>');
console.log('    <anything else>    sent to CS2 as a raw console command (e.g. demo_pause)');
console.log('[dolly-server] Ctrl+C to quit.\n');

const fmt = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '-');

function printKeyframes(kf) {
	const items = kf.items || [];
	process.stdout.write('\n');
	console.log(`── Campath: ${kf.count} keyframe(s)  [path ${kf.enabled ? 'ENABLED' : 'disabled'}] ──`);
	if (!items.length) {
		console.log('   (empty — scrub to a tick, fly the cam, then `capture`)');
	} else {
		items.forEach((k, i) => {
			const p = k.pos || {}, a = k.ang || {};
			console.log(`  #${i}  t=${fmt(k.time, 2)}s  pos=(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})  fov=${fmt(k.fov)}  roll=${fmt(a.roll)}`);
		});
		if (kf.count >= 4) console.log('   (>=4 keyframes — `enable` then unpause to preview the move)');
		else console.log(`   (need ${4 - kf.count} more for cubic; or set all channels to linear for 2)`);
	}
	console.log('');
}

function broadcast(obj) {
	const s = JSON.stringify(obj);
	for (const ws of clients) ws.send(s);
}

wss.on('connection', (ws) => {
	clients.add(ws);
	console.log('\n[dolly-server] HLAE connected.');

	ws.on('message', (data, isBinary) => {
		if (isBinary) return;
		let obj;
		try { obj = JSON.parse(data.toString()); } catch (_) { return; }

		if (obj.type === 'cam') {
			const now = Date.now();
			if (now - lastPrint < 100) return; // ~10 Hz console refresh
			lastPrint = now;
			const v = obj.view || {};
			process.stdout.write(
				`\rtick=${obj.demoTick ?? '-'} t=${fmt(obj.demoTime, 2)}s ${obj.paused ? '[paused] ' : ''}` +
				`pos=(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}) ang=(${fmt(v.rX)}, ${fmt(v.rY)}, ${fmt(v.rZ)}) fov=${fmt(v.fov)}   `
			);
		} else if (obj.type === 'keyframes') {
			printKeyframes(obj);
		}
	});

	ws.on('close', () => { clients.delete(ws); console.log('\n[dolly-server] HLAE disconnected.'); });
	ws.on('error', (e) => console.error('\n[dolly-server] ws error:', e.message));
});

// REPL
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
	const raw = line.trim();
	if (!raw) return;
	if (clients.size === 0) { console.log('[dolly-server] (no HLAE connected yet)'); return; }

	const parts = raw.split(/\s+/);
	const cmd = parts[0].toLowerCase();
	const rest = parts.slice(1);

	switch (cmd) {
		case 'capture': case 'cap': broadcast({ type: 'capture' }); console.log('[sent] capture'); break;
		case 'list': case 'ls': broadcast({ type: 'list' }); break;
		case 'clear': broadcast({ type: 'clear' }); console.log('[sent] clear'); break;
		case 'remove': case 'rm': {
			const i = parseInt(rest[0], 10);
			if (Number.isInteger(i)) { broadcast({ type: 'remove', index: i }); console.log('[sent] remove ' + i); }
			else console.log('usage: remove <index>');
			break;
		}
		case 'enable': broadcast({ type: 'enable', on: true }); console.log('[sent] enable'); break;
		case 'disable': broadcast({ type: 'enable', on: false }); console.log('[sent] disable'); break;
		case 'draw': broadcast({ type: 'draw', on: true }); console.log('[sent] draw on'); break;
		case 'drawoff': broadcast({ type: 'draw', on: false }); console.log('[sent] draw off'); break;
		case 'interp': {
			const [channel, mode] = rest;
			if (channel && mode) { broadcast({ type: 'interp', channel, mode }); console.log(`[sent] interp ${channel} ${mode}`); }
			else console.log('usage: interp <position|rotation|fov> <default|linear|cubic|sLinear|sCubic>');
			break;
		}
		default:
			broadcast({ type: 'exec', cmd: raw });
			console.log('[sent] exec: ' + raw);
	}
});
