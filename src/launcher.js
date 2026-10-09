'use strict';
/*
 * Steam detection + direct game launch.
 * The game is ALWAYS started by spawning ProjectZomboid64.exe itself (detached, own process).
 * Steam is only started (never used to start the game) when it is not already running.
 */
const cp = require('child_process'), fs = require('fs'), path = require('path');

const IS_WIN = process.platform === 'win32';
const STEAM_PROC = IS_WIN ? 'steam.exe' : 'steam';
const GAME_PROCS = ['ProjectZomboid64.exe', 'ProjectZomboid32.exe'];
const err = (m) => Object.assign(new Error(m), { human: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, args, timeout = 8000) => new Promise((res) =>
  cp.execFile(cmd, args, { windowsHide: true, timeout }, (e, out) => res({ e, out: String(out || '') })));

async function isProcessRunning(name) {
  if (IS_WIN) {
    const { out } = await run('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH']);
    return out.toLowerCase().includes('"' + name.toLowerCase() + '"');
  }
  const { e } = await run('pgrep', ['-x', name.slice(0, 15)]);
  return !e;
}
async function anyRunning(names) { for (const n of names) if (await isProcessRunning(n)) return n; return ''; }

async function reg(key, value) {
  if (!IS_WIN) return '';
  const { out } = await run('reg', ['query', key, '/v', value]);
  const m = out.match(new RegExp('\\s' + value + '\\s+REG_\\w+\\s+(.+)', 'i'));
  return m ? m[1].trim() : '';
}

/** Locate steam.exe: configured path, registry, location derived from the game folder, default folders. */
async function findSteamExe({ configured, gameDir } = {}) {
  if (!IS_WIN) return configured && fs.existsSync(configured) ? configured : '';
  const c = [configured];
  c.push(await reg('HKCU\\Software\\Valve\\Steam', 'SteamExe'));
  const sp = await reg('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (sp) c.push(path.join(sp, 'steam.exe'));
  if (gameDir) { // ...\Steam\steamapps\common\ProjectZomboid -> ...\Steam
    let d = path.resolve(gameDir);
    for (let i = 0; i < 6 && path.dirname(d) !== d; i++, d = path.dirname(d)) {
      if (path.basename(d).toLowerCase() === 'steamapps') { c.push(path.join(path.dirname(d), 'steam.exe')); break; }
    }
  }
  for (const pf of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)']) if (pf) c.push(path.join(pf, 'Steam', 'steam.exe'));
  for (const x of c) { try { if (x && fs.statSync(path.normalize(x)).isFile()) return path.normalize(x); } catch {} }
  return '';
}

/** Steam has finished starting when a user is logged in (ActiveUser != 0). */
async function steamReady() {
  const v = await reg('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser');
  return !!v && parseInt(v, 16) > 0;
}

/** Spawn a program fully detached from this app, and report spawn failures. */
function spawnDetached(exe, args = []) {
  return new Promise((res, rej) => {
    let c;
    try { c = cp.spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }); } catch (e) { return rej(e); }
    c.once('error', rej);
    c.once('spawn', () => { c.unref(); res(); });
  });
}
const spawnErr = (what, e) => err('Could not start ' + what + ' (' + (e.code || e.message) + '). ' +
  (e.code === 'ENOENT' ? 'The file does not exist.' : e.code === 'EACCES' || e.code === 'EPERM' ? 'Permission denied - the program may need to be run as administrator, or antivirus blocked it.' : e.code === 'UNKNOWN' ? 'Windows refused to start it (it may require administrator rights).' : e.message));

/**
 * Order: (1) Steam if not already running, wait for it to initialise, (2) the game, directly.
 * All side effects are injectable so the sequence can be unit-tested.
 */
async function launchSequence(o) {
  const d = Object.assign({
    isRunning: isProcessRunning, steamReady, sleep, log: () => {},
    startSteam: (exe) => spawnDetached(exe).catch((e) => { throw spawnErr('Steam', e); }),
    startGame: (exe) => spawnDetached(exe).catch((e) => { throw spawnErr('Project Zomboid', e); }),
    minWait: 5000, graceAfterReady: 3000, steamTimeout: 60000
  }, o);
  let steamStarted = false, note = '';
  if (await d.isRunning(STEAM_PROC)) {
    d.log('Steam is already running - not starting another instance.');
  } else {
    if (!d.steamExe) throw err('Steam is not running and steam.exe could not be found. Start Steam yourself, or choose steam.exe in Settings.');
    d.log('Steam is not running - starting Steam...');
    await d.startSteam(d.steamExe); steamStarted = true;
    const t0 = Date.now(); let ready = false;
    await d.sleep(d.minWait);
    while (Date.now() - t0 < d.steamTimeout) {
      if (await d.steamReady()) { ready = true; break; }
      d.log('Waiting for Steam to finish starting...'); await d.sleep(1000);
    }
    if (ready) await d.sleep(d.graceAfterReady);
    else note = 'Steam did not finish logging in within ' + Math.round(d.steamTimeout / 1000) + ' s; the game was started anyway. If it complains about Steam, log in and start it again.';
  }
  d.log('Starting ' + path.basename(d.exe) + ' directly...');
  await d.startGame(d.exe);
  return { steamStarted, note };
}

module.exports = { isProcessRunning, anyRunning, findSteamExe, steamReady, launchSequence, spawnDetached, STEAM_PROC, GAME_PROCS };
