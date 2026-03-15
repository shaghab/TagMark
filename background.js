// TagMark Background Service Worker
// Handles context menus, sync, and cross-tab communication

const STORAGE_KEY  = 'tagmark_bookmarks'; // legacy — kept only for one-time migration
const SETTINGS_KEY = 'tagmark_settings';
const INDEX_KEY    = 'tagmark_index';     // ordered array of bookmark IDs
const BM_PREFIX    = 'tagmark_bm_';      // per-bookmark key: tagmark_bm_<id>
const FOLDERS_KEY  = 'tagmark_folders';  // array of folder objects

const MAX_FOLDER_NAME_LEN = 100;

const DEFAULT_FOLDER_NAMES = ['Work', 'Personal', 'Learning', 'Entertainment', 'News & Reading', 'Shopping'];

// ── Context Menu Setup ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'tagmark-save-page',
    title: 'Save to TagMark',
    contexts: ['page']
  });

  chrome.contextMenus.create({
    id: 'tagmark-save-link',
    title: 'Save link to TagMark',
    contexts: ['link']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url, title, favIconUrl;

  if (info.menuItemId === 'tagmark-save-link') {
    url = info.linkUrl;
    title = info.linkText || url;
    favIconUrl = '';
  } else {
    url = tab.url;
    title = tab.title;
    favIconUrl = tab.favIconUrl || '';
  }

  if (!isValidUrl(url)) {
    return;
  }

  try {
    await saveBookmark({ url, title, favIconUrl, tags: [], notes: '', pinned: false });
  } catch (err) {
    console.error('[TagMark] context menu save failed:', err);
    return;
  }

  // Notify any open dashboard tabs
  notifyDashboard('bookmark-added');

  // Show badge briefly
  chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId: tab.id });
  }, 2000);
});

// ── URL Validation ───────────────────────────────────────────────────────────

const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'file:'];

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_URL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ── Storage Helpers ─────────────────────────────────────────────────────────
//
// Bookmarks are stored as individual keys (tagmark_bm_<id>) rather than a
// single array so that no single chrome.storage.sync entry exceeds the 8 KB
// per-item limit that would silently prevent cross-device sync.
//
// Storage layout:
//   tagmark_index          → string[]   ordered list of bookmark IDs
//   tagmark_bm_<id>        → Bookmark   one key per bookmark
//   tagmark_settings       → Settings   unchanged

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.sync.get(keys, resolve));
}

function storageSet(items) {
  return new Promise(resolve => chrome.storage.sync.set(items, resolve));
}

function storageRemove(keys) {
  return new Promise(resolve => chrome.storage.sync.remove(keys, resolve));
}

// ── Folder Storage Helpers ───────────────────────────────────────────────────

async function getFolders() {
  const result = await storageGet([FOLDERS_KEY]);
  if (!Array.isArray(result[FOLDERS_KEY])) {
    // First run — seed default folders
    const now = Date.now();
    const folders = DEFAULT_FOLDER_NAMES.map(name => ({
      id: generateId(),
      name,
      parentId: null,
      createdAt: now
    }));
    await storageSet({ [FOLDERS_KEY]: folders });
    return folders;
  }
  return result[FOLDERS_KEY];
}

async function saveFolders(folders) {
  await storageSet({ [FOLDERS_KEY]: folders });
}

async function getBookmarks() {
  const result = await storageGet([INDEX_KEY]);
  const ids = result[INDEX_KEY];

  // No index yet — either fresh install or pre-sharding data that needs migration.
  if (!Array.isArray(ids)) {
    return migrateLegacyStorage();
  }

  if (ids.length === 0) return [];

  const bmKeys = ids.map(id => BM_PREFIX + id);
  const bmResult = await storageGet(bmKeys);
  // Preserve ordering from index; skip any entries missing from storage.
  // Re-inflate compacted bookmarks with default values for omitted fields so
  // callers always receive a fully-shaped object.
  return ids
    .map(id => bmResult[BM_PREFIX + id])
    .filter(Boolean)
    .map(bm => ({
      tags: [],
      notes: '',
      pinned: false,
      folderId: null,
      gtdStatus: null,
      contentType: null,
      urgency: null,
      importance: null,
      ...bm
    }));
}

