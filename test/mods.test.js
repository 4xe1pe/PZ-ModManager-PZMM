const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const M = require('../src/mods');

const safeChild = (base, name) => {
  if (!base || !name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('unsafe ' + name);
  return path.join(base, name);
};
const put = (f, c = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const read = (f) => fs.readFileSync(f, 'utf8');

function world(ask) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pzmm-mods-')), insts = {}, w = { fail: null, asked: [] };
  for (const id of ['ia', 'ib']) { const dir = path.join(root, id); insts[id] = { id, name: id.toUpperCase(), pid: 'b42', dir, libDir: path.join(dir, 'library'), modsDir: path.join(dir, 'mods') }; fs.mkdirSync(insts[id].libDir, { recursive: true }); fs.mkdirSync(insts[id].modsDir, { recursive: true }); }
  const idxFile = (i) => path.join(i.libDir, 'index.json');
  w.insts = insts;
  w.idx = (i) => { try { return JSON.parse(read(idxFile(i))); } catch { return []; } };
  w.deps = {
    safeChild,
    readIdx: async (pid, iid) => w.idx(insts[iid]),
    writeIdx: async (pid, iid, arr) => { if (w.fail === iid) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); fs.writeFileSync(idxFile(insts[iid]), JSON.stringify(arr)); },
    ask: async (name, where) => { w.asked.push([name, where]); return ask || { action: 'skip' }; }
  };
  w.add = (i, wid, name, { lib = 'lib-' + name, mod = lib, status = 'Downloaded' } = {}) => {
    if (lib !== null) put(path.join(i.libDir, wid, name, 'mod.info'), lib);
    if (mod !== null) put(path.join(i.modsDir, name, 'mod.info'), mod);
    const idx = w.idx(i); idx.push({ id: wid + '/' + name, wid, name, title: name, status, downloadedAt: 1 }); fs.writeFileSync(idxFile(i), JSON.stringify(idx));
  };
  return w;
}
const mv = (w, ids, from = 'ia', to = 'ib') => M.moveMods(ids.map((id) => ({ from: w.insts[from], id })), w.insts[to], w.deps);

test('move: library copy, installed copy and index entry follow the mod', async () => {
  const w = world(); w.add(w.insts.ia, '100', 'A'); w.add(w.insts.ia, '100', 'B'); w.add(w.insts.ia, '200', 'C', { mod: null });
  const r = await mv(w, ['100/A', '200/C']);
  assert.deepEqual(r.map((x) => x.r), ['Moved', 'Moved']);
  const { ia, ib } = w.insts;
  assert.equal(read(path.join(ib.libDir, '100', 'A', 'mod.info')), 'lib-A'); assert.ok(fs.existsSync(path.join(ib.modsDir, 'A', 'mod.info')));
  assert.ok(fs.existsSync(path.join(ib.libDir, '200', 'C'))); assert.ok(!fs.existsSync(path.join(ib.modsDir, 'C')));
  assert.ok(!fs.existsSync(path.join(ia.libDir, '100', 'A'))); assert.ok(!fs.existsSync(path.join(ia.modsDir, 'A'))); assert.ok(!fs.existsSync(path.join(ia.libDir, '200')));
  assert.ok(fs.existsSync(path.join(ia.libDir, '100', 'B')) && fs.existsSync(path.join(ia.modsDir, 'B')));
  assert.deepEqual(w.idx(ia).map((m) => m.id), ['100/B']); assert.deepEqual(w.idx(ib).map((m) => m.id).sort(), ['100/A', '200/C']);
});

test('move: same instance, missing entry, failed download and missing files are reported without changes', async () => {
  const w = world(); w.add(w.insts.ia, '1', 'A', { lib: null, mod: null }); w.add(w.insts.ia, '2', '_failed', { lib: null, mod: null, status: 'Failed' });
  const r = [...await mv(w, ['1/A']), ...await mv(w, ['2/_failed']), ...await mv(w, ['9/none']), ...await mv(w, ['1/A'], 'ia', 'ia')];
  assert.deepEqual(r.map((x) => x.r), ['Failed', 'Failed', 'Failed', 'Skipped']);
  assert.equal(w.idx(w.insts.ia).length, 2); assert.equal(w.idx(w.insts.ib).length, 0);
});

test('move: only the installed copy exists (library copy missing) is still moved', async () => {
  const w = world(); w.add(w.insts.ia, '1', 'A', { lib: null, mod: 'm' });
  assert.equal((await mv(w, ['1/A']))[0].r, 'Moved');
  assert.equal(read(path.join(w.insts.ib.modsDir, 'A', 'mod.info')), 'm'); assert.ok(!fs.existsSync(path.join(w.insts.ia.modsDir, 'A')));
});

