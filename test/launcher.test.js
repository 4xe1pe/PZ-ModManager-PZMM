const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const L = require('../src/launcher');

const fakes = (o = {}) => {
  const calls = [];
  return { calls, d: Object.assign({
    exe: '/g/ProjectZomboid64.exe', steamExe: '/s/steam.exe', sleep: async () => {}, minWait: 0, graceAfterReady: 0, steamTimeout: 5000,
    log: () => {}, isRunning: async () => false, steamReady: async () => true,
    startSteam: async () => calls.push('steam'), startGame: async () => calls.push('game') }, o) };
};

test('Steam not running: Steam first, then game', async () => {
  const f = fakes(); const r = await L.launchSequence(f.d);
  assert.deepEqual(f.calls, ['steam', 'game']); assert.equal(r.steamStarted, true); assert.equal(r.note, '');
});
test('Steam already running: no second Steam, game launched directly', async () => {
  const f = fakes({ isRunning: async () => true }); const r = await L.launchSequence(f.d);
  assert.deepEqual(f.calls, ['game']); assert.equal(r.steamStarted, false);
});
test('waits until Steam reports ready before launching the game', async () => {
  let polls = 0; const f = fakes({ steamReady: async () => ++polls >= 3 });
  await L.launchSequence(f.d); assert.equal(polls, 3); assert.deepEqual(f.calls, ['steam', 'game']);
});
test('Steam never becomes ready: game still launched, with a warning note', async () => {
  const f = fakes({ steamReady: async () => false, steamTimeout: 30, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const r = await L.launchSequence(f.d); assert.deepEqual(f.calls, ['steam', 'game']); assert.match(r.note, /did not finish/);
});
test('Steam missing: clear error and the game is NOT launched', async () => {
  const f = fakes({ steamExe: '' });
  await assert.rejects(L.launchSequence(f.d), /steam\.exe could not be found/); assert.deepEqual(f.calls, []);
});
test('Steam start failure aborts before the game', async () => {
  const f = fakes({ startSteam: async () => { throw new Error('nope'); } });
  await assert.rejects(L.launchSequence(f.d), /nope/); assert.deepEqual(f.calls, []);
});

test('spawnDetached really starts a separate executable in its own folder', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pzl-')), exe = path.join(d, 'ProjectZomboid64.exe'), out = path.join(d, 'out.txt');
  fs.writeFileSync(exe, `#!/bin/sh\npwd > "${out}"\necho "args:$#" >> "${out}"\n`, { mode: 0o755 });
  await L.spawnDetached(exe);
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  const t = fs.readFileSync(out, 'utf8'); assert.ok(t.startsWith(fs.realpathSync(d))); assert.match(t, /args:0/);
});
test('spawnDetached reports a missing / non-executable file', async () => {
  await assert.rejects(L.spawnDetached('/definitely/missing/ProjectZomboid64.exe'), (e) => e.code === 'ENOENT');
});
test('process detection', async () => {
  assert.equal(await L.isProcessRunning('definitely-not-a-process'), false);
  assert.equal(await L.isProcessRunning('node'), true);
});
