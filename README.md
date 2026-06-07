# Tab Vault

A polished Chrome / Brave extension (Manifest V3) that **logs every tab you have open over time**, bundles snapshots into sessions like Google Docs version history, and lets you browse, search, and diff the history.

> **Tab Vault is observer-only.** It has zero ability to open, close, navigate, focus, move, or pin tabs. There is no restore feature in this build — the user has a separate tool for that. Tab Vault only reads the browser state, writes snapshots to local storage, and optionally exports them to a JSON file or HTTPS webhook.

> **Multi-profile + multi-browser aware.** Each Chrome / Brave / Edge profile keeps its own independent history (enforced by the browser's per-profile storage). The popup chip shows `Browser · Label` (e.g. `Brave · Work`) so you always know which vault you're looking at. Set a label like "Work" or "Personal" in settings and it shows up in the chip and bakes into export filenames. Importing a backup from another profile triggers a confirmation. If you point multiple installs at the same scheduled-backup webhook, you'll receive a separate email per browser+profile combo, with the browser name in the subject line.

> **Scheduled off-device backups** (opt-in, default once-a-day): the extension can also bundle your snapshots into a JSON file on a fixed interval (30 min … weekly) and either save it to your `Downloads/tab-vault/` folder, POST it to an HTTPS endpoint you control, or both. Use the included Google Apps Script template in `integrations/apps-script-mailer/` to receive these as daily emails from your own Gmail to your own Gmail — no third-party services.

## What it does

- **Periodic snapshots** of every tab across every Chrome / Brave window, including tab groups (title + color + collapsed state) and pinned tabs. Default cadence is every 10 minutes; configurable.
- **Manual snapshots** with one click (or `Ctrl/Cmd + Shift + S`).
- **Sessions** — snapshots within an hour of each other are bundled into a session, shown as a timeline grouped by day (Today, Yesterday, weekday, then dated).
- **Diff per snapshot** — each snapshot shows what was opened and closed vs. the previous snapshot in the same session (Google-Docs-style change view).
- **Search** across snapshot names and types.
- **Pin** snapshots so retention pruning never touches them.
- **JSON export / import** — back up your history to a file or import an older backup.
- **Scheduled off-device backups** — once a day by default, optional, sent to a local Downloads folder and/or a user-configured HTTPS webhook.
- **Light / Dark / Auto** theme.
- **Keyboard shortcuts**:
  - `Ctrl/Cmd + Shift + S` — save snapshot
  - `Ctrl/Cmd + Shift + E` — open the history dashboard
  - Inside the dashboard: `Ctrl/Cmd + S` save · `Ctrl/Cmd + /` focus search.

## What it explicitly does NOT do

- Open tabs. Ever. Not on click, not on schedule, not on crash recovery.
- Close, move, navigate, focus, or pin tabs.
- Modify any browser state.
- Make any network request other than the user-configured backup webhook.

If you want restoration, use your separate restore tool. Tab Vault gives you the **history + the JSON backup**; that's its job.

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

### Use across multiple browsers and profiles

Each Chrome / Brave / Edge profile runs its own independent copy of the extension's storage. To install elsewhere:

1. **Different profile (same browser):** switch via the top-right avatar menu. Repeat Step 2 — open `chrome://extensions` *in that profile*, Developer mode on, Load unpacked, select the same folder.
2. **Different browser entirely:** open the equivalent extensions page (`brave://extensions`, `edge://extensions`, etc.), Developer mode on, Load unpacked, select the same folder.
3. In each install's dashboard, set a **Profile label** ("Work", "Personal", etc.) so you can tell them apart.

What you get with multiple installs:

- **Separate snapshots.** Each install captures only the tabs in *its* browser+profile. They never bleed across.
- **Separate popup chip.** Reads `Brave · Work`, `Chrome · Personal`, etc. — auto-detected via `navigator.brave?.isBrave()` for Brave and User-Agent for others.
- **Separate emails.** If you point every install at the same Apps Script webhook, you get distinct emails per install. The subject is `[Tab Vault] <Browser> · <Label> — N snapshots` so they're easy to filter.
- **Separate exports.** Export filenames include browser-aware profile labels too.

---

## How everything works

```
┌──────────────────────────────────────────────────────────────────┐
│                          Tab Vault                                │
│                  (observer — never opens tabs)                    │
│                                                                   │
│   Periodic + manual snapshots ──► chrome.storage.local            │
│        (every 10 min default)            │                        │
│                                          │                        │
│        Tab events ──► live snapshot ◄────┘                        │
│        (debounced 4s)    (read-only, never used to auto-restore)  │
│                                                                   │
│   Scheduled backup ──► Downloads/tab-vault/  AND/OR  HTTPS webhook│
│   (default once a day, opt-in)                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Two surfaces

- **Popup** (toolbar icon) — quick view: current stats, save button, last few snapshots, "View history" link.
- **Dashboard** (the options page, opens in its own tab) — full timeline of snapshots grouped by day → session → snapshot, with diff between consecutive snapshots, search, settings, import/export.

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

### Storage layout

Everything is in `chrome.storage.local` (per-profile, isolated by Chrome itself):
- `snap:index` — a lightweight array of `{id, name, type, timestamp, stats, pinned}` for fast UI rendering.
- `snap:<uuid>` — each snapshot's full payload under its own key, so the dashboard loads only what it shows.
- `tv:settings` — your settings (auto interval, profile label, theme, etc.).
- `tv:profileId` — your stable per-profile UUID.
- `tv:live` + `tv:live_meta` — the rolling crash-recovery snapshot.
- `tv:session` — the current browser-session id.

### What is *guaranteed* never to happen

- **Tab Vault never opens, closes, navigates, focuses, moves, or pins a tab. Period.** Verified by 108 observer-only invariant tests + a static check that scans every source file for forbidden Chrome API calls.
- **Profiles never see each other's history.** Chrome's per-profile storage isolates them; we add a profile UUID on top so cross-profile imports are flagged.
- **No outbound network traffic** other than your own configured backup webhook. No analytics, no sync server, no telemetry.
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

### How to bring tabs back

Tab Vault doesn't open tabs itself. The history is available in two places:

1. **Browse the dashboard.** Click any snapshot in the timeline — the detail pane lists every URL with title and favicon. Use the **⎘ copy** button next to a row to copy a single URL.
2. **Export to JSON.** Dashboard header → **Export** downloads a complete backup file. Hand that file to your separate restore tool.

The scheduled backup (settings → ⚙) does this automatically — daily by default — to your `Downloads/tab-vault/` folder, or POSTs it to a webhook of your choice.

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
- **Favicons appear blank in old snapshots** — favicons are stored as URLs; if you view a snapshot from a site that's now unreachable, the browser falls back to a default. The URL itself is always preserved.
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
- A ⎘ button next to each tab to copy its URL
- Export this single snapshot as JSON for use with your separate restore tool

## Where data lives

- Snapshots are stored in `chrome.storage.local` under their own keys (`snap:<uuid>`) with a fast index at `snap:index`.
- A live snapshot at `tv:live` is rewritten on tab events plus a 1-minute heartbeat. **It is read-only from the user's perspective** — Tab Vault never auto-opens those tabs. On the next browser start, if a previous-session live snapshot is found, it's promoted into the history as a `crash` snapshot so you have a record of what was open before the crash. Tabs are not auto-opened; use your separate restore tool with this snapshot if you want them back.
- `unlimitedStorage` is requested so dense histories don't run into the default 5 MB cap.

## Settings (defaults are tuned for dense logging)

| Setting | Default |
|---|---|
| Auto-snapshot interval | 10 minutes |
| New-session gap | 60 minutes |
| Max retained snapshots (pinned always kept) | 200 |
| Crash-recovery live snapshot | Enabled (read-only) |
| Profile label (this Chrome profile) | empty |
| Theme | Auto (system) |

## Reliability guarantees

| Risk | Mitigation |
|---|---|
| Tab Vault interfering with Chrome's session restore | Tab Vault never calls `chrome.tabs.create/update/remove/move` or `chrome.windows.create/remove` anywhere. Verified by 108 invariant tests (including a static source-file scan) covering install, startup, alarms, every tab/window/group event, every message handler, scheduled-backup firings, and keyboard shortcuts. |
| Tab Vault opening tabs by accident | Impossible — `lib/restore.js` was deleted; no module imports `chrome.tabs.create` anywhere; tests fail the build if any source file does. |
| Two snapshot writes racing (alarm + manual click) | Promise-chain mutex serializes every index-touching operation in `lib/storage.js` |
| Storage quota exceeded | `safeSet()` catches `QUOTA*` errors, prunes oldest unpinned snapshot, retries once; pinned never touched |
| Index points at a deleted key | `repairIndex()` runs on every service worker startup |
| Snapshot rendered then deleted before view | Dashboard shows "no longer available" state instead of crashing |
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
      "type": "manual|auto|startup|crash|import",
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
│   └── sessions.js            # session bundling + diffs (pure)
├── popup/                     # toolbar popup
├── options/                   # full dashboard
├── icons/                     # 16/32/48/128 PNG (generated)
├── scripts/make_icons.py      # regenerate icons (stdlib only)
└── tests/                     # 173 tests covering libs, background, no-auto-open
```

## Tests (327 total)

```
node tests/test.mjs                # 52 lib + integration tests
node tests/test_background.mjs     # 37 background message-handler tests
node tests/test_sessions.mjs       # 32 session bundling + diff tests
node tests/test_no_autoopen.mjs    # 108 observer-only invariant tests (incl. static source scan)
node tests/test_storage_safety.mjs # 39 mutex / quota / repair / validation tests
node tests/test_profile.mjs        # 29 multi-profile/browser + import validation tests
node tests/test_resilience.mjs     # 30 crash recovery, stress, race, edge-case tests
```

### Resilience coverage

The `test_resilience.mjs` suite simulates real-world failure modes:

- **Startup with no windows yet** (Chrome session-restore racing our handler) — verifies we don't persist an empty snapshot.
- **Manual save with no windows** still works (explicit user intent).
- **Browser killed before clean shutdown** — verifies the live snapshot becomes a `crash` history entry on next launch *without* re-opening any tabs.
- **Service-worker restart cycle** — `initOnce()` is idempotent, profile id and settings survive.
- **250 tabs across 10 windows** — captures in under 2 s; round-trips through storage intact.
- **chrome:// / chrome-extension:// / about:blank URLs** preserved verbatim in snapshots.
- **Snapshot deleted between list and fetch** returns `null` cleanly without crashing the dashboard.
- **Storage already populated when extension reloads** — existing data and label survive.
- **50 sequential captures + concurrent alarm + manual race** — mutex keeps the index consistent (zero orphans).
- **Hourly backup cycles fire** — zero tab mutations.
- **Restore from a pruned snapshot** returns a clean error.
- **Chrome restores tabs *after* our startup snapshot** — the live heartbeat catches up; nothing is lost.

The **observer-only** suite is the strongest invariant in the codebase:

- A **static check** opens every source file (`background.js`, all of `lib/`, popup, dashboard) and asserts none of them contain `chrome.tabs.create / .update / .remove / .move`, `chrome.windows.create / .remove / .update`, `chrome.tabs.group`, or `chrome.tabGroups.update`. If any of those strings appears as a real call (not in a comment), the suite fails the build.
- A **file-existence check** asserts `lib/restore.js` is gone.
- **Runtime checks** fire every event (install, startup, alarms, tab/window/group events, keyboard shortcuts) and every message handler and verify `chrome.tabs.create / .update / .remove`, `chrome.windows.create / .remove`, `chrome.tabs.group` counters all stay at zero.
- Confirms `restore` and `restore-latest` messages return "Unknown message" — they simply don't exist anymore.

The **storage-safety** suite verifies the write mutex serializes concurrent operations, the quota-retry handler prunes oldest unpinned snapshots when storage is full (and never touches pinned ones), the index repair removes orphans, and the import validator rejects malformed JSON without partial application.

The **profile** suite verifies per-profile UUID stability, label persistence, export envelope embedding, cross-profile detection on import, and that the dashboard never confuses one profile's history for another.

## Privacy

- No network requests. No analytics. No sync. All local.
- Incognito windows are never captured.
- Restoration is always confirmed by default.
