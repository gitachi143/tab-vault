// Resilience / edge-case tests.
//
// Covers scenarios that could happen on a real laptop:
//   * Chrome's session-restore races our startup handler (windows.getAll empty)
//   * Browser crashed before clean shutdown (live snapshot survives)
//   * Service worker killed and re-initialized mid-run
//   * 200+ tabs across many windows (stress + size)
//   * chrome:// and chrome-extension:// URLs in snapshots
//   * Snapshot deleted while user has the detail pane open
//   * Storage already populated when extension reloads
//   * Many sequential captures without leaks
//   * Empty captures aren't persisted

import { createMockChrome } from './mock-chrome.mjs';

const harness = createMockChrome();
globalThis.chrome = harness.chromeApi;
const realWarn = console.warn;
console.warn = () => {};

const { seedWindow, reset, state } = harness;

const storage  = await import('../lib/storage.js');
const snapshot = await import('../lib/snapshot.js');

await import('../background.js');

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    const ls = harness.chromeApi.runtime.onMessage.listeners;
    ls[0](msg, { id: 'test' }, (response) => {
      if (response && response.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

let pass = 0, fail = 0;
const failures = [];
function assert(c, m) { if (c) pass++; else { fail++; failures.push(m); console.log('  ✗', m); } }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function grp(name, fn) { console.log('\n▸', name); await fn(); }

// --------------------------------------------------------------------------
await grp('startup with NO windows yet (Chrome session-restore racing us)', async () => {
  reset();
  // Pretend Chrome hasn't created any windows yet
  // (state.windows is already empty after reset)
  harness.chromeApi.runtime.onStartup.emit();
  await new Promise(r => setTimeout(r, 50));

  // We should NOT have persisted an empty startup snapshot.
  const list = await sendMessage({ type: 'list-index' });
  const startups = list.index.filter(e => e.type === 'startup');
  eq(startups.length, 0, 'no empty startup snapshot persisted');
});

// --------------------------------------------------------------------------
await grp('manual save with NO windows is still persisted (explicit user intent)', async () => {
  reset();
  // No windows. User clicks Save anyway.
  const { snapshot: snap } = await sendMessage({ type: 'capture', snapshotType: 'manual' });
  assert(snap && snap.stats.tabCount === 0, 'empty manual snapshot accepted');
  const list = await sendMessage({ type: 'list-index' });
  eq(list.index.length, 1, 'one snapshot in history');
});

// --------------------------------------------------------------------------
await grp('crash recovery end-to-end (browser killed before clean shutdown)', async () => {
  reset();
  // Pretend a previous session was active and writing live snapshots
  seedWindow({ tabs: [
    { url: 'https://session-a.com/' },
    { url: 'https://session-a.com/2', groupId: 1 }
  ], groups: [{ id: 1, title: 'Work', color: 'blue' }] });

  const liveSnap = await snapshot.captureSnapshot({ type: 'live' });
  await storage.writeLive(liveSnap, 'crashed-session-id');

  // Crash: clear all windows
  state.windows.clear();
  state.tabGroups = new Map();

  // New browser start
  harness.chromeApi.runtime.onStartup.emit();
  await new Promise(r => setTimeout(r, 50));

  const list = await sendMessage({ type: 'list-index' });
  const crash = list.index.find(e => e.type === 'crash');
  assert(crash, 'crash snapshot present after recovery');
  assert(crash.stats.tabCount === 2, 'crash snapshot has all 2 tabs');
  // Tab Vault must NOT have re-opened those tabs
  eq(state.windows.size, 0, 'no windows auto-reopened (Chrome handles that)');
});

// --------------------------------------------------------------------------
await grp('service worker restart: initOnce is idempotent', async () => {
  reset();
  // First "lifetime"
  await sendMessage({ type: 'capture' });
  const profile1 = await sendMessage({ type: 'get-profile' });
  // Simulate SW restart: re-import background.js? Modules cache — but the
  // _ready Promise is module-scope so it persists. The next message just
  // sees initOnce already resolved.
  const profile2 = await sendMessage({ type: 'get-profile' });
  eq(profile1.profileId, profile2.profileId, 'profile id stable across calls');

  // Now fire onInstalled again (would happen on extension update). Settings
  // should not be reset, profile id should not change.
  harness.chromeApi.runtime.onInstalled.emit({ reason: 'update' });
  await new Promise(r => setTimeout(r, 50));
  const profile3 = await sendMessage({ type: 'get-profile' });
  eq(profile3.profileId, profile1.profileId, 'profile id persists across onInstalled');
});

// --------------------------------------------------------------------------
await grp('stress: 250 tabs across 10 windows captures cleanly', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { maxSnapshots: 0 } });
  for (let w = 0; w < 10; w++) {
    seedWindow({ tabs: Array.from({ length: 25 }, (_, i) => ({ url: `https://w${w}-t${i}.com/`, title: `Tab ${w}-${i}` })) });
  }
  const t0 = Date.now();
  const { snapshot: snap } = await sendMessage({ type: 'capture' });
  const captureMs = Date.now() - t0;
  eq(snap.stats.tabCount, 250, '250 tabs captured');
  eq(snap.stats.windowCount, 10, '10 windows captured');
  assert(captureMs < 2000, `capture under 2s, got ${captureMs}ms`);

  // Verify the snapshot round-trips through storage cleanly
  const fetched = await sendMessage({ type: 'get-snapshot', id: snap.id });
  eq(fetched.snapshot.stats.tabCount, 250, 'snapshot retrieved intact');
});

