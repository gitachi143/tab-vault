// Storage layer for Tab Vault. Snapshots are kept under individual keys
// (snap:<id>) so we never have to load every snapshot to read one, and a
// lightweight index (snap:index) lists ids+metadata for fast UI rendering.
//
// Concurrency model: every operation that reads-then-writes the index goes
// through a single promise-chain mutex (`runExclusive`). This makes the
// extension safe against concurrent firings (e.g. an alarms-driven auto
// snapshot landing at the same moment as a manual save click).

import { uuid } from './utils.js';

export const KEYS = {
  INDEX: 'snap:index',
  SETTINGS: 'tv:settings',
  LIVE: 'tv:live',
  LIVE_META: 'tv:live_meta',
  SESSION: 'tv:session',
  PROFILE_ID: 'tv:profileId',
  BROWSER: 'tv:browserInfo',   // { name, lastSeen }
  PREFIX: 'snap:'
};

export const DEFAULT_SETTINGS = {
  autoSnapshotMinutes: 10,
  maxSnapshots: 200,
  liveSnapshotEnabled: true,
  liveSnapshotDebounceMs: 4000,
  sessionGapMinutes: 60,
  theme: 'auto',
  profileLabel: '',
  // Hourly backup (opt-in, both channels independent)
  hourlyBackupEnabled: false,
  hourlyBackupDownload: true,
  hourlyBackupWebhookUrl: '',
  hourlyBackupWebhookSecret: '',
  hourlyBackupIntervalMinutes: 1440,
  hourlyBackupLastStatus: '',
  hourlyBackupLastRunAt: 0,
  schemaVersion: 1
};

function area() { return chrome.storage.local; }

// --------------------------------------------------------------------------
// Mutex — serialize all index-mutating operations.
// --------------------------------------------------------------------------
let _mutexTail = Promise.resolve();
function runExclusive(fn) {
  const prev = _mutexTail;
  let release;
  _mutexTail = new Promise(r => { release = r; });
  return prev.then(() => fn()).finally(() => release());
}

// --------------------------------------------------------------------------
// Safe write — handles quota errors by pruning the oldest unpinned snapshot
// and retrying once. This is defensive; with `unlimitedStorage` it should
// never actually trigger, but if the user revokes that permission we still
// degrade gracefully.
// --------------------------------------------------------------------------
async function safeSet(items, { retryOnQuota = true } = {}) {
  try {
    await area().set(items);
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (retryOnQuota && /quota|QUOTA/i.test(msg)) {
      const pruned = await _emergencyPrune();
      if (pruned) {
        try { await area().set(items); return true; }
        catch (e2) { throw new Error(`Storage quota exceeded even after pruning: ${e2.message || e2}`); }
      }
    }
    throw e;
  }
}

async function _emergencyPrune() {
  const idx = await _readIndex();
  // Drop oldest unpinned. If none, give up.
  const candidates = idx.filter(e => !e.pinned).sort((a, b) => a.timestamp - b.timestamp);
  if (candidates.length === 0) return false;
  const drop = candidates[0];
  await area().remove(KEYS.PREFIX + drop.id);
  await area().set({ [KEYS.INDEX]: idx.filter(e => e.id !== drop.id) });
  return true;
}

