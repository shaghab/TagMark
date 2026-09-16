'use strict';

/**
 * Covers the multi-type import path added alongside the export options:
 * sanitizers for notes/tasks/folders, folder id remapping, dedupe behaviour,
 * and the export-data / import-data message actions.
 */

const { createBgContext } = require('./helpers/bg-context');

let context, sendMessage, storage;

beforeEach(() => {
  ({ context, sendMessage, storage } = createBgContext());
});

// ── sanitizeNote ─────────────────────────────────────────────────────────────

describe('sanitizeNote', () => {
  test('keeps title, content, tags and pinned state', () => {
    const note = context.sanitizeNote({
      title: '  My Note  ',
      content: 'Body text',
      tags: ['Web Dev', 'JS'],
      pinned: true,
    });
    expect(note.title).toBe('My Note');
    expect(note.content).toBe('Body text');
    expect(note.tags).toEqual(['web-dev', 'js']);
    expect(note.pinned).toBe(true);
  });

  test('rejects a note with neither title nor content', () => {
    expect(context.sanitizeNote({ title: '   ', content: '' })).toBeNull();
  });

  test('rejects non-objects', () => {
    expect(context.sanitizeNote(null)).toBeNull();
    expect(context.sanitizeNote('nope')).toBeNull();
    expect(context.sanitizeNote([])).toBeNull();
  });

  test('falls back to Untitled when only content is present', () => {
    expect(context.sanitizeNote({ content: 'just a body' }).title).toBe('Untitled');
  });

  test('assigns a fresh id rather than trusting the file', () => {
    expect(context.sanitizeNote({ title: 'x', id: 'attacker-id' }).id).not.toBe('attacker-id');
  });

  test('keeps a sane createdAt and replaces a bogus one', () => {
    expect(context.sanitizeNote({ title: 'x', createdAt: 1234 }).createdAt).toBe(1234);
    expect(context.sanitizeNote({ title: 'x', createdAt: -5 }).createdAt).toBeGreaterThan(0);
    expect(context.sanitizeNote({ title: 'x', createdAt: 'soon' }).createdAt).toBeGreaterThan(0);
  });
});

// ── sanitizeTask ─────────────────────────────────────────────────────────────

describe('sanitizeTask', () => {
  test('keeps valid gtdStatus, urgency and importance', () => {
    const task = context.sanitizeTask({
      title: 'Ship it',
      gtdStatus: 'next',
      urgency: 'high',
      importance: 'critical',
    });
    expect(task.gtdStatus).toBe('next');
    expect(task.urgency).toBe('high');
    expect(task.importance).toBe('critical');
  });

  test('nulls out unrecognised enum values', () => {
    const task = context.sanitizeTask({
      title: 'Ship it',
      gtdStatus: 'whenever',
      urgency: 'extreme',
      importance: 'meh',
    });
    expect(task.gtdStatus).toBeNull();
    expect(task.urgency).toBeNull();
    expect(task.importance).toBeNull();
  });

  test('rejects a task with no title', () => {
    expect(context.sanitizeTask({ notes: 'orphan' })).toBeNull();
  });
});

// ── sanitizeFolder ───────────────────────────────────────────────────────────

describe('sanitizeFolder', () => {
  test('trims the name and assigns a fresh id', () => {
    const folder = context.sanitizeFolder({ id: 'old', name: '  Work  ' });
    expect(folder.name).toBe('Work');
    expect(folder.id).not.toBe('old');
  });

  test('rejects an unnamed folder', () => {
    expect(context.sanitizeFolder({ name: '   ' })).toBeNull();
  });

  test('truncates an overlong name', () => {
    expect(context.sanitizeFolder({ name: 'x'.repeat(500) }).name).toHaveLength(100);
  });
});

// ── export-data ──────────────────────────────────────────────────────────────

