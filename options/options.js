import { relativeTime, formatDate, safeHostname, bytesHuman } from '../lib/utils.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  days: [],                // [{ dateKey, label, sessions: [...] }]
  indexById: new Map(),    // id → index entry (with _diffSummary)
  current: null,           // currently loaded full snapshot
  currentDiff: null,       // diff vs previous in session
  selectedId: null,
  query: '',
  settings: null,
  // window selection for selective restore
  selection: new Map()
};

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      if (resp && resp.error) return reject(new Error(resp.error));
      resolve(resp);
    });
  });
}

function toast(text, ms = 2200) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else document.documentElement.removeAttribute('data-theme');
}

// ---------- Settings ----------

async function loadSettings() {
  const { settings } = await send({ type: 'get-settings' });
  state.settings = settings;
  applyTheme(settings.theme);
  $('#auto-minutes').value = String(settings.autoSnapshotMinutes);
  $('#session-gap').value = String(settings.sessionGapMinutes ?? 60);
  $('#max-snapshots').value = String(settings.maxSnapshots);
  $('#theme').value = settings.theme;
  $('#live-enabled').checked = !!settings.liveSnapshotEnabled;
  $('#confirm-restore').checked = !!settings.confirmRestore;
  $('#profile-label').value = settings.profileLabel || '';
  await applyProfileChip();
}

async function applyProfileChip() {
  try {
    const p = await send({ type: 'get-profile' });
    state.profile = p;
    const chip = $('#profile-chip');
    if (p.profileLabel) {
      chip.textContent = p.profileLabel;
      chip.classList.remove('unlabeled');
      chip.title = `Profile: ${p.profileLabel} (id ${p.shortId}). Each Chrome profile keeps its own history.`;
    } else {
      chip.textContent = p.shortId;
      chip.classList.add('unlabeled');
      chip.title = `Unnamed profile (id ${p.shortId}). Set a label below to make it easier to recognise.`;
    }
  } catch { /* ignore */ }
}

async function patchSettings(patch) {
  const { settings } = await send({ type: 'set-settings', patch });
  state.settings = settings;
  applyTheme(settings.theme);
}

// ---------- Timeline ----------

async function loadTimeline() {
  const { days, usage } = await send({ type: 'get-timeline' });
  state.days = days || [];
  state.indexById = new Map();
  let total = 0;
  for (const d of state.days) for (const s of d.sessions) {
    for (const snap of s.snapshots) {
      state.indexById.set(snap.id, snap);
      total += 1;
    }
  }
  $('#stats-mini').textContent = `${total} snapshot${total === 1 ? '' : 's'} • ${bytesHuman(usage)} used`;
  $('#list-count').textContent = String(total);
  renderTimeline();
  if (!state.current && total === 0) renderDetail();
}

function renderTimeline() {
  const root = $('#timeline');
  root.innerHTML = '';
  const empty = $('#snap-empty');
  const q = state.query.trim().toLowerCase();

  let any = false;
  for (const day of state.days) {
    const matchingSessions = day.sessions
      .map(s => ({ ...s, snapshots: s.snapshots.filter(e => matchesQuery(e, q)) }))
      .filter(s => s.snapshots.length > 0);
    if (matchingSessions.length === 0) continue;

    const dayEl = document.createElement('div');
    dayEl.className = 'day-block';
    const head = document.createElement('div');
    head.className = 'day-head';
    head.textContent = day.label;
    dayEl.appendChild(head);

    for (const sess of matchingSessions) {
      dayEl.appendChild(renderSession(sess));
      any = true;
    }
    root.appendChild(dayEl);
  }
  empty.hidden = any;
}

function matchesQuery(entry, q) {
  if (!q) return true;
  if ((entry.name || '').toLowerCase().includes(q)) return true;
  if ((entry.type || '').toLowerCase().includes(q)) return true;
  // We don't load full snapshots for typeahead — that's expensive.
  // Names and types cover the common case; selecting a snapshot reveals tabs.
  return false;
}

