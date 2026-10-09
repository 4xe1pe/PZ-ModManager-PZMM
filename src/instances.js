'use strict';
/*
 * Instance switching for Project Zomboid.
 *
 * How PZ finds local mods: it scans <user dir>\Zomboid\mods (plus subscribed Workshop items).
 * The game has no setting for "use another mods folder" short of -cachedir (which would also
 * relocate saves, options and server configs), so each instance keeps its mods in its own
 * folder and Zomboid\mods is turned into a directory junction (symlink) pointing at the
 * selected instance's "mods" folder. The game then reads that instance (including the
 * mod-menu's default.txt) transparently, and saves/options stay shared.
 *
 * Data safety rules:
 *  - a real, non-empty Zomboid\mods folder is NEVER deleted: it is renamed to a
 *    "<mods>.pzmm-backup-<timestamp>" sibling (same volume -> atomic) and optionally
 *    copied into the instance first;
 *  - links are removed with unlink/rmdir only (never recursive), so link targets are untouched;
 *  - a link we did not create (pointing outside our instances) is never replaced;
 *  - every switch is verified by writing a probe file through the link and any failure rolls back.
 */
const fs = require('fs'), fsp = fs.promises, path = require('path');

const IS_WIN = process.platform === 'win32';
const err = (m) => Object.assign(new Error(m), { human: true });
const norm = (p) => { const r = path.resolve(p); return IS_WIN ? r.toLowerCase() : r; };
const inside = (child, parent) => {
  const r = path.relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
};
const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const samePath = (a, b) => !!a && !!b && norm(realOf(a)) === norm(realOf(b));

function slugify(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'instance';
}

/** kind: none | file | dir | link (link also reports its target) */
function linkInfo(p) {
  let st; try { st = fs.lstatSync(p); } catch { return { kind: 'none' }; }
  if (st.isSymbolicLink()) {
    let t = ''; try { t = path.resolve(path.dirname(p), fs.readlinkSync(p)); } catch {}
    return { kind: 'link', target: t };
  }
  return { kind: st.isDirectory() ? 'dir' : 'file' };
}
/** true if `link` is a link currently pointing at `target` */
function isLinkedTo(link, target) {
  if (!link || !target) return false;
  const li = linkInfo(link);
  return li.kind === 'link' && (norm(li.target) === norm(target) || samePath(link, target));
}
async function removeLink(p) {
  if (linkInfo(p).kind !== 'link') throw err('Refusing to remove "' + p + '": it is not a link.');
  try { await fsp.unlink(p); } catch { await fsp.rmdir(p); } // never recursive: the target stays intact
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
function backupName(p) {
  const base = p + '.pzmm-backup-' + stamp(); let n = base, i = 1;
  while (fs.existsSync(n)) n = base + '-' + (++i);
  return n;
}
async function importInto(src, dest, names) {
  let n = 0;
  for (const name of names) {
    const to = path.join(dest, name);
    if (fs.existsSync(to)) continue; // never overwrite what the instance already has
    await fsp.cp(path.join(src, name), to, { recursive: true, errorOnExist: true, force: false });
    n++;
  }
  return n;
}
async function verify(link, target) {
  if (!samePath(link, target)) throw new Error('the link does not resolve to the instance folder');
  const probe = '.pzmm-probe-' + process.pid + '-' + Date.now();
  await fsp.writeFile(path.join(link, probe), 'x');
  const seen = fs.existsSync(path.join(target, probe));
  await fsp.rm(path.join(target, probe), { force: true });
  if (!seen) throw new Error('files written through the link did not appear in the instance folder');
}
const hint = (e) => (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') ? ' (close Project Zomboid and any program using the Mods folder, then retry)' : '');

/**
 * Make `link` (the game's Mods folder) point to `target` (the instance's mods folder).
 * opts.isManaged(p)  -> true when p is the mods folder of one of our instances
 * opts.confirmAdopt({link, names, target}) -> 'import' | 'backup' | 'cancel'
 */
async function activate(link, target, opts = {}) {
  if (!link) throw err('No Project Zomboid Mods folder is configured for this profile.');
  const isManaged = opts.isManaged || (() => false);
  const log = opts.log || (() => {});
  try { await fsp.mkdir(target, { recursive: true }); } catch (e) { throw err('Cannot create the instance folder "' + target + '": ' + e.message); }

  let li = linkInfo(link), backup = null, imported = 0, prevTarget = null;
  if (li.kind === 'link') {
    if (isLinkedTo(link, target)) { await verify(link, target).catch((e) => { throw err('The Mods link exists but does not work: ' + e.message); }); return { already: true }; }
    if (!isManaged(li.target)) throw err('The Mods folder "' + link + '" is a link to "' + li.target + '", which does not belong to this app. It was left untouched. Remove or move that link manually, or choose a different Mods folder in the left panel.');
    prevTarget = li.target;
    try { await removeLink(link); } catch (e) { throw err('Could not replace the old Mods link: ' + e.message + hint(e)); }
  } else if (li.kind === 'file') {
    throw err('"' + link + '" is a file, not a folder. Rename it or choose a different Mods folder.');
  } else if (li.kind === 'dir') {
    let names; try { names = await fsp.readdir(link); } catch (e) { throw err('Cannot read the Mods folder: ' + e.message); }
    if (!names.length) { await fsp.rmdir(link); }
    else {
      const choice = opts.confirmAdopt ? await opts.confirmAdopt({ link, names, target }) : 'cancel';
      if (choice !== 'import' && choice !== 'backup') throw err('Cancelled - your Mods folder was not changed.');
      if (choice === 'import') {
        try { imported = await importInto(link, target, names); } catch (e) { throw err('Could not copy the current mods into the instance (nothing was changed): ' + e.message); }
      }
      backup = backupName(link);
      try { await fsp.rename(link, backup); } catch (e) { backup = null; throw err('Could not move the current Mods folder aside: ' + e.message + hint(e)); }
      log('Existing Mods folder preserved as ' + backup);
    }
  }

  try {
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.symlink(target, link, 'junction');
    await verify(link, target);
  } catch (e) { // roll back to exactly what was there before
    try { if (linkInfo(link).kind === 'link') await removeLink(link); } catch {}
    try { if (backup) await fsp.rename(backup, link); else if (prevTarget) await fsp.symlink(prevTarget, link, 'junction'); } catch {}
    throw err('Could not switch the Mods folder to the instance (everything was restored): ' + e.message + hint(e) + (IS_WIN ? '. Junctions require an NTFS drive.' : ''));
  }
  return { already: false, backup, imported };
}

module.exports = { activate, linkInfo, isLinkedTo, removeLink, samePath, inside, slugify, norm, err };
