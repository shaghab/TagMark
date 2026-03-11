# TagMark — Tech Debt Register

Items are fixed one by one; each fix is committed and pushed, then the entry is removed from this file.

| # | File(s) | Issue |
|---|---------|-------|
| 5 | `dashboard.js:206` | Inline `style="cursor:pointer"` on active-filter tag chips — should be a CSS rule |
| 6 | `dashboard.js:340-341` | Favicon show/hide uses inline `style=` strings in `renderCard` instead of a CSS class |
| 7 | `popup.js`, `dashboard.js` | `escHtml`, `escAttr`, `tagColorIndex`, `getTheme`, `applyTheme`, `formatUrl` duplicated verbatim in both files — extract to `shared.js` |
