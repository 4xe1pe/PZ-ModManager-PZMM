'use strict';
/*
 * Workshop mod update logic (plain Node, no Electron; see test/updates.test.js).
 *
 * Version detection: GetPublishedFileDetails returns hcontent_file, the Steam content manifest id.
 * It changes when the item's files change, not when only its title or description changes, so it is
 * the primary signal. time_updated is used only when no manifest is returned.
 *
 * Replacement: SteamCMD downloads into its own folder. The mods are copied into a staging folder inside
 * the instance, verified against the current copy, and swapped in with renames on the same volume.
 * Every rename is recorded; if any step fails (including the index write) the recorded renames are
 * reversed, restoring the previous files. Old files are deleted only after the whole swap succeeded.
 */
const fs = require('fs'), fsp = fs.promises, path = require('path'), crypto = require('crypto');

const err = (m) => Object.assign(new Error(m), { human: true });
const hint = (e) => (e && (e.code === 'EPERM' || e.code === 'EBUSY')
  ? ' Close Project Zomboid and any program using the mod folder, then retry.' : '');

/* ---------- version snapshots ---------- */

/** Version snapshot from a GetPublishedFileDetails entry. */
function snapOf(d) {
  if (!d) return null;
  const time = Number(d.time_updated) || 0;
  const manifest = d.hcontent_file ? String(d.hcontent_file) : null;
  return time || manifest ? { time, manifest } : null;
}

/** Version the local copy was downloaded at. Entries from older versions of the app have none. */
const downloadedSnap = (m) => m.snapDl || null;

/** Last version seen on Steam (set on download and on every "Check for updates"). */
const seenSnap = (m) => m.snapSeen || (m.remoteUpdated ? { time: m.remoteUpdated, manifest: null } : null);

/** true if `remote` is newer than `dl`. Manifest ids are authoritative; time is the fallback. */
function isNewer(dl, remote) {
  if (!remote) return false;
  if (!dl) return true; // local version unknown: verify by downloading
  if (dl.manifest && remote.manifest) return dl.manifest !== remote.manifest;
  return remote.time > dl.time;
}

/** Badge rule. Entries without a download snapshot keep the old wall-clock comparison. */
function updateAvailable(m) {
  if (!m || m.status === 'Failed' || !m.wid || m.wid === 'local') return false;
  const seen = seenSnap(m);
  if (!seen) return false;
  const dl = downloadedSnap(m);
  if (!dl) return seen.time * 1000 > (m.downloadedAt || 0); // legacy
  return isNewer(dl, seen);
}

/* ---------- helpers ---------- */

