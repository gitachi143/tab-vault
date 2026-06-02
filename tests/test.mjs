// Integration test suite for Tab Vault.
//
// We install a mock chrome.* on globalThis, then dynamically import the lib
// modules so they pick it up.

import { createMockChrome } from './mock-chrome.mjs';

const harness = createMockChrome();
globalThis.chrome = harness.chromeApi;
// stub console.warn so noisy paths don't pollute test output
const realWarn = console.warn;
console.warn = () => {};

const { seedWindow, reset, state } = harness;

// Dynamic imports AFTER globalThis.chrome is set
const utils    = await import('../lib/utils.js');
const storage  = await import('../lib/storage.js');
const snapshot = await import('../lib/snapshot.js');
const restore  = await import('../lib/restore.js');

let pass = 0, fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.log('  ✗', msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  assert(a === b, `${msg} — expected ${b}, got ${a}`);
}
function group(name, fn) {
  console.log('\n▸', name);
  return fn();
}

// ============================================================
group('utils', () => {
  assert(typeof utils.uuid() === 'string', 'uuid returns string');
  assert(utils.uuid() !== utils.uuid(), 'uuid is unique');
  assert(/^\d{4}-\d{2}-\d{2}/.test(utils.formatDate(Date.now())), 'formatDate format');
  assert(utils.normalizeUrlForRestore('chrome://newtab/') === 'chrome://newtab/', 'newtab pass through');
  assert(utils.normalizeUrlForRestore('chrome-search://local-ntp/local-ntp.html') === 'chrome://newtab/', 'chrome-search normalized');
  assert(utils.normalizeUrlForRestore('about:newtab') === 'chrome://newtab/', 'about:newtab normalized');
  assert(utils.normalizeUrlForRestore('https://example.com/') === 'https://example.com/', 'normal URL untouched');
  assert(utils.normalizeUrlForRestore('') === 'chrome://newtab/', 'empty URL → newtab');
  assert(utils.safeHostname('https://foo.com/x') === 'foo.com', 'safeHostname');
  assert(utils.safeHostname('not a url') === 'not a url', 'safeHostname fallback');
  assert(/just now|s ago/.test(utils.relativeTime(Date.now())), 'relativeTime now');
  assert(utils.bytesHuman(500) === '500 B', 'bytesHuman B');
  assert(utils.bytesHuman(2048).includes('KB'), 'bytesHuman KB');
  assert(utils.bytesHuman(5 * 1024 * 1024).includes('MB'), 'bytesHuman MB');
});

// ============================================================
await group('storage: settings round-trip', async () => {
  reset();
  const s1 = await storage.getSettings();
  eq(s1.autoSnapshotMinutes, storage.DEFAULT_SETTINGS.autoSnapshotMinutes, 'default autoSnapshotMinutes');
  await storage.setSettings({ autoSnapshotMinutes: 60, theme: 'dark' });
  const s2 = await storage.getSettings();
  eq(s2.autoSnapshotMinutes, 60, 'persisted autoSnapshotMinutes');
  eq(s2.theme, 'dark', 'persisted theme');
  eq(s2.maxSnapshots, storage.DEFAULT_SETTINGS.maxSnapshots, 'other defaults preserved');
});

// ============================================================
await group('snapshot: capture basics', async () => {
  reset();
  // Seed two windows with mixed tabs, pins, groups
  seedWindow({
    focused: true,
    tabs: [
      { url: 'https://a.com/', title: 'A', pinned: true, active: false },
      { url: 'https://b.com/', title: 'B', active: true },
      { url: 'https://c.com/', title: 'C', groupId: 100 },
      { url: 'https://d.com/', title: 'D', groupId: 100 }
    ],
    groups: [{ id: 100, title: 'Work', color: 'blue', collapsed: false }]
  });
  seedWindow({
    tabs: [
      { url: 'chrome://newtab/', title: 'New' },
      { url: 'https://e.com/', title: 'E' }
    ]
  });

  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  eq(snap.windows.length, 2, 'two windows captured');
  eq(snap.stats.tabCount, 6, 'tabCount 6');
  eq(snap.stats.groupCount, 1, 'groupCount 1');
  eq(snap.stats.pinnedCount, 1, 'pinnedCount 1');
  assert(snap.windows[0].focused === true, 'first window focused');
  assert(snap.windows[0].tabs[0].pinned === true, 'tab pinned preserved');
  assert(snap.windows[0].tabs[2].groupId === 100, 'groupId preserved');
  assert(snap.windows[0].groups[0].color === 'blue', 'group color preserved');
  assert(snap.schema === snapshot.SNAPSHOT_SCHEMA, 'schema set');
  assert(snap.type === 'manual', 'type set');
});

