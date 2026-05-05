# Setting up Google Drive Sync (one-time publisher setup)

> **Audience:** the person publishing TagMark to the Chrome Web Store (or
> distributing it as an unpacked extension). End users **never** do any of
> this — once you have replaced the placeholder client ID below, every user
> who installs TagMark just clicks **Connect Google Drive** in the Cloud
> Sync modal, picks their Google account, and is done.

---

## What you'll do

1. Determine your extension's deterministic ID
2. Create a Google Cloud project
3. Configure the OAuth consent screen (no app verification required)
4. Create a Chrome-Extension OAuth client ID
5. Replace the placeholder in `manifest.json`
6. Reload and test

The whole thing typically takes 10–15 minutes.

---

## 1. Get your extension ID

The repo's `manifest.json` already includes a fixed `key` field. That key
makes the extension ID deterministic across every install — meaning a
single OAuth client ID will be valid for every user, on every machine,
forever.

**Easiest path** — load the unpacked extension once:

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and pick the repo root
4. Copy the 32-character ID that appears under "TagMark" — e.g.
   `abcdefghijklmnopqrstuvwxyzabcdef`

**Programmatic path** (optional, if you don't have Chrome handy):

```bash
node -e "const c=require('crypto'),k=Buffer.from('PASTE_KEY_FROM_MANIFEST','base64');\
process.stdout.write(c.createHash('sha256').update(k).digest('hex')\
.slice(0,32).split('').map(x=>String.fromCharCode(parseInt(x,16)+97)).join(''))"
```

Both methods produce the same ID.

---

## 2. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/projectcreate>
2. Project name: anything you like (e.g. `tagmark-extension`)
3. Click **Create**

Once the project is selected, in the left nav: **APIs & Services →
Library** → search for **Google Drive API** → click **Enable**.

> Why the Drive API? Because the extension calls
> `https://www.googleapis.com/drive/v3/...` to upload and download the
> single backup file. The API has to be enabled in your project for those
> calls to succeed.

---

## 3. Configure the OAuth consent screen

In the left nav: **APIs & Services → OAuth consent screen**.

1. **User Type** → **External** → **Create**.
2. **App information**
   - App name: `TagMark`
   - User support email: your email
   - App logo: optional (any PNG of `icons/icon128.png` will do)
3. **App domains**: leave blank — not required for a Chrome-extension OAuth
   client.
4. **Developer contact information**: your email.
5. **Save and Continue** → reach the **Scopes** step.
6. Click **Add or Remove Scopes** → in the filter, paste:
   ```
   https://www.googleapis.com/auth/drive.file
   ```
   Tick it. Click **Update**.
7. **Save and Continue** through the remaining steps. You may add
   yourself as a **Test user** while the app is in *Testing* mode, but
   once you publish (next step) test users are no longer required.
8. Back on the OAuth consent screen, click **Publish app**. Confirm the
   prompt.

> ### Why publishing is safe and does **not** trigger Google's app verification
>
> The `drive.file` scope is in Google's
> [recommended / non-sensitive scope list](https://developers.google.com/identity/protocols/oauth2/scopes#drive).
> It only grants access to files the user picks or that the app itself
> creates — not their entire Drive. Apps that use **only** non-sensitive
> scopes do **not** need to go through Google's app-verification process
> in order to publish, and users will **not** see the
> "Google hasn't verified this app" warning screen on the consent dialog.
> They will instead see a normal "TagMark wants to: see, edit, create and
> delete only the specific Google Drive files you use with this app"
> consent screen.

---

## 4. Create the OAuth client ID

In the left nav: **APIs & Services → Credentials**.

1. Click **Create credentials → OAuth client ID**.
2. **Application type** → **Chrome Extension**.
3. **Name** → anything (e.g. `tagmark-cws`).
4. **Application ID** → paste the 32-character extension ID from step 1.
5. Click **Create**.
6. Copy the resulting client ID. It looks like
   `1234567890-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com`.

---

## 5. Drop the client ID into `manifest.json`

Open `manifest.json` at the repo root and replace the placeholder:

```diff
   "oauth2": {
-    "client_id": "REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
+    "client_id": "1234567890-abcdef….apps.googleusercontent.com",
     "scopes": [
       "https://www.googleapis.com/auth/drive.file"
     ]
   },
```

Commit and ship. End users get the new build, click **Connect Google
Drive**, and it just works.

---

## 6. Smoke test

1. `chrome://extensions/` → click the **refresh icon** on the TagMark card.
2. Open the dashboard → click **Cloud Sync** in the sidebar footer.
3. Click **Connect Google Drive**.
4. Pick a Google account → review the consent screen → click **Continue**.
5. Click **Back up now**. The toast should read
   *"Backed up N bookmarks to Drive"*.
6. Open <https://drive.google.com/> → confirm `tagmark-backup.json` exists.
7. Click **Restore from Drive** → confirm bookmarks come back identically.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `OAuth2 not granted or revoked` after clicking Connect | Stale token in chrome.identity cache | Click **Sign out of Google Drive** in the modal, then **Connect** again |
| `bad client id: …` in the service-worker console | Client ID typo in `manifest.json`, or extension ID mismatch in GCP | Re-check both ends of step 4 / step 5 |
| Consent screen shows "Google hasn't verified this app" | OAuth consent screen still in *Testing* mode | Go back to step 3 step 8 — **Publish app** |
| Drive list / upload returns 403 `Drive API has not been used` | Drive API not enabled in your project | Enable it under **APIs & Services → Library** (step 2) |
| Connect succeeds but Backup says `Drive upload failed: 401` | Token expired AND silent refresh failed for an unusual reason | Sign out + reconnect; if persistent, file an issue with the service-worker console output |

---

## What if you fork TagMark?

If you fork the repo and publish under a different Chrome Web Store
listing, you must redo steps 1–5 with **your** extension's ID. The
upstream client ID will not work for a different extension.
