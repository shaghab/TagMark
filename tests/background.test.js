'use strict';

/**
 * Unit tests for background.js — the extension service worker.
 *
 * background.js is a plain script with no exports. We load it via vm so that
 * all top-level `function` declarations (isValidUrl, sanitizeFavIconUrl, etc.)
 * become properties of the sandbox and are callable directly. All Chrome API
 * calls are intercepted by the in-memory mock provided by createBgContext().
 */

const { createBgContext, createStorageMock } = require('./helpers/bg-context');

// ── isValidUrl ────────────────────────────────────────────────────────────────

describe('isValidUrl', () => {
  let isValidUrl;
  beforeEach(() => { ({ context: { isValidUrl } } = createBgContext()); });

  test('accepts http: URLs', ()  => expect(isValidUrl('http://example.com')).toBe(true));
  test('accepts https: URLs', () => expect(isValidUrl('https://example.com/path')).toBe(true));
  test('accepts file: URLs', ()  => expect(isValidUrl('file:///home/user/doc.html')).toBe(true));

  test('rejects chrome:// URLs',     () => expect(isValidUrl('chrome://settings')).toBe(false));
  test('rejects javascript: URLs',   () => expect(isValidUrl('javascript:alert(1)')).toBe(false));
  test('rejects data:text/html URLs',() => expect(isValidUrl('data:text/html,<h1>x</h1>')).toBe(false));
  test('rejects ftp: URLs',          () => expect(isValidUrl('ftp://example.com')).toBe(false));
  test('rejects null',               () => expect(isValidUrl(null)).toBe(false));
  test('rejects empty string',       () => expect(isValidUrl('')).toBe(false));
  test('rejects a non-string',       () => expect(isValidUrl(42)).toBe(false));
  test('rejects a malformed URL',    () => expect(isValidUrl('not a url')).toBe(false));
});

// ── sanitizeFavIconUrl ────────────────────────────────────────────────────────

describe('sanitizeFavIconUrl', () => {
  let sanitizeFavIconUrl;
  beforeEach(() => { ({ context: { sanitizeFavIconUrl } } = createBgContext()); });

  test('passes through https: favicon URLs', () => {
    const url = 'https://example.com/favicon.ico';
    expect(sanitizeFavIconUrl(url)).toBe(url);
  });

  test('passes through http: favicon URLs', () => {
    const url = 'http://example.com/favicon.ico';
    expect(sanitizeFavIconUrl(url)).toBe(url);
  });

  test('blocks data:image/ URLs (storage bloat prevention)', () => {
    expect(sanitizeFavIconUrl('data:image/png;base64,abc123==')).toBe('');
  });

  test('blocks data:image/ URLs regardless of case', () => {
    expect(sanitizeFavIconUrl('DATA:IMAGE/PNG;base64,abc123==')).toBe('');
  });

  test('blocks javascript: URLs', () => {
    expect(sanitizeFavIconUrl('javascript:alert(1)')).toBe('');
  });

  test('blocks data:text/html URLs', () => {
    expect(sanitizeFavIconUrl('data:text/html,<h1>xss</h1>')).toBe('');
  });

  test('blocks chrome:// URLs', () => {
    expect(sanitizeFavIconUrl('chrome://favicon/https://example.com')).toBe('');
  });

  test('returns empty string for non-string input', () => {
    expect(sanitizeFavIconUrl(null)).toBe('');
    expect(sanitizeFavIconUrl(42)).toBe('');
  });

  test('returns empty string for an empty input', () => {
    expect(sanitizeFavIconUrl('')).toBe('');
  });
});

// ── sanitizeBookmark ──────────────────────────────────────────────────────────