test('conflict: skip leaves both instances untouched', async () => {
  const w = world({ action: 'skip' }); w.add(w.insts.ia, '1', 'A', { lib: 'new' }); w.add(w.insts.ib, '1', 'A', { lib: 'old' });
  assert.equal((await mv(w, ['1/A']))[0].r, 'Skipped');
  assert.equal(read(path.join(w.insts.ib.libDir, '1', 'A', 'mod.info')), 'old'); assert.equal(read(path.join(w.insts.ia.libDir, '1', 'A', 'mod.info')), 'new');
  assert.equal(w.idx(w.insts.ia).length, 1); assert.equal(w.idx(w.insts.ib).length, 1); assert.deepEqual(w.asked, [['A', 'IB']]);
});

test('conflict: replace swaps the destination copy and leaves no backups', async () => {
  const w = world({ action: 'replace' }); w.add(w.insts.ia, '1', 'A', { lib: 'new' }); w.add(w.insts.ib, '1', 'A', { lib: 'old' });
  assert.equal((await mv(w, ['1/A']))[0].r, 'Replaced');
  const { ia, ib } = w.insts;
  assert.equal(read(path.join(ib.libDir, '1', 'A', 'mod.info')), 'new'); assert.equal(read(path.join(ib.modsDir, 'A', 'mod.info')), 'new');
  assert.deepEqual(fs.readdirSync(path.join(ib.libDir, '1')), ['A']); assert.deepEqual(fs.readdirSync(ib.modsDir), ['A']);
  assert.equal(w.idx(ib).length, 1); assert.equal(w.idx(ia).length, 0); assert.ok(!fs.existsSync(path.join(ia.modsDir, 'A')));
});

test('conflict: keep both stores the moved mod under a new name; "apply to all" asks once', async () => {
  const w = world({ action: 'both', all: true }); for (const n of ['A', 'B']) { w.add(w.insts.ia, '1', n, { lib: 'src-' + n }); w.add(w.insts.ib, '1', n, { lib: 'dst-' + n }); }
  const r = await mv(w, ['1/A', '1/B']);
  assert.deepEqual(r.map((x) => x.r), ['Kept both', 'Kept both']); assert.equal(w.asked.length, 1);
  const { ib } = w.insts;
  assert.equal(read(path.join(ib.libDir, '1', 'A', 'mod.info')), 'dst-A'); assert.equal(read(path.join(ib.libDir, '1', 'A_1', 'mod.info')), 'src-A');
  assert.ok(fs.existsSync(path.join(ib.modsDir, 'A_1', 'mod.info'))); assert.deepEqual(w.idx(ib).map((m) => m.id).sort(), ['1/A', '1/A_1', '1/B', '1/B_1']);
  assert.equal(w.idx(ib).find((m) => m.id === '1/A_1').name, 'A_1');
});

test('failure while updating the source index rolls everything back', async () => {
  const w = world(); w.add(w.insts.ia, '1', 'A', { lib: 'src' }); w.fail = 'ia';
  const r = await mv(w, ['1/A']);
  assert.equal(r[0].r, 'Failed'); assert.match(r[0].msg, /disk full/);
  const { ia, ib } = w.insts;
  assert.equal(read(path.join(ia.libDir, '1', 'A', 'mod.info')), 'src'); assert.ok(fs.existsSync(path.join(ia.modsDir, 'A')));
  assert.ok(!fs.existsSync(path.join(ib.libDir, '1'))); assert.deepEqual(fs.readdirSync(ib.modsDir), []); assert.deepEqual(w.idx(ib), []);
});

test('failed replace restores the original destination mod', async () => {
  const w = world({ action: 'replace' }); w.add(w.insts.ia, '1', 'A', { lib: 'new' }); w.add(w.insts.ib, '1', 'A', { lib: 'old' }); w.fail = 'ia';
  assert.equal((await mv(w, ['1/A']))[0].r, 'Failed');
  const { ib } = w.insts;
  assert.equal(read(path.join(ib.libDir, '1', 'A', 'mod.info')), 'old'); assert.equal(read(path.join(ib.modsDir, 'A', 'mod.info')), 'old');
  assert.deepEqual(fs.readdirSync(path.join(ib.libDir, '1')), ['A']); assert.deepEqual(fs.readdirSync(ib.modsDir), ['A']); assert.equal(w.idx(ib).length, 1);
});

test('one failing mod does not stop the others', async () => {
  const w = world(); w.add(w.insts.ia, '1', 'A', { lib: null, mod: null }); w.add(w.insts.ia, '2', 'B');
  assert.deepEqual((await mv(w, ['1/A', '2/B'])).map((x) => x.r), ['Failed', 'Moved']);
});

