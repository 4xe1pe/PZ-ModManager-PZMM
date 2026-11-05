'use strict';
/*
 * Steam Workshop collections.
 *
 * A collection is a Workshop item of type 2 whose "children" are the mods it contains.
 * Required items (dependencies) are reported per mod by the Steam Web API.
 *
 * planCollection() only talks to Steam through the three functions it receives
 * (details, collectionChildren, requiredItems), so the decision logic can be tested
 * without the network. Anything Steam refuses is reported, never silently dropped.
 */
const https = require('https');

const PZ_APPID = 108600;
const FILE_COLLECTION = 2;
const MAX_NAME = 40;
const err = (m) => Object.assign(new Error(m), { human: true });

const chunks = (a, n = 50) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

/* ---------- Steam Web API (POST, form encoded) ---------- */
function steamPost(host, path, body) {
  return new Promise((res, rej) => {
    const rq = https.request({ host, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', () => {
        if (r.statusCode !== 200) return rej(new Error(`Steam answered HTTP ${r.statusCode}.`));
        try { res(JSON.parse(b).response || {}); } catch { rej(new Error('Steam returned an unexpected response.')); }
      });
    });
    rq.on('error', rej);
    rq.setTimeout(15000, () => rq.destroy(new Error('Steam did not respond (network problem?).')));
    rq.end(body);
  });
}
const idForm = (ids, extra = []) => ids.map((id, i) => `publishedfileids[${i}]=${id}`).concat(extra).join('&');

/** Map<collectionId, [{ publishedfileid, file_type }]> */
async function collectionChildren(ids) {
  const out = new Map();
  for (const part of chunks(ids)) {
    const r = await steamPost('api.steampowered.com', '/ISteamRemoteStorage/GetCollectionDetails/v1/', idForm(part, ['collectioncount=' + part.length]));
    for (const c of r.collectiondetails || []) {
      out.set(String(c.publishedfileid), (c.children || []).map((x) => ({ publishedfileid: String(x.publishedfileid), file_type: Number(x.file_type) })));
    }
  }
  return out;
}

/**
 * Map<itemId, [requiredItemId]> for Workshop items. Best effort: the call may be refused
 * (the caller treats a failure as "dependency check unavailable"), never as "no dependencies".
 */
async function requiredItems(ids) {
  const out = new Map();
  for (const part of chunks(ids)) {
    const r = await steamPost('api.steampowered.com', '/IPublishedFileService/GetDetails/v1/', idForm(part, ['includechildren=true']));
    for (const d of r.publishedfiledetails || []) out.set(String(d.publishedfileid), (d.children || []).map((c) => String(c.publishedfileid)));
  }
  return out;
}

/* ---------- planning ---------- */
/**
 * Resolves a collection into the mods to download and the problems found.
 * api: { details(ids) -> [PublishedFileDetails], collectionChildren(ids), requiredItems(ids) }
 */
