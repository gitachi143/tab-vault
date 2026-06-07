# Tab Vault

A polished Chrome / Brave extension (Manifest V3) that **logs every tab you have open over time**, bundles snapshots into sessions like Google Docs version history, and lets you browse, search, and diff the history.

> **Tab Vault is a backup, not a replacement for Chrome's session restore.** Chrome's "Continue where you left off" is your primary safety net. Tab Vault is a passive observer that records what's open so you can browse the history and, if you ever need it, restore from any past point. It never closes, opens, modifies, or duplicates a tab on its own.

> **Tab Vault never opens tabs on its own.** The only code path that opens a tab or window runs when you click a **Restore** button. Lifecycle events, alarms, tab events, hourly backups, and crash detection only read and write storage.

> **Multi-profile aware.** Each Chrome / Brave profile keeps its own independent history (enforced by the browser's per-profile storage). Set a label like "Work" or "Personal" in settings and it shows up in the popup header and bakes into export filenames. Importing a backup from another profile triggers a confirmation.

> **Scheduled off-device backups** (opt-in, default once-a-day): the extension can also bundle your snapshots into a JSON file on a fixed interval (30 min … weekly) and either save it to your `Downloads/tab-vault/` folder, POST it to an HTTPS endpoint you control, or both. Use the included Google Apps Script template in `integrations/apps-script-mailer/` to receive these as daily emails from your own Gmail to your own Gmail — no third-party services.

## What it does

- **Periodic snapshots** of every tab across every Chrome / Brave window, including tab groups (title + color + collapsed state) and pinned tabs. Default cadence is every 10 minutes; configurable.
- **Manual snapshots** with one click (or `Ctrl/Cmd + Shift + S`).
- **Sessions** — snapshots within an hour of each other are bundled into a session, shown as a timeline grouped by day (Today, Yesterday, weekday, then dated).
- **Diff per snapshot** — each snapshot shows what was opened and closed vs. the previous snapshot in the same session (Google-Docs-style change view).
- **Search** across snapshot names and types.
- **Pin** snapshots so retention pruning never touches them.
- **JSON export / import** — back up and restore your *history* to a file. The export contains every snapshot.
- **Restore** is explicit, separate, and confirmed:
  - **Popup:** one small footer link, "Restore last stored session" — uses the most recent snapshot, opens it in new windows, with a confirmation.
  - **Dashboard:** every snapshot has its own restore controls (new windows / single window / append-to-current / selected-only).
- **Light / Dark / Auto** theme.
- **Keyboard shortcuts**:
  - `Ctrl/Cmd + Shift + S` — save snapshot
  - `Ctrl/Cmd + Shift + E` — open the history dashboard
  - Inside the dashboard: `Ctrl/Cmd + S` save · `Ctrl/Cmd + /` focus search.

## Install from GitHub (Chrome or Brave)

You don't need Node or npm — Tab Vault has zero runtime dependencies. The only thing you do is download the folder and load it as an unpacked extension.

### Step 1 — get the code onto your laptop

Pick whichever you prefer:

**Option A: `git clone` (recommended — easy to update later)**
```bash
cd ~                                     # or wherever you want it
git clone https://github.com/gitachi143/tab-vault.git
```
You now have `~/tab-vault/`.

**Option B: download a ZIP**
1. Go to https://github.com/gitachi143/tab-vault
2. Click the green **Code** button → **Download ZIP**
3. Unzip it somewhere stable (Documents, Desktop, anywhere you won't move it from).
   - If you move or delete the folder later, Chrome/Brave will disable the extension because it can no longer find the files. Pick a permanent spot.

### Step 2 — load it as an unpacked extension

| Browser | Address bar URL |
|---|---|
| Chrome | `chrome://extensions` |
| Brave | `brave://extensions` |
| Edge | `edge://extensions` |

1. Open that URL.
2. Top-right corner: toggle **Developer mode** ON.
3. Top-left: click **Load unpacked**.
4. In the file picker, select the `tab-vault` folder (the one that directly contains `manifest.json`).
5. The "Tab Vault" card appears. Make sure its toggle is **on**.
6. Click the **puzzle-piece** icon in the browser toolbar → find Tab Vault → click the **pin** icon so it stays visible.

### Step 3 — verify it's working

- Click the Tab Vault icon. You should see stats (your current tabs/windows/groups), a **Save snapshot** button, and a profile chip showing a short id (e.g. `a3b8c1d2`).
- Click **Save snapshot** — a toast should say *"Saved N tabs"*.
- Click **View history →** — the dashboard opens in a new tab with your snapshot on the timeline.

If anything's red on the extension card, click **Errors** and paste the message — it's almost always a manifest path issue from moving the folder.

### Updating later

```bash
cd ~/tab-vault          # or wherever you cloned it
git pull
```
Then back in `chrome://extensions`, click the **refresh icon** on the Tab Vault card. Your existing snapshots are kept.

### Use across multiple Chrome profiles

Each Chrome / Brave profile runs its own independent copy of the extension's storage. To install for a second profile:

1. Switch to the other profile (top-right avatar menu).
2. Repeat Step 2 above — open `chrome://extensions` *in that profile*, Developer mode on, Load unpacked, select the same folder.
3. Open the Tab Vault dashboard in each profile and set a **Profile label** ("Work", "Personal", etc.) so you can tell them apart at a glance.

Each profile's snapshots are stored separately and never bleed across. Exports are tagged with the profile id and label so backups don't get confused.

---

## How everything works

```
┌─────────────────────────────────────────────────────────────────┐
│                         Tab Vault                                │
│                                                                  │
│  Periodic + manual snapshots ──► chrome.storage.local            │
│       (every 10 min default)            │                        │
│                                         │                        │
│       Tab events ──► live snapshot ◄────┘                        │
│       (debounced 4s)    (read-only, never auto-restored)         │
│                                                                  │
│  YOU click Restore ◄── popup OR dashboard ──► open new windows   │
│                       (this is the ONLY way tabs are opened)     │
└─────────────────────────────────────────────────────────────────┘
```

### Two surfaces

- **Popup** (toolbar icon) — quick view: current stats, save button, last few snapshots, "View history" link, and a small footer link to restore the most recent snapshot.
- **Dashboard** (the options page, opens in its own tab) — full timeline of snapshots grouped by day → session → snapshot, with diff between consecutive snapshots, search, settings, import/export, and explicit restore controls.

### What a snapshot contains

Every snapshot captures, for every non-incognito Chrome / Brave window:
- All tabs: URL, title, favicon URL, pinned state, active state, index, group membership.
- All tab groups: title, color, collapsed state.
- Window state: maximized / normal / minimized, position, size, focused.

### When snapshots are taken

| Trigger | Type label | Frequency |
|---|---|---|
| You click **Save snapshot** | `manual` | on demand |
| Auto-snapshot alarm | `auto` | every 10 min (configurable) |
| Browser start | `startup` | once on browser launch |
| Service-worker live heartbeat | `live` (read-only) | every 1 min, updated also on tab events |
| Detected crash on next launch | `crash` | once, when previous-session live snapshot survives |
| Before any restore | `pre-restore` | one safety snapshot, so you can always undo |

### Storage layout

Everything is in `chrome.storage.local` (per-profile, isolated by Chrome itself):
- `snap:index` — a lightweight array of `{id, name, type, timestamp, stats, pinned}` for fast UI rendering.
- `snap:<uuid>` — each snapshot's full payload under its own key, so the dashboard loads only what it shows.
- `tv:settings` — your settings (auto interval, profile label, theme, etc.).
- `tv:profileId` — your stable per-profile UUID.
- `tv:live` + `tv:live_meta` — the rolling crash-recovery snapshot.
- `tv:session` — the current browser-session id.

### What is *guaranteed* never to happen

- **Tab Vault never opens a tab or window unless you click Restore.** Tested by 13 invariant tests that fire every other code path.
- **Profiles never see each other's history.** Chrome's per-profile storage isolates them; we add a profile UUID on top so cross-profile imports are flagged.
- **No network traffic.** Zero. No analytics, no sync server, no telemetry.
- **Incognito windows are never recorded.**

---

## How to use it

### Save a snapshot

- **One-time:** click the Tab Vault icon → **Save snapshot**.
- **Keyboard:** `Ctrl/Cmd + Shift + S` from anywhere.
- **Automatic:** turned on by default — every 10 minutes. Change in dashboard settings (⚙).

### Browse your history

- Click the Tab Vault icon → **View history →** (or `Ctrl/Cmd + Shift + E`).
- The dashboard opens. Left column is a timeline:
  - **Day headers**: Today, Yesterday, weekday names, then dated.
  - **Sessions**: contiguous snapshots within 60 min of each other (configurable). Each session shows its time range, snapshot count, and peak tab count.
  - **Snapshots**: name, timestamp, tab/window/group counts, and a diff badge like `+3` or `−2` showing change vs. the previous snapshot in that session.
- Click any snapshot. The right pane shows:
  - **Changes since previous snapshot** — two columns ("Opened" / "Closed") listing the URLs that came and went.
  - **Windows and tab groups** — exactly as they were at that moment, with favicons, pinned markers, group colors.

### Restore (the only thing that opens tabs)

Three places, all explicit:

1. **Popup → "Restore last stored session"** (footer). Confirms first, then opens the most recent snapshot in new windows.
2. **Dashboard → click a snapshot → "Restore this snapshot…"**. Confirms first, then opens that snapshot in new windows. Also auto-saves a `pre-restore` snapshot so you can undo by restoring that one.
3. **Dashboard → "More restore modes ▾"** offers three layouts:
   - **New windows** — one new window per saved window (recreates layout exactly).
   - **Single window** — combine everything into one new window.
   - **Append to current window** — add the saved tabs alongside whatever you have open.
4. **Dashboard → check the box next to specific windows or tabs → "Restore selected…"** — opens only what you picked.

Every restore is confirmed by default. Toggle off in settings if you don't want the prompt.

### Pin snapshots you care about

In the dashboard detail pane, click **Pin**. Pinned snapshots survive retention pruning forever (the 200-snapshot cap only applies to unpinned ones).

### Search

Top of dashboard → search box, or `Ctrl/Cmd + /` to focus it. Searches snapshot names and types right now.

### Back up off-device

- Dashboard header → **Export** — downloads `tab-vault-<label>-YYYYMMDD-HHMMSS.json` containing every snapshot.
- Dashboard header → **Import** — accepts that file back. Choose **Merge** to add alongside your current history, or **Replace everything** to wipe and reload.
- A backup from another profile triggers a confirmation before importing.

### Settings (⚙ in the dashboard header)

| Setting | What it does |
|---|---|
| **Auto-snapshot every** | How often a background snapshot is taken. Disable for manual-only. |
| **New session after gap of** | Pause longer than this and the next snapshot starts a new session bundle. |
| **Keep at most** | Retention cap (pinned always kept regardless). |
| **Theme** | Light / Dark / Auto (follow system). |
| **Profile label** | Name this Chrome profile so the popup chip and export filename are recognisable. |
| **Crash-recovery live snapshot** | Keep updating the read-only crash snapshot. Recommended on. |
| **Always confirm before restore** | Show a confirmation modal before opening tabs. Strongly recommended on. |
| **Run scheduled backup** | Bundle all snapshots into JSON on a fixed interval (see below). Off by default. |
| **Save to Downloads/tab-vault/** | Backup file lands in your local Downloads folder. |
| **Backup interval** | 30 min, hourly, 6h, 12h, daily (default), 2-day, weekly. |
| **Webhook URL (HTTPS)** | Backup is also POSTed to this URL (e.g. an Apps Script email forwarder). |
| **Optional shared secret** | Sent in the POST body; your webhook can verify it before processing. |
| **Run backup now** | Triggers a backup immediately to verify both channels work. |
| **Delete all snapshots…** | Nuclear option. Tap if you want a clean slate. |

### Get daily emails of your backup (3-minute setup)

You don't need a server or a paid service — your own Google account is enough.

1. Open [`integrations/apps-script-mailer/README.md`](./integrations/apps-script-mailer/README.md) and follow the 5-step setup. It deploys a Google Apps Script web app that runs as you, receives the backup POST, and emails the JSON to your own Gmail address.
2. Paste the resulting Web app URL into Tab Vault → **⚙** → **Webhook URL**.
3. Tick **Run scheduled backup**.
4. Click **Run backup now** to test — you should receive an email within ~20 seconds with the full backup attached. After that, you'll get one email per day by default (change the interval in the same settings panel if you want hourly instead).

Why this approach: browser extensions can't send email directly (there is no email API). They can only POST to HTTPS endpoints. The Apps Script template is the simplest endpoint that turns a POST into an email — it runs on Google's infrastructure under your own account, signs in as you, sends from your own Gmail to your own Gmail, costs nothing, and requires no third-party services or API keys.

### Keyboard shortcuts

- **Global** (work anywhere in the browser):
  - `Ctrl/Cmd + Shift + S` — save snapshot
  - `Ctrl/Cmd + Shift + E` — open dashboard
- **Inside the dashboard:**
  - `Ctrl/Cmd + S` — save snapshot
  - `Ctrl/Cmd + /` — focus search

Change shortcuts in `chrome://extensions/shortcuts`.

### Uninstalling / removing

`chrome://extensions` → Tab Vault → **Remove**. This wipes the extension's `chrome.storage.local`. If you want to keep your history, **export to JSON first**.

To temporarily disable without losing data, use the toggle on the extension card.

---

## Troubleshooting

- **"This extension may have been corrupted" / red Errors button** — usually means the folder was moved after loading. Click Remove, re-run **Load unpacked**, pick the new location.
- **Snapshots not auto-saving** — open the dashboard → ⚙ → confirm **Auto-snapshot every** is set to something > 0. Chrome's alarms minimum is 1 minute.
- **Tab favicons missing on restore** — favicons are stored as URLs; if the server is unreachable when the tab opens, the browser falls back to default.
- **`chrome://newtab` opened instead of the saved URL** — special pages like `chrome://newtab`, `chrome-search://`, and `edge://newtab` cannot be programmatically opened by extensions. We route them to the new-tab page.
- **Snapshot disappeared after pruning** — bump **Keep at most** in settings, or pin (★) the ones you want forever.
- **Two profiles showing the same data** — they shouldn't, ever. Each Chrome profile has separate storage. If you see this, the most likely cause is that you're actually in the same profile in two windows. Check the profile chip in the popup header.

## Mental model

```
┌─ Today ──────────────────────────────────────────────
│  ● Session 14:30 – 16:05      (8 snapshots · peak 47 tabs)
│  ├─ 16:05  Snapshot           47 tabs  +3
│  ├─ 15:55  Auto-snapshot      44 tabs  −2
│  ├─ 15:45  Auto-snapshot      46 tabs  +1
│  └─ 14:30  Auto-snapshot      45 tabs   ·
│
│  ● Session 09:00 – 11:00      (12 snapshots · peak 51 tabs)
│  └─ …
│
┌─ Yesterday ──────────────────────────────────────────
│  ● Session 20:10 – 22:30      …
```

Click any snapshot to see:
- The exact tabs and windows that were open
- What changed since the previous snapshot in the session ("Opened" / "Closed")
- A **Restore this snapshot** button (with confirmation)

## Where data lives

- Snapshots are stored in `chrome.storage.local` under their own keys (`snap:<uuid>`) with a fast index at `snap:index`.
- A live snapshot at `tv:live` is rewritten on tab events plus a 1-minute heartbeat. **It is read-only from the user's perspective** — Tab Vault never auto-opens those tabs. On the next browser start, if a previous-session live snapshot is found, it's promoted into the history as a `crash` snapshot you can manually restore.
- `unlimitedStorage` is requested so dense histories don't run into the default 5 MB cap.

## Settings (defaults are tuned for dense logging)

| Setting | Default |
|---|---|
| Auto-snapshot interval | 10 minutes |
| New-session gap | 60 minutes |
| Max retained snapshots (pinned always kept) | 200 |
| Crash-recovery live snapshot | Enabled (read-only) |
| Confirm before restore | Enabled |
| Profile label (this Chrome profile) | empty |
| Theme | Auto (system) |

## Reliability guarantees

| Risk | Mitigation |
|---|---|
| Tab Vault interfering with Chrome's session restore | Tab Vault never calls `chrome.tabs.create/update/remove/move` or `chrome.windows.create/remove` outside the explicit user-clicked restore path. Tested by 32 invariant tests covering install, startup, alarms, tab/window/group events, hourly backup firings, and keyboard shortcuts. |
| Two snapshot writes racing (alarm + manual click) | Promise-chain mutex serializes every index-touching operation in `lib/storage.js` |
| Storage quota exceeded | `safeSet()` catches `QUOTA*` errors, prunes oldest unpinned snapshot, retries once; pinned never touched |
| Index points at a deleted key | `repairIndex()` runs on every service worker startup |
| Snapshot rendered then deleted before view | Dashboard shows "no longer available" state instead of crashing |
| Restore opens the wrong tabs | A `pre-restore` snapshot is auto-saved before every restore — undo is one click |
| Malformed import file | Strict shape validation (`lib/validate.js`) rejects the entire file before any storage write |
| Cross-profile import confusion | `inspect-import` flags the profile mismatch; confirmation prompt before commit |
| Service worker killed mid-task | Background re-inits via `_ready` gate on first message after restart; no half-state visible |
| Auto-snapshots while dashboard is open | `chrome.storage.onChanged` listener refreshes timeline live |

## Snapshot file format (v1)

```jsonc
{
  "kind": "tab-vault-export",          // or "tab-vault-snapshot" for a single snapshot
  "version": 1,
  "exportedAt": 1716393600000,
  "snapshots": [
    {
      "id": "uuid",
      "schema": 1,
      "name": "Snapshot • 2026-05-24 14:00",
      "type": "manual|auto|startup|crash|pre-restore|import",
      "timestamp": 1716393600000,
      "pinned": false,
      "windows": [
        {
          "windowId": 1,
          "focused": true,
          "state": "normal",
          "top": 0, "left": 0, "width": 1440, "height": 900,
          "tabs": [
            {
              "id": 1, "url": "...", "title": "...", "favIconUrl": "...",
              "pinned": false, "active": true, "index": 0, "groupId": -1
            }
          ],
          "groups": [
            { "id": 1, "title": "Work", "color": "blue", "collapsed": false }
          ]
        }
      ],
      "stats": { "tabCount": 42, "windowCount": 3, "groupCount": 2, "pinnedCount": 3 }
    }
  ]
}
```

## Layout

```
chromeextension/
├── manifest.json
├── background.js              # service worker (MV3)
├── lib/
│   ├── utils.js
│   ├── storage.js             # chrome.storage.local + index
│   ├── snapshot.js            # capture
│   ├── restore.js             # restore (only invoked by explicit user click)
│   └── sessions.js            # session bundling + diffs (pure)
├── popup/                     # toolbar popup
├── options/                   # full dashboard
├── icons/                     # 16/32/48/128 PNG (generated)
├── scripts/make_icons.py      # regenerate icons (stdlib only)
└── tests/                     # 173 tests covering libs, background, no-auto-open
```

## Tests (254 total)

```
node tests/test.mjs               # 89 lib + integration tests
node tests/test_background.mjs    # 39 background message-handler tests
node tests/test_sessions.mjs      # 32 session bundling + diff tests
node tests/test_no_autoopen.mjs   # 32 invariant tests: nothing auto-opens/closes tabs
node tests/test_storage_safety.mjs # 39 mutex / quota / repair / validation tests
node tests/test_profile.mjs       # 23 multi-profile + import validation tests
```

The **no-auto-open** suite verifies that across every non-restore code path (install, startup, alarms, tab events, group events, every non-restore message, keyboard shortcuts), `chrome.tabs.create` and `chrome.windows.create` are called **zero** times. Only an explicit `restore` or `restore-latest` message opens anything.

The **storage-safety** suite verifies the write mutex serializes concurrent operations, the quota-retry handler prunes oldest unpinned snapshots when storage is full (and never touches pinned ones), the index repair removes orphans, and the import validator rejects malformed JSON without partial application.

The **profile** suite verifies per-profile UUID stability, label persistence, export envelope embedding, cross-profile detection on import, and that the dashboard never confuses one profile's history for another.

## Privacy

- No network requests. No analytics. No sync. All local.
- Incognito windows are never captured.
- Restoration is always confirmed by default.
