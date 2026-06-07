// Tab Vault — background service worker.
//
// Responsibilities:
//   * onInstalled / onStartup bootstrapping (per-profile id, retention repair)
//   * Scheduled auto-snapshots via chrome.alarms
//   * Live (debounced) snapshots for crash recovery
//   * Crash detection on startup
//   * Keyboard command handling
//   * Message routing for popup + options pages

import { captureSnapshot, captureAndPersist } from './lib/snapshot.js';
import {
  getSettings, setSettings,
  getIndex, getAllSnapshots, getSnapshot,
  putSnapshot, deleteSnapshot, renameSnapshot, setPinned,
  writeLive, readLive, clearLive,
  getSession, setSession,
  getProfileId, shortProfileId,
  repairIndex,
  storageUsage
} from './lib/storage.js';
import { restoreSnapshot } from './lib/restore.js';
import { bundleIntoSessions, groupByDay, computeDiff, summarizeDiff } from './lib/sessions.js';
import { validateImportPayload, ValidationError } from './lib/validate.js';
import { buildBackupPayload, downloadBackup, postToWebhook } from './lib/backup.js';
import { uuid, debounce, formatDateFile } from './lib/utils.js';

// =====================================================================
// HARD INVARIANTS — DO NOT VIOLATE WITHOUT REMOVING THIS COMMENT
//
// 1. Tab Vault never opens tabs or windows automatically.
//    chrome.tabs.create and chrome.windows.create are reachable from exactly
//    one code path: the `restore` / `restore-latest` message, which is only
//    sent by an explicit user click in the popup or dashboard.
//
// 2. Tab Vault never closes, replaces, navigates, focuses, moves, or
//    otherwise mutates a user's tabs. The only call sites of
//    chrome.tabs.update, chrome.tabs.remove, chrome.windows.remove,
//    chrome.tabs.move are inside lib/restore.js — itself only reachable
//    from #1.
//
// 3. Chrome's native "Continue where you left off" session restore is
//    independent of Tab Vault. Tab Vault is a passive observer at startup:
//    it captures whatever tabs Chrome has already restored and writes them
//    to storage. It does not delay, block, interfere, or duplicate that
//    process. If Chrome restores your tabs on launch, you get those tabs.
//    Tab Vault's own restore is a manual backup option, not a replacement.
//
// All "alarms, tab events, startup, crash detection" code paths only READ
// from the browser and WRITE to chrome.storage.local. They never call any
// mutating Chrome API.
// =====================================================================

const ALARM_AUTO = 'tv-auto-snapshot';
const ALARM_LIVE_HEARTBEAT = 'tv-live-heartbeat';
const ALARM_HOURLY_BACKUP = 'tv-hourly-backup';

// --------------------------------------------------------------------------
// Init gate — every message handler awaits this so we never operate on
// half-initialised state (e.g. settings still loading on first install).
// --------------------------------------------------------------------------
let _ready = null;
function initOnce() {
  if (_ready) return _ready;
  _ready = (async () => {
    // Ensure defaults are persisted (no-op on subsequent runs).
    const settings = await getSettings();
    await setSettings(settings);
    // Ensure a profile id exists.
    await getProfileId();
    // Repair any orphaned index entries from a previous run.
    try { await repairIndex(); } catch (e) { console.warn('Tab Vault: index repair failed', e); }
  })();
  return _ready;
}

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  await initOnce();
  await beginSession({ snapshotKind: 'startup' });
  await rescheduleAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await initOnce();
  await beginSession({ snapshotKind: 'startup' });
  await rescheduleAlarms();
});

async function beginSession({ snapshotKind }) {
  const prevLive = await readLive();
  const newSessionId = uuid();
  await setSession(newSessionId);

  // Crash recovery: if a previous-session live snapshot exists, promote it
  // into the history as a "crash" snapshot. We DO NOT auto-open those tabs.
  if (prevLive.snap && prevLive.meta && prevLive.meta.sessionId !== newSessionId) {
    const tabs = countTabs(prevLive.snap);
    if (tabs > 0) {
      const snap = { ...prevLive.snap };
      snap.id = uuid();
      snap.type = 'crash';
      snap.name = `Recovered • ${tabs} tab${tabs === 1 ? '' : 's'}`;
      snap.timestamp = prevLive.meta.lastWriteTs || Date.now();
      await putSnapshot(snap);
      await setBadge('!', '#d97706');
    }
  }
  await clearLive();

  // Inline (no setTimeout) so the work is awaited before the service worker
  // can be unloaded. Chrome session-restore may not have finished by now;
  // tab events + the heartbeat alarm will fill in any tabs that arrive later.
  try { await captureAndPersist({ type: snapshotKind }); }
  catch (e) { console.warn('Tab Vault startup snapshot failed', e); }
  await writeLiveNow();
}