describe('handleMessage: export-data', () => {
  test('returns all four collections', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [] } });
    await sendMessage({ action: 'save-note', note: { title: 'N', content: 'body' } });
    await sendMessage({ action: 'save-task', task: { title: 'T' } });

    const data = await sendMessage({ action: 'export-data' });

    expect(data.bookmarks).toHaveLength(1);
    expect(data.notes).toHaveLength(1);
    expect(data.tasks).toHaveLength(1);
    expect(data.folders.length).toBeGreaterThan(0); // default folders are seeded
  });

  test('honours the include list and returns empty arrays for the rest', async () => {
    await sendMessage({ action: 'save-bookmark', bookmark: { url: 'https://a.com', title: 'A', tags: [] } });
    await sendMessage({ action: 'save-note', note: { title: 'N', content: 'body' } });

    const data = await sendMessage({ action: 'export-data', include: ['bookmarks'] });

    expect(data.bookmarks).toHaveLength(1);
    expect(data.notes).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.folders).toEqual([]);
  });
});

// ── import-data ──────────────────────────────────────────────────────────────

describe('handleMessage: import-data', () => {
  test('imports all four types in one call', async () => {
    const result = await sendMessage({
      action: 'import-data',
      data: {
        bookmarks: [{ url: 'https://a.com', title: 'A' }],
        notes:     [{ title: 'N', content: 'body' }],
        tasks:     [{ title: 'T' }],
        folders:   [{ id: 'f1', name: 'Imported' }],
      },
    });

    expect(result.counts.bookmarks).toBe(1);
    expect(result.counts.notes).toBe(1);
    expect(result.counts.tasks).toBe(1);
    expect(result.counts.folders).toBe(1);

    expect(await sendMessage({ action: 'get-bookmarks' })).toHaveLength(1);
    expect(await sendMessage({ action: 'get-notes' })).toHaveLength(1);
    expect(await sendMessage({ action: 'get-tasks' })).toHaveLength(1);
  });

  test('remaps folderId from the file onto the newly created folder', async () => {
    await sendMessage({
      action: 'import-data',
      data: {
        folders:   [{ id: 'file-folder-1', name: 'Research' }],
        bookmarks: [{ url: 'https://a.com', title: 'A', folderId: 'file-folder-1' }],
        notes:     [{ title: 'N', content: 'c', folderId: 'file-folder-1' }],
        tasks:     [{ title: 'T', folderId: 'file-folder-1' }],
      },
    });

    const folders = await sendMessage({ action: 'get-folders' });
    const research = folders.find(f => f.name === 'Research');
    expect(research).toBeDefined();
    expect(research.id).not.toBe('file-folder-1');

    const [bookmark] = await sendMessage({ action: 'get-bookmarks' });
    const [note]     = await sendMessage({ action: 'get-notes' });
    const [task]     = await sendMessage({ action: 'get-tasks' });
    expect(bookmark.folderId).toBe(research.id);
    expect(note.folderId).toBe(research.id);
    expect(task.folderId).toBe(research.id);
  });

  test('preserves nesting when a subfolder is imported', async () => {
    await sendMessage({
      action: 'import-data',
      data: {
        folders: [
          { id: 'child',  name: 'Papers', parentId: 'parent' },
          { id: 'parent', name: 'Research' },
        ],
      },
    });

    const folders = await sendMessage({ action: 'get-folders' });
    const parent = folders.find(f => f.name === 'Research');
    const child  = folders.find(f => f.name === 'Papers');
    expect(child.parentId).toBe(parent.id);
  });

  test('drops a folderId that matches nothing rather than dangling', async () => {
    await sendMessage({
      action: 'import-data',
      data: { bookmarks: [{ url: 'https://a.com', title: 'A', folderId: 'ghost-folder' }] },
    });

    const [bookmark] = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmark.folderId).toBeNull();
  });

  test('reuses an existing folder of the same name instead of duplicating it', async () => {
    const created = await sendMessage({ action: 'create-folder', name: 'Research' });
    const before  = (await sendMessage({ action: 'get-folders' })).length;

    await sendMessage({
      action: 'import-data',
      data: {
        folders:   [{ id: 'file-1', name: 'Research' }],
        bookmarks: [{ url: 'https://a.com', title: 'A', folderId: 'file-1' }],
      },
    });

    const after = await sendMessage({ action: 'get-folders' });
    expect(after).toHaveLength(before);

    const [bookmark] = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmark.folderId).toBe(created.id);
  });

  test('re-importing the same payload adds nothing the second time', async () => {
    const payload = {
      bookmarks: [{ url: 'https://a.com', title: 'A' }],
      notes:     [{ title: 'N', content: 'body' }],
      tasks:     [{ title: 'T', notes: 'detail' }],
      folders:   [{ id: 'f1', name: 'Imported' }],
    };

    await sendMessage({ action: 'import-data', data: payload });
    const second = await sendMessage({ action: 'import-data', data: payload });

    expect(second.counts.notes).toBe(0);
    expect(second.counts.tasks).toBe(0);
    expect(second.counts.folders).toBe(0);

    expect(await sendMessage({ action: 'get-notes' })).toHaveLength(1);
    expect(await sendMessage({ action: 'get-tasks' })).toHaveLength(1);
    expect(await sendMessage({ action: 'get-bookmarks' })).toHaveLength(1);
  });

  test('a note differing only in content is treated as new', async () => {
    await sendMessage({ action: 'import-data', data: { notes: [{ title: 'N', content: 'one' }] } });
    await sendMessage({ action: 'import-data', data: { notes: [{ title: 'N', content: 'two' }] } });
    expect(await sendMessage({ action: 'get-notes' })).toHaveLength(2);
  });

  test('skips invalid entries without failing the whole import', async () => {
    const result = await sendMessage({
      action: 'import-data',
      data: {
        bookmarks: [
          { url: 'javascript:alert(1)', title: 'bad scheme' },
          null,
          { url: 'https://good.com', title: 'good' },
        ],
        notes: [{ title: '' }, { title: 'keeper' }],
      },
    });

    expect(result.counts.bookmarks).toBe(1);
    expect(result.counts.notes).toBe(1);

    const [bookmark] = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmark.url).toBe('https://good.com');
  });

  test('handles a missing or malformed payload without throwing', async () => {
    const empty = {
      bookmarks: 0, notes: 0, tasks: 0, folders: 0,
      skipped: { bookmarks: 0, notes: 0, tasks: 0, folders: 0 },
    };
    expect((await sendMessage({ action: 'import-data' })).counts).toEqual(empty);
    expect((await sendMessage({ action: 'import-data', data: null })).counts).toEqual(empty);
    expect((await sendMessage({ action: 'import-data', data: [] })).counts).toEqual(empty);
    expect((await sendMessage({ action: 'import-data', data: { bookmarks: 'nope' } })).counts).toEqual(empty);
  });

  test('does not hang on a folder parent cycle', async () => {
    await sendMessage({
      action: 'import-data',
      data: {
        folders: [
          { id: 'a', name: 'A', parentId: 'b' },
          { id: 'b', name: 'B', parentId: 'a' },
        ],
      },
    });

    const folders = await sendMessage({ action: 'get-folders' });
    expect(folders.find(f => f.name === 'A')).toBeDefined();
    expect(folders.find(f => f.name === 'B')).toBeDefined();
  });
});

