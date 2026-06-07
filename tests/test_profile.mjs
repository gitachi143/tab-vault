// Tests for multi-profile behavior: profile-id generation, label persistence,
// export envelope contents, cross-profile import detection.

import { createMockChrome } from './mock-chrome.mjs';

const harness = createMockChrome();
globalThis.chrome = harness.chromeApi;
const realWarn = console.warn;
console.warn = () => {};

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
await grp('get-profile generates a stable id on first call', async () => {
  reset();
  const p1 = await sendMessage({ type: 'get-profile' });
  assert(typeof p1.profileId === 'string' && p1.profileId.length >= 8, 'profileId is non-empty string');
  assert(typeof p1.shortId === 'string' && p1.shortId.length === 8, 'shortId is 8 chars');
  const p2 = await sendMessage({ type: 'get-profile' });
  eq(p2.profileId, p1.profileId, 'profileId stable across calls');
});

// --------------------------------------------------------------------------
await grp('profile label round-trips through settings', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { profileLabel: 'Work' } });
  const p = await sendMessage({ type: 'get-profile' });
  eq(p.profileLabel, 'Work', 'label persisted');
});

// --------------------------------------------------------------------------
await grp('export-all embeds profileId and profileLabel', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { profileLabel: 'Personal', maxSnapshots: 0 } });
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-all' });
  assert(typeof exp.data.profileId === 'string', 'export has profileId');
  eq(exp.data.profileLabel, 'Personal', 'export has profileLabel');
});

// --------------------------------------------------------------------------
await grp('export filename includes profile label', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { profileLabel: 'Work-Laptop' } });
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-all' });
  assert(/tab-vault-Work-Laptop-\d{8}-\d{6}\.json/.test(exp.filename), `filename matches profile, got ${exp.filename}`);
});

// --------------------------------------------------------------------------
await grp('export filename falls back to short profile id when label is empty', async () => {
  reset();
  // No label set.
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-all' });
  assert(/tab-vault-[0-9a-f]{8}-\d{8}-\d{6}\.json/.test(exp.filename), `filename has short id, got ${exp.filename}`);
});

// --------------------------------------------------------------------------
await grp('inspect-import flags cross-profile sources', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { profileLabel: 'Profile-A' } });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-all' });

  // Manually pretend this export came from a different profile.
  const otherPayload = { ...exp.data, profileId: 'completely-different-id', profileLabel: 'Profile-B' };
  const info = await sendMessage({ type: 'inspect-import', payload: otherPayload });
  assert(info.ok, 'valid file ok=true');
  eq(info.isSameProfile, false, 'flagged as cross-profile');
  eq(info.fromProfileLabel, 'Profile-B', 'fromProfileLabel surfaced');
  eq(info.currentProfileLabel, 'Profile-A', 'currentProfileLabel surfaced');
});

// --------------------------------------------------------------------------
await grp('inspect-import: same-profile export is NOT flagged', async () => {
  reset();
  await sendMessage({ type: 'set-settings', patch: { profileLabel: 'Same' } });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-all' });
  const info = await sendMessage({ type: 'inspect-import', payload: exp.data });
  assert(info.ok, 'valid');
  eq(info.isSameProfile, true, 'same profile not flagged');
});

// --------------------------------------------------------------------------
await grp('inspect-import: a payload with no profileId is treated as same-profile', async () => {
  reset();
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  const { snapshot } = await sendMessage({ type: 'capture' });
  // Build a bare snapshot envelope without any profile metadata
  const info = await sendMessage({ type: 'inspect-import', payload: snapshot });
  assert(info.ok, 'valid bare snapshot');
  eq(info.isSameProfile, true, 'no profileId → no warning');
});

// --------------------------------------------------------------------------
await grp('inspect-import: invalid payload is rejected with precise error', async () => {
  reset();
  const info = await sendMessage({ type: 'inspect-import', payload: { kind: 'tab-vault-snapshot', version: 1, snapshot: { id: 'x', timestamp: 1, windows: 'oops' } } });
  assert(!info.ok, 'invalid payload ok=false');
  assert(/windows/.test(info.validationError), `error names the bad field, got: ${info.validationError}`);
});

// --------------------------------------------------------------------------
await grp('strict import validation rejects malformed snapshot via import message', async () => {
  reset();
  let err;
  try {
    await sendMessage({ type: 'import', payload: {
      kind: 'tab-vault-snapshot', version: 1,
      snapshot: { id: 'x', timestamp: 1, windows: [{ tabs: [{ title: 'no-url' }] }] }
    } });
  } catch (e) { err = e; }
  assert(err && /Invalid file/.test(err.message), 'import rejects malformed snapshot');
  // And nothing was added
  const list = await sendMessage({ type: 'list-index' });
  eq(list.index.length, 0, 'index unchanged');
});

// --------------------------------------------------------------------------
await grp('set-browser-info round-trips and feeds get-profile', async () => {
  reset();
  await sendMessage({ type: 'set-browser-info', name: 'Brave' });
  const p = await sendMessage({ type: 'get-profile' });
  eq(p.browserName, 'Brave', 'browser name persisted');

  await sendMessage({ type: 'set-browser-info', name: 'Chrome' });
  const p2 = await sendMessage({ type: 'get-profile' });
  eq(p2.browserName, 'Chrome', 'browser name overwritten');
});

await grp('export-all envelope includes browserName from storage', async () => {
  reset();
  await sendMessage({ type: 'set-browser-info', name: 'Brave' });
  await sendMessage({ type: 'set-settings', patch: { profileLabel: 'My-Brave', maxSnapshots: 0 } });
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-all' });
  eq(exp.data.browserName, 'Brave', 'export envelope has browserName=Brave');
  eq(exp.data.profileLabel, 'My-Brave', 'export envelope has label');
});

await grp('export-one envelope includes browserName', async () => {
  reset();
  await sendMessage({ type: 'set-browser-info', name: 'Edge' });
  seedWindow({ tabs: [{ url: 'https://x.com/' }] });
  const { snapshot } = await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-one', id: snapshot.id });
  eq(exp.data.browserName, 'Edge', 'export-one envelope has browserName=Edge');
});

await grp('default browserName is Chrome when unset', async () => {
  reset();
  const p = await sendMessage({ type: 'get-profile' });
  eq(p.browserName, 'Chrome', 'default Chrome');
});

await grp('import propagates profileId from envelope for downstream UI', async () => {
  reset();
  // Build an export from this profile, then mutate to a different profile id
  // and verify import still works (warning is presentation-layer).
  await sendMessage({ type: 'set-settings', patch: { profileLabel: 'A', maxSnapshots: 0 } });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  await sendMessage({ type: 'capture' });
  const exp = await sendMessage({ type: 'export-all' });
  const payload = { ...exp.data, profileId: 'foreign-id', profileLabel: 'B' };

  const r = await sendMessage({ type: 'import', payload, merge: true });
  assert(r.imported >= 1, 'import succeeded');
  eq(r.fromProfileId, 'foreign-id', 'fromProfileId returned');
  eq(r.fromProfileLabel, 'B', 'fromProfileLabel returned');
});

console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) { for (const f of failures) console.log(' •', f); process.exit(1); }
console.log('Profile tests passed ✓');
console.warn = realWarn;
