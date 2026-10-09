const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path'), fs = require('fs'), fsp = fs.promises, cp = require('child_process');
const https = require('https'), crypto = require('crypto');
const instLib = require('./instances'), launcher = require('./launcher');
const APPID = '108600';
let win, S, mods = [], queue = [], running = false, installed = {}, proc = null, logs = [], launching = false;

const err = (m) => Object.assign(new Error(m), { human: true });
const wrap = (fn) => async (_event, ...a) => { try { return (await fn(...a)) || {}; } catch (e) { return { error: e.human ? e.message : 'Unexpected error: ' + e.message }; } };
const log = (l) => { logs.push(l); if (logs.length > 200) logs.shift(); win && win.webContents.send('log', l); };

/* ---------- settings ---------- */
const sfile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = () => ({
  steamcmd: '', steamExe: '', library: path.join(app.getPath('documents'), 'PZModManager'), active: 'b42',
  instances: {}, activeInstance: {},
  profiles: {
    b41: { name: 'Build 41', gameDir: '', exePath: '', modsDir: path.join(app.getPath('home'), 'Zomboid', 'mods') },
    b42: { name: 'Build 42', gameDir: '', exePath: '', modsDir: path.join(app.getPath('home'), 'Zomboid', 'mods') }
  }
});
function loadSettings() {
  S = defaults();
  try { const j = JSON.parse(fs.readFileSync(sfile(), 'utf8')); Object.assign(S, j, { profiles: Object.assign(S.profiles, j.profiles) }); } catch {}
  ensureInstances();
}
const saveSettings = () => { fs.mkdirSync(path.dirname(sfile()), { recursive: true }); fs.writeFileSync(sfile(), JSON.stringify(S, null, 2)); };

/* ---------- instances ---------- */
const rid = () => 'i' + crypto.randomBytes(5).toString('hex');
const mkInstance = (name, root) => ({ id: rid(), name, dir: root, libDir: path.join(root, 'library'), modsDir: path.join(root, 'mods') });
function ensureInstances() { // every profile always has >= 1 instance; the first one adopts the pre-instance library
  S.instances = S.instances && typeof S.instances === 'object' ? S.instances : {}; S.activeInstance = S.activeInstance || {};
  for (const pid of Object.keys(S.profiles)) {
    if (!Array.isArray(S.instances[pid]) || !S.instances[pid].length) {
      const root = path.join(S.library, 'Instances', pid, 'default');
      S.instances[pid] = [{ ...mkInstance('Default', root), libDir: path.join(S.library, pid) }];
    }
    if (!S.instances[pid].some((i) => i.id === S.activeInstance[pid])) S.activeInstance[pid] = S.instances[pid][0].id;
  }
}
const getInst = (pid = S.active, iid) => {
  const l = S.instances[pid];
  if (iid) { const f = l.find((i) => i.id === iid); if (!f) throw err('That instance no longer exists.'); return f; }
  return l.find((i) => i.id === S.activeInstance[pid]) || l[0];
};
const isCur = (j) => j.pid === S.active && j.iid === getInst().id;
function touchInstance(i) { // create folders + marker (the marker lets us recognise our own folders before ever deleting anything)
  try {
    fs.mkdirSync(i.modsDir, { recursive: true }); fs.mkdirSync(i.libDir, { recursive: true });
    try { fs.writeFileSync(path.join(i.dir, '.pzmm-instance.json'), JSON.stringify({ app: 'pz-mod-manager', id: i.id, name: i.name }), { flag: 'wx' }); } catch {}
  } catch (e) { throw err('Cannot create the instance folders under "' + i.dir + '": ' + e.message); }
}
const tidy = (n) => String(n ?? '').replace(/\s+/g, ' ').trim();

/* ---------- library index (per profile + instance) ---------- */
const libDir = (pid = S.active, iid) => getInst(pid, iid).libDir;
const readIdx = async (pid, iid) => { try { return JSON.parse(await fsp.readFile(path.join(libDir(pid, iid), 'index.json'), 'utf8')); } catch { return []; } };
const writeIdx = async (pid, iid, arr) => { await fsp.mkdir(libDir(pid, iid), { recursive: true }); await fsp.writeFile(path.join(libDir(pid, iid), 'index.json'), JSON.stringify(arr, null, 1)); };
const saveMods = () => writeIdx(S.active, undefined, mods);
const safeChild = (base, name) => {
  if (!base || !name || /[\\/]/.test(name) || name === '.' || name === '..') throw err('Refusing unsafe path operation on "' + name + '".');
  return path.join(base, name);
};