// --------------------------------------------------------------------------
await grp('chrome:// URLs (other than newtab) are preserved verbatim', async () => {
  reset();
  seedWindow({ tabs: [
    { url: 'chrome://settings/' },
    { url: 'chrome://extensions/' },
    { url: 'chrome-extension://abc/popup.html' },
    { url: 'about:blank' },
    { url: 'https://normal.com/' }
  ] });
  const snap = await snapshot.captureSnapshot({ type: 'manual' });
  // All URLs preserved as-is in the snapshot (no normalization at capture time)
  const urls = snap.windows[0].tabs.map(t => t.url);
  eq(urls, [
    'chrome://settings/',
    'chrome://extensions/',
    'chrome-extension://abc/popup.html',
    'about:blank',
    'https://normal.com/'
  ], 'all special URLs captured verbatim');
});

// --------------------------------------------------------------------------
await grp('deleted snapshot returns null on later fetch', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  const { snapshot: snap } = await sendMessage({ type: 'capture' });
  await sendMessage({ type: 'delete', id: snap.id });
  const r = await sendMessage({ type: 'get-snapshot', id: snap.id });
  eq(r.snapshot, null, 'deleted snapshot returns null cleanly');
});

// --------------------------------------------------------------------------
await grp('storage already populated when extension reloads', async () => {
  reset();
  // Pre-seed storage with a snapshot from an "earlier session"
  await sendMessage({ type: 'set-settings', patch: { maxSnapshots: 0, profileLabel: 'Existing-User' } });
  seedWindow({ tabs: [{ url: 'https://before-reload.com/' }] });
  const { snapshot: snap } = await sendMessage({ type: 'capture', name: 'pre-reload' });

  // Simulate extension reload by firing onInstalled
  harness.chromeApi.runtime.onInstalled.emit({ reason: 'update' });
  await new Promise(r => setTimeout(r, 50));

  // Existing data must survive
  const list = await sendMessage({ type: 'list-index' });
  assert(list.index.find(e => e.id === snap.id), 'existing snapshot survived reload');
  const settings = (await sendMessage({ type: 'get-settings' })).settings;
  eq(settings.profileLabel, 'Existing-User', 'profile label survived reload');
});

// --------------------------------------------------------------------------
await grp('many sequential captures: no storage corruption', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { maxSnapshots: 0 } });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  // Fire 50 captures back to back through the message channel
  const results = [];
  for (let i = 0; i < 50; i++) {
    const r = await sendMessage({ type: 'capture', name: `seq-${i}` });
    results.push(r.snapshot.id);
  }
  const list = await sendMessage({ type: 'list-index' });
  eq(list.index.length, 50, 'all 50 captures persisted');
  // Verify all distinct ids
  const distinct = new Set(results);
  eq(distinct.size, 50, 'all ids unique');
  // Index repair should find no orphans
  const r = await storage.repairIndex();
  eq(r.removed, 0, 'no orphans after stress run');
});

// --------------------------------------------------------------------------
await grp('concurrent captures during alarm + manual: index stays correct', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { maxSnapshots: 0, autoSnapshotMinutes: 5 } });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  // Race: fire 5 manual + 5 alarm-driven captures concurrently
  const ops = [];
  for (let i = 0; i < 5; i++) ops.push(sendMessage({ type: 'capture', name: `manual-${i}` }));
  for (let i = 0; i < 5; i++) ops.push(new Promise(async (resolve) => {
    harness.chromeApi.alarms._fire('tv-auto-snapshot');
    setTimeout(resolve, 0);
  }));
  await Promise.all(ops);
  await new Promise(r => setTimeout(r, 100));

  const list = await sendMessage({ type: 'list-index' });
  // 10 in total expected, mutex must have prevented loss
  assert(list.index.length === 10, `expected 10 after race, got ${list.index.length}`);
  const r = await storage.repairIndex();
  eq(r.removed, 0, 'index consistent (no orphans)');
});

