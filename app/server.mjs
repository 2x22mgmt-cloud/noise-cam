// =============================================================================
//  Noise Cam — app server (Phase 3: GUI)
// =============================================================================
//  One process that:
//    1. serves the web UI (public/) over HTTP
//    2. accepts the HLAE bridge on  ws://localhost:31337/mirv   (unchanged)
//    3. accepts the browser UI on   ws://localhost:31337/ui
//    4. relays messages between them (cam/keyframes -> UI, commands -> HLAE)
//
//  Run:  npm install  &&  npm start     (or double-click ..\NoiseCam.bat)
//  Then your browser opens http://localhost:31337 automatically.
// =============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DOLLY_PORT ? Number(process.env.DOLLY_PORT) : 31337;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon'
};

// --- static file server -----------------------------------------------------
const httpServer = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(req.url.split('?')[0]);
	if (urlPath === '/') urlPath = '/index.html';
	const safe = path.normalize(urlPath).replace(/^(\.\.[\\/])+/, '');
	const filePath = path.join(PUBLIC, safe);
	if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
	fs.readFile(filePath, (err, data) => {
		if (err) { res.writeHead(404); res.end('not found'); return; }
		res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
		res.end(data);
	});
});

// --- two websocket endpoints sharing the port -------------------------------
const wssMirv = new WebSocketServer({ noServer: true }); // HLAE bridge
const wssUi = new WebSocketServer({ noServer: true });    // browser UI
const hlaeClients = new Set();
const uiClients = new Set();

httpServer.on('upgrade', (req, socket, head) => {
	let pathname = '/';
	try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
	if (pathname === '/mirv') {
		wssMirv.handleUpgrade(req, socket, head, (ws) => wssMirv.emit('connection', ws, req));
	} else if (pathname === '/ui') {
		wssUi.handleUpgrade(req, socket, head, (ws) => wssUi.emit('connection', ws, req));
	} else {
		socket.destroy();
	}
});

function broadcast(set, str) {
	for (const ws of set) { if (ws.readyState === 1) ws.send(str); }
}
function uiStatus() {
	broadcast(uiClients, JSON.stringify({ type: 'status', hlae: hlaeClients.size > 0 }));
}

// HLAE bridge: forward its cam/keyframes to the UI.
wssMirv.on('connection', (ws) => {
	hlaeClients.add(ws);
	console.log('[dolly] CS2/HLAE connected.');
	uiStatus();
	broadcast(hlaeClients, JSON.stringify({ type: 'list' })); // pull current keyframes
	ws.on('message', (data, isBinary) => { if (!isBinary) broadcast(uiClients, data.toString()); });
	ws.on('close', () => { hlaeClients.delete(ws); console.log('[dolly] CS2/HLAE disconnected.'); uiStatus(); });
	ws.on('error', () => {});
});

// Browser UI: forward its commands to HLAE.
wssUi.on('connection', (ws) => {
	uiClients.add(ws);
	ws.send(JSON.stringify({ type: 'status', hlae: hlaeClients.size > 0 }));
	if (hlaeClients.size > 0) broadcast(hlaeClients, JSON.stringify({ type: 'list' }));
	ws.on('message', (data, isBinary) => { if (!isBinary) broadcast(hlaeClients, data.toString()); });
	ws.on('close', () => { uiClients.delete(ws); });
	ws.on('error', () => {});
});

httpServer.listen(PORT, () => {
	const url = `http://localhost:${PORT}`;
	console.log('========================================================');
	console.log('  Noise Cam');
	console.log(`  UI:            ${url}`);
	console.log(`  HLAE endpoint: ws://localhost:${PORT}/mirv`);
	console.log('========================================================');
	console.log('In CS2 (via HLAE) run:');
	console.log(`  mirv_script_load "${path.join(__dirname, '..', 'bridge', 'noisecam-bridge.js')}"`);
	console.log('Opening the UI in your browser...  (Ctrl+C here to quit)\n');
	if (process.platform === 'win32') {
		try { exec(`start "" "${url}"`); } catch (_) {}
	}
});