function exeFor(pid) {
  const p = S.profiles[pid]; if (p.exePath) return p.exePath;
  if (p.gameDir) { const e = path.join(p.gameDir, 'ProjectZomboid64.exe'); if (fs.existsSync(e)) return e; }
  return '';
}
function pub() {
  const ci = getInst(), p = S.profiles[S.active], exe = exeFor(S.active), li = instLib.linkInfo(p.modsDir || '');
  return {
    settings: S, busy: running, queue, logs: logs.slice(-40), steam: findSteamcmd(), launching,
    instance: { id: ci.id, name: ci.name, dir: ci.dir, modsDir: ci.modsDir, linked: instLib.isLinkedTo(p.modsDir, ci.modsDir), linkKind: li.kind },
    exe, exeExists: !!exe && fs.existsSync(exe),
    mods: mods.map((m) => ({ ...m, installed: !!installed[m.id], update: !!(m.remoteUpdated && m.remoteUpdated * 1000 > m.downloadedAt && m.status !== 'Failed') }))
  };
}
const send = () => win && win.webContents.send('state', pub());

/* ---------- helpers ---------- */
function findSteamcmd() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  const c = [S.steamcmd, path.join(S.library, 'steamcmd'), 'C:\\steamcmd', 'C:\\SteamCMD', path.join(app.getPath('home'), 'steamcmd'), ...pf.map((p) => path.join(p, 'SteamCMD'))].filter(Boolean);
  for (const x of c) {
    try {
      if (/steamcmd\.exe$/i.test(x) && fs.existsSync(x)) return x;
      const e = path.join(x, 'steamcmd.exe'); if (fs.existsSync(e)) return e;
    } catch {}
  }
  return '';
}
async function hashDir(d) {
  const h = crypto.createHash('sha1');
  const walk = async (p, rel) => {
    const es = (await fsp.readdir(p, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of es) { const r = rel + '/' + e.name; h.update(r); if (e.isDirectory()) await walk(path.join(p, e.name), r); else h.update(await fsp.readFile(path.join(p, e.name))); }
  };
  await walk(d, ''); return h.digest('hex');
}
async function dirSize(d) { let t = 0; try { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); t += e.isDirectory() ? await dirSize(p) : (await fsp.stat(p)).size; } } catch {} return t; }
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