// --------------------------------------------------------------------------
// Settings
// --------------------------------------------------------------------------
export async function getSettings() {
  const { [KEYS.SETTINGS]: s } = await area().get(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function setSettings(partial) {
  return runExclusive(async () => {
    const cur = await getSettings();
    const next = { ...cur, ...partial };
    await safeSet({ [KEYS.SETTINGS]: next });
    return next;
  });
}

// --------------------------------------------------------------------------
// Profile id (stable per Chrome profile)
// --------------------------------------------------------------------------
export async function getProfileId() {
  const { [KEYS.PROFILE_ID]: pid } = await area().get(KEYS.PROFILE_ID);
  if (typeof pid === 'string' && pid.length > 0) return pid;
  const fresh = uuid();
  await safeSet({ [KEYS.PROFILE_ID]: fresh });
  return fresh;
}

export function shortProfileId(pid) {
  if (typeof pid !== 'string' || pid.length < 8) return '????????';
  return pid.slice(0, 8);
}

export async function getBrowserInfo() {
  const { [KEYS.BROWSER]: info } = await area().get(KEYS.BROWSER);
  return info && typeof info === 'object' ? info : { name: 'Chrome', lastSeen: 0 };
}

export async function setBrowserInfo(name) {
  if (!name || typeof name !== 'string') return;
  await safeSet({ [KEYS.BROWSER]: { name, lastSeen: Date.now() } });
}

// --------------------------------------------------------------------------
// Index + snapshots
// --------------------------------------------------------------------------
async function _readIndex() {
  const { [KEYS.INDEX]: idx } = await area().get(KEYS.INDEX);
  return Array.isArray(idx) ? idx : [];
}

export async function getIndex() {
  return _readIndex();
}

export async function getSnapshot(id) {
  const key = KEYS.PREFIX + id;
  const { [key]: snap } = await area().get(key);
  return snap || null;
}

export async function getAllSnapshots() {
  const idx = await _readIndex();
  if (idx.length === 0) return [];
  const keys = idx.map(e => KEYS.PREFIX + e.id);
  const data = await area().get(keys);
  return idx.map(e => data[KEYS.PREFIX + e.id]).filter(Boolean);
}

function makeIndexEntry(snap) {
  return {
    id: snap.id,
    name: snap.name,
    type: snap.type,
    timestamp: snap.timestamp,
    stats: snap.stats,
    pinned: !!snap.pinned
  };
}

export async function putSnapshot(snap) {
  return runExclusive(async () => {
    await safeSet({ [KEYS.PREFIX + snap.id]: snap });
    const idx = await _readIndex();
    const existing = idx.findIndex(e => e.id === snap.id);
    const entry = makeIndexEntry(snap);
    if (existing >= 0) idx[existing] = entry;
    else idx.unshift(entry);
    idx.sort((a, b) => b.timestamp - a.timestamp);
    await safeSet({ [KEYS.INDEX]: idx });
    await _enforceRetentionInLock();
    return snap;
  });
}

export async function deleteSnapshot(id) {
  return runExclusive(async () => {
    const idx = await _readIndex();
    const next = idx.filter(e => e.id !== id);
    await safeSet({ [KEYS.INDEX]: next });
    await area().remove(KEYS.PREFIX + id);
  });
}

export async function renameSnapshot(id, name) {
  return runExclusive(async () => {
    const snap = await getSnapshot(id);
    if (!snap) return null;
    snap.name = name;
    await safeSet({ [KEYS.PREFIX + snap.id]: snap });
    const idx = await _readIndex();
    const existing = idx.findIndex(e => e.id === id);
    if (existing >= 0) {
      idx[existing] = makeIndexEntry(snap);
      await safeSet({ [KEYS.INDEX]: idx });
    }
    return snap;
  });
}

export async function setPinned(id, pinned) {
  return runExclusive(async () => {
    const snap = await getSnapshot(id);
    if (!snap) return null;
    snap.pinned = !!pinned;
    await safeSet({ [KEYS.PREFIX + snap.id]: snap });
    const idx = await _readIndex();
    const existing = idx.findIndex(e => e.id === id);
    if (existing >= 0) {
      idx[existing] = makeIndexEntry(snap);
      await safeSet({ [KEYS.INDEX]: idx });
    }
    return snap;
  });
}

export async function enforceRetention() {
  return runExclusive(_enforceRetentionInLock);
}

async function _enforceRetentionInLock() {
  const settings = await getSettings();
  const max = settings.maxSnapshots | 0;
  if (max <= 0) return;
  const idx = await _readIndex();
  const pinned = idx.filter(e => e.pinned);
  const unpinned = idx.filter(e => !e.pinned);
  if (pinned.length + unpinned.length <= max) return;
  const keepUnpinned = unpinned.slice(0, Math.max(0, max - pinned.length));
  const keepIds = new Set([...pinned, ...keepUnpinned].map(e => e.id));
  const toDrop = idx.filter(e => !keepIds.has(e.id)).map(e => e.id);
  if (toDrop.length === 0) return;
  await area().remove(toDrop.map(id => KEYS.PREFIX + id));
  await safeSet({ [KEYS.INDEX]: idx.filter(e => keepIds.has(e.id)) });
}

// --------------------------------------------------------------------------
// Index repair — drop entries whose snapshot data key is missing.
// Run on startup; cheap when consistent (a single getAll batch read).
// --------------------------------------------------------------------------
export async function repairIndex() {
  return runExclusive(async () => {
    const idx = await _readIndex();
    if (idx.length === 0) return { removed: 0 };
    const keys = idx.map(e => KEYS.PREFIX + e.id);
    const data = await area().get(keys);
    const survivors = idx.filter(e => data[KEYS.PREFIX + e.id]);
    const removed = idx.length - survivors.length;
    if (removed > 0) await safeSet({ [KEYS.INDEX]: survivors });
    return { removed };
  });
}

// --------------------------------------------------------------------------
// Live (crash-recovery) snapshot
// Throttle is read from storage (LIVE_META.lastWriteTs) so it stays correct
// across service-worker restarts and isn't a module-scope footgun.
// --------------------------------------------------------------------------
const MIN_LIVE_WRITE_INTERVAL_MS = 2000;

export async function writeLive(snap, sessionId) {
  const { [KEYS.LIVE_META]: prior } = await area().get(KEYS.LIVE_META);
  const last = (prior && prior.lastWriteTs) || 0;
  const now = Date.now();
  if (now - last < MIN_LIVE_WRITE_INTERVAL_MS) return false;
  await safeSet({
    [KEYS.LIVE]: snap,
    [KEYS.LIVE_META]: { lastWriteTs: now, sessionId }
  });
  return true;
}

export async function readLive() {
  const { [KEYS.LIVE]: snap, [KEYS.LIVE_META]: meta } = await area().get([KEYS.LIVE, KEYS.LIVE_META]);
  return { snap: snap || null, meta: meta || null };
}

export async function clearLive() {
  await area().remove([KEYS.LIVE, KEYS.LIVE_META]);
}

// --------------------------------------------------------------------------
// Session id
// --------------------------------------------------------------------------
export async function getSession() {
  const { [KEYS.SESSION]: s } = await area().get(KEYS.SESSION);
  return s || null;
}

export async function setSession(sessionId) {
  await safeSet({ [KEYS.SESSION]: sessionId });
}

// --------------------------------------------------------------------------
// Usage
// --------------------------------------------------------------------------
export async function storageUsage() {
  return new Promise(resolve => {
    try { chrome.storage.local.getBytesInUse(null, (bytes) => resolve(bytes || 0)); }
    catch { resolve(0); }
  });
}
