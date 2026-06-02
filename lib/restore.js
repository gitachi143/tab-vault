// Restoration. Recreates windows, tabs, pinned state, and tab groups
// (title + color + collapsed) from a snapshot.

import { normalizeUrlForRestore } from './utils.js';

/**
 * mode:
 *   'new-windows'   — one new window per saved window (default)
 *   'single-window' — all tabs in a single new window
 *   'current'       — append to current focused window
 *   'selected'      — restore only the given selection (see opts.selection)
 *
 * opts.selection: { windowIds?: Set<number>, tabKeys?: Set<string> }
 *   where tabKey = `${windowId}:${tabIndex}`
 *
 * opts.closeOthers: boolean — close all other windows after restore
 */
export async function restoreSnapshot(snapshot, opts = {}) {
  const mode = opts.mode || 'new-windows';
  const filtered = filterSnapshot(snapshot, opts.selection);
  if (filtered.windows.length === 0) return { restored: 0 };

  // Track windows that existed *before* restore so closeOthers can remove
  // them without nuking the windows we just created.
  let preExistingIds = null;
  if (opts.closeOthers) {
    const wins = await chrome.windows.getAll();
    preExistingIds = new Set(wins.map(w => w.id));
  }

  let restored = 0;
  if (mode === 'current') {
    const cur = await chrome.windows.getCurrent();
    for (const w of filtered.windows) {
      restored += await appendToWindow(cur.id, w);
    }
    // closeOthers under 'current' means: close every other window, keep current.
    if (opts.closeOthers && preExistingIds) preExistingIds.delete(cur.id);
  } else if (mode === 'single-window') {
    const combined = combineWindows(filtered.windows);
    restored += await openOneWindow(combined);
  } else {
    // new-windows
    for (const w of filtered.windows) {
      restored += await openOneWindow(w);
    }
  }

  if (opts.closeOthers && preExistingIds) {
    for (const id of preExistingIds) {
      try { await chrome.windows.remove(id); } catch {}
    }
  }
  return { restored };
}

function filterSnapshot(snapshot, selection) {
  if (!selection) return snapshot;
  const wantedW = selection.windowIds instanceof Set ? selection.windowIds : null;
  const wantedT = selection.tabKeys instanceof Set ? selection.tabKeys : null;
  if (!wantedW && !wantedT) return snapshot;
  const out = { ...snapshot, windows: [] };
  for (const w of snapshot.windows) {
    const fullWindow = wantedW ? wantedW.has(w.windowId) : false;
    let tabs;
    if (fullWindow) {
      tabs = w.tabs;
    } else if (wantedT) {
      tabs = w.tabs.filter(t => wantedT.has(`${w.windowId}:${t.index}`));
    } else {
      // wantedW is set but this window isn't in it, and no per-tab filter
      continue;
    }
    if (tabs.length === 0) continue;
    out.windows.push({ ...w, tabs });
  }
  return out;
}

function combineWindows(windows) {
  const allTabs = [];
  const allGroups = [];
  const groupOffset = new Map();
  let nextIndex = 0;
  for (const w of windows) {
    const indexShift = nextIndex;
    for (const t of w.tabs) {
      allTabs.push({ ...t, index: t.index + indexShift });
    }
    nextIndex += w.tabs.length;
    for (const g of w.groups) {
      // We keep groups conceptually; group IDs are rewritten on restore anyway.
      allGroups.push({ ...g, _origWindowId: w.windowId });
    }
  }
  return {
    ...windows[0],
    tabs: allTabs,
    groups: allGroups
  };
}

async function openOneWindow(w) {
  const tabs = w.tabs.slice().sort((a, b) => a.index - b.index);
  if (tabs.length === 0) return 0;
  const urls = tabs.map(t => normalizeUrlForRestore(t.url));
  const createInfo = {
    url: urls,
    focused: false,
    state: ['normal', 'maximized', 'minimized', 'fullscreen'].includes(w.state) ? w.state : 'normal'
  };
  // Bounds only apply when state is 'normal'.
  if (createInfo.state === 'normal') {
    if (Number.isFinite(w.top)) createInfo.top = w.top;
    if (Number.isFinite(w.left)) createInfo.left = w.left;
    if (Number.isFinite(w.width)) createInfo.width = w.width;
    if (Number.isFinite(w.height)) createInfo.height = w.height;
  }
  const win = await chrome.windows.create(createInfo);
  // Map newly-created tabs (in order) to the snapshot tabs (in order).
  const newTabs = (win.tabs || []).slice().sort((a, b) => a.index - b.index);
  await applyTabState(newTabs, tabs);
  await applyGroups(win.id, newTabs, tabs, w.groups || []);
  return tabs.length;
}

async function appendToWindow(windowId, w) {
  const tabs = w.tabs.slice().sort((a, b) => a.index - b.index);
  const created = [];
  for (const t of tabs) {
    const nt = await chrome.tabs.create({
      windowId,
      url: normalizeUrlForRestore(t.url),
      pinned: !!t.pinned,
      active: false
    });
    created.push(nt);
  }
  await applyGroups(windowId, created, tabs, w.groups || []);
  return tabs.length;
}

async function applyTabState(newTabs, snapTabs) {
  const pairs = newTabs.map((nt, i) => [nt, snapTabs[i]]).filter(([_, s]) => s);
  await Promise.all(pairs.map(async ([nt, s]) => {
    const updates = {};
    if (s.pinned) updates.pinned = true;
    if (s.mutedInfo?.muted) updates.muted = true;
    if (Object.keys(updates).length) {
      try { await chrome.tabs.update(nt.id, updates); } catch {}
    }
  }));
  const activeSnap = snapTabs.findIndex(t => t.active);
  if (activeSnap >= 0 && newTabs[activeSnap]) {
    try { await chrome.tabs.update(newTabs[activeSnap].id, { active: true }); } catch {}
  }
}

async function applyGroups(windowId, newTabs, snapTabs, groups) {
  if (!chrome.tabs.group || !chrome.tabGroups || groups.length === 0) return;
  const byGroup = new Map();
  for (let i = 0; i < snapTabs.length; i++) {
    const s = snapTabs[i];
    if (s.groupId == null || s.groupId === -1) continue;
    const nt = newTabs[i];
    if (!nt) continue;
    if (!byGroup.has(s.groupId)) byGroup.set(s.groupId, []);
    byGroup.get(s.groupId).push(nt.id);
  }
  for (const g of groups) {
    const tabIds = byGroup.get(g.id);
    if (!tabIds || tabIds.length === 0) continue;
    try {
      const newGroupId = await chrome.tabs.group({ createProperties: { windowId }, tabIds });
      await chrome.tabGroups.update(newGroupId, {
        title: g.title || '',
        color: g.color || 'grey',
        collapsed: !!g.collapsed
      });
    } catch (e) {
      console.warn('Tab Vault: failed to recreate group', g, e);
    }
  }
}

