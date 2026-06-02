// Tab Vault — background service worker.
//
// Responsibilities:
//   * onInstalled / onStartup bootstrapping
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
  storageUsage
} from './lib/storage.js';
import { restoreSnapshot } from './lib/restore.js';
import { bundleIntoSessions, groupByDay, computeDiff, summarizeDiff } from './lib/sessions.js';
import { uuid, debounce, formatDateFile } from './lib/utils.js';

// =====================================================================
// HARD INVARIANT: Tab Vault never opens tabs or windows automatically.
// chrome.tabs.create and chrome.windows.create are reachable from exactly
// one code path: the `restore` message, which is only sent by an explicit
// user click in the popup or dashboard. Everything else (alarms, tab
// events, startup, crash detection) only READS and WRITES storage.
// Do not add automatic-restore behaviour without removing this comment.
// =====================================================================

const ALARM_AUTO = 'tv-auto-snapshot';
const ALARM_LIVE_HEARTBEAT = 'tv-live-heartbeat';

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await setSettings(settings); // persist defaults
  await beginSession({ snapshotKind: 'startup' });
  await rescheduleAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await beginSession({ snapshotKind: 'startup' });
  await rescheduleAlarms();
});

async function beginSession({ snapshotKind }) {
  const prevLive = await readLive();
  const newSessionId = uuid();
  await setSession(newSessionId);

  // If we had a live snapshot from a *different* session that has tabs,
  // surface it as a crash-recovery candidate by promoting it to a real snapshot.
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
  if (s.autoSnapshotMinutes && s.autoSnapshotMinutes > 0) {
    chrome.alarms.create(ALARM_AUTO, {
      delayInMinutes: s.autoSnapshotMinutes,
      periodInMinutes: s.autoSnapshotMinutes
    });
  }
  if (s.liveSnapshotEnabled) {
    // Heartbeat at 1-minute resolution; this is the minimum chrome.alarms allows.
    chrome.alarms.create(ALARM_LIVE_HEARTBEAT, { delayInMinutes: 1, periodInMinutes: 1 });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_AUTO) {
    try { await captureAndPersist({ type: 'auto' }); } catch (e) { console.warn('auto snapshot failed', e); }
  } else if (alarm.name === ALARM_LIVE_HEARTBEAT) {
    await writeLiveNow();
  }
});

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
  handleMessage(msg).then(sendResponse).catch(e => sendResponse({ error: String(e?.message || e) }));
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
    case 'list-index': {
      return { index: await getIndex(), usage: await storageUsage() };
    }
    case 'get-timeline': {
      const s = await getSettings();
      const idx = await getIndex();
      const sessions = bundleIntoSessions(idx, s.sessionGapMinutes ?? 60);
      // Attach a diff summary for every snapshot vs. the previous one in the
      // same session. We only pre-compute the summary (light); full diffs are
      // fetched on demand via 'get-diff'.
      for (const sess of sessions) {
        // snapshots in sess.snapshots are newest-first; pair each with the
        // older neighbour for "what changed since last save".
        for (let i = 0; i < sess.snapshots.length; i++) {
          const cur = sess.snapshots[i];
          const prev = sess.snapshots[i + 1] || null;
          if (!prev) { cur._diffSummary = null; continue; }
          // Cheap derivation from stats only — for the badge we don't need the
          // full URL diff. The detail view will compute the precise diff.
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
      // Convenience shortcut for the popup's single restore button.
      // Still routed through the same explicit `restore` plumbing — there is
      // NO automatic invocation of this path anywhere in the codebase.
      const idx = await getIndex();
      if (idx.length === 0) throw new Error('No snapshots to restore');
      const newest = idx[0];
      const snap = await getSnapshot(newest.id);
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
      if (!snap) throw new Error('Snapshot not found');
      // Defensive: save current state before destructive restores so users can undo.
      if (msg.options?.closeOthers) {
        try { await captureAndPersist({ type: 'pre-restore' }); } catch {}
      }
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
      const data = {
        kind: 'tab-vault-export',
        version: 1,
        exportedAt: Date.now(),
        settings: await getSettings(),
        snapshots: await getAllSnapshots()
      };
      const filename = `tab-vault-${formatDateFile(Date.now())}.json`;
      return { data, filename };
    }
    case 'export-one': {
      const snap = await getSnapshot(msg.id);
      if (!snap) throw new Error('Snapshot not found');
      return {
        data: { kind: 'tab-vault-snapshot', version: 1, snapshot: snap },
        filename: `tab-vault-${formatDateFile(snap.timestamp)}.json`
      };
    }
    case 'import': {
      const result = await importPayload(msg.payload, !!msg.merge);
      return result;
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
  if (!payload || typeof payload !== 'object') throw new Error('Invalid import payload');
  let imported = 0;
  const accept = async (snap) => {
    if (!snap || !Array.isArray(snap.windows)) return;
    const copy = { ...snap, id: uuid(), type: snap.type || 'import' };
    if (!copy.name) copy.name = `Imported • ${imported + 1}`;
    if (!copy.timestamp) copy.timestamp = Date.now();
    await putSnapshot(copy);
    imported += 1;
  };

  if (payload.kind === 'tab-vault-snapshot' && payload.snapshot) {
    await accept(payload.snapshot);
  } else if (payload.kind === 'tab-vault-export' && Array.isArray(payload.snapshots)) {
    if (!merge) {
      const idx = await getIndex();
      for (const e of idx) await deleteSnapshot(e.id);
    }
    for (const s of payload.snapshots) await accept(s);
  } else if (Array.isArray(payload.windows)) {
    // Looks like a bare snapshot
    await accept(payload);
  } else {
    throw new Error('Unrecognized file format');
  }
  return { imported };
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}