async function findMods(root) {
  const dirs = [];
  const walk = async (d, depth) => {
    if (depth > 10) return;
    let es; try { es = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    if (es.some((e) => e.isFile() && e.name.toLowerCase() === 'mod.info')) dirs.push(d);
    for (const e of es) if (e.isDirectory()) await walk(path.join(d, e.name), depth + 1);
  };
  await walk(root, 0);
  const roots = new Map();
  for (const d of dirs) { // Build 42: <Mod>/42/mod.info and <Mod>/common -> mod root is the parent
    let r = d; if (d !== root && /^(\d+(\.\d+)*|common)$/i.test(path.basename(d))) r = path.dirname(d);
    if (!roots.has(r)) roots.set(r, d);
  }
  const out = [];
  for (const [r, d] of roots) {
    let title = path.basename(r);
    try { const m = (await fsp.readFile(path.join(d, 'mod.info'), 'utf8')).match(/^\s*name\s*=\s*(.+?)\s*$/im); if (m) title = m[1]; } catch {}
    out.push({ dir: r, name: path.basename(r), title });
  }
  return out;
}
function details(ids) {
  return new Promise((res, rej) => {
    const body = ids.map((id, i) => `publishedfileids[${i}]=${id}`).concat('itemcount=' + ids.length).join('&');
    const rq = https.request({ host: 'api.steampowered.com', path: '/ISteamRemoteStorage/GetPublishedFileDetails/v1/', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', () => { try { res(JSON.parse(b).response.publishedfiledetails); } catch { rej(new Error('Steam returned an unexpected response (the Workshop API may have changed).')); } });
    });
    rq.on('error', rej); rq.setTimeout(15000, () => rq.destroy(new Error('Steam did not respond (network problem?).'))); rq.end(body);
  });
}
const parseId = (s) => { s = String(s || '').trim(); let m = s.match(/^\d{5,}$/) || s.match(/[?&]id=(\d{5,})/); return m ? (m[1] || m[0]) : null; };

/* ---------- SteamCMD ---------- */
function steamErr(out) {
  if (/No subscription|Access Denied/i.test(out)) return 'Steam refused anonymous access to this item. It may be private, friends-only or removed.';
  if (/File Not Found|Item not found/i.test(out)) return 'Steam says this Workshop item does not exist anymore.';
  if (/Timeout|Unable to connect|No Connection|Failed to connect/i.test(out)) return 'Network problem while talking to Steam. Check your internet connection / firewall and retry.';
  if (/disk write failure|not enough disk|low disk/i.test(out)) return 'SteamCMD could not write to disk. Free some space or check folder permissions.';
  if (/ERROR!\s*Download item.*failed/i.test(out)) return 'SteamCMD failed to download the item. Retry; if it keeps failing use Clear Cache first.';
  return '';
}
function runSteam(exe, wid, onLine) {
  return new Promise((res) => {
    const p = cp.spawn(exe, ['+login', 'anonymous', '+workshop_download_item', APPID, wid, '+quit'], { cwd: path.dirname(exe) });
    proc = p; let out = '';
    const h = (d) => { const t = d.toString(); out += t; t.split(/\r?\n/).filter(Boolean).forEach(onLine); };
    p.stdout.on('data', h); p.stderr.on('data', h);
    p.on('error', (e) => res({ out: out + e.message, code: -1, spawnError: e }));
    p.on('close', (code) => { proc = null; res({ out, code }); });
  });
}
async function runJob(j) {
  const exe = findSteamcmd();
  if (!exe) throw err('SteamCMD was not found. Open Settings to select it or let the app install it.');
  try { touchInstance(getInst(j.pid, j.iid)); } catch { throw err('Cannot write to the instance folder. Pick another one in Settings or create a new instance elsewhere.'); }
  j.status = 'Downloading'; send();
  let title = j.wid, upd = 0;
  try {
    const [d] = await details([j.wid]);
    if (d.result !== 1) throw err(`Workshop item ${j.wid} does not exist or is private. Check the ID/URL.`);
    title = d.title; upd = d.time_updated;
  } catch (e) { if (e.human) throw e; log('Could not query Steam Web API: ' + e.message); }
  j.title = title;
  const src = path.join(path.dirname(exe), 'steamapps', 'workshop', 'content', APPID, j.wid);
  let r;
  for (let attempt = 1; attempt <= 2; attempt++) {
    r = await runSteam(exe, j.wid, (l) => { j.line = l.slice(0, 160); log(l); send(); });
    if (r.spawnError) throw err('SteamCMD could not be started (' + r.spawnError.code + '). Check the SteamCMD path and permissions.');
    if (/Success\. Downloaded item/i.test(r.out) || steamErr(r.out)) break;
    log('SteamCMD did not report success (exit ' + r.code + '), retrying once (first run often self-updates)...');
  }
  if (j.cancelled) throw err('Download cancelled.');
  if (!/Success\. Downloaded item/i.test(r.out)) throw err(steamErr(r.out) || `SteamCMD finished without downloading the item (exit code ${r.code}). Retry, or use Clear Cache.`);
  j.status = 'Processing'; send();
  if (!fs.existsSync(src)) throw err('SteamCMD reported success but the downloaded files are missing (' + src + ').');
  const found = await findMods(src);
  if (!found.length) throw err('The download contains no valid Project Zomboid mod (no mod.info found). It may be a map/collection or a partial download.');
  const idx = (await readIdx(j.pid, j.iid)).filter((m) => m.wid !== j.wid);
  const base = path.join(libDir(j.pid, j.iid), j.wid);
  await fsp.rm(base, { recursive: true, force: true });
  for (const f of found) {
    await fsp.cp(f.dir, safeChild(base, f.name), { recursive: true });
    idx.push({ id: j.wid + '/' + f.name, wid: j.wid, name: f.name, title: f.title, workshopTitle: title, status: 'Downloaded', downloadedAt: Date.now(), remoteUpdated: upd, selected: true });
  }
  await writeIdx(j.pid, j.iid, idx); if (isCur(j)) mods = idx;
  j.msg = found.length > 1 ? `${found.length} mods found - untick the ones you don't want before pushing.` : 'OK';
}
async function processQueue() {
  if (running) return; running = true; send();
  while (true) {
    const j = queue.find((q) => q.status === 'Waiting'); if (!j) break;
    try { await runJob(j); j.status = 'Completed'; }
    catch (e) {
      j.status = 'Failed'; j.msg = e.human ? e.message : 'Unexpected error: ' + e.message; log('FAILED ' + j.wid + ': ' + j.msg);
      const idx = (await readIdx(j.pid, j.iid)).filter((m) => m.wid !== j.wid);
      idx.push({ id: j.wid + '/_failed', wid: j.wid, name: '', title: j.title || j.wid, status: 'Failed', downloadedAt: Date.now(), error: j.msg, selected: false });
      await writeIdx(j.pid, j.iid, idx); if (isCur(j)) mods = idx;
    }
    await refreshInstalled(); send();
  }
  running = false; send();
}
async function refreshInstalled() {
  const ci = getInst(), res = {};
  for (const m of mods.slice()) {
    if (m.status !== 'Downloaded') continue;
    const d = path.join(ci.modsDir, m.name);
    try { if (fs.existsSync(d) && (await hashDir(d)) === (await hashDir(path.join(ci.libDir, m.wid, m.name)))) res[m.id] = true; } catch {}
  }
  if (getInst().id === ci.id) installed = res; // ignore the result if the user switched instance meanwhile
  send();
}

/* ---------- build detection ---------- */
function detectBuild(g) {
  let major = null;
  for (const f of ['media/version.txt', 'version.txt']) {
    try { const m = fs.readFileSync(path.join(g, f), 'utf8').match(/(\d+)\.\d+/); if (m) { major = m[1]; break; } } catch {}
  }
  if (!major) { try { const acf = fs.readFileSync(path.join(g, '..', '..', 'appmanifest_108600.acf'), 'utf8'); if (/"BetaKey"\s+"unstable"/i.test(acf)) major = '42'; } catch {} }
  const id = major && 'b' + major; return id && S.profiles[id] ? id : null;
}

/* ---------- IPC ---------- */
function ask(ch, data) { return new Promise((res) => { ipcMain.once(ch + '-reply', (_e, v) => res(v)); win.webContents.send(ch, data); }); }

ipcMain.handle('state', () => pub());
ipcMain.handle('setActive', wrap(async (pid) => { if (!S.profiles[pid]) throw err('Unknown profile.'); S.active = pid; saveSettings(); mods = await readIdx(pid); installed = {}; send(); refreshInstalled(); }));
ipcMain.handle('pickGame', wrap(async (forcePid) => {
  const r = await dialog.showOpenDialog(win, { title: 'Select the Project Zomboid game folder', properties: ['openDirectory'] });
  if (r.canceled) return;
  const g = r.filePaths[0];
  if (!['ProjectZomboid64.exe', 'ProjectZomboid32.exe'].some((f) => fs.existsSync(path.join(g, f))) && !fs.existsSync(path.join(g, 'media')))
    throw err('This does not look like a Project Zomboid folder (ProjectZomboid64.exe / media not found). Select the folder that contains the game, e.g. ...\\steamapps\\common\\ProjectZomboid.');
  const detected = detectBuild(g); const pid = forcePid || detected || S.active;
  S.profiles[pid].gameDir = g; S.active = pid; saveSettings(); mods = await readIdx(pid); installed = {}; send(); refreshInstalled();
  return { info: forcePid ? `Folder assigned to ${S.profiles[pid].name}.` : detected ? `Detected ${S.profiles[pid].name} - profile selected automatically.` : `Could not detect the build automatically; folder assigned to ${S.profiles[pid].name}. Use the version dropdown if that is wrong.` };
}));
ipcMain.handle('pickMods', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select the folder Project Zomboid reads mods from (usually ...\\Zomboid\\mods). The app manages it as a link to the selected instance.', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return;
  const chosen = r.filePaths[0];
  for (const i of Object.values(S.instances).flat()) if ([i.dir, i.libDir, i.modsDir].some((q) => instLib.inside(chosen, q) || instLib.inside(q, chosen))) throw err('That folder overlaps with the instance "' + i.name + '". Choose the game\'s own Mods folder (usually ...\\Zomboid\\mods).');
  try { await fsp.access(chosen, fs.constants.W_OK); } catch { throw err('That folder is not writable. Choose another folder or fix its permissions.'); }
  S.profiles[S.active].modsDir = r.filePaths[0]; saveSettings(); send(); refreshInstalled();
}));
ipcMain.handle('pickSteamcmd', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select steamcmd.exe or its folder', properties: ['openFile', 'openDirectory'], filters: [{ name: 'steamcmd', extensions: ['exe'] }] });
  if (r.canceled) return;
  const p = r.filePaths[0];
  const ok = /steamcmd\.exe$/i.test(p) || fs.existsSync(path.join(p, 'steamcmd.exe'));
  if (!ok) throw err('steamcmd.exe was not found there.');
  S.steamcmd = p; saveSettings(); send();
}));
ipcMain.handle('pickLibrary', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select the Mod Manager library folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return;
  S.library = r.filePaths[0]; saveSettings(); mods = await readIdx(S.active); installed = {}; send(); refreshInstalled();
  return { info: 'Library folder changed. Existing instances keep their folders; new instances are created in the new location.' };
}));
ipcMain.handle('installSteamcmd', wrap(async () => {
  const dir = path.join(S.library, 'steamcmd'); await fsp.mkdir(dir, { recursive: true });
  const zip = path.join(dir, 'steamcmd.zip'); log('Downloading SteamCMD...');
  const dl = (u) => new Promise((res, rej) => https.get(u, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return res(dl(r.headers.location));
    if (r.statusCode !== 200) return rej(err('Could not download SteamCMD (HTTP ' + r.statusCode + ').'));
    const f = fs.createWriteStream(zip); r.pipe(f); f.on('finish', () => f.close(res));
  }).on('error', () => rej(err('Network error while downloading SteamCMD.'))));
  await dl('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip');
  await new Promise((res, rej) => cp.execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zip}' -DestinationPath '${dir}'`], (e) => (e ? rej(err('Could not extract SteamCMD: ' + e.message)) : res())));
  S.steamcmd = dir; saveSettings(); log('Running SteamCMD once so it can update itself...');
  await new Promise((res) => { const p = cp.spawn(path.join(dir, 'steamcmd.exe'), ['+quit'], { cwd: dir }); p.stdout.on('data', (d) => log(d.toString().trim())); p.on('close', res); p.on('error', res); });
  send(); return { info: 'SteamCMD installed.' };
}));
ipcMain.handle('download', wrap(async (input) => {
  const wid = parseId(input);
  if (!wid) throw err('That is not a valid Workshop URL or ID. Paste a link like https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890 or just the number.');
  const ci = getInst();
  if (queue.some((q) => q.wid === wid && q.pid === S.active && q.iid === ci.id && ['Waiting', 'Downloading', 'Processing'].includes(q.status))) throw err('This item is already in the queue.');
  queue = queue.filter((q) => !(q.wid === wid && q.pid === S.active && q.iid === ci.id)); queue.push({ wid, pid: S.active, iid: ci.id, iname: ci.name, title: wid, status: 'Waiting' });
  send(); processQueue(); return { info: `Added to download queue for instance "${ci.name}".` };
}));
ipcMain.handle('cancel', wrap(async () => { queue.forEach((q) => { if (q.status === 'Waiting') { q.status = 'Failed'; q.msg = 'Cancelled'; } if (q.status === 'Downloading') q.cancelled = true; }); if (proc) proc.kill(); send(); }));
ipcMain.handle('select', wrap(async (id, v) => { const m = mods.find((x) => x.id === id); if (m) { m.selected = v; await saveMods(); } }));
ipcMain.handle('checkUpdates', wrap(async () => {
  const ids = [...new Set(mods.filter((m) => m.status !== 'Failed').map((m) => m.wid))]; if (!ids.length) return { info: 'No mods to check.' };
  let d; try { d = await details(ids); } catch (e) { throw err('Could not check updates: ' + e.message); }
  for (const x of d) if (x.result === 1) mods.filter((m) => m.wid === String(x.publishedfileid)).forEach((m) => (m.remoteUpdated = x.time_updated));
  await saveMods(); send();
  const n = new Set(mods.filter((m) => m.remoteUpdated * 1000 > m.downloadedAt).map((m) => m.wid)).size;
  return { info: n ? `${n} Workshop item(s) have updates. Re-download them to update.` : 'Everything is up to date.' };
}));
ipcMain.handle('push', wrap(async () => {
  const p = S.profiles[S.active], ci = getInst(), dir = ci.modsDir;
  try { touchInstance(ci); await fsp.access(dir, fs.constants.W_OK); } catch { throw err('The instance Mods folder is invalid or not writable: ' + dir); }
  const todo = mods.filter((m) => m.selected && m.status === 'Downloaded');
  if (!todo.length) throw err('Nothing to push. Download a mod first and make sure it is ticked.');
  const results = []; let all = null;
  for (const m of todo) {
    try {
      const src = path.join(ci.libDir, m.wid, m.name);
      if (!fs.existsSync(src)) throw new Error('library copy is missing - re-download this mod');
      let dest = safeChild(dir, m.name);
      if (fs.existsSync(dest)) {
        if ((await hashDir(src)) === (await hashDir(dest))) { results.push({ name: m.name, r: 'Already installed' }); continue; }
        let c = all; if (!c) { c = await ask('conflict', { name: m.name }); if (c.all) all = c; }
        if (c.action === 'skip') { results.push({ name: m.name, r: 'Skipped' }); continue; }
        if (c.action === 'replace') await fsp.rm(dest, { recursive: true, force: true });
        else { let i = 1, n = `${m.name}_${m.wid}`; while (fs.existsSync(path.join(dir, n))) n = `${m.name}_${m.wid}_${++i}`; dest = safeChild(dir, n); }
      }
      await fsp.cp(src, dest, { recursive: true });
      results.push({ name: m.name, r: 'Installed' });
    } catch (e) { results.push({ name: m.name, r: 'Failed', msg: e.message + (e.code === 'EPERM' || e.code === 'EBUSY' ? ' (close Project Zomboid and retry)' : '') }); }
  }
  await refreshInstalled();
  const note = instLib.isLinkedTo(p.modsDir, dir) ? `The game is already pointed at "${ci.name}", so it sees these mods now.` : `Pushed into the instance "${ci.name}". The game will use them once this instance is activated - click "Launch Project Zomboid" or "Activate now".`;
  return { results, note, instance: ci.name };
}));
ipcMain.handle('remove', wrap(async (ids) => {
  const sel = mods.filter((m) => ids.includes(m.id)); if (!sel.length) throw err('Tick the mods you want to remove first.');
  const ci = getInst(), mdir = ci.modsDir;
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Remove from library', 'Remove from instance Mods folder', 'Remove from both', 'Cancel'], defaultId: 3, cancelId: 3, title: 'Remove mods', message: `Remove ${sel.length} mod(s) from instance "${ci.name}"?`, detail: sel.map((m) => '• ' + (m.name || m.title)).join('\n') + '\n\nThis cannot be undone.' });
  if (r.response === 3) return;
  const lib = r.response !== 1, game = r.response !== 0, errors = [];
  for (const m of sel) {
    try {
      if (game && m.status !== 'Failed') await fsp.rm(safeChild(mdir, m.name), { recursive: true, force: true });
      if (lib) { if (m.status !== 'Failed') await fsp.rm(safeChild(path.join(ci.libDir, m.wid), m.name), { recursive: true, force: true }); mods = mods.filter((x) => x.id !== m.id); }
    } catch (e) { errors.push(`${m.name}: ${e.message}`); }
  }
  await saveMods(); await refreshInstalled();
  if (errors.length) throw err('Some removals failed:\n' + errors.join('\n'));
}));
ipcMain.handle('clearCache', wrap(async () => {
  if (running) throw err('A download is running. Wait for it to finish first.');
  const exe = findSteamcmd(); if (!exe) throw err('SteamCMD was not found, so there is no cache to clear.');
  const dir = path.dirname(exe);
  const protectedPaths = [S.library, ...Object.values(S.profiles).flatMap((x) => [x.gameDir, x.modsDir]), ...Object.values(S.instances).flat().flatMap((i) => [i.dir, i.libDir, i.modsDir])].filter(Boolean);
  const targets = ['steamapps', 'userdata'].map((n) => path.join(dir, n)).filter((t) => fs.existsSync(t));
  for (const t of targets) for (const pp of protectedPaths) if (inside(pp, t)) throw err(`Refusing to clear: "${pp}" is inside ${t}. Move your library/game/mods folder out of the SteamCMD folder first.`);
  if (!targets.length) return { info: 'SteamCMD cache is already empty.' };
  const sizes = []; for (const t of targets) sizes.push(`• ${t}  (${mb(await dirSize(t))})`);
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Clear cache', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Clear Cache', message: 'Delete the SteamCMD cache?', detail: 'These folders will be deleted:\n' + sizes.join('\n') + '\n\nYour Mod Manager library, mods already in Project Zomboid and steamcmd.exe itself are NOT touched. SteamCMD recreates these folders when needed.' });
  if (r.response !== 0) return;
  for (const t of targets) await fsp.rm(t, { recursive: true, force: true }).catch((e) => { throw err('Could not delete ' + t + ': ' + e.message); });
  return { info: 'SteamCMD cache cleared.' };
}));