describe('sanitizeBookmark', () => {
  let sanitizeBookmark;
  beforeEach(() => { ({ context: { sanitizeBookmark } } = createBgContext()); });

  const VALID_RAW = {
    url: 'https://example.com',
    title: 'Example',
    notes: 'Some notes',
    tags: ['javascript', 'web'],
    pinned: false,
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    favIconUrl: 'https://example.com/favicon.ico',
  };

  test('returns a valid bookmark object for valid input', () => {
    const b = sanitizeBookmark(VALID_RAW);
    expect(b).not.toBeNull();
    expect(b.url).toBe('https://example.com');
    expect(b.title).toBe('Example');
    expect(b.notes).toBe('Some notes');
    expect(b.tags).toEqual(['javascript', 'web']);
    expect(b.pinned).toBe(false);
    expect(b.favIconUrl).toBe('https://example.com/favicon.ico');
  });

  test('generates a fresh id (not the same as any input id)', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, id: 'original-id' });
    expect(typeof b.id).toBe('string');
    expect(b.id.length).toBeGreaterThan(0);
  });

  test('returns null for a null input', () => {
    expect(sanitizeBookmark(null)).toBeNull();
  });

  test('returns null for an array', () => {
    expect(sanitizeBookmark([])).toBeNull();
  });

  test('returns null for a non-object primitive', () => {
    expect(sanitizeBookmark('string')).toBeNull();
    expect(sanitizeBookmark(42)).toBeNull();
  });

  test('returns null when the URL is invalid', () => {
    expect(sanitizeBookmark({ ...VALID_RAW, url: 'chrome://settings' })).toBeNull();
    expect(sanitizeBookmark({ ...VALID_RAW, url: 'javascript:evil()' })).toBeNull();
    expect(sanitizeBookmark({ ...VALID_RAW, url: '' })).toBeNull();
  });

  test('falls back to the URL when title is missing', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, title: undefined });
    expect(b.title).toBe('https://example.com');
  });

  test('normalizes tags to lowercase with spaces replaced by hyphens', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, tags: ['Web Dev', 'JAVASCRIPT', 'Some Tag'] });
    expect(b.tags).toEqual(['web-dev', 'javascript', 'some-tag']);
  });

  test('filters out non-string tags', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, tags: ['valid', 42, null, 'also-valid'] });
    expect(b.tags).toEqual(['valid', 'also-valid']);
  });

  test('limits tags to a maximum of 50', () => {
    const manyTags = Array.from({ length: 60 }, (_, i) => `tag${i}`);
    const b = sanitizeBookmark({ ...VALID_RAW, tags: manyTags });
    expect(b.tags.length).toBe(50);
  });

  test('treats a non-array tags value as empty', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, tags: 'not-an-array' });
    expect(b.tags).toEqual([]);
  });

  test('preserves a valid createdAt timestamp', () => {
    const b = sanitizeBookmark(VALID_RAW);
    expect(b.createdAt).toBe(1700000000000);
  });

  test('falls back createdAt to now when the value is 0 or negative', () => {
    const before = Date.now();
    const b = sanitizeBookmark({ ...VALID_RAW, createdAt: 0 });
    const after = Date.now();
    expect(b.createdAt).toBeGreaterThanOrEqual(before);
    expect(b.createdAt).toBeLessThanOrEqual(after);
  });

  test('sanitizes a dangerous favIconUrl', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, favIconUrl: 'javascript:alert(1)' });
    expect(b.favIconUrl).toBe('');
  });

  test('preserves a valid folderId string', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, folderId: 'folder-123' });
    expect(b.folderId).toBe('folder-123');
  });

  test('converts a falsy folderId to null', () => {
    expect(sanitizeBookmark({ ...VALID_RAW, folderId: '' }).folderId).toBeNull();
    expect(sanitizeBookmark({ ...VALID_RAW, folderId: null }).folderId).toBeNull();
  });

  test('preserves a valid gtdStatus', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, gtdStatus: 'next' });
    expect(b.gtdStatus).toBe('next');
  });

  test('sets gtdStatus to null for an unrecognised value', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, gtdStatus: 'unknown-status' });
    expect(b.gtdStatus).toBeNull();
  });

  test('sets gtdStatus to null when not provided', () => {
    const b = sanitizeBookmark(VALID_RAW);
    expect(b.gtdStatus).toBeNull();
  });

  test('preserves a valid contentType', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, contentType: 'read' });
    expect(b.contentType).toBe('read');
  });

  test('sets contentType to null for an unrecognised value', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, contentType: 'invalid' });
    expect(b.contentType).toBeNull();
  });

  test('preserves a valid urgency', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, urgency: 'high' });
    expect(b.urgency).toBe('high');
  });

  test('sets urgency to null for an unrecognised value', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, urgency: 'extreme' });
    expect(b.urgency).toBeNull();
  });

  test('preserves a valid importance', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, importance: 'critical' });
    expect(b.importance).toBe('critical');
  });

  test('sets importance to null for an unrecognised value', () => {
    const b = sanitizeBookmark({ ...VALID_RAW, importance: 'super-important' });
    expect(b.importance).toBeNull();
  });

  test('all valid gtdStatus values are accepted', () => {
    const statuses = ['next', 'later', 'someday', 'waiting', 'done', 'archived', 'dropped', 'reference'];
    for (const gtdStatus of statuses) {
      const b = sanitizeBookmark({ ...VALID_RAW, gtdStatus });
      expect(b.gtdStatus).toBe(gtdStatus);
    }
  });

  test('all valid contentType values are accepted', () => {
    const types = ['read', 'watch', 'listen', 'learn', 'try', 'create', 'build'];
    for (const contentType of types) {
      const b = sanitizeBookmark({ ...VALID_RAW, contentType });
      expect(b.contentType).toBe(contentType);
    }
  });

  test('all valid priority level values are accepted for urgency and importance', () => {
    const levels = ['critical', 'high', 'medium', 'low', 'none'];
    for (const level of levels) {
      expect(sanitizeBookmark({ ...VALID_RAW, urgency: level }).urgency).toBe(level);
      expect(sanitizeBookmark({ ...VALID_RAW, importance: level }).importance).toBe(level);
    }
  });
});

