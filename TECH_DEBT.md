# TagMark — Tech Debt Register

Items are fixed one by one; each fix is committed and pushed, then the entry is removed from this file.

| # | File(s) | Issue |
|---|---------|-------|
| 3 | `popup.js:252`, `dashboard.js:620` | Toast duration mismatch: popup uses 2500 ms, dashboard uses 2800 ms |
| 4 | `background.js:23-51` | Context menu click handler calls `saveBookmark()` without try-catch; errors silently swallowed |
| 5 | `dashboard.js:206` | Inline `style="cursor:pointer"` on active-filter tag chips — should be a CSS rule |
| 6 | `dashboard.js:340-341` | Favicon show/hide uses inline `style=` strings in `renderCard` instead of a CSS class |
| 7 | `popup.js`, `dashboard.js` | `escHtml`, `escAttr`, `tagColorIndex`, `getTheme`, `applyTheme`, `formatUrl` duplicated verbatim in both files — extract to `shared.js` |
