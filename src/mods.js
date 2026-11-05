'use strict';
const fs = require('fs'), fsp = fs.promises, path = require('path'), crypto = require('crypto');
const { hint } = require('./instances');

const rm = (p) => fsp.rm(p, { recursive: true, force: true });

async function place(src, dest, replace, undo, olds) {
  if (replace && fs.existsSync(dest)) {
    const old = dest + '.pzmm-old-' + Date.now();
    await fsp.rename(dest, old);
    undo.push(() => fsp.rename(old, dest)); olds.push(old);
  }
  if (!src) return;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  undo.push(() => rm(dest));
  await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
}

async function transfer(m, name, replace, from, to, sIdx, dIdx, d) {
  const src = { lib: d.safeChild(path.join(from.libDir, m.wid), m.name), mod: d.safeChild(from.modsDir, m.name) };
  const dst = { lib: d.safeChild(path.join(to.libDir, m.wid), name), mod: d.safeChild(to.modsDir, name) };
  const has = { lib: fs.existsSync(src.lib), mod: fs.existsSync(src.mod) };
  if (!has.lib && !has.mod) throw new Error('no files found for this mod in the source instance (library copy and installed copy are both missing)');
  const entry = { ...m, name, id: m.wid + '/' + name };
  const nd = dIdx.filter((x) => x.id !== entry.id).concat(entry), ns = sIdx.filter((x) => x.id !== m.id);
  const undo = [], olds = [];
  try {
    for (const k of ['lib', 'mod']) await place(has[k] ? src[k] : null, dst[k], replace, undo, olds);
    undo.push(() => d.writeIdx(to.pid, to.id, dIdx));
    await d.writeIdx(to.pid, to.id, nd);
    await d.writeIdx(from.pid, from.id, ns);
  } catch (e) {
    for (const u of undo.reverse()) { try { await u(); } catch {} }
    await fsp.rmdir(path.dirname(dst.lib)).catch(() => {});
    throw e;
  }
  for (const o of olds) await rm(o).catch(() => {});
  const left = [];
  for (const k of ['lib', 'mod']) if (has[k]) await rm(src[k]).catch((e) => left.push(src[k] + ' (' + e.message + ')'));
  await fsp.rmdir(path.join(from.libDir, m.wid)).catch(() => {});
  return { nd, ns, left };
}

const VERSION_DIR = /^(\d+(\.\d+)*|common)$/i;
const LOCAL_WID = 'local';

