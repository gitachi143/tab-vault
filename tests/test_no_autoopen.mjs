// Invariant test: Tab Vault must never call chrome.tabs.create or
// chrome.windows.create except as the result of an explicit user-triggered
// `restore` / `restore-latest` message.
//
// We boot the background service worker with the mock chrome, then fire every
// non-restore event we can think of (install, startup, every tab/window/group
// event, alarms, save snapshot via message, settings change, import, export,
// list, get, delete, rename, pin, etc.) and assert that no chrome.tabs.create
// or chrome.windows.create ever happens.

import { createMockChrome } from './mock-chrome.mjs';

const harness = createMockChrome();
globalThis.chrome = harness.chromeApi;
const realWarn = console.warn;
console.warn = () => {};

let tabCreates = 0;
let windowCreates = 0;
let tabUpdates = 0;
let tabRemoves = 0;
let windowRemoves = 0;

// Wrap the mock to count every potentially-disruptive call.
const realTabsCreate = harness.chromeApi.tabs.create;
harness.chromeApi.tabs.create = function (...args) {
  tabCreates += 1;
  return realTabsCreate.apply(this, args);
};
const realWindowsCreate = harness.chromeApi.windows.create;
harness.chromeApi.windows.create = function (...args) {
  windowCreates += 1;
  return realWindowsCreate.apply(this, args);
};
const realTabsUpdate = harness.chromeApi.tabs.update;
harness.chromeApi.tabs.update = function (...args) {
  tabUpdates += 1;
  return realTabsUpdate.apply(this, args);
};
// tabs.remove + windows.remove aren't defined on our mock yet — add no-ops
// so the counters don't blow up when restore wires close-old logic.
harness.chromeApi.tabs.remove = async function () { tabRemoves += 1; };
const realWindowsRemove = harness.chromeApi.windows.remove;
harness.chromeApi.windows.remove = function (...args) {
  windowRemoves += 1;
  return realWindowsRemove.apply(this, args);
};

function resetCounters() {
  tabCreates = 0; windowCreates = 0; tabUpdates = 0; tabRemoves = 0; windowRemoves = 0;
}

const { seedWindow, reset, state } = harness;

await import('../background.js');

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    const ls = harness.chromeApi.runtime.onMessage.listeners;
    if (ls.length === 0) return reject(new Error('No onMessage listener'));
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
await grp('non-restore message paths do not open tabs', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }, { url: 'https://b.com/' }] });

  // Try every non-restore message.
  await sendMessage({ type: 'ping' });
  await sendMessage({ type: 'get-current-stats' });
  await sendMessage({ type: 'capture' });
  await sendMessage({ type: 'list-index' });
  await sendMessage({ type: 'get-timeline' });
  await sendMessage({ type: 'get-settings' });
  await sendMessage({ type: 'set-settings', patch: { autoSnapshotMinutes: 5 } });
  await sendMessage({ type: 'export-all' });

  // Capture twice so we can diff
  const { snapshot } = await sendMessage({ type: 'capture', name: 'A' });
  await sendMessage({ type: 'capture', name: 'B' });
  await sendMessage({ type: 'get-snapshot', id: snapshot.id });
  await sendMessage({ type: 'rename', id: snapshot.id, name: 'A-renamed' });
  await sendMessage({ type: 'pin', id: snapshot.id, pinned: true });
  await sendMessage({ type: 'recompute-alarms' });
  await sendMessage({ type: 'clear-all' });

  eq(tabCreates, 0, 'no chrome.tabs.create calls');
  eq(windowCreates, 0, 'no chrome.windows.create calls');
});