/* ---------- instances & launching ---------- */
const nameOk = (pid, name, selfId) => {
  name = tidy(name);
  if (!name) throw err('Please enter a name for the instance.');
  if (name.length > 40) throw err('Instance names can be at most 40 characters.');
  if (/[\u0000-\u001f<>]/.test(name)) throw err('The name contains characters that are not allowed.');
  if (S.instances[pid].some((i) => i.id !== selfId && i.name.toLowerCase() === name.toLowerCase())) throw err(`An instance named "${name}" already exists for ${S.profiles[pid].name}.`);
  return name;
};
function rootOk(dir) { // a storage folder may never overlap the game, the game's Mods link, or another instance
  if (!path.isAbsolute(dir)) throw err('The storage folder must be a full path, e.g. D:\\PZ\\Instance1.');
  dir = path.resolve(dir);
  if (path.parse(dir).root === dir || instLib.samePath(dir, app.getPath('home'))) throw err('Choose a dedicated folder - not a drive root or your user folder.');
  for (const [pid, p] of Object.entries(S.profiles)) {
    for (const g of [p.gameDir, p.modsDir]) if (g && (instLib.inside(dir, g) || instLib.inside(g, dir))) throw err(`The storage folder must not overlap with "${g}" (the game / its Mods folder).`);
    for (const o of S.instances[pid]) for (const q of [o.dir, o.libDir, o.modsDir]) if (instLib.inside(dir, q) || instLib.inside(q, dir)) throw err(`The storage folder overlaps with the instance "${o.name}" (${o.dir}).`);
  }
  return dir;
}
const modLinks = () => [...new Set(Object.values(S.profiles).map((p) => p.modsDir).filter(Boolean))];