// ── Sparse imports must not erase curated metadata ───────────────────────────

describe('import-data: merging onto an existing bookmark', () => {
  const CURATED = {
    url: 'https://example.com/a',
    title: 'My Curated Title',
    tags: ['javascript', 'web-dev'],
    notes: 'Important notes I wrote',
    pinned: true,
    gtdStatus: 'next',
    contentType: 'read',
    urgency: 'high',
    importance: 'critical',
  };

  const saveCurated = () => sendMessage({ action: 'save-bookmark', bookmark: CURATED });

  test('a bare HTML-style record keeps the local metadata', async () => {
    await saveCurated();
    // What parseNetscapeHtml produces from a plain Chrome export.
    await sendMessage({
      action: 'import-data',
      data: { bookmarks: [{ url: CURATED.url, title: 'example.com', tags: [], notes: '' }] },
    });

    const [b] = await sendMessage({ action: 'get-bookmarks' });
    expect(b.tags).toEqual(['javascript', 'web-dev']);
    expect(b.notes).toBe('Important notes I wrote');
    expect(b.pinned).toBe(true);
    expect(b.gtdStatus).toBe('next');
    expect(b.contentType).toBe('read');
    expect(b.urgency).toBe('high');
    expect(b.importance).toBe('critical');
  });

  test('a value the file does carry still wins', async () => {
    await saveCurated();
    await sendMessage({
      action: 'import-data',
      data: { bookmarks: [{
        url: CURATED.url,
        title: 'A Better Title',
        tags: ['rust'],
        notes: 'replacement note',
        gtdStatus: 'waiting',
      }] },
    });

    const [b] = await sendMessage({ action: 'get-bookmarks' });
    expect(b.title).toBe('A Better Title');
    expect(b.tags).toEqual(['rust']);
    expect(b.notes).toBe('replacement note');
    expect(b.gtdStatus).toBe('waiting');
    // Untouched fields survive.
    expect(b.pinned).toBe(true);
    expect(b.importance).toBe('critical');
  });

  test('an explicit pinned:false in a TagMark export is honoured', async () => {
    await saveCurated();
    await sendMessage({
      action: 'import-data',
      data: { bookmarks: [{ url: CURATED.url, title: 'x', pinned: false }] },
    });
    expect((await sendMessage({ action: 'get-bookmarks' }))[0].pinned).toBe(false);
  });

  test('the id and createdAt of the existing bookmark are preserved', async () => {
    const saved = await saveCurated();
    await sendMessage({
      action: 'import-data',
      data: { bookmarks: [{ url: CURATED.url, title: 'other' }] },
    });

    const [b] = await sendMessage({ action: 'get-bookmarks' });
    expect(b.id).toBe(saved.id);
    expect(b.createdAt).toBe(saved.createdAt);
  });

  test('a full export round-trips over itself without losing anything', async () => {
    await saveCurated();
    const exported = await sendMessage({ action: 'export-data' });
    await sendMessage({ action: 'import-data', data: exported });

    const [b] = await sendMessage({ action: 'get-bookmarks' });
    expect(b.tags).toEqual(['javascript', 'web-dev']);
    expect(b.pinned).toBe(true);
    expect(b.gtdStatus).toBe('next');
    expect(b.urgency).toBe('high');
  });
});