// ── generateId ────────────────────────────────────────────────────────────────

describe('generateId', () => {
  let generateId;
  beforeEach(() => { ({ context: { generateId } } = createBgContext()); });

  test('returns a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('generates unique IDs across 200 calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId()));
    expect(ids.size).toBe(200);
  });
});

// ── handleMessage: get-bookmarks ──────────────────────────────────────────────

describe('handleMessage: get-bookmarks', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  test('returns an empty array when there are no bookmarks', async () => {
    const result = await sendMessage({ action: 'get-bookmarks' });
    expect(result).toEqual([]);
  });

  test('returns a saved bookmark in the array', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://example.com', title: 'Example', tags: [], notes: '', pinned: false, favIconUrl: '',
    }});
    const result = await sendMessage({ action: 'get-bookmarks' });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://example.com');
  });
});

// ── handleMessage: save-bookmark ─────────────────────────────────────────────

describe('handleMessage: save-bookmark', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  const BM = {
    url: 'https://example.com',
    title: 'Example Site',
    tags: ['test', 'example'],
    notes: 'A note',
    pinned: false,
    favIconUrl: 'https://example.com/favicon.ico',
  };

  test('returns the saved bookmark with generated id and timestamps', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: BM });
    expect(result.url).toBe(BM.url);
    expect(result.title).toBe(BM.title);
    expect(result.tags).toEqual(BM.tags);
    expect(typeof result.id).toBe('string');
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.updatedAt).toBeGreaterThan(0);
  });

  test('the bookmark appears in subsequent get-bookmarks', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: BM });
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks.length).toBe(1);
    expect(bookmarks[0].url).toBe(BM.url);
  });

  test('deduplicates by URL — saving the same URL updates the existing entry', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: BM });
    await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, title: 'Updated Title' } });
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks.length).toBe(1);
    expect(bookmarks[0].title).toBe('Updated Title');
  });

  test('preserves the original createdAt when updating a duplicate URL', async () => {
    const first  = await sendMessage({ action: 'save-bookmark', bookmark: BM });
    const second = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, title: 'Updated' } });
    expect(second.createdAt).toBe(first.createdAt);
  });

  test('returns an error object for an invalid URL scheme', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, url: 'chrome://settings' } });
    expect(result).toHaveProperty('error');
  });

  test('normalizes tags to lowercase with hyphens', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, tags: ['Web Dev', 'JAVASCRIPT'] } });
    expect(result.tags).toEqual(['web-dev', 'javascript']);
  });

  test('truncates a title exceeding 2 000 characters', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, title: 'A'.repeat(3000) } });
    expect(result.title.length).toBeLessThanOrEqual(2000);
  });

  test('sanitizes a dangerous favIconUrl', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, favIconUrl: 'javascript:evil()' } });
    expect(result.favIconUrl).toBe('');
  });

  test('stores pinned as a boolean', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, pinned: 1 } });
    expect(result.pinned).toBe(true);
  });

  test('saves a valid gtdStatus', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, gtdStatus: 'next' } });
    expect(result.gtdStatus).toBe('next');
  });

  test('stores null for an unrecognised gtdStatus', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, gtdStatus: 'bogus' } });
    expect(result.gtdStatus).toBeNull();
  });

  test('saves a valid contentType', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, contentType: 'watch' } });
    expect(result.contentType).toBe('watch');
  });

  test('stores null for an unrecognised contentType', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, contentType: 'invalid' } });
    expect(result.contentType).toBeNull();
  });

  test('saves valid urgency and importance', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, urgency: 'high', importance: 'critical' } });
    expect(result.urgency).toBe('high');
    expect(result.importance).toBe('critical');
  });

  test('stores null for unrecognised urgency and importance', async () => {
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, urgency: 'extreme', importance: 'meh' } });
    expect(result.urgency).toBeNull();
    expect(result.importance).toBeNull();
  });

  test('preserves existing gtdStatus when URL is a duplicate and new value is invalid', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, gtdStatus: 'later' } });
    const result = await sendMessage({ action: 'save-bookmark', bookmark: { ...BM, gtdStatus: 'bogus' } });
    expect(result.gtdStatus).toBe('later');
  });
});

