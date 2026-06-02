// Sessions, day-bundling, and snapshot diffing.
//
// A "session" is a contiguous run of snapshots whose timestamps are at most
// `gapMinutes` apart. Default: 60 minutes (configurable). Long gaps (sleep,
// browser closed) break sessions naturally.

export function bundleIntoSessions(indexEntries, gapMinutes = 60) {
  if (!Array.isArray(indexEntries) || indexEntries.length === 0) return [];
  // Work newest-first to keep the UI's natural reading order.
  const sorted = [...indexEntries].sort((a, b) => b.timestamp - a.timestamp);
  const gapMs = gapMinutes * 60 * 1000;

  const sessions = [];
  let current = null;
  for (const e of sorted) {
    if (!current) {
      current = newSession(e);
      sessions.push(current);
      continue;
    }
    const prevEarliest = current.startTs;
    if (prevEarliest - e.timestamp <= gapMs) {
      // continue same session — entries are newest-first, so e is older
      current.snapshots.push(e);
      current.startTs = e.timestamp;
      mergeStats(current, e);
    } else {
      current = newSession(e);
      sessions.push(current);
    }
  }
  for (const s of sessions) finalizeStats(s);
  return sessions;
}

function newSession(e) {
  return {
    id: `sess-${e.timestamp}-${e.id.slice(0, 8)}`,
    startTs: e.timestamp,
    endTs: e.timestamp,
    snapshots: [e],
    peakTabs: e.stats?.tabCount ?? 0,
    peakWindows: e.stats?.windowCount ?? 0,
    peakGroups: e.stats?.groupCount ?? 0,
    count: 1
  };
}

function mergeStats(s, e) {
  if ((e.stats?.tabCount ?? 0) > s.peakTabs) s.peakTabs = e.stats.tabCount;
  if ((e.stats?.windowCount ?? 0) > s.peakWindows) s.peakWindows = e.stats.windowCount;
  if ((e.stats?.groupCount ?? 0) > s.peakGroups) s.peakGroups = e.stats.groupCount;
  s.count += 1;
}

function finalizeStats(s) {
  // snapshots are pushed in newest-first then older order; reorder to
  // newest→oldest for display.
  s.snapshots.sort((a, b) => b.timestamp - a.timestamp);
}

// Returns [{ dateKey: 'YYYY-MM-DD', label, sessions: [...] }, ...] newest first.
export function groupByDay(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];
  const buckets = new Map();
  for (const s of sessions) {
    const d = new Date(s.endTs);
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  const out = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([dateKey, sess]) => ({
      dateKey,
      label: dayLabel(dateKey),
      sessions: sess.sort((a, b) => b.endTs - a.endTs)
    }));
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dayLabel(dateKey) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  if (dateKey === todayKey) return 'Today';
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const yestKey = `${yest.getFullYear()}-${pad2(yest.getMonth() + 1)}-${pad2(yest.getDate())}`;
  if (dateKey === yestKey) return 'Yesterday';
  // Within the last 6 days, show weekday name.
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const diffDays = Math.round((today - dt) / (24 * 3600 * 1000));
  if (diffDays > 1 && diffDays < 7) {
    return dt.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------- Diff ----------
//
// Given two full snapshots (with .windows[].tabs[]), compute what URLs were
// opened, closed, or kept. We match by URL (multiple tabs with the same URL
// are bucketed by count).

export function snapshotUrlCounts(snap) {
  const m = new Map();
  if (!snap || !Array.isArray(snap.windows)) return m;
  for (const w of snap.windows) {
    for (const t of w.tabs || []) {
      const url = t.url || '';
      const cur = m.get(url) || { count: 0, title: t.title || '' };
      cur.count += 1;
      if (!cur.title && t.title) cur.title = t.title;
      m.set(url, cur);
    }
  }
  return m;
}

export function computeDiff(prevSnap, curSnap) {
  const prev = snapshotUrlCounts(prevSnap);
  const cur = snapshotUrlCounts(curSnap);

  const added = [];     // tabs in cur that weren't in prev (delta count > 0)
  const removed = [];   // tabs in prev that aren't in cur (delta count > 0)
  const kept = [];      // tabs in both (smaller count of the two)

  const seen = new Set();
  for (const [url, { count, title }] of cur) {
    seen.add(url);
    const prevCount = prev.get(url)?.count || 0;
    const keepN = Math.min(prevCount, count);
    if (keepN > 0) kept.push({ url, title, count: keepN });
    const addedN = count - prevCount;
    if (addedN > 0) added.push({ url, title, count: addedN });
  }
  for (const [url, { count, title }] of prev) {
    if (seen.has(url)) continue;
    removed.push({ url, title, count });
  }
  // For URLs in both with prev > cur, the surplus on prev side is removed:
  for (const [url, { count: prevCount, title }] of prev) {
    if (!seen.has(url)) continue;
    const curCount = cur.get(url)?.count || 0;
    const removedN = prevCount - curCount;
    if (removedN > 0) removed.push({ url, title, count: removedN });
  }
  added.sort(byTitle);
  removed.sort(byTitle);
  kept.sort(byTitle);
  return { added, removed, kept };
}

function byTitle(a, b) {
  return (a.title || a.url).localeCompare(b.title || b.url);
}

export function summarizeDiff(diff) {
  if (!diff) return '';
  const a = diff.added.reduce((s, x) => s + x.count, 0);
  const r = diff.removed.reduce((s, x) => s + x.count, 0);
  if (a === 0 && r === 0) return 'no change';
  const parts = [];
  if (a > 0) parts.push(`+${a}`);
  if (r > 0) parts.push(`−${r}`);
  return parts.join(' ');
}