// ── Distinct records that happen to share their text ─────────────────────────

describe('import-data: records with matching text but different metadata', () => {
  // TagMark lets you create two notes with the same title and body, so a
  // backup containing both has to restore both.
  test('two notes sharing title and content both survive a restore', async () => {
    await sendMessage({ action: 'save-note', note: { title: 'Meeting', content: 'agenda', tags: ['work'], pinned: true } });
    await new Promise(r => setTimeout(r, 5));
    await sendMessage({ action: 'save-note', note: { title: 'Meeting', content: 'agenda', tags: ['personal'] } });

    const data  = await sendMessage({ action: 'export-data' });
    const fresh = createBgContext();
    await fresh.sendMessage({ action: 'import-data', data });

    const notes = await fresh.sendMessage({ action: 'get-notes' });
    expect(notes).toHaveLength(2);
    expect(notes.map(n => n.tags.join()).sort()).toEqual(['personal', 'work']);
    expect(notes.find(n => n.tags.includes('work')).pinned).toBe(true);
  });

  test('two tasks sharing title and notes both survive a restore', async () => {
    await sendMessage({ action: 'save-task', task: { title: 'Review', notes: 'the doc', gtdStatus: 'next' } });
    await new Promise(r => setTimeout(r, 5));
    await sendMessage({ action: 'save-task', task: { title: 'Review', notes: 'the doc', gtdStatus: 'waiting' } });

    const data  = await sendMessage({ action: 'export-data' });
    const fresh = createBgContext();
    await fresh.sendMessage({ action: 'import-data', data });

    const tasks = await fresh.sendMessage({ action: 'get-tasks' });
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.gtdStatus).sort()).toEqual(['next', 'waiting']);
  });

  test('re-importing the same backup is still a no-op', async () => {
    await sendMessage({ action: 'save-note', note: { title: 'Meeting', content: 'agenda', tags: ['work'] } });
    await new Promise(r => setTimeout(r, 5));
    await sendMessage({ action: 'save-note', note: { title: 'Meeting', content: 'agenda', tags: ['personal'] } });

    const data  = await sendMessage({ action: 'export-data' });
    const fresh = createBgContext();
    await fresh.sendMessage({ action: 'import-data', data });
    const second = await fresh.sendMessage({ action: 'import-data', data });

    expect(second.counts.notes).toBe(0);
    expect(await fresh.sendMessage({ action: 'get-notes' })).toHaveLength(2);
  });

  test('a note differing only in pin state is kept', async () => {
    await sendMessage({
      action: 'import-data',
      data: { notes: [
        { title: 'N', content: 'c', createdAt: 1000, pinned: true },
        { title: 'N', content: 'c', createdAt: 1000, pinned: false },
      ] },
    });
    expect(await sendMessage({ action: 'get-notes' })).toHaveLength(2);
  });

  test('a genuinely identical record is still collapsed', async () => {
    const note = { title: 'N', content: 'c', createdAt: 1000, tags: ['x'], pinned: true };
    const result = await sendMessage({ action: 'import-data', data: { notes: [note, { ...note }] } });
    expect(result.counts.notes).toBe(1);
  });
});

