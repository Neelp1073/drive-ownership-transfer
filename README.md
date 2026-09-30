# Drive Bulk Ownership Transfer

A local Brave / Chromium **Manifest V3** extension that transfers ownership of Google Drive files and folders using the **official Google Drive API v3** and **OAuth 2.0**.

It does **not** click through the Drive website, does **not** use a service account, and does **not** ship with any client secrets or access tokens. You paste your own OAuth client ID after creating a Google Cloud project.

Default target account (change this in the extension UI, or in `js/config.js`):

```text
REPLACE_WITH_THE_NEW_ACCOUNT_EMAIL
```

---

## Architecture (short)

1. A toolbar popup opens `app.html`, which is the real UI. Transfer work runs in that page so Chrome/Brave will not kill it the way they kill a Manifest V3 service worker.
2. You sign in with OAuth (`chrome.identity.launchWebAuthFlow`). The access token stays in `chrome.storage.local` on this browser profile.
3. **Scan** calls `files.list` with `'me' in owners and trashed = false` and walks every page of results. Each file and each folder is a separate item. **Transferring a folder does not transfer the files inside it.**
4. A **review** screen shows eligible vs skipped items, a CSV download, and a mandatory confirmation checkbox. **Dry Run** walks the same list and writes a report without calling any permission APIs. **Start Transfer** is the only control that changes ownership.
5. Progress is saved after every item (Pause / Resume / Cancel). Failed items do not stop the rest of the queue. Rate limits use exponential backoff.

```text
popup.html  →  app.html (UI)
                 ├─ js/auth.js      OAuth 2.0
                 ├─ js/drive.js     Drive API v3 + retries
                 ├─ js/scan.js      owner scan + skip reasons
                 ├─ js/transfer.js  Workspace transfer + Gmail Phase 1/2
                 └─ js/state.js     resumable chrome.storage.local
```

---

## Ownership limits Google will not let this tool bypass

A true, complete “everything I own is now yours” transfer is **not always possible**. The extension reports these cases instead of pretending they worked.

| Situation | What happens |
| --- | --- |
| **Shared Drives** | Files belong to the organization, not a person. Individual ownership cannot be transferred. |
| **Different Workspace organizations / domains** | Google rejects the API call. Both accounts must be in the **same** organization. |
| **Personal Gmail ↔ Workspace** | Google does not allow this ownership transfer. |
| **Items you do not own** | Skipped. Only the owner can transfer. |
| **`canShare` / `canTransferOwnership` is false** | Skipped; the API says the item cannot be shared or transferred. |
| **Consumer Gmail → Gmail** | Not instant. Source makes the target a **pending owner**. The target must sign in here and **accept** (Phase 2). Until then, you still own the files. |
| **Folder vs children** | Each owned child is transferred separately. A folder transfer never changes the owner of the files inside. |
| **Previous owner access** | The old owner is **kept as a writer**. This tool never removes that writer permission, and never deletes, moves, or downloads content. |

---

## 1. Create a Google Cloud OAuth client

Do this once. Both the **source** account (current owner) and the **target** account (new owner) will sign in to *your* app.

### Create the project and enable Drive

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Click **Select a project** → **New Project**. Name it something like `Drive Ownership Transfer`.
3. Open **APIs & Services** → **Library**.
4. Search for **Google Drive API** → **Enable**.

### Configure the OAuth consent screen

1. Open **APIs & Services** → **OAuth consent screen**.
2. Choose **External** (personal Gmail) or **Internal** (Workspace-only, if that option appears).
3. App name: `Drive Bulk Ownership Transfer`. Add your email as the support / developer contact.
4. Scopes → **Add or remove scopes** → add:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `openid`  
   The full Drive scope is required because this app must list **all** files you own and change permissions. The narrower `drive.file` scope only covers files the app created, so it cannot do a bulk transfer.
5. If the app is in **Testing** mode (default for personal use), open **Test users** and add **both** the source account and the target account. Otherwise Google will refuse sign-in.
6. You do **not** need to submit the app for verification if only those test users will use it.

### Create the OAuth client ID

1. Open **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**.
2. Prefer **Web application** (works well with Brave):
   - Name: `Drive Transfer Brave`
   - **Authorized redirect URIs**: leave empty for a moment, load the extension (step 2), copy the redirect URI from the Setup card, then come back and add it exactly. It looks like:  
     `https://<extension-id>.chromiumapp.org/`
   - **Authorized JavaScript origins** (optional): `chrome-extension://<extension-id>`
