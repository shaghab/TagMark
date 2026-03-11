# CLAUDE.md — TagMark Chrome Extension

## Project Overview

**TagMark** is a vanilla JavaScript Chrome extension (Manifest V3) for bookmark management with tagging, annotation, and search capabilities. No build tools, no frameworks, no external dependencies — pure HTML, CSS, and JavaScript using native Chrome APIs.

> "Your bookmarks, with memory. Save, tag, annotate, and search your bookmarks."

---

## Repository Structure

```
TagMark/
├── manifest.json          # Chrome extension manifest (MV3)
├── background.js          # Service worker — data layer & cross-component messaging
├── popup.html             # Extension popup HTML (400px wide)
├── popup.js               # Popup logic — save/delete current page, tag autocomplete
├── popup.css              # Popup styles with dark mode support
├── dashboard.html         # Full management UI HTML
├── dashboard.js           # Dashboard logic — filter, sort, search, edit, import/export
├── dashboard.css          # Dashboard styles with dark mode support
└── icons/                 # Extension icons (16, 32, 48, 128 px PNG)
```

No `package.json`, no `node_modules`, no build step. All files are loaded directly by Chrome.

---

## Architecture

The extension follows a classic 3-component Chrome extension pattern:

```
┌─────────────────────────────────────────────────┐
│  User Interface Layer                           │
│  ┌─────────────┐     ┌───────────────────────┐ │
│  │  popup.html  │     │   dashboard.html       │ │
│  │  popup.js    │     │   dashboard.js         │ │
│  └──────┬──────┘     └──────────┬────────────┘ │
│         │  chrome.runtime.sendMessage           │
└─────────┼──────────────────────┼───────────────┘
          │                      │
┌─────────▼──────────────────────▼───────────────┐
│  background.js (Service Worker)                 │
│  - Message handler (all actions)               │
│  - Chrome Storage API (sync)                   │
│  - Context menu integration                    │
└─────────────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────┐
│  chrome.storage.sync                            │
│  Keys: tagmark_bookmarks, tagmark_settings      │
└─────────────────────────────────────────────────┘
```

### Message-Passing API

All data operations go through the background service worker via `chrome.runtime.sendMessage`. **Never** call `chrome.storage` directly from popup or dashboard.

**Actions supported by background.js**:

| Action | Payload | Description |
|--------|---------|-------------|
| `get-bookmarks` | — | Returns all bookmarks array |
| `save-bookmark` | `{ bookmark }` | Creates or updates (duplicate URL detection) |
| `delete-bookmark` | `{ id }` | Removes a bookmark by id |
| `update-bookmark` | `{ bookmark }` | Updates existing bookmark |
| `toggle-pin` | `{ id }` | Toggles pinned state |
| `get-all-tags` | — | Returns sorted unique tags array |
| `import-bookmarks` | `{ bookmarks }` | Merges with existing (dedupes by URL) |
| `export-bookmarks` | — | Returns all bookmarks for export |
| `get-settings` | — | Returns `{ theme }` |
| `save-settings` | `{ settings }` | Persists `{ theme }` |

**Background → UI notifications** (sent to all dashboard tabs on changes):

- `bookmark-added`
- `bookmark-deleted`
- `bookmark-updated`
- `bookmarks-imported`

---

## Data Model

### Bookmark Object

```javascript
{
  id: string,        // Unique ID: base36 timestamp + random chars, e.g. "aoi6k"
  url: string,       // Full URL, e.g. "https://example.com/path"
  title: string,     // Page title
  favIconUrl: string, // Favicon URL or data URI
  tags: string[],    // Lowercase, hyphen-separated, e.g. ["javascript", "web-dev"]
  notes: string,     // Free-form annotation text
  pinned: boolean,
  createdAt: number, // ms since epoch
  updatedAt: number  // ms since epoch
}
```

### Storage Keys (chrome.storage.sync)

- `tagmark_bookmarks` — Array of bookmark objects
- `tagmark_settings` — `{ theme: 'light' | 'dark' }`

### localStorage

- `tagmark_theme` — Mirrors the theme setting for fast UI init without async call

---

## Code Conventions

### JavaScript

- **No build tools, no transpilation** — write plain ES2020+ (Chrome supports it natively)
- **Strict mode**: every JS file begins with `'use strict';`
- **IIFE** wrapping for scope isolation in popup.js and dashboard.js
- **DOM shorthand**: `const $ = id => document.getElementById(id);`
- **Async/await** for all Chrome API calls
- **HTML escaping**: use `escHtml(str)` and `escAttr(str)` helpers before inserting user data into innerHTML — never skip this
- **Section comments**: use `// ── Section Name ──` style separators between logical blocks

### CSS

