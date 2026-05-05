// TagMark — Google Drive sync module
// Loaded via importScripts() in background.js when running in a service worker.
// All functions are top-level so they share the service-worker global scope.
// Copyright (c) 2026 Asim Ghaffar (github.com/shaghab)
//
// Sync model
// ----------
// A single JSON document — `tagmark-backup.json` — is stored in the user's
// own Google Drive (scope: drive.file, so the file is only accessible to this
// extension and visible to the user in their Drive UI).
//
// The file holds a snapshot of all bookmarks, folders, and settings, and is
// overwritten on every backup. Restoring replaces local data wholesale.
//
// Auto-sync, when enabled, schedules a chrome.alarms backup every 30 minutes
// while the user is signed in.

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const GDRIVE_FILE_NAME    = 'tagmark-backup.json';
const GDRIVE_BACKUP_VER   = 1;
const GDRIVE_AUTO_ALARM   = 'tagmark-gdrive-auto-backup';
const GDRIVE_AUTO_PERIOD  = 30; // minutes
const GDRIVE_FILES_API    = 'https://www.googleapis.com/drive/v3/files';
const GDRIVE_UPLOAD_API   = 'https://www.googleapis.com/upload/drive/v3/files';
const GDRIVE_REVOKE_URL   = 'https://oauth2.googleapis.com/revoke';

// ── Settings persistence ─────────────────────────────────────────────────────
//
// Drive sync state lives inside the existing tagmark_settings object so it is
// covered by the same chrome.storage.sync layer (and roams with the user's
// theme). Shape:
//
//   tagmark_settings.driveSync = {
//     enabled:        boolean,  // user has signed in at least once
//     autoSync:       boolean,  // periodic backup alarm enabled
//     fileId:         string,   // Drive file ID of the backup, if known
//     lastSyncAt:     number,   // ms epoch of last successful upload
//     lastSyncStatus: 'ok' | 'error' | null,
//     lastError:      string    // last error message, if any
//   }

function defaultDriveSyncState() {
  return {
    enabled: false,
    autoSync: false,
    fileId: null,
    lastSyncAt: 0,
    lastSyncStatus: null,
    lastError: ''
  };
}

async function getDriveState() {
  const result = await new Promise(r => chrome.storage.sync.get([SETTINGS_KEY], r));
  const settings = result[SETTINGS_KEY] || {};
  return { ...defaultDriveSyncState(), ...(settings.driveSync || {}) };
}

async function setDriveState(patch) {
  const result = await new Promise(r => chrome.storage.sync.get([SETTINGS_KEY], r));
  const settings = result[SETTINGS_KEY] || {};
  const next = { ...defaultDriveSyncState(), ...(settings.driveSync || {}), ...patch };
  await new Promise(r =>
    chrome.storage.sync.set({ [SETTINGS_KEY]: { ...settings, driveSync: next } }, r)
  );
  return next;
}

// ── Configuration check ──────────────────────────────────────────────────────
//
// The OAuth client_id ships in manifest.json. Public/fork builds may still
// carry the placeholder string, which would let users click "Connect Google
// Drive" only to hit a confusing OAuth failure. Detect that case at runtime
// so the dashboard can hide the Cloud Sync UI entirely until a publisher
// swaps in a real client_id.

function isGdriveConfigured() {
  try {
    const manifest = chrome.runtime.getManifest();
    const id = manifest && manifest.oauth2 && manifest.oauth2.client_id;
    if (typeof id !== 'string' || !id) return false;
    if (id.startsWith('REPLACE_WITH_')) return false;
    return true;
  } catch {
    return false;
  }
}