async function hashDir(d) {
  const h = crypto.createHash('sha1');
  const walk = async (p, rel) => {
    const es = (await fsp.readdir(p, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of es) {
      const r = rel + '/' + e.name; h.update(r);
      if (e.isDirectory()) await walk(path.join(p, e.name), r);
      else h.update(await fsp.readFile(path.join(p, e.name)));
    }
  };
  await walk(d, '');
  return h.digest('hex');
}

async function removeEmptyDirs(list) {
  for (const d of list) await fsp.rmdir(d).catch(() => {});
}

/* ---------- transactional replacement ---------- */

/**
 * ctx:
 *   wid                 Workshop item id
 *   libDir, modsDir     instance library folder and instance Mods folder
 *   found               [{dir, name, title}] mods in the freshly downloaded item (dirs live in SteamCMD's folder)
 *   targets             index entries (status Downloaded) currently held for this item
 *   stageRoot           folder inside libDir for the new copies (same volume)
 *   stashRoot           folder inside libDir for the old copies (same volume)
 *   commit({changed, unchanged, added})   writes the index; a throw rolls the swap back
 *   onPhase(text)       optional progress callback
 * Returns { changed, unchanged, added, keptBackups }.
 */
async function performUpdate(ctx) {
  const { wid, libDir, modsDir, found, targets, stageRoot, stashRoot, commit, onPhase = () => {} } = ctx;

  const names = found.map((f) => f.name);
  if (new Set(names).size !== names.length) throw err('The downloaded item contains two mods with the same folder name. Nothing was changed.');
  const missing = targets.map((t) => t.name).filter((n) => !names.includes(n));
  if (missing.length) throw err(`The new version no longer contains ${missing.join(', ')}. Nothing was changed; your current copy was kept.`);

  const lib = path.join(libDir, wid);
  const newDir = path.join(stageRoot, 'new');
  const modStage = path.join(stageRoot, 'mods');
  const stash = path.join(stashRoot, 'lib');
  const mstash = path.join(stashRoot, 'mods');
  const keptBackups = [];
  const result = { changed: [], unchanged: [], added: [], keptBackups };
  let keepAll = false;

  try {
    onPhase('Verifying');
    await fsp.mkdir(newDir, { recursive: true });
    const oldHash = {};
    for (const f of found) {
      await fsp.cp(f.dir, path.join(newDir, f.name), { recursive: true, errorOnExist: true, force: false });
      const live = path.join(lib, f.name);
      oldHash[f.name] = fs.existsSync(live) ? await hashDir(live) : null;
      const newHash = await hashDir(path.join(newDir, f.name));
      if (oldHash[f.name] === newHash) result.unchanged.push(f.name);
      else {
        result.changed.push(f.name);
        if (!targets.some((t) => t.name === f.name)) result.added.push(f.name);
      }
    }

    // Content identical: nothing on disk changes, only the version snapshot is recorded.
    if (!result.changed.length) {
      await commit({ changed: [], unchanged: result.unchanged, added: [] });
      return result;
    }

    const steps = [];
    for (const n of result.changed) {
      steps.push({ kind: 'lib', incoming: path.join(newDir, n), dest: path.join(lib, n), backup: path.join(stash, n) });
      const md = path.join(modsDir, n);
      if (fs.existsSync(md)) { // only mods the user actually pushed get their Mods-folder copy replaced
        const copy = path.join(modStage, n);
        await fsp.mkdir(modStage, { recursive: true });
        await fsp.cp(path.join(newDir, n), copy, { recursive: true, errorOnExist: true, force: false });
        // if the installed copy differs from the library copy, the user edited it: keep its backup
        const edited = oldHash[n] === null || (await hashDir(md)) !== oldHash[n];
        steps.push({ kind: 'mods', incoming: copy, dest: md, backup: path.join(mstash, n), edited });
      }
    }

    onPhase('Replacing');
    const undo = [];
    try {
      for (const s of steps) {
        if (fs.existsSync(s.dest)) {
          await fsp.mkdir(path.dirname(s.backup), { recursive: true });
          await fsp.rename(s.dest, s.backup);
          undo.push(() => fsp.rename(s.backup, s.dest));
        }
        await fsp.mkdir(path.dirname(s.dest), { recursive: true });
        await fsp.rename(s.incoming, s.dest);
        undo.push(() => fsp.rename(s.dest, s.incoming));
      }
      await commit({ changed: result.changed, unchanged: result.unchanged, added: result.added });
    } catch (e) {
      const failed = [];
      for (const u of undo.reverse()) { try { await u(); } catch (x) { failed.push(x.message); } }
      if (failed.length) {
        keepAll = true;
        throw err(`Update failed and the automatic rollback was incomplete (${failed.join('; ')}). Previous files are kept in ${stashRoot}. Original error: ${e.message}`);
      }
      throw err(`Update failed, the previous version was restored: ${e.message}${hint(e)}`);
    }

    // Success: the old copies are removed, except edited installed copies, which are kept.
    onPhase('Cleaning up');
    for (const s of steps) {
      if (!fs.existsSync(s.backup)) continue;
      if (s.kind === 'mods' && s.edited) { keptBackups.push(s.backup); continue; }
      await fsp.rm(s.backup, { recursive: true, force: true }).catch(() => keptBackups.push(s.backup));
    }
    return result;
  } catch (e) {
    if (e.human) throw e;
    throw err('Update could not be prepared; nothing was changed: ' + e.message);
  } finally {
    if (!keepAll) {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      await removeEmptyDirs([stash, mstash, stashRoot]);
    }
  }
}

module.exports = { snapOf, downloadedSnap, seenSnap, isNewer, updateAvailable, hashDir, performUpdate };