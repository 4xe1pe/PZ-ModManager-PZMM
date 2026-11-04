const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const ACTIVE = ['Waiting', 'Downloading', 'Processing'];
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (s) => String(s || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

/* ---------- mod icons: poster image with the initials tile as fallback ---------- */
const modIcon = (m, iid) => {
  const pick = m.name && m.status !== 'Failed';
  return `<div class="tile sm mod-ic" style="--h:${hue(m.wid)}"${pick ? ` data-iid="${esc(iid)}" data-wid="${esc(m.wid)}" data-name="${esc(m.name)}"` : ''}><span>${esc(initials(m.title))}</span></div>`;
};
const posterCache = new Map();
const loadPoster = (iid, wid, name) => {
  const k = [iid, wid, name].join('\n');
  if (!posterCache.has(k)) posterCache.set(k, Promise.resolve().then(() => api.poster(iid, wid, name)).then((r) => (r && r.data) || null, () => null));
  return posterCache.get(k);
};
function hydratePosters(root) {
  root.querySelectorAll('.mod-ic[data-name]').forEach((el) => {
    if (el.querySelector('img')) return;
    loadPoster(el.dataset.iid, el.dataset.wid, el.dataset.name).then((src) => {
      if (!src || !el.isConnected || el.querySelector('img')) return;
      const img = new Image(); img.alt = ''; img.draggable = false;
      img.onerror = () => img.remove(); // broken file: the initials underneath stay visible
      img.src = src; el.appendChild(img);
    });
  });
}

let st = null, curId = null, curTitle = '', forced = '', view = 'mods', instSig = '';
let modQ = '', modF = 'all', amQ = '', amF = 'all';
const wv = $('wv');
let am = [], amRows = [], amSel = new Set(), amOpen = false, amBusy = false, amSig = '', amFilter = '', amTarget = '';

/* ---------- feedback: toast, dialogs, context menu ---------- */
function toast(r, okMsg) {
  const m = r && r.error ? r.error : (r && r.info) || okMsg; if (!m) return;
  const t = $('toast'); t.textContent = m; t.className = r && r.error ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), r && r.error ? 9000 : 4000);
}
function modal(title, body, buttons, extra, after) {
  return new Promise((res) => {
    $('mTitle').textContent = title; $('mBody').innerHTML = body;
    const bar = $('mBtns'); bar.innerHTML = '';
    // the "cancel" value: Cancel / Skip / the last button, so Esc and the × never trigger a destructive choice
    const cancelVal = (buttons.find((b) => ['c', 'skip'].includes(b[1])) || buttons[buttons.length - 1])[1];
    const finish = (val) => {
      const f = {}; $('mBody').querySelectorAll('[data-f]').forEach((i) => (f[i.dataset.f] = i.value));
      const all = extra && $('chkAll') ? $('chkAll').checked : false;
      $('modal').hidden = true; document.removeEventListener('keydown', onKey); res({ val, all, f });
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(cancelVal); };
    buttons.forEach(([label, val, cls]) => {
      const x = document.createElement('button'); x.textContent = label; if (cls) x.className = cls;
      x.onclick = () => finish(val); bar.appendChild(x);
    });
    $('mX').onclick = () => finish(cancelVal);
    document.addEventListener('keydown', onKey);
    $('modal').hidden = false; if (after) after();
  });
}
const act = async (p, ok) => { const r = await p; toast(r, ok); return r; };

const ctx = $('ctx');
function closeCtx() { ctx.hidden = true; }
function openCtx(e, items) {
  e.preventDefault(); e.stopPropagation();
  const list = items.filter(Boolean);
  ctx.innerHTML = list.map((it, i) => (it === 'sep' ? '<div class="sep"></div>' : `<button role="menuitem" data-i="${i}" class="${it.cls || ''}" ${it.off ? 'disabled' : ''}>${esc(it.label)}</button>`)).join('');
  ctx.querySelectorAll('button').forEach((b) => (b.onclick = () => { const it = list[+b.dataset.i]; closeCtx(); it.run(); }));
  ctx.hidden = false;
  const x = Math.min(e.clientX, innerWidth - ctx.offsetWidth - 8), y = Math.min(e.clientY, innerHeight - ctx.offsetHeight - 8);
  ctx.style.left = Math.max(8, x) + 'px'; ctx.style.top = Math.max(8, y) + 'px';
}
const copy = (t) => Promise.resolve().then(() => navigator.clipboard.writeText(t)).then(() => toast({ info: 'Copied ' + t }), () => toast({ error: 'Could not copy to the clipboard.' }));
function openWorkshop(wid) { showView('browser'); wv.loadURL(`https://steamcommunity.com/sharedfiles/filedetails/?id=${wid}`); }

