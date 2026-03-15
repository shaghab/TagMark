// TagMark Cloud Sync — Supabase REST client
// Loaded via importScripts() from background.js (service worker).
// No SDK; uses fetch() directly — avoids bundling and CSP issues.
// Service workers are NOT subject to the extension_pages CSP, so fetch()
// to external URLs works here even though connect-src is 'none' for HTML pages.

'use strict';

const SUPA_URL      = 'https://pnjowaiavznpjdhcddsf.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuam93YWlhdnpucGpkaGNkZHNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODg5NjYsImV4cCI6MjA4OTE2NDk2Nn0.yKi_j1wD9QzUeoSBrDvUJAO2c43Cay6CCX6nmqqmiIA';

const CLOUD_SESSION_KEY   = 'tagmark_cloud_session';
const CLOUD_LAST_SYNC_KEY = 'tagmark_cloud_last_sync';

// ── chrome.storage.local helpers (session is device-specific, not synced) ────

function localGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function localSet(items) {
  return new Promise(resolve => chrome.storage.local.set(items, resolve));
}

function localRemove(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

// ── Session management ────────────────────────────────────────────────────────

async function cloudGetSession() {
  const result = await localGet([CLOUD_SESSION_KEY]);
  return result[CLOUD_SESSION_KEY] || null;
}

async function cloudSaveSession(session) {
  await localSet({ [CLOUD_SESSION_KEY]: session });
}

async function cloudClearSession() {
  await localRemove([CLOUD_SESSION_KEY, CLOUD_LAST_SYNC_KEY]);
}

async function cloudGetLastSync() {
  const result = await localGet([CLOUD_LAST_SYNC_KEY]);
  return result[CLOUD_LAST_SYNC_KEY] || 0;
}

async function cloudSetLastSync(ts) {
  await localSet({ [CLOUD_LAST_SYNC_KEY]: ts });
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64urlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64urlEncode(digest);
  return { codeVerifier, codeChallenge };
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function cloudRefreshToken(refreshToken) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPA_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!res.ok) throw new Error('Token refresh failed');
  return res.json();
}

// Returns a valid access token, refreshing silently if within 60 s of expiry.
async function cloudGetValidToken() {
  const session = await cloudGetSession();
  if (!session) return null;

  if (Date.now() >= session.expires_at - 60_000) {
    try {
      const refreshed = await cloudRefreshToken(session.refresh_token);
      const updated = {
        ...session,
        access_token:  refreshed.access_token,
        refresh_token: refreshed.refresh_token || session.refresh_token,
        expires_at:    Date.now() + (refreshed.expires_in || 3600) * 1000
      };
      await cloudSaveSession(updated);
      return updated.access_token;
    } catch {
      await cloudClearSession();
      return null;
    }
  }

  return session.access_token;
}

// ── Sign in ───────────────────────────────────────────────────────────────────
//
// Uses PKCE + chrome.identity.launchWebAuthFlow (no popup / redirect page needed).
//
// Before this works you must add the extension's chromiumapp.org URL to
// Supabase → Authentication → URL Configuration → Redirect URLs:
//   https://<extension-id>.chromiumapp.org/
// Find your extension ID at chrome://extensions.

async function cloudSignIn() {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const redirectUrl = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const authUrl =
    `${SUPA_URL}/auth/v1/authorize?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectUrl)}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  const callbackUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, url => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(url);
      }
    });
  });

  if (!callbackUrl) throw new Error('Auth flow returned no URL');

  // Supabase PKCE redirects with ?code=<auth_code>
  const parsed = new URL(callbackUrl);
  const code   = parsed.searchParams.get('code');
  const errMsg = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
  if (errMsg) throw new Error(errMsg);
  if (!code)  throw new Error('No auth code in callback URL');

  // Exchange code + verifier for tokens
  const tokenRes = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPA_ANON_KEY },
    body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier })
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error(err.error_description || err.msg || 'Token exchange failed');
  }

  const data = await tokenRes.json();
  const session = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
    user: { id: data.user.id, email: data.user.email }
  };
  await cloudSaveSession(session);
  return session;
}

// ── Sign out ──────────────────────────────────────────────────────────────────

async function cloudSignOut() {
  const token = await cloudGetValidToken();
  if (token) {
    // Best-effort server-side session revocation — ignore errors
    fetch(`${SUPA_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { 'apikey': SUPA_ANON_KEY, 'Authorization': `Bearer ${token}` }
    }).catch(() => {});
  }
  await cloudClearSession();
}

// ── Low-level REST fetch ──────────────────────────────────────────────────────

async function sbFetch(path, opts = {}, token) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPA_ANON_KEY,
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...opts.headers
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Data mapping (TagMark camelCase ↔ Postgres snake_case) ───────────────────

function bookmarkToRow(bm, userId) {
  return {
    id:           bm.id,
    user_id:      userId,
    url:          bm.url,
    title:        bm.title        || '',
    fav_icon_url: bm.favIconUrl   || '',
    tags:         Array.isArray(bm.tags) ? bm.tags : [],
    notes:        bm.notes        || '',
    pinned:       Boolean(bm.pinned),
    folder_id:    bm.folderId     || null,
    gtd_status:   bm.gtdStatus    || null,
    content_type: bm.contentType  || null,
    urgency:      bm.urgency      || null,
    importance:   bm.importance   || null,
    created_at:   bm.createdAt    || Date.now(),
    updated_at:   bm.updatedAt    || Date.now()
  };
}

function rowToBookmark(row) {
  return {
    id:          row.id,
    url:         row.url,
    title:       row.title        || '',
    favIconUrl:  row.fav_icon_url || '',
    tags:        Array.isArray(row.tags) ? row.tags : [],
    notes:       row.notes        || '',
    pinned:      Boolean(row.pinned),
    folderId:    row.folder_id    || null,
    gtdStatus:   row.gtd_status   || null,
    contentType: row.content_type || null,
    urgency:     row.urgency      || null,
    importance:  row.importance   || null,
    createdAt:   row.created_at   || Date.now(),
    updatedAt:   row.updated_at   || Date.now()
  };
}

// ── Cloud bookmark operations ─────────────────────────────────────────────────

async function cloudUpsertBookmark(bm, token, userId) {
  await sbFetch('bookmarks?on_conflict=id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(bookmarkToRow(bm, userId))
  }, token);
}

async function cloudDeleteBookmark(id, token) {
  await sbFetch(`bookmarks?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }, token);
}

// Fetch all cloud bookmarks for this user (used for full sync).
async function cloudFetchAll(token) {
  const rows = await sbFetch('bookmarks?select=*&order=updated_at.asc', {
    method: 'GET'
  }, token);
  return (rows || []).map(rowToBookmark);
}

// Batch upsert — used on first sign-in to push all local bookmarks.
async function cloudPushAll(bookmarks, token, userId) {
  if (!bookmarks.length) return;
  await sbFetch('bookmarks?on_conflict=id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(bookmarks.map(bm => bookmarkToRow(bm, userId)))
  }, token);
}
