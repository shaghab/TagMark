// TagMark Background Service Worker
// Handles context menus, sync, and cross-tab communication
// Copyright (c) 2026 Asim Ghaffar (github.com/shaghab)

const STORAGE_KEY  = 'tagmark_bookmarks'; // legacy — kept only for one-time migration
const SETTINGS_KEY = 'tagmark_settings';
const INDEX_KEY    = 'tagmark_index';     // ordered array of bookmark IDs
const BM_PREFIX    = 'tagmark_bm_';      // per-bookmark key: tagmark_bm_<id>
const FOLDERS_KEY  = 'tagmark_folders';  // array of folder objects

const NOTE_INDEX_KEY = 'tagmark_index_note'; // ordered array of note IDs
const NOTE_PREFIX    = 'tagmark_note_';      // per-note key: tagmark_note_<id>
const TASK_INDEX_KEY  = 'tagmark_index_task'; // ordered array of task IDs
const TASK_PREFIX     = 'tagmark_task_';      // per-task key: tagmark_task_<id>

const TRASH_INDEX_KEY = 'tagmark_trash_index'; // ordered array of trash IDs
const TRASH_PREFIX    = 'tagmark_trash_';       // per-item key: tagmark_trash_<id>
const TRASH_MAX_ITEMS = 50;                     // cap to avoid quota exhaustion

const MAX_FOLDER_NAME_LEN = 100;
const MAX_CONTENT_LEN     = 5000;  // note content cap — chrome.storage.sync is 8 KB per item
const SYNC_ITEM_QUOTA     = 8192;  // chrome.storage.sync per-item byte limit

const DEFAULT_FOLDER_NAMES = ['Work', 'Personal', 'Learning', 'Entertainment', 'News & Reading', 'Shopping'];

// ── Toolbar Icon ─────────────────────────────────────────────────────────────

const DEFAULT_ICON_PATHS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png'
};

// Draws the TagMark icon at the given pixel size.
// bookmarked=true → green background (#22c55e); false → indigo (#6366f1).
function drawBookmarkIcon(size, bookmarked) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const s = size / 128;

  // Rounded-rect background
  const r = 28 * s;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.arcTo(size, 0, size, r, r);
  ctx.lineTo(size, size - r);
  ctx.arcTo(size, size, size - r, size, r);
  ctx.lineTo(r, size);
  ctx.arcTo(0, size, 0, size - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.fillStyle = bookmarked ? '#22c55e' : '#6366f1';
  ctx.fill();

  // Bookmark ribbon — mirrors the SVG path M84 24H44a8 8 … z
  ctx.beginPath();
  ctx.moveTo(84 * s, 24 * s);
  ctx.lineTo(44 * s, 24 * s);
  ctx.arcTo(36 * s, 24 * s, 36 * s, 32 * s, 8 * s);
  ctx.lineTo(36 * s, 100 * s);
  ctx.lineTo(64 * s, 82 * s);
  ctx.lineTo(92 * s, 100 * s);
  ctx.lineTo(92 * s, 32 * s);
  ctx.arcTo(92 * s, 24 * s, 84 * s, 24 * s, 8 * s);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();

  // Tag dot
  ctx.beginPath();
  ctx.arc(64 * s, 52 * s, 8 * s, 0, Math.PI * 2);
  ctx.fillStyle = bookmarked ? '#22c55e' : '#6366f1';
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

function setTabIcon(tabId, isBookmarked) {
  if (isBookmarked) {
    const imageData = {};
    for (const size of [16, 32, 48, 128]) {
      imageData[size] = drawBookmarkIcon(size, true);
    }
    chrome.action.setIcon({ tabId, imageData }).catch(() => {});
  } else {
    chrome.action.setIcon({ tabId, path: DEFAULT_ICON_PATHS }).catch(() => {});
  }
}

// After a bookmark is saved or deleted, update all open tabs at that URL.
async function refreshIconForUrl(url, isBookmarked) {
  if (!isValidUrl(url)) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url === url) {
      setTabIcon(tab.id, isBookmarked);
    }
  }
}