// ── OAuth ────────────────────────────────────────────────────────────────────

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    if (!chrome.identity || !chrome.identity.getAuthToken) {
      reject(new Error('chrome.identity is not available'));
      return;
    }
    chrome.identity.getAuthToken({ interactive: !!interactive }, token => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(
          (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
          'Failed to obtain Google OAuth token'
        ));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise(resolve => {
    if (!chrome.identity || !chrome.identity.removeCachedAuthToken) {
      resolve();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// Drive API calls return 401 when a cached token has been revoked server-side.
// On 401 we drop the token from the identity cache and retry once with a fresh
// one. Any further failure is surfaced to the caller.
async function authedFetch(url, options = {}, retry = true) {
  const token = await getAuthToken(false);
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (res.status === 401 && retry) {
    await removeCachedAuthToken(token);
    return authedFetch(url, options, false);
  }
  return res;
}

// ── Drive file helpers ───────────────────────────────────────────────────────

// Returns the Drive file ID of the backup file, or null if not present.
// Uses the metadata cached in settings first; falls back to a name search.
async function findBackupFileId() {
  const state = await getDriveState();
  if (state.fileId) {
    // Verify the cached file still exists (it may have been trashed by the user).
    const head = await authedFetch(
      `${GDRIVE_FILES_API}/${encodeURIComponent(state.fileId)}?fields=id,trashed`
    );
    if (head.ok) {
      const meta = await head.json();
      if (!meta.trashed) return state.fileId;
    }
    // Fall through to name search if cached ID is stale.
  }

  const q = encodeURIComponent(`name = '${GDRIVE_FILE_NAME}' and trashed = false`);
  const res = await authedFetch(
    `${GDRIVE_FILES_API}?q=${q}&spaces=drive&fields=files(id,modifiedTime,size)`
  );
  if (!res.ok) {
    throw new Error(`Drive list failed: ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data.files) || data.files.length === 0) return null;
  return data.files[0].id;
}

// Multipart upload: a metadata JSON part + the backup body, separated by a
// random boundary. Used both for creating a new file and updating an existing
// one (PATCH).
function buildMultipartBody(metadata, body, boundary) {
  const delim = `\r\n--${boundary}\r\n`;
  const close = `\r\n--${boundary}--`;
  return (
    delim +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delim +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    body +
    close
  );
}

async function uploadBackupFile(jsonBody) {
  const existingId = await findBackupFileId();
  const boundary   = 'tagmark-' + Math.random().toString(36).slice(2);
  const metadata   = existingId
    ? { name: GDRIVE_FILE_NAME }
    : { name: GDRIVE_FILE_NAME, mimeType: 'application/json' };
  const body = buildMultipartBody(metadata, jsonBody, boundary);

  const url = existingId
    ? `${GDRIVE_UPLOAD_API}/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,modifiedTime`
    : `${GDRIVE_UPLOAD_API}?uploadType=multipart&fields=id,modifiedTime`;

  const res = await authedFetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive upload failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function downloadBackupFile() {
  const fileId = await findBackupFileId();
  if (!fileId) return null;
  const res = await authedFetch(
    `${GDRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`
  );
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Drive download failed: ${res.status}`);
  }
  const text = await res.text();
  return { fileId, text };
}

// ── Snapshot build / apply ───────────────────────────────────────────────────

const MAX_RESTORE_BYTES = 50 * 1024 * 1024; // 50 MB hard cap on a downloaded backup

async function buildSnapshot() {
  const [bookmarks, folders, settingsResult] = await Promise.all([
    getBookmarks(),
    getFolders(),
    new Promise(r => chrome.storage.sync.get([SETTINGS_KEY], r))
  ]);
  const rawSettings = settingsResult[SETTINGS_KEY] || {};
  // Strip transient driveSync state from the snapshot so a restore on another
  // device doesn't import this device's sign-in flag.
  const exportSettings = { theme: rawSettings.theme || 'light' };
  return {
    schema:     'tagmark-backup',
    version:    GDRIVE_BACKUP_VER,
    exportedAt: Date.now(),
    settings:   exportSettings,
    folders,
    bookmarks
  };
}

// Replace local bookmarks and folders with the snapshot's contents.
// driveSync state in settings is preserved so the user stays signed in.
async function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Backup file is empty or unreadable');
  }
  if (snapshot.schema !== 'tagmark-backup') {
    throw new Error('Backup file is not a TagMark backup');
  }

  const incomingBookmarks = Array.isArray(snapshot.bookmarks) ? snapshot.bookmarks : [];
  const incomingFolders   = Array.isArray(snapshot.folders)   ? snapshot.folders   : [];

  // Sanitize bookmarks through the existing import path so malformed entries
  // are rejected and lengths/tags are normalised.
  const cleanBookmarks = incomingBookmarks
    .map(sanitizeBookmark)
    .filter(Boolean);

  // Folders: keep only the fields we recognise, with type checks.
  const cleanFolders = incomingFolders
    .filter(f => f && typeof f === 'object' && typeof f.id === 'string' && typeof f.name === 'string')
    .map(f => ({
      id:        f.id,
      name:      String(f.name).trim().replace(/[<>"'`]/g, '').slice(0, MAX_FOLDER_NAME_LEN),
      parentId:  typeof f.parentId === 'string' && f.parentId ? f.parentId : null,
      createdAt: typeof f.createdAt === 'number' ? f.createdAt : Date.now()
    }))
    .filter(f => f.name);

  // Drop any bookmark folderId that points at a folder we didn't accept.
  const folderIds = new Set(cleanFolders.map(f => f.id));
  cleanBookmarks.forEach(b => {
    if (b.folderId && !folderIds.has(b.folderId)) b.folderId = null;
  });

  // Wholesale replace: clear existing per-bookmark keys before writing the new
  // index so stale data can't linger.
  const { [INDEX_KEY]: oldIds = [] } = await new Promise(r =>
    chrome.storage.sync.get([INDEX_KEY], r)
  );
  if (oldIds.length) {
    await new Promise(r =>
      chrome.storage.sync.remove(oldIds.map(id => BM_PREFIX + id), r)
    );
  }
  await saveBookmarks(cleanBookmarks);
  await saveFolders(cleanFolders);

  // Settings: merge so we don't wipe the local driveSync block.
  if (snapshot.settings && typeof snapshot.settings === 'object') {
    const result = await new Promise(r => chrome.storage.sync.get([SETTINGS_KEY], r));
    const current = result[SETTINGS_KEY] || {};
    const VALID_THEMES = ['light', 'dark'];
    const theme = VALID_THEMES.includes(snapshot.settings.theme)
      ? snapshot.settings.theme
      : (current.theme || 'light');
    await new Promise(r =>
      chrome.storage.sync.set({
        [SETTINGS_KEY]: { ...current, theme }
      }, r)
    );
  }

  return { bookmarks: cleanBookmarks.length, folders: cleanFolders.length };
}

// ── Public sync actions ──────────────────────────────────────────────────────

async function gdriveConnect() {
  // Force the consent prompt the first time so the user can pick an account.
  const token = await getAuthToken(true);
  if (!token) throw new Error('Sign-in cancelled');
  const state = await setDriveState({ enabled: true, lastError: '' });
  return { connected: true, state };
}

async function gdriveDisconnect() {
  // Pull whatever cached token we have so we can revoke it server-side.
  let token = null;
  try { token = await getAuthToken(false); } catch { /* not signed in */ }
  if (token) {
    await removeCachedAuthToken(token);
    // Best-effort revoke; ignore errors so we always reach the local cleanup.
    try {
      await fetch(`${GDRIVE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch { /* offline or revoke endpoint unavailable */ }
  }
  await stopAutoSync();
  // Reset the entire driveSync block so a future re-connect starts clean.
  const state = await setDriveState({
    enabled: false,
    autoSync: false,
    fileId: null,
    lastSyncAt: 0,
    lastSyncStatus: null,
    lastError: ''
  });
  return { connected: false, state };
}

async function gdriveStatus() {
  const configured = isGdriveConfigured();
  const state = await getDriveState();
  // When the build hasn't been wired to a real OAuth client yet, skip the
  // identity probe — it would fail noisily and slow down the UI for nothing.
  let signedIn = false;
  if (configured && state.enabled) {
    try {
      const token = await getAuthToken(false);
      signedIn = !!token;
    } catch {
      signedIn = false;
    }
  }
  return { ...state, configured, signedIn };
}

async function gdriveBackup() {
  try {
    const snapshot = await buildSnapshot();
    const json     = JSON.stringify(snapshot);
    const meta     = await uploadBackupFile(json);
    const state    = await setDriveState({
      fileId: meta.id || null,
      lastSyncAt: Date.now(),
      lastSyncStatus: 'ok',
      lastError: ''
    });
    return {
      success: true,
      bookmarks: snapshot.bookmarks.length,
      folders:   snapshot.folders.length,
      bytes:     json.length,
      state
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    await setDriveState({ lastSyncStatus: 'error', lastError: msg.slice(0, 500) });
    throw err;
  }
}

async function gdriveRestore() {
  const dl = await downloadBackupFile();
  if (!dl) {
    throw new Error('No TagMark backup found in your Google Drive');
  }
  if (dl.text.length > MAX_RESTORE_BYTES) {
    throw new Error('Backup file is too large to restore (>50 MB)');
  }
  let snapshot;
  try {
    snapshot = JSON.parse(dl.text);
  } catch {
    throw new Error('Backup file is not valid JSON');
  }
  const counts = await applySnapshot(snapshot);
  await setDriveState({
    fileId: dl.fileId,
    lastSyncAt: Date.now(),
    lastSyncStatus: 'ok',
    lastError: ''
  });
  notifyDashboard('bookmarks-imported');
  notifyDashboard('folders-updated');
  return { success: true, ...counts };
}

// ── Auto-sync ────────────────────────────────────────────────────────────────

async function startAutoSync() {
  if (!chrome.alarms) return;
  await new Promise(r => chrome.alarms.create(GDRIVE_AUTO_ALARM, {
    periodInMinutes: GDRIVE_AUTO_PERIOD,
    delayInMinutes:  GDRIVE_AUTO_PERIOD
  }, r));
  await setDriveState({ autoSync: true });
}

async function stopAutoSync() {
  if (!chrome.alarms) return;
  await new Promise(r => chrome.alarms.clear(GDRIVE_AUTO_ALARM, () => r()));
  await setDriveState({ autoSync: false });
}

async function gdriveSetAutoSync(enabled) {
  if (enabled) await startAutoSync(); else await stopAutoSync();
  return await getDriveState();
}

// Service worker may be torn down between alarms; rewire the listener on every
// startup so periodic backups still fire after Chrome wakes the worker.
if (chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener) {
  chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name !== GDRIVE_AUTO_ALARM) return;
    try {
      await gdriveBackup();
    } catch (err) {
      console.warn('[TagMark] auto-backup failed:', err && err.message);
    }
  });
}
