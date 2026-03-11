// TagMark Background Service Worker
// Handles context menus, sync, and cross-tab communication

const STORAGE_KEY = 'tagmark_bookmarks';
const SETTINGS_KEY = 'tagmark_settings';

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

  await saveBookmark({ url, title, favIconUrl, tags: [], notes: '', pinned: false });

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

const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'ftp:', 'file:'];

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

async function getBookmarks() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY] || []);
    });
  });
}

async function saveBookmarks(bookmarks) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [STORAGE_KEY]: bookmarks }, resolve);
  });
}

async function saveBookmark(bookmark) {
  if (!isValidUrl(bookmark.url)) {
    throw new Error('Invalid URL scheme');
  }

  const bookmarks = await getBookmarks();

  // Check for duplicate URL
  const existingIndex = bookmarks.findIndex(b => b.url === bookmark.url);

  const newBookmark = {
    id: existingIndex >= 0 ? bookmarks[existingIndex].id : generateId(),
    url: bookmark.url,
    title: bookmark.title || bookmark.url,
    favIconUrl: bookmark.favIconUrl || '',
    tags: bookmark.tags || [],
    notes: bookmark.notes || '',
    pinned: bookmark.pinned || false,
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
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function notifyDashboard(action) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && tab.url.includes('dashboard.html')) {
        chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
      }
    });
  });
}

// ── Import Sanitizer ────────────────────────────────────────────────────────

const MAX_TITLE_LEN = 2000;
const MAX_URL_LEN   = 2048;
const MAX_NOTES_LEN = 10000;
const MAX_TAG_LEN   = 100;
const MAX_TAGS      = 50;

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
    favIconUrl: typeof raw.favIconUrl === 'string' ? raw.favIconUrl.slice(0, MAX_URL_LEN) : '',
    tags,
    notes,
    pinned,
    createdAt,
    updatedAt
  };
}

// ── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      if (message.bookmark.url && !isValidUrl(message.bookmark.url)) {
        return { error: 'Invalid URL scheme' };
      }
      const bookmarks = await getBookmarks();
      const idx = bookmarks.findIndex(b => b.id === message.bookmark.id);
      if (idx >= 0) {
        bookmarks[idx] = { ...bookmarks[idx], ...message.bookmark, updatedAt: Date.now() };
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
      return new Promise(resolve => {
        chrome.storage.sync.set({ [SETTINGS_KEY]: message.settings }, () => resolve({ success: true }));
      });
    }

    default:
      return { error: 'Unknown action' };
  }
}
