// Hourly backup builder + sender. Two delivery channels (independent):
//   1. chrome.downloads.download   — writes JSON to the user's Downloads folder
//   2. HTTPS POST to a webhook URL — used by the Apps Script email-forwarder
//      template in integrations/apps-script-mailer/
//
// This module never opens or modifies tabs. It only reads from storage and
// writes either to disk (downloads) or to a user-configured URL (fetch).

import { getAllSnapshots, getSettings, getProfileId, shortProfileId } from './storage.js';
import { formatDateFile } from './utils.js';

export const BACKUP_SCHEMA = 1;

export async function buildBackupPayload({ reason = 'hourly' } = {}) {
  const settings = await getSettings();
  const profileId = await getProfileId();
  const snapshots = await getAllSnapshots();
  return {
    kind: 'tab-vault-export',
    version: BACKUP_SCHEMA,
    reason,
    exportedAt: Date.now(),
    profileId,
    profileLabel: settings.profileLabel || '',
    snapshotCount: snapshots.length,
    settings,
    snapshots
  };
}

export function backupFilename(label, profileId, ts) {
  const safeLabel = (label || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
  const tag = safeLabel || shortProfileId(profileId);
  return `tab-vault-${tag}-backup-${formatDateFile(ts || Date.now())}.json`;
}

// --- downloads -------------------------------------------------------------

export async function downloadBackup(payload) {
  if (!chrome.downloads?.download) throw new Error('chrome.downloads not available');
  const filename = backupFilename(payload.profileLabel, payload.profileId, payload.exportedAt);
  const json = JSON.stringify(payload, null, 2);
  // Use a data URL so we don't need to allocate a Blob URL on a service worker.
  // (chrome.downloads supports data: URLs.)
  const dataUrl = 'data:application/json;base64,' + base64Encode(json);
  const id = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: `tab-vault/${filename}`,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(downloadId);
      }
    );
  });
  return { ok: true, downloadId: id, filename };
}

function base64Encode(s) {
  // btoa requires latin1; use TextEncoder + chunked conversion for UTF-8 safety.
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// --- webhook ---------------------------------------------------------------

export async function postToWebhook(url, payload, { secret = '', timeoutMs = 30_000 } = {}) {
  if (!url) throw new Error('webhook URL not configured');
  if (!/^https:\/\//i.test(url)) throw new Error('webhook URL must use HTTPS');
  const body = JSON.stringify({
    schema: BACKUP_SCHEMA,
    secret,
    filename: backupFilename(payload.profileLabel, payload.profileId, payload.exportedAt),
    profileId: payload.profileId,
    profileLabel: payload.profileLabel,
    snapshotCount: payload.snapshotCount,
    exportedAt: payload.exportedAt,
    reason: payload.reason,
    data: payload
  });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store'
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, body: text.slice(0, 1000) };
  } finally {
    clearTimeout(t);
  }
}