// ============================================================
await group('storage: put/get/delete/list', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });

  const snap1 = await snapshot.captureSnapshot({ type: 'manual', name: 'first' });
  await storage.putSnapshot(snap1);
  const snap2 = await snapshot.captureSnapshot({ type: 'auto' });
  snap2.timestamp = snap1.timestamp + 1000;
  await storage.putSnapshot(snap2);

  const idx = await storage.getIndex();
  eq(idx.length, 2, 'index has 2');
  assert(idx[0].timestamp >= idx[1].timestamp, 'index sorted desc by timestamp');

  const fetched = await storage.getSnapshot(snap1.id);
  assert(fetched && fetched.name === 'first', 'getSnapshot');

  await storage.renameSnapshot(snap1.id, 'renamed');
  const r = await storage.getSnapshot(snap1.id);
  eq(r.name, 'renamed', 'rename persists');
  const idx2 = await storage.getIndex();
  assert(idx2.find(e => e.id === snap1.id).name === 'renamed', 'rename reflected in index');

  await storage.setPinned(snap1.id, true);
  const p = await storage.getSnapshot(snap1.id);
  assert(p.pinned === true, 'pin persists');

  await storage.deleteSnapshot(snap2.id);
  const idx3 = await storage.getIndex();
  eq(idx3.length, 1, 'after delete');
  const gone = await storage.getSnapshot(snap2.id);
  assert(gone === null, 'deleted snapshot is gone');
});

// ============================================================
await group('storage: retention prunes oldest, keeps pinned', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 3 });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  // Insert 5 snapshots with increasing timestamps
  const made = [];
  for (let i = 0; i < 5; i++) {
    const s = await snapshot.captureSnapshot({ type: 'auto' });
    s.timestamp = 1_000_000 + i * 1000;
    s.name = 'snap-' + i;
    await storage.putSnapshot(s);
    made.push(s);
  }
  const idx = await storage.getIndex();
  eq(idx.length, 3, 'retention to 3');
  // Expect the latest 3 (indices 2,3,4) kept
  const names = idx.map(e => e.name).sort();
  eq(names, ['snap-2', 'snap-3', 'snap-4'], 'kept newest 3');

  // Now pin the oldest remaining, add 3 more, oldest pinned must survive
  await storage.setPinned(idx[2].id, true);
  for (let i = 5; i < 8; i++) {
    const s = await snapshot.captureSnapshot({ type: 'auto' });
    s.timestamp = 1_000_000 + i * 1000;
    s.name = 'snap-' + i;
    await storage.putSnapshot(s);
  }
  const idx2 = await storage.getIndex();
  eq(idx2.length, 3, 'still cap of 3');
  const stillThere = idx2.find(e => e.pinned);
  assert(stillThere !== undefined, 'pinned survived retention');
});