/* ---------- shared helpers ---------- */
const curInst = () => { const S = st.settings, L = S.instances[S.active]; return L.find((i) => i.id === S.activeInstance[S.active]) || L[0]; };
const allInst = () => Object.entries(st.settings.instances).flatMap(([pid, l]) => l.map((i) => ({ ...i, pid })));
const instById = (id) => allInst().find((i) => i.id === id);
const mState = (m) => (m.status === 'Failed' ? 'Failed' : m.installed ? 'Installed' : 'Downloaded');
const matchQ = (m, q) => !q || [m.title, m.name, m.wid].some((x) => String(x ?? '').toLowerCase().includes(q));
const matchF = (state, upd, f) => f === 'all' || (f === 'update' ? !!upd : f === state.toLowerCase());

/* ---------- main render (called on every state push) ---------- */
function render() {
  if (!st) return;
  renderProfiles(); renderPaths(); renderStatus(); renderInstances(); renderDetails(); renderMods(); renderDetect(); amSync();
}
function renderProfiles() {
  const S = st.settings;
  $('profiles').innerHTML = Object.entries(S.profiles).map(([id, p]) => `<button class="seg ${id === S.active ? 'on' : ''}" data-id="${esc(id)}" title="${esc(p.gameDir || 'No game folder set')}">${esc(p.name)}</button>`).join('');
  $('profiles').querySelectorAll('.seg').forEach((e) => (e.onclick = () => act(api.setActive(e.dataset.id))));
}
function renderPaths() {
  const S = st.settings, P = S.profiles[S.active];
  $('paths').innerHTML = `
   <div class="fld"><label>Game folder · ${esc(P.name)}</label><div class="path">${esc(P.gameDir) || '<i>not set</i>'}</div><button id="pg" class="mini">Browse…</button></div>
   <div class="fld"><label>Game executable</label><div class="path">${st.exe ? esc(st.exe) : '<i>not set</i>'}${st.exe && !st.exeExists ? ' <span class="bad">(missing)</span>' : ''}</div><button id="pe" class="mini">Select executable…</button></div>
   <div class="fld"><label>Mods folder (managed link)</label><div class="path">${esc(P.modsDir) || '<i>not set</i>'}</div><button id="pm" class="mini">Browse…</button></div>
   <div class="fld"><label>Folder for “Browse…”</label><select id="ver"><option value="">Auto-detect version</option>${Object.entries(S.profiles).map(([id, p]) => `<option value="${esc(id)}" ${forced === id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`;
  $('ver').onchange = (e) => (forced = e.target.value);
  $('pg').onclick = () => act(api.pickGame(forced || null));
  $('pm').onclick = () => act(api.pickMods());
  $('pe').onclick = () => act(api.pickExe());
}
function renderStatus() {
  const busy = st.busy;
  $('steamStatus').innerHTML = st.steam
    ? `<span class="dot ok"></span>SteamCMD ready`
    : `<span class="dot bad"></span>SteamCMD not found – open Settings`;
  const active = st.queue.filter((q) => ACTIVE.includes(q.status)).length, failed = st.queue.filter((q) => q.status === 'Failed').length;
  $('queueCount').textContent = st.queue.length ? `Queue: ${active} active${failed ? ` · ${failed} failed` : ''}` : 'Queue empty';
  $('queue').innerHTML = st.queue.slice(-6).map((q) => `<div class="qrow">${esc(q.title)} <span class="muted">(${esc(q.wid)}) → ${esc(q.iname || '')}</span> – <b class="${q.status === 'Failed' ? 'bad' : q.status === 'Completed' ? 'ok' : ''}">${q.status}</b> <span class="muted">${esc(q.status === 'Failed' || q.status === 'Completed' ? q.msg || '' : q.line || '')}</span></div>`).join('');
  $('bar').className = busy ? 'run' : '';
  $('btnCancel').hidden = !busy;
  $('btnClear').disabled = busy;
  $('modCount').textContent = st.mods.length || '';
}
let instListSig = '';
function renderInstances() {
  const S = st.settings, L = S.instances[S.active], cur = curInst(), I = st.instance;
  const sig = JSON.stringify([S.active, L.map((i) => [i.id, i.name, i.modsDir]), cur.id, I.linked]);
  if (sig !== instListSig) { // rebuild only on change, so hover and context menus are not reset by log updates
    instListSig = sig;
    $('instList').innerHTML = L.length ? L.map((i) => {
      const on = i.id === cur.id;
      const state = on ? (I.linked ? 'Active in the game' : 'Selected · not active yet') : 'Idle';
      return `<div class="inst ${on ? 'on' : ''}" role="option" aria-selected="${on}" tabindex="0" data-id="${esc(i.id)}" title="${esc(i.modsDir)}">
        <div class="tile" style="--h:${hue(i.name)}">${esc(initials(i.name))}</div>
        <div class="inst-txt"><b>${esc(i.name)}</b><small>${on && I.linked ? '<span class="dot ok"></span>' : '<span class="dot"></span>'}${state}</small></div></div>`;
    }).join('') : '<div class="empty-s">No instances yet.</div>';
  }
}
function renderDetails() {
  const S = st.settings, P = S.profiles[S.active], cur = curInst(), I = st.instance;
  $('detTile').textContent = initials(cur.name); $('detTile').style.setProperty('--h', hue(cur.name));
  $('detName').textContent = cur.name;
  $('detSub').textContent = `Project Zomboid · ${P.name}`;
  $('detVer').textContent = P.name;
  $('detMods').textContent = `${st.mods.length} mod(s)`;
  $('detDir').textContent = cur.dir;
  $('detModsDir').textContent = cur.modsDir;
  $('detChip').className = 'chip ' + (I.linked ? 'on' : '');
  $('detChip').textContent = I.linked ? 'Active in the game' : 'Not active yet – activated automatically on launch';
  $('iAct').disabled = !!st.launching;
  $('btnLaunch').disabled = !!st.launching;
  $('btnLaunch').innerHTML = st.launching ? `${icon('play')}Launching…` : `${icon('play')}Launch`;
  $('launchInfo').innerHTML = `Launches with <b>${esc(cur.name)}</b> · ${esc(P.name)}<br>${st.exe ? (st.exeExists ? '' : '<span class="bad">Executable missing: </span>') + esc(st.exe.split(/[\\/]/).pop()) : '<span class="bad">No executable selected</span>'}<br><button class="mini" id="btnExe">Select executable…</button>`;
  $('btnExe').onclick = () => act(api.pickExe());
}

/* ---------- mods of the selected instance ---------- */
function visMods() { const q = modQ.trim().toLowerCase(); return st.mods.filter((m) => matchQ(m, q) && matchF(mState(m), m.update, modF)); }
function renderMods() {
  const P = st.settings.profiles[st.settings.active], cur = curInst();
  const picked = st.mods.filter((m) => m.selected).length;
  $('modsTitle').textContent = cur.name;
  $('modsSub').textContent = `${P.name} · ${st.mods.length} mod(s)${picked ? ` · ${picked} selected` : ''}`;
  $('btnRemove').disabled = !picked || st.busy;
  $('btnUpdates').disabled = !st.mods.length;
  if (!st.mods.length) {
    $('modTable').innerHTML = `<div class="empty"><div class="empty-ic">${icon('box')}</div><b>No mods in this instance yet</b><p>Open the Workshop browser, find a mod and press Download. It will appear here.</p><button id="emptyBrowse" class="primary">${icon('globe')}Open Workshop browser</button></div>`;
    $('emptyBrowse').onclick = () => showView('browser');
    return;
  }
  const vis = visMods();
  if (!vis.length) { $('modTable').innerHTML = '<div class="empty"><b>No mods match</b><p>Try another search or filter.</p></div>'; return; }
  const allOn = vis.every((m) => m.selected);
  $('modTable').innerHTML = `<table><thead><tr><th class="c-chk"><input type="checkbox" id="modAll" title="Select all shown" ${allOn ? 'checked' : ''}></th><th>Mod</th><th>Status</th><th>Updates</th><th class="hide-md">Downloaded</th></tr></thead><tbody>${vis.map((m) => {
    const s = mState(m);
    return `<tr class="${m.selected ? 'sel-row' : ''}" data-id="${esc(m.id)}">
      <td class="c-chk"><input type="checkbox" class="sel" data-id="${esc(m.id)}" ${m.selected ? 'checked' : ''}></td>
      <td><div class="modcell">${modIcon(m, curInst().id)}<div class="mc-txt"><div class="mc-title">${esc(m.title)}</div><small>${m.name && m.name !== m.title ? esc(m.name) + ' · ' : ''}Workshop ${esc(m.wid)}</small>${m.error ? `<small class="bad block">${esc(m.error)}</small>` : ''}</div></div></td>
      <td><span class="badge b-${s}">${s}</span></td>
      <td>${m.update ? '<span class="badge b-upd">Update available</span>' : '<span class="muted">—</span>'}</td>
      <td class="hide-md muted">${m.downloadedAt ? new Date(m.downloadedAt).toLocaleString() : '—'}</td></tr>`;
  }).join('')}</tbody></table>`;
  hydratePosters($('modTable'));
}
function renderDetect() {
  const id = curId; if (!id) { $('detect').textContent = 'Browse the Workshop – open a mod page and its ID is picked up automatically.'; return; }
  const m = st.mods.find((x) => x.wid === id), q = st.queue.find((x) => x.wid === id && x.iid === curInst().id && ACTIVE.includes(x.status));
  const state = q ? q.status : !m ? 'Not downloaded' : m.status === 'Failed' ? 'Failed' : m.installed ? 'Installed' : 'Downloaded';
  const cls = state === 'Not downloaded' ? 'b-wait' : state === 'Installed' ? 'b-Installed' : state === 'Failed' ? 'b-Failed' : 'b-Downloaded';
  $('detect').innerHTML = `<b>${esc(curTitle)}</b><span class="muted">ID ${esc(id)}</span><span class="badge ${cls}">${state}</span>${m && m.update ? '<span class="badge b-upd">Update available</span>' : ''}`;
}
function nav() {
  const u = wv.getURL(); const m = u.match(/sharedfiles\/filedetails\/?\?(?:.*&)?id=(\d+)/);
  curId = m ? m[1] : null; curTitle = wv.getTitle().replace(/^Steam Workshop::/, '') || ''; renderDetect();
}

/* ---------- navigation between sections ---------- */
function showView(v) {
  view = v;
  document.querySelectorAll('.nav-item').forEach((x) => x.classList.toggle('on', x.dataset.s === v));
  $('modsView').hidden = v !== 'mods'; $('browser').hidden = v !== 'browser'; $('allModsView').hidden = v !== 'all';
  amOpen = v === 'all';
  if (amOpen) { amSig = ''; amSync(); }
}

/* ---------- instance actions ---------- */
async function newInst() {
  const r = await modal('New instance', `<div class="fld"><label>Name</label><input data-f="name" placeholder="e.g. Survival, Vanilla, Testing…" maxlength="40"></div><div class="fld"><label>Storage folder (optional)</label><div class="two"><input data-f="dir" id="fDir" placeholder="Default: inside the library folder"><button id="fBrowse" type="button">Browse…</button></div><small>The instance keeps its mods and downloads in this folder. Leave empty to use the library folder.</small></div>`,
    [['Cancel', 'c'], ['Create', 'ok', 'primary']], false,
    () => { $('fBrowse').onclick = async () => { const x = await api.pickFolder('Select the storage folder for this instance'); if (x.path) $('fDir').value = x.path; }; });
  if (r.val === 'ok') act(api.instCreate({ name: r.f.name, dir: r.f.dir }));
}
async function renameInst(id) {
  const inst = instById(id); if (!inst) return;
  const r = await modal('Rename instance', `<div class="fld"><label>New name</label><input data-f="name" value="${esc(inst.name)}" maxlength="40"></div>`, [['Cancel', 'c'], ['Rename', 'ok', 'primary']]);
  if (r.val === 'ok') act(api.instRename(id, r.f.name));
}
const deleteInst = (id) => act(api.instDelete(id));
function instMenu(id) {
  const cur = curInst();
  return [
    { label: 'Activate now', off: st.launching, run: async () => { if (id !== cur.id) await api.instSelect(id); act(api.instActivate()); } },
    { label: 'Select', off: id === cur.id, run: () => act(api.instSelect(id)) },
    'sep',
    { label: 'Rename…', run: () => renameInst(id) },
    { label: 'Delete…', cls: 'danger', off: st.busy, run: () => deleteInst(id) }
  ];
}

/* ---------- all mods across instances ---------- */
const amKey = (m) => m.iid + '/' + m.id, amName = (m) => m.name || m.title;
const amState = (m) => (m.status === 'Failed' ? 'Failed' : !m.hasLib && !m.inMods ? 'Missing' : m.inMods ? 'Installed' : 'Downloaded');
const amSelected = () => am.filter((m) => amSel.has(amKey(m)));
function amPrune() { amSel = new Set(am.filter((m) => amSel.has(amKey(m)) && m.iid === amFilter).map(amKey)); }
async function loadAllMods() {
  const r = await api.modsAll(); if (r.error) return toast(r);
  am = r.items; amPrune(); renderAllMods();
}
function amSync() {
  if (!amOpen || !st) return;
  const sig = JSON.stringify([st.busy, st.settings.instances, st.mods.map((m) => [m.id, m.status, m.installed]), st.queue.map((q) => q.status)]);
  if (sig !== amSig) { amSig = sig; loadAllMods(); }
}
function amBar() {
  const n = amSelected().length;
  $('amCount').textContent = n ? `${n} selected` : `${amRows.length} shown`;
  $('amMove').disabled = $('amDel').disabled = !n || amBusy;
  const a = $('amAll'); if (a) a.checked = amRows.length > 0 && amRows.every((m) => amSel.has(amKey(m)));
}
async function amRun(p, title) {
  amBusy = true; amBar(); const r = await p; amBusy = false;
  if (r.error) toast(r); else modal(title, resultRows(r.results), [['OK', 1, 'primary']]);
  await loadAllMods();
}
function renderAllMods() {
  const S = st.settings, L = allInst();
  if (!L.some((i) => i.id === amFilter)) amFilter = (L.find((i) => i.id === S.activeInstance[S.active]) || L[0]).id;
  if (!L.some((i) => i.id === amTarget)) amTarget = (L.find((i) => i.id !== amFilter) || L[0]).id;
  const groups = (sel) => Object.entries(S.instances).map(([pid, l]) => `<optgroup label="${esc(S.profiles[pid].name)}">${l.map((i) => `<option value="${esc(i.id)}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>`).join('');
  $('amFilter').innerHTML = groups(amFilter);
  $('amTarget').innerHTML = groups(amTarget);
  const q = amQ.trim().toLowerCase();
  amRows = am.filter((m) => m.iid === amFilter && matchQ(m, q) && matchF(amState(m), m.update, amF));
  $('amTable').innerHTML = !am.some((m) => m.iid === amFilter) ? '<div class="empty"><div class="empty-ic">' + icon('list') + '</div><b>No mods in this instance</b><p>Pick another instance above, or download or copy mods into this one.</p></div>'
    : !amRows.length ? '<div class="empty"><b>No mods match</b><p>Try another search or filter.</p></div>'
    : `<table><thead><tr><th class="c-chk"><input type="checkbox" id="amAll"></th><th>Mod</th><th>Instance</th><th>Version</th><th class="hide-md">Downloaded</th><th>Status</th><th>Updates</th></tr></thead><tbody>${amRows.map((m) => {
      const s = amState(m), k = amKey(m);
      return `<tr class="${amSel.has(k) ? 'sel-row' : ''}" data-k="${esc(k)}">
        <td class="c-chk"><input type="checkbox" class="amSel" data-k="${esc(k)}" ${amSel.has(k) ? 'checked' : ''}></td>
        <td><div class="modcell">${modIcon(m, m.iid)}<div class="mc-txt"><div class="mc-title">${esc(m.title)}</div><small>${m.name && m.name !== m.title ? esc(m.name) + ' · ' : ''}Workshop ${esc(m.wid)}</small>${m.error ? `<small class="bad block">${esc(m.error)}</small>` : ''}</div></div></td>
        <td class="muted">${esc(m.iname)}</td><td class="muted">${esc(m.pname)}</td>
        <td class="hide-md muted">${m.downloadedAt ? new Date(m.downloadedAt).toLocaleString() : '—'}</td>
        <td><span class="badge b-${s}">${s === 'Missing' ? 'Files missing' : s}</span></td>
        <td>${m.update ? '<span class="badge b-upd">Update available</span>' : '<span class="muted">—</span>'}</td></tr>`;
    }).join('')}</tbody></table>`;
  amBar(); hydratePosters($('amTable'));
}
async function amMoveFlow() {
  const S = st.settings, to = allInst().find((i) => i.id === amTarget), sel = amSelected(), mv = sel.filter((m) => m.iid !== to.id && m.status !== 'Failed');
  if (!mv.length) return toast({ error: `Nothing to move: the selected mods are already in “${to.name}” or are failed downloads.` });
  const by = {}; mv.forEach((m) => (by[m.iid] ||= { n: `${m.iname} (${m.pname})`, l: [] }).l.push(amName(m)));
  const r = await modal(`Move ${mv.length} mod(s) to “${to.name}”`, [
    Object.values(by).map((g) => `<div>• <b>${esc(g.n)}</b>: ${g.l.map((x) => esc(x)).join(', ')}</div>`).join(''),
    `<div class="opt muted">Each mod's downloaded files and its copy in the Mods folder (if any) are copied to <b>${esc(to.name)}</b> (${esc(S.profiles[to.pid].name)}) and added to its list. Only then are they removed from the source instance. If a step fails, that mod is left untouched in the source. If a mod already exists in the target you are asked whether to replace it, keep both or skip it.</div>`,
    mv.some((m) => m.pid !== to.pid) ? '<div class="bad">Some mods come from a different Project Zomboid version profile and may not work in the target version.</div>' : '',
    sel.length > mv.length ? `<div class="opt muted">${sel.length - mv.length} selected mod(s) are ignored (already in the target or failed downloads).</div>` : ''
  ].join(''), [['Cancel', 'c'], ['Move', 'ok', 'primary']]);
  if (r.val === 'ok') amRun(api.modsMove(mv.map((m) => ({ iid: m.iid, id: m.id })), to.id), 'Move finished');
}
async function amDelFlow() {
  const sel = amSelected(), nLib = sel.filter((m) => m.hasLib).length, nMods = sel.filter((m) => m.inMods).length;
  const opt = (t, d) => `<div class="opt"><b>${t}</b> – ${d}</div>`;
  const r = await modal(`Delete ${sel.length} mod(s)`, [
    sel.slice(0, 12).map((m) => `<div>• ${esc(amName(m))} <small>${esc(m.iname)} · ${esc(m.pname)}</small></div>`).join(''), sel.length > 12 ? `<div class="muted">… and ${sel.length - 12} more</div>` : '',
    opt('Remove from library', `deletes the downloaded copy kept by this app (${nLib} found) and removes the mod from the list. The copy in the instance's Mods folder (${nMods} found) is left in place.`),
    opt('Remove from Mods folder', `deletes only the copy in the instance's Mods folder (${nMods} found), which is what Project Zomboid loads. The downloaded copy and the list entry stay, so you can push it again.`),
    opt('Remove from both', 'deletes both copies and removes the mod from the list.'),
    '<div class="bad">This cannot be undone.</div>'
  ].join(''), [['Cancel', 'c'], ['Remove from library', 'lib'], ['Remove from Mods folder', 'game'], ['Remove from both', 'both', 'danger']]);
  if (r.val !== 'c') amRun(api.modsDelete(sel.map((m) => ({ iid: m.iid, id: m.id })), r.val), 'Delete finished');
}

/* ---------- results / settings / conflicts ---------- */
const resultIcon = { Installed: '✔', Moved: '✔', Replaced: '✔', 'Kept both': '✔', Removed: '✔', 'Already installed': '＝', Skipped: '↷', Partial: '⚠', Failed: '✖' };
const resultRows = (results) => results.map((x) => `<div class="res-row"><span>${resultIcon[x.r]} ${esc(x.name)}${x.from ? ` <small>(${esc(x.from)})</small>` : ''}</span><span class="${x.r === 'Failed' || x.r === 'Partial' ? 'bad' : ['Installed', 'Moved', 'Replaced', 'Kept both', 'Removed'].includes(x.r) ? 'ok' : ''}">${x.r}${x.msg ? ' – ' + esc(x.msg) : ''}</span></div>`).join('');

/* ---------- event wiring (set up once) ---------- */
document.querySelectorAll('.nav-item').forEach((t) => (t.onclick = () => showView(t.dataset.s)));
$('back').onclick = () => wv.canGoBack() && wv.goBack();
$('fwd').onclick = () => wv.canGoForward() && wv.goForward();
$('home').onclick = () => wv.loadURL('https://steamcommunity.com/app/108600/workshop/');
['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'dom-ready'].forEach((e) => wv.addEventListener(e, () => { try { nav(); } catch {} }));

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
  modal('Push finished – instance “' + (r.instance || '') + '”', resultRows(r.results) + (r.note ? `<div class="opt muted">${esc(r.note)}</div>` : ''), [['OK', 1, 'primary']]);
};
$('btnSettings').onclick = async () => {
  const S = st.settings, sx = await api.steamInfo();
  const body = `<div class="row"><span>Steam (for launching)</span><span>${sx.path ? esc(sx.path) : '<b class="bad">not found</b>'}</span></div><div class="row"><span>SteamCMD</span><span>${st.steam ? esc(st.steam) : '<b class="bad">not found</b>'}</span></div><div class="row"><span>Library</span><span>${esc(S.library)}</span></div><div class="fld" style="margin-top:14px"><label>Custom launch arguments</label><input data-f="launchArgs" value="${esc(S.launchArgs || '')}" placeholder="-javaagent:ZombieBuddy.jar"><small>Passed to the game when launching. Separate arguments with spaces; use quotes for values containing spaces. Leave empty for a normal launch.</small></div>`;
  const r = await modal('Settings', body, [['Select steam.exe…', 'x'], ['Select SteamCMD…', 's'], ['Install SteamCMD', 'i'], ['Library folder…', 'l'], ['Close', 'c', 'primary']]);
  if (r.f && r.f.launchArgs !== undefined && r.f.launchArgs.trim() !== (S.launchArgs || '').trim()) await api.setLaunchArgs(r.f.launchArgs);
  if (r.val === 'x') act(api.pickSteamExe()); if (r.val === 's') act(api.pickSteamcmd()); if (r.val === 'i') act(api.installSteamcmd(), 'Installing SteamCMD, see status bar…'); if (r.val === 'l') act(api.pickLibrary());
};

$('tbNew').onclick = newInst; $('iNew').onclick = newInst;
$('iAct').onclick = () => act(api.instActivate());
$('iRen').onclick = () => renameInst(curInst().id);
$('iDel').onclick = () => deleteInst(curInst().id);

// instance list: click to select, right-click for actions
$('instList').addEventListener('click', (e) => { const el = e.target.closest('.inst'); if (el && el.dataset.id !== curInst().id) act(api.instSelect(el.dataset.id)); });
$('instList').addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; const el = e.target.closest('.inst'); if (el && el.dataset.id !== curInst().id) act(api.instSelect(el.dataset.id)); });
$('instList').addEventListener('contextmenu', (e) => { const el = e.target.closest('.inst'); if (el) openCtx(e, instMenu(el.dataset.id)); });