// When the user switches tabs or navigates, sync the icon to bookmark state.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !isValidUrl(tab.url)) return;
    const bookmarks = await getBookmarks();
    setTabIcon(tabId, bookmarks.some(b => b.url === tab.url));
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !isValidUrl(tab.url)) return;
  try {
    const bookmarks = await getBookmarks();
    setTabIcon(tabId, bookmarks.some(b => b.url === tab.url));
  } catch {}
});

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

  // Update toolbar icon for the saved tab
  setTabIcon(tab.id, true);

  // Show badge briefly
  chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId: tab.id });
  }, 2000);
});

// ── URL Validation ───────────────────────────────────────────────────────────

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

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
  return new Promise((resolve, reject) =>
    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    })
  );
}

function storageRemove(keys) {
  return new Promise((resolve, reject) =>
    chrome.storage.sync.remove(keys, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    })
  );
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
  if (typeof bookmark.url === 'string' && bookmark.url.length > MAX_URL_LEN) {
    throw new Error('URL exceeds maximum allowed length');
  }

  const bookmarks = await getBookmarks();

  // Check for duplicate URL
  const existingIndex = bookmarks.findIndex(b => b.url === bookmark.url);

  // Enforce field-length limits so a tab with an unusually long title or
  // a bulk-programmatic caller cannot bloat chrome.storage.sync (A08).
  const newBookmark = {
    id: existingIndex >= 0 ? bookmarks[existingIndex].id : generateId(),
    url: bookmark.url.slice(0, MAX_URL_LEN),
    title: (typeof bookmark.title === 'string' ? bookmark.title : bookmark.url).slice(0, MAX_TITLE_LEN) || bookmark.url,
    favIconUrl: sanitizeFavIconUrl(bookmark.favIconUrl),
    tags: normalizeTags(bookmark.tags),
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

// Returns the byte size chrome.storage.sync will charge for one key-value pair.
// Chrome measures: key.length + JSON.stringify(value).length (in chars, not UTF-8 bytes).
function syncItemSize(key, value) {
  return key.length + JSON.stringify(value).length;
}

// ── Note Storage Helpers ────────────────────────────────────────────────────

async function getNotes() {
  const result = await storageGet([NOTE_INDEX_KEY]);
  const ids = result[NOTE_INDEX_KEY];
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const noteKeys = ids.map(id => NOTE_PREFIX + id);
  const noteResult = await storageGet(noteKeys);
  return ids
    .map(id => noteResult[NOTE_PREFIX + id])
    .filter(Boolean)
    .map(note => ({ tags: [], content: '', pinned: false, folderId: null, ...note }));
}

async function saveNote(note) {
  const result = await storageGet([NOTE_INDEX_KEY]);
  const ids = Array.isArray(result[NOTE_INDEX_KEY]) ? result[NOTE_INDEX_KEY] : [];
  const content = typeof note.content === 'string' ? note.content : '';
  if (content.length > MAX_CONTENT_LEN) {
    throw new Error(`Note content exceeds the ${MAX_CONTENT_LEN}-character limit.`);
  }
  const newNote = {
    id: generateId(),
    title: (typeof note.title === 'string' ? note.title.trim() : '').slice(0, MAX_TITLE_LEN) || 'Untitled',
    content,
    tags: normalizeTags(note.tags),
    pinned: Boolean(note.pinned),
    folderId: typeof note.folderId === 'string' && note.folderId ? note.folderId : null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const noteKey = NOTE_PREFIX + newNote.id;
  const packed  = compactBookmark(newNote);
  if (syncItemSize(noteKey, packed) > SYNC_ITEM_QUOTA) {
    throw new Error('Note is too long to sync. Please shorten the content or title.');
  }
  await storageSet({ [NOTE_INDEX_KEY]: [newNote.id, ...ids], [noteKey]: packed });
  return newNote;
}

async function updateNote(incoming) {
  const noteKey = NOTE_PREFIX + incoming.id;
  const result = await storageGet([NOTE_INDEX_KEY, noteKey]);
  const ids = Array.isArray(result[NOTE_INDEX_KEY]) ? result[NOTE_INDEX_KEY] : [];
  if (!ids.includes(incoming.id)) return { success: false };
  const existing = result[noteKey] || {};
  const updated = {
    ...existing,
    title: typeof incoming.title === 'string'
      ? incoming.title.trim().slice(0, MAX_TITLE_LEN) || existing.title || 'Untitled'
      : (existing.title || 'Untitled'),
    content: (() => {
      const c = typeof incoming.content === 'string' ? incoming.content : (existing.content || '');
      if (c.length > MAX_CONTENT_LEN) throw new Error(`Note content exceeds the ${MAX_CONTENT_LEN}-character limit.`);
      return c;
    })(),
    tags: normalizeTags(Array.isArray(incoming.tags) ? incoming.tags : (existing.tags || [])),
    pinned: typeof incoming.pinned === 'boolean' ? incoming.pinned : Boolean(existing.pinned),
    folderId: typeof incoming.folderId !== 'undefined'
      ? (typeof incoming.folderId === 'string' && incoming.folderId ? incoming.folderId : null)
      : (existing.folderId || null),
    updatedAt: Date.now()
  };
  const packed = compactBookmark(updated);
  if (syncItemSize(noteKey, packed) > SYNC_ITEM_QUOTA) {
    throw new Error('Note is too long to sync. Please shorten the content or title.');
  }
  await storageSet({ [noteKey]: packed });
  return { success: true };
}

async function deleteNoteById(id) {
  const result = await storageGet([NOTE_INDEX_KEY]);
  const ids = Array.isArray(result[NOTE_INDEX_KEY]) ? result[NOTE_INDEX_KEY] : [];
  await storageSet({ [NOTE_INDEX_KEY]: ids.filter(i => i !== id) });
  await storageRemove([NOTE_PREFIX + id]);
  return { success: true };
}

// ── Task Storage Helpers ────────────────────────────────────────────────────

async function getTasks() {
  const result = await storageGet([TASK_INDEX_KEY]);
  const ids = result[TASK_INDEX_KEY];
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const taskKeys = ids.map(id => TASK_PREFIX + id);
  const taskResult = await storageGet(taskKeys);
  return ids
    .map(id => taskResult[TASK_PREFIX + id])
    .filter(Boolean)
    .map(task => ({
      tags: [], notes: '', pinned: false, folderId: null,
      gtdStatus: null, urgency: null, importance: null,
      ...task
    }));
}

async function saveTask(task) {
  const result = await storageGet([TASK_INDEX_KEY]);
  const ids = Array.isArray(result[TASK_INDEX_KEY]) ? result[TASK_INDEX_KEY] : [];
  const notes = typeof task.notes === 'string' ? task.notes : '';
  if (notes.length > MAX_NOTES_LEN) {
    throw new Error(`Task notes exceed the ${MAX_NOTES_LEN}-character limit.`);
  }
  const newTask = {
    id: generateId(),
    title: (typeof task.title === 'string' ? task.title.trim() : '').slice(0, MAX_TITLE_LEN) || 'Untitled',
    notes,
    tags: normalizeTags(task.tags),
    pinned: Boolean(task.pinned),
    folderId: typeof task.folderId === 'string' && task.folderId ? task.folderId : null,
    gtdStatus:   GTD_STATUSES.includes(task.gtdStatus)    ? task.gtdStatus   : null,
    urgency:     PRIORITY_LEVELS.includes(task.urgency)    ? task.urgency    : null,
    importance:  PRIORITY_LEVELS.includes(task.importance) ? task.importance : null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const taskKey = TASK_PREFIX + newTask.id;
  const packed  = compactBookmark(newTask);
  if (syncItemSize(taskKey, packed) > SYNC_ITEM_QUOTA) {
    throw new Error('Task is too long to sync. Please shorten the notes or title.');
  }
  await storageSet({ [TASK_INDEX_KEY]: [newTask.id, ...ids], [taskKey]: packed });
  return newTask;
}

async function updateTask(incoming) {
  const taskKey = TASK_PREFIX + incoming.id;
  const result = await storageGet([TASK_INDEX_KEY, taskKey]);
  const ids = Array.isArray(result[TASK_INDEX_KEY]) ? result[TASK_INDEX_KEY] : [];
  if (!ids.includes(incoming.id)) return { success: false };
  const existing = result[taskKey] || {};
  const updated = {
    ...existing,
    title: typeof incoming.title === 'string'
      ? incoming.title.trim().slice(0, MAX_TITLE_LEN) || existing.title || 'Untitled'
      : (existing.title || 'Untitled'),
    notes: (() => {
      const n = typeof incoming.notes === 'string' ? incoming.notes : (existing.notes || '');
      if (n.length > MAX_NOTES_LEN) throw new Error(`Task notes exceed the ${MAX_NOTES_LEN}-character limit.`);
      return n;
    })(),
    tags: normalizeTags(Array.isArray(incoming.tags) ? incoming.tags : (existing.tags || [])),
    pinned: typeof incoming.pinned === 'boolean' ? incoming.pinned : Boolean(existing.pinned),
    folderId: typeof incoming.folderId !== 'undefined'
      ? (typeof incoming.folderId === 'string' && incoming.folderId ? incoming.folderId : null)
      : (existing.folderId || null),
    gtdStatus: typeof incoming.gtdStatus !== 'undefined'
      ? (GTD_STATUSES.includes(incoming.gtdStatus) ? incoming.gtdStatus : null)
      : (existing.gtdStatus || null),
    urgency: typeof incoming.urgency !== 'undefined'
      ? (PRIORITY_LEVELS.includes(incoming.urgency) ? incoming.urgency : null)
      : (existing.urgency || null),
    importance: typeof incoming.importance !== 'undefined'
      ? (PRIORITY_LEVELS.includes(incoming.importance) ? incoming.importance : null)
      : (existing.importance || null),
    updatedAt: Date.now()
  };
  const packed = compactBookmark(updated);
  if (syncItemSize(taskKey, packed) > SYNC_ITEM_QUOTA) {
    throw new Error('Task is too long to sync. Please shorten the notes or title.');
  }
  await storageSet({ [taskKey]: packed });
  return { success: true };
}

async function deleteTaskById(id) {
  const result = await storageGet([TASK_INDEX_KEY]);
  const ids = Array.isArray(result[TASK_INDEX_KEY]) ? result[TASK_INDEX_KEY] : [];
  await storageSet({ [TASK_INDEX_KEY]: ids.filter(i => i !== id) });
  await storageRemove([TASK_PREFIX + id]);
  return { success: true };
}

// ── Trash Storage Helpers ───────────────────────────────────────────────────
//
// Layout: TRASH_INDEX_KEY holds an array of { trashId, type, deletedAt }
// objects (metadata only). The raw item data is stored under TRASH_PREFIX +
// trashId with no extra wrapper, so items that were already near the 8 KB
// per-key limit are not pushed over it by trash metadata overhead.

async function getTrashItems() {
  const result = await storageGet([TRASH_INDEX_KEY]);
  const index = result[TRASH_INDEX_KEY];
  if (!Array.isArray(index) || index.length === 0) return [];
  const trashKeys = index.map(e => TRASH_PREFIX + e.trashId);
  const dataResult = await storageGet(trashKeys);
  return index
    .map(e => {
      const data = dataResult[TRASH_PREFIX + e.trashId];
      return data ? { trashId: e.trashId, type: e.type, deletedAt: e.deletedAt, data } : null;
    })
    .filter(Boolean);
}

async function addToTrash(type, item) {
  const result = await storageGet([TRASH_INDEX_KEY]);
  let index = Array.isArray(result[TRASH_INDEX_KEY]) ? result[TRASH_INDEX_KEY] : [];

  // Enforce max size — drop the oldest entries (at end of array) first.
  if (index.length >= TRASH_MAX_ITEMS) {
    const dropped = index.splice(TRASH_MAX_ITEMS - 1);
    await storageRemove(dropped.map(e => TRASH_PREFIX + e.trashId));
  }

  const trashId = generateId();
  const entry = { trashId, type, deletedAt: Date.now() };
  index = [entry, ...index];
  // Store metadata in the index; store only the raw item data under the
  // per-key so the trash copy is never larger than the original.
  await storageSet({ [TRASH_INDEX_KEY]: index, [TRASH_PREFIX + trashId]: item });
  return entry;
}

async function removeFromTrash(trashId) {
  const result = await storageGet([TRASH_INDEX_KEY]);
  const index = Array.isArray(result[TRASH_INDEX_KEY]) ? result[TRASH_INDEX_KEY] : [];
  await storageSet({ [TRASH_INDEX_KEY]: index.filter(e => e.trashId !== trashId) });
  await storageRemove([TRASH_PREFIX + trashId]);
}

function generateId() {
  // Use CSPRNG instead of Math.random() to prevent ID prediction (A02).
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return Date.now().toString(36) + buf[0].toString(36) + buf[1].toString(36);
}

async function notifyDashboard(action) {
  // Match only tabs showing this extension's own dashboard page.
  // A loose .includes() check would also match web pages whose URL
  // happens to contain 'dashboard.html' (A01 – Broken Access Control).
  const dashboardUrl = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({});
  tabs.forEach(tab => {
    if (tab.url && tab.url.startsWith(dashboardUrl)) {
      chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
    }
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

// Normalise a raw tags array: type-check, trim, lowercase, hyphenate spaces,
// truncate each tag, drop empties, and cap the count. Used in saveBookmark,
// sanitizeBookmark, and update-bookmark so the logic stays in one place.
function normalizeTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .filter(t => typeof t === 'string')
    .map(t => t.trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_TAG_LEN))
    .filter(t => t.length > 0)
    .slice(0, MAX_TAGS);
}

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

  const tags = normalizeTags(raw.tags);

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
    console.error('[TagMark] message handler error:', err);
    sendResponse({ error: 'An error occurred. Please try again.' });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(message) {
  switch (message.action) {
    case 'get-bookmarks':
      return await getBookmarks();

    case 'save-bookmark': {
      const saved = await saveBookmark(message.bookmark);
      await refreshIconForUrl(saved.url, true);
      return saved;
    }

    case 'delete-bookmark': {
      const bookmarks = await getBookmarks();
      const bm = bookmarks.find(b => b.id === message.id);
      if (!bm) return { success: false };
      // Write to Trash before removing from the main list so a quota-exceeded
      // error on the trash write leaves the original bookmark intact.
      const trashEntry = await addToTrash('bookmark', bm);
      try {
        const filtered = bookmarks.filter(b => b.id !== message.id);
        await saveBookmarks(filtered);
      } catch (err) {
        // Roll back the trash entry so the user is not left with a duplicate.
        await removeFromTrash(trashEntry.trashId).catch(() => {});
        throw err;
      }
      notifyDashboard('bookmark-deleted');
      if (bm.url) await refreshIconForUrl(bm.url, false);
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
          tags: normalizeTags(Array.isArray(incoming.tags) ? incoming.tags : existing.tags),
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
      const now = Date.now();
      // Unassign bookmarks from deleted folders
      const bookmarks = await getBookmarks();
      let bmChanged = false;
      bookmarks.forEach(b => {
        if (b.folderId && toDelete.has(b.folderId)) { b.folderId = null; b.updatedAt = now; bmChanged = true; }
      });
      if (bmChanged) await saveBookmarks(bookmarks);
      // Unassign notes from deleted folders
      const notes = await getNotes();
      const noteUpdates = {};
      notes.forEach(note => {
        if (note.folderId && toDelete.has(note.folderId)) {
          noteUpdates[NOTE_PREFIX + note.id] = compactBookmark({ ...note, folderId: null, updatedAt: now });
        }
      });
      if (Object.keys(noteUpdates).length) await storageSet(noteUpdates);
      // Unassign tasks from deleted folders
      const tasks = await getTasks();
      const taskUpdates = {};
      tasks.forEach(task => {
        if (task.folderId && toDelete.has(task.folderId)) {
          taskUpdates[TASK_PREFIX + task.id] = compactBookmark({ ...task, folderId: null, updatedAt: now });
        }
      });
      if (Object.keys(taskUpdates).length) await storageSet(taskUpdates);
      notifyDashboard('folders-updated');
      return { success: true };
    }

    case 'get-all-tags': {
      const [bookmarks, notes, tasks] = await Promise.all([getBookmarks(), getNotes(), getTasks()]);
      const tagSet = new Set();
      [...bookmarks, ...notes, ...tasks].forEach(item => (item.tags || []).forEach(t => tagSet.add(t)));
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
          merged[idx] = { ...merged[idx], ...b, id: merged[idx].id, createdAt: merged[idx].createdAt };
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

    case 'get-notes':
      return await getNotes();

    case 'save-note': {
      try {
        const saved = await saveNote(message.note);
        notifyDashboard('note-added');
        return saved;
      } catch (err) {
        return { error: err.message || 'Failed to save note.' };
      }
    }

    case 'update-note': {
      try {
        const result = await updateNote(message.note);
        notifyDashboard('note-updated');
        return result;
      } catch (err) {
        return { error: err.message || 'Failed to update note.' };
      }
    }

    case 'delete-note': {
      const noteKey = NOTE_PREFIX + message.id;
      const stored = (await storageGet([noteKey]))[noteKey];
      let noteTrashEntry;
      if (stored) noteTrashEntry = await addToTrash('note', { ...stored, id: message.id });
      try {
        const result = await deleteNoteById(message.id);
        notifyDashboard('note-deleted');
        return result;
      } catch (err) {
        if (noteTrashEntry) await removeFromTrash(noteTrashEntry.trashId).catch(() => {});
        throw err;
      }
    }

    case 'toggle-pin-note': {
      const noteKey = NOTE_PREFIX + message.id;
      const stored = (await storageGet([noteKey]))[noteKey];
      if (!stored) return { success: false };
      const updated = { ...stored, pinned: !Boolean(stored.pinned), updatedAt: Date.now() };
      await storageSet({ [noteKey]: compactBookmark(updated) });
      notifyDashboard('note-updated');
      return { pinned: updated.pinned };
    }

    case 'get-tasks':
      return await getTasks();

    case 'save-task': {
      try {
        const saved = await saveTask(message.task);
        notifyDashboard('task-added');
        return saved;
      } catch (err) {
        return { error: err.message || 'Failed to save task.' };
      }
    }

    case 'update-task': {
      try {
        const result = await updateTask(message.task);
        notifyDashboard('task-updated');
        return result;
      } catch (err) {
        return { error: err.message || 'Failed to update task.' };
      }
    }

    case 'delete-task': {
      const taskKey = TASK_PREFIX + message.id;
      const stored = (await storageGet([taskKey]))[taskKey];
      let taskTrashEntry;
      if (stored) taskTrashEntry = await addToTrash('task', { ...stored, id: message.id });
      try {
        const result = await deleteTaskById(message.id);
        notifyDashboard('task-deleted');
        return result;
      } catch (err) {
        if (taskTrashEntry) await removeFromTrash(taskTrashEntry.trashId).catch(() => {});
        throw err;
      }
    }

    case 'toggle-pin-task': {
      const taskKey = TASK_PREFIX + message.id;
      const stored = (await storageGet([taskKey]))[taskKey];
      if (!stored) return { success: false };
      const updated = { ...stored, pinned: !Boolean(stored.pinned), updatedAt: Date.now() };
      await storageSet({ [taskKey]: compactBookmark(updated) });
      notifyDashboard('task-updated');
      return { pinned: updated.pinned };
    }

    case 'get-trash':
      return await getTrashItems();

    case 'restore-from-trash': {
      // Look up the metadata from the index and the raw data from the per-key.
      const indexResult = await storageGet([TRASH_INDEX_KEY]);
      const index = Array.isArray(indexResult[TRASH_INDEX_KEY]) ? indexResult[TRASH_INDEX_KEY] : [];
      const entry = index.find(e => e.trashId === message.trashId);
      if (!entry) return { success: false };
      const dataResult = await storageGet([TRASH_PREFIX + message.trashId]);
      const data = dataResult[TRASH_PREFIX + message.trashId];
      if (!data) return { success: false };
      const { type } = entry;
      if (type === 'bookmark') {
        const bookmarks = await getBookmarks();
        const sameId  = bookmarks.find(b => b.id  === data.id);
        const sameUrl = data.url && bookmarks.find(b => b.url === data.url);
        if (sameId || sameUrl) {
          // Already present (by ID) or a newer bookmark claimed the same URL.
          // Remove the trash entry without restoring to avoid a duplicate card.
          await removeFromTrash(message.trashId);
          notifyDashboard('trash-updated');
          return { success: false, reason: 'duplicate' };
        }
        bookmarks.unshift(data);
        await saveBookmarks(bookmarks);
        if (data.url) await refreshIconForUrl(data.url, true);
        notifyDashboard('bookmark-added');
      } else if (type === 'note') {
        const ids = (await storageGet([NOTE_INDEX_KEY]))[NOTE_INDEX_KEY] || [];
        if (!ids.includes(data.id)) {
          await storageSet({ [NOTE_INDEX_KEY]: [data.id, ...ids], [NOTE_PREFIX + data.id]: compactBookmark(data) });
        }
        notifyDashboard('note-added');
      } else if (type === 'task') {
        const ids = (await storageGet([TASK_INDEX_KEY]))[TASK_INDEX_KEY] || [];
        if (!ids.includes(data.id)) {
          await storageSet({ [TASK_INDEX_KEY]: [data.id, ...ids], [TASK_PREFIX + data.id]: compactBookmark(data) });
        }
        notifyDashboard('task-added');
      }
      await removeFromTrash(message.trashId);
      notifyDashboard('trash-updated');
      return { success: true };
    }

    case 'permanent-delete': {
      await removeFromTrash(message.trashId);
      notifyDashboard('trash-updated');
      return { success: true };
    }

    case 'empty-trash': {
      const result2 = await storageGet([TRASH_INDEX_KEY]);
      const index2 = Array.isArray(result2[TRASH_INDEX_KEY]) ? result2[TRASH_INDEX_KEY] : [];
      await storageRemove([TRASH_INDEX_KEY, ...index2.map(e => TRASH_PREFIX + e.trashId)]);
      notifyDashboard('trash-updated');
      return { success: true, count: index2.length };
    }

    case 'get-storage-usage': {
      const [bytesInUse, quota] = await Promise.all([
        new Promise(resolve => chrome.storage.sync.getBytesInUse(null, resolve)),
        Promise.resolve(chrome.storage.sync.QUOTA_BYTES)
      ]);
      return { bytesInUse, quota };
    }

    case 'get-settings': {
      const result = await storageGet([SETTINGS_KEY]);
      return result[SETTINGS_KEY] || { theme: 'light' };
    }

    case 'save-settings': {
      // Only persist recognised theme values; reject arbitrary objects (A08).
      const VALID_THEMES = ['light', 'dark'];
      const theme = message.settings && VALID_THEMES.includes(message.settings.theme)
        ? message.settings.theme
        : 'light';
      await storageSet({ [SETTINGS_KEY]: { theme } });
      return { success: true };
    }

    default:
      return { error: 'Unknown action' };
  }
}

// ── Startup Icon Sync ────────────────────────────────────────────────────────
// On service worker activation, update icons for all currently open tabs so
// already-bookmarked pages show the green icon without needing a navigation.
(async () => {
  try {
    const [bookmarks, tabs] = await Promise.all([getBookmarks(), chrome.tabs.query({})]);
    const bookmarkedUrls = new Set(bookmarks.map(b => b.url));
    for (const tab of tabs) {
      if (tab.id && tab.url) {
        setTabIcon(tab.id, bookmarkedUrls.has(tab.url));
      }
    }
  } catch {}
})();
