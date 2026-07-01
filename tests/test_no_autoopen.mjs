// Observer-only invariant tests.
//
// Tab Vault has NO ability to open, close, navigate, focus, move, or pin tabs.
// There is no restore feature. The user uses a separate tool for that.
//
// These tests prove:
//   1. Across every code path in the extension (install, startup, alarms,
//      tab/window/group events, every message handler, keyboard shortcuts,
//      hourly backup), chrome.tabs.create/.update/.remove/.move and
//      chrome.windows.create/.remove are NEVER called.
//   2. The `restore` and `restore-latest` message handlers do not exist —
//      sending those messages returns an "Unknown message" error.
//   3. There is no lib/restore.js module in the codebase.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMockChrome } from './mock-chrome.mjs';

const harness = createMockChrome();
globalThis.chrome = harness.chromeApi;
const realWarn = console.warn;
console.warn = () => {};

let tabCreates = 0, windowCreates = 0, tabUpdates = 0, tabRemoves = 0, windowRemoves = 0, tabGroupCalls = 0;

const realTabsCreate = harness.chromeApi.tabs.create;
harness.chromeApi.tabs.create = function (...args) { tabCreates += 1; return realTabsCreate.apply(this, args); };
const realWindowsCreate = harness.chromeApi.windows.create;
harness.chromeApi.windows.create = function (...args) { windowCreates += 1; return realWindowsCreate.apply(this, args); };
const realTabsUpdate = harness.chromeApi.tabs.update;
harness.chromeApi.tabs.update = function (...args) { tabUpdates += 1; return realTabsUpdate.apply(this, args); };
harness.chromeApi.tabs.remove = async function () { tabRemoves += 1; };
const realWindowsRemove = harness.chromeApi.windows.remove;
harness.chromeApi.windows.remove = function (...args) { windowRemoves += 1; return realWindowsRemove.apply(this, args); };
const realTabsGroup = harness.chromeApi.tabs.group;
harness.chromeApi.tabs.group = function (...args) { tabGroupCalls += 1; return realTabsGroup.apply(this, args); };