async function planCollection(wid, api, { maxDepth = 3 } = {}) {
  const [root] = await api.details([wid]);
  if (!root || Number(root.result) !== 1) throw err(`Collection ${wid} does not exist or is private.`);
  if (Number(root.file_type) !== FILE_COLLECTION) throw err('This Workshop item is a single mod, not a collection. Use Download for single mods.');

  // 1) walk the collection tree; nested collections are expanded up to maxDepth
  const seenCol = new Set([wid]), itemIds = new Set();
  let nested = 0, level = [wid];
  for (let depth = 0; level.length; depth++) {
    const kids = await api.collectionChildren(level), next = [];
    for (const parent of level) for (const c of kids.get(parent) || []) {
      const id = String(c.publishedfileid);
      if (Number(c.file_type) === FILE_COLLECTION) {
        if (seenCol.has(id)) continue;
        seenCol.add(id);
        if (depth + 1 < maxDepth) next.push(id); else nested++;
      } else itemIds.add(id);
    }
    level = next;
  }

  // 2) details of every item
  const dets = new Map();
  const fetchDetails = async (ids) => { for (const part of chunks(ids)) for (const d of await api.details(part)) dets.set(String(d.publishedfileid), d); };
  await fetchDetails([...itemIds]);
  const titleOf = (id) => (dets.get(id) || {}).title || 'Workshop ' + id;
  const reasonFor = (id) => {
    const d = dets.get(id);
    if (!d || Number(d.result) !== 1) return 'Removed from Steam or not found';
    if ([1, 2].includes(Number(d.visibility))) return 'Private or friends-only: Steam will not download it for anonymous users';
    if (d.consumer_app_id && Number(d.consumer_app_id) !== PZ_APPID) return 'Not a Project Zomboid item';
    if (d.file_type !== undefined && Number(d.file_type) !== 0) return 'Not a mod (Workshop type ' + Number(d.file_type) + ')';
    return '';
  };
  const members = [...itemIds].map((id) => { const reason = reasonFor(id); return { wid: id, title: titleOf(id), reason, ok: !reason }; });

  // 3) required items of the downloadable members (best effort, reported either way)
  let depsChecked = true; const deps = [];
  try {
    const okIds = members.filter((m) => m.ok).map((m) => m.wid);
    const req = await api.requiredItems(okIds);
    const by = new Map();
    for (const id of okIds) for (const dep of req.get(id) || []) {
      if (itemIds.has(dep) || seenCol.has(dep)) continue;
      if (!by.has(dep)) by.set(dep, new Set());
      by.get(dep).add(titleOf(id));
    }
    await fetchDetails([...by.keys()].filter((x) => !dets.has(x)));
    for (const [dep, who] of by) {
      const reason = reasonFor(dep);
      deps.push({ wid: dep, title: titleOf(dep), reason, ok: !reason, requiredBy: [...who] });
    }
  } catch {
    depsChecked = false;
  }

  return { kind: 'collection', wid, title: root.title || '', preview: root.preview_url || '', members, deps, depsChecked, nested };
}

/** what to download: the collection's usable mods, plus (manage automatically) the usable required mods */
function downloadList(plan, mode) {
  const list = plan.members.filter((m) => m.ok).map((m) => ({ wid: m.wid, title: m.title, origin: 'collection' }));
  if (mode === 'auto') for (const d of plan.deps) if (d.ok) list.push({ wid: d.wid, title: d.title, origin: 'dependency', requiredBy: d.requiredBy });
  return list;
}

/* ---------- names ---------- */
/** a safe instance name from a collection title (the app's rules: <= 40 chars, no <> or control characters) */
function instanceNameFor(title, wid) {
  const n = String(title || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return n || 'Collection ' + wid;
}
/** appends " (2)", " (3)"... until the name is free (taken: lower-case names already used) */
function uniqueName(base, taken) {
  let name = base, i = 1;
  while (taken.has(name.toLowerCase())) {
    i++; const suffix = ` (${i})`;
    name = base.slice(0, MAX_NAME - suffix.length).trimEnd() + suffix;
  }
  return name;
}

/* ---------- collection image (used as the instance icon) ---------- */
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const imageExt = (type) => IMAGE_TYPES[String(type || '').split(';')[0].trim().toLowerCase()] || '';

/** downloads an https image (max bytes, few redirects); resolves { data: Buffer, type } */
const IMAGE_HOSTS = /(^|\.)(akamaihd\.net|steamstatic\.com|steamusercontent\.com|steamcommunity\.com)$/i; // Steam's own image hosts only
function fetchImage(url, max = 5 * 1048576, redirects = 3) {
  return new Promise((res, rej) => {
    let u; try { u = new URL(url); } catch { return rej(new Error('invalid image address')); }
    if (u.protocol !== 'https:' || !IMAGE_HOSTS.test(u.hostname)) return rej(new Error('image is not on a Steam host'));
    const rq = https.get(u, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume(); return res(fetchImage(new URL(r.headers.location, u).href, max, redirects - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const type = String(r.headers['content-type'] || '');
      if (!imageExt(type)) { r.resume(); return rej(new Error('not an image')); }
      const parts = []; let size = 0;
      r.on('data', (d) => { size += d.length; if (size > max) r.destroy(new Error('image is too large')); else parts.push(d); });
      r.on('error', rej);
      r.on('end', () => (size > max ? rej(new Error('image is too large')) : res({ data: Buffer.concat(parts), type })));
    });
    rq.setTimeout(15000, () => rq.destroy(new Error('timed out')));
    rq.on('error', rej);
  });
}

module.exports = { planCollection, downloadList, collectionChildren, requiredItems, instanceNameFor, uniqueName, imageExt, fetchImage, PZ_APPID };