describe('import-data: records with no timestamp in the file', () => {
  // Without a createdAt there is nothing to tell two same-text records apart,
  // so they collapse — and re-importing that file stays a no-op.
  const payload = { notes: [{ title: 'N', content: 'body' }], tasks: [{ title: 'T', notes: 'detail' }] };

  test('re-importing a timestamp-less file adds nothing the second time', async () => {
    await sendMessage({ action: 'import-data', data: payload });
    const second = await sendMessage({ action: 'import-data', data: payload });

    expect(second.counts.notes).toBe(0);
    expect(second.counts.tasks).toBe(0);
    expect(await sendMessage({ action: 'get-notes' })).toHaveLength(1);
    expect(await sendMessage({ action: 'get-tasks' })).toHaveLength(1);
  });

  test('a timestamp-less record matches one already saved', async () => {
    await sendMessage({ action: 'save-note', note: { title: 'N', content: 'body' } });
    const result = await sendMessage({ action: 'import-data', data: payload });
    expect(result.counts.notes).toBe(0);
    expect(await sendMessage({ action: 'get-notes' })).toHaveLength(1);
  });
});

// ── Same-named sibling folders ───────────────────────────────────────────────

describe('import-data: sibling folders with the same name', () => {
  test('two same-named siblings in one payload stay distinct', async () => {
    await sendMessage({
      action: 'import-data',
      data: {
        folders: [
          { id: 'f1', name: 'Work' },
          { id: 'f2', name: 'Work' },
        ],
        bookmarks: [
          { url: 'https://a.com', title: 'A', folderId: 'f1' },
          { url: 'https://b.com', title: 'B', folderId: 'f2' },
        ],
      },
    });

    const folders = (await sendMessage({ action: 'get-folders' })).filter(f => f.name === 'Work');
    expect(folders).toHaveLength(2);

    // The two bookmarks did not get merged into one folder.
    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    const a = bookmarks.find(b => b.url === 'https://a.com');
    const b = bookmarks.find(b => b.url === 'https://b.com');
    expect(a.folderId).not.toBe(b.folderId);
  });

  test('re-importing that payload still reuses rather than duplicating', async () => {
    const data = {
      folders: [{ id: 'f1', name: 'Work' }, { id: 'f2', name: 'Work' }],
    };
    await sendMessage({ action: 'import-data', data });
    const second = await sendMessage({ action: 'import-data', data });

    expect(second.counts.folders).toBe(0);
    expect((await sendMessage({ action: 'get-folders' })).filter(f => f.name === 'Work')).toHaveLength(2);
  });

  test('a single folder still matches an existing one of the same name', async () => {
    const created = await sendMessage({ action: 'create-folder', name: 'Research' });
    await sendMessage({
      action: 'import-data',
      data: {
        folders: [{ id: 'x', name: 'Research' }],
        bookmarks: [{ url: 'https://a.com', title: 'A', folderId: 'x' }],
      },
    });
    expect((await sendMessage({ action: 'get-bookmarks' }))[0].folderId).toBe(created.id);
  });
});

// ── Sync quota ───────────────────────────────────────────────────────────────

