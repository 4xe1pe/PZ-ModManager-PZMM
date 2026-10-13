const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let st = null, curId = null, curTitle = '', forced = '';
const wv = $('wv');
let am = [], amRows = [], amSel = new Set(), amOpen = false, amBusy = false, amSig = '', amFilter = '', amTarget = '';

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
  renderInst(); renderMods(); renderDetect(); amSync();
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
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t)); $('browser').hidden = t.dataset.t !== 'browser'; $('modsView').hidden = t.dataset.t !== 'mods'; $('allModsView').hidden = true; amOpen = false; $('btnAllMods').classList.remove('primary'); }));
const resultIcon = { Installed: '✔', Moved: '✔', Replaced: '✔', 'Kept both': '✔', Removed: '✔', 'Already installed': '＝', Skipped: '↷', Partial: '⚠', Failed: '✖' };
const resultRows = (results) => results.map((x) => `<div class="row"><span>${resultIcon[x.r]} ${esc(x.name)}${x.from ? ` <small style="color:#7d8596">(${esc(x.from)})</small>` : ''}</span><span class="${x.r === 'Failed' || x.r === 'Partial' ? 'bad' : ['Installed', 'Moved', 'Replaced', 'Kept both', 'Removed'].includes(x.r) ? 'ok' : ''}">${x.r}${x.msg ? ' – ' + esc(x.msg) : ''}</span></div>`).join('');
const amKey = (m) => m.iid + '/' + m.id, amName = (m) => m.name || m.title;
const amState = (m) => (m.status === 'Failed' ? 'Failed' : !m.hasLib && !m.inMods ? 'Missing' : m.inMods ? 'Installed' : 'Downloaded');
const amSelected = () => am.filter((m) => amSel.has(amKey(m)));
function amPrune() { amSel = new Set(am.filter((m) => amSel.has(amKey(m)) && m.iid === amFilter).map(amKey)); }
async function loadAllMods() {
  const r = await api.modsAll(); if (r.error) return toast(r);
  am = r.items; amPrune(); renderAllMods();
}
function amSync() {
  if (!amOpen) return;
  const sig = JSON.stringify([st.busy, st.settings.instances, st.mods.map((m) => [m.id, m.status, m.installed]), st.queue.map((q) => q.status)]);
  if (sig !== amSig) { amSig = sig; loadAllMods(); }
}
function amBar() {
  const n = amSelected().length;
  $('amCount').textContent = n ? `${n} selected` : `${amRows.length} mod(s)`;
  $('amMove').disabled = $('amDel').disabled = !n || amBusy;
  const a = $('amAll'); if (a) a.checked = amRows.length > 0 && amRows.every((m) => amSel.has(amKey(m)));
}
async function amRun(p, title) {
  amBusy = true; amBar(); const r = await p; amBusy = false;
  if (r.error) toast(r); else modal(title, resultRows(r.results), [['OK', 1, 'primary']]);
  await loadAllMods();
}
function renderAllMods() {
  const S = st.settings, L = Object.entries(S.instances).flatMap(([pid, l]) => l.map((i) => ({ ...i, pid })));
  if (!L.some((i) => i.id === amFilter)) amFilter = (L.find((i) => i.id === S.activeInstance[S.active]) || L[0]).id;
  if (!L.some((i) => i.id === amTarget)) amTarget = (L.find((i) => i.id !== amFilter) || L[0]).id;
  const groups = (sel) => Object.entries(S.instances).map(([pid, l]) => `<optgroup label="${esc(S.profiles[pid].name)}">${l.map((i) => `<option value="${esc(i.id)}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>`).join('');
  $('amBar').innerHTML = `<select id="amFilter">${groups(amFilter)}</select><span id="amCount" style="align-self:center;color:#9aa3b5"></span><span style="flex:1"></span><span style="align-self:center;color:#7d8596">Move to</span><select id="amTarget">${groups(amTarget)}</select><button id="amMove" class="accent">➜ Move</button><button id="amDel" class="danger">🗑 Delete…</button>`;
  amRows = am.filter((m) => m.iid === amFilter);
  $('amTable').innerHTML = !amRows.length ? '<div class="empty">No mods in this instance.<br>Pick another instance above, or download or copy mods into this one.</div>' : `<table><tr><th><input type="checkbox" id="amAll"></th><th>Mod name</th><th>Instance</th><th>Project Zomboid version</th><th>Download date</th><th>Status</th><th>Update status</th></tr>${amRows.map((m, n) => {
    const s = amState(m);
    return `<tr><td><input type="checkbox" class="amSel" data-n="${n}" ${amSel.has(amKey(m)) ? 'checked' : ''}></td><td>${esc(m.title)}${m.name && m.name !== m.title ? `<br><small style="color:#7d8596">${esc(m.name)} · ${esc(m.wid)}</small>` : ''}${m.error ? `<br><small class="bad">${esc(m.error)}</small>` : ''}</td>
    <td>${esc(m.iname)}</td><td>${esc(m.pname)}</td><td>${m.downloadedAt ? new Date(m.downloadedAt).toLocaleString() : '—'}</td><td><span class="badge b-${s}">${s === 'Missing' ? 'Files missing' : s}</span></td><td>${m.update ? '<span class="badge b-upd">Update available</span>' : '<span style="color:#7d8596">—</span>'}</td></tr>`; }).join('')}</table>`;
  const boxes = [...document.querySelectorAll('.amSel')];
  boxes.forEach((c) => (c.onchange = () => { const k = amKey(amRows[c.dataset.n]); c.checked ? amSel.add(k) : amSel.delete(k); amBar(); }));
  if ($('amAll')) $('amAll').onchange = (e) => { amRows.forEach((m) => (e.target.checked ? amSel.add(amKey(m)) : amSel.delete(amKey(m)))); boxes.forEach((c) => (c.checked = e.target.checked)); amBar(); };
  $('amFilter').onchange = (e) => { amFilter = e.target.value; if (amTarget === amFilter) amTarget = (L.find((i) => i.id !== amFilter) || L[0]).id; amPrune(); renderAllMods(); };
  $('amTarget').onchange = (e) => (amTarget = e.target.value);
  $('amMove').onclick = async () => {
    const to = L.find((i) => i.id === amTarget), sel = amSelected(), mv = sel.filter((m) => m.iid !== to.id && m.status !== 'Failed');
    if (!mv.length) return toast({ error: `Nothing to move: the selected mods are already in "${to.name}" or are failed downloads.` });
    const by = {}; mv.forEach((m) => (by[m.iid] ||= { n: `${m.iname} (${m.pname})`, l: [] }).l.push(amName(m)));
    const r = await modal(`Move ${mv.length} mod(s) to “${to.name}”`, [
      Object.values(by).map((g) => `<div>• <b>${esc(g.n)}</b>: ${g.l.map((x) => esc(x)).join(', ')}</div>`).join(''),
      `<div style="margin-top:10px;color:#9aa3b5;white-space:normal">Each mod's downloaded files and its copy in the Mods folder (if any) are copied to <b>${esc(to.name)}</b> (${esc(S.profiles[to.pid].name)}) and added to its list. Only then are they removed from the source instance. If a step fails, that mod is left untouched in the source. If a mod already exists in the target you are asked whether to replace it, keep both or skip it.</div>`,
      mv.some((m) => m.pid !== to.pid) ? '<div class="bad" style="margin-top:8px;white-space:normal">Some mods come from a different Project Zomboid version profile and may not work in the target version.</div>' : '',
      sel.length > mv.length ? `<div style="margin-top:8px;color:#9aa3b5;white-space:normal">${sel.length - mv.length} selected mod(s) are ignored (already in the target or failed downloads).</div>` : ''
    ].join(''), [['Cancel', 'c'], ['Move', 'ok', 'primary']]);
    if (r.val === 'ok') amRun(api.modsMove(mv.map((m) => ({ iid: m.iid, id: m.id })), to.id), 'Move finished');
  };
  $('amDel').onclick = async () => {
    const sel = amSelected(), nLib = sel.filter((m) => m.hasLib).length, nMods = sel.filter((m) => m.inMods).length;
    const opt = (t, d) => `<div style="margin-top:8px;white-space:normal"><b>${t}</b> – ${d}</div>`;
    const r = await modal(`Delete ${sel.length} mod(s)`, [
      sel.slice(0, 12).map((m) => `<div>• ${esc(amName(m))} <small style="color:#7d8596">${esc(m.iname)} · ${esc(m.pname)}</small></div>`).join(''), sel.length > 12 ? `<div>… and ${sel.length - 12} more</div>` : '',
      opt('Remove from library', `deletes the downloaded copy kept by this app (${nLib} found) and removes the mod from the list. The copy in the instance's Mods folder (${nMods} found) is left in place.`),
      opt('Remove from Mods folder', `deletes only the copy in the instance's Mods folder (${nMods} found), which is what Project Zomboid loads. The downloaded copy and the list entry stay, so you can push it again.`),
      opt('Remove from both', 'deletes both copies and removes the mod from the list.'),
      '<div class="bad" style="margin-top:10px">This cannot be undone.</div>'
    ].join(''), [['Cancel', 'c'], ['Remove from library', 'lib'], ['Remove from Mods folder', 'game'], ['Remove from both', 'both', 'danger']]);
    if (r.val !== 'c') amRun(api.modsDelete(sel.map((m) => ({ iid: m.iid, id: m.id })), r.val), 'Delete finished');
  };
  amBar();
}
$('btnAllMods').onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on')); $('browser').hidden = true; $('modsView').hidden = true; $('allModsView').hidden = false;
  amOpen = true; amSig = ''; $('btnAllMods').classList.add('primary'); amSync();
};
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
  modal('Push finished – instance “' + (r.instance || '') + '”', resultRows(r.results) + (r.note ? `<div style="margin-top:12px;color:#9aa3b5;white-space:normal">${esc(r.note)}</div>` : ''), [['OK', 1, 'primary']]);
};
$('btnSettings').onclick = async () => {
  const S = st.settings, sx = await api.steamInfo(); const body = `<div class="row"><span>Steam (for launching)</span><span>${sx.path ? esc(sx.path) : '<b class="bad">not found</b>'}</span></div><div class="row"><span>SteamCMD</span><span>${st.steam ? esc(st.steam) : '<b class="bad">not found</b>'}</span></div><div class="row"><span>Library</span><span>${esc(S.library)}</span></div>`;
  const r = await modal('Settings', body, [['Select steam.exe…', 'x'], ['Select SteamCMD…', 's'], ['Install SteamCMD', 'i'], ['Library folder…', 'l'], ['Close', 'c', 'primary']]);
  if (r.val === 'x') act(api.pickSteamExe()); if (r.val === 's') act(api.pickSteamcmd()); if (r.val === 'i') act(api.installSteamcmd(), 'Installing SteamCMD, see status bar…'); if (r.val === 'l') act(api.pickLibrary());
};
api.on('state', (s) => { st = s; render(); });
api.on('log', (l) => { $('logline').textContent = l; });
api.on('conflict', async (d) => {
  const r = await modal('Mod already exists', `${d.where ? 'The mod' : 'A different version of'} <b>${esc(d.name)}</b> already exists in ${d.where ? 'instance “' + esc(d.where) + '”' : 'the Mods folder'}.<br><br><label><input type="checkbox" id="chkAll"> Apply to all remaining</label>`, [['Replace', 'replace', 'primary'], ['Keep both', 'both'], ['Skip', 'skip']], true);
  api.reply('conflict-reply', { action: r.val, all: r.all });
});
api.state().then((s) => { st = s; render(); });