// --------------------------------------------------------------------------
await grp('lifecycle events (install, startup) do not open tabs', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }, { url: 'https://b.com/' }] });

  // Prime a "crashed" live snapshot so onStartup will promote it.
  // Even crash recovery must NOT auto-open tabs.
  const storage = await import('../lib/storage.js');
  const snapshot = await import('../lib/snapshot.js');
  const live = await snapshot.captureSnapshot({ type: 'live' });
  await storage.writeLive(live, 'previous-session');

  // Trigger onInstalled
  harness.chromeApi.runtime.onInstalled.emit({ reason: 'install' });
  await new Promise(r => setTimeout(r, 50));

  // Trigger onStartup — should promote crash snapshot but NOT open windows
  harness.chromeApi.runtime.onStartup.emit();
  await new Promise(r => setTimeout(r, 50));

  eq(tabCreates, 0, 'no tab creates during install/startup');
  eq(windowCreates, 0, 'no window creates during install/startup');

  // Verify the crash snapshot was created in storage (recovery happened) but
  // tabs were NOT opened.
  const list = await sendMessage({ type: 'list-index' });
  const crashSnap = list.index.find(e => e.type === 'crash');
  assert(crashSnap, 'crash recovery snapshot was created (history-only, no auto-open)');
});

// --------------------------------------------------------------------------
await grp('tab/window/group events do not open tabs', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  // Fire every event our listeners hook
  const ev = harness.chromeApi;
  ev.tabs.onCreated.emit({ id: 999, url: 'https://x.com/' });
  ev.tabs.onRemoved.emit(999, {});
  ev.tabs.onUpdated.emit(999, {}, {});
  ev.tabs.onMoved.emit(999, {});
  ev.tabs.onAttached.emit(999, {});
  ev.tabs.onDetached.emit(999, {});
  ev.tabs.onReplaced.emit(999, 998);
  ev.windows.onCreated.emit({ id: 99 });
  ev.windows.onRemoved.emit(99);
  ev.tabGroups.onCreated.emit({ id: 1 });
  ev.tabGroups.onUpdated.emit({ id: 1 });
  ev.tabGroups.onRemoved.emit({ id: 1 });
  ev.tabGroups.onMoved.emit({ id: 1 });

  await new Promise(r => setTimeout(r, 50));

  eq(tabCreates, 0, 'no tab creates on tab events');
  eq(windowCreates, 0, 'no window creates on tab events');
});

// --------------------------------------------------------------------------
await grp('alarms (auto-snapshot, heartbeat) do not open tabs', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  await sendMessage({ type: 'set-settings', patch: { autoSnapshotMinutes: 5, liveSnapshotEnabled: true } });

  harness.chromeApi.alarms._fire('tv-auto-snapshot');
  harness.chromeApi.alarms._fire('tv-live-heartbeat');
  await new Promise(r => setTimeout(r, 50));

  eq(tabCreates, 0, 'no tab creates from alarms');
  eq(windowCreates, 0, 'no window creates from alarms');
});

// --------------------------------------------------------------------------
await grp('commands (Cmd+Shift+S, Cmd+Shift+E) do not open tabs', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  harness.chromeApi.commands.onCommand.emit('save-snapshot');
  harness.chromeApi.commands.onCommand.emit('open-dashboard');
  await new Promise(r => setTimeout(r, 50));

  eq(tabCreates, 0, 'no tab creates from save-snapshot shortcut');
  eq(windowCreates, 0, 'no window creates from open-dashboard shortcut');
});

// --------------------------------------------------------------------------
await grp('only "restore" and "restore-latest" messages open tabs', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }, { url: 'https://b.com/' }] });
  const { snapshot } = await sendMessage({ type: 'capture' });

  // Wipe windows to simulate "user clicks restore to recover"
  state.windows.clear();
  state.tabGroups = new Map();

  await sendMessage({ type: 'restore', id: snapshot.id, options: { mode: 'new-windows' } });
  assert(windowCreates >= 1, 'explicit restore DID open a window (as designed)');

  const before = tabCreates + windowCreates;
  // Now fire many things AFTER restore — none should open more tabs
  harness.chromeApi.alarms._fire('tv-auto-snapshot');
  harness.chromeApi.commands.onCommand.emit('save-snapshot');
  harness.chromeApi.tabs.onCreated.emit({});
  harness.chromeApi.runtime.onStartup.emit();
  await new Promise(r => setTimeout(r, 50));
  const after = tabCreates + windowCreates;
  eq(after, before, 'no additional opens after restore completed');
});

