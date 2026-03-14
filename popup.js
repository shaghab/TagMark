// TagMark Popup Script

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  const WINDOW_CLOSE_DELAY_MS = 900; // brief pause so the toast is visible before closing

  // ── State ─────────────────────────────────────────────────────────────────

  let currentTab = null;
  let existingBookmark = null;
  let allTags = [];
  let allFolders = [];
  let selectedTags = [];
  let isPinned = false;
  let gtdStatus = null;
  let contentType = null;
  let urgency = null;
  let importance = null;

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
  const gtdGroup       = $('gtdGroup');
  const typeGroup      = $('typeGroup');
  const urgencyGroup   = $('urgencyGroup');
  const importanceGroup = $('importanceGroup');

  // ── Tag chips ─────────────────────────────────────────────────────────────

  function renderChips() {
    renderTagChips(tagChips, selectedTags);
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
    tag = normalizeTag(tag);
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
    setTimeout(hideDropdown, BLUR_HIDE_DELAY_MS);
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
    ).slice(0, AC_MAX_ITEMS);
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

  // ── Pill groups (GTD / Type) ──────────────────────────────────────────────

  setupPillGroup(gtdGroup,        v => { gtdStatus = v; });
  setupPillGroup(typeGroup,       v => { contentType = v; });
  setupPillGroup(urgencyGroup,    v => { urgency = v; });
  setupPillGroup(importanceGroup, v => { importance = v; });

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
      pinned: isPinned,
      folderId: $('folderSelect').value || null,
      gtdStatus,
      contentType,
      urgency,
      importance
    };

    try {
      await chrome.runtime.sendMessage({ action: 'save-bookmark', bookmark });
      showToast(existingBookmark ? 'Bookmark updated!' : 'Bookmark saved!');
      setTimeout(() => window.close(), WINDOW_CLOSE_DELAY_MS);
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
      setTimeout(() => window.close(), WINDOW_CLOSE_DELAY_MS);
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
    toastTimer = setTimeout(() => toast.classList.remove('show'), TOAST_DURATION_MS);
  }

  // ── Folder select ─────────────────────────────────────────────────────────

  function populateFolderSelect() {
    const sel = $('folderSelect');
    sel.innerHTML = '<option value="">— No folder —</option>';
    const addOptions = (parentId, depth) => {
      allFolders
        .filter(f => f.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.id;
          opt.textContent = '\u00A0\u00A0'.repeat(depth * 2) + f.name;
          sel.appendChild(opt);
          addOptions(f.id, depth + 1);
        });
    };
    addOptions(null, 0);
  }

  // ── Load current tab ──────────────────────────────────────────────────────

  async function init() {
    applyTheme(getTheme());

    // Get all tags for autocomplete and folders for select
    try {
      [allTags, allFolders] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'get-all-tags' }),
        chrome.runtime.sendMessage({ action: 'get-folders' })
      ]);
      if (!Array.isArray(allTags)) allTags = [];
      if (!Array.isArray(allFolders)) allFolders = [];
    } catch {
      allTags = [];
      allFolders = [];
    }
    populateFolderSelect();

    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    // Populate page card
    pageTitle.textContent = tab.title || tab.url;
    pageUrl.textContent = formatUrl(tab.url);

    const safeFavIcon = sanitizeFavIconUrl(tab.favIconUrl || '');
    if (safeFavIcon) {
      pageFavicon.src = safeFavIcon;
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
      if (existingBookmark.folderId) {
        $('folderSelect').value = existingBookmark.folderId;
      }
      if (GTD_STATUSES.includes(existingBookmark.gtdStatus)) {
        gtdStatus = existingBookmark.gtdStatus;
        gtdGroup.querySelector(`[data-value="${existingBookmark.gtdStatus}"]`)?.classList.add('active');
      }
      if (CONTENT_TYPES.includes(existingBookmark.contentType)) {
        contentType = existingBookmark.contentType;
        typeGroup.querySelector(`[data-value="${existingBookmark.contentType}"]`)?.classList.add('active');
      }
      if (PRIORITY_LEVELS.includes(existingBookmark.urgency)) {
        urgency = existingBookmark.urgency;
        urgencyGroup.querySelector(`[data-value="${existingBookmark.urgency}"]`)?.classList.add('active');
      }
      if (PRIORITY_LEVELS.includes(existingBookmark.importance)) {
        importance = existingBookmark.importance;
        importanceGroup.querySelector(`[data-value="${existingBookmark.importance}"]`)?.classList.add('active');
      }
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

  // ── Boot ──────────────────────────────────────────────────────────────────

  init().catch(console.error);

})();