// ============================================================
await group('restore: new-windows mode recreates everything', async () => {
  reset();
  // Source state: one window with pinned + grouped + active
  seedWindow({
    focused: true,
    tabs: [
      { url: 'https://pin.com/', pinned: true },
      { url: 'https://a.com/', active: true },
      { url: 'https://b.com/', groupId: 200 },
      { url: 'https://c.com/', groupId: 200 }
    ],
    groups: [{ id: 200, title: 'Reading', color: 'green', collapsed: true }]
  });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });

  // Wipe windows to simulate cold restore
  state.windows.clear();
  state.tabGroups = new Map();

  const result = await restore.restoreSnapshot(snap, { mode: 'new-windows' });
  eq(result.restored, 4, 'restored 4 tabs');
  const wins = [...state.windows.values()];
  eq(wins.length, 1, 'one window created');
  const w = wins[0];
  eq(w.tabs.length, 4, '4 tabs in restored window');

  const pinned = w.tabs.filter(t => t.pinned);
  eq(pinned.length, 1, 'pinned preserved');
  eq(pinned[0].url, 'https://pin.com/', 'correct tab pinned');

  // Groups recreated
  const groups = [...(state.tabGroups || new Map()).values()];
  eq(groups.length, 1, 'one group recreated');
  eq(groups[0].title, 'Reading', 'group title preserved');
  eq(groups[0].color, 'green', 'group color preserved');
  eq(groups[0].collapsed, true, 'group collapsed preserved');

  // The grouped tabs reference the new groupId
  const grouped = w.tabs.filter(t => t.groupId === groups[0].id);
  eq(grouped.length, 2, '2 tabs in group');
  const groupedUrls = grouped.map(t => t.url).sort();
  eq(groupedUrls, ['https://b.com/', 'https://c.com/'], 'correct tabs in group');
});

// ============================================================
await group('restore: single-window combines multiple windows', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://a.com/' }, { url: 'https://b.com/' }] });
  seedWindow({ tabs: [{ url: 'https://c.com/' }] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });

  state.windows.clear();
  state.tabGroups = new Map();

  const result = await restore.restoreSnapshot(snap, { mode: 'single-window' });
  eq(result.restored, 3, 'restored 3 tabs');
  eq(state.windows.size, 1, 'one window');
  const w = [...state.windows.values()][0];
  eq(w.tabs.length, 3, '3 tabs combined');
});

// ============================================================
await group('restore: current mode appends to current window', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://src1.com/' }, { url: 'https://src2.com/' }] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });

  // Set up a target current window with 1 existing tab
  state.windows.clear();
  state.tabGroups = new Map();
  seedWindow({ focused: true, tabs: [{ url: 'https://existing.com/' }] });
  const target = [...state.windows.values()][0];

  const result = await restore.restoreSnapshot(snap, { mode: 'current' });
  eq(result.restored, 2, 'appended 2 tabs');
  eq(target.tabs.length, 3, 'existing + 2 appended');
});

// ============================================================
await group('restore: selective restore', async () => {
  reset();
  const w1 = seedWindow({
    tabs: [
      { url: 'https://w1-a.com/' },
      { url: 'https://w1-b.com/' },
      { url: 'https://w1-c.com/' }
    ]
  });
  const w2 = seedWindow({ tabs: [{ url: 'https://w2-a.com/' }, { url: 'https://w2-b.com/' }] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });

  state.windows.clear();
  state.tabGroups = new Map();

  // Restore only window 1 entirely + index 1 from window 2
  const selection = {
    windowIds: new Set([w1]),
    tabKeys: new Set([`${w2}:1`])
  };
  const result = await restore.restoreSnapshot(snap, { mode: 'new-windows', selection });
  eq(result.restored, 3 + 1, '3 (full w1) + 1 (selected w2 tab) restored');
  const wins = [...state.windows.values()];
  eq(wins.length, 2, 'two windows created');
  const sizes = wins.map(w => w.tabs.length).sort();
  eq(sizes, [1, 3], 'one window with 3 tabs, one with 1');
});

// ============================================================
await group('restore: settings.closeOthers triggers pre-restore snapshot', async () => {
  reset();
  // Existing 'live' session
  seedWindow({ focused: true, tabs: [{ url: 'https://existing.com/' }] });
  const before = await snapshot.captureAndPersist({ type: 'manual' });

  // Restore with closeOthers
  state.windows.clear();
  seedWindow({ focused: true, tabs: [{ url: 'https://focused-target.com/' }] });
  await restore.restoreSnapshot(before, { mode: 'new-windows', closeOthers: true });

  // After closeOthers we expect only the new windows (the previous "current" was removed)
  const wins = [...state.windows.values()];
  // The window we created via seedWindow was removed; restored window remains
  const urls = wins.flatMap(w => w.tabs.map(t => t.url));
  assert(urls.includes('https://existing.com/'), 'restored URL present');
  assert(!urls.includes('https://focused-target.com/'), 'previous focused window closed');
});