function countTabs(snap) {
  return (snap?.windows || []).reduce((a, w) => a + (w.tabs?.length || 0), 0);
}

// ---------- Alarms ----------

async function rescheduleAlarms() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_AUTO);
  await chrome.alarms.clear(ALARM_LIVE_HEARTBEAT);
  await chrome.alarms.clear(ALARM_HOURLY_BACKUP);
  if (s.autoSnapshotMinutes && s.autoSnapshotMinutes > 0) {
    chrome.alarms.create(ALARM_AUTO, {
      delayInMinutes: s.autoSnapshotMinutes,
      periodInMinutes: s.autoSnapshotMinutes
    });
  }
  if (s.liveSnapshotEnabled) {
    chrome.alarms.create(ALARM_LIVE_HEARTBEAT, { delayInMinutes: 1, periodInMinutes: 1 });
  }
  if (s.hourlyBackupEnabled) {
    const period = Math.max(1, s.hourlyBackupIntervalMinutes | 0 || 60);
    chrome.alarms.create(ALARM_HOURLY_BACKUP, { delayInMinutes: period, periodInMinutes: period });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await initOnce();
  if (alarm.name === ALARM_AUTO) {
    try { await captureAndPersist({ type: 'auto' }); } catch (e) { console.warn('auto snapshot failed', e); }
  } else if (alarm.name === ALARM_LIVE_HEARTBEAT) {
    await writeLiveNow();
  } else if (alarm.name === ALARM_HOURLY_BACKUP) {
    try { await runHourlyBackup('hourly'); } catch (e) { console.warn('hourly backup failed', e); }
  }
});

// ---------- Hourly backup driver ----------

async function runHourlyBackup(reason) {
  const s = await getSettings();
  if (!s.hourlyBackupEnabled) return { skipped: true, reason: 'disabled' };
  const payload = await buildBackupPayload({ reason });
  const results = { downloaded: null, posted: null };
  // Independent channels — one can fail without sinking the other.
  if (s.hourlyBackupDownload) {
    try { results.downloaded = await downloadBackup(payload); }
    catch (e) { results.downloaded = { ok: false, error: String(e?.message || e) }; }
  }
  if (s.hourlyBackupWebhookUrl) {
    try {
      results.posted = await postToWebhook(s.hourlyBackupWebhookUrl, payload, {
        secret: s.hourlyBackupWebhookSecret || ''
      });
    } catch (e) {
      results.posted = { ok: false, error: String(e?.message || e) };
    }
  }
  const statusLines = [];
  if (results.downloaded) statusLines.push(`download: ${results.downloaded.ok ? 'ok' : 'fail (' + (results.downloaded.error || '') + ')'}`);
  if (results.posted) statusLines.push(`webhook: ${results.posted.ok ? 'ok' : 'fail (' + (results.posted.error || results.posted.status) + ')'}`);
  const summary = statusLines.length ? statusLines.join(' · ') : 'no channels configured';
  await setSettings({
    hourlyBackupLastStatus: `${new Date().toLocaleString()} — ${summary}`,
    hourlyBackupLastRunAt: Date.now()
  });
  return { ok: true, results, summary };
}

// ---------- Live snapshot (crash recovery) ----------

const writeLiveDebounced = debounce(writeLiveNow, 4000);

async function writeLiveNow() {
  const s = await getSettings();
  if (!s.liveSnapshotEnabled) return;
  try {
    const snap = await captureSnapshot({ type: 'live' });
    const sessionId = await getSession();
    await writeLive(snap, sessionId);
  } catch (e) {
    console.warn('Tab Vault: failed to write live snapshot', e);
  }
}