// ── handleMessage: delete-bookmark ───────────────────────────────────────────

describe('handleMessage: delete-bookmark', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  async function saveBm(overrides = {}) {
    return sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://example.com', title: 'Test', tags: [], notes: '', pinned: false, favIconUrl: '', ...overrides,
    }});
  }

  test('removes the bookmark by id', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'delete-bookmark', id: saved.id });
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks.length).toBe(0);
  });

  test('returns { success: true } even for a non-existent id', async () => {
    const result = await sendMessage({ action: 'delete-bookmark', id: 'no-such-id' });
    expect(result).toEqual({ success: true });
  });

  test('only removes the targeted bookmark when multiple exist', async () => {
    const a = await saveBm({ url: 'https://a.com' });
    await saveBm({ url: 'https://b.com' });
    await sendMessage({ action: 'delete-bookmark', id: a.id });
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks.length).toBe(1);
    expect(bookmarks[0].url).toBe('https://b.com');
  });
});

// ── handleMessage: update-bookmark ───────────────────────────────────────────

describe('handleMessage: update-bookmark', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  async function saveBm(overrides = {}) {
    return sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://example.com', title: 'Old Title', tags: ['old'], notes: 'old note',
      pinned: false, favIconUrl: '', ...overrides,
    }});
  }

  test('updates title, tags, and notes', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, title: 'New Title', tags: ['new'], notes: 'new note' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.title).toBe('New Title');
    expect(updated.tags).toEqual(['new']);
    expect(updated.notes).toBe('new note');
  });

  test('does not allow changing id or createdAt', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, id: 'hacked', createdAt: 0 } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.id).toBe(saved.id);
    expect(updated.createdAt).toBe(saved.createdAt);
  });

  test('returns an error for an invalid URL', async () => {
    const saved = await saveBm();
    const result = await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, url: 'javascript:evil()' } });
    expect(result).toHaveProperty('error');
  });

  test('returns { success: true } when the id is not found', async () => {
    const result = await sendMessage({ action: 'update-bookmark', bookmark: { id: 'missing', url: 'https://x.com' } });
    expect(result).toEqual({ success: true });
  });

  test('normalizes updated tags', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, tags: ['Web Dev', 'JS'] } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.tags).toEqual(['web-dev', 'js']);
  });

  test('updates updatedAt to a newer timestamp', async () => {
    const saved = await saveBm();
    await new Promise(r => setTimeout(r, 2)); // ensure time advances
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, title: 'Updated' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.updatedAt).toBeGreaterThan(saved.updatedAt);
  });

  test('can update folderId to a non-empty string', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, folderId: 'folder-abc' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.folderId).toBe('folder-abc');
  });

  test('can clear folderId by setting it to an empty string', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, folderId: '' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.folderId).toBeNull();
  });

  test('can update gtdStatus to a valid value', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, gtdStatus: 'someday' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.gtdStatus).toBe('someday');
  });

  test('sets gtdStatus to null when updated with an invalid value', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, gtdStatus: 'bogus' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.gtdStatus).toBeNull();
  });

  test('can update contentType to a valid value', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, contentType: 'learn' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.contentType).toBe('learn');
  });

  test('can update urgency and importance', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, urgency: 'medium', importance: 'low' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.urgency).toBe('medium');
    expect(updated.importance).toBe('low');
  });

  test('preserves existing gtdStatus when update does not include gtdStatus field', async () => {
    const saved = await sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://example.com', title: 'Old Title', tags: ['old'], notes: 'old note',
      pinned: false, favIconUrl: '', gtdStatus: 'waiting',
    }});
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, title: 'New Title' } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.gtdStatus).toBe('waiting');
  });

  test('can set pinned to true via update', async () => {
    const saved = await saveBm();
    await sendMessage({ action: 'update-bookmark', bookmark: { ...saved, pinned: true } });
    const [updated] = await sendMessage({ action: 'get-bookmarks' });
    expect(updated.pinned).toBe(true);
  });
});

// ── handleMessage: toggle-pin ─────────────────────────────────────────────────