// Strip fields whose value is null, undefined, false, or empty string before
// writing to storage — missing key and null are equivalent on read, so this
// saves ~40–50 bytes per bookmark with no data loss.
function compactBookmark(bm) {
  const out = {};
  for (const [k, v] of Object.entries(bm)) {
    if (v !== null && v !== undefined && v !== false && v !== '') {
      // Keep non-empty arrays; skip empty ones (e.g. tags: [])
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
  }
  return out;
}

async function saveBookmarks(bookmarks) {
  // Find IDs that are being removed so their individual keys can be deleted.
  const { [INDEX_KEY]: currentIds = [] } = await storageGet([INDEX_KEY]);
  const newIdSet = new Set(bookmarks.map(b => b.id));
  const removedKeys = currentIds
    .filter(id => !newIdSet.has(id))
    .map(id => BM_PREFIX + id);

  const toSet = { [INDEX_KEY]: bookmarks.map(b => b.id) };
  for (const bm of bookmarks) {
    toSet[BM_PREFIX + bm.id] = compactBookmark(bm);
  }

  if (removedKeys.length > 0) await storageRemove(removedKeys);
  await storageSet(toSet);
}

// One-time migration: move the old monolithic tagmark_bookmarks array into the
// new per-bookmark key layout and delete the legacy key.
async function migrateLegacyStorage() {
  const result = await storageGet([STORAGE_KEY]);
  const bookmarks = result[STORAGE_KEY];

  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    // Fresh install — just initialise an empty index.
    await storageSet({ [INDEX_KEY]: [] });
    return [];
  }

  const toSet = { [INDEX_KEY]: bookmarks.map(b => b.id) };
  for (const bm of bookmarks) {
    toSet[BM_PREFIX + bm.id] = bm;
  }
  await storageSet(toSet);
  await storageRemove([STORAGE_KEY]);

  console.log(`[TagMark] migrated ${bookmarks.length} bookmarks to sharded storage`);
  return bookmarks;
}

async function saveBookmark(bookmark) {
  if (!isValidUrl(bookmark.url)) {
    throw new Error('Invalid URL scheme');
  }

  const bookmarks = await getBookmarks();

  // Check for duplicate URL
  const existingIndex = bookmarks.findIndex(b => b.url === bookmark.url);

  // Enforce field-length limits so a tab with an unusually long title or
  // a bulk-programmatic caller cannot bloat chrome.storage.sync (A08).
  const rawTags = Array.isArray(bookmark.tags) ? bookmark.tags : [];
  const newBookmark = {
    id: existingIndex >= 0 ? bookmarks[existingIndex].id : generateId(),
    url: bookmark.url.slice(0, MAX_URL_LEN),
    title: (typeof bookmark.title === 'string' ? bookmark.title : bookmark.url).slice(0, MAX_TITLE_LEN) || bookmark.url,
    favIconUrl: sanitizeFavIconUrl(bookmark.favIconUrl),
    tags: rawTags
      .filter(t => typeof t === 'string')
      .map(t => t.trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_TAG_LEN))
      .filter(t => t.length > 0)
      .slice(0, MAX_TAGS),
    notes: (typeof bookmark.notes === 'string' ? bookmark.notes : '').slice(0, MAX_NOTES_LEN),
    pinned: Boolean(bookmark.pinned),
    folderId: typeof bookmark.folderId === 'string' && bookmark.folderId ? bookmark.folderId : null,
    gtdStatus:   GTD_STATUSES.includes(bookmark.gtdStatus)    ? bookmark.gtdStatus   : (existingIndex >= 0 ? (bookmarks[existingIndex].gtdStatus   || null) : null),
    contentType: CONTENT_TYPES.includes(bookmark.contentType) ? bookmark.contentType : (existingIndex >= 0 ? (bookmarks[existingIndex].contentType || null) : null),
    urgency:    PRIORITY_LEVELS.includes(bookmark.urgency)    ? bookmark.urgency    : (existingIndex >= 0 ? (bookmarks[existingIndex].urgency    || null) : null),
    importance: PRIORITY_LEVELS.includes(bookmark.importance) ? bookmark.importance : (existingIndex >= 0 ? (bookmarks[existingIndex].importance || null) : null),
    createdAt: existingIndex >= 0 ? bookmarks[existingIndex].createdAt : Date.now(),
    updatedAt: Date.now()
  };

  if (existingIndex >= 0) {
    bookmarks[existingIndex] = newBookmark;
  } else {
    bookmarks.unshift(newBookmark);
  }

  await saveBookmarks(bookmarks);
  return newBookmark;
}

