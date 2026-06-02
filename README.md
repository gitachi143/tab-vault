# Tab Vault

A polished Chrome / Brave extension (Manifest V3) that **logs every tab you have open over time**, bundles snapshots into sessions like Google Docs version history, and lets you browse, search, and diff the history.

> **Tab Vault never opens tabs on its own.** The only code path that opens a tab or window runs when you click a **Restore** button. Lifecycle events, alarms, tab events, and crash detection only read and write storage.

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

## Install (Chrome or Brave)

1. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this folder.
4. Pin the Tab Vault icon in your toolbar.

That's it — Chrome and Brave are both Chromium with full MV3 + tabGroups support.

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
| Theme | Auto (system) |

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

## Tests

```
node tests/test.mjs            # 89 lib + integration tests
node tests/test_background.mjs # 39 background message-handler tests
node tests/test_sessions.mjs   # 32 session bundling + diff tests
node tests/test_no_autoopen.mjs # 13 invariant tests: nothing auto-opens tabs
```

The no-auto-open suite verifies that **across every non-restore code path** (install, startup, alarms, tab events, group events, every non-restore message, keyboard shortcuts), `chrome.tabs.create` and `chrome.windows.create` are called **zero** times. Only an explicit `restore` or `restore-latest` message opens anything.

## Privacy

- No network requests. No analytics. No sync. All local.
- Incognito windows are never captured.
- Restoration is always confirmed by default.