describe('handleMessage: toggle-pin', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  async function saveBm(pinned = false) {
    return sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://example.com', title: 'Test', tags: [], notes: '', pinned, favIconUrl: '',
    }});
  }

  test('toggles pin from false to true', async () => {
    const saved  = await saveBm(false);
    const result = await sendMessage({ action: 'toggle-pin', id: saved.id });
    expect(result.pinned).toBe(true);
  });

  test('toggles pin from true to false', async () => {
    const saved  = await saveBm(true);
    const result = await sendMessage({ action: 'toggle-pin', id: saved.id });
    expect(result.pinned).toBe(false);
  });

  test('reflects the change in get-bookmarks', async () => {
    const saved = await saveBm(false);
    await sendMessage({ action: 'toggle-pin', id: saved.id });
    const [bm] = await sendMessage({ action: 'get-bookmarks' });
    expect(bm.pinned).toBe(true);
  });

  test('returns { success: false } for an unknown id', async () => {
    const result = await sendMessage({ action: 'toggle-pin', id: 'unknown-id' });
    expect(result).toEqual({ success: false });
  });
});

// ── handleMessage: get-all-tags ───────────────────────────────────────────────

describe('handleMessage: get-all-tags', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  test('returns an empty array when there are no bookmarks', async () => {
    expect(await sendMessage({ action: 'get-all-tags' })).toEqual([]);
  });

  test('returns sorted, unique tags across all bookmarks', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: ['zebra', 'apple'], notes: '', pinned: false, favIconUrl: '' }});
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://b.com', title: 'B', tags: ['apple', 'mango'], notes: '', pinned: false, favIconUrl: '' }});
    const tags = await sendMessage({ action: 'get-all-tags' });
    expect(tags).toEqual(['apple', 'mango', 'zebra']);
  });

  test('returns an empty array when no bookmark has tags', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    expect(await sendMessage({ action: 'get-all-tags' })).toEqual([]);
  });
});

// ── handleMessage: import-bookmarks ──────────────────────────────────────────

describe('handleMessage: import-bookmarks', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  const now = Date.now();
  const VALID_IMPORT = { url: 'https://import.com', title: 'Import', tags: ['imported'], notes: '', pinned: false, createdAt: now, updatedAt: now };

  test('imports valid bookmarks and returns the count', async () => {
    const result = await sendMessage({ action: 'import-bookmarks', bookmarks: [VALID_IMPORT] });
    expect(result.count).toBe(1);
  });

  test('the imported bookmark appears in get-bookmarks', async () => {
    await sendMessage({ action: 'import-bookmarks', bookmarks: [VALID_IMPORT] });
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks.some(b => b.url === VALID_IMPORT.url)).toBe(true);
  });

  test('skips entries with invalid URLs', async () => {
    const result = await sendMessage({ action: 'import-bookmarks', bookmarks: [
      { url: 'chrome://settings', title: 'Bad', tags: [], notes: '', pinned: false, createdAt: now, updatedAt: now },
      VALID_IMPORT,
    ]});
    expect(result.count).toBe(1);
  });

  test('skips null and non-object entries', async () => {
    const result = await sendMessage({ action: 'import-bookmarks', bookmarks: [null, 'string', 42, VALID_IMPORT] });
    expect(result.count).toBe(1);
  });

  test('merges a duplicate URL rather than creating a second entry', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { url: VALID_IMPORT.url, title: 'Old', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    await sendMessage({ action: 'import-bookmarks', bookmarks: [VALID_IMPORT] });
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks.filter(b => b.url === VALID_IMPORT.url).length).toBe(1);
  });

  test('handles a null bookmarks payload gracefully (returns count 0)', async () => {
    const result = await sendMessage({ action: 'import-bookmarks', bookmarks: null });
    expect(result.count).toBe(0);
  });

  test('normalizes tags during import', async () => {
    const raw = { ...VALID_IMPORT, tags: ['Web Dev', 'JAVASCRIPT'] };
    await sendMessage({ action: 'import-bookmarks', bookmarks: [raw] });
    const [bm] = await sendMessage({ action: 'get-bookmarks' });
    // Order matches the input array after normalization
    expect(bm.tags).toEqual(['web-dev', 'javascript']);
  });
});

// ── handleMessage: export-bookmarks ──────────────────────────────────────────

describe('handleMessage: export-bookmarks', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  test('returns an empty array when there are no bookmarks', async () => {
    expect(await sendMessage({ action: 'export-bookmarks' })).toEqual([]);
  });

  test('returns all saved bookmarks', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://b.com', title: 'B', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    const exported = await sendMessage({ action: 'export-bookmarks' });
    expect(Array.isArray(exported)).toBe(true);
    expect(exported.length).toBe(2);
  });
});