describe('import-data: folder sync quota', () => {
  // The whole folder tree lives under one chrome.storage.sync key, capped at
  // 8 KB, so a large browser export must degrade rather than fail outright.
  const manyFolders = n => Array.from({ length: n }, (_, i) => ({
    id: `file-folder-${i}`,
    name: `Imported Folder Number ${i}`,
    parentId: null,
  }));

  test('truncates an oversized folder tree instead of rejecting the import', async () => {
    const result = await sendMessage({
      action: 'import-data',
      data: {
        folders: manyFolders(400),
        bookmarks: [{ url: 'https://a.com', title: 'A', folderId: 'file-folder-0' }],
      },
    });

    expect(result.counts.skipped.folders).toBeGreaterThan(0);
    expect(result.counts.folders).toBeGreaterThan(0);
    // The bookmark still imports rather than being lost with the folders.
    expect(result.counts.bookmarks).toBe(1);
    expect(await sendMessage({ action: 'get-bookmarks' })).toHaveLength(1);
  });

  test('keeps the stored folder value inside the per-item quota', async () => {
    await sendMessage({ action: 'import-data', data: { folders: manyFolders(400) } });

    const stored = storage._data['tagmark_folders'];
    const bytes  = 'tagmark_folders'.length + JSON.stringify(stored).length;
    expect(bytes).toBeLessThanOrEqual(8192);
  });

  test('an item whose folder was skipped lands unfiled rather than dangling', async () => {
    const folders = manyFolders(400);
    const lastId  = folders[folders.length - 1].id;

    await sendMessage({
      action: 'import-data',
      data: {
        folders,
        bookmarks: [{ url: 'https://a.com', title: 'A', folderId: lastId }],
      },
    });

    const [bookmark] = await sendMessage({ action: 'get-bookmarks' });
    const storedIds  = new Set((await sendMessage({ action: 'get-folders' })).map(f => f.id));
    expect(bookmark.folderId === null || storedIds.has(bookmark.folderId)).toBe(true);
  });

  test('a normal-sized tree reports nothing skipped', async () => {
    const result = await sendMessage({ action: 'import-data', data: { folders: manyFolders(3) } });
    expect(result.counts.skipped.folders).toBe(0);
    expect(result.counts.folders).toBe(3);
  });
});

describe('import-data: collection index quota', () => {
  // Each collection's id index is a single sync item capped at 8 KB (~545
  // ids), so a large batch must truncate rather than have storageSet reject
  // the whole write.
  const manyNotes = n => Array.from({ length: n }, (_, i) => ({ title: `Note ${i}`, content: `body ${i}` }));
  const manyTasks = n => Array.from({ length: n }, (_, i) => ({ title: `Task ${i}`, notes: `detail ${i}` }));
  const manyBookmarks = n => Array.from({ length: n }, (_, i) => ({ url: `https://example.com/${i}`, title: `B${i}` }));

  const indexBytes = (storage, key) =>
    key.length + JSON.stringify(storage._data[key] || []).length;

  test('a huge note batch truncates and reports the remainder', async () => {
    const result = await sendMessage({ action: 'import-data', data: { notes: manyNotes(900) } });

    expect(result.counts.skipped.notes).toBeGreaterThan(0);
    expect(result.counts.notes).toBeGreaterThan(0);
    expect(indexBytes(storage, 'tagmark_index_note')).toBeLessThanOrEqual(8192);
    // Every id in the index resolves to a stored note.
    const notes = await sendMessage({ action: 'get-notes' });
    expect(notes).toHaveLength(result.counts.notes);
  });

  test('a huge task batch truncates and reports the remainder', async () => {
    const result = await sendMessage({ action: 'import-data', data: { tasks: manyTasks(900) } });

    expect(result.counts.skipped.tasks).toBeGreaterThan(0);
    expect(indexBytes(storage, 'tagmark_index_task')).toBeLessThanOrEqual(8192);
    expect(await sendMessage({ action: 'get-tasks' })).toHaveLength(result.counts.tasks);
  });

  test('a huge bookmark batch truncates and reports the remainder', async () => {
    const result = await sendMessage({ action: 'import-data', data: { bookmarks: manyBookmarks(900) } });

    expect(result.counts.skipped.bookmarks).toBeGreaterThan(0);
    expect(indexBytes(storage, 'tagmark_index')).toBeLessThanOrEqual(8192);
    expect(await sendMessage({ action: 'get-bookmarks' })).toHaveLength(result.counts.bookmarks);
  });

  test('a batch is bounded by total sync bytes, not just per-item size', async () => {
    // Each note is small enough on its own and the index would hold them all,
    // but together they exceed chrome.storage.sync's total quota.
    const fat = Array.from({ length: 540 }, (_, i) => ({
      title: `Note ${i}`,
      content: 'x'.repeat(300),
    }));

    const result = await sendMessage({ action: 'import-data', data: { notes: fat } });

    expect(result.counts.skipped.notes).toBeGreaterThan(0);
    expect(result.counts.notes).toBeGreaterThan(0);

    const totalBytes = Object.entries(storage._data)
      .reduce((sum, [k, v]) => sum + k.length + JSON.stringify(v).length, 0);
    expect(totalBytes).toBeLessThanOrEqual(102400);
  });

  test('the skipped count covers every omitted record, not just one', async () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ title: `Note ${i}`, content: `body ${i}` }));
    const result = await sendMessage({ action: 'import-data', data: { notes: many } });

    // Every input is either imported or counted as skipped.
    expect(result.counts.notes + result.counts.skipped.notes).toBe(900);
    expect(result.counts.skipped.notes).toBeGreaterThan(1);
  });

  test('a normal-sized batch reports nothing skipped', async () => {
    const result = await sendMessage({
      action: 'import-data',
      data: { notes: manyNotes(5), tasks: manyTasks(5), bookmarks: manyBookmarks(5) },
    });
    expect(result.counts.skipped).toEqual({ bookmarks: 0, notes: 0, tasks: 0, folders: 0 });
    expect(result.counts.notes).toBe(5);
    expect(result.counts.tasks).toBe(5);
    expect(result.counts.bookmarks).toBe(5);
  });

  test('updating existing bookmarks does not consume index room', async () => {
    await sendMessage({ action: 'import-data', data: { bookmarks: manyBookmarks(20) } });
    const result = await sendMessage({ action: 'import-data', data: { bookmarks: manyBookmarks(20) } });
    expect(result.counts.skipped.bookmarks).toBe(0);
    expect(await sendMessage({ action: 'get-bookmarks' })).toHaveLength(20);
  });
});