3. Alternative: type **Chrome extension**, and set the application ID to the extension ID shown in Setup / `brave://extensions`. Then also paste that same client ID into `manifest.json` under `oauth2.client_id`.
4. Copy the **Client ID** (it ends with `.apps.googleusercontent.com`).  
   **Do not** put a client secret in this project. The extension uses public-client OAuth (PKCE or the identity API).

---

## 2. Load the unpacked extension in Brave

1. Open Brave and go to `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Choose this folder: `drive-ownership-transfer` (the folder that contains `manifest.json`).
5. Pin the extension if you want. Click its icon → **Open transfer tool**.
6. On the Setup card, copy:
   - **Extension ID**
   - **Authorized redirect URI**
7. Paste those into the Google Cloud OAuth client from step 1, then click **Save** in Cloud Console.
8. Paste the **OAuth 2.0 client ID** into the extension Setup card.
9. Replace `REPLACE_WITH_THE_NEW_ACCOUNT_EMAIL` with the real target address.
10. Click **Save setup**.

If Brave later assigns a new extension ID (this happens if you reload from a different path), update the redirect URI in Google Cloud to match.

Optional: put the same client ID into `manifest.json` → `oauth2.client_id` if you want Chrome’s `getAuthToken` helper as a fallback.

---

## 3. Use the tool

Keep the transfer tab open while a run is in progress.

### A. Google Workspace → same organization

1. **Sign in as source** (the current owner).
2. Click **Scan owned files and folders**. Wait until pagination finishes.
3. Read the review: eligible files, eligible folders, skipped items and reasons.
4. Download the **CSV preview** if you want a copy before anything changes.
5. Check **I understand this changes ownership…**
6. Optionally click **Dry run** (no API writes).
7. Click **Start Transfer**. Each item is transferred with `transferOwnership=true`. Google emails the new owner. You remain a **writer**.

### B. Personal Gmail → personal Gmail (two phases)

Google will not make the target the owner until that person accepts.

**Phase 1 — source account**

1. Sign in as the current owner, scan, review, check the confirmation box.
2. Click **Start Transfer**. The extension adds the target as a writer with `pendingOwner=true` and stores each file ID + permission ID locally.

**Phase 2 — target account**

1. The UI explains that the target must authorize the app and accept.
2. Click **Sign out**, then **Sign in as target (Phase 2)**. Choose the target Google account. That account must be a test user on your OAuth consent screen.
3. Click **Accept pending transfers**. The extension calls `transferOwnership=true` on each stored pending permission.
4. If the target never accepts, those files stay yours. The CSV report will say so.

### Controls

| Button | What it does |
| --- | --- |
| Dry run | Walks the list, writes a report, **changes nothing** |
| Start Transfer | The only button that mutates permissions |
| Pause / Resume | Stops after the current item / continues from the saved cursor |
| Cancel | Stops the queue; results stay so you can export |
| Export CSV report | Download id, name, status, reason, permission ID, error |
| Clear saved state | Deletes the local scan, progress, and pending-transfer list |

---

## Error messages you may see

- **Different organization / domain** — both accounts must be in the same Google Workspace org.
- **Gmail ↔ Workspace** — Google does not permit that ownership change.
- **Shared Drive** — no personal owner to transfer.
- **Owned by someone else** — sign in as the owner, or skip that file.
- **Target has not accepted** — finish Phase 2 while signed in as the target.
- **Rate limit / quota** — the tool waits and retries (exponential backoff). If it keeps failing, pause for a few minutes and click Resume. Google also limits how many sharing/ownership changes you can make in a short window.

---

## Privacy

- No analytics, no backend, no service account.
- OAuth tokens and the transfer queue live in this browser’s extension storage.
- **Clear saved state** and **Sign out** remove that local data (sign-out also revokes the token with Google when possible).

---

## Development layout

```text
manifest.json
app.html / popup.html / background.js
css/styles.css
js/config.js
js/auth.js
js/drive.js
js/scan.js
js/transfer.js
js/state.js
js/csv.js
js/errors.js
js/app.js
icons/
```

No build step and no framework. After you edit files, click **Reload** on `brave://extensions`.