function renderSession(sess) {
  const wrap = document.createElement('div');
  wrap.className = 'session-block';
  const head = document.createElement('div');
  head.className = 'session-head';
  const dot = document.createElement('span');
  dot.className = 'dot';
  head.appendChild(dot);
  const t = document.createElement('span');
  t.className = 'session-title';
  t.textContent = sessionTitle(sess);
  head.appendChild(t);
  const meta = document.createElement('span');
  meta.className = 'session-meta';
  meta.textContent = `· ${sess.count} snapshot${sess.count === 1 ? '' : 's'} · peak ${sess.peakTabs} tab${sess.peakTabs === 1 ? '' : 's'}`;
  head.appendChild(meta);
  wrap.appendChild(head);

  for (const snap of sess.snapshots) {
    wrap.appendChild(renderSnapRow(snap));
  }
  return wrap;
}

function sessionTitle(sess) {
  const start = new Date(sess.startTs);
  const end = new Date(sess.endTs);
  const fmt = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sess.startTs === sess.endTs) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function renderSnapRow(e) {
  const li = document.createElement('div');
  li.className = 'snap-row' + (e.id === state.selectedId ? ' active' : '') + (e.pinned ? ' pinned' : '');
  li.dataset.id = e.id;

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = e.name;

  const badge = document.createElement('span');
  badge.className = `badge type ${e.type || 'manual'}`;
  badge.textContent = e.type || 'manual';

  // diff badge
  const diff = document.createElement('span');
  let dClass = 'same';
  let dText = '·';
  if (e._diffSummary) {
    if (e._diffSummary.startsWith('+')) dClass = 'plus';
    else if (e._diffSummary.startsWith('−')) dClass = 'minus';
    dText = e._diffSummary;
  }
  diff.className = `diff-badge ${dClass}`;
  diff.textContent = dText;
  diff.title = 'Δ tabs vs. previous snapshot in this session';

  const sub = document.createElement('div');
  sub.className = 'sub';
  const stats = e.stats || {};
  const time = new Date(e.timestamp);
  sub.textContent = `${pad(time.getHours())}:${pad(time.getMinutes())} · ${stats.tabCount ?? 0} tabs · ${stats.windowCount ?? 0} window${(stats.windowCount ?? 0) === 1 ? '' : 's'} · ${stats.groupCount ?? 0} group${(stats.groupCount ?? 0) === 1 ? '' : 's'}${e.pinned ? ' · ★ pinned' : ''}`;

  li.append(name, diff, badge, sub);
  li.addEventListener('click', () => selectSnapshot(e.id));
  return li;
}

// ---------- Snapshot detail ----------

async function selectSnapshot(id) {
  state.selectedId = id;
  state.selection = new Map();
  $$('.snap-row').forEach(el => el.classList.toggle('active', el.dataset.id === id));

  let snapshot = null;
  try {
    const resp = await send({ type: 'get-snapshot', id });
    snapshot = resp.snapshot;
  } catch { /* fall through to missing state */ }

  if (!snapshot) {
    state.current = null;
    state.currentDiff = null;
    renderMissingDetail();
    return;
  }
  state.current = snapshot;

  // Compute diff vs previous in session, if any.
  const idx = state.indexById.get(id);
  const sess = findSessionForId(id);
  let prevId = null;
  if (sess) {
    const pos = sess.snapshots.findIndex(s => s.id === id);
    if (pos >= 0 && pos < sess.snapshots.length - 1) {
      prevId = sess.snapshots[pos + 1].id;
    }
  }
  if (prevId) {
    try {
      const { diff, summary } = await send({ type: 'get-diff', fromId: prevId, toId: id });
      state.currentDiff = { diff, summary, prevId };
    } catch { state.currentDiff = null; }
  } else {
    state.currentDiff = null;
  }
  renderDetail();
}

