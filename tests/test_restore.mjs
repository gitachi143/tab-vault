// Tests for the new restore-from-file flow.

import { createMockChrome } from './mock-chrome.mjs';

const harness = createMockChrome();
globalThis.chrome = harness.chromeApi;
const realWarn = console.warn;
console.warn = () => {};

const { reset, state } = harness;

const restore = await import('../lib/restore.js');
const utils   = await import('../lib/utils.js');

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
await grp('utils.normalizeUrlForRestore', () => {
  eq(utils.normalizeUrlForRestore('https://example.com/'), 'https://example.com/', 'normal URL untouched');
  eq(utils.normalizeUrlForRestore('http://example.com/'), 'http://example.com/', 'http URL untouched');
  eq(utils.normalizeUrlForRestore('chrome://settings/'), 'about:blank', 'chrome:// rewritten');
  eq(utils.normalizeUrlForRestore('chrome-extension://abc/x'), 'about:blank', 'chrome-extension:// rewritten');
  eq(utils.normalizeUrlForRestore('brave://flags'), 'about:blank', 'brave:// rewritten');
  eq(utils.normalizeUrlForRestore('devtools://devtools/'), 'about:blank', 'devtools:// rewritten');
  eq(utils.normalizeUrlForRestore('javascript:alert(1)'), 'about:blank', 'javascript: rewritten');
  eq(utils.normalizeUrlForRestore(''), 'about:blank', 'empty rewritten');
  eq(utils.normalizeUrlForRestore(null), 'about:blank', 'null rewritten');
});

// --------------------------------------------------------------------------
await grp('restoreWindows: opens one window per saved window with tabs in order', async () => {
  reset();
  const r = await restore.restoreWindows([
    {
      tabs: [
        { url: 'https://a.com/', index: 0 },
        { url: 'https://b.com/', index: 1 },
        { url: 'https://c.com/', index: 2 }
      ],
      state: 'normal'
    }
  ]);
  eq(r.openedWindows, 1, 'one window opened');
  eq(r.openedTabs, 3, '3 tabs opened');
  const wins = [...state.windows.values()];
  eq(wins.length, 1, 'one window in mock state');
  eq(wins[0].tabs.map(t => t.url), ['https://a.com/', 'https://b.com/', 'https://c.com/'], 'tab order preserved');
});

// --------------------------------------------------------------------------
await grp('restoreWindows: tab order respected even when input is unsorted', async () => {
  reset();
  await restore.restoreWindows([
    {
      tabs: [
        { url: 'https://second.com/', index: 1 },
        { url: 'https://third.com/', index: 2 },
        { url: 'https://first.com/', index: 0 }
      ],
      state: 'normal'
    }
  ]);
  const wins = [...state.windows.values()];
  eq(wins[0].tabs.map(t => t.url), ['https://first.com/', 'https://second.com/', 'https://third.com/'], 'sorted by index');
});

// --------------------------------------------------------------------------
await grp('restoreWindows: multiple windows open in given order', async () => {
  reset();
  await restore.restoreWindows([
    { tabs: [{ url: 'https://w1-a.com/' }, { url: 'https://w1-b.com/' }], state: 'normal' },
    { tabs: [{ url: 'https://w2-a.com/' }], state: 'normal' },
    { tabs: [{ url: 'https://w3-a.com/' }, { url: 'https://w3-b.com/' }, { url: 'https://w3-c.com/' }], state: 'normal' }
  ]);
  const wins = [...state.windows.values()];
  eq(wins.length, 3, 'three windows opened');
  eq(wins.map(w => w.tabs.length), [2, 1, 3], 'tab counts match');
});

// --------------------------------------------------------------------------
await grp('restoreWindows: empty window is skipped, no chrome.windows.create', async () => {
  reset();
  let creates = 0;
  const realCreate = harness.chromeApi.windows.create;
  harness.chromeApi.windows.create = function (...a) { creates++; return realCreate.apply(this, a); };
  await restore.restoreWindows([
    { tabs: [], state: 'normal' },
    { tabs: [{ url: 'https://x.com/' }], state: 'normal' }
  ]);
  harness.chromeApi.windows.create = realCreate;
  eq(creates, 1, 'only the non-empty window opened');
});

// --------------------------------------------------------------------------
await grp('restoreWindows: chrome:// URLs route to about:blank, count preserved', async () => {
  reset();
  const r = await restore.restoreWindows([
    {
      tabs: [
        { url: 'https://normal.com/', index: 0 },
        { url: 'chrome://settings/', index: 1 },
        { url: 'chrome-extension://abc/page.html', index: 2 }
      ],
      state: 'normal'
    }
  ]);
  eq(r.openedTabs, 3, 'all 3 tabs accounted for');
  eq(r.skippedUrls.length, 2, 'two internal URLs rewritten');
  const wins = [...state.windows.values()];
  eq(wins[0].tabs.map(t => t.url), ['https://normal.com/', 'about:blank', 'about:blank'], 'internal URLs become about:blank');
});

// --------------------------------------------------------------------------
await grp('restoreWindows: window state preserved (maximized, fullscreen, minimized)', async () => {
  reset();
  await restore.restoreWindows([
    { tabs: [{ url: 'https://a.com/' }], state: 'maximized' },
    { tabs: [{ url: 'https://b.com/' }], state: 'fullscreen' },
    { tabs: [{ url: 'https://c.com/' }], state: 'minimized' },
    { tabs: [{ url: 'https://d.com/' }], state: 'normal', top: 100, left: 50, width: 1024, height: 768 }
  ]);
  const wins = [...state.windows.values()];
  eq(wins.map(w => w.state), ['maximized', 'fullscreen', 'minimized', 'normal'], 'states preserved');
  // The normal window should also have bounds
  const normalWin = wins[3];
  eq(normalWin.top, 100, 'top preserved');
  eq(normalWin.left, 50, 'left preserved');
  eq(normalWin.width, 1024, 'width preserved');
  eq(normalWin.height, 768, 'height preserved');
});

// --------------------------------------------------------------------------
await grp('end-to-end: restore-from-file message opens the right windows', async () => {
  reset();
  const result = await sendMessage({
    type: 'restore-from-file',
    windows: [
      { tabs: [{ url: 'https://aa.com/', index: 0 }, { url: 'https://bb.com/', index: 1 }], state: 'normal' },
      { tabs: [{ url: 'https://cc.com/', index: 0 }], state: 'normal' }
    ]
  });
  eq(result.openedWindows, 2, '2 windows opened');
  eq(result.openedTabs, 3, '3 tabs opened');
  eq(state.windows.size, 2, '2 windows in mock state');
});

// --------------------------------------------------------------------------
await grp('end-to-end: invalid payload is rejected', async () => {
  reset();
  let err;
  try { await sendMessage({ type: 'restore-from-file', windows: 'not-an-array' }); }
  catch (e) { err = e; }
  assert(err && /Invalid restore payload/.test(err.message), 'rejects non-array');

  let err2;
  try { await sendMessage({ type: 'restore-from-file' }); }
  catch (e) { err2 = e; }
  assert(err2, 'rejects missing windows');
});

// --------------------------------------------------------------------------
await grp('end-to-end: restoring zero windows produces zero opens', async () => {
  reset();
  const r = await sendMessage({ type: 'restore-from-file', windows: [] });
  eq(r.openedWindows, 0, 'zero opened');
  eq(r.openedTabs, 0, 'zero tabs');
  eq(state.windows.size, 0, 'state empty');
});

console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) { for (const f of failures) console.log(' •', f); process.exit(1); }
console.log('Restore tests passed ✓');
console.warn = realWarn;
