// CS2 Dolly — browser UI logic. Talks to app/server.mjs over /ui,
// which relays to the HLAE bridge running inside CS2.

const TICKRATE = 64; // CS2 demos
const $ = (id) => document.getElementById(id);

let ws = null;
let enabled = false;     // campath enabled state (from keyframes msg)
let drawOn = false;      // local toggle for "show path"
let lastCamPaint = 0;

// ---------- logging ----------
function log(msg) {
	const el = $('log');
	const line = `${new Date().toLocaleTimeString()}  ${msg}\n`;
	el.textContent = (line + el.textContent).split('\n').slice(0, 60).join('\n');
}

// ---------- websocket ----------
function connect() {
	ws = new WebSocket(`ws://${location.host}/ui`);
	ws.onopen = () => setStatus(false, 'server connected — waiting for CS2');
	ws.onclose = () => { setStatus(false, 'server offline — retrying'); setTimeout(connect, 1000); };
	ws.onerror = () => {};
	ws.onmessage = (ev) => {
		let m; try { m = JSON.parse(ev.data); } catch { return; }
		if (m.type === 'cam') onCam(m);
		else if (m.type === 'keyframes') onKeyframes(m);
		else if (m.type === 'status') setStatus(m.hlae, m.hlae ? 'CS2 connected' : 'waiting for CS2');
	};
}
function send(obj) {
	if (ws && ws.readyState === 1) {
		ws.send(JSON.stringify(obj));
		// log control messages (exec() logs its own, so skip those here)
		if (obj.type && obj.type !== 'exec') {
			log('» ' + obj.type + (obj.on === true ? ' on' : obj.on === false ? ' off' : '') + (obj.index !== undefined ? ' #' + obj.index : ''));
		}
	} else log('not connected');
}
function exec(cmd) { send({ type: 'exec', cmd }); log('» ' + cmd); }

// ---------- status ----------
function setStatus(on, text) {
	$('statusDot').classList.toggle('on', !!on);
	$('statusText').textContent = text;
}

// ---------- live readout ----------
const f = (n, d = 1) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '–');
function onCam(m) {
	const now = performance.now();
	if (now - lastCamPaint < 80) return; // ~12 fps UI refresh
	lastCamPaint = now;
	const v = m.view || {};
	$('rTick').textContent = m.demoTick ?? '–';
	$('rTime').textContent = m.demoTime != null ? f(m.demoTime, 2) + 's' : '–';
	$('rFov').textContent = f(v.fov);
	$('rState').textContent = m.paused ? '⏸ paused' : '▶ playing';
	$('rPos').textContent = `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`;
	$('rAng').textContent = `${f(v.rX)}, ${f(v.rY)}, ${f(v.rZ)}`;
}

// ---------- keyframes ----------
function onKeyframes(kf) {
	enabled = !!kf.enabled;
	$('kfCount').textContent = `(${kf.count})`;
	const list = $('kfList');
	const items = kf.items || [];
	if (!items.length) {
		list.innerHTML = '<div class="empty">No keyframes yet — fly the cam and hit Capture.</div>';
	} else {
		list.innerHTML = '';
		items.forEach((k, i) => {
			const p = k.pos || {}, a = k.ang || {};
			const tick = (typeof k.tick === 'number') ? k.tick : Math.round((k.time || 0) * TICKRATE);
			const row = document.createElement('div');
			row.className = 'kf-row';
			row.innerHTML =
				`<span>${i}</span>` +
				`<span>${f(k.time, 2)}s</span>` +
				`<span class="pos">${f(p.x)}, ${f(p.y)}, ${f(p.z)}</span>` +
				`<span>${f(k.fov)}</span>` +
				`<span>${f(a.roll)}</span>` +
				`<span class="acts"></span>`;
			const acts = row.querySelector('.acts');
			const go = document.createElement('button'); go.textContent = 'Go';
			go.title = `demo_gototick ${tick}`;
			go.onclick = () => exec('demo_gototick ' + tick);
			const del = document.createElement('button'); del.textContent = '✕'; del.className = 'danger';
			del.onclick = () => send({ type: 'remove', index: i });
			acts.append(go, del);
			list.appendChild(row);
		});
	}
	updateEnableBtn();
}
function updateEnableBtn() {
	const b = $('btnEnable');
	b.textContent = enabled ? 'Disable path' : 'Enable path';
	b.classList.toggle('active', enabled);
}

// ---------- DoF helper ----------
function applyDof() {
	const nc = $('dofNearCrisp').value, fc = $('dofFarCrisp').value;
	const nb = $('dofNearBlurry').value, fb = $('dofFarBlurry').value;
	exec(`r_dof_override 1;r_dof_override_near_crisp ${nc};r_dof_override_far_crisp ${fc};r_dof_override_near_blurry ${nb};r_dof_override_far_blurry ${fb}`);
}

// ---------- wire up ----------
function wire() {
	$('btnCapture').onclick = () => send({ type: 'capture' });
	$('btnEnable').onclick = () => send({ type: 'enable', on: !enabled });
	$('btnDraw').onclick = () => { drawOn = !drawOn; send({ type: 'draw', on: drawOn }); $('btnDraw').classList.toggle('active', drawOn); };
	$('btnClear').onclick = () => { if (confirm('Clear all keyframes?')) send({ type: 'clear' }); };
	$('btnSave').onclick = () => exec('mirv_campath save ' + ($('pathName').value || 'myshot'));
	$('btnLoad').onclick = () => exec('mirv_campath load ' + ($('pathName').value || 'myshot'));

	$('btnPause').onclick = () => exec('demo_pause');
	$('btnResume').onclick = () => exec('demo_resume');
	$('btnGoto').onclick = () => { const t = $('gotoTick').value; if (t !== '') exec('demo_gototick ' + t); };
	document.querySelectorAll('.ts').forEach((b) => b.onclick = () => exec('demo_timescale ' + b.dataset.ts));

	document.querySelectorAll('[data-cmd]').forEach((b) => b.onclick = () => exec(b.dataset.cmd));
	document.querySelectorAll('[data-macro]').forEach((b) => b.onclick = () => {
		switch (b.dataset.macro) {
			case 'setup': exec('sv_cheats 1;mirv_cvar_unhide_all;mirv_fix animations 1;cl_drawhud 0;cl_draw_only_deathnotices 1;cl_demo_predict 0;cl_trueview_show_status 0;r_show_build_info false'); break;
			case 'cam': exec('mirv_input camera'); break;
			case 'dofon': applyDof(); break;
			case 'dofoff': exec('r_dof_override 0'); break;
		}
	});
	$('btnApplyDof').onclick = applyDof;
	$('btnBlock').onclick = () => {
		const n = ($('blockName').value || '').trim();
		if (!n) { log('enter your player name first'); return; }
		const ok = confirm(
			'Block other kills\n\n' +
			'⚠ You must be selecting / spectating the player whose kills you want to isolate.\n' +
			`This keeps only kill feed entries involving "${n}" and blocks the rest.\n\n` +
			'Apply the filter now?'
		);
		if (!ok) { log('block other kills — cancelled'); return; }
		exec(`mirv_deathmsg filter add attackerMatch=!${n} victimMatch=!${n} block=1 lastRule=1`);
	};

	$('btnSend').onclick = () => { const c = $('rawCmd').value.trim(); if (c) { exec(c); $('rawCmd').value = ''; } };
	$('rawCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSend').click(); });
}

wire();
connect();
