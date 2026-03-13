// TagMark shared utilities
// Loaded before popup.js and dashboard.js; functions are global.

'use strict';

// ── HTML escaping ────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Tag color ────────────────────────────────────────────────────────────────

function tagColorIndex(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  return Math.abs(hash) % 8;
}

// ── Theme ────────────────────────────────────────────────────────────────────

function getTheme() {
  return localStorage.getItem('tagmark_theme') || 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  const sun = toggle.querySelector('.sun-icon');
  const moon = toggle.querySelector('.moon-icon');
  if (theme === 'dark') {
    sun.style.display = 'none';
    moon.style.display = '';
  } else {
    sun.style.display = '';
    moon.style.display = 'none';
  }
}

// ── Pill group ────────────────────────────────────────────────────────────────

// Attaches a click handler to a pill-button group. Clicking an active button
// deselects it (calls setVal(null)); clicking an inactive button selects it.
function setupPillGroup(groupEl, setVal) {
  groupEl.addEventListener('click', e => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    const isActive = btn.classList.contains('active');
    groupEl.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
    if (!isActive) {
      btn.classList.add('active');
      setVal(btn.dataset.value);
    } else {
      setVal(null);
    }
  });
}

// ── GTD & Content Type ────────────────────────────────────────────────────────

const GTD_STATUSES  = ['next', 'later', 'someday', 'waiting', 'done', 'archived', 'dropped', 'reference'];
const CONTENT_TYPES = ['read', 'watch', 'listen', 'learn', 'try', 'create', 'build'];

// ── UI timing & limits ────────────────────────────────────────────────────────

const TOAST_DURATION_MS  = 2800; // how long toast notifications stay visible
const BLUR_HIDE_DELAY_MS = 150;  // delay before hiding autocomplete on input blur
const AC_MAX_ITEMS       = 8;    // max autocomplete suggestions shown at once

// ── Tag chips ─────────────────────────────────────────────────────────────────

// Renders tag chips into container. Click removal is handled by the caller via
// event delegation on the container's parent (tagInputWrap / editTagInputWrap).
function renderTagChips(container, tags) {
  container.innerHTML = '';
  tags.forEach(tag => {
    const ci = tagColorIndex(tag);
    const chip = document.createElement('span');
    chip.className = `tag-chip tc-${ci}`;
    chip.innerHTML =
      `${escHtml(tag)}<button class="chip-remove" data-tag="${escAttr(tag)}" aria-label="Remove tag ${escAttr(tag)}">` +
        `<svg width="10" height="10" viewBox="0 0 24 24" fill="none">` +
          `<line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>` +
          `<line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>` +
        `</svg></button>`;
    container.appendChild(chip);
  });
}

// ── Tag normalization ─────────────────────────────────────────────────────────

function normalizeTag(tag) {
  return String(tag).trim().toLowerCase().replace(/\s+/g, '-');
}

// ── URL formatting ───────────────────────────────────────────────────────────

function formatUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch { return url; }
}