async function prepareInstance(pid) { // make the game's Mods folder point at the selected instance
  const p = S.profiles[pid], ci = getInst(pid);
  if (!p.modsDir) throw err(`No Mods folder is set for ${p.name}. Set it in the left panel (usually ...\\Zomboid\\mods).`);
  const g = await launcher.anyRunning(launcher.GAME_PROCS);
  if (g && !instLib.isLinkedTo(p.modsDir, ci.modsDir)) throw err(`${g} is running. Close the game first - the Mods folder cannot be switched safely while it is open.`);
  touchInstance(ci);
  return instLib.activate(p.modsDir, ci.modsDir, {
    log,
    isManaged: (t) => Object.values(S.instances).flat().some((i) => instLib.samePath(t, i.modsDir)),
    confirmAdopt: async ({ link, names }) => {
      const r = await dialog.showMessageBox(win, {
        type: 'question', buttons: [`Import into "${ci.name}" and continue`, 'Keep as backup and continue', 'Cancel'], defaultId: 0, cancelId: 2, title: 'Existing Mods folder found',
        message: 'Your Project Zomboid Mods folder already contains files.',
        detail: `To switch between instances, this app turns\n${link}\ninto a link to the selected instance's folder.\n\nNothing is deleted: the current folder is renamed to "${path.basename(link)}.pzmm-backup-<date>" next to it.\n\n"Import" additionally copies its ${names.length} item(s) into the instance "${ci.name}" so they stay available:\n${names.slice(0, 8).map((n) => '• ' + n).join('\n')}${names.length > 8 ? '\n• ...' : ''}`
      });
      return ['import', 'backup', 'cancel'][r.response];
    }
  });
}