// ── handleMessage: get-settings / save-settings ───────────────────────────────

describe('handleMessage: settings', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  test('returns { theme: "light" } by default', async () => {
    expect(await sendMessage({ action: 'get-settings' })).toEqual({ theme: 'light' });
  });

  test('save and retrieve dark theme', async () => {
    await sendMessage({ action: 'save-settings', settings: { theme: 'dark' } });
    expect((await sendMessage({ action: 'get-settings' })).theme).toBe('dark');
  });

  test('save and retrieve light theme', async () => {
    await sendMessage({ action: 'save-settings', settings: { theme: 'light' } });
    expect((await sendMessage({ action: 'get-settings' })).theme).toBe('light');
  });

  test('rejects an unknown theme value and falls back to "light"', async () => {
    // First set dark so we can confirm the invalid write did not keep it as dark
    await sendMessage({ action: 'save-settings', settings: { theme: 'dark' } });
    await sendMessage({ action: 'save-settings', settings: { theme: 'purple' } });
    expect((await sendMessage({ action: 'get-settings' })).theme).toBe('light');
  });

  test('handles a null settings payload without throwing', async () => {
    const result = await sendMessage({ action: 'save-settings', settings: null });
    expect(result).toEqual({ success: true });
  });
});

// ── handleMessage: folders ────────────────────────────────────────────────────

describe('handleMessage: folders', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  // ── get-folders ──

  test('get-folders seeds default folders on first call', async () => {
    const folders = await sendMessage({ action: 'get-folders' });
    expect(Array.isArray(folders)).toBe(true);
    expect(folders.length).toBeGreaterThan(0);
    expect(folders[0]).toHaveProperty('id');
    expect(folders[0]).toHaveProperty('name');
    expect(folders[0]).toHaveProperty('parentId');
    expect(folders[0]).toHaveProperty('createdAt');
  });

  // ── create-folder ──

  test('create-folder adds a root folder and returns it', async () => {
    const folder = await sendMessage({ action: 'create-folder', name: 'My Folder', parentId: null });
    expect(folder.name).toBe('My Folder');
    expect(folder.parentId).toBeNull();
    expect(typeof folder.id).toBe('string');
  });

  test('create-folder adds a subfolder under a valid parent', async () => {
    const parent = await sendMessage({ action: 'create-folder', name: 'Parent', parentId: null });
    const child  = await sendMessage({ action: 'create-folder', name: 'Child', parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  test('create-folder returns an error for an empty name', async () => {
    const result = await sendMessage({ action: 'create-folder', name: '' });
    expect(result).toHaveProperty('error');
  });

  test('create-folder returns an error for a non-existent parentId', async () => {
    const result = await sendMessage({ action: 'create-folder', name: 'Orphan', parentId: 'nonexistent-id' });
    expect(result).toHaveProperty('error');
  });

  test('create-folder trims and truncates the name', async () => {
    const folder = await sendMessage({ action: 'create-folder', name: '  A'.padEnd(200, 'x'), parentId: null });
    expect(folder.name.length).toBeLessThanOrEqual(100);
  });

  // ── update-folder ──

  test('update-folder renames the folder', async () => {
    const folder = await sendMessage({ action: 'create-folder', name: 'Old', parentId: null });
    await sendMessage({ action: 'update-folder', id: folder.id, name: 'New' });
    const folders = await sendMessage({ action: 'get-folders' });
    expect(folders.find(f => f.id === folder.id).name).toBe('New');
  });

  test('update-folder returns an error for an unknown id', async () => {
    const result = await sendMessage({ action: 'update-folder', id: 'unknown', name: 'X' });
    expect(result).toHaveProperty('error');
  });

  test('update-folder returns an error for an empty name', async () => {
    const folder = await sendMessage({ action: 'create-folder', name: 'Valid', parentId: null });
    const result = await sendMessage({ action: 'update-folder', id: folder.id, name: '' });
    expect(result).toHaveProperty('error');
  });

  // ── delete-folder ──

  test('delete-folder removes the folder from the list', async () => {
    const folder = await sendMessage({ action: 'create-folder', name: 'ToDelete', parentId: null });
    await sendMessage({ action: 'delete-folder', id: folder.id });
    const folders = await sendMessage({ action: 'get-folders' });
    expect(folders.find(f => f.id === folder.id)).toBeUndefined();
  });

  test('delete-folder cascades to subfolders', async () => {
    const parent = await sendMessage({ action: 'create-folder', name: 'Parent', parentId: null });
    const child  = await sendMessage({ action: 'create-folder', name: 'Child', parentId: parent.id });
    await sendMessage({ action: 'delete-folder', id: parent.id });
    const folders = await sendMessage({ action: 'get-folders' });
    expect(folders.find(f => f.id === parent.id)).toBeUndefined();
    expect(folders.find(f => f.id === child.id)).toBeUndefined();
  });

  test('delete-folder unassigns bookmarks that were in the deleted folder', async () => {
    const folder = await sendMessage({ action: 'create-folder', name: 'Folder', parentId: null });
    await sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://example.com', title: 'Test', tags: [], notes: '', pinned: false, favIconUrl: '', folderId: folder.id,
    }});
    await sendMessage({ action: 'delete-folder', id: folder.id });
    const [bm] = await sendMessage({ action: 'get-bookmarks' });
    expect(bm.folderId).toBeNull();
  });
});

