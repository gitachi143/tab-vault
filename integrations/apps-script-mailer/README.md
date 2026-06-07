# Tab Vault — Apps Script email forwarder

A 3-minute setup that gives you hourly emails of your Tab Vault backups
attached as JSON, sent from your own Gmail address to your own Gmail address,
running on Google's infrastructure under your own account.

## Why this approach

Browser extensions cannot send email directly — they can only fetch HTTPS
endpoints. So Tab Vault POSTs the backup JSON to a webhook URL you control.
This Apps Script is the simplest webhook that emails you the attached file.

No third-party services. No API keys. No payment. The script runs in your
own Google Apps Script project, signs in as you, and uses your own Gmail
quota (which is generous — far more than once an hour).

## Setup

### 1. Create the Apps Script project

1. Open <https://script.google.com>.
2. Click **New project** (top-left).
3. Replace the default `function myFunction() { }` content in `Code.gs` with
   the contents of [`Code.gs`](./Code.gs) from this directory.

### 2. (Optional) Set a shared secret

If you want to make sure no one else can trigger your email forwarder even
if they discover the URL, edit the top of `Code.gs`:

```javascript
const SHARED_SECRET = 'paste-a-long-random-string-here';
```

You will paste the same string into Tab Vault → ⚙ → "Optional shared secret"
in the next steps. Leave it empty if you don't care about that protection.

### 3. Deploy as a web app

1. Click **Deploy** (top right) → **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Configure:
   - **Description:** Tab Vault mailer
   - **Execute as:** Me (your.email@gmail.com)
   - **Who has access:** Anyone
     - Don't worry: the URL is unguessable, and the optional secret in step
       2 makes it actually unauthenticated-only-if-you-want.
4. Click **Deploy**.
5. The first time, Google will ask you to authorize. The script runs as you
   and sends mail as you, so it needs your permission. Click through the
   "this app isn't verified" warning — that's because the app is yours, not
   Google's. Choose **Advanced → Go to (unsafe)** → **Allow**.
6. Copy the **Web app URL** it gives you. It looks like:
   `https://script.google.com/macros/s/AKfy.../exec`

### 4. Wire Tab Vault to it

1. Open Tab Vault → **⚙** (settings).
2. Scroll to **Hourly backup (off-device)**.
3. Tick **Run hourly backup**.
4. Paste the URL into **Webhook URL**.
5. If you set a `SHARED_SECRET` in step 2, paste it into **Optional shared
   secret**.
6. Click **Run backup now**. Within ~20 seconds you should receive an email
   with the JSON attached.

### 5. (Optional) Test the script directly

You can also paste the Web app URL into a browser. A GET request returns:

```json
{"ok":true,"message":"Tab Vault email-forwarder is live. POST a backup to this URL."}
```

That confirms the endpoint is reachable.

## What gets emailed

- **Subject:** `[Tab Vault] <profile-label> — <N> snapshots`
- **Body:** profile name, snapshot count, generation timestamp, trigger reason.
- **Attachment:** `tab-vault-<label>-backup-YYYYMMDD-HHMMSS.json` — the full
  export, identical in shape to what the **Export all** button produces.

To restore from one of these emails, save the JSON, then in Tab Vault click
**Import** and select it.

## Disabling or rotating

- **Turn off temporarily:** uncheck "Run hourly backup" in Tab Vault settings.
- **Rotate the URL:** in Apps Script → Deploy → Manage deployments → Archive
  the old one, create a new deployment, paste the new URL into Tab Vault.
- **Change the email recipient:** the script always sends to
  `Session.getActiveUser().getEmail()` — your own Google account. Change
  that line in `Code.gs` and redeploy if you want a different address.