// mods table: checkboxes, select-all, right-click
$('modSearch').oninput = (e) => { modQ = e.target.value; renderMods(); };
$('modFilter').onchange = (e) => { modF = e.target.value; renderMods(); };
$('modTable').addEventListener('change', (e) => {
  const t = e.target;
  if (t.classList.contains('sel')) { const m = st.mods.find((x) => x.id === t.dataset.id); if (m) { m.selected = t.checked; api.select(m.id, t.checked); } renderMods(); }
  else if (t.id === 'modAll') { visMods().forEach((m) => { m.selected = t.checked; api.select(m.id, t.checked); }); renderMods(); }
});
$('modTable').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const m = st.mods.find((x) => x.id === tr.dataset.id); if (!m) return;
  openCtx(e, [
    { label: m.selected ? 'Deselect' : 'Select', run: () => { m.selected = !m.selected; api.select(m.id, m.selected); renderMods(); } },
    { label: 'Open Workshop page', run: () => openWorkshop(m.wid) },
    { label: 'Copy Workshop ID', run: () => copy(m.wid) },
    'sep',
    { label: 'Remove this mod…', cls: 'danger', off: st.busy, run: () => act(api.remove([m.id])) }
  ]);
});

// all-mods view
$('amFilter').onchange = (e) => { amFilter = e.target.value; if (amTarget === amFilter) amTarget = (allInst().find((i) => i.id !== amFilter) || allInst()[0]).id; amPrune(); renderAllMods(); };
$('amTarget').onchange = (e) => (amTarget = e.target.value);
$('amSearch').oninput = (e) => { amQ = e.target.value; renderAllMods(); };
$('amStatus').onchange = (e) => { amF = e.target.value; renderAllMods(); };
$('amMove').onclick = amMoveFlow;
$('amDel').onclick = amDelFlow;
$('amTable').addEventListener('change', (e) => {
  const t = e.target;
  if (t.classList.contains('amSel')) { const m = amRows.find((x) => amKey(x) === t.dataset.k); if (m) { t.checked ? amSel.add(amKey(m)) : amSel.delete(amKey(m)); t.closest('tr').classList.toggle('sel-row', t.checked); } amBar(); }
  else if (t.id === 'amAll') { amRows.forEach((m) => (t.checked ? amSel.add(amKey(m)) : amSel.delete(amKey(m)))); renderAllMods(); }
});
$('amTable').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-k]'); if (!tr) return;
  const m = amRows.find((x) => amKey(x) === tr.dataset.k); if (!m) return;
  const k = amKey(m);
  openCtx(e, [
    { label: amSel.has(k) ? 'Deselect' : 'Select', run: () => { amSel.has(k) ? amSel.delete(k) : amSel.add(k); renderAllMods(); } },
    { label: 'Select only this mod', run: () => { amSel = new Set([k]); renderAllMods(); } },
    'sep',
    m.wid && { label: 'Open Workshop page', run: () => openWorkshop(m.wid) },
    m.wid && { label: 'Copy Workshop ID', run: () => copy(m.wid) },
    'sep',
    { label: 'Delete… (this mod)', cls: 'danger', off: amBusy, run: () => { amSel = new Set([k]); renderAllMods(); amDelFlow(); } }
  ]);
});