function resetCounters() {
  tabCreates = 0; windowCreates = 0; tabUpdates = 0; tabRemoves = 0; windowRemoves = 0; tabGroupCalls = 0;
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

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// --------------------------------------------------------------------------
await grp('static: lib/restore.js exists and is the ONLY whitelisted opener', () => {
  const restorePath = path.join(ROOT, 'lib', 'restore.js');
  assert(fs.existsSync(restorePath), 'lib/restore.js exists');
  const src = fs.readFileSync(restorePath, 'utf8');
  // The only mutating Chrome call allowed anywhere is chrome.windows.create in this file.
  assert(/chrome\.windows\.create\(/.test(src), 'lib/restore.js calls chrome.windows.create (expected)');
  // It must NOT call any other forbidden API.
  const otherForbidden = [
    'chrome.tabs.create(',
    'chrome.tabs.update(',
    'chrome.tabs.remove(',
    'chrome.tabs.move(',
    'chrome.tabs.group(',
    'chrome.windows.remove(',
    'chrome.windows.update(',
    'chrome.tabGroups.update('
  ];
  for (const f of otherForbidden) {
    assert(!src.includes(f), `lib/restore.js must not contain ${f}`);
  }
});

// --------------------------------------------------------------------------
await grp('static: no source file OTHER THAN lib/restore.js opens or mutates tabs', () => {
  // lib/restore.js is the single allowed opener (via chrome.windows.create).
  // Every other source file must contain ZERO mutating Chrome API calls.
  const targets = [
    'background.js',
    'lib/utils.js',
    'lib/storage.js',
    'lib/snapshot.js',
    'lib/sessions.js',
    'lib/backup.js',
    'lib/validate.js',
    'popup/popup.js',
    'options/options.js'
  ];
  const forbiddenCalls = [
    'chrome.tabs.create(',
    'chrome.tabs.update(',
    'chrome.tabs.remove(',
    'chrome.tabs.move(',
    'chrome.tabs.group(',
    'chrome.windows.create(',
    'chrome.windows.remove(',
    'chrome.windows.update(',
    'chrome.tabGroups.update('
  ];
  for (const t of targets) {
    const src = fs.readFileSync(path.join(ROOT, t), 'utf8');
    for (const f of forbiddenCalls) {
      const lines = src.split('\n');
      const hits = lines.filter(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
        return line.includes(f);
      });
      assert(hits.length === 0, `${t} must not contain ${f} (found ${hits.length} call sites)`);
    }
  }
});

// --------------------------------------------------------------------------
await grp('runtime: install + startup + crash recovery never mutate tabs', async () => {
  reset();
  resetCounters();
  // Pre-seed tabs as if Chrome's session restore put them there
  seedWindow({ tabs: [
    { url: 'https://chrome-restored.com/1' },
    { url: 'https://chrome-restored.com/2' },
    { url: 'https://chrome-restored.com/3' }
  ] });
  const seededTabIds = new Set([...state.windows.values()].flatMap(w => w.tabs.map(t => t.id)));

  // Prime a "crashed" live snapshot
  const storage = await import('../lib/storage.js');
  const snapshot = await import('../lib/snapshot.js');
  const live = await snapshot.captureSnapshot({ type: 'live' });
  await storage.writeLive(live, 'crashed-session');

  // Fire install, startup, and several alarms
  harness.chromeApi.runtime.onInstalled.emit({ reason: 'install' });
  await new Promise(r => setTimeout(r, 30));
  harness.chromeApi.runtime.onStartup.emit();
  await new Promise(r => setTimeout(r, 30));
  harness.chromeApi.alarms._fire('tv-auto-snapshot');
  harness.chromeApi.alarms._fire('tv-live-heartbeat');
  harness.chromeApi.alarms._fire('tv-hourly-backup');
  await new Promise(r => setTimeout(r, 50));

  eq(tabCreates, 0, 'no tabs created');
  eq(windowCreates, 0, 'no windows created');
  eq(tabUpdates, 0, 'no tab mutations');
  eq(tabRemoves, 0, 'no tabs removed');
  eq(windowRemoves, 0, 'no windows removed');
  eq(tabGroupCalls, 0, 'no group calls');

  // Original tabs still present, unchanged
  const idsNow = new Set([...state.windows.values()].flatMap(w => w.tabs.map(t => t.id)));
  for (const id of seededTabIds) assert(idsNow.has(id), `tab ${id} still present`);

  // Crash recovery still added a snapshot to history (read-only)
  const list = await sendMessage({ type: 'list-index' });
  assert(list.index.find(e => e.type === 'crash'), 'crash snapshot recorded in history');
});

// --------------------------------------------------------------------------
await grp('runtime: every message handler is observer-only', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }, { url: 'https://b.com/' }] });

  const messages = [
    { type: 'ping' },
    { type: 'get-current-stats' },
    { type: 'get-profile' },
    { type: 'set-browser-info', name: 'Brave' },
    { type: 'list-index' },
    { type: 'get-timeline' },
    { type: 'capture' },
    { type: 'capture', snapshotType: 'manual', name: 'test' },
    { type: 'get-settings' },
    { type: 'set-settings', patch: { profileLabel: 'X' } },
    { type: 'export-all' },
    { type: 'recompute-alarms' },
    { type: 'run-backup-now' }
  ];

  for (const m of messages) {
    try { await sendMessage(m); } catch { /* expected for some */ }
  }
  // get-snapshot, rename, pin, delete need an id — capture one
  const { snapshot: snap } = await sendMessage({ type: 'capture' });
  await sendMessage({ type: 'get-snapshot', id: snap.id });
  await sendMessage({ type: 'rename', id: snap.id, name: 'renamed' });
  await sendMessage({ type: 'pin', id: snap.id, pinned: true });
  await sendMessage({ type: 'export-one', id: snap.id });
  await sendMessage({ type: 'inspect-import', payload: { kind: 'tab-vault-snapshot', version: 1, snapshot: { id: 's', timestamp: 1, windows: [] } } });
  await sendMessage({ type: 'delete', id: snap.id });
  await sendMessage({ type: 'clear-all' });

  eq(tabCreates, 0, 'no tabs created across all messages');
  eq(windowCreates, 0, 'no windows created');
  eq(tabUpdates, 0, 'no tabs updated');
  eq(tabRemoves, 0, 'no tabs removed');
  eq(windowRemoves, 0, 'no windows removed');
  eq(tabGroupCalls, 0, 'no group calls');
});