function hookTabEvents() {
  const events = [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onUpdated,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
    chrome.tabs.onReplaced,
    chrome.windows.onCreated,
    chrome.windows.onRemoved
  ];
  for (const ev of events) {
    if (ev && ev.addListener) ev.addListener(() => writeLiveDebounced());
  }
  if (chrome.tabGroups?.onCreated) chrome.tabGroups.onCreated.addListener(() => writeLiveDebounced());
  if (chrome.tabGroups?.onUpdated) chrome.tabGroups.onUpdated.addListener(() => writeLiveDebounced());
  if (chrome.tabGroups?.onRemoved) chrome.tabGroups.onRemoved.addListener(() => writeLiveDebounced());
  if (chrome.tabGroups?.onMoved)   chrome.tabGroups.onMoved.addListener(() => writeLiveDebounced());
}
hookTabEvents();

// ---------- Commands ----------

chrome.commands.onCommand.addListener(async (command) => {
  await initOnce();
  if (command === 'save-snapshot') {
    const snap = await captureAndPersist({ type: 'manual' });
    await setBadge(String(snap.stats.tabCount), '#16a34a');
    setTimeout(() => setBadge('', ''), 3000);
  } else if (command === 'open-dashboard') {
    chrome.runtime.openOptionsPage();
  }
});

// ---------- Messaging ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  initOnce()
    .then(() => handleMessage(msg))
    .then(sendResponse)
    .catch(e => sendResponse({ error: String(e?.message || e) }));
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'ping':
      return { ok: true };
    case 'get-current-stats': {
      const wins = await chrome.windows.getAll({ populate: true });
      const filtered = wins.filter(w => !w.incognito);
      let tabs = 0, pinned = 0;
      for (const w of filtered) {
        tabs += (w.tabs || []).length;
        pinned += (w.tabs || []).filter(t => t.pinned).length;
      }
      let groups = 0;
      if (chrome.tabGroups?.query) {
        try { groups = (await chrome.tabGroups.query({})).length; } catch {}
      }
      return { windows: filtered.length, tabs, groups, pinned };
    }
    case 'get-profile': {
      const profileId = await getProfileId();
      const s = await getSettings();
      return { profileId, profileLabel: s.profileLabel || '', shortId: shortProfileId(profileId) };
    }
    case 'list-index': {
      return { index: await getIndex(), usage: await storageUsage() };
    }
    case 'get-timeline': {
      const s = await getSettings();
      const idx = await getIndex();
      const sessions = bundleIntoSessions(idx, s.sessionGapMinutes ?? 60);
      for (const sess of sessions) {
        for (let i = 0; i < sess.snapshots.length; i++) {
          const cur = sess.snapshots[i];
          const prev = sess.snapshots[i + 1] || null;
          if (!prev) { cur._diffSummary = null; continue; }
          const da = (cur.stats?.tabCount ?? 0) - (prev.stats?.tabCount ?? 0);
          if (da > 0) cur._diffSummary = `+${da}`;
          else if (da < 0) cur._diffSummary = `−${-da}`;
          else cur._diffSummary = '·';
        }
      }
      const days = groupByDay(sessions);
      return { days, sessions, usage: await storageUsage(), settings: s };
    }
    case 'get-diff': {
      const a = await getSnapshot(msg.fromId);
      const b = await getSnapshot(msg.toId);
      if (!a || !b) throw new Error('Snapshot not found');
      const diff = computeDiff(a, b);
      return { diff, summary: summarizeDiff(diff) };
    }
    case 'restore-latest': {
      const idx = await getIndex();
      if (idx.length === 0) throw new Error('No snapshots to restore');
      const newest = idx[0];
      const snap = await getSnapshot(newest.id);
      if (!snap) throw new Error('Snapshot no longer available');
      // Safety net: take a pre-restore snapshot so the user can always roll back.
      try { await captureAndPersist({ type: 'pre-restore', name: 'Before restore (auto-saved)' }); } catch {}
      const result = await restoreSnapshot(snap, { mode: msg.mode || 'new-windows' });
      return { restored: result.restored, id: newest.id, name: newest.name };
    }
    case 'get-snapshot':
      return { snapshot: await getSnapshot(msg.id) };
    case 'capture': {
      const snap = await captureAndPersist({ type: msg.snapshotType || 'manual', name: msg.name });
      return { snapshot: snap };
    }
    case 'delete':
      await deleteSnapshot(msg.id);
      return { ok: true };
    case 'rename':
      return { snapshot: await renameSnapshot(msg.id, msg.name) };
    case 'pin':
      return { snapshot: await setPinned(msg.id, msg.pinned) };
    case 'restore': {
      const snap = await getSnapshot(msg.id);
      if (!snap) throw new Error('Snapshot no longer available');
      // Safety net: always take a pre-restore snapshot before any restore.
      try { await captureAndPersist({ type: 'pre-restore', name: 'Before restore (auto-saved)' }); } catch {}
      const selection = deserializeSelection(msg.options?.selection);
      const result = await restoreSnapshot(snap, { ...msg.options, selection });
      return result;
    }
    case 'get-settings':
      return { settings: await getSettings() };
    case 'set-settings': {
      const next = await setSettings(msg.patch || {});
      await rescheduleAlarms();
      return { settings: next };
    }
    case 'export-all': {
      const settings = await getSettings();
      const profileId = await getProfileId();
      const data = {
        kind: 'tab-vault-export',
        version: 1,
        exportedAt: Date.now(),
        profileId,
        profileLabel: settings.profileLabel || '',
        settings,
        snapshots: await getAllSnapshots()
      };
      const filename = exportFilename(settings.profileLabel, profileId, Date.now());
      return { data, filename };
    }
    case 'export-one': {
      const snap = await getSnapshot(msg.id);
      if (!snap) throw new Error('Snapshot not found');
      const settings = await getSettings();
      const profileId = await getProfileId();
      return {
        data: {
          kind: 'tab-vault-snapshot',
          version: 1,
          profileId,
          profileLabel: settings.profileLabel || '',
          snapshot: snap
        },
        filename: exportFilename(settings.profileLabel, profileId, snap.timestamp)
      };
    }
    case 'inspect-import': {
      // Read-only: returns metadata about a payload so the UI can show a
      // cross-profile warning before committing to the import.
      try {
        const parsed = validateImportPayload(msg.payload);
        const profileId = await getProfileId();
        const settings = await getSettings();
        return {
          ok: true,
          kind: parsed.kind,
          count: parsed.snapshots.length,
          fromProfileId: parsed.profileId,
          fromProfileLabel: parsed.profileLabel,
          currentProfileId: profileId,
          currentProfileLabel: settings.profileLabel || '',
          isSameProfile: !parsed.profileId || parsed.profileId === profileId
        };
      } catch (e) {
        return { ok: false, validationError: e instanceof ValidationError ? e.message : String(e?.message || e) };
      }
    }
    case 'import': {
      return importPayload(msg.payload, !!msg.merge);
    }
    case 'clear-all': {
      const idx = await getIndex();
      for (const e of idx) await deleteSnapshot(e.id);
      await clearLive();
      return { ok: true };
    }
    case 'recompute-alarms':
      await rescheduleAlarms();
      return { ok: true };
    case 'run-backup-now': {
      const result = await runHourlyBackup('manual');
      return result;
    }
    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}

