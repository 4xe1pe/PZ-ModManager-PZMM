const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let st = null, curId = null, curTitle = '', forced = '';
const wv = $('wv');

function toast(r, okMsg) {
  const m = r && r.error ? r.error : (r && r.info) || okMsg; if (!m) return;
  const t = $('toast'); t.textContent = m; t.className = r && r.error ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), r && r.error ? 9000 : 4000);
}
function modal(title, body, buttons, extra, after) {
  return new Promise((res) => {
    $('mTitle').textContent = title; $('mBody').innerHTML = body; const b = $('mBtns'); b.innerHTML = '';
    buttons.forEach(([label, val, cls]) => { const x = document.createElement('button'); x.textContent = label; if (cls) x.className = cls;
      x.onclick = () => { const f = {}; $('mBody').querySelectorAll('[data-f]').forEach((i) => (f[i.dataset.f] = i.value)); $('modal').hidden = true; res({ val, all: extra ? $('chkAll').checked : false, f }); }; b.appendChild(x); });
    $('modal').hidden = false; if (after) after();
  });
}
const act = async (p, ok) => { const r = await p; toast(r, ok); return r; };

function render() {
  if (!st) return; const S = st.settings, P = S.profiles[S.active];
  $('profiles').innerHTML = Object.entries(S.profiles).map(([id, p]) => `<div class="prof ${id === S.active ? 'on' : ''}" data-id="${id}">${esc(p.name)}<small>${p.gameDir ? esc(p.gameDir) : 'No game folder set'}</small></div>`).join('');
  $('profiles').querySelectorAll('.prof').forEach((e) => (e.onclick = () => act(api.setActive(e.dataset.id))));
  $('paths').innerHTML = `<b>${esc(P.name)}</b><div class="lbl" style="margin:8px 0 2px">Game folder</div><div class="p">${esc(P.gameDir) || '<i>not set</i>'}</div>
   <select id="ver"><option value="">Auto-detect version</option>${Object.entries(S.profiles).map(([id, p]) => `<option value="${id}" ${forced === id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
   <button id="pg">Browse…</button>
   <div class="lbl" style="margin:8px 0 2px">Game executable</div><div class="p">${st.exe ? esc(st.exe) : '<i>not set</i>'}${st.exe && !st.exeExists ? ' <span class="bad">(missing)</span>' : ''}</div><button id="pe">Select executable…</button>
   <div class="lbl" style="margin:8px 0 2px">Game Mods folder (managed link)</div><div class="p">${esc(P.modsDir) || '<i>not set</i>'}</div><button id="pm">Browse…</button>`;
  $('ver').onchange = (e) => (forced = e.target.value); $('pg').onclick = () => act(api.pickGame(forced || null)); $('pm').onclick = () => act(api.pickMods()); $('pe').onclick = () => act(api.pickExe());
  const busy = st.busy;
  $('btnClear').disabled = busy; $('btnCancel').hidden = !busy; $('bar').className = busy ? 'run' : '';
  $('steamStatus').innerHTML = st.steam ? `SteamCMD: <span class="ok">ready</span> – ${esc(st.steam)}` : `SteamCMD: <span class="bad">not found</span> – open Settings`;
  $('queue').innerHTML = st.queue.slice(-6).map((q) => `${esc(q.title)} (${q.wid}) → ${esc(q.iname || '')} – <b class="${q.status === 'Failed' ? 'bad' : q.status === 'Completed' ? 'ok' : ''}">${q.status}</b> ${esc(q.status === 'Failed' || q.status === 'Completed' ? q.msg || '' : q.line || '')}`).join('<br>');
  $('modCount').textContent = st.mods.length ? `(${st.mods.length})` : '';
  renderInst(); renderMods(); renderDetect();
}
let instSig = '';
const curInst = () => { const S = st.settings, L = S.instances[S.active]; return L.find((i) => i.id === S.activeInstance[S.active]) || L[0]; };
function renderInst() {
  const S = st.settings, L = S.instances[S.active], cur = curInst(), I = st.instance;
  const sig = JSON.stringify([S.active, L.map((i) => [i.id, i.name]), cur.id, I.linked, cur.modsDir, st.launching]);
  if (sig !== instSig) { // only rebuild when something changed, so an open dropdown is not closed by log updates
    instSig = sig;
    $('instbar').innerHTML = `<span class="lbl2">Instance</span><select id="instSel">${L.map((i) => `<option value="${esc(i.id)}" ${i.id === cur.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select>
      <button id="iNew">＋ New</button><button id="iRen">✎ Rename</button><button id="iDel">🗑 Delete</button><button id="iAct" ${st.launching ? 'disabled' : ''}>Activate now</button>
      <span class="chip ${I.linked ? 'on' : ''}">${I.linked ? '● Active in the game' : '○ Not active in the game yet – activated automatically on launch'}</span>
      <span class="ipath">Mods folder of this instance: ${esc(cur.modsDir)}</span>`;
    $('instSel').onchange = (e) => act(api.instSelect(e.target.value));
    $('iAct').onclick = () => act(api.instActivate());
    $('iDel').onclick = () => act(api.instDelete(cur.id));
    $('iRen').onclick = async () => {
      const r = await modal('Rename instance', `<div class="fld"><label>New name</label><input data-f="name" value="${esc(cur.name)}" maxlength="40"></div>`, [['Cancel', 'c'], ['Rename', 'ok', 'primary']]);
      if (r.val === 'ok') act(api.instRename(cur.id, r.f.name));
    };
    $('iNew').onclick = async () => {
      const r = await modal('New instance', `<div class="fld"><label>Name</label><input data-f="name" placeholder="e.g. Instance 2, Vanilla…" maxlength="40"></div><div class="fld"><label>Storage folder (optional)</label><div class="two"><input data-f="dir" id="fDir" placeholder="Default: inside the library folder"><button id="fBrowse" type="button">Browse…</button></div><small>The instance keeps its mods and downloads in this folder. Leave empty to use the library folder.</small></div>`,
        [['Cancel', 'c'], ['Create', 'ok', 'primary']], false,
        () => { $('fBrowse').onclick = async () => { const x = await api.pickFolder('Select the storage folder for this instance'); if (x.path) $('fDir').value = x.path; }; });
      if (r.val === 'ok') act(api.instCreate({ name: r.f.name, dir: r.f.dir }));
    };
  }
  $('btnLaunch').disabled = !!st.launching; $('btnLaunch').textContent = st.launching ? '⏳ Launching…' : '▶ Launch Project Zomboid';
  $('launchInfo').innerHTML = `Will launch with instance:<br><b>${esc(cur.name)}</b> · ${esc(S.profiles[S.active].name)}<br>${st.exe ? (st.exeExists ? '' : '<span class="bad">Executable missing: </span>') + esc(st.exe.split(/[\\/]/).pop()) : '<span class="bad">No executable selected</span>'} <button class="mini" id="btnExe">Select…</button>`;
  $('btnExe').onclick = () => act(api.pickExe());
}
function renderMods() {
  if (!st.mods.length) { $('modTable').innerHTML = '<div class="empty">No mods in this instance yet.<br>Use the Workshop Browser and press Download.</div>'; return; }
  $('modTable').innerHTML = `<table><tr><th></th><th>Mod name</th><th>Project Zomboid version</th><th>Download date</th><th>Status</th><th>Update status</th></tr>${st.mods.map((m) => {
    const s = m.status === 'Failed' ? 'Failed' : m.installed ? 'Installed' : 'Downloaded';
    return `<tr><td><input type="checkbox" class="sel" data-id="${esc(m.id)}" ${m.selected ? 'checked' : ''}></td><td>${esc(m.title)}${m.name && m.name !== m.title ? `<br><small style="color:#7d8596">${esc(m.name)} · ${m.wid}</small>` : ''}${m.error ? `<br><small class="bad">${esc(m.error)}</small>` : ''}</td>
    <td>${esc(st.settings.profiles[st.settings.active].name)}</td><td>${new Date(m.downloadedAt).toLocaleString()}</td><td><span class="badge b-${s}">${s}</span></td><td>${m.update ? '<span class="badge b-upd">Update available</span>' : '<span style="color:#7d8596">—</span>'}</td></tr>`; }).join('')}</table>`;
  document.querySelectorAll('.sel').forEach((c) => (c.onchange = () => { const m = st.mods.find((x) => x.id === c.dataset.id); m.selected = c.checked; api.select(c.dataset.id, c.checked); }));
}
function renderDetect() {
  const id = curId; if (!id) { $('detect').textContent = 'Browse the Workshop – open a mod page and its ID is picked up automatically.'; return; }
  const m = st.mods.find((x) => x.wid === id), q = st.queue.find((x) => x.wid === id && x.iid === curInst().id && ['Waiting', 'Downloading', 'Processing'].includes(x.status));
  const state = q ? q.status : !m ? 'Not downloaded' : m.status === 'Failed' ? 'Failed' : m.installed ? 'Installed' : 'Downloaded';
  $('detect').innerHTML = `<b>${esc(curTitle)}</b> <span style="color:#7d8596">ID ${id}</span> <span class="badge b-${state === 'Not downloaded' ? 'wait' : state === 'Installed' ? 'Installed' : state === 'Failed' ? 'Failed' : 'Downloaded'}">${state}</span>${m && m.update ? '<span class="badge b-upd">Update available</span>' : ''}`;
}
function nav() {
  const u = wv.getURL(); const m = u.match(/sharedfiles\/filedetails\/?\?(?:.*&)?id=(\d+)/);
  curId = m ? m[1] : null; curTitle = wv.getTitle().replace(/^Steam Workshop::/, '') || ''; renderDetect();
}
['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'dom-ready'].forEach((e) => wv.addEventListener(e, () => { try { nav(); } catch {} }));
$('back').onclick = () => wv.canGoBack() && wv.goBack(); $('fwd').onclick = () => wv.canGoForward() && wv.goForward();
$('home').onclick = () => wv.loadURL('https://steamcommunity.com/app/108600/workshop/');
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t)); $('browser').hidden = t.dataset.t !== 'browser'; $('modsView').hidden = t.dataset.t !== 'mods'; }));
const doDownload = async () => { const v = $('paste').value.trim() || curId; if (!v) return toast({ error: 'Open a Workshop mod page or paste a URL/ID first.' }); const r = await act(api.download(v)); if (!r.error) $('paste').value = ''; };
$('btnDownload').onclick = doDownload; $('addPaste').onclick = doDownload; $('paste').onkeydown = (e) => e.key === 'Enter' && doDownload();
$('btnCancel').onclick = () => api.cancel();
$('btnLaunch').onclick = async () => {
  $('btnLaunch').disabled = true; toast({ info: 'Preparing launch… progress is shown in the status bar.' });
  const r = await api.launch(); if (st) $('btnLaunch').disabled = !!st.launching; toast(r);
};
$('btnUpdates').onclick = () => act(api.checkUpdates());
$('btnClear').onclick = () => act(api.clearCache());
$('btnRemove').onclick = () => act(api.remove(st.mods.filter((m) => m.selected).map((m) => m.id)));
$('btnPush').onclick = async () => {
  $('btnPush').disabled = true; const r = await api.push(); $('btnPush').disabled = false;
  if (r.error) return toast(r);
  const icon = { Installed: '✔', 'Already installed': '＝', Skipped: '↷', Failed: '✖' };
  modal('Push finished – instance “' + (r.instance || '') + '”', r.results.map((x) => `<div class="row"><span>${icon[x.r]} ${esc(x.name)}</span><span class="${x.r === 'Failed' ? 'bad' : x.r === 'Installed' ? 'ok' : ''}">${x.r}${x.msg ? ' – ' + esc(x.msg) : ''}</span></div>`).join('') + (r.note ? `<div style="margin-top:12px;color:#9aa3b5;white-space:normal">${esc(r.note)}</div>` : ''), [['OK', 1, 'primary']]);
};
$('btnSettings').onclick = async () => {
  const S = st.settings, sx = await api.steamInfo(); const body = `<div class="row"><span>Steam (for launching)</span><span>${sx.path ? esc(sx.path) : '<b class="bad">not found</b>'}</span></div><div class="row"><span>SteamCMD</span><span>${st.steam ? esc(st.steam) : '<b class="bad">not found</b>'}</span></div><div class="row"><span>Library</span><span>${esc(S.library)}</span></div>`;
  const r = await modal('Settings', body, [['Select steam.exe…', 'x'], ['Select SteamCMD…', 's'], ['Install SteamCMD', 'i'], ['Library folder…', 'l'], ['Close', 'c', 'primary']]);
  if (r.val === 'x') act(api.pickSteamExe()); if (r.val === 's') act(api.pickSteamcmd()); if (r.val === 'i') act(api.installSteamcmd(), 'Installing SteamCMD, see status bar…'); if (r.val === 'l') act(api.pickLibrary());
};
api.on('state', (s) => { st = s; render(); });
api.on('log', (l) => { $('logline').textContent = l; });
api.on('conflict', async (d) => {
  const r = await modal('Mod already exists', `A different version of <b>${esc(d.name)}</b> already exists in the Mods folder.<br><br><label><input type="checkbox" id="chkAll"> Apply to all remaining</label>`, [['Replace', 'replace', 'primary'], ['Keep both', 'both'], ['Skip', 'skip']], true);
  api.reply('conflict-reply', { action: r.val, all: r.all });
});
api.state().then((s) => { st = s; render(); });
