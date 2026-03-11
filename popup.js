// TagMark Popup Script

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────

  let currentTab = null;
  let existingBookmark = null;
  let allTags = [];
  let selectedTags = [];
  let isPinned = false;

  // ── DOM refs ──────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);
  const app          = $('app');
  const themeToggle  = $('themeToggle');
  const openDash     = $('openDashboard');
  const pageFavicon  = $('pageFavicon');
  const faviconFall  = $('faviconFallback');
  const pageTitle    = $('pageTitle');
  const pageUrl      = $('pageUrl');
  const pinBtn       = $('pinBtn');
  const alreadySaved = $('alreadySaved');
  const tagInputWrap = $('tagInputWrap');
  const tagChips     = $('tagChips');
  const tagInput     = $('tagInput');
  const acDropdown   = $('autocompleteDropdown');
  const notesInput   = $('notesInput');
  const bookmarkForm = $('bookmarkForm');
  const saveBtn      = $('saveBtn');
  const deleteBtn    = $('deleteBtn');
  const toast        = $('toast');

  // ── Theme ─────────────────────────────────────────────────────────────────

  function getTheme() {
    return localStorage.getItem('tagmark_theme') || 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const sun = themeToggle.querySelector('.sun-icon');
    const moon = themeToggle.querySelector('.moon-icon');
    if (theme === 'dark') {
      sun.style.display = 'none';
      moon.style.display = '';
    } else {
      sun.style.display = '';
      moon.style.display = 'none';
    }
  }

  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tagmark_theme', next);
    applyTheme(next);
    chrome.runtime.sendMessage({ action: 'save-settings', settings: { theme: next } });
  }

  // ── Tag color ─────────────────────────────────────────────────────────────

  function tagColorIndex(tag) {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
    return Math.abs(hash) % 8;
  }

  // ── Tag chips ─────────────────────────────────────────────────────────────

  function renderChips() {
    tagChips.innerHTML = '';
    selectedTags.forEach(tag => {
      const ci = tagColorIndex(tag);
      const chip = document.createElement('span');
      chip.className = `tag-chip tc-${ci}`;
      chip.innerHTML = `${escHtml(tag)}<button class="chip-remove" data-tag="${escAttr(tag)}" aria-label="Remove tag ${escAttr(tag)}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg></button>`;
      tagChips.appendChild(chip);
    });
  }

  tagInputWrap.addEventListener('click', e => {
    if (e.target.closest('.chip-remove')) {
      const tag = e.target.closest('.chip-remove').dataset.tag;
      selectedTags = selectedTags.filter(t => t !== tag);
      renderChips();
    } else {
      tagInput.focus();
    }
  });

  function addTag(tag) {
    tag = tag.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag && !selectedTags.includes(tag)) {
      selectedTags.push(tag);
      renderChips();
    }
    tagInput.value = '';
    hideDropdown();
  }

  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = tagInput.value.trim();
      if (val) {
        addTag(val);
      } else if (e.key === 'Enter') {
        bookmarkForm.requestSubmit();
      }
    } else if (e.key === 'Backspace' && !tagInput.value && selectedTags.length) {
      selectedTags.pop();
      renderChips();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateDropdown(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateDropdown(-1);
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  tagInput.addEventListener('input', () => {
    showAutocomplete(tagInput.value.trim().toLowerCase());
  });

  tagInput.addEventListener('blur', () => {
    setTimeout(hideDropdown, 150);
  });

  // ── Autocomplete ──────────────────────────────────────────────────────────

  let acItems = [];
  let acActive = -1;

  function showAutocomplete(query) {
    if (!query) { hideDropdown(); return; }
    acItems = allTags.filter(t =>
      t.includes(query) &&
      !selectedTags.includes(t) &&
      t !== query
    ).slice(0, 8);
    if (!acItems.length) { hideDropdown(); return; }
    acActive = -1;
    acDropdown.innerHTML = acItems.map((t, i) => {
      const ci = tagColorIndex(t);
      return `<div class="autocomplete-item" data-index="${i}">
        <span class="tag-dot dot-${ci}"></span>${escHtml(t)}
      </div>`;
    }).join('');
    acDropdown.style.display = '';
  }

  function hideDropdown() {
    acDropdown.style.display = 'none';
    acItems = [];
    acActive = -1;
  }

  function navigateDropdown(dir) {
    const items = acDropdown.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    items[acActive]?.classList.remove('active');
    acActive = Math.max(-1, Math.min(items.length - 1, acActive + dir));
    items[acActive]?.classList.add('active');
  }

  acDropdown.addEventListener('mousedown', e => {
    const item = e.target.closest('.autocomplete-item');
    if (item) {
      e.preventDefault();
      addTag(acItems[+item.dataset.index]);
    }
  });

  // ── Pin button ────────────────────────────────────────────────────────────

  pinBtn.addEventListener('click', () => {
    isPinned = !isPinned;
    pinBtn.classList.toggle('pinned', isPinned);
    pinBtn.title = isPinned ? 'Unpin bookmark' : 'Pin bookmark';
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  openDash.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  });

  // ── Theme toggle ──────────────────────────────────────────────────────────

  themeToggle.addEventListener('click', toggleTheme);

  // ── Save form ─────────────────────────────────────────────────────────────

  bookmarkForm.addEventListener('submit', async e => {
    e.preventDefault();
    saveBtn.classList.add('saving');
    saveBtn.textContent = 'Saving…';

    const bookmark = {
      ...(existingBookmark || {}),
      url: currentTab.url,
      title: currentTab.title,
      favIconUrl: currentTab.favIconUrl || '',
      tags: [...selectedTags],
      notes: notesInput.value.trim(),
      pinned: isPinned
    };

    try {
      await chrome.runtime.sendMessage({ action: 'save-bookmark', bookmark });
      showToast(existingBookmark ? 'Bookmark updated!' : 'Bookmark saved!');
      setTimeout(() => window.close(), 900);
    } catch {
      showToast('Error saving bookmark.');
      saveBtn.classList.remove('saving');
      saveBtn.textContent = 'Save bookmark';
    }
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  deleteBtn.addEventListener('click', async () => {
    if (!existingBookmark) return;
    deleteBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ action: 'delete-bookmark', id: existingBookmark.id });
      showToast('Bookmark deleted.');
      setTimeout(() => window.close(), 900);
    } catch {
      showToast('Error deleting bookmark.');
      deleteBtn.disabled = false;
    }
  });

  // ── Toast ─────────────────────────────────────────────────────────────────

  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  // ── Load current tab ──────────────────────────────────────────────────────

  async function init() {
    applyTheme(getTheme());

    // Get all tags for autocomplete
    try {
      allTags = await chrome.runtime.sendMessage({ action: 'get-all-tags' });
    } catch { allTags = []; }

    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    // Populate page card
    pageTitle.textContent = tab.title || tab.url;
    pageUrl.textContent = formatUrl(tab.url);

    if (tab.favIconUrl) {
      pageFavicon.src = tab.favIconUrl;
      pageFavicon.style.display = '';
      faviconFall.style.display = 'none';
      pageFavicon.onerror = () => {
        pageFavicon.style.display = 'none';
        faviconFall.style.display = '';
      };
    } else {
      pageFavicon.style.display = 'none';
      faviconFall.style.display = '';
    }

    // Check if already saved
    try {
      const bookmarks = await chrome.runtime.sendMessage({ action: 'get-bookmarks' });
      existingBookmark = bookmarks.find(b => b.url === tab.url) || null;
    } catch { existingBookmark = null; }

    if (existingBookmark) {
      alreadySaved.style.display = '';
      selectedTags = [...(existingBookmark.tags || [])];
      notesInput.value = existingBookmark.notes || '';
      isPinned = existingBookmark.pinned || false;
      pinBtn.classList.toggle('pinned', isPinned);
      deleteBtn.style.display = '';

      // Re-label save button
      saveBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none">
        <polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg> Update bookmark`;

      renderChips();
    }

    // Disable form for chrome:// pages
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      saveBtn.disabled = true;
      saveBtn.title = 'Cannot bookmark this page';
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function formatUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname + (u.pathname !== '/' ? u.pathname : '');
    } catch { return url; }
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  init().catch(console.error);

})();
