const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const M = require('../src/mods');

const safeChild = (base, name) => {
  if (!base || !name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('unsafe ' + name);
  return path.join(base, name);
};
const put = (f, c = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const read = (f) => fs.readFileSync(f, 'utf8');
function inst() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pzmm-push-'));
  const i = { libDir: path.join(root, 'library'), modsDir: path.join(root, 'mods') };
  fs.mkdirSync(i.libDir); fs.mkdirSync(i.modsDir);
  return i;
}

test('push copies library copies into the instance Mods folder and reports Installed', async () => {
  const i = inst(); put(path.join(i.libDir, '100', 'A', 'mod.info'), 'A');
  const r = await M.pushMods([{ wid: '100', name: 'A' }], i, { ask: async () => ({ action: 'skip' }), safeChild });
  assert.deepEqual(r.map((x) => x.r), ['Installed']);
  assert.equal(read(path.join(i.modsDir, 'A', 'mod.info')), 'A');
});

test('an identical mod is "Already installed"; a different one asks and is never overwritten by default', async () => {
  const i = inst(); put(path.join(i.libDir, '1', 'A', 'mod.info'), 'new'); put(path.join(i.modsDir, 'A', 'mod.info'), 'old');
  const asked = [];
  const r = await M.pushMods([{ wid: '1', name: 'A' }], i, { ask: async (n) => { asked.push(n); return { action: 'skip' }; }, safeChild });
  assert.deepEqual(r.map((x) => x.r), ['Skipped']); assert.deepEqual(asked, ['A']);
  assert.equal(read(path.join(i.modsDir, 'A', 'mod.info')), 'old');
  put(path.join(i.modsDir, 'B', 'mod.info'), 'same'); put(path.join(i.libDir, '2', 'B', 'mod.info'), 'same');
  assert.equal((await M.pushMods([{ wid: '2', name: 'B' }], i, { ask: async () => ({ action: 'skip' }), safeChild }))[0].r, 'Already installed');
});

test('replace and keep-both are honoured; "apply to all" is remembered', async () => {
  const i = inst();
  put(path.join(i.libDir, '1', 'A', 'mod.info'), 'new-A'); put(path.join(i.modsDir, 'A', 'mod.info'), 'old-A');
  put(path.join(i.libDir, '2', 'B', 'mod.info'), 'new-B'); put(path.join(i.modsDir, 'B', 'mod.info'), 'old-B');
  const r = await M.pushMods([{ wid: '1', name: 'A' }, { wid: '2', name: 'B' }], i, { ask: async () => ({ action: 'replace', all: true }), safeChild });
  assert.deepEqual(r.map((x) => x.r), ['Installed', 'Installed']);
  assert.equal(read(path.join(i.modsDir, 'A', 'mod.info')), 'new-A');
  assert.equal(read(path.join(i.modsDir, 'B', 'mod.info')), 'new-B');

  const j = inst(); put(path.join(j.libDir, '3', 'C', 'mod.info'), 'new-C'); put(path.join(j.modsDir, 'C', 'mod.info'), 'old-C');
  const k = await M.pushMods([{ wid: '3', name: 'C' }], j, { ask: async () => ({ action: 'both' }), safeChild });
  assert.equal(k[0].r, 'Installed');
  assert.equal(read(path.join(j.modsDir, 'C', 'mod.info')), 'old-C');
  assert.equal(read(path.join(j.modsDir, 'C_3', 'mod.info')), 'new-C');
});

test('a missing library copy fails only that mod and the others still go in', async () => {
  const i = inst(); put(path.join(i.libDir, '2', 'B', 'mod.info'), 'B');
  const r = await M.pushMods([{ wid: '1', name: 'A' }, { wid: '2', name: 'B' }], i, { ask: async () => ({ action: 'skip' }), safeChild });
  assert.deepEqual(r.map((x) => x.r), ['Failed', 'Installed']);
  assert.match(r[0].msg, /library copy is missing/);
});

test('readModInfo reads id and require (comma separated); a folder without mod.info gives nothing', async () => {
  const i = inst(); const d = path.join(i.libDir, 'x');
  put(path.join(d, 'mod.info'), 'name=Alpha\nid=AlphaMod\nrequire=Base, Extra ,\n');
  assert.deepEqual(await M.readModInfo(d), { id: 'AlphaMod', requires: ['Base', 'Extra'] });
  assert.deepEqual(await M.readModInfo(path.join(i.libDir, 'nope')), { id: '', requires: [] });
});

test('missingRequirements lists what downloaded mods need and nothing that is provided', () => {
  const idx = [
    { status: 'Downloaded', title: 'Alpha', name: 'Alpha', modId: 'AlphaMod', requires: ['Base', 'Extra'] },
    { status: 'Downloaded', title: 'Base', name: 'BaseFolder', modId: 'Base', requires: [] },
    { status: 'Failed', title: 'Broken', name: '', modId: 'Extra', requires: [] },   // failed entries provide nothing
  ];
  assert.deepEqual(M.missingRequirements(idx), [{ mod: 'Alpha', needs: 'Extra' }]);
  assert.deepEqual(M.missingRequirements([]), []);
});