// ============================================================
await group('snapshot: skips incognito windows', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://normal.com/' }] });
  const inc = seedWindow({ tabs: [{ url: 'https://incognito.com/' }] });
  state.windows.get(inc).incognito = true;
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  eq(snap.windows.length, 1, 'incognito filtered');
  eq(snap.windows[0].tabs[0].url, 'https://normal.com/', 'only normal kept');
});

// ============================================================
await group('snapshot: URL normalization on restore', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'chrome-search://local-ntp/local-ntp.html' }, { url: 'https://x.com/' }] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  state.windows.clear();
  state.tabGroups = new Map();
  await restore.restoreSnapshot(snap, { mode: 'new-windows' });
  const w = [...state.windows.values()][0];
  eq(w.tabs[0].url, 'chrome://newtab/', 'chrome-search rewritten to newtab');
  eq(w.tabs[1].url, 'https://x.com/', 'normal URL preserved');
});

// ============================================================
await group('storage: import round-trip preserves data', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [
    { url: 'https://a.com/', pinned: true, active: false },
    { url: 'https://b.com/', active: true, groupId: 300 }
  ], groups: [{ id: 300, title: 'g', color: 'red', collapsed: false }] });
  const snap = await snapshot.captureAndPersist({ type: 'manual', name: 'orig' });

  const all = await storage.getAllSnapshots();
  eq(all.length, 1, 'one snapshot persisted');

  // Round-trip via JSON
  const payload = { kind: 'tab-vault-export', version: 1, exportedAt: Date.now(), snapshots: all };
  const json = JSON.stringify(payload);
  reset();
  const parsed = JSON.parse(json);
  // Re-import each snapshot manually as background.js does
  for (const s of parsed.snapshots) {
    s.id = utils.uuid();
    await storage.putSnapshot(s);
  }
  const after = await storage.getAllSnapshots();
  eq(after.length, 1, 'imported snapshot');
  eq(after[0].name, 'orig', 'name preserved through round-trip');
  eq(after[0].windows[0].tabs[0].pinned, true, 'pinned preserved');
  eq(after[0].windows[0].groups[0].color, 'red', 'group color preserved');
});

// ============================================================
await group('crash recovery: live snapshot is readable and clearable', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://session1.com/' }] });
  const snap = await snapshot.captureSnapshot({ type: 'live' });
  await storage.writeLive(snap, 'session-1');
  const { snap: read, meta } = await storage.readLive();
  assert(read && read.windows[0].tabs[0].url === 'https://session1.com/', 'live snap read');
  assert(meta.sessionId === 'session-1', 'meta read');
  await storage.clearLive();
  const after = await storage.readLive();
  assert(after.snap === null && after.meta === null, 'live cleared');
});

// ============================================================
await group('storage: usage reports bytes', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  const before = await storage.storageUsage();
  await snapshot.captureAndPersist({ type: 'manual' });
  const after = await storage.storageUsage();
  assert(after > before, 'usage grew after writing snapshot');
});