// --------------------------------------------------------------------------
await grp('Chrome session restore is NOT interfered with', async () => {
  // Simulate the user's normal startup pattern:
  //   1. Chrome restores tabs from previous session (other apps do this — we don't)
  //   2. Tab Vault's onStartup fires, captures whatever Chrome restored
  //   3. Tab Vault must NOT close, modify, or duplicate any of those tabs
  reset();
  resetCounters();

  // Pre-seed: pretend Chrome already restored some tabs before our handler runs
  seedWindow({ tabs: [
    { url: 'https://restored-by-chrome.com/1' },
    { url: 'https://restored-by-chrome.com/2' },
    { url: 'https://restored-by-chrome.com/3' }
  ], focused: true });
  const seededTabIds = new Set(
    [...state.windows.values()].flatMap(w => w.tabs.map(t => t.id))
  );

  // Now fire Tab Vault's onStartup — it should ONLY observe, not mutate.
  harness.chromeApi.runtime.onStartup.emit();
  await new Promise(r => setTimeout(r, 50));

  // Counters must be zero
  eq(tabCreates, 0, 'onStartup creates no tabs');
  eq(windowCreates, 0, 'onStartup creates no windows');
  eq(tabUpdates, 0, 'onStartup does not modify any existing tab');
  eq(tabRemoves, 0, 'onStartup closes no tabs');
  eq(windowRemoves, 0, 'onStartup closes no windows');

  // The tabs Chrome restored are still there, unchanged
  const tabsNow = [...state.windows.values()].flatMap(w => w.tabs);
  eq(tabsNow.length, 3, 'all 3 Chrome-restored tabs still present');
  const idsNow = new Set(tabsNow.map(t => t.id));
  for (const id of seededTabIds) assert(idsNow.has(id), `tab ${id} still present`);
});

await grp('Chrome session restore: still un-interfered after auto-snapshot fires', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [
    { url: 'https://chrome-restored.com/a' },
    { url: 'https://chrome-restored.com/b' }
  ] });
  await sendMessage({ type: 'set-settings', patch: { autoSnapshotMinutes: 5, liveSnapshotEnabled: true } });

  // Multiple cycles of "tab event → auto snapshot → heartbeat"
  for (let i = 0; i < 3; i++) {
    harness.chromeApi.tabs.onCreated.emit({ id: 999 + i, url: 'https://added.com/' + i });
    harness.chromeApi.tabs.onUpdated.emit(999 + i, {}, {});
    harness.chromeApi.alarms._fire('tv-auto-snapshot');
    harness.chromeApi.alarms._fire('tv-live-heartbeat');
  }
  await new Promise(r => setTimeout(r, 50));

  eq(tabCreates, 0, 'auto-snapshot cycles never create tabs');
  eq(windowCreates, 0, 'never create windows');
  eq(tabUpdates, 0, 'never update existing tabs');
  eq(tabRemoves, 0, 'never close tabs');
  eq(windowRemoves, 0, 'never close windows');
});

await grp('hourly backup alarm does not open or modify tabs', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  // Even with full hourly backup enabled, no tab/window mutation
  await sendMessage({ type: 'set-settings', patch: {
    hourlyBackupEnabled: true,
    hourlyBackupDownload: true,
    hourlyBackupWebhookUrl: ''
  } });
  // Fire the hourly backup alarm
  harness.chromeApi.alarms._fire('tv-hourly-backup');
  await new Promise(r => setTimeout(r, 80));

  eq(tabCreates, 0, 'hourly backup creates no tabs');
  eq(windowCreates, 0, 'hourly backup creates no windows');
  eq(tabUpdates, 0, 'hourly backup updates no tabs');
  eq(tabRemoves, 0, 'hourly backup closes no tabs');
  eq(windowRemoves, 0, 'hourly backup closes no windows');
});

// --------------------------------------------------------------------------
console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) {
  for (const f of failures) console.log(' •', f);
  process.exit(1);
}
console.log('No-auto-open invariant holds ✓');
console.warn = realWarn;
