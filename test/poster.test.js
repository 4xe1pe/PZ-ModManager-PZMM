const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { findPoster } = require('../src/mods');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pzmm-poster-'));
const put = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'png'); };

test('Build 42 poster (<mod>/42/poster.png) wins over the mod root', async () => {
  const mod = path.join(tmp(), 'alicesWeaponSling');
  put(path.join(mod, '42', 'poster.png')); put(path.join(mod, 'poster.png'));
  assert.strictEqual(await findPoster([mod]), path.join(mod, '42', 'poster.png'));
});

test('Build 41 layout (poster.png in the mod root) is found', async () => {
  const mod = path.join(tmp(), 'oldMod');
  put(path.join(mod, 'poster.png'));
  assert.strictEqual(await findPoster([mod]), path.join(mod, 'poster.png'));
});

test('missing poster returns null and later roots are tried', async () => {
  const a = path.join(tmp(), 'empty'), b = path.join(tmp(), 'has');
  fs.mkdirSync(a, { recursive: true }); put(path.join(b, 'poster.png'));
  assert.strictEqual(await findPoster([a]), null);
  assert.strictEqual(await findPoster([a, b]), path.join(b, 'poster.png'));
});