// ============================================================
await group('restore: active tab is set after restore', async () => {
  reset();
  seedWindow({ tabs: [
    { url: 'https://a.com/' },
    { url: 'https://b.com/', active: true },
    { url: 'https://c.com/' }
  ] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  state.windows.clear();
  state.tabGroups = new Map();
  await restore.restoreSnapshot(snap, { mode: 'new-windows' });
  const w = [...state.windows.values()][0];
  const active = w.tabs.find(t => t.active);
  assert(active && active.url === 'https://b.com/', 'active tab preserved');
});

// ============================================================
await group('restore: multiple groups in one window', async () => {
  reset();
  seedWindow({
    tabs: [
      { url: 'https://g1-a.com/', groupId: 1 },
      { url: 'https://g1-b.com/', groupId: 1 },
      { url: 'https://g2-a.com/', groupId: 2 },
      { url: 'https://ungrouped.com/' }
    ],
    groups: [
      { id: 1, title: 'First', color: 'blue' },
      { id: 2, title: 'Second', color: 'red' }
    ]
  });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  state.windows.clear();
  state.tabGroups = new Map();
  await restore.restoreSnapshot(snap, { mode: 'new-windows' });
  const groups = [...(state.tabGroups || new Map()).values()];
  eq(groups.length, 2, '2 groups recreated');
  const titles = groups.map(g => g.title).sort();
  eq(titles, ['First', 'Second'], 'group titles preserved');
  const colors = groups.map(g => g.color).sort();
  eq(colors, ['blue', 'red'], 'group colors preserved');
});

// ============================================================
await group('restore: window state preserved (maximized)', async () => {
  reset();
  seedWindow({
    state: 'maximized',
    tabs: [{ url: 'https://a.com/' }]
  });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  state.windows.clear();
  state.tabGroups = new Map();
  await restore.restoreSnapshot(snap, { mode: 'new-windows' });
  const w = [...state.windows.values()][0];
  eq(w.state, 'maximized', 'window state preserved');
});

// ============================================================
await group('restore: empty selection returns 0', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  state.windows.clear();
  const r = await restore.restoreSnapshot(snap, {
    mode: 'new-windows',
    selection: { windowIds: new Set(), tabKeys: new Set() }
  });
  eq(r.restored, 0, 'no tabs restored from empty selection');
  eq(state.windows.size, 0, 'no windows created');
});

// ============================================================
await group('snapshot: live snapshot capture is identical to manual', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://x.com/' }, { url: 'https://y.com/' }] });
  const a = await snapshot.captureSnapshot({ type: 'live' });
  const b = await snapshot.captureSnapshot({ type: 'manual' });
  eq(a.windows[0].tabs.map(t => t.url), b.windows[0].tabs.map(t => t.url), 'same tab list');
  eq(a.type, 'live', 'type live');
  eq(b.type, 'manual', 'type manual');
});

// ============================================================
await group('retention: pinned beyond max never dropped', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 2 });
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  // Create 5 snapshots, all pinned. Cap is 2, but pinned override.
  for (let i = 0; i < 5; i++) {
    const s = await snapshot.captureSnapshot({ type: 'manual' });
    s.timestamp = 1_000_000 + i * 1000;
    s.name = 'pin-' + i;
    s.pinned = true;
    await storage.putSnapshot(s);
  }
  const idx = await storage.getIndex();
  eq(idx.length, 5, 'all pinned survive');
});

// ============================================================
await group('storage: rename updates index entry only when found', async () => {
  reset();
  const r = await storage.renameSnapshot('nonexistent', 'foo');
  assert(r === null, 'rename of missing snapshot returns null');
});

// ============================================================
await group('storage: pin of missing snapshot returns null', async () => {
  reset();
  const r = await storage.setPinned('nonexistent', true);
  assert(r === null, 'pin of missing returns null');
});

// ============================================================
await group('restore: selection with only tabKeys (no windowIds)', async () => {
  reset();
  const wid = seedWindow({ tabs: [
    { url: 'https://0.com/' },
    { url: 'https://1.com/' },
    { url: 'https://2.com/' }
  ] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  state.windows.clear();
  state.tabGroups = new Map();
  const r = await restore.restoreSnapshot(snap, {
    mode: 'new-windows',
    selection: { tabKeys: new Set([`${wid}:0`, `${wid}:2`]) }
  });
  eq(r.restored, 2, 'restored 2 selected tabs');
  const w = [...state.windows.values()][0];
  const urls = w.tabs.map(t => t.url).sort();
  eq(urls, ['https://0.com/', 'https://2.com/'], 'correct tabs restored');
});

// ============================================================
// Summary
console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(' •', f);
  process.exit(1);
} else {
  console.log('All tests passed ✓');
}
console.warn = realWarn;
