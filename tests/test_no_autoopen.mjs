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

// Wrap the mock to count creates.
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
  tabCreates = 0; windowCreates = 0;
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
  tabCreates = 0; windowCreates = 0;
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
  tabCreates = 0; windowCreates = 0;
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
  tabCreates = 0; windowCreates = 0;
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
  tabCreates = 0; windowCreates = 0;
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
  tabCreates = 0; windowCreates = 0;
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
console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) {
  for (const f of failures) console.log(' •', f);
  process.exit(1);
}
console.log('No-auto-open invariant holds ✓');
console.warn = realWarn;