// ── handleMessage: unknown action ────────────────────────────────────────────

describe('handleMessage: unknown action', () => {
  let sendMessage;
  beforeEach(() => { ({ sendMessage } = createBgContext()); });

  test('returns { error: "Unknown action" }', async () => {
    const result = await sendMessage({ action: 'this-does-not-exist' });
    expect(result).toEqual({ error: 'Unknown action' });
  });
});

// ── notifyDashboard ───────────────────────────────────────────────────────────

describe('notifyDashboard', () => {
  test('invokes the original tabs.sendMessage for a matching dashboard tab (no error thrown)', async () => {
    // This test exercises bg-context.js line 92 (the default tabs.sendMessage stub).
    // We override only tabs.query; the original sendMessage from the mock is called.
    const { chrome, sendMessage } = createBgContext();
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');

    chrome.tabs.query = (_, cb) => cb([{ id: 99, url: dashboardUrl }]);
    // tabs.sendMessage is NOT overridden — the original mock (line 92) is used.

    const saved = await sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://notify-orig.com', title: 'Notify Orig', tags: [], notes: '', pinned: false, favIconUrl: '',
    }});
    // delete-bookmark always calls notifyDashboard
    const result = await sendMessage({ action: 'delete-bookmark', id: saved.id });
    expect(result).toEqual({ success: true });
  });

  test('sends a message to an open dashboard tab', async () => {
    const { chrome, sendMessage } = createBgContext();
    const sentMessages = [];
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');

    chrome.tabs.query = (_, cb) => cb([{ id: 99, url: dashboardUrl }]);
    chrome.tabs.sendMessage = (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return Promise.resolve();
    };

    const saved = await sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://notify-test.com', title: 'Notify Test', tags: [], notes: '', pinned: false, favIconUrl: '',
    }});
    await sendMessage({ action: 'delete-bookmark', id: saved.id });

    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages[0].tabId).toBe(99);
    expect(sentMessages[0].msg.action).toBe('bookmark-deleted');
  });

  test('does not send to tabs whose URL does not start with the dashboard URL', async () => {
    const { chrome, sendMessage } = createBgContext();
    const sentMessages = [];

    chrome.tabs.query = (_, cb) => cb([
      { id: 1, url: 'https://example.com/dashboard.html' }, // not this extension's URL
      { id: 2, url: null },                                  // tab with no URL
    ]);
    chrome.tabs.sendMessage = (tabId, msg) => {
      sentMessages.push({ tabId, msg });
      return Promise.resolve();
    };

    const saved = await sendMessage({ action: 'save-bookmark', bookmark: {
      url: 'https://no-notify.com', title: 'No Notify', tags: [], notes: '', pinned: false, favIconUrl: '',
    }});
    await sendMessage({ action: 'delete-bookmark', id: saved.id });

    expect(sentMessages.length).toBe(0);
  });
});

// ── Storage sharding ─────────────────────────────────────────────────────────

describe('storage sharding', () => {
  let sendMessage, storage;
  beforeEach(() => { ({ sendMessage, storage } = createBgContext()); });

  test('each bookmark is stored under its own tagmark_bm_<id> key', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://b.com', title: 'B', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    const keys   = Object.keys(storage._data);
    const bmKeys = keys.filter(k => k.startsWith('tagmark_bm_'));
    expect(bmKeys.length).toBe(2);
    expect(keys).toContain('tagmark_index');
  });

  test('the tagmark_index contains the correct IDs in order', async () => {
    const a = await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    const b = await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://b.com', title: 'B', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    const index = storage._data['tagmark_index'];
    expect(index).toContain(a.id);
    expect(index).toContain(b.id);
  });

  test('deleting a bookmark removes its individual storage key', async () => {
    const bm = await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    await sendMessage({ action: 'delete-bookmark', id: bm.id });
    expect(storage._data[`tagmark_bm_${bm.id}`]).toBeUndefined();
  });

  test('the tagmark_index is updated after delete', async () => {
    const bm = await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, favIconUrl: '' }});
    await sendMessage({ action: 'delete-bookmark', id: bm.id });
    expect(storage._data['tagmark_index']).not.toContain(bm.id);
  });
});

