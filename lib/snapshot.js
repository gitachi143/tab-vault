// Snapshot capture. Reads all windows, tabs, and tab groups and produces a
// self-contained, restorable record.

import { uuid, nowMs, formatDate } from './utils.js';
import { putSnapshot } from './storage.js';

export const SNAPSHOT_SCHEMA = 1;

function pickTab(t) {
  return {
    id: t.id,
    url: t.url || t.pendingUrl || '',
    title: t.title || '',
    favIconUrl: t.favIconUrl || '',
    pinned: !!t.pinned,
    active: !!t.active,
    index: t.index ?? 0,
    groupId: t.groupId ?? -1,
    incognito: !!t.incognito,
    audible: !!t.audible,
    mutedInfo: t.mutedInfo || null
  };
}

function pickGroup(g) {
  return {
    id: g.id,
    title: g.title || '',
    color: g.color || 'grey',
    collapsed: !!g.collapsed
  };
}

async function getGroupsForWindow(windowId) {
  if (!chrome.tabGroups?.query) return [];
  try {
    const groups = await chrome.tabGroups.query({ windowId });
    return groups.map(pickGroup);
  } catch {
    return [];
  }
}

export async function captureSnapshot({ type = 'manual', name = null } = {}) {
  const windows = await chrome.windows.getAll({ populate: true });
  const wOut = [];
  let tabCount = 0;
  let groupCount = 0;
  let pinnedCount = 0;

  for (const w of windows) {
    if (w.incognito) continue; // never capture incognito; restoring it is unreliable and a privacy footgun
    const tabs = (w.tabs || []).map(pickTab);
    const groups = await getGroupsForWindow(w.id);
    tabCount += tabs.length;
    pinnedCount += tabs.filter(t => t.pinned).length;
    groupCount += groups.length;
    wOut.push({
      windowId: w.id,
      focused: !!w.focused,
      state: w.state || 'normal',
      type: w.type || 'normal',
      top: w.top, left: w.left, width: w.width, height: w.height,
      tabs,
      groups
    });
  }

  const id = uuid();
  const ts = nowMs();
  const snap = {
    id,
    schema: SNAPSHOT_SCHEMA,
    name: name || defaultName(type, ts),
    type,
    timestamp: ts,
    windows: wOut,
    stats: {
      tabCount,
      windowCount: wOut.length,
      groupCount,
      pinnedCount
    }
  };
  return snap;
}

export async function captureAndPersist(opts) {
  const snap = await captureSnapshot(opts);
  await putSnapshot(snap);
  return snap;
}

function defaultName(type, ts) {
  const label = {
    manual: 'Snapshot',
    auto: 'Auto-snapshot',
    startup: 'Startup snapshot',
    crash: 'Recovered snapshot',
    'pre-restore': 'Pre-restore snapshot',
    import: 'Imported snapshot'
  }[type] || 'Snapshot';
  return `${label} • ${formatDate(ts)}`;
}