- **CSS custom properties** for all theme-sensitive values (colors, backgrounds, borders)
- **Dark mode** via `[data-theme="dark"]` attribute on `<html>` element — not `prefers-color-scheme`
- **BEM-like class naming**: `.bookmark-card`, `.card-header`, `.tag-chip`, `.modal-overlay`
- Smooth transitions on interactive elements (`transition: 0.2s`)
- **Tag colors**: 8-color palette assigned by `tagColorIndex(tag)` hash function — never assign colors directly

### Tags

- Always lowercase
- Spaces replaced with hyphens (normalization happens in input handlers)
- Stored as an array of strings on each bookmark
- The `get-all-tags` action returns them deduplicated and alphabetically sorted

---

## Key Functions Reference

### background.js

| Function | Purpose |
|----------|---------|
| `getBookmarks()` | Read bookmark array from chrome.storage.sync |
| `saveBookmarks(bookmarks)` | Write bookmark array to chrome.storage.sync |
| `saveBookmark(bookmark)` | Add or update one bookmark (duplicate URL → update) |
| `notifyDashboard(action)` | Send update message to all open dashboard tabs |

### popup.js

| Function | Purpose |
|----------|---------|
| `loadCurrentTab()` | Populate popup with active tab info |
| `loadExistingBookmark(url)` | Check if URL already saved, populate form |
| `addTag(tagText)` | Add tag chip to UI and internal array |
| `removeTag(index)` | Remove tag chip |
| `showSuggestions(query)` | Filter and display autocomplete dropdown |
| `showToast(msg, type)` | Show 2800ms notification ('success' or 'error') |

### dashboard.js

| Function | Purpose |
|----------|---------|
| `renderBookmarks()` | Apply filters/sort and render grid |
| `applyFilters()` | Filter by pinned state, active tags, and search query |
| `applySorting(arr)` | Sort by newest/oldest/a-z/z-a |
| `renderSidebar()` | Update tag list with counts |
| `openEditModal(bookmark)` | Populate and show edit modal |
| `tagColorIndex(tag)` | Hash tag string to 0–7 for color assignment |
| `escHtml(str)` / `escAttr(str)` | HTML sanitization helpers |
| `showToast(msg, type)` | 2800ms notification |

---

## Development Workflow

### Loading the Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the repository root directory

### Making Changes

1. Edit source files (no compilation needed)
2. Go to `chrome://extensions/`
3. Click the **refresh icon** on the TagMark card
4. Test in popup or dashboard

### Debugging

| Component | How to open DevTools |
|-----------|---------------------|
| Popup | Right-click popup → **Inspect** |
| Background worker | `chrome://extensions/` → click **"service worker"** link |
| Dashboard | Open dashboard page → F12 |

### Testing

There is currently no automated test suite. Manual testing checklist:
- Save bookmark from popup (new and duplicate URL)
- Delete bookmark from popup
- Right-click page → "Save to TagMark"
- Right-click link → "Save link to TagMark"
- Tag autocomplete (keyboard nav, comma/enter to add, backspace to remove)
- Dark/light theme toggle (popup and dashboard)
- Dashboard: filter by tag, filter pinned, search
- Dashboard: sort all 4 directions
- Dashboard: edit bookmark, toggle pin, delete
- Export bookmarks as JSON
- Import JSON file (merge behavior)
- Dashboard updates in real-time when popup saves a bookmark

---

## Extension Permissions

Declared in `manifest.json`:

| Permission | Reason |
|-----------|--------|
| `storage` | chrome.storage.sync for bookmarks and settings |
| `tabs` | Read active tab URL/title/favicon for saving |
| `contextMenus` | Right-click "Save to TagMark" menu items |
| `activeTab` | Access current tab data when popup opens |

---

## Things to Avoid

- **Never** call `chrome.storage` directly from popup.js or dashboard.js — always go through background message passing
- **Never** insert user-generated content (titles, URLs, notes, tags) into innerHTML without escaping via `escHtml()`/`escAttr()`
- **Never** add external dependencies, npm packages, or build steps — keep it dependency-free
- **Never** use `chrome.storage.local` — the extension uses `chrome.storage.sync` for cross-device sync
- **Never** store theme only in localStorage — always also persist to chrome.storage.sync via `save-settings`
- **Avoid** adding frameworks (React, Vue, etc.) — the vanilla JS approach is intentional for performance and simplicity

---

## Manifest V3 Notes

This extension uses **Manifest V3** (current Chrome standard):
- Background script runs as a **service worker** (`background.js`) — it can be terminated by Chrome at any time
- No persistent background page
- All state must be read from `chrome.storage` at the start of each service worker activation
- Use `chrome.runtime.onMessage` (not `chrome.extension.onMessage`)
- Context menus must be re-registered on `chrome.runtime.onInstalled` AND service worker startup