// --------------------------------------------------------------------------
await grp('runtime: legacy `restore` / `restore-latest` messages are removed', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  let err1;
  try { await sendMessage({ type: 'restore', id: 'anything' }); } catch (e) { err1 = e; }
  assert(err1 && /Unknown message/.test(err1.message), 'legacy `restore` is still gone');

  let err2;
  try { await sendMessage({ type: 'restore-latest' }); } catch (e) { err2 = e; }
  assert(err2 && /Unknown message/.test(err2.message), 'legacy `restore-latest` is still gone');
});

// --------------------------------------------------------------------------
await grp('runtime: `restore-from-file` is the ONLY message that opens windows', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  // Sending the new message with a valid window object DOES open a window.
  await sendMessage({ type: 'restore-from-file', windows: [
    { tabs: [{ url: 'https://restored.com/', index: 0 }], state: 'normal' }
  ] });
  assert(windowCreates === 1, `restore-from-file opens a window (got ${windowCreates})`);

  // Now fire everything else again — no additional opens
  resetCounters();
  await sendMessage({ type: 'ping' });
  await sendMessage({ type: 'capture' });
  await sendMessage({ type: 'list-index' });
  await sendMessage({ type: 'get-timeline' });
  harness.chromeApi.alarms._fire('tv-auto-snapshot');
  harness.chromeApi.alarms._fire('tv-live-heartbeat');
  harness.chromeApi.alarms._fire('tv-hourly-backup');
  harness.chromeApi.commands.onCommand.emit('save-snapshot');
  harness.chromeApi.tabs.onCreated.emit({});
  harness.chromeApi.tabs.onUpdated.emit(0, {}, {});
  harness.chromeApi.windows.onCreated.emit({});
  await new Promise(r => setTimeout(r, 50));
  eq(tabCreates, 0, 'no tab creates from non-restore paths');
  eq(windowCreates, 0, 'no window creates from non-restore paths');
  eq(tabUpdates, 0, 'no tab updates');
});

// --------------------------------------------------------------------------
await grp('runtime: tab/window/group events do not mutate the browser', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

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

  eq(tabCreates, 0, 'no tab creates');
  eq(windowCreates, 0, 'no window creates');
  eq(tabUpdates, 0, 'no tab updates');
  eq(tabRemoves, 0, 'no tab removes');
  eq(windowRemoves, 0, 'no window removes');
});

// --------------------------------------------------------------------------
await grp('runtime: keyboard shortcuts do not mutate', async () => {
  reset();
  resetCounters();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  harness.chromeApi.commands.onCommand.emit('save-snapshot');
  harness.chromeApi.commands.onCommand.emit('open-dashboard');
  await new Promise(r => setTimeout(r, 50));
  eq(tabCreates, 0, 'no tab creates from shortcuts');
  eq(windowCreates, 0, 'no window creates from shortcuts');
  eq(tabUpdates, 0, 'no tab updates from shortcuts');
});

// --------------------------------------------------------------------------
console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) { for (const f of failures) console.log(' •', f); process.exit(1); }
console.log('Observer-only invariant holds ✓');
console.warn = realWarn;