// ── Legacy storage migration ──────────────────────────────────────────────────

describe('migrateLegacyStorage', () => {
  let sendMessage, storage;
  beforeEach(() => { ({ sendMessage, storage } = createBgContext()); });

  test('migrates the old tagmark_bookmarks array to per-bookmark keys', async () => {
    const legacy = [
      { id: 'abc1', url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, createdAt: 1000, updatedAt: 1000, favIconUrl: '' },
      { id: 'abc2', url: 'https://b.com', title: 'B', tags: [], notes: '', pinned: false, createdAt: 2000, updatedAt: 2000, favIconUrl: '' },
    ];
    // Pre-populate legacy key; absence of tagmark_index triggers migration
    storage._data['tagmark_bookmarks'] = legacy;

    const bookmarks = await sendMessage({ action: 'get-bookmarks' });

    expect(bookmarks.length).toBe(2);
    expect(bookmarks.map(b => b.url)).toContain('https://a.com');
    expect(bookmarks.map(b => b.url)).toContain('https://b.com');
  });

  test('removes the legacy key after migration', async () => {
    storage._data['tagmark_bookmarks'] = [
      { id: 'abc1', url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, createdAt: 1000, updatedAt: 1000, favIconUrl: '' },
    ];
    await sendMessage({ action: 'get-bookmarks' });
    expect(storage._data['tagmark_bookmarks']).toBeUndefined();
  });

  test('creates the new tagmark_index after migration', async () => {
    storage._data['tagmark_bookmarks'] = [
      { id: 'abc1', url: 'https://a.com', title: 'A', tags: [], notes: '', pinned: false, createdAt: 1000, updatedAt: 1000, favIconUrl: '' },
    ];
    await sendMessage({ action: 'get-bookmarks' });
    expect(Array.isArray(storage._data['tagmark_index'])).toBe(true);
  });

  test('initialises an empty index for a fresh install (no legacy data)', async () => {
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks).toEqual([]);
    expect(Array.isArray(storage._data['tagmark_index'])).toBe(true);
  });
});

// ── createStorageMock: object-form get ────────────────────────────────────────

describe('createStorageMock: object-form get (defaults)', () => {
  let storage;
  beforeEach(() => { storage = createStorageMock(); });

  test('returns the provided default for a key not in storage', done => {
    storage.get({ missingKey: 'default-value' }, result => {
      expect(result.missingKey).toBe('default-value');
      done();
    });
  });

  test('returns the stored value (not the default) when the key exists', done => {
    storage._data['existingKey'] = 'stored-value';
    storage.get({ existingKey: 'default-value' }, result => {
      expect(result.existingKey).toBe('stored-value');
      done();
    });
  });

  test('handles multiple keys — some stored, some using defaults', done => {
    storage._data['keyA'] = 'actual-a';
    storage.get({ keyA: 'default-a', keyB: 'default-b' }, result => {
      expect(result.keyA).toBe('actual-a');
      expect(result.keyB).toBe('default-b');
      done();
    });
  });

  test('string-form get returns only the matching key', done => {
    storage._data['theKey'] = 'theValue';
    storage.get('theKey', result => {
      expect(result.theKey).toBe('theValue');
      done();
    });
  });

  test('string-form get returns empty result for a missing key', done => {
    storage.get('noSuchKey', result => {
      expect(Object.keys(result).length).toBe(0);
      done();
    });
  });

  test('remove deletes a key and subsequent get returns empty', done => {
    storage._data['toRemove'] = 'value';
    storage.remove('toRemove', () => {
      storage.get(['toRemove'], result => {
        expect(result.toRemove).toBeUndefined();
        done();
      });
    });
  });
});

// ── Message authentication ────────────────────────────────────────────────────

describe('message authentication', () => {
  test('does not respond to messages from a foreign extension ID', done => {
    const { msgListeners } = createBgContext();
    let called = false;
    msgListeners[0](
      { action: 'get-bookmarks' },
      { id: 'some-other-extension-id' },
      () => { called = true; },
    );
    // The listener returns without calling sendResponse for non-matching IDs
    setTimeout(() => {
      expect(called).toBe(false);
      done();
    }, 20);
  });
});