ipcMain.handle('instCreate', wrap(async ({ name, dir } = {}) => {
  const pid = S.active; name = nameOk(pid, name);
  let root;
  if (tidy(dir)) root = rootOk(tidy(dir));
  else { const b = path.join(S.library, 'Instances', pid, instLib.slugify(name)); let r = b, n = 1; while (fs.existsSync(r)) r = b + '-' + (++n); root = rootOk(r); }
  const i = mkInstance(name, root); touchInstance(i);
  S.instances[pid].push(i); S.activeInstance[pid] = i.id; saveSettings();
  mods = await readIdx(pid); installed = {}; send(); refreshInstalled();
  return { info: `Instance "${name}" created and selected.` };
}));
ipcMain.handle('instRename', wrap(async (id, name) => {
  const i = getInst(S.active, id); i.name = nameOk(S.active, name, id); saveSettings();
  try { fs.writeFileSync(path.join(i.dir, '.pzmm-instance.json'), JSON.stringify({ app: 'pz-mod-manager', id: i.id, name: i.name })); } catch {}
  send(); return { info: `Renamed to "${i.name}".` };
}));
ipcMain.handle('instSelect', wrap(async (id) => {
  const i = getInst(S.active, id); S.activeInstance[S.active] = i.id; saveSettings();
  mods = await readIdx(S.active); installed = {}; send(); refreshInstalled();
  return { info: `Instance "${i.name}" selected. It is activated for the game when you launch (or press "Activate now").` };
}));
ipcMain.handle('instActivate', wrap(async () => {
  if (launching) throw err('A launch is in progress.');
  launching = true; send();
  try {
    const ci = getInst(), a = await prepareInstance(S.active);
    return { info: a.already ? `"${ci.name}" is already active in the game.` : `"${ci.name}" is now the active instance.${a.backup ? ' Your previous Mods folder was kept as ' + a.backup : ''}` };
  } finally { launching = false; send(); }
}));
ipcMain.handle('instDelete', wrap(async (id) => {
  const pid = S.active, i = getInst(pid, id), L = S.instances[pid];
  if (L.length <= 1) throw err('Each version profile needs at least one instance. Create another one before deleting this one.');
  if (queue.some((q) => q.iid === i.id && ['Waiting', 'Downloading', 'Processing'].includes(q.status))) throw err('A download for this instance is still running. Wait for it or cancel it first.');
  if (modLinks().some((l) => instLib.isLinkedTo(l, i.modsDir))) throw err(`"${i.name}" is the instance currently active in the game's Mods folder. Activate or launch another instance first.`);
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Remove from app only (keep files)', 'Delete instance and its files', 'Cancel'], defaultId: 2, cancelId: 2, title: 'Delete instance',
    message: `Delete the instance "${i.name}"?`, detail: `Mods folder:\n${i.modsDir}\nDownload library:\n${i.libDir}\n\n"Delete ... files" permanently removes those two folders. "Keep files" only forgets the instance in this app. Other instances are never touched.` });
  if (r.response === 2) return;
  if (r.response === 1) {
    let mk = null; try { mk = JSON.parse(fs.readFileSync(path.join(i.dir, '.pzmm-instance.json'), 'utf8')); } catch {}
    if (!mk || mk.id !== i.id) throw err('This folder was not created by this app (marker file missing), so its files will not be deleted automatically. Use "Remove from app only" and delete it yourself.');
    const prot = [app.getPath('home'), S.library, ...Object.values(S.profiles).flatMap((p) => [p.gameDir, p.modsDir]), ...Object.values(S.instances).flat().filter((o) => o.id !== i.id).flatMap((o) => [o.dir, o.libDir, o.modsDir])].filter(Boolean);
    for (const t of [i.modsDir, i.libDir]) for (const q of prot) if (instLib.inside(q, t)) throw err(`Refusing to delete "${t}" because it contains "${q}".`);
    for (const t of [i.modsDir, i.libDir]) await fsp.rm(t, { recursive: true, force: true }).catch((e) => { throw err('Could not delete ' + t + ': ' + e.message); });
    await fsp.rm(path.join(i.dir, '.pzmm-instance.json'), { force: true }); await fsp.rmdir(i.dir).catch(() => {});
  }
  S.instances[pid] = L.filter((x) => x.id !== i.id);
  if (S.activeInstance[pid] === i.id) S.activeInstance[pid] = S.instances[pid][0].id;
  saveSettings(); mods = await readIdx(pid); installed = {}; send(); refreshInstalled();
  return { info: r.response === 1 ? `Instance "${i.name}" and its files were deleted.` : `Instance "${i.name}" removed from the app (files kept).` };
}));
ipcMain.handle('pickFolder', wrap(async (title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Select a folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? {} : { path: r.filePaths[0] };
}));
ipcMain.handle('pickExe', wrap(async () => {
  const p = S.profiles[S.active];
  const r = await dialog.showOpenDialog(win, { title: 'Select ProjectZomboid64.exe', defaultPath: exeFor(S.active) || p.gameDir || undefined, properties: ['openFile'], filters: [{ name: 'Executable', extensions: ['exe'] }] });
  if (r.canceled) return;
  const f = r.filePaths[0];
  if (!/\.exe$/i.test(f)) throw err('Please select an .exe file (normally ProjectZomboid64.exe in the game folder).');
  p.exePath = f; if (!p.gameDir) p.gameDir = path.dirname(f); saveSettings(); send();
  return { info: 'Game executable saved: ' + f };
}));
ipcMain.handle('pickSteamExe', wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Select steam.exe', properties: ['openFile'], filters: [{ name: 'steam.exe', extensions: ['exe'] }] });
  if (r.canceled) return;
  if (!/^steam\.exe$/i.test(path.basename(r.filePaths[0]))) throw err('Please select steam.exe (usually C:\\Program Files (x86)\\Steam\\steam.exe).');
  S.steamExe = r.filePaths[0]; saveSettings(); send(); return { info: 'Steam location saved.' };
}));
ipcMain.handle('steamInfo', wrap(async () => ({ path: await launcher.findSteamExe({ configured: S.steamExe, gameDir: S.profiles[S.active].gameDir }) })));

