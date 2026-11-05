const test = require('node:test'), assert = require('node:assert');
const W = require('../src/workshop');

// A fake Steam: items, collections (children) and required items are plain tables.
function steam(world, { reqFails = false } = {}) {
  return {
    details: async (ids) => ids.map((id) => ({ publishedfileid: id, result: 9, ...world.items[id] }) ).map((d) => (world.items[d.publishedfileid] ? d : { ...d, result: 9 })),
    collectionChildren: async (ids) => new Map(ids.filter((id) => world.cols[id]).map((id) => [id, world.cols[id]])),
    requiredItems: async (ids) => { if (reqFails) throw new Error('Steam answered HTTP 403.'); return new Map(ids.filter((id) => world.req[id]).map((id) => [id, world.req[id]])); },
  };
}
const mod = (title, extra = {}) => ({ result: 1, file_type: 0, consumer_app_id: 108600, visibility: 0, title, ...extra });
const col = (title, extra = {}) => ({ result: 1, file_type: 2, title, ...extra });

test('collection: usable mods are kept; private, other-game, removed and non-mod items are reported', async () => {
  const world = {
    items: { C: col('My Pack', { preview_url: 'https://x/y.png' }), A: mod('Alpha'), B: mod('Beta', { visibility: 1 }), D: mod('Gamma', { consumer_app_id: 440 }), F: mod('Foxtrot'), G: mod('Gone', { result: 9 }), W: mod('Wallpaper', { file_type: 6 }) },
    cols: { C: [{ publishedfileid: 'A', file_type: 0 }, { publishedfileid: 'B', file_type: 0 }, { publishedfileid: 'D', file_type: 0 }, { publishedfileid: 'F', file_type: 0 }, { publishedfileid: 'G', file_type: 0 }, { publishedfileid: 'W', file_type: 0 }] },
    req: {},
  };
  const p = await W.planCollection('C', steam(world));
  assert.equal(p.title, 'My Pack'); assert.equal(p.preview, 'https://x/y.png'); assert.equal(p.depsChecked, true);
  const byId = Object.fromEntries(p.members.map((m) => [m.wid, m]));
  assert.equal(byId.A.ok, true); assert.equal(byId.F.ok, true);
  assert.match(byId.B.reason, /Private or friends-only/);
  assert.match(byId.D.reason, /Not a Project Zomboid item/);
  assert.match(byId.G.reason, /Removed from Steam/);
  assert.match(byId.W.reason, /Not a mod/);
  assert.deepEqual(W.downloadList(p, 'manual').map((m) => m.wid), ['A', 'F']);
});

test('dependencies: found required mods are listed with who needs them; unavailable ones are reported; collection members are not duplicated', async () => {
  const world = {
    items: { C: col('Deps'), A: mod('Alpha'), B: mod('Beta'), X: mod('Xray'), Y: mod('Yankee', { visibility: 2 }) },
    cols: { C: [{ publishedfileid: 'A', file_type: 0 }, { publishedfileid: 'B', file_type: 0 }] },
    req: { A: ['X', 'B'], B: ['Y', 'X'] },   // B is a member already, so it must not be listed as a dependency
  };
  const p = await W.planCollection('C', steam(world));
  const deps = Object.fromEntries(p.deps.map((d) => [d.wid, d]));
  assert.deepEqual(Object.keys(deps).sort(), ['X', 'Y']);
  assert.equal(deps.X.ok, true); assert.deepEqual(deps.X.requiredBy.sort(), ['Alpha', 'Beta']);
  assert.equal(deps.Y.ok, false); assert.match(deps.Y.reason, /Private/);
  assert.deepEqual(W.downloadList(p, 'manual').map((m) => m.wid), ['A', 'B']);          // manual: collection only
  assert.deepEqual(W.downloadList(p, 'auto').map((m) => m.wid), ['A', 'B', 'X']);       // auto: + available deps, never unavailable ones
  assert.equal(W.downloadList(p, 'auto').find((m) => m.wid === 'X').origin, 'dependency');
});

test('when Steam refuses the dependency lookup the plan still works and says so', async () => {
  const world = { items: { C: col('Plain'), A: mod('Alpha') }, cols: { C: [{ publishedfileid: 'A', file_type: 0 }] }, req: {} };
  const p = await W.planCollection('C', steam(world, { reqFails: true }));
  assert.equal(p.depsChecked, false); assert.deepEqual(p.deps, []);
  assert.deepEqual(W.downloadList(p, 'auto').map((m) => m.wid), ['A']);
});

test('nested collections are expanded once, depth-limited, and items are de-duplicated', async () => {
  const world = {
    items: { C: col('Outer'), N: col('Inner'), M: col('Deep'), A: mod('Alpha'), B: mod('Beta'), Z: mod('Zulu') },
    cols: {
      C: [{ publishedfileid: 'A', file_type: 0 }, { publishedfileid: 'N', file_type: 2 }],
      N: [{ publishedfileid: 'B', file_type: 0 }, { publishedfileid: 'A', file_type: 0 }, { publishedfileid: 'M', file_type: 2 }],
      M: [{ publishedfileid: 'Z', file_type: 0 }],
    },
    req: {},
  };
  const full = await W.planCollection('C', steam(world), { maxDepth: 3 });
  assert.deepEqual(full.members.map((m) => m.wid).sort(), ['A', 'B', 'Z']);   // A appears twice, kept once
  assert.equal(full.nested, 0);
  const shallow = await W.planCollection('C', steam(world), { maxDepth: 2 });
  assert.deepEqual(shallow.members.map((m) => m.wid).sort(), ['A', 'B']);      // M is one level too deep
  assert.equal(shallow.nested, 1);
});

test('a single mod or a missing item is refused with a clear message', async () => {
  const world = { items: { A: mod('Alpha'), Q: col('Ghost', { result: 9 }) }, cols: {}, req: {} };
  await assert.rejects(W.planCollection('A', steam(world)), (e) => e.human && /not a collection/.test(e.message));
  await assert.rejects(W.planCollection('Q', steam(world)), (e) => e.human && /does not exist/.test(e.message));
});

test('instance names: safe, at most 40 characters, unique case-insensitively', () => {
  assert.equal(W.instanceNameFor('  My <b>Pack</b>\n  ', '1'), 'My bPack/b'); // < and > removed, whitespace collapsed
  assert.equal(W.instanceNameFor('', '123'), 'Collection 123');
  assert.ok(W.instanceNameFor('x'.repeat(80), '1').length <= 40);
  assert.equal(W.uniqueName('Survival', new Set(['survival'])), 'Survival (2)');
  assert.equal(W.uniqueName('Survival', new Set(['survival', 'survival (2)'])), 'Survival (3)');
  assert.equal(W.uniqueName('New', new Set()), 'New');
  const long = W.uniqueName('y'.repeat(40), new Set(['y'.repeat(40)]));
  assert.ok(long.length <= 40 && long.endsWith(' (2)'));
});

test('collection images: only real image types map to a file extension', () => {
  assert.equal(W.imageExt('image/png'), 'png');
  assert.equal(W.imageExt('image/jpeg; charset=binary'), 'jpg');
  assert.equal(W.imageExt('text/html'), '');
  assert.equal(W.imageExt(undefined), '');
});
