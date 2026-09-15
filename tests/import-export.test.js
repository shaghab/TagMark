'use strict';

/**
 * Covers the multi-type import path added alongside the export options:
 * sanitizers for notes/tasks/folders, folder id remapping, dedupe behaviour,
 * and the export-data / import-data message actions.
 */

const { createBgContext } = require('./helpers/bg-context');

let context, sendMessage;

beforeEach(() => {
  ({ context, sendMessage } = createBgContext());
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
    const empty = { bookmarks: 0, notes: 0, tasks: 0, folders: 0 };
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