// ── Legacy compatibility ─────────────────────────────────────────────────────

describe('handleMessage: import-bookmarks (legacy)', () => {
  test('still imports a bare bookmarks array and returns a count', async () => {
    const result = await sendMessage({
      action: 'import-bookmarks',
      bookmarks: [{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com', title: 'B' }],
    });

    expect(result.count).toBe(2);
    expect(await sendMessage({ action: 'get-bookmarks' })).toHaveLength(2);
  });

  test('merges a duplicate URL rather than creating a second entry', async () => {
    await sendMessage({ action: 'import-bookmarks', bookmarks: [{ url: 'https://a.com', title: 'First' }] });
    await sendMessage({ action: 'import-bookmarks', bookmarks: [{ url: 'https://a.com', title: 'Second' }] });

    const bookmarks = await sendMessage({ action: 'get-bookmarks' });
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0].title).toBe('Second');
  });

  test('handles a null payload gracefully', async () => {
    expect((await sendMessage({ action: 'import-bookmarks', bookmarks: null })).count).toBe(0);
  });
});

// ── Round trip ───────────────────────────────────────────────────────────────

describe('export → import round trip', () => {
  test('a full export restores into an empty profile', async () => {
    const folder = await sendMessage({ action: 'create-folder', name: 'Research' });
    await sendMessage({
      action: 'save-bookmark',
      bookmark: { url: 'https://a.com', title: 'A', tags: ['js'], notes: 'hello', folderId: folder.id },
    });
    await sendMessage({ action: 'save-note', note: { title: 'N', content: 'body', tags: ['ideas'] } });
    await sendMessage({ action: 'save-task', task: { title: 'T', gtdStatus: 'next' } });

    const exported = await sendMessage({ action: 'export-data' });

    // Restore into a completely separate profile.
    const fresh = createBgContext();
    await fresh.sendMessage({ action: 'import-data', data: exported });

    const bookmarks = await fresh.sendMessage({ action: 'get-bookmarks' });
    const notes     = await fresh.sendMessage({ action: 'get-notes' });
    const tasks     = await fresh.sendMessage({ action: 'get-tasks' });
    const folders   = await fresh.sendMessage({ action: 'get-folders' });

    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0].url).toBe('https://a.com');
    expect(bookmarks[0].tags).toEqual(['js']);
    expect(bookmarks[0].notes).toBe('hello');

    expect(notes[0].title).toBe('N');
    expect(notes[0].content).toBe('body');
    expect(tasks[0].title).toBe('T');
    expect(tasks[0].gtdStatus).toBe('next');

    // The bookmark still sits in its folder after the id remap.
    const research = folders.find(f => f.name === 'Research');
    expect(bookmarks[0].folderId).toBe(research.id);
  });
});
