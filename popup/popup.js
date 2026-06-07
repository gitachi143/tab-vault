import { relativeTime, bytesHuman, detectBrowserName } from '../lib/utils.js';

const $ = (s, r = document) => r.querySelector(s);

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

function toast(text, ms = 1800) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

async function applyTheme() {
  const { settings } = await send({ type: 'get-settings' });
  if (settings.theme === 'light') document.documentElement.dataset.theme = 'light';
  else if (settings.theme === 'dark') document.documentElement.dataset.theme = 'dark';
}

async function reportBrowser() {
  try {
    const name = await detectBrowserName();
    if (name) await send({ type: 'set-browser-info', name });
  } catch { /* ignore */ }
}

async function applyProfileChip() {
  try {
    const p = await send({ type: 'get-profile' });
    const chip = $('#profile-chip');
    const browser = p.browserName || 'Chrome';
    if (p.profileLabel) {
      chip.textContent = `${browser} · ${p.profileLabel}`;
      chip.classList.remove('unlabeled');
      chip.title = `${browser} — profile "${p.profileLabel}" (id ${p.shortId}). Each browser profile keeps its own history.`;
    } else {
      chip.textContent = `${browser} · ${p.shortId}`;
      chip.classList.add('unlabeled');
      chip.title = `${browser} — unnamed profile (id ${p.shortId}). Set a label in the dashboard settings.`;
    }
  } catch {
    $('#profile-chip').textContent = '?';
  }
}

async function loadStats() {
  try {
    const s = await send({ type: 'get-current-stats' });
    $('[data-stat="tabs"]').textContent = s.tabs;
    $('[data-stat="windows"]').textContent = s.windows;
    $('[data-stat="groups"]').textContent = s.groups;
    $('[data-stat="pinned"]').textContent = s.pinned;
  } catch {}
}

async function loadRecent() {
  const ul = $('#recent-list');
  ul.innerHTML = '';
  const { index, usage } = await send({ type: 'list-index' });
  $('#usage').textContent = `Storage: ${bytesHuman(usage)}`;

  if (!index || index.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No snapshots yet. Save your first one above.';
    ul.appendChild(li);
    $('#last-saved').textContent = 'No snapshots yet';
    return;
  }
  $('#last-saved').textContent = `Last: ${relativeTime(index[0].timestamp)}`;

  // Show only recent 5 — clicking each opens the history page with that snapshot.
  for (const e of index.slice(0, 5)) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = e.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${e.stats?.tabCount ?? 0} tabs · ${e.stats?.windowCount ?? 0} windows · ${relativeTime(e.timestamp)}`;
    meta.append(name, sub);
    const badge = document.createElement('span');
    badge.className = `badge ${e.type || 'manual'}`;
    badge.textContent = e.type || 'manual';
    li.append(meta, badge);
    // Click opens dashboard (NEVER opens tabs).
    li.style.cursor = 'pointer';
    li.title = 'Open in history';
    li.addEventListener('click', () => chrome.runtime.openOptionsPage());
    ul.appendChild(li);
  }
}

async function saveNow() {
  const btn = $('#save-now');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { snapshot } = await send({ type: 'capture', snapshotType: 'manual' });
    toast(`Saved ${snapshot.stats.tabCount} tabs`);
    await loadRecent();
  } catch (e) {
    toast(`Save failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await applyTheme();
  await reportBrowser();
  applyProfileChip();
  $('#save-now').addEventListener('click', saveNow);
  $('#refresh').addEventListener('click', () => { loadStats(); loadRecent(); });
  $('#see-all').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#open-dashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());
  loadStats();
  loadRecent();
});
