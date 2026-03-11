# TagMark — Tech Debt Register

Items are fixed one by one; each fix is committed and pushed, then the entry is removed from this file.

| # | File(s) | Issue |
|---|---------|-------|
| 7 | `popup.js`, `dashboard.js` | `escHtml`, `escAttr`, `tagColorIndex`, `getTheme`, `applyTheme`, `formatUrl` duplicated verbatim in both files — extract to `shared.js` |
