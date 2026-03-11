// TagMark Dashboard Script

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let allBookmarks = [];
  let allTags = [];
  let selectedTagFilters = [];
  let activeFilter = 'all'; // 'all' | 'pinned'
  let searchQuery = '';
  let sortOrder = 'newest';
  let editTags = [];
  let editAcItems = [];
  let editAcActive = -1;

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  const sidebar          = $('sidebar');
  const sidebarToggle    = $('sidebarToggle');
  const filterAll        = $('filterAll');
  const filterPinned     = $('filterPinned');
  const allCount         = $('allCount');
  const pinnedCount      = $('pinnedCount');
  const tagFilterList    = $('tagFilterList');
  const searchInput      = $('searchInput');
  const sortSelect       = $('sortSelect');
  const activeFiltersRow = $('activeFilters');
  const activeTagChips   = $('activeTagChips');
  const clearFilters     = $('clearFilters');
  const loadingState     = $('loadingState');
  const bookmarkGrid     = $('bookmarkGrid');
  const emptyState       = $('emptyState');
  const emptyTitle       = $('emptyTitle');
  const emptyDesc        = $('emptyDesc');
  const modalOverlay     = $('modalOverlay');
  const closeModal       = $('closeModal');
  const cancelEdit       = $('cancelEdit');
  const editForm         = $('editForm');
  const editId           = $('editId');
  const editTitle        = $('editTitle');
  const editUrl          = $('editUrl');
  const editTagInputWrap = $('editTagInputWrap');
  const editTagChips     = $('editTagChips');
  const editTagInput     = $('editTagInput');
  const editAcDropdown   = $('editAcDropdown');
  const editNotes        = $('editNotes');
  const themeToggle      = $('themeToggle');
  const importBtn        = $('importBtn');
  const exportBtn        = $('exportBtn');
  const importFileInput  = $('importFileInput');
  const toast            = $('toast');

  // ── Theme ──────────────────────────────────────────────────────────────────

  themeToggle.addEventListener('click', () => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tagmark_theme', next);
    applyTheme(next);
    chrome.runtime.sendMessage({ action: 'save-settings', settings: { theme: next } });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'ftp:', 'file:'];

  function safeUrl(url) {
    try {
      const parsed = new URL(String(url));
      return ALLOWED_URL_SCHEMES.includes(parsed.protocol) ? url : '#';
    } catch {
      return '#';
    }
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── Load / refresh ─────────────────────────────────────────────────────────

  async function loadBookmarks() {
    try {
      allBookmarks = await chrome.runtime.sendMessage({ action: 'get-bookmarks' });
      allTags = [...new Set(allBookmarks.flatMap(b => b.tags))].sort();
    } catch (e) {
      allBookmarks = [];
      allTags = [];
    }
    renderSidebar();
    renderGrid();
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────

  function renderSidebar() {
    allCount.textContent = allBookmarks.length;
    pinnedCount.textContent = allBookmarks.filter(b => b.pinned).length;

    tagFilterList.innerHTML = '';
    const tagCounts = {};
    allBookmarks.forEach(b => b.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));

    [...allTags].sort().forEach(tag => {
      const ci = tagColorIndex(tag);
      const item = document.createElement('button');
      item.className = 'tag-filter-item' + (selectedTagFilters.includes(tag) ? ' active' : '');
      item.dataset.tag = tag;
      item.innerHTML = `<span class="tag-dot dot-${ci}"></span>${escHtml(tag)}<span class="tag-filter-count">${tagCounts[tag] || 0}</span>`;
      item.addEventListener('click', () => toggleTagFilter(tag));
      tagFilterList.appendChild(item);
    });
  }

  function toggleTagFilter(tag) {
    const idx = selectedTagFilters.indexOf(tag);
    if (idx >= 0) {
      selectedTagFilters.splice(idx, 1);
    } else {
      selectedTagFilters.push(tag);
    }
    renderSidebar();
    renderActiveFilters();
    renderGrid();
  }

  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });

  filterAll.addEventListener('click', () => {
    activeFilter = 'all';
    filterAll.classList.add('active');
    filterPinned.classList.remove('active');
    renderGrid();
  });

  filterPinned.addEventListener('click', () => {
    activeFilter = 'pinned';
    filterPinned.classList.add('active');
    filterAll.classList.remove('active');
    renderGrid();
  });

  clearFilters.addEventListener('click', () => {
    selectedTagFilters = [];
    renderSidebar();
    renderActiveFilters();
    renderGrid();
  });

  // ── Active filters row ─────────────────────────────────────────────────────

  function renderActiveFilters() {
    if (!selectedTagFilters.length) {
      activeFiltersRow.style.display = 'none';
      return;
    }
    activeFiltersRow.style.display = '';
    activeTagChips.innerHTML = selectedTagFilters.map(tag => {
      const ci = tagColorIndex(tag);
      return `<span class="tag-chip tc-${ci} active-filter-chip" data-tag="${escAttr(tag)}">
        ${escHtml(tag)} ×
      </span>`;
    }).join('');
    activeTagChips.querySelectorAll('.tag-chip').forEach(chip => {
      chip.addEventListener('click', () => toggleTagFilter(chip.dataset.tag));
    });
  }

  // ── Search & sort ──────────────────────────────────────────────────────────

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.toLowerCase().trim();
    renderGrid();
  });

  sortSelect.addEventListener('change', () => {
    sortOrder = sortSelect.value;
    renderGrid();
  });

  // ── Keyboard shortcut ─────────────────────────────────────────────────────

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === 'Escape' && modalOverlay.style.display !== 'none') {
      closeEditModal();
    }
  });

  // ── Grid rendering ─────────────────────────────────────────────────────────

  function getFilteredSorted() {
    let list = [...allBookmarks];

    // Filter by pinned view
    if (activeFilter === 'pinned') list = list.filter(b => b.pinned);

    // Filter by selected tags (AND logic)
    if (selectedTagFilters.length) {
      list = list.filter(b => selectedTagFilters.every(t => b.tags.includes(t)));
    }

    // Filter by search query
    if (searchQuery) {
      list = list.filter(b =>
        (b.title || '').toLowerCase().includes(searchQuery) ||
        (b.url || '').toLowerCase().includes(searchQuery) ||
        (b.notes || '').toLowerCase().includes(searchQuery) ||
        b.tags.some(t => t.includes(searchQuery))
      );
    }

    // Sort
    list.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      switch (sortOrder) {
        case 'oldest': return a.createdAt - b.createdAt;
        case 'alpha':  return (a.title||'').localeCompare(b.title||'');
        case 'alpha-desc': return (b.title||'').localeCompare(a.title||'');
        default:       return b.createdAt - a.createdAt; // newest
      }
    });

    return list;
  }

  function renderGrid() {
    loadingState.style.display = 'none';
    const filtered = getFilteredSorted();

    if (!filtered.length) {
      bookmarkGrid.style.display = 'none';
      emptyState.style.display = '';

      if (allBookmarks.length === 0) {
        emptyTitle.textContent = 'No bookmarks yet';
        emptyDesc.textContent = 'Click the TagMark icon in your toolbar to save your first bookmark.';
      } else if (searchQuery) {
        emptyTitle.textContent = 'No results found';
        emptyDesc.textContent = `No bookmarks match "${searchQuery}". Try a different search.`;
      } else if (selectedTagFilters.length) {
        emptyTitle.textContent = 'No bookmarks with these tags';
        emptyDesc.textContent = 'Try removing some filters to see more bookmarks.';
      } else if (activeFilter === 'pinned') {
        emptyTitle.textContent = 'No pinned bookmarks';
        emptyDesc.textContent = 'Star a bookmark from the card or popup to pin it here.';
      } else {
        emptyTitle.textContent = 'Nothing here';
        emptyDesc.textContent = 'Try adjusting your filters.';
      }
      return;
    }

    emptyState.style.display = 'none';
    bookmarkGrid.style.display = '';
    bookmarkGrid.innerHTML = filtered.map(b => renderCard(b)).join('');

    // Attach event listeners
    bookmarkGrid.querySelectorAll('.card-pin-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.preventDefault(); togglePin(btn.dataset.id); });
    });
    bookmarkGrid.querySelectorAll('.card-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.preventDefault(); openEditModal(btn.dataset.id); });
    });
    bookmarkGrid.querySelectorAll('.card-delete-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.preventDefault(); deleteBookmark(btn.dataset.id); });
    });
    bookmarkGrid.querySelectorAll('.card-tag').forEach(chip => {
      chip.addEventListener('click', () => {
        if (!selectedTagFilters.includes(chip.dataset.tag)) {
          selectedTagFilters.push(chip.dataset.tag);
          renderSidebar();
          renderActiveFilters();
          renderGrid();
        }
      });
    });
    bookmarkGrid.querySelectorAll('.card-favicon').forEach(img => {
      img.addEventListener('error', function () {
        this.classList.add('hidden');
        this.nextElementSibling.classList.remove('hidden');
      });
    });
  }

  function renderCard(b) {
    const faviconSrc = escAttr(b.favIconUrl || '');
    const faviconHiddenClass = b.favIconUrl ? '' : ' hidden';
    const faviconFallHiddenClass = b.favIconUrl ? ' hidden' : '';

    const tagsHtml = (b.tags || []).map(t => {
      const ci = tagColorIndex(t);
      return `<span class="tag-chip tc-${ci} card-tag" data-tag="${escAttr(t)}" title="Filter by ${escAttr(t)}">${escHtml(t)}</span>`;
    }).join('');

    const notesHtml = b.notes
      ? `<p class="card-notes">${escHtml(b.notes)}</p>`
      : '';

    return `
      <article class="bookmark-card${b.pinned ? ' pinned' : ''}" data-id="${escAttr(b.id)}">
        <div class="card-header">
          <img class="card-favicon${faviconHiddenClass}" src="${faviconSrc}" alt="" />
          <svg class="card-favicon-fallback${faviconFallHiddenClass}" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" stroke="currentColor" stroke-width="1.5"/>
          </svg>
          <div class="card-title-wrap">
            <a class="card-title" href="${escAttr(safeUrl(b.url))}" target="_blank" rel="noopener noreferrer" title="${escAttr(b.title || b.url)}">${escHtml(b.title || b.url)}</a>
            <p class="card-url">${escHtml(formatUrl(b.url))}</p>
          </div>
          <button class="card-action-btn card-pin-btn${b.pinned ? ' text-amber' : ''}" data-id="${escAttr(b.id)}" title="${b.pinned ? 'Unpin' : 'Pin'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${b.pinned ? '#f59e0b' : 'none'}" stroke="${b.pinned ? '#f59e0b' : 'currentColor'}" stroke-width="2">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
        ${notesHtml}
        <div class="card-footer">
          <span class="card-date">${formatDate(b.createdAt)}</span>
          <div class="card-actions">
            <button class="card-action-btn card-edit-btn" data-id="${escAttr(b.id)}" title="Edit">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="card-action-btn card-delete-btn delete" data-id="${escAttr(b.id)}" title="Delete">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3,6 5,6 21,6" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M10 11v6M14 11v6" stroke-linecap="round"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>
      </article>
    `;
  }

  // ── Pin toggle ─────────────────────────────────────────────────────────────

  async function togglePin(id) {
    await chrome.runtime.sendMessage({ action: 'toggle-pin', id });
    await loadBookmarks();
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function deleteBookmark(id) {
    const card = bookmarkGrid.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      await new Promise(r => setTimeout(r, 200));
    }
    await chrome.runtime.sendMessage({ action: 'delete-bookmark', id });
    await loadBookmarks();
    showToast('Bookmark deleted.');
  }

  // ── Edit modal ─────────────────────────────────────────────────────────────

  function openEditModal(id) {
    const b = allBookmarks.find(x => x.id === id);
    if (!b) return;

    editId.value = b.id;
    editTitle.value = b.title || '';
    editUrl.value = b.url || '';
    editNotes.value = b.notes || '';
    editTags = [...(b.tags || [])];
    renderEditChips();

    modalOverlay.style.display = '';
    setTimeout(() => editTitle.focus(), 100);
  }

  function closeEditModal() {
    modalOverlay.style.display = 'none';
    editTags = [];
    editAcItems = [];
    editAcActive = -1;
    editAcDropdown.style.display = 'none';
  }

  closeModal.addEventListener('click', closeEditModal);
  cancelEdit.addEventListener('click', closeEditModal);
  modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeEditModal();
  });

  editForm.addEventListener('submit', async e => {
    e.preventDefault();
    const id = editId.value;
    const b = allBookmarks.find(x => x.id === id);
    if (!b) return;

    const updated = {
      ...b,
      title: editTitle.value.trim() || b.url,
      url: editUrl.value.trim() || b.url,
      tags: [...editTags],
      notes: editNotes.value.trim()
    };

    await chrome.runtime.sendMessage({ action: 'update-bookmark', bookmark: updated });
    closeEditModal();
    await loadBookmarks();
    showToast('Bookmark updated!');
  });

  // ── Edit tag chips ─────────────────────────────────────────────────────────

  function renderEditChips() {
    editTagChips.innerHTML = '';
    editTags.forEach(tag => {
      const ci = tagColorIndex(tag);
      const chip = document.createElement('span');
      chip.className = `tag-chip tc-${ci}`;
      chip.innerHTML = `${escHtml(tag)}<button class="chip-remove" data-tag="${escAttr(tag)}" aria-label="Remove tag ${escAttr(tag)}">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
      </button>`;
      editTagChips.appendChild(chip);
    });
  }

  editTagInputWrap.addEventListener('click', e => {
    if (e.target.closest('.chip-remove')) {
      const tag = e.target.closest('.chip-remove').dataset.tag;
      editTags = editTags.filter(t => t !== tag);
      renderEditChips();
    } else {
      editTagInput.focus();
    }
  });

  editTagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = editTagInput.value.trim();
      if (val) addEditTag(val);
    } else if (e.key === 'Backspace' && !editTagInput.value && editTags.length) {
      editTags.pop();
      renderEditChips();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateEditDropdown(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateEditDropdown(-1);
    } else if (e.key === 'Escape') {
      hideEditDropdown();
    }
  });

  editTagInput.addEventListener('input', () => {
    showEditAutocomplete(editTagInput.value.trim().toLowerCase());
  });

  editTagInput.addEventListener('blur', () => {
    setTimeout(hideEditDropdown, 150);
  });

  function addEditTag(tag) {
    tag = tag.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag && !editTags.includes(tag)) {
      editTags.push(tag);
      renderEditChips();
    }
    editTagInput.value = '';
    hideEditDropdown();
  }

  function showEditAutocomplete(query) {
    if (!query) { hideEditDropdown(); return; }
    editAcItems = allTags.filter(t => t.includes(query) && !editTags.includes(t)).slice(0, 8);
    if (!editAcItems.length) { hideEditDropdown(); return; }
    editAcActive = -1;
    editAcDropdown.innerHTML = editAcItems.map((t, i) => {
      const ci = tagColorIndex(t);
      return `<div class="autocomplete-item" data-index="${i}">
        <span class="tag-dot dot-${ci}"></span>${escHtml(t)}
      </div>`;
    }).join('');
    editAcDropdown.style.display = '';
  }

  function hideEditDropdown() {
    editAcDropdown.style.display = 'none';
    editAcItems = [];
    editAcActive = -1;
  }

  function navigateEditDropdown(dir) {
    const items = editAcDropdown.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    items[editAcActive]?.classList.remove('active');
    editAcActive = Math.max(-1, Math.min(items.length - 1, editAcActive + dir));
    items[editAcActive]?.classList.add('active');
  }

  editAcDropdown.addEventListener('mousedown', e => {
    const item = e.target.closest('.autocomplete-item');
    if (item) {
      e.preventDefault();
      addEditTag(editAcItems[+item.dataset.index]);
    }
  });

  // ── Import / Export ────────────────────────────────────────────────────────

  exportBtn.addEventListener('click', async () => {
    try {
      const bookmarks = await chrome.runtime.sendMessage({ action: 'export-bookmarks' });
      const json = JSON.stringify(bookmarks, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tagmark-export-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${bookmarks.length} bookmarks.`);
    } catch {
      showToast('Export failed.');
    }
  });

  importBtn.addEventListener('click', () => importFileInput.click());

  importFileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const bookmarks = Array.isArray(data) ? data : data.bookmarks || [];
      if (!bookmarks.length) { showToast('No bookmarks found in file.'); return; }
      const result = await chrome.runtime.sendMessage({ action: 'import-bookmarks', bookmarks });
      showToast(`Imported ${result.count} bookmarks.`);
      await loadBookmarks();
    } catch {
      showToast('Import failed — invalid JSON.');
    }
    importFileInput.value = '';
  });

  // ── Live updates from background ───────────────────────────────────────────

  chrome.runtime.onMessage.addListener(message => {
    const refreshActions = ['bookmark-added', 'bookmark-deleted', 'bookmark-updated', 'bookmarks-imported'];
    if (refreshActions.includes(message.action)) {
      loadBookmarks();
    }
  });

  // ── Toast ──────────────────────────────────────────────────────────────────

  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  applyTheme(getTheme());
  loadBookmarks();

})();
