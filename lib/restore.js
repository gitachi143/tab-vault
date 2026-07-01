// Window-level restorer.
//
// This module is the ONLY place in the codebase that calls
// chrome.windows.create. It is invoked exclusively by the
// `restore-from-file` message handler in background.js, which itself is
// only sent by an explicit click in the Import & Restore modal in the
// dashboard.
//
// Tab Vault's capture path (alarms, lifecycle events, tab/window events,
// scheduled backup, every other message) does NOT touch this module.
// The static check in tests/test_no_autoopen.mjs whitelists ONLY this
// file for chrome.windows.create usage.

import { normalizeUrlForRestore } from './utils.js';

const VALID_STATES = new Set(['normal', 'maximized', 'minimized', 'fullscreen']);

/**
 * Open one browser window per provided window object. Preserves saved tab
 * order (by index) and window state. Skips empty windows.
 *
 * @param {Array} windows  Array of saved window objects.
 *   Each window: { tabs: [{url, index, ...}], state, top, left, width, height }
 * @returns {Promise<{openedWindows: number, openedTabs: number, skippedUrls: string[]}>}
 */
export async function restoreWindows(windows) {
  if (!Array.isArray(windows)) throw new Error('restoreWindows: windows must be an array');
  let openedWindows = 0;
  let openedTabs = 0;
  const skippedUrls = [];

  for (const w of windows) {
    const tabs = (w?.tabs || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const urls = [];
    for (const t of tabs) {
      const original = t?.url || '';
      const normalized = normalizeUrlForRestore(original);
      // Normalization may rewrite an unrestorable internal URL to about:blank;
      // those are kept (so the tab count matches) but recorded for the UI.
      urls.push(normalized);
      if (normalized !== original) skippedUrls.push(original);
    }
    if (urls.length === 0) continue;

    const createInfo = { url: urls, focused: false };
    const state = VALID_STATES.has(w?.state) ? w.state : 'normal';
    createInfo.state = state;
    if (state === 'normal') {
      if (Number.isFinite(w?.top))    createInfo.top = w.top;
      if (Number.isFinite(w?.left))   createInfo.left = w.left;
      if (Number.isFinite(w?.width))  createInfo.width = w.width;
      if (Number.isFinite(w?.height)) createInfo.height = w.height;
    }
    try {
      await chrome.windows.create(createInfo);
      openedWindows += 1;
      openedTabs += urls.length;
    } catch (e) {
      console.warn('Tab Vault: failed to open window', e);
    }
  }

  return { openedWindows, openedTabs, skippedUrls };
}
