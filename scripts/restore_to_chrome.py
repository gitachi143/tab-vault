#!/usr/bin/env python3
"""
restore_to_chrome.py — re-open a Tab Vault snapshot as real browser tabs.

Tab Vault itself is observer-only (it just records). This script is the
companion restorer: it reads a Tab Vault JSON export and launches each
saved window with all of its tabs, using the browser's command-line
interface.

Usage:
  python3 scripts/restore_to_chrome.py /path/to/tab-vault-...json
  python3 scripts/restore_to_chrome.py PATH --browser brave
  python3 scripts/restore_to_chrome.py PATH --dry-run
  python3 scripts/restore_to_chrome.py PATH --window 1 --window 3
  python3 scripts/restore_to_chrome.py PATH --snapshot 2
  python3 scripts/restore_to_chrome.py PATH --batch-size 100

Behaviour:
  * One new browser window is opened per saved window. Tabs appear in the
    saved order. Pinned and group state are NOT recreated (the command-line
    interface can't express them — only URLs).
  * Special URLs that the browser refuses to open from the command line
    (chrome://, chrome-extension://, devtools://, about:blank) are skipped
    and listed at the end so you can decide what to do with them.
  * Large windows (>100 tabs) open in batches so the browser doesn't
    refuse / lose tabs. Default batch is 80, adjustable via --batch-size.
  * --dry-run shows exactly what would be opened without launching anything.

The JSON shape this tool reads is the same one Tab Vault's Export button
produces — see README.md → "Snapshot file format (v1)".
"""

import argparse
import json
import os
import subprocess
import sys
import time
from typing import List, Dict, Any

BROWSER_PATHS = {
    "chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "brave":  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "edge":   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
}

# URLs the browser will silently drop or refuse to open from --new-window.
SKIP_PREFIXES = (
    "chrome://",
    "chrome-extension://",
    "chrome-search://",
    "chrome-untrusted://",
    "devtools://",
    "edge://",
    "brave://",
    "about:",
    "view-source:",
    "javascript:",
)


def load_payload(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def list_snapshots(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return the list of snapshots in this payload, regardless of envelope."""
    if "snapshots" in payload and isinstance(payload["snapshots"], list):
        return payload["snapshots"]
    if "snapshot" in payload and isinstance(payload["snapshot"], dict):
        return [payload["snapshot"]]
    if "windows" in payload:                # bare snapshot
        return [payload]
    raise SystemExit("File doesn't look like a Tab Vault export.")


def pick_snapshot(snapshots: List[Dict[str, Any]], requested: int) -> Dict[str, Any]:
    if not snapshots:
        raise SystemExit("No snapshots in this file.")
    if len(snapshots) == 1:
        return snapshots[0]
    if requested:
        if requested < 1 or requested > len(snapshots):
            raise SystemExit(f"--snapshot {requested} out of range (1..{len(snapshots)}).")
        return snapshots[requested - 1]
    # If multiple, pick the most recent by timestamp.
    return sorted(snapshots, key=lambda s: s.get("timestamp", 0), reverse=True)[0]


def split_url(url: str):
    """Return (url, skip_reason or None)."""
    if not url:
        return url, "empty URL"
    lower = url.lower()
    for p in SKIP_PREFIXES:
        if lower.startswith(p):
            return url, f"browser-internal scheme ({p}*)"
    return url, None


def open_window(browser_bin: str, urls: List[str], batch_size: int, dry: bool):
    """Open a single browser window populated with all given URLs."""
    if not urls:
        return
    first = urls[0]
    rest = urls[1:]
    if dry:
        print(f"  [dry-run] open --new-window with first URL {first}")
    else:
        subprocess.Popen(
            [browser_bin, "--new-window", first],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.2)  # let the window appear so subsequent URLs attach to it
    # Add remaining URLs in batches to the same browser instance.
    i = 0
    while i < len(rest):
        chunk = rest[i:i + batch_size]
        if dry:
            print(f"  [dry-run] add {len(chunk)} more tabs (batch starting #{i+2})")
        else:
            subprocess.Popen(
                [browser_bin, *chunk],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(0.6)
        i += len(chunk)


def main():
    ap = argparse.ArgumentParser(description="Restore a Tab Vault snapshot to Chrome / Brave.")
    ap.add_argument("path", help="Tab Vault JSON export file")
    ap.add_argument("--browser", choices=BROWSER_PATHS.keys(), default="chrome",
                    help="Target browser (default: chrome)")
    ap.add_argument("--snapshot", type=int, default=0,
                    help="When the file contains multiple snapshots, pick this one (1-indexed). "
                         "Default: the most recent.")
    ap.add_argument("--window", action="append", type=int, default=[],
                    help="Restore only specific window indices (1-indexed). Pass multiple times.")
    ap.add_argument("--batch-size", type=int, default=80,
                    help="Tabs per command-line invocation (default: 80). Reduce if you see drops.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print what would be opened without launching the browser.")
    args = ap.parse_args()

    if not os.path.exists(args.path):
        sys.exit(f"File not found: {args.path}")

    browser_bin = BROWSER_PATHS[args.browser]
    if not args.dry_run and not os.path.exists(browser_bin):
        sys.exit(f"{args.browser.title()} executable not found at {browser_bin}")

    payload = load_payload(args.path)
    snapshots = list_snapshots(payload)
    snap = pick_snapshot(snapshots, args.snapshot)

    name = snap.get("name", "(unnamed)")
    ts = snap.get("timestamp", 0)
    profile = payload.get("profileLabel") or snap.get("profileLabel") or "(no label)"
    print(f"Source file:       {args.path}")
    print(f"Snapshot:          {name}")
    print(f"Captured (ms):     {ts}")
    print(f"Source profile:    {profile}")
    print(f"Target browser:    {args.browser}")
    print()

    windows = snap.get("windows", []) or []
    if args.window:
        wanted = set(args.window)
        windows = [w for i, w in enumerate(windows, start=1) if i in wanted]

    skipped: List[str] = []
    total_tabs = 0
    for i, w in enumerate(windows, start=1):
        tabs = sorted(w.get("tabs", []) or [], key=lambda t: t.get("index", 0))
        urls = []
        for t in tabs:
            url, reason = split_url(t.get("url", ""))
            if reason:
                skipped.append(f"  window {i}: {url}    ← {reason}")
            else:
                urls.append(url)
        print(f"Window {i}: {len(urls)} tabs to open"
              f"{' (' + str(len(tabs) - len(urls)) + ' skipped)' if len(tabs) != len(urls) else ''}")
        if urls:
            open_window(browser_bin, urls, args.batch_size, args.dry_run)
            total_tabs += len(urls)
        if i != len(windows):
            time.sleep(0.4)  # breathing room between windows

    print()
    print(f"Done. {total_tabs} tabs across {len(windows)} window(s) "
          f"{'would be opened' if args.dry_run else 'opened'}.")
    if skipped:
        print(f"\nSkipped {len(skipped)} browser-internal URL(s) (cannot be opened from CLI):")
        for line in skipped[:40]:
            print(line)
        if len(skipped) > 40:
            print(f"  ... and {len(skipped) - 40} more")


if __name__ == "__main__":
    main()