function renderMissingDetail() {
  const empty = $('#detail-empty');
  const detail = $('#detail');
  detail.hidden = true;
  empty.hidden = false;
  empty.innerHTML = '<p>This snapshot is no longer available.</p><p class="muted">It may have been pruned by retention or deleted in another window. Pick a different one from the timeline.</p>';
}

function findSessionForId(id) {
  for (const d of state.days) for (const s of d.sessions) {
    if (s.snapshots.some(x => x.id === id)) return s;
  }
  return null;
}

const COLORS = ['grey','blue','red','yellow','green','pink','purple','cyan','orange'];
function colorClass(c) { return COLORS.includes(c) ? `tg-${c}` : 'tg-grey'; }

function renderDetail() {
  const empty = $('#detail-empty');
  const detail = $('#detail');
  const snap = state.current;
  if (!snap) {
    empty.hidden = false;
    detail.hidden = true;
    return;
  }
  empty.hidden = true;
  detail.hidden = false;
  detail.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'detail-head';

  const titleEl = document.createElement('h2');
  titleEl.textContent = snap.name;
  titleEl.title = 'Double-click to rename';
  titleEl.addEventListener('dblclick', renameCurrent);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${formatDate(snap.timestamp)} · ${snap.stats?.tabCount ?? 0} tabs · ${snap.stats?.windowCount ?? 0} windows · ${snap.stats?.groupCount ?? 0} groups · type: ${snap.type}${snap.pinned ? ' · ★ pinned' : ''}`;

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const btnRestore = mkBtn('Restore this snapshot…', 'restore-primary', () => doRestore('new-windows'));
  btnRestore.title = 'Opens new windows for every saved window. Confirms first.';
  const btnRestoreSelected = mkBtn('Restore selected…', '', () => doRestore('selected'));
  btnRestoreSelected.id = 'btn-restore-selected';
  const btnAdvanced = mkBtn('More restore modes ▾', '', (e) => openRestoreMenu(e));
  const btnExport = mkBtn('Export', '', exportCurrent);
  const btnRename = mkBtn('Rename', '', renameCurrent);
  const btnPin = mkBtn(snap.pinned ? 'Unpin' : 'Pin', '', togglePin);
  const btnDelete = mkBtn('Delete', 'danger', deleteCurrent);
  actions.append(btnRestore, btnRestoreSelected, btnAdvanced, btnExport, btnRename, btnPin, btnDelete);

  head.append(titleEl, actions, meta);
  detail.append(head);

  // Diff section (if there's a previous snapshot in the same session)
  if (state.currentDiff && state.currentDiff.diff) {
    detail.append(renderDiffSection(state.currentDiff));
  }

  for (const w of snap.windows) {
    detail.append(renderWindowBlock(w));
  }

  updateRestoreSelectedDisabled();
}

function renderDiffSection({ diff, summary }) {
  const section = document.createElement('section');
  section.className = 'diff-section';
  const header = document.createElement('header');
  const lbl = document.createElement('span');
  lbl.textContent = 'Changes since previous snapshot in this session';
  const sum = document.createElement('span');
  sum.className = 'summary';
  sum.textContent = summary;
  header.append(lbl, sum);
  section.append(header);

  const cols = document.createElement('div');
  cols.className = 'diff-cols';
  cols.append(diffCol('added', 'Opened', diff.added));
  cols.append(diffCol('removed', 'Closed', diff.removed));
  section.append(cols);
  return section;
}

function diffCol(kind, label, items) {
  const div = document.createElement('div');
  div.className = `diff-col ${kind}`;
  const h = document.createElement('h4');
  const total = items.reduce((s, x) => s + x.count, 0);
  h.textContent = total > 0 ? `${label} (${total})` : label;
  div.append(h);
  if (items.length === 0) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No changes';
    div.append(none);
    return div;
  }
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = (it.count > 1 ? `${it.title || safeHostname(it.url)} ×${it.count}` : (it.title || safeHostname(it.url)));
    const u = document.createElement('span');
    u.className = 'url';
    u.textContent = it.url;
    li.append(t, u);
    ul.append(li);
  }
  div.append(ul);
  return div;
}

function openRestoreMenu(ev) {
  // Simple inline confirm modal listing the three modes.
  ev.preventDefault();
  showChoiceModal('Choose restore mode', [
    { label: 'New windows (one per saved window)', value: 'new-windows', desc: 'Recreates the window layout exactly.' },
    { label: 'Single new window', value: 'single-window', desc: 'All tabs combined into one new window.' },
    { label: 'Append to current window', value: 'current', desc: 'Adds the saved tabs to the window you have open now.' }
  ]).then(mode => {
    if (mode) doRestore(mode);
  });
}

function showChoiceModal(title, options) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal';
    const h = document.createElement('h3');
    h.textContent = title;
    box.append(h);
    for (const o of options) {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.style.margin = '6px 0';
      btn.style.textAlign = 'left';
      btn.innerHTML = `<strong>${o.label}</strong><br><span class="muted" style="font-size:12px">${o.desc}</span>`;
      btn.addEventListener('click', () => done(o.value));
      box.append(btn);
    }
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    cancel.style.marginTop = '10px';
    cancel.addEventListener('click', () => done(null));
    box.append(cancel);
    back.append(box);
    root.append(back);
    const keyHandler = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    function done(v) {
      document.removeEventListener('keydown', keyHandler);
      root.innerHTML = '';
      resolve(v);
    }
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    document.addEventListener('keydown', keyHandler);
  });
}

function mkBtn(text, className, handler) {
  const b = document.createElement('button');
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener('click', handler);
  return b;
}

function renderWindowBlock(w) {
  const block = document.createElement('section');
  block.className = 'window-block';
  block.dataset.windowId = String(w.windowId);

  const head = document.createElement('div');
  head.className = 'window-head';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.title = 'Select window for selective restore';
  check.addEventListener('click', e => e.stopPropagation());
  check.addEventListener('change', () => toggleWindowSelection(w, check.checked, block));

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = w.focused ? `Window ${w.windowId} (focused)` : `Window ${w.windowId}`;

  const counts = document.createElement('span');
  counts.className = 'muted';
  counts.style.fontSize = '12px';
  counts.textContent = `${w.tabs.length} tabs · ${w.groups.length} groups · ${w.state}`;

  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▾';

  head.append(check, title, counts, chev);
  head.addEventListener('click', (ev) => {
    if (ev.target === check) return;
    block.classList.toggle('collapsed');
    chev.textContent = block.classList.contains('collapsed') ? '▸' : '▾';
  });

  const body = document.createElement('div');
  body.className = 'window-body';

  const groupedIds = new Set();
  for (const g of w.groups) {
    const groupTabs = w.tabs.filter(t => t.groupId === g.id);
    if (groupTabs.length === 0) continue;
    body.append(renderGroup(w, g, groupTabs));
    groupTabs.forEach(t => groupedIds.add(t.index));
  }
  const ungrouped = w.tabs.filter(t => !groupedIds.has(t.index));
  if (ungrouped.length > 0) {
    body.append(renderTabsUl(w, ungrouped));
  }

  block.append(head, body);
  return block;
}

function renderGroup(w, g, tabs) {
  const wrap = document.createElement('div');
  wrap.className = 'group-block';
  const head = document.createElement('div');
  head.className = 'group-head';
  const dot = document.createElement('span');
  dot.className = `group-color ${colorClass(g.color)}`;
  const t = document.createElement('span');
  t.textContent = g.title || '(unnamed group)';
  const cnt = document.createElement('span');
  cnt.className = 'muted';
  cnt.style.marginLeft = 'auto';
  cnt.textContent = `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`;
  head.append(dot, t, cnt);
  wrap.append(head, renderTabsUl(w, tabs));
  return wrap;
}

function renderTabsUl(w, tabs) {
  const ul = document.createElement('ul');
  ul.className = 'tabs-ul';
  for (const t of tabs.slice().sort((a, b) => a.index - b.index)) {
    ul.append(renderTabRow(w, t));
  }
  return ul;
}

function renderTabRow(w, t) {
  const li = document.createElement('li');
  li.className = 'tab-row';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.title = 'Include in selective restore';
  cb.addEventListener('change', () => toggleTabSelection(w, t, cb.checked));
  cb.dataset.win = String(w.windowId);
  cb.dataset.tabkey = `${w.windowId}:${t.index}`;

  const fav = document.createElement('span');
  fav.className = 'favicon';
  if (t.favIconUrl) {
    const img = document.createElement('img');
    img.src = t.favIconUrl;
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    fav.append(img);
  }

  const titleWrap = document.createElement('div');
  titleWrap.className = 'title-wrap';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = t.title || safeHostname(t.url) || '(untitled)';
  const url = document.createElement('div');
  url.className = 'url';
  url.textContent = t.url || '';
  titleWrap.append(title, url);

  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = '6px';
  if (t.pinned) {
    const p = document.createElement('span');
    p.className = 'pinned';
    p.textContent = '📌';
    p.title = 'Pinned tab';
    right.append(p);
  }
  // Copy URL button — explicitly DOES NOT open a tab.
  const copyBtn = document.createElement('button');
  copyBtn.className = 'open-btn';
  copyBtn.title = 'Copy URL';
  copyBtn.textContent = '⎘';
  copyBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try { await navigator.clipboard.writeText(t.url || ''); toast('URL copied'); }
    catch { toast('Copy failed'); }
  });
  right.append(copyBtn);

  li.append(cb, fav, titleWrap, right);
  return li;
}

function toggleWindowSelection(w, checked, block) {
  if (checked) {
    state.selection.set(w.windowId, { all: true, tabKeys: new Set() });
    $$('input[type="checkbox"]', block).forEach(cb => {
      if (cb.dataset.tabkey) cb.checked = true;
    });
  } else {
    state.selection.delete(w.windowId);
    $$('input[type="checkbox"]', block).forEach(cb => {
      if (cb.dataset.tabkey) cb.checked = false;
    });
  }
  updateRestoreSelectedDisabled();
}

function toggleTabSelection(w, t, checked) {
  let entry = state.selection.get(w.windowId);
  if (!entry) {
    entry = { all: false, tabKeys: new Set() };
    state.selection.set(w.windowId, entry);
  }
  const key = `${w.windowId}:${t.index}`;
  if (checked) entry.tabKeys.add(key);
  else entry.tabKeys.delete(key);
  entry.all = false;
  if (entry.tabKeys.size === 0) state.selection.delete(w.windowId);
  updateRestoreSelectedDisabled();
}

function updateRestoreSelectedDisabled() {
  const btn = $('#btn-restore-selected');
  if (!btn) return;
  btn.disabled = state.selection.size === 0;
  btn.style.opacity = btn.disabled ? '0.5' : '1';
}

function serializeSelection() {
  if (state.selection.size === 0) return null;
  const windowIds = [];
  const tabKeys = [];
  for (const [wid, entry] of state.selection) {
    if (entry.all) windowIds.push(wid);
    else for (const k of entry.tabKeys) tabKeys.push(k);
  }
  return { windowIds, tabKeys };
}

// ---------- Operations ----------

async function doRestore(mode) {
  if (!state.current) return;
  const selection = mode === 'selected' ? serializeSelection() : null;
  if (mode === 'selected' && (!selection || (selection.windowIds.length === 0 && selection.tabKeys.length === 0))) {
    toast('No tabs selected.');
    return;
  }
  // Restore is ALWAYS user-triggered AND always confirmed unless the user
  // explicitly turned the confirmation off in settings.
  if (state.settings?.confirmRestore !== false) {
    const willOpen = mode === 'selected'
      ? (selection.tabKeys.length + selection.windowIds.reduce((s, wid) => {
          const w = state.current.windows.find(x => x.windowId === wid);
          return s + (w ? w.tabs.length : 0);
        }, 0))
      : state.current.stats.tabCount;
    const ok = await confirmModal(
      'Restore?',
      `This will open ${willOpen} tab${willOpen === 1 ? '' : 's'} from "${state.current.name}". Tab Vault never opens tabs on its own — this is the only place it does. Continue?`,
      'Restore now'
    );
    if (!ok) return;
  }
  try {
    const r = await send({ type: 'restore', id: state.current.id, options: { mode, selection } });
    toast(`Opened ${r.restored} tabs`);
  } catch (e) {
    toast(`Restore failed: ${e.message}`);
  }
}

async function renameCurrent() {
  if (!state.current) return;
  const name = prompt('New name:', state.current.name);
  if (!name) return;
  await send({ type: 'rename', id: state.current.id, name });
  state.current.name = name;
  await loadTimeline();
  renderDetail();
  toast('Renamed');
}

async function togglePin() {
  if (!state.current) return;
  const pinned = !state.current.pinned;
  await send({ type: 'pin', id: state.current.id, pinned });
  state.current.pinned = pinned;
  await loadTimeline();
  renderDetail();
  toast(pinned ? 'Pinned' : 'Unpinned');
}

async function deleteCurrent() {
  if (!state.current) return;
  const ok = await confirmModal(
    'Delete snapshot',
    `Delete "${state.current.name}"? This cannot be undone.`,
    'Delete',
    true
  );
  if (!ok) return;
  await send({ type: 'delete', id: state.current.id });
  state.current = null;
  state.selectedId = null;
  state.currentDiff = null;
  await loadTimeline();
  renderDetail();
  toast('Deleted');
}

async function exportCurrent() {
  if (!state.current) return;
  const { data, filename } = await send({ type: 'export-one', id: state.current.id });
  downloadJSON(data, filename);
}

async function exportAll() {
  const { data, filename } = await send({ type: 'export-all' });
  if (!data.snapshots || data.snapshots.length === 0) {
    toast('No snapshots to export.');
    return;
  }
  downloadJSON(data, filename);
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFile(file) {
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); } catch { return toast('Invalid JSON file.'); }

  // Strict validation first via the background — gives a precise error if any.
  let info;
  try { info = await send({ type: 'inspect-import', payload }); }
  catch (e) { return toast(`Import failed: ${e.message}`); }
  if (!info.ok) return toast(`Invalid file: ${info.validationError}`);

  // Cross-profile warning: if the file came from a different profile, ask.
  if (info.fromProfileId && !info.isSameProfile) {
    const fromLabel = info.fromProfileLabel || info.fromProfileId.slice(0, 8);
    const intoLabel = info.currentProfileLabel || (state.profile?.shortId ?? 'this profile');
    const ok = await confirmModal(
      'Backup is from a different profile',
      `This file was exported by profile "${fromLabel}". You are currently in "${intoLabel}". Import it into the current profile?`,
      'Import here'
    );
    if (!ok) return;
  }

  let merge = true;
  if (info.kind === 'export') {
    const choice = await showChoiceModal('Import', [
      { label: 'Merge with existing', value: 'merge', desc: 'Add imported snapshots alongside your current history.' },
      { label: 'Replace everything', value: 'replace', desc: 'Delete all existing snapshots, then import. Destructive!' }
    ]);
    if (!choice) return;
    merge = choice === 'merge';
    if (!merge) {
      const ok = await confirmModal('Replace all?', 'This will delete every existing snapshot before importing. Continue?', 'Replace all', true);
      if (!ok) return;
    }
  }
  try {
    const r = await send({ type: 'import', payload, merge });
    toast(`Imported ${r.imported} snapshot${r.imported === 1 ? '' : 's'}`);
    await loadTimeline();
  } catch (e) {
    toast(`Import failed: ${e.message}`);
  }
}

async function saveNow() {
  const btn = $('#save-now');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.textContent = 'Saving…';
  try {
    const { snapshot } = await send({ type: 'capture', snapshotType: 'manual' });
    toast(`Saved ${snapshot.stats.tabCount} tabs`);
    await loadTimeline();
    await selectSnapshot(snapshot.id);
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function clearAll() {
  const ok = await confirmModal('Delete all snapshots?', 'This will permanently delete every saved snapshot. This cannot be undone.', 'Delete all', true);
  if (!ok) return;
  await send({ type: 'clear-all' });
  state.current = null;
  state.selectedId = null;
  state.currentDiff = null;
  await loadTimeline();
  renderDetail();
  toast('All snapshots deleted.');
}

// ---------- Confirm modal ----------

function confirmModal(title, body, confirmText = 'OK', destructive = false) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = destructive ? 'danger' : 'primary';
    ok.textContent = confirmText;
    actions.append(cancel, ok);
    box.append(h, p, actions);
    back.append(box);
    root.append(back);
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    const done = (v) => {
      document.removeEventListener('keydown', keyHandler);
      root.innerHTML = '';
      resolve(v);
    };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    back.addEventListener('click', (e) => { if (e.target === back) done(false); });
    document.addEventListener('keydown', keyHandler);
    setTimeout(() => ok.focus(), 0);
  });
}

// ---------- Live storage updates ----------

let _refreshDebounce = null;
function setupStorageListener() {
  if (!chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Only refresh on changes that affect the timeline.
    const watched = ['snap:index', 'tv:settings'];
    if (!watched.some(k => k in changes)) return;
    clearTimeout(_refreshDebounce);
    _refreshDebounce = setTimeout(async () => {
      try { await loadTimeline(); } catch {}
    }, 250);
  });
}

// ---------- Wiring ----------

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadTimeline();

  $('#save-now').addEventListener('click', saveNow);
  $('#export-all').addEventListener('click', exportAll);
  $('#import-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importFile(f);
    e.target.value = '';
  });
  $('#settings-toggle').addEventListener('click', () => {
    const p = $('#settings-panel');
    p.hidden = !p.hidden;
  });

  $('#auto-minutes').addEventListener('change', e => patchSettings({ autoSnapshotMinutes: parseInt(e.target.value, 10) || 0 }));
  $('#session-gap').addEventListener('change', async e => { await patchSettings({ sessionGapMinutes: parseInt(e.target.value, 10) || 60 }); await loadTimeline(); });
  $('#max-snapshots').addEventListener('change', async e => { await patchSettings({ maxSnapshots: parseInt(e.target.value, 10) || 0 }); await loadTimeline(); });
  $('#theme').addEventListener('change', e => patchSettings({ theme: e.target.value }));
  $('#live-enabled').addEventListener('change', e => patchSettings({ liveSnapshotEnabled: e.target.checked }));
  $('#confirm-restore').addEventListener('change', e => patchSettings({ confirmRestore: e.target.checked }));
  const profileInput = $('#profile-label');
  if (profileInput) {
    let labelDebounce;
    profileInput.addEventListener('input', (e) => {
      clearTimeout(labelDebounce);
      const v = e.target.value;
      labelDebounce = setTimeout(async () => {
        await patchSettings({ profileLabel: v });
        await applyProfileChip();
      }, 300);
    });
  }
  $('#clear-all').addEventListener('click', clearAll);

  $('#search').addEventListener('input', e => { state.query = e.target.value; renderTimeline(); });

  // Live refresh: when the background writes a new snapshot (auto-snapshot,
  // crash recovery, etc.) the dashboard updates without a manual refresh.
  setupStorageListener();

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
    if (mod && e.key === '/' )              { e.preventDefault(); $('#search').focus(); }
  });
});