test('delete modes: library, mods folder, both', async () => {
  const w = world(), { ia } = w.insts, del = (mode, ids) => M.deleteMods(ids.map((id) => ({ inst: ia, id })), mode, w.deps);
  for (const [wid, n] of [['1', 'A'], ['2', 'B'], ['3', 'C']]) w.add(ia, wid, n);
  w.add(ia, '4', '_failed', { lib: null, mod: null, status: 'Failed' });
  assert.equal((await del('game', ['1/A']))[0].r, 'Removed');
  assert.ok(!fs.existsSync(path.join(ia.modsDir, 'A'))); assert.ok(fs.existsSync(path.join(ia.libDir, '1', 'A'))); assert.equal(w.idx(ia).length, 4);
  assert.equal((await del('lib', ['2/B']))[0].r, 'Removed');
  assert.ok(!fs.existsSync(path.join(ia.libDir, '2'))); assert.ok(fs.existsSync(path.join(ia.modsDir, 'B'))); assert.ok(!w.idx(ia).some((m) => m.id === '2/B'));
  assert.equal((await del('both', ['3/C']))[0].r, 'Removed');
  assert.ok(!fs.existsSync(path.join(ia.modsDir, 'C'))); assert.ok(!fs.existsSync(path.join(ia.libDir, '3')));
  assert.equal((await del('game', ['4/_failed']))[0].r, 'Skipped'); assert.equal((await del('lib', ['4/_failed']))[0].r, 'Removed');
  assert.deepEqual(w.idx(ia).map((m) => m.id), ['1/A']);
  assert.equal((await del('both', ['9/none']))[0].r, 'Skipped');
});

test('delete keeps the entry when the index cannot be saved or other mods of the same item stay intact', async () => {
  const w = world(), { ia } = w.insts; w.add(ia, '1', 'A'); w.add(ia, '1', 'B');
  assert.equal((await M.deleteMods([{ inst: ia, id: '1/A' }], 'both', w.deps))[0].r, 'Removed');
  assert.ok(fs.existsSync(path.join(ia.libDir, '1', 'B', 'mod.info'))); assert.ok(fs.existsSync(path.join(ia.modsDir, 'B')));
  w.fail = 'ia'; assert.equal((await M.deleteMods([{ inst: ia, id: '1/B' }], 'both', w.deps))[0].r, 'Failed');
});

test('local: mods only present in the Mods folder are listed, never written to the index, and can be moved and deleted', async () => {
  const w = world(), { ia, ib } = w.insts;
  w.add(ia, '1', 'Tracked');
  put(path.join(ia.modsDir, 'Hand', 'mod.info'), 'name=Hand Made\nid=Hand');
  put(path.join(ia.modsDir, 'B42Mod', '42', 'mod.info'), 'name = B42 Mod');
  put(path.join(ia.modsDir, 'Tracked_1', 'mod.info'), 'x');
  put(path.join(ia.modsDir, 'NotAMod', 'readme.txt'), 'x');
  put(path.join(ia.modsDir, 'Hand.pzmm-old-1', 'mod.info'), 'x');
  const deps = { ...w.deps, readIdx: async (p, i) => M.withLocal(w.insts[i], w.idx(w.insts[i])), writeIdx: (p, i, a) => w.deps.writeIdx(p, i, M.withoutLocal(a)) };
  const list = await deps.readIdx('b42', 'ia');
  assert.deepEqual(list.map((m) => m.id).sort(), ['1/Tracked', 'local/B42Mod', 'local/Hand']);
  assert.equal(list.find((m) => m.id === 'local/Hand').title, 'Hand Made'); assert.equal(list.find((m) => m.id === 'local/B42Mod').title, 'B42 Mod');
  const r = await M.moveMods([{ from: ia, id: 'local/Hand' }], ib, deps);
  assert.equal(r[0].r, 'Moved'); assert.ok(fs.existsSync(path.join(ib.modsDir, 'Hand', 'mod.info'))); assert.ok(!fs.existsSync(path.join(ia.modsDir, 'Hand')));
  assert.deepEqual(w.idx(ib), []); assert.deepEqual((await deps.readIdx('b42', 'ib')).map((m) => m.id), ['local/Hand']);
  assert.equal((await M.deleteMods([{ inst: ia, id: 'local/B42Mod' }], 'lib', deps))[0].r, 'Skipped'); assert.ok(fs.existsSync(path.join(ia.modsDir, 'B42Mod')));
  assert.equal((await M.deleteMods([{ inst: ia, id: 'local/B42Mod' }], 'game', deps))[0].r, 'Removed'); assert.ok(!fs.existsSync(path.join(ia.modsDir, 'B42Mod')));
  assert.deepEqual((await deps.readIdx('b42', 'ia')).map((m) => m.id).sort(), ['1/Tracked']);
});