ipcMain.handle('launch', wrap(async () => {
  if (launching) throw err('A launch is already in progress.');
  launching = true; send();
  try {
    const pid = S.active, p = S.profiles[pid], ci = getInst(pid), exe = exeFor(pid);
    if (!exe) throw err('ProjectZomboid64.exe is not set. Click "Select executable…" in the left panel (it is in the game folder, e.g. ...\\steamapps\\common\\ProjectZomboid).');
    let isFile = false; try { isFile = fs.statSync(exe).isFile(); } catch {}
    if (!isFile) throw err('The game executable was not found:\n' + exe + '\nSelect it again with "Select executable…".');
    const g = await launcher.anyRunning([path.basename(exe), ...launcher.GAME_PROCS]);
    if (g) throw err(`Project Zomboid is already running (${g}). Close it first so the selected instance can be activated safely.`);
    const steamExe = await launcher.findSteamExe({ configured: S.steamExe, gameDir: p.gameDir || path.dirname(exe) });
    if (!steamExe && !(await launcher.isProcessRunning(launcher.STEAM_PROC))) throw err('Steam is not running and steam.exe could not be found. Start Steam yourself, or choose steam.exe in Settings.');
    log(`Preparing instance "${ci.name}"...`);
    const a = await prepareInstance(pid); send();
    log(a.already ? `Instance "${ci.name}" was already active.` : `Instance "${ci.name}" activated.`);
    const res = await launcher.launchSequence({ exe, steamExe, log });
    log(`Launched Project Zomboid with instance "${ci.name}".`);
    return { info: `Launched Project Zomboid with instance "${ci.name}".${res.steamStarted ? ' Steam was started first.' : ''}${a.backup ? ' Your previous Mods folder was kept as ' + a.backup + '.' : ''}${res.note ? ' ' + res.note : ''}` };
  } finally { launching = false; send(); }
}));

/* ---------- window ---------- */
app.whenReady().then(async () => {
  loadSettings(); saveSettings(); mods = await readIdx(S.active);
  win = new BrowserWindow({ width: 1360, height: 840, minWidth: 1100, minHeight: 650, backgroundColor: '#1b1d23', title: 'Project Zomboid Mod Manager', webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true, contextIsolation: true } });
  win.removeMenu(); win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => { send(); refreshInstalled(); });
});
app.on('window-all-closed', () => { if (proc) proc.kill(); app.quit(); });
