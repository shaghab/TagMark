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

// ── GTD & Content Type ────────────────────────────────────────────────────────

const GTD_STATUSES  = ['next', 'later', 'someday', 'waiting', 'done', 'archived', 'dropped', 'reference'];
const CONTENT_TYPES = ['read', 'watch', 'listen', 'learn', 'try', 'create', 'build'];

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
