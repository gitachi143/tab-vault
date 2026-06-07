/**
 * Tab Vault — email-forwarder (Google Apps Script)
 *
 * Receives a POST from the Tab Vault extension's hourly backup and emails
 * the attached JSON to your own Gmail address. No keys, no third-party
 * service: it runs on Google's infrastructure under your own account.
 *
 * Setup (3 minutes):
 *   1. Open https://script.google.com → New project
 *   2. Replace Code.gs with this file
 *   3. (Optional) Change SHARED_SECRET below to a long random string. If you
 *      set one here, paste the same string in the extension's "Optional
 *      shared secret" field — POSTs without it will be rejected.
 *   4. Click Deploy → New deployment → type: Web app
 *        - Execute as: Me
 *        - Who has access: Anyone   (the URL is unguessable; the secret guards it)
 *   5. Copy the Web app URL it gives you (it ends in /exec)
 *   6. Paste that URL into Tab Vault → ⚙ → Webhook URL
 *   7. Click "Run backup now" in the extension to test — you should receive
 *      an email within ~20 seconds.
 *
 * The first time you trigger it, Google will ask you to authorize the
 * script to send mail on your behalf. Click through the warning (your own
 * script under your own account → "Advanced" → "Go to script (unsafe)").
 */

const SHARED_SECRET = ''; // optional — recommend setting a long random string

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'missing body' });
    }
    const payload = JSON.parse(e.postData.contents);
    if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
      return json({ ok: false, error: 'unauthorized' });
    }
    const data = payload.data || payload;
    const filename = payload.filename || 'tab-vault-backup.json';
    const profileLabel = payload.profileLabel || data.profileLabel || '';
    const browserName = payload.browserName || data.browserName || 'Chrome';
    const profileId = payload.profileId || data.profileId || '';
    const snapshotCount = payload.snapshotCount ?? (Array.isArray(data.snapshots) ? data.snapshots.length : 0);
    const exportedAt = payload.exportedAt || data.exportedAt || Date.now();

    const jsonText = JSON.stringify(data, null, 2);
    const blob = Utilities.newBlob(jsonText, 'application/json', filename);

    const myEmail = Session.getActiveUser().getEmail();
    if (!myEmail) {
      return json({ ok: false, error: 'cannot resolve active user email; re-deploy with "Execute as: Me"' });
    }

    // Subject distinguishes browsers AND profiles so multi-install setups get
    // clearly separable emails. Examples:
    //   [Tab Vault] Brave · Work — 42 snapshots
    //   [Tab Vault] Chrome · 1a2b3c4d — 38 snapshots   (no label set)
    const labelOrId = profileLabel || (profileId ? profileId.slice(0, 8) : 'unknown');
    const subject = `[Tab Vault] ${browserName} · ${labelOrId} — ${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'}`;
    const body = [
      `Tab Vault backup`,
      ``,
      `Browser:     ${browserName}`,
      `Profile:     ${profileLabel || '(unnamed — set a label in Tab Vault settings)'}`,
      `Profile id:  ${profileId || '(missing)'}`,
      `Snapshots:   ${snapshotCount}`,
      `Generated:   ${new Date(exportedAt).toString()}`,
      `Trigger:     ${payload.reason || data.reason || 'scheduled'}`,
      ``,
      `The full JSON is attached. To restore it, drop the file into Tab Vault → Import.`
    ].join('\n');

    MailApp.sendEmail({
      to: myEmail,
      subject,
      body,
      attachments: [blob]
    });
    return json({ ok: true, sentTo: myEmail });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return json({ ok: true, message: 'Tab Vault email-forwarder is live. POST a backup to this URL.' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
