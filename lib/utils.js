// Shared utilities for Tab Vault.

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // Fallback (RFC 4122 v4-ish) for very old runtimes.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0'));
  return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
}

export function nowMs() {
  return Date.now();
}

export function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateFile(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function relativeTime(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  if (dy < 7) return `${dy}d ago`;
  return formatDate(ts);
}

export function bytesHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// URLs the browser refuses (or silently fails) to open via chrome.windows.create.
// We route them to about:blank so the tab count is preserved.
const UNRESTORABLE_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'brave://',
  'view-source:',
  'javascript:'
];

export function normalizeUrlForRestore(url) {
  if (!url || typeof url !== 'string') return 'about:blank';
  for (const p of UNRESTORABLE_PREFIXES) {
    if (url.startsWith(p)) return 'about:blank';
  }
  return url;
}

export function safeHostname(url) {
  try { return new URL(url).hostname || url; } catch { return url || ''; }
}

// Detect the host browser. Reliable detection requires being called from a
// page context (popup or options) where `navigator.brave?.isBrave()` is
// exposed. Returns one of: 'Chrome' | 'Brave' | 'Edge' | 'Opera' | 'Chromium'.
export async function detectBrowserName() {
  try {
    if (typeof navigator !== 'undefined' && navigator.brave?.isBrave) {
      const isBrave = await navigator.brave.isBrave();
      if (isBrave) return 'Brave';
    }
  } catch { /* fall through */ }
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/\bEdg\//.test(ua))     return 'Edge';
  if (/\bOPR\//.test(ua) || /Opera\//.test(ua)) return 'Opera';
  if (/\bChrome\//.test(ua))  return 'Chrome';
  if (/Chromium/.test(ua))    return 'Chromium';
  return 'Chrome';
}

// Lightweight debounce — used by background to coalesce live snapshots.
export function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
