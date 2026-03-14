'use strict';

/**
 * Unit tests for shared.js — pure utility functions.
 *
 * shared.js defines its functions as globals (no IIFE, no exports) so we load
 * it with vm.runInContext into a minimal sandbox that provides only the
 * built-ins those pure functions actually need.
 */

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

const sharedCode = fs.readFileSync(path.resolve(__dirname, '../shared.js'), 'utf8');

// Provide only the globals the pure functions need (no DOM, no localStorage).
const ctx = vm.createContext({ URL, String, Math, setTimeout, clearTimeout });
vm.runInContext(sharedCode, ctx);

const { escHtml, escAttr, tagColorIndex, formatUrl } = ctx;

// ── escHtml ───────────────────────────────────────────────────────────────────

describe('escHtml', () => {
  test('escapes & to &amp;', () => {
    expect(escHtml('a & b')).toBe('a &amp; b');
  });

  test('escapes < to &lt;', () => {
    expect(escHtml('<script>')).toBe('&lt;script&gt;');
  });

  test('escapes > to &gt;', () => {
    expect(escHtml('a > b')).toBe('a &gt; b');
  });

  test('escapes " to &quot;', () => {
    expect(escHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  test("escapes ' to &#39;", () => {
    expect(escHtml("it's")).toBe('it&#39;s');
  });

  test('escapes all five special characters together', () => {
    expect(escHtml('<a href="x" title=\'y\'>&</a>')).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  test('re-escapes an already-escaped entity (& in &amp; becomes &amp;)', () => {
    expect(escHtml('&amp;')).toBe('&amp;amp;');
  });

  test('coerces numbers to string', () => {
    expect(escHtml(42)).toBe('42');
  });

  test('coerces null to the string "null"', () => {
    expect(escHtml(null)).toBe('null');
  });

  test('returns an empty string unchanged', () => {
    expect(escHtml('')).toBe('');
  });

  test('does not escape plain text', () => {
    expect(escHtml('hello world')).toBe('hello world');
  });
});

// ── escAttr ───────────────────────────────────────────────────────────────────

describe('escAttr', () => {
  test('escapes " to &quot;', () => {
    expect(escAttr('say "hello"')).toBe('say &quot;hello&quot;');
  });

  test("escapes ' to &#39;", () => {
    expect(escAttr("it's")).toBe('it&#39;s');
  });

  test('does NOT escape < or > (only quote chars are escaped)', () => {
    expect(escAttr('<div>')).toBe('<div>');
  });

  test('does NOT escape &', () => {
    expect(escAttr('a & b')).toBe('a & b');
  });

  test('coerces non-strings', () => {
    expect(escAttr(0)).toBe('0');
    expect(escAttr(true)).toBe('true');
  });

  test('returns an empty string unchanged', () => {
    expect(escAttr('')).toBe('');
  });
});

// ── tagColorIndex ─────────────────────────────────────────────────────────────

describe('tagColorIndex', () => {
  test('returns an integer in the range [0, 7]', () => {
    const samples = ['javascript', 'python', 'rust', 'web-dev', 'a', 'z', '', 'foo-bar'];
    for (const tag of samples) {
      const idx = tagColorIndex(tag);
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(7);
    }
  });

  test('is deterministic — same tag always produces the same index', () => {
    expect(tagColorIndex('javascript')).toBe(tagColorIndex('javascript'));
    expect(tagColorIndex('web-dev')).toBe(tagColorIndex('web-dev'));
    expect(tagColorIndex('')).toBe(tagColorIndex(''));
  });

  test('returns a value within range for a single-character tag', () => {
    expect(tagColorIndex('a')).toBeGreaterThanOrEqual(0);
    expect(tagColorIndex('a')).toBeLessThanOrEqual(7);
  });

  test('produces at least two distinct indices across a set of common tags', () => {
    const tags = ['javascript', 'python', 'ruby', 'go', 'rust', 'java', 'swift', 'kotlin'];
    const indices = new Set(tags.map(tagColorIndex));
    expect(indices.size).toBeGreaterThan(1);
  });
});

// ── formatUrl ─────────────────────────────────────────────────────────────────

describe('formatUrl', () => {
  test('strips the trailing slash for a root URL', () => {
    expect(formatUrl('https://example.com/')).toBe('example.com');
  });

  test('returns hostname + path for a non-root URL', () => {
    expect(formatUrl('https://example.com/docs/guide')).toBe('example.com/docs/guide');
  });

  test('returns the raw string for an invalid URL', () => {
    expect(formatUrl('not-a-url')).toBe('not-a-url');
  });

  test('includes the hostname for URLs with query strings', () => {
    const result = formatUrl('https://example.com/search?q=test');
    expect(result).toContain('example.com');
  });

  test('works with http: URLs', () => {
    expect(formatUrl('http://example.com/path')).toBe('example.com/path');
  });

  test('returns a string for file: URLs without throwing', () => {
    const result = formatUrl('file:///home/user/doc.html');
    expect(typeof result).toBe('string');
  });
});

// ── normalizeTag ──────────────────────────────────────────────────────────────

const { normalizeTag } = ctx;

describe('normalizeTag', () => {
  test('lowercases the tag', () => {
    expect(normalizeTag('JAVASCRIPT')).toBe('javascript');
  });

  test('replaces spaces with hyphens', () => {
    expect(normalizeTag('web dev')).toBe('web-dev');
  });

  test('collapses multiple spaces into a single hyphen', () => {
    expect(normalizeTag('a  b   c')).toBe('a-b-c');
  });

  test('trims leading and trailing whitespace', () => {
    expect(normalizeTag('  react  ')).toBe('react');
  });

  test('lowercases and replaces spaces together', () => {
    expect(normalizeTag('  Web Dev  ')).toBe('web-dev');
  });

  test('passes through an already-normalized tag unchanged', () => {
    expect(normalizeTag('web-dev')).toBe('web-dev');
  });

  test('coerces numbers to string', () => {
    expect(normalizeTag(42)).toBe('42');
  });

  test('returns an empty string for an empty input', () => {
    expect(normalizeTag('')).toBe('');
  });
});

// ── debounce ──────────────────────────────────────────────────────────────────

const { debounce } = ctx;

describe('debounce', () => {
  // Use real timers: the vm context captures the real setTimeout at creation
  // time, so Jest fake timers do not control it.

  test('does not call the function immediately (synchronously)', () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 20);
    debounced();
    // No timer advance — fn must not have been called yet
    expect(fn).not.toHaveBeenCalled();
  });

  test('calls the function after the delay elapses', async () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 20);
    debounced();
    await new Promise(r => setTimeout(r, 40));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('resets the timer on repeated calls — only fires once', async () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 50);
    debounced();
    await new Promise(r => setTimeout(r, 20));
    debounced();
    await new Promise(r => setTimeout(r, 20));
    debounced();
    await new Promise(r => setTimeout(r, 70));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('passes arguments to the wrapped function', async () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 20);
    debounced('hello', 42);
    await new Promise(r => setTimeout(r, 40));
    expect(fn).toHaveBeenCalledWith('hello', 42);
  });

  test('can fire multiple times when separated by the full delay', async () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 20);
    debounced();
    await new Promise(r => setTimeout(r, 40));
    debounced();
    await new Promise(r => setTimeout(r, 40));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
