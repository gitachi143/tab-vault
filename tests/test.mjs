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