function deserializeSelection(sel) {
  if (!sel) return null;
  const out = {};
  if (Array.isArray(sel.windowIds)) out.windowIds = new Set(sel.windowIds);
  if (Array.isArray(sel.tabKeys)) out.tabKeys = new Set(sel.tabKeys);
  return out;
}

async function importPayload(payload, merge) {
  // Validate strictly before touching storage. If anything is malformed we
  // reject the whole import — never partially apply.
  let parsed;
  try { parsed = validateImportPayload(payload); }
  catch (e) {
    if (e instanceof ValidationError) throw new Error(`Invalid file: ${e.message}`);
    throw e;
  }

  // For multi-snapshot exports, optional non-merge mode wipes existing data.
  if (parsed.kind === 'export' && !merge) {
    const idx = await getIndex();
    for (const e of idx) await deleteSnapshot(e.id);
  }

  let imported = 0;
  for (const snap of parsed.snapshots) {
    const copy = { ...snap, id: uuid(), type: snap.type || 'import' };
    if (!copy.name) copy.name = `Imported • ${imported + 1}`;
    if (!copy.timestamp) copy.timestamp = Date.now();
    copy.pinned = !!copy.pinned;
    await putSnapshot(copy);
    imported += 1;
  }
  return { imported, fromProfileId: parsed.profileId, fromProfileLabel: parsed.profileLabel };
}

function exportFilename(label, profileId, ts) {
  const safeLabel = (label || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
  const tag = safeLabel || shortProfileId(profileId);
  return `tab-vault-${tag}-${formatDateFile(ts || Date.now())}.json`;
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}
