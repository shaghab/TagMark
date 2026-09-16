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
function createStorageMock(runtime) {
  const data = {};

  // Mirrors Chrome: the callback still runs, with runtime.lastError set for
  // the duration of that callback and cleared afterwards.
  function failWith(message, cb) {
    if (runtime) runtime.lastError = { message };
    if (cb) cb();
    if (runtime) delete runtime.lastError;
  }

  return {
    _data: data,

    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,

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

    // Chrome rejects the WHOLE set() when any single item exceeds
    // QUOTA_BYTES_PER_ITEM or the store would exceed QUOTA_BYTES, signalling
    // it through chrome.runtime.lastError rather than throwing. Enforcing that
    // here is what makes a missing quota check fail a test instead of passing
    // silently and only breaking in a real profile.
    set(items, cb) {
      const sizeOf = (k, v) => k.length + JSON.stringify(v).length;

      for (const [k, v] of Object.entries(items)) {
        if (sizeOf(k, v) > this.QUOTA_BYTES_PER_ITEM) {
          return failWith(`QUOTA_BYTES_PER_ITEM quota exceeded for key "${k}"`, cb);
        }
      }

      const merged = { ...data, ...items };
      const total = Object.entries(merged).reduce((sum, [k, v]) => sum + sizeOf(k, v), 0);
      if (total > this.QUOTA_BYTES) {
        return failWith('QUOTA_BYTES quota exceeded', cb);
      }

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
 * options.seed – storage entries written before background.js runs.
 *
 * Returns:
 *   context        – the vm sandbox (all top-level functions are properties)
 *   storage        – in-memory storage mock (inspect `._data` for raw values)
 *   sendMessage    – async helper to simulate a chrome.runtime message
 *   chrome         – the chrome API mock object
 *   msgListeners   – the raw array of registered onMessage listeners
 */
function createBgContext(options = {}) {
  const msgListeners = [];

  // chrome.runtime is built first so the storage mock can set lastError on it.
  const runtime = {
    id: 'tagmark-test-ext-id',
    onInstalled: { addListener: () => {} },
    onMessage:   { addListener: fn => msgListeners.push(fn) },
    getURL:      p => `chrome-extension://tagmark-test-ext-id/${p}`,
  };

  const storage = createStorageMock(runtime);

  // background.js reads storage as soon as it loads (it refreshes the badge),
  // so anything a test needs to be already present — legacy data for the
  // migration path, for instance — has to be seeded before that happens.
  if (options.seed) Object.assign(storage._data, options.seed);

  const chrome = {
    runtime,
    storage: { sync: storage },
    contextMenus: {
      create:    () => {},
      onClicked: { addListener: () => {} },
    },
    tabs: {
      // background.js calls this both callback-style and promise-style.
      query:       (_, cb) => (typeof cb === 'function' ? cb([]) : Promise.resolve([])),
      sendMessage: () => Promise.resolve(),
      get:         () => Promise.resolve({}),
      onActivated: { addListener: () => {} },
      onUpdated:   { addListener: () => {} },
    },
    action: {
      setBadgeText:            () => {},
      setBadgeBackgroundColor: () => {},
      setIcon:                 () => {},
    },
  };

  // Build the sandbox explicitly.  Object.assign copies only enumerable own
  // properties of `global`, which in Node.js excludes built-ins like URL, Date
  // and Promise (they are non-enumerable).  We therefore list them explicitly.
  const context = vm.createContext({
    chrome,
    // WHATWG URL (used by isValidUrl, sanitizeFavIconUrl, formatUrl)
    URL,
    // Web Crypto (used by generateId)
    crypto,
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
