'use strict';

/**
 * Test helper: loads background.js into an isolated vm sandbox with a mock
 * Chrome API so that unit tests can call its functions without a real browser.
 *
 * Strategy
 * --------
 * background.js is a plain script (no exports). When run via vm.runInContext
 * all top-level `function` declarations become properties of the sandbox
 * object, making them directly accessible in tests. `const`/`let` declarations
 * remain block-scoped to the script but are accessible through the closures of
 * those functions — which is exactly how the code works in production.
 */

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

const BG_PATH = path.resolve(__dirname, '../../background.js');

// ── Storage mock ─────────────────────────────────────────────────────────────

/**
 * Returns a minimal chrome.storage.sync mock that stores data in memory.
 * `._data` is exposed for direct inspection inside tests.
 */
function createStorageMock() {
  const data = {};
  return {
    _data: data,

    QUOTA_BYTES: 102400,

    get(keys, cb) {
      const result = {};
      if (Array.isArray(keys)) {
        keys.forEach(k => {
          if (Object.prototype.hasOwnProperty.call(data, k)) result[k] = data[k];
        });
      } else if (keys !== null && typeof keys === 'object') {
        Object.keys(keys).forEach(k => {
          result[k] = Object.prototype.hasOwnProperty.call(data, k) ? data[k] : keys[k];
        });
      } else if (typeof keys === 'string') {
        if (Object.prototype.hasOwnProperty.call(data, keys)) result[keys] = data[keys];
      }
      cb(result);
    },

    set(items, cb) {
      Object.assign(data, items);
      if (cb) cb();
    },

    remove(keys, cb) {
      const arr = Array.isArray(keys) ? keys : [keys];
      arr.forEach(k => delete data[k]);
      if (cb) cb();
    },

    getBytesInUse(keys, cb) {
      // Rough estimate: JSON-serialize all matching entries and count bytes.
      const entries = keys === null
        ? Object.entries(data)
        : (Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]]).filter(([, v]) => v !== undefined);
      const bytes = entries.reduce((sum, [k, v]) => sum + k.length + JSON.stringify(v).length, 0);
      cb(bytes);
    },
  };
}

// ── Context factory ───────────────────────────────────────────────────────────

/**
 * Loads background.js into an isolated vm context with a mocked Chrome API.
 *
 * Returns:
 *   context        – the vm sandbox (all top-level functions are properties)
 *   storage        – in-memory storage mock (inspect `._data` for raw values)
 *   sendMessage    – async helper to simulate a chrome.runtime message
 *   chrome         – the chrome API mock object
 *   msgListeners   – the raw array of registered onMessage listeners
 */
function createBgContext() {
  const storage      = createStorageMock();
  const msgListeners = [];

  const chrome = {
    runtime: {
      id: 'tagmark-test-ext-id',
      onInstalled: { addListener: () => {} },
      onMessage:   { addListener: fn => msgListeners.push(fn) },
      getURL:      p => `chrome-extension://tagmark-test-ext-id/${p}`,
    },
    storage: { sync: storage },
    contextMenus: {
      create:    () => {},
      onClicked: { addListener: () => {} },
    },
    tabs: {
      query:       (_, cb) => cb([]),
      sendMessage: () => Promise.resolve(),
    },
    action: {
      setBadgeText:            () => {},
      setBadgeBackgroundColor: () => {},
    },
  };

  // Build the sandbox explicitly.  Object.assign copies only enumerable own
  // properties of `global`, which in Node.js excludes built-ins like URL, Date
  // and Promise (they are non-enumerable).  We therefore list them explicitly.
  const context = vm.createContext({
    chrome,
    // WHATWG URL (used by isValidUrl, sanitizeFavIconUrl, formatUrl)
    URL,
    // Core language built-ins used by background.js
    Date,
    Math,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Boolean,
    String,
    Number,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    JSON,
    RegExp,
    // Node.js globals
    console,
    setTimeout,
    clearTimeout,
  });

  const code = fs.readFileSync(BG_PATH, 'utf8');
  vm.runInContext(code, context);

  /**
   * Simulates chrome.runtime.sendMessage from an extension-owned page.
   * The sender ID always matches chrome.runtime.id so the auth guard passes.
   */
  async function sendMessage(message) {
    if (!msgListeners.length) throw new Error('background.js registered no onMessage listener');
    return new Promise(resolve => {
      msgListeners[0](
        message,
        { id: 'tagmark-test-ext-id' },
        resolve,
      );
    });
  }

  return { context, storage, sendMessage, chrome, msgListeners };
}

module.exports = { createBgContext, createStorageMock };
