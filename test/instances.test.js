const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os');
const I = require('../src/instances');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pzmm-'));
const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (f, c = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const ls = (d) => fs.readdirSync(d).sort();

function world() {
  const root = tmp(), zomboid = mk(root, 'Zomboid'), link = path.join(zomboid, 'mods');
  const a = mk(root, 'inst', 'a', 'mods'), b = mk(root, 'inst', 'b', 'mods');
  const managed = (t) => [a, b].some((x) => I.samePath(t, x));
  return { root, zomboid, link, a, b, managed };
}

test('fresh install: no Mods folder -> link created and verified', async () => {
  const w = world();
  put(path.join(w.a, 'ModA', 'mod.info'));
  const r = await I.activate(w.link, w.a, { isManaged: w.managed });
  assert.equal(r.already, false);
  assert.ok(I.isLinkedTo(w.link, w.a));
  assert.deepEqual(ls(w.link), ['ModA']); // game sees the instance through the link
});

test('switching instances never mixes or touches mods', async () => {
  const w = world();
  put(path.join(w.a, 'ModA', 'mod.info'), 'A'); put(path.join(w.b, 'ModB', 'mod.info'), 'B');
  await I.activate(w.link, w.a, { isManaged: w.managed });
  assert.deepEqual(ls(w.link), ['ModA']);
  await I.activate(w.link, w.b, { isManaged: w.managed });
  assert.deepEqual(ls(w.link), ['ModB']);
  assert.deepEqual(ls(w.a), ['ModA']); assert.deepEqual(ls(w.b), ['ModB']);
  assert.equal(fs.readFileSync(path.join(w.a, 'ModA', 'mod.info'), 'utf8'), 'A');
  // a write "by the game" through the link lands only in the active instance
  put(path.join(w.link, 'default.txt'), 'list');
  assert.ok(fs.existsSync(path.join(w.b, 'default.txt'))); assert.ok(!fs.existsSync(path.join(w.a, 'default.txt')));
  // re-activating the active one is a no-op
  assert.equal((await I.activate(w.link, w.b, { isManaged: w.managed })).already, true);
});

test('existing real Mods folder: import + backup, nothing deleted', async () => {
  const w = world();
  put(path.join(w.link, 'OldMod', 'mod.info'), 'old'); put(path.join(w.link, 'default.txt'), 'active');
  put(path.join(w.a, 'OldMod', 'mod.info'), 'instance-version'); // must not be overwritten
  const r = await I.activate(w.link, w.a, { isManaged: w.managed, confirmAdopt: async () => 'import' });
  assert.equal(r.imported, 1); // default.txt copied, OldMod skipped (already in instance)
  assert.equal(fs.readFileSync(path.join(w.a, 'OldMod', 'mod.info'), 'utf8'), 'instance-version');
  assert.ok(fs.existsSync(path.join(w.a, 'default.txt')));
  assert.ok(r.backup && fs.readFileSync(path.join(r.backup, 'OldMod', 'mod.info'), 'utf8') === 'old');
  assert.ok(I.isLinkedTo(w.link, w.a));
});

test('existing Mods folder: backup-only and cancel', async () => {
  let w = world(); put(path.join(w.link, 'M', 'mod.info'));
  const r = await I.activate(w.link, w.a, { isManaged: w.managed, confirmAdopt: async () => 'backup' });
  assert.deepEqual(ls(w.a), []); assert.ok(fs.existsSync(path.join(r.backup, 'M', 'mod.info')));
  w = world(); put(path.join(w.link, 'M', 'mod.info'));
  await assert.rejects(I.activate(w.link, w.a, { isManaged: w.managed, confirmAdopt: async () => 'cancel' }), /Cancelled/);
  assert.equal(I.linkInfo(w.link).kind, 'dir'); assert.ok(fs.existsSync(path.join(w.link, 'M', 'mod.info')));
  await assert.rejects(I.activate(w.link, w.a, { isManaged: w.managed }), /Cancelled/); // no callback -> safe default
});

test('empty real folder is simply replaced', async () => {
  const w = world(); mk(w.link);
  const r = await I.activate(w.link, w.a, { isManaged: w.managed });
  assert.equal(r.backup, null); assert.ok(I.isLinkedTo(w.link, w.a));
});

test('foreign link is refused and left untouched', async () => {
  const w = world(), other = mk(w.root, 'someone-elses-mods'); put(path.join(other, 'X', 'mod.info'));
  fs.symlinkSync(other, w.link, 'junction');
  await assert.rejects(I.activate(w.link, w.a, { isManaged: w.managed }), /does not belong to this app/);
  assert.ok(I.isLinkedTo(w.link, other)); assert.ok(fs.existsSync(path.join(other, 'X', 'mod.info')));
});

test('a file in place of the folder is refused', async () => {
  const w = world(); put(w.link, 'file');
  await assert.rejects(I.activate(w.link, w.a, { isManaged: w.managed }), /is a file/);
  assert.equal(fs.readFileSync(w.link, 'utf8'), 'file');
});

test('failure while linking rolls back (backup restored)', async () => {
  const w = world(); put(path.join(w.link, 'Keep', 'mod.info'), 'keep');
  const orig = fsp.symlink; fsp.symlink = async () => { const e = new Error('boom'); e.code = 'EPERM'; throw e; };
  try { await assert.rejects(I.activate(w.link, w.a, { isManaged: w.managed, confirmAdopt: async () => 'backup' }), /everything was restored/); }
  finally { fsp.symlink = orig; }
  assert.equal(I.linkInfo(w.link).kind, 'dir');
  assert.equal(fs.readFileSync(path.join(w.link, 'Keep', 'mod.info'), 'utf8'), 'keep');
  assert.deepEqual(ls(w.zomboid), ['mods']); // no stray backup left behind
});

test('failure while re-pointing restores the previous link', async () => {
  const w = world(); await I.activate(w.link, w.a, { isManaged: w.managed });
  const orig = fsp.symlink; let n = 0;
  fsp.symlink = async (...a) => { if (n++ === 0) throw new Error('boom'); return orig(...a); };
  try { await assert.rejects(I.activate(w.link, w.b, { isManaged: w.managed }), /restored/); } finally { fsp.symlink = orig; }
  assert.ok(I.isLinkedTo(w.link, w.a));
});

test('removeLink never deletes the target and refuses real folders', async () => {
  const w = world(); put(path.join(w.a, 'M', 'mod.info'));
  await I.activate(w.link, w.a, { isManaged: w.managed }); await I.removeLink(w.link);
  assert.equal(I.linkInfo(w.link).kind, 'none'); assert.ok(fs.existsSync(path.join(w.a, 'M', 'mod.info')));
  mk(w.link); put(path.join(w.link, 'f'));
  await assert.rejects(I.removeLink(w.link), /not a link/); assert.ok(fs.existsSync(path.join(w.link, 'f')));
});

test('dangling managed link (instance folder was removed) is repaired', async () => {
  const w = world(); await I.activate(w.link, w.a, { isManaged: w.managed });
  fs.rmSync(w.a, { recursive: true });
  await I.activate(w.link, w.b, { isManaged: w.managed });
  assert.ok(I.isLinkedTo(w.link, w.b));
});

test('slugify / inside', () => {
  assert.equal(I.slugify('Instance 2!'), 'instance-2'); assert.equal(I.slugify('???'), 'instance');
  assert.ok(I.inside('/a/b/c', '/a/b')); assert.ok(!I.inside('/a/bc', '/a/b')); assert.ok(!I.inside('/a/..x', '/a/b')); assert.ok(I.inside('/a/..x', '/a'));
});