async function scanInstalled(modsDir) {
  let es; try { es = await fsp.readdir(modsDir); } catch { return []; }
  const out = [];
  for (const name of es) {
    if (name.includes('.pzmm-')) continue;
    const dir = path.join(modsDir, name);
    let st; try { st = await fsp.stat(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let subs = []; try { subs = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && VERSION_DIR.test(e.name)).map((e) => path.join(dir, e.name)); } catch { continue; }
    let info = null;
    for (const d of [dir, ...subs]) { try { info = await fsp.readFile(path.join(d, 'mod.info'), 'utf8'); break; } catch {} }
    if (info === null) continue;
    const t = info.match(/^\s*name\s*=\s*(.+?)\s*$/im);
    out.push({ name, title: t ? t[1] : name, mtime: st.mtimeMs });
  }
  return out;
}

/** adds the mods found in the instance's Mods folder that the index does not know (installed by hand or imported); they are never written to the index */
async function withLocal(inst, idx) {
  const known = idx.filter((m) => m.status !== 'Failed' && m.name).map((m) => ({ n: m.name.toLowerCase(), p: (m.name + '_' + m.wid).toLowerCase() }));
  const tracked = (name) => { const n = name.toLowerCase(); return known.some((k) => k.n === n || n.startsWith(k.p)); };
  const extra = (await scanInstalled(inst.modsDir)).filter((f) => !tracked(f.name))
    .map((f) => ({ id: LOCAL_WID + '/' + f.name, wid: LOCAL_WID, name: f.name, title: f.title, status: 'Downloaded', downloadedAt: Math.round(f.mtime), selected: false, local: true }));
  return idx.concat(extra);
}
const withoutLocal = (idx) => idx.filter((m) => !m.local);

/** items: [{ from: instance(+pid), id }]; d: { readIdx, writeIdx, safeChild, ask(name, where) -> { action, all } } */
async function moveMods(items, to, d) {
  const idx = new Map(), results = []; let all = null;
  const get = async (i) => { if (!idx.has(i.id)) idx.set(i.id, await d.readIdx(i.pid, i.id)); return idx.get(i.id); };
  for (const { from, id } of items) {
    const res = { name: id, from: from.name };
    try {
      if (from.id === to.id) { results.push({ ...res, r: 'Skipped', msg: 'already in this instance' }); continue; }
      const sIdx = await get(from), dIdx = await get(to), m = sIdx.find((x) => x.id === id);
      if (!m) throw new Error('the mod is no longer in the source instance');
      res.name = m.name || m.title;
      if (m.status === 'Failed') throw new Error('this failed download has no files to move');
      let name = m.name, replace = false;
      const taken = (n) => dIdx.some((x) => x.id === m.wid + '/' + n) || fs.existsSync(d.safeChild(path.join(to.libDir, m.wid), n)) || fs.existsSync(d.safeChild(to.modsDir, n));
      if (taken(name)) {
        const c = all || await d.ask(m.name, to.name); if (c.all) all = c;
        if (c.action === 'skip') { results.push({ ...res, r: 'Skipped', msg: 'already exists in the destination' }); continue; }
        if (c.action === 'replace') replace = true;
        else { let i = 1, n = `${m.name}_${m.wid}`; while (taken(n)) n = `${m.name}_${m.wid}_${++i}`; name = n; }
      }
      const t = await transfer(m, name, replace, from, to, sIdx, dIdx, d);
      idx.set(to.id, t.nd); idx.set(from.id, t.ns);
      if (t.left.length) results.push({ ...res, r: 'Partial', msg: 'moved, but the old files could not be fully removed from the source - delete them manually: ' + t.left.join('; ') });
      else results.push({ ...res, r: replace ? 'Replaced' : name !== m.name ? 'Kept both' : 'Moved', msg: name !== m.name ? 'saved as "' + name + '"' : '' });
    } catch (e) { results.push({ ...res, r: 'Failed', msg: e.message + hint(e) + ' - nothing was changed' }); }
  }
  return results;
}

/** items: [{ inst(+pid), id }]; mode: lib | game | both */
async function deleteMods(items, mode, d) {
  const lib = mode !== 'game', game = mode !== 'lib', idx = new Map(), results = [];
  for (const { inst, id } of items) {
    const res = { name: id, from: inst.name };
    try {
      if (!idx.has(inst.id)) idx.set(inst.id, await d.readIdx(inst.pid, inst.id));
      const cur = idx.get(inst.id), m = cur.find((x) => x.id === id);
      if (!m) { results.push({ ...res, r: 'Skipped', msg: 'not in the list anymore' }); continue; }
      res.name = m.name || m.title;
      const files = m.status !== 'Failed';
      if (!lib && !files) { results.push({ ...res, r: 'Skipped', msg: 'a failed download has no files' }); continue; }
      if (m.local && !game) { results.push({ ...res, r: 'Skipped', msg: 'this mod only exists in the Mods folder (no library copy)' }); continue; }
      if (files && game) await rm(d.safeChild(inst.modsDir, m.name));
      if (files && lib) { await rm(d.safeChild(path.join(inst.libDir, m.wid), m.name)); await fsp.rmdir(path.join(inst.libDir, m.wid)).catch(() => {}); }
      if (lib) { const next = cur.filter((x) => x.id !== id); await d.writeIdx(inst.pid, inst.id, next); idx.set(inst.id, next); }
      results.push({ ...res, r: 'Removed' });
    } catch (e) { results.push({ ...res, r: 'Failed', msg: e.message + hint(e) }); }
  }
  return results;
}

/* ---------- mod poster (poster.png) ---------- */
// Build 42 keeps it in <Mod>/42/, Build 41 (and most older mods) keep it in the mod root; 'common' is checked too.
const POSTER_DIRS = ['42', '', 'common', '41'];
const POSTER_MAX = 2 * 1024 * 1024;
/** roots: mod folders in priority order; returns the path of the first usable poster.png, or null */
async function findPoster(roots) {
  for (const r of roots) for (const sub of POSTER_DIRS) {
    const f = path.join(r, sub, 'poster.png');
    try { const st = await fsp.stat(f); if (st.isFile() && st.size <= POSTER_MAX) return f; } catch {}
  }
  return null;
}

/* ---------- hashing, push into an instance's Mods folder ---------- */
async function hashDir(d) {
  const h = crypto.createHash('sha1');
  const walk = async (p, rel) => {
    const es = (await fsp.readdir(p, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of es) { const r = rel + '/' + e.name; h.update(r); if (e.isDirectory()) await walk(path.join(p, e.name), r); else h.update(await fsp.readFile(path.join(p, e.name))); }
  };
  await walk(d, ''); return h.digest('hex');
}

/**
 * Copies the library copies of `list` (index entries of `inst`) into inst.modsDir.
 * Nothing is overwritten without asking: d.ask(name) -> { action: 'replace' | 'both' | 'skip', all }.
 */
async function pushMods(list, inst, { ask, safeChild }) {
  const results = []; let all = null;
  for (const m of list) {
    try {
      const src = path.join(inst.libDir, m.wid, m.name);
      if (!fs.existsSync(src)) throw new Error('library copy is missing - re-download this mod');
      let dest = safeChild(inst.modsDir, m.name);
      if (fs.existsSync(dest)) {
        if ((await hashDir(src)) === (await hashDir(dest))) { results.push({ name: m.name, r: 'Already installed' }); continue; }
        let c = all; if (!c) { c = await ask(m.name); if (c.all) all = c; }
        if (c.action === 'skip') { results.push({ name: m.name, r: 'Skipped' }); continue; }
        if (c.action === 'replace') await rm(dest);
        else { let i = 1, n = `${m.name}_${m.wid}`; while (fs.existsSync(path.join(inst.modsDir, n))) n = `${m.name}_${m.wid}_${++i}`; dest = safeChild(inst.modsDir, n); }
      }
      await fsp.cp(src, dest, { recursive: true });
      results.push({ name: m.name, r: 'Installed' });
    } catch (e) { results.push({ name: m.name, r: 'Failed', msg: e.message + (e.code === 'EPERM' || e.code === 'EBUSY' ? ' (close Project Zomboid and retry)' : '') }); }
  }
  return results;
}

/* ---------- mod.info: identity and requirements ---------- */
/** reads `id=` and `require=` from the mod.info in `dir` (both optional) */
async function readModInfo(dir) {
  let text = '';
  try { text = await fsp.readFile(path.join(dir, 'mod.info'), 'utf8'); } catch { return { id: '', requires: [] }; }
  const get = (k) => { const m = text.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.+?)\\s*$', 'im')); return m ? m[1] : ''; };
  return { id: get('id'), requires: get('require').split(',').map((s) => s.trim()).filter(Boolean) };
}

/** requirements declared by downloaded mods that are not provided by any mod of this index */
function missingRequirements(idx) {
  const have = new Set();
  for (const m of idx) if (m.status !== 'Failed') { if (m.modId) have.add(m.modId.toLowerCase()); if (m.name) have.add(m.name.toLowerCase()); }
  const out = [], seen = new Set();
  for (const m of idx) if (m.status === 'Downloaded' && m.requires) for (const r of m.requires) {
    if (have.has(r.toLowerCase())) continue;
    const key = (m.title || m.name) + '\n' + r;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ mod: m.title || m.name, needs: r });
  }
  return out;
}

module.exports = { moveMods, deleteMods, withLocal, withoutLocal, findPoster, hashDir, pushMods, readModInfo, missingRequirements };
