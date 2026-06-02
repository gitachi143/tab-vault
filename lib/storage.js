// Storage layer for Tab Vault. Snapshots are kept under individual keys
// (snap:<id>) so we never have to load every snapshot to read one, and a
// lightweight index (snap:index) lists ids+metadata for fast UI rendering.

export const KEYS = {
  INDEX: 'snap:index',
  SETTINGS: 'tv:settings',
  LIVE: 'tv:live',           // rolling snapshot for crash recovery
  LIVE_META: 'tv:live_meta', // { lastWriteTs, sessionId }
  SESSION: 'tv:session',     // current session id (set on onStartup)
  PREFIX: 'snap:'
};

export const DEFAULT_SETTINGS = {
  // Tab Vault is history-first. Defaults favour denser logging over
  // restoration. Restoration is exclusively user-initiated.
  autoSnapshotMinutes: 10,     // 0 disables. Dense by default so the history is useful.
  maxSnapshots: 200,           // 0 = unlimited. With 10-min cadence that's ~33h of dense history.
  liveSnapshotEnabled: true,   // continuously updated; *not* used for auto-restore
  liveSnapshotDebounceMs: 4000,
  sessionGapMinutes: 60,       // gaps longer than this split into a new session
  theme: 'auto',               // 'auto' | 'light' | 'dark'
  confirmRestore: true,        // restore always shows an explicit confirmation
  schemaVersion: 1
};

function area() {
  return chrome.storage.local;
}

export async function getSettings() {
  const { [KEYS.SETTINGS]: s } = await area().get(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function setSettings(partial) {
  const cur = await getSettings();
  const next = { ...cur, ...partial };
  await area().set({ [KEYS.SETTINGS]: next });
  return next;
}

export async function getIndex() {
  const { [KEYS.INDEX]: idx } = await area().get(KEYS.INDEX);
  return Array.isArray(idx) ? idx : [];
}

async function setIndex(idx) {
  await area().set({ [KEYS.INDEX]: idx });
}

export async function getSnapshot(id) {
  const key = KEYS.PREFIX + id;
  const { [key]: snap } = await area().get(key);
  return snap || null;
}

export async function getAllSnapshots() {
  const idx = await getIndex();
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
  await area().set({ [KEYS.PREFIX + snap.id]: snap });
  const idx = await getIndex();
  const existing = idx.findIndex(e => e.id === snap.id);
  const entry = makeIndexEntry(snap);
  if (existing >= 0) idx[existing] = entry;
  else idx.unshift(entry);
  idx.sort((a, b) => b.timestamp - a.timestamp);
  await setIndex(idx);
  await enforceRetention();
  return snap;
}

export async function deleteSnapshot(id) {
  const idx = await getIndex();
  const next = idx.filter(e => e.id !== id);
  await setIndex(next);
  await area().remove(KEYS.PREFIX + id);
}

export async function renameSnapshot(id, name) {
  const snap = await getSnapshot(id);
  if (!snap) return null;
  snap.name = name;
  await putSnapshot(snap);
  return snap;
}

export async function setPinned(id, pinned) {
  const snap = await getSnapshot(id);
  if (!snap) return null;
  snap.pinned = !!pinned;
  await putSnapshot(snap);
  return snap;
}

export async function enforceRetention() {
  const settings = await getSettings();
  const max = settings.maxSnapshots | 0;
  if (max <= 0) return;
  const idx = await getIndex();
  // Always keep pinned + the most recent N regardless of pin state.
  const pinned = idx.filter(e => e.pinned);
  const unpinned = idx.filter(e => !e.pinned);
  if (pinned.length + unpinned.length <= max) return;
  const keepUnpinned = unpinned.slice(0, Math.max(0, max - pinned.length));
  const keepIds = new Set([...pinned, ...keepUnpinned].map(e => e.id));
  const toDrop = idx.filter(e => !keepIds.has(e.id)).map(e => e.id);
  if (toDrop.length === 0) return;
  await area().remove(toDrop.map(id => KEYS.PREFIX + id));
  await setIndex(idx.filter(e => keepIds.has(e.id)));
}

// Live (crash-recovery) snapshot is stored under a dedicated key so it never
// pollutes the main snapshot index.
export async function writeLive(snap, sessionId) {
  await area().set({
    [KEYS.LIVE]: snap,
    [KEYS.LIVE_META]: { lastWriteTs: Date.now(), sessionId }
  });
}

export async function readLive() {
  const { [KEYS.LIVE]: snap, [KEYS.LIVE_META]: meta } = await area().get([KEYS.LIVE, KEYS.LIVE_META]);
  return { snap: snap || null, meta: meta || null };
}

export async function clearLive() {
  await area().remove([KEYS.LIVE, KEYS.LIVE_META]);
}

export async function getSession() {
  const { [KEYS.SESSION]: s } = await area().get(KEYS.SESSION);
  return s || null;
}

export async function setSession(sessionId) {
  await area().set({ [KEYS.SESSION]: sessionId });
}

export async function storageUsage() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.getBytesInUse(null, (bytes) => resolve(bytes || 0));
    } catch {
      resolve(0);
    }
  });
}
