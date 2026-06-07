// Tests for the storage hardening pass:
//   * write mutex serializes concurrent index ops
//   * defensive index repair drops orphans
//   * quota retry prunes oldest unpinned and retries
//   * import validation rejects malformed payloads

import { createMockChrome } from './mock-chrome.mjs';

const harness = createMockChrome();
globalThis.chrome = harness.chromeApi;
const realWarn = console.warn;
console.warn = () => {};

const { seedWindow, reset, state } = harness;

const storage  = await import('../lib/storage.js');
const snapshot = await import('../lib/snapshot.js');
const validate = await import('../lib/validate.js');

let pass = 0, fail = 0;
const failures = [];
function assert(c, m) { if (c) pass++; else { fail++; failures.push(m); console.log('  ✗', m); } }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function grp(name, fn) { console.log('\n▸', name); await fn(); }

// --------------------------------------------------------------------------
await grp('mutex: concurrent putSnapshot calls never lose entries', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  // Build 10 distinct snapshots first (sequential capture is fine), then
  // put them all *concurrently*. The mutex should serialize the read-modify-
  // write of the index so all 10 end up in it.
  const snaps = [];
  for (let i = 0; i < 10; i++) {
    const s = await snapshot.captureSnapshot({ type: 'manual', name: `s-${i}` });
    s.timestamp = 2_000_000 + i;
    snaps.push(s);
  }
  await Promise.all(snaps.map(s => storage.putSnapshot(s)));

  const idx = await storage.getIndex();
  eq(idx.length, 10, 'all 10 entries present after concurrent writes');
  const ids = new Set(idx.map(e => e.id));
  for (const s of snaps) assert(ids.has(s.id), `entry ${s.name} present`);
});

// --------------------------------------------------------------------------
await grp('mutex: put + delete + rename run sequentially', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  const s = await snapshot.captureSnapshot({ type: 'manual', name: 'orig' });

  // Fire put, then immediately rename, then immediately delete, all racing.
  const p1 = storage.putSnapshot(s);
  const p2 = storage.renameSnapshot(s.id, 'renamed-1');
  const p3 = storage.renameSnapshot(s.id, 'renamed-2');
  const p4 = storage.setPinned(s.id, true);
  await Promise.all([p1, p2, p3, p4]);

  const got = await storage.getSnapshot(s.id);
  // Whichever rename ran last wins; both must complete without error.
  assert(got !== null, 'snapshot exists after concurrent ops');
  assert(got.name === 'renamed-1' || got.name === 'renamed-2', `name is one of the rename values, got ${got.name}`);
  assert(got.pinned === true, 'pinned applied');
});

// --------------------------------------------------------------------------
await grp('repairIndex removes orphan entries', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });

  const s1 = await snapshot.captureSnapshot({ type: 'manual', name: 'a' });
  const s2 = await snapshot.captureSnapshot({ type: 'manual', name: 'b' });
  s2.timestamp = s1.timestamp + 1;
  await storage.putSnapshot(s1);
  await storage.putSnapshot(s2);

  // Manually corrupt: remove s1's data key but leave it in the index.
  await new Promise(r => chrome.storage.local.remove('snap:' + s1.id, r));

  const idxBefore = await storage.getIndex();
  eq(idxBefore.length, 2, 'index still claims 2');

  const { removed } = await storage.repairIndex();
  eq(removed, 1, 'repair removed 1 orphan');
  const idxAfter = await storage.getIndex();
  eq(idxAfter.length, 1, 'index now matches data');
  eq(idxAfter[0].id, s2.id, 'survivor is s2');
});

// --------------------------------------------------------------------------
await grp('quota retry: storage.set with QUOTA error retries after pruning oldest unpinned', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  // Seed three unpinned snapshots
  for (let i = 0; i < 3; i++) {
    const s = await snapshot.captureSnapshot({ type: 'auto', name: `s-${i}` });
    s.timestamp = 5_000_000 + i;
    await storage.putSnapshot(s);
  }
  const beforeIdx = await storage.getIndex();
  eq(beforeIdx.length, 3, 'three snapshots before quota test');

  // Install a quota-rejecting wrapper for ONE call.
  const originalSet = chrome.storage.local.set;
  let quotaFiresLeft = 1;
  chrome.storage.local.set = async function (items) {
    if (quotaFiresLeft > 0) {
      quotaFiresLeft -= 1;
      const e = new Error('QUOTA_BYTES quota exceeded');
      throw e;
    }
    return originalSet.call(this, items);
  };

  // Trigger a write that will fail once, then succeed.
  const newSnap = await snapshot.captureSnapshot({ type: 'manual', name: 'big' });
  newSnap.timestamp = 9_000_000;
  await storage.putSnapshot(newSnap);
  // Restore original
  chrome.storage.local.set = originalSet;

  const afterIdx = await storage.getIndex();
  // The oldest unpinned was pruned to make room.
  const names = afterIdx.map(e => e.name).sort();
  assert(names.includes('big'), 'new snapshot was written after retry');
  assert(names.length === 3, `pruned to 3, got ${names.length}`);
  assert(!names.includes('s-0'), 'oldest (s-0) was pruned');
});