// global dismissal of context menu
document.addEventListener('mousedown', (e) => { if (!ctx.contains(e.target)) closeCtx(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
window.addEventListener('blur', closeCtx); window.addEventListener('resize', closeCtx);
document.addEventListener('scroll', closeCtx, true);

/* ---------- resizable side panels (widths in px, persisted) ---------- */
const LIM = { side: [180, 360], det: [240, 420] }, MIN_CENTER = 460, HANDLE = 6;
const clampN = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const savedW = (() => { try { return JSON.parse(localStorage.getItem('pzmm-widths')) || {}; } catch { return {}; } })();
const narrow = innerWidth <= 1320;
const widths = { side: savedW.side || (narrow ? 220 : 240), det: savedW.det || (narrow ? 260 : 288) };
function fit() { // keep both panels within their limits and always leave the centre at least MIN_CENTER wide
  const room = innerWidth - HANDLE * 2 - MIN_CENTER;
  widths.side = clampN(widths.side, LIM.side); widths.det = clampN(widths.det, LIM.det);
  if (widths.side + widths.det > room) widths.det = Math.max(LIM.det[0], room - widths.side);
  if (widths.side + widths.det > room) widths.side = Math.max(LIM.side[0], room - widths.det);
  $('app').style.setProperty('--side-w', widths.side + 'px');
  $('app').style.setProperty('--det-w', widths.det + 'px');
}
function bindHandle(id, key, dir) { // dir: +1 when the handle sits on the panel's right edge, -1 on its left edge
  const h = $(id), save = () => localStorage.setItem('pzmm-widths', JSON.stringify({ side: widths.side, det: widths.det }));
  h.tabIndex = 0; h.setAttribute('role', 'separator'); h.setAttribute('aria-orientation', 'vertical');
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag'); document.body.classList.add('resizing');
    const x0 = e.clientX, w0 = widths[key];
    const move = (ev) => { widths[key] = w0 + dir * (ev.clientX - x0); fit(); };
    const up = () => { h.removeEventListener('pointermove', move); h.classList.remove('drag'); document.body.classList.remove('resizing'); save(); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up, { once: true }); h.addEventListener('pointercancel', up, { once: true });
  });
  h.addEventListener('keydown', (e) => { // arrow keys for keyboard users
    const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0; if (!d) return;
    e.preventDefault(); widths[key] += d * dir * 12; fit(); save();
  });
}
bindHandle('rzL', 'side', 1); bindHandle('rzR', 'det', -1);
fit(); window.addEventListener('resize', fit);

api.on('state', (s) => { st = s; render(); });
api.on('log', (l) => { $('logline').textContent = l; });
api.on('conflict', async (d) => {
  const r = await modal('Mod already exists', `${d.where ? 'The mod' : 'A different version of'} <b>${esc(d.name)}</b> already exists in ${d.where ? 'instance “' + esc(d.where) + '”' : 'the Mods folder'}.<br><br><label><input type="checkbox" id="chkAll"> Apply to all remaining</label>`, [['Replace', 'replace', 'primary'], ['Keep both', 'both'], ['Skip', 'skip']], true);
  api.reply('conflict-reply', { action: r.val, all: r.all });
});
api.state().then((s) => { st = s; render(); showView(view); });