// --------------------------------------------------------------------------
await grp('hourly backup never opens / closes / modifies any tabs', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: {
    hourlyBackupEnabled: true,
    hourlyBackupDownload: false, // skip download (mock doesn't have full chrome.downloads)
    hourlyBackupWebhookUrl: ''
  } });
  seedWindow({ tabs: [{ url: 'https://x.com/' }, { url: 'https://y.com/' }] });
  const beforeTabIds = new Set([...state.windows.values()].flatMap(w => w.tabs.map(t => t.id)));

  // Fire many backup cycles
  for (let i = 0; i < 5; i++) {
    harness.chromeApi.alarms._fire('tv-hourly-backup');
  }
  await new Promise(r => setTimeout(r, 100));

  const afterTabIds = new Set([...state.windows.values()].flatMap(w => w.tabs.map(t => t.id)));
  eq(afterTabIds.size, beforeTabIds.size, 'tab count unchanged');
  for (const id of beforeTabIds) assert(afterTabIds.has(id), `tab ${id} still present`);
});

// --------------------------------------------------------------------------
await grp('pruned snapshot fetch returns null cleanly', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { maxSnapshots: 3 } });
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  // Capture 5 → retention prunes to 3
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const s = await snapshot.captureSnapshot({ type: 'manual', name: `s-${i}` });
    s.timestamp = 1_000_000 + i * 1000;
    await storage.putSnapshot(s);
    ids.push(s.id);
  }
  // The oldest (s-0) should be gone
  const list = await sendMessage({ type: 'list-index' });
  eq(list.index.length, 3, 'retention pruned to 3');
  const survivingIds = new Set(list.index.map(e => e.id));
  const prunedId = ids.find(id => !survivingIds.has(id));
  assert(prunedId, 'one id was actually pruned');
  // Try to fetch the pruned snapshot
  const r = await sendMessage({ type: 'get-snapshot', id: prunedId });
  eq(r.snapshot, null, 'pruned snapshot returns null');
});

// --------------------------------------------------------------------------
await grp('Chrome session-restore: tabs that arrive AFTER our startup snapshot still get captured', async () => {
  reset();
  // Startup with 1 tab
  seedWindow({ tabs: [{ url: 'https://initial.com/' }] });
  harness.chromeApi.runtime.onStartup.emit();
  await new Promise(r => setTimeout(r, 50));
  const list1 = await sendMessage({ type: 'list-index' });
  const startupSnap = list1.index.find(e => e.type === 'startup');
  assert(startupSnap && startupSnap.stats.tabCount === 1, 'startup snapshot has 1 tab');

  // Chrome continues restoring tabs after our snapshot ran — simulated by
  // creating more tabs in the existing window AND firing the onCreated event.
  const w = [...state.windows.values()][0];
  for (let i = 0; i < 3; i++) {
    const t = { id: 9000 + i, windowId: w.id, url: `https://late-${i}.com/`, title: '', index: w.tabs.length, pinned: false, active: false, groupId: -1 };
    w.tabs.push(t);
    harness.chromeApi.tabs.onCreated.emit(t);
  }
  // The live-heartbeat alarm should now pick those up. Live writes are
  // throttled to >=2s apart so we age the prior write past the throttle.
  const meta = (await storage.readLive()).meta;
  if (meta) {
    await chrome.storage.local.set({ 'tv:live_meta': { ...meta, lastWriteTs: meta.lastWriteTs - 5000 } });
  }
  harness.chromeApi.alarms._fire('tv-live-heartbeat');
  await new Promise(r => setTimeout(r, 80));
  const { snap: live } = await storage.readLive();
  assert(live, 'live snapshot present');
  const liveTabCount = (live.windows[0]?.tabs || []).length;
  eq(liveTabCount, 4, 'live snapshot has all 4 tabs after late additions');
});

// --------------------------------------------------------------------------
console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) { for (const f of failures) console.log(' •', f); process.exit(1); }
console.log('Resilience tests passed ✓');
console.warn = realWarn;