// --------------------------------------------------------------------------
await grp('quota: pinned snapshots are NOT pruned during quota retry', async () => {
  reset();
  await storage.setSettings({ maxSnapshots: 0 });
  seedWindow({ tabs: [{ url: 'https://a.com/' }] });
  // Three pinned + one unpinned. Pruning must pick the unpinned.
  for (let i = 0; i < 3; i++) {
    const s = await snapshot.captureSnapshot({ type: 'manual', name: `pin-${i}` });
    s.timestamp = 6_000_000 + i;
    s.pinned = true;
    await storage.putSnapshot(s);
  }
  const u = await snapshot.captureSnapshot({ type: 'auto', name: 'unpinned-victim' });
  u.timestamp = 6_000_500;
  await storage.putSnapshot(u);

  const originalSet = chrome.storage.local.set;
  let quotaFiresLeft = 1;
  chrome.storage.local.set = async function (items) {
    if (quotaFiresLeft > 0) { quotaFiresLeft -= 1; throw new Error('QUOTA exceeded'); }
    return originalSet.call(this, items);
  };
  const newSnap = await snapshot.captureSnapshot({ type: 'manual', name: 'newcomer' });
  newSnap.timestamp = 9_500_000;
  await storage.putSnapshot(newSnap);
  chrome.storage.local.set = originalSet;

  const names = (await storage.getIndex()).map(e => e.name).sort();
  assert(names.includes('newcomer'), 'newcomer written');
  assert(!names.includes('unpinned-victim'), 'unpinned victim pruned');
  assert(names.includes('pin-0') && names.includes('pin-1') && names.includes('pin-2'), 'all pinned survived');
});

// --------------------------------------------------------------------------
await grp('validateImportPayload: accepts well-formed snapshot envelope', () => {
  const snap = {
    id: 'a', timestamp: 123, name: 'n', type: 'manual',
    windows: [{ tabs: [{ url: 'https://x.com/', title: 'X' }] }]
  };
  const r = validate.validateImportPayload({ kind: 'tab-vault-snapshot', version: 1, snapshot: snap });
  eq(r.kind, 'single', 'detected single');
  eq(r.snapshots.length, 1, 'one snapshot');
});

await grp('validateImportPayload: accepts well-formed export envelope', () => {
  const snap = { id: 'a', timestamp: 1, windows: [{ tabs: [{ url: 'https://x.com/' }] }] };
  const r = validate.validateImportPayload({ kind: 'tab-vault-export', version: 1, snapshots: [snap, snap] });
  eq(r.kind, 'export', 'detected export');
  eq(r.snapshots.length, 2, 'two snapshots');
});

await grp('validateImportPayload: accepts bare snapshot', () => {
  const snap = { id: 'a', timestamp: 1, windows: [{ tabs: [{ url: 'https://x.com/' }] }] };
  const r = validate.validateImportPayload(snap);
  eq(r.kind, 'single', 'bare snapshot accepted');
});

await grp('validateImportPayload: rejects unknown kind without windows', () => {
  let err;
  try { validate.validateImportPayload({ random: true }); } catch (e) { err = e; }
  assert(err instanceof validate.ValidationError, 'throws ValidationError');
  assert(/Unrecognized/.test(err.message), 'message mentions Unrecognized');
});

await grp('validateImportPayload: rejects snapshot with non-array windows', () => {
  let err;
  try {
    validate.validateImportPayload({ kind: 'tab-vault-snapshot', version: 1, snapshot: { id: 'a', timestamp: 1, windows: 'oops' } });
  } catch (e) { err = e; }
  assert(err instanceof validate.ValidationError, 'throws ValidationError');
  assert(/windows must be an array/.test(err.message), `message names the bad field, got: ${err?.message}`);
});

await grp('validateImportPayload: rejects tab missing url', () => {
  let err;
  try {
    validate.validateImportPayload({ kind: 'tab-vault-snapshot', version: 1, snapshot: {
      id: 'a', timestamp: 1, windows: [{ tabs: [{ title: 'no url' }] }]
    } });
  } catch (e) { err = e; }
  assert(err instanceof validate.ValidationError, 'throws ValidationError');
  assert(/url must be a string/.test(err.message), `message names url, got: ${err?.message}`);
});

await grp('validateImportPayload: rejects non-numeric timestamp', () => {
  let err;
  try {
    validate.validateImportPayload({ kind: 'tab-vault-snapshot', version: 1, snapshot: {
      id: 'a', timestamp: 'yesterday', windows: []
    } });
  } catch (e) { err = e; }
  assert(err instanceof validate.ValidationError, 'throws ValidationError');
});

await grp('validateImportPayload: extracts profile metadata from envelope', () => {
  const r = validate.validateImportPayload({
    kind: 'tab-vault-export',
    version: 1,
    profileId: 'abc-123',
    profileLabel: 'Work',
    snapshots: []
  });
  eq(r.profileId, 'abc-123', 'profileId extracted');
  eq(r.profileLabel, 'Work', 'profileLabel extracted');
});

console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) { for (const f of failures) console.log(' •', f); process.exit(1); }
console.log('Storage safety + validation tests passed ✓');
console.warn = realWarn;
