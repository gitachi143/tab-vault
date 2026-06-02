// Tests for lib/sessions.js (pure functions — no chrome mocks needed).
import {
  bundleIntoSessions,
  groupByDay,
  computeDiff,
  summarizeDiff,
  snapshotUrlCounts
} from '../lib/sessions.js';

let pass = 0, fail = 0;
const failures = [];

function assert(c, m) { if (c) pass++; else { fail++; failures.push(m); console.log('  ✗', m); } }
function eq(a, b, m) { assert(JSON.stringify(a) === JSON.stringify(b), `${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function grp(name, fn) { console.log('\n▸', name); fn(); }

const MIN = 60 * 1000;

function entry(id, ts, tabCount = 1, opts = {}) {
  return { id, timestamp: ts, name: `s-${id}`, type: opts.type || 'auto', pinned: !!opts.pinned, stats: { tabCount, windowCount: 1, groupCount: 0 } };
}

grp('bundle: empty input', () => {
  eq(bundleIntoSessions([]), [], 'empty array returns empty array');
  eq(bundleIntoSessions(null), [], 'null returns empty array');
});

grp('bundle: single entry → single session', () => {
  const e = entry('a', 1_000_000);
  const out = bundleIntoSessions([e]);
  eq(out.length, 1, 'one session');
  eq(out[0].snapshots.length, 1, 'one snapshot');
  eq(out[0].startTs, 1_000_000, 'startTs');
  eq(out[0].endTs, 1_000_000, 'endTs');
});

grp('bundle: close in time → same session', () => {
  const t = 1_000_000;
  const entries = [
    entry('a', t),
    entry('b', t + 10 * MIN, 2),
    entry('c', t + 20 * MIN, 5)
  ];
  const out = bundleIntoSessions(entries, 60);
  eq(out.length, 1, 'one session');
  eq(out[0].snapshots.length, 3, 'three snapshots');
  eq(out[0].peakTabs, 5, 'peakTabs is max');
});

grp('bundle: large gap → new session', () => {
  const t = 1_000_000;
  const entries = [
    entry('a', t),
    entry('b', t + 90 * MIN) // gap > 60 minutes
  ];
  const out = bundleIntoSessions(entries, 60);
  eq(out.length, 2, 'two sessions due to gap');
});

grp('bundle: configurable gap', () => {
  const t = 1_000_000;
  const entries = [entry('a', t), entry('b', t + 16 * MIN)];
  eq(bundleIntoSessions(entries, 15).length, 2, 'gap=15min splits at 16min');
  eq(bundleIntoSessions(entries, 30).length, 1, 'gap=30min keeps together');
});

grp('bundle: snapshots within a session are newest-first', () => {
  const t = 1_000_000;
  const entries = [entry('old', t), entry('mid', t + 5 * MIN), entry('new', t + 10 * MIN)];
  const out = bundleIntoSessions(entries, 60);
  eq(out[0].snapshots.map(s => s.id), ['new', 'mid', 'old'], 'newest first');
});

grp('groupByDay: separate days', () => {
  const day1 = new Date(2026, 4, 24, 10, 0).getTime();
  const day2 = new Date(2026, 4, 22, 10, 0).getTime();
  const sessions = bundleIntoSessions([
    entry('a', day1),
    entry('b', day2)
  ], 60);
  const days = groupByDay(sessions);
  eq(days.length, 2, 'two day buckets');
});

grp('groupByDay: today/yesterday labels (relative to mocked date)', () => {
  // We can't easily inject "today" — just verify the date key is set and
  // labels are strings.
  const now = Date.now();
  const sessions = bundleIntoSessions([entry('a', now)], 60);
  const days = groupByDay(sessions);
  assert(days[0].dateKey && /\d{4}-\d{2}-\d{2}/.test(days[0].dateKey), 'dateKey set');
  assert(typeof days[0].label === 'string' && days[0].label.length > 0, 'label is non-empty string');
});

grp('snapshotUrlCounts: tallies duplicates', () => {
  const snap = {
    windows: [
      { tabs: [
        { url: 'https://a.com/', title: 'A' },
        { url: 'https://a.com/', title: 'A' },
        { url: 'https://b.com/', title: 'B' }
      ] }
    ]
  };
  const m = snapshotUrlCounts(snap);
  eq(m.get('https://a.com/').count, 2, 'a.com counted twice');
  eq(m.get('https://b.com/').count, 1, 'b.com counted once');
});

grp('computeDiff: added/removed/kept', () => {
  const prev = { windows: [{ tabs: [
    { url: 'https://keep.com/', title: 'Keep' },
    { url: 'https://gone.com/', title: 'Gone' }
  ]}]};
  const cur = { windows: [{ tabs: [
    { url: 'https://keep.com/', title: 'Keep' },
    { url: 'https://new.com/', title: 'New' }
  ]}]};
  const d = computeDiff(prev, cur);
  eq(d.added.map(x => x.url), ['https://new.com/'], 'added=new.com');
  eq(d.removed.map(x => x.url), ['https://gone.com/'], 'removed=gone.com');
  eq(d.kept.map(x => x.url), ['https://keep.com/'], 'kept=keep.com');
});

grp('computeDiff: duplicates handled', () => {
  const prev = { windows: [{ tabs: [
    { url: 'https://x.com/' }, { url: 'https://x.com/' }, { url: 'https://x.com/' }
  ]}]};
  const cur = { windows: [{ tabs: [
    { url: 'https://x.com/' }
  ]}]};
  const d = computeDiff(prev, cur);
  eq(d.added, [], 'no additions');
  eq(d.removed.length, 1, 'one removal entry');
  eq(d.removed[0].count, 2, 'removed count = 2 (had 3, now 1)');
  eq(d.kept[0].count, 1, 'kept count = 1');
});

grp('computeDiff: identical → no changes', () => {
  const snap = { windows: [{ tabs: [{ url: 'https://x.com/' }] }] };
  const d = computeDiff(snap, snap);
  eq(d.added, [], 'no added');
  eq(d.removed, [], 'no removed');
  eq(d.kept.length, 1, 'kept');
});

grp('summarizeDiff', () => {
  eq(summarizeDiff({ added: [], removed: [], kept: [] }), 'no change', 'empty');
  eq(summarizeDiff({ added: [{count:2}], removed: [], kept: [] }), '+2', 'plus only');
  eq(summarizeDiff({ added: [], removed: [{count:1}], kept: [] }), '−1', 'minus only');
  eq(summarizeDiff({ added: [{count:3}], removed: [{count:1},{count:2}], kept: [] }), '+3 −3', 'both');
});

console.log(`\n— ${pass} passed, ${fail} failed —`);
if (fail > 0) {
  for (const f of failures) console.log(' •', f);
  process.exit(1);
}
console.log('Sessions tests passed ✓');