function generateId() {
  // Use CSPRNG instead of Math.random() to prevent ID prediction (A02).
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return Date.now().toString(36) + buf[0].toString(36) + buf[1].toString(36);
}

function notifyDashboard(action) {
  // Match only tabs showing this extension's own dashboard page.
  // A loose .includes() check would also match web pages whose URL
  // happens to contain 'dashboard.html' (A01 – Broken Access Control).
  const dashboardUrl = chrome.runtime.getURL('dashboard.html');
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && tab.url.startsWith(dashboardUrl)) {
        chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
      }
    });
  });
}

// ── Import Sanitizer ────────────────────────────────────────────────────────

const MAX_TITLE_LEN  = 2000;
const MAX_URL_LEN    = 2048;
const MAX_NOTES_LEN  = 10000;
const MAX_TAG_LEN    = 100;
const MAX_TAGS       = 50;

const GTD_STATUSES  = ['next', 'later', 'someday', 'waiting', 'done', 'archived', 'dropped', 'reference'];
const CONTENT_TYPES = ['read', 'watch', 'listen', 'learn', 'try', 'create', 'build'];

const PRIORITY_LEVELS = ['critical', 'high', 'medium', 'low', 'none'];

// Allow only http/https favicon URLs (A03 – Injection).
// data: URIs are rejected to keep chrome.storage.sync usage low — favicons
// are re-fetched from Google's favicon service at render time when missing.
function sanitizeFavIconUrl(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().slice(0, MAX_URL_LEN);
  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:'].includes(parsed.protocol) ? trimmed : '';
  } catch {
    return '';
  }
}

function sanitizeBookmark(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const url = typeof raw.url === 'string' ? raw.url.trim().slice(0, MAX_URL_LEN) : '';
  if (!isValidUrl(url)) return null;

  const title = typeof raw.title === 'string'
    ? raw.title.trim().slice(0, MAX_TITLE_LEN)
    : url;

  const notes = typeof raw.notes === 'string'
    ? raw.notes.slice(0, MAX_NOTES_LEN)
    : '';

  const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
  const tags = rawTags
    .filter(t => typeof t === 'string')
    .map(t => t.trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_TAG_LEN))
    .filter(t => t.length > 0)
    .slice(0, MAX_TAGS);

  const pinned  = Boolean(raw.pinned);
  const now     = Date.now();
  const createdAt = typeof raw.createdAt === 'number' && raw.createdAt > 0
    ? raw.createdAt
    : now;
  const updatedAt = typeof raw.updatedAt === 'number' && raw.updatedAt > 0
    ? raw.updatedAt
    : now;

  return {
    id:         generateId(),
    url,
    title,
    favIconUrl: sanitizeFavIconUrl(raw.favIconUrl),
    tags,
    notes,
    pinned,
    folderId:    typeof raw.folderId === 'string' && raw.folderId ? raw.folderId : null,
    gtdStatus:   GTD_STATUSES.includes(raw.gtdStatus)    ? raw.gtdStatus   : null,
    contentType: CONTENT_TYPES.includes(raw.contentType) ? raw.contentType : null,
    urgency:     PRIORITY_LEVELS.includes(raw.urgency)    ? raw.urgency    : null,
    importance:  PRIORITY_LEVELS.includes(raw.importance) ? raw.importance : null,
    createdAt,
    updatedAt
  };
}

// ── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages originating from this extension's own pages.
  // Rejects messages from web pages, foreign extensions, and content scripts
  // that are not part of TagMark (A01 – Broken Access Control).
  if (sender.id !== chrome.runtime.id) return;

  handleMessage(message).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(message) {
  switch (message.action) {
    case 'get-bookmarks':
      return await getBookmarks();

    case 'save-bookmark':
      return await saveBookmark(message.bookmark);

    case 'delete-bookmark': {
      const bookmarks = await getBookmarks();
      const filtered = bookmarks.filter(b => b.id !== message.id);
      await saveBookmarks(filtered);
      notifyDashboard('bookmark-deleted');
      return { success: true };
    }

    case 'update-bookmark': {
      const incoming = message.bookmark;
      if (incoming.url && !isValidUrl(incoming.url)) {
        return { error: 'Invalid URL scheme' };
      }
      const bookmarks = await getBookmarks();
      const idx = bookmarks.findIndex(b => b.id === incoming.id);
      if (idx >= 0) {
        const existing = bookmarks[idx];
        // Only allow explicit mutable fields to be updated (A08).
        // Spreading message.bookmark directly would let a caller overwrite
        // immutable fields like id and createdAt.
        const rawTags = Array.isArray(incoming.tags) ? incoming.tags : existing.tags;
        bookmarks[idx] = {
          ...existing,
          title: typeof incoming.title === 'string'
            ? incoming.title.trim().slice(0, MAX_TITLE_LEN) || existing.url
            : existing.title,
          url: incoming.url
            ? incoming.url.slice(0, MAX_URL_LEN)
            : existing.url,
          notes: typeof incoming.notes === 'string'
            ? incoming.notes.slice(0, MAX_NOTES_LEN)
            : existing.notes,
          tags: rawTags
            .filter(t => typeof t === 'string')
            .map(t => t.trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_TAG_LEN))
            .filter(t => t.length > 0)
            .slice(0, MAX_TAGS),
          pinned: typeof incoming.pinned === 'boolean' ? incoming.pinned : existing.pinned,
          folderId: typeof incoming.folderId !== 'undefined'
            ? (typeof incoming.folderId === 'string' && incoming.folderId ? incoming.folderId : null)
            : (existing.folderId || null),
          gtdStatus: typeof incoming.gtdStatus !== 'undefined'
            ? (GTD_STATUSES.includes(incoming.gtdStatus) ? incoming.gtdStatus : null)
            : (existing.gtdStatus || null),
          contentType: typeof incoming.contentType !== 'undefined'
            ? (CONTENT_TYPES.includes(incoming.contentType) ? incoming.contentType : null)
            : (existing.contentType || null),
          urgency: typeof incoming.urgency !== 'undefined'
            ? (PRIORITY_LEVELS.includes(incoming.urgency) ? incoming.urgency : null)
            : (existing.urgency || null),
          importance: typeof incoming.importance !== 'undefined'
            ? (PRIORITY_LEVELS.includes(incoming.importance) ? incoming.importance : null)
            : (existing.importance || null),
          updatedAt: Date.now()
        };
        await saveBookmarks(bookmarks);
        notifyDashboard('bookmark-updated');
      }
      return { success: true };
    }

    case 'toggle-pin': {
      const bookmarks = await getBookmarks();
      const idx = bookmarks.findIndex(b => b.id === message.id);
      if (idx >= 0) {
        bookmarks[idx].pinned = !bookmarks[idx].pinned;
        bookmarks[idx].updatedAt = Date.now();
        await saveBookmarks(bookmarks);
        notifyDashboard('bookmark-updated');
        return { pinned: bookmarks[idx].pinned };
      }
      return { success: false };
    }

    case 'get-folders':
      return await getFolders();

    case 'create-folder': {
      const folders = await getFolders();
      // Strip HTML metacharacters at storage time so folder names can never
      // carry injection payloads regardless of how they are rendered (A03).
      const name = typeof message.name === 'string'
        ? message.name.trim().replace(/[<>"'`]/g, '').slice(0, MAX_FOLDER_NAME_LEN)
        : '';
      if (!name) return { error: 'Invalid folder name' };
      const parentId = typeof message.parentId === 'string' && message.parentId ? message.parentId : null;
      if (parentId && !folders.find(f => f.id === parentId)) return { error: 'Parent folder not found' };
      const folder = { id: generateId(), name, parentId, createdAt: Date.now() };
      folders.push(folder);
      await saveFolders(folders);
      notifyDashboard('folders-updated');
      return folder;
    }

    case 'update-folder': {
      const folders = await getFolders();
      const idx = folders.findIndex(f => f.id === message.id);
      if (idx < 0) return { error: 'Folder not found' };
      const name = typeof message.name === 'string'
        ? message.name.trim().replace(/[<>"'`]/g, '').slice(0, MAX_FOLDER_NAME_LEN)
        : '';
      if (!name) return { error: 'Invalid folder name' };
      folders[idx] = { ...folders[idx], name };
      await saveFolders(folders);
      notifyDashboard('folders-updated');
      return { success: true };
    }

    case 'delete-folder': {
      const folders = await getFolders();
      const toDelete = new Set();
      const collectDescendants = id => {
        toDelete.add(id);
        folders.filter(f => f.parentId === id).forEach(f => collectDescendants(f.id));
      };
      collectDescendants(message.id);
      await saveFolders(folders.filter(f => !toDelete.has(f.id)));
      // Unassign bookmarks from deleted folders
      const bookmarks = await getBookmarks();
      let changed = false;
      bookmarks.forEach(b => {
        if (b.folderId && toDelete.has(b.folderId)) {
          b.folderId = null;
          b.updatedAt = Date.now();
          changed = true;
        }
      });
      if (changed) await saveBookmarks(bookmarks);
      notifyDashboard('folders-updated');
      if (changed) notifyDashboard('bookmark-updated');
      return { success: true };
    }

    case 'get-all-tags': {
      const bookmarks = await getBookmarks();
      const tagSet = new Set();
      bookmarks.forEach(b => b.tags.forEach(t => tagSet.add(t)));
      return Array.from(tagSet).sort();
    }

    case 'import-bookmarks': {
      const existing = await getBookmarks();
      const toImport = Array.isArray(message.bookmarks) ? message.bookmarks : [];
      const merged = [...existing];
      let imported = 0;
      for (const raw of toImport) {
        const b = sanitizeBookmark(raw);
        if (!b) continue; // skip invalid entries
        const idx = merged.findIndex(e => e.url === b.url);
        if (idx >= 0) {
          merged[idx] = { ...merged[idx], ...b, id: merged[idx].id };
        } else {
          merged.push(b);
        }
        imported++;
      }
      await saveBookmarks(merged);
      notifyDashboard('bookmarks-imported');
      return { count: imported };
    }

    case 'export-bookmarks':
      return await getBookmarks();

    case 'get-settings': {
      return new Promise(resolve => {
        chrome.storage.sync.get([SETTINGS_KEY], r => resolve(r[SETTINGS_KEY] || { theme: 'light' }));
      });
    }

    case 'save-settings': {
      // Only persist recognised theme values; reject arbitrary objects (A08).
      const VALID_THEMES = ['light', 'dark'];
      const theme = message.settings && VALID_THEMES.includes(message.settings.theme)
        ? message.settings.theme
        : 'light';
      return new Promise(resolve => {
        chrome.storage.sync.set({ [SETTINGS_KEY]: { theme } }, () => resolve({ success: true }));
      });
    }

    default:
      return { error: 'Unknown action' };
  }
}
