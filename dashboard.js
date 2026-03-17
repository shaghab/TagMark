// TagMark Dashboard Script
// Copyright (c) 2026 Asim Ghaffar (github.com/shaghab)

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let allBookmarks = [];
  let allTags = [];
  let allFolders = [];
  let selectedTagFilters = [];
  let selectedDateFilter = null; // null | "YYYY" | "YYYY-M" | "YYYY-M-D"
  let selectedFolderFilter = null; // null | folder id
  let openFolderIds = new Set();
  let dateTreeOpenYears  = new Set();
  let dateTreeOpenMonths = new Set();
  let activeFilter = 'all'; // 'all' | 'pinned'
  let selectedGtdFilter  = null; // null | GTD_STATUSES value
  let selectedTypeFilter = null; // null | CONTENT_TYPES value
  let searchQuery = '';
  let sortOrder = 'newest';
  let editTags = [];
  let editGtdStatus = null;
  let editContentType = null;
  let editUrgency = null;
  let editImportance = null;
  let editAcItems = [];
  let editAcActive = -1;
  let tagSortOrder = 'recent'; // 'recent' | 'name' | 'count'
  let tagListExpanded = false;
  const TAG_LIMIT = 5;

  // Folder modal state
  let folderModalMode = null;   // 'new-root' | 'new-sub' | 'rename'
  let folderModalTargetId = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  const sidebar          = $('sidebar');
  const sidebarToggle    = $('sidebarToggle');
  const filterAll        = $('filterAll');
  const filterPinned     = $('filterPinned');
  const allCount         = $('allCount');
  const pinnedCount      = $('pinnedCount');
  const tagFilterList    = $('tagFilterList');
  const dateFilterTree   = $('dateFilterTree');
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
  const gtdFilterList    = $('gtdFilterList');
  const typeFilterList   = $('typeFilterList');
  const themeToggle      = $('themeToggle');
  const importBtn        = $('importBtn');
  const exportBtn        = $('exportBtn');
  const importFileInput  = $('importFileInput');
  const toast            = $('toast');
  const storageMeterFill  = $('storageMeterFill');
  const storageMeterLabel = $('storageMeterLabel');

  // ── Theme ──────────────────────────────────────────────────────────────────

  themeToggle.addEventListener('click', toggleTheme);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

  // Returns { action, score } for a bookmark based on the decision matrix.
  // action is one of: 'do-now' | 'do' | 'schedule' | 'delegate' | 'incubate' | 'ignore'
  // score allows sorting within the same action bucket (higher = more important).
  function calcScore(b) {
    const imp = PRIORITY_RANK[b.importance] || 0;
    const urg = PRIORITY_RANK[b.urgency]    || 0;

    let action;
    if (imp >= 3) {
      // Critical or High importance
      if (urg === 4)      action = 'do-now';
      else if (urg === 3) action = 'do';
      else                action = 'schedule';
    } else if (imp === 2) {
      // Medium importance
      if (urg === 4)      action = 'do';
      else if (urg === 3) action = 'schedule';
      else                action = 'incubate';
    } else if (imp === 1) {
      // Low importance
      if (urg >= 3)       action = 'delegate';
      else if (urg === 2) action = 'incubate';
      else                action = 'ignore';
    } else {
      // No importance
      if (urg >= 3)       action = 'delegate';
      else                action = 'ignore';
    }

    const BASE = { 'do-now': 600, 'do': 500, 'schedule': 400, 'delegate': 300, 'incubate': 200, 'ignore': 100 };
    const score = BASE[action] + imp * 5 + urg;
    return { action, score };
  }

  const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

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
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── Load / refresh ─────────────────────────────────────────────────────────

  async function loadBookmarks() {
    try {
      [allBookmarks, allFolders] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'get-bookmarks' }),
        chrome.runtime.sendMessage({ action: 'get-folders' })
      ]);
      if (!Array.isArray(allFolders)) allFolders = [];
      allTags = [...new Set(allBookmarks.flatMap(b => b.tags))].sort();
    } catch (e) {
      allBookmarks = [];
      allTags = [];
      allFolders = [];
      console.error('[TagMark] loadBookmarks failed:', e);
      showToast('Could not load bookmarks. Try reloading the page.', 'error');
    }
    renderSidebar();
    renderGtdFilter();
    renderTypeFilter();
    renderDateTree();
    renderFolderTree();
    renderGrid();
    updateStorageMeter();
  }

  // ── Storage meter ──────────────────────────────────────────────────────────

  let _lastQuotaWarnPct = 0; // suppress repeat toasts within a session

  async function updateStorageMeter() {
    try {
      const { bytesInUse, quota } = await chrome.runtime.sendMessage({ action: 'get-storage-usage' });
      const pct = Math.min(100, Math.round((bytesInUse / quota) * 100));
      const used  = (bytesInUse / 1024).toFixed(1);
      const total = Math.round(quota / 1024);
      storageMeterFill.style.width = pct + '%';
      storageMeterFill.classList.toggle('warn',   pct >= 60 && pct < 85);
      storageMeterFill.classList.toggle('danger', pct >= 85);
      storageMeterLabel.textContent = `${used} KB / ${total} KB sync (${pct}%)`;

      // Warn once per threshold crossing so the user knows to act (A09).
      if (pct >= 95 && _lastQuotaWarnPct < 95) {
        showToast('Sync storage almost full (≥95%). Export and delete old bookmarks.', 'error');
      } else if (pct >= 80 && _lastQuotaWarnPct < 80) {
        showToast('Sync storage over 80% full. Consider exporting a backup.', 'error');
      }
      _lastQuotaWarnPct = pct;
    } catch {
      storageMeterLabel.textContent = 'Sync storage unavailable';
    }
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────

  function renderSidebar() {
    allCount.textContent = allBookmarks.length;
    pinnedCount.textContent = allBookmarks.filter(b => b.pinned).length;

    // Build counts and recency per tag
    const tagCounts = {};
    const tagRecency = {};
    allBookmarks.forEach(b => {
      const ts = b.updatedAt || b.createdAt || 0;
      b.tags.forEach(t => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
        if (!tagRecency[t] || ts > tagRecency[t]) tagRecency[t] = ts;
      });
    });

    // Sort tags according to current tagSortOrder
    const sorted = [...allTags].sort((a, b) => {
      if (tagSortOrder === 'count') return (tagCounts[b] || 0) - (tagCounts[a] || 0);
      if (tagSortOrder === 'name')  return a.localeCompare(b);
      // 'recent': most recently used first
      return (tagRecency[b] || 0) - (tagRecency[a] || 0);
    });

    const total = sorted.length;
    const visible = tagListExpanded ? sorted : sorted.slice(0, TAG_LIMIT);

    tagFilterList.innerHTML = '';

    // Sort controls
    const sortBar = document.createElement('div');
    sortBar.className = 'tag-sort-bar';
    ['recent', 'name', 'count'].forEach(order => {
      const btn = document.createElement('button');
      btn.className = 'tag-sort-btn' + (tagSortOrder === order ? ' active' : '');
      btn.textContent = order === 'recent' ? 'Recent' : order === 'name' ? 'Name' : 'Count';
      btn.addEventListener('click', () => {
        tagSortOrder = order;
        renderSidebar();
      });
      sortBar.appendChild(btn);
    });
    tagFilterList.appendChild(sortBar);

    // Tag items
    visible.forEach(tag => {
      const ci = tagColorIndex(tag);
      const item = document.createElement('button');
      item.className = 'tag-filter-item' + (selectedTagFilters.includes(tag) ? ' active' : '');
      item.dataset.tag = tag;
      item.innerHTML = `<span class="tag-dot dot-${ci}"></span>${escHtml(tag)}<span class="tag-filter-count">${tagCounts[tag] || 0}</span>`;
      item.addEventListener('click', () => toggleTagFilter(tag));
      tagFilterList.appendChild(item);
    });

    // More / Less toggle
    if (total > TAG_LIMIT) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'tag-more-btn';
      if (tagListExpanded) {
        moreBtn.textContent = 'Less';
      } else {
        moreBtn.textContent = `More (${total - TAG_LIMIT})`;
      }
      moreBtn.addEventListener('click', () => {
        tagListExpanded = !tagListExpanded;
        renderSidebar();
      });
      tagFilterList.appendChild(moreBtn);
    }
  }

  // ── GTD & Type sidebar filters ─────────────────────────────────────────────

  function renderGtdFilter() {
    const counts = {};
    allBookmarks.forEach(b => {
      if (b.gtdStatus) counts[b.gtdStatus] = (counts[b.gtdStatus] || 0) + 1;
    });
    gtdFilterList.innerHTML = '';
    GTD_STATUSES.forEach(status => {
      const count = counts[status] || 0;
      const item = document.createElement('button');
      item.className = 'status-filter-item gtd-item ' + (GTD_CSS_CLASS[status] || '') + (selectedGtdFilter === status ? ' active' : '');
      item.dataset.value = status;
      item.innerHTML = `<span class="status-dot"></span>${escHtml(status.charAt(0).toUpperCase() + status.slice(1))}<span class="tag-filter-count">${count}</span>`;
      item.addEventListener('click', () => {
        selectedGtdFilter = selectedGtdFilter === status ? null : status;
        renderGtdFilter();
        refreshMain();
      });
      gtdFilterList.appendChild(item);
    });
  }

  function renderTypeFilter() {
    const counts = {};
    allBookmarks.forEach(b => {
      if (b.contentType) counts[b.contentType] = (counts[b.contentType] || 0) + 1;
    });
    typeFilterList.innerHTML = '';
    CONTENT_TYPES.forEach(type => {
      const count = counts[type] || 0;
      const item = document.createElement('button');
      item.className = 'status-filter-item type-item ' + (TYPE_CSS_CLASS[type] || '') + (selectedTypeFilter === type ? ' active' : '');
      item.dataset.value = type;
      item.innerHTML = `<span class="status-dot"></span>${escHtml(type.charAt(0).toUpperCase() + type.slice(1))}<span class="tag-filter-count">${count}</span>`;
      item.addEventListener('click', () => {
        selectedTypeFilter = selectedTypeFilter === type ? null : type;
        renderTypeFilter();
        refreshMain();
      });
      typeFilterList.appendChild(item);
    });
  }

  // ── Date tree ──────────────────────────────────────────────────────────────

  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];

  function buildDateTree() {
    // Returns { year: { month: { day: count } } }
    const tree = {};
    allBookmarks.forEach(b => {
      const d = new Date(b.createdAt);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      if (!tree[y]) tree[y] = {};
      if (!tree[y][m]) tree[y][m] = {};
      tree[y][m][day] = (tree[y][m][day] || 0) + 1;
    });
    return tree;
  }

  function monthTotal(monthObj) {
    return Object.values(monthObj).reduce((s, n) => s + n, 0);
  }

  function yearTotal(yearObj) {
    return Object.values(yearObj).reduce((s, mo) => s + monthTotal(mo), 0);
  }

  function formatDateFilter(filter) {
    const parts = filter.split('-');
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${MONTH_NAMES[+parts[1] - 1]} ${parts[0]}`;
    return `${MONTH_NAMES[+parts[1] - 1]} ${parts[2]}, ${parts[0]}`;
  }

  function renderDateTree() {
    const tree = buildDateTree();
    const years = Object.keys(tree).sort((a, b) => b - a);

    // Auto-open most recent year on first load
    if (years.length && !dateTreeOpenYears.size) {
      dateTreeOpenYears.add(years[0]);
    }

    dateFilterTree.innerHTML = '';

    years.forEach(year => {
      const yearKey = String(year);
      const isYearOpen = dateTreeOpenYears.has(yearKey);
      const isYearActive = selectedDateFilter === yearKey;
      const yTotal = yearTotal(tree[year]);

      // Year row
      const yearBtn = document.createElement('button');
      yearBtn.className = 'date-node date-year-node' + (isYearActive ? ' active' : '');
      yearBtn.innerHTML =
        `<span class="date-arrow${isYearOpen ? ' open' : ''}">` +
          `<svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
        `</span>` +
        `<span class="date-node-label">${escHtml(year)}</span>` +
        `<span class="date-node-count">${yTotal}</span>`;
      yearBtn.addEventListener('click', () => {
        isYearOpen ? dateTreeOpenYears.delete(yearKey) : dateTreeOpenYears.add(yearKey);
        selectedDateFilter = isYearActive ? null : yearKey;
        renderDateTree();
        refreshMain();
      });
      dateFilterTree.appendChild(yearBtn);

      if (!isYearOpen) return;

      // Month rows
      const months = Object.keys(tree[year]).sort((a, b) => b - a);
      months.forEach(month => {
        const monthKey = `${year}-${month}`;
        const isMonthOpen = dateTreeOpenMonths.has(monthKey);
        const isMonthActive = selectedDateFilter === monthKey;
        const mTotal = monthTotal(tree[year][month]);

        const monthBtn = document.createElement('button');
        monthBtn.className = 'date-node date-month-node' + (isMonthActive ? ' active' : '');
        monthBtn.innerHTML =
          `<span class="date-arrow${isMonthOpen ? ' open' : ''}">` +
            `<svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
          `</span>` +
          `<span class="date-node-label">${escHtml(MONTH_NAMES[+month - 1])}</span>` +
          `<span class="date-node-count">${mTotal}</span>`;
        monthBtn.addEventListener('click', e => {
          e.stopPropagation();
          isMonthOpen ? dateTreeOpenMonths.delete(monthKey) : dateTreeOpenMonths.add(monthKey);
          selectedDateFilter = isMonthActive ? null : monthKey;
          renderDateTree();
          refreshMain();
        });
        dateFilterTree.appendChild(monthBtn);

        if (!isMonthOpen) return;

        // Day rows
        const days = Object.keys(tree[year][month]).sort((a, b) => b - a);
        days.forEach(day => {
          const dayKey = `${year}-${month}-${day}`;
          const isDayActive = selectedDateFilter === dayKey;
          const dCount = tree[year][month][day];

          const dayBtn = document.createElement('button');
          dayBtn.className = 'date-node date-day-node' + (isDayActive ? ' active' : '');
          dayBtn.innerHTML =
            `<span class="date-node-label">${escHtml(MONTH_NAMES[+month - 1])} ${escHtml(day)}</span>` +
            `<span class="date-node-count">${dCount}</span>`;
          dayBtn.addEventListener('click', e => {
            e.stopPropagation();
            selectedDateFilter = isDayActive ? null : dayKey;
            renderDateTree();
            refreshMain();
          });
          dateFilterTree.appendChild(dayBtn);
        });
      });
    });
  }

  // ── Folder helpers ──────────────────────────────────────────────────────────

  function getFolderDescendantIds(folderId) {
    const ids = new Set([folderId]);
    const collect = id => {
      allFolders.filter(f => f.parentId === id).forEach(f => {
        ids.add(f.id);
        collect(f.id);
      });
    };
    collect(folderId);
    return ids;
  }

  function getFolderPath(folderId) {
    const path = [];
    let current = allFolders.find(f => f.id === folderId);
    while (current) {
      path.unshift(current.name);
      current = current.parentId ? allFolders.find(f => f.id === current.parentId) : null;
    }
    return path;
  }

  function getFolderBookmarkCount(folderId) {
    const ids = getFolderDescendantIds(folderId);
    return allBookmarks.filter(b => ids.has(b.folderId)).length;
  }

  // ── Folder tree ─────────────────────────────────────────────────────────────

  function renderFolderTree() {
    const container = $('folderTree');
    container.innerHTML = '';

    const roots = allFolders.filter(f => !f.parentId).sort((a, b) => a.name.localeCompare(b.name));

    function renderNode(folder, depth) {
      const children = allFolders.filter(f => f.parentId === folder.id).sort((a, b) => a.name.localeCompare(b.name));
      const hasChildren = children.length > 0;
      const isOpen = openFolderIds.has(folder.id);
      const isActive = selectedFolderFilter === folder.id;
      const count = getFolderBookmarkCount(folder.id);

      const row = document.createElement('div');
      row.className = 'folder-node-row' + (isActive ? ' active' : '');
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.innerHTML =
        `<span class="folder-arrow${hasChildren ? '' : ' folder-arrow-hidden'}${isOpen ? ' open' : ''}">` +
          `<svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
        `</span>` +
        `<svg class="folder-icon" width="13" height="13" viewBox="0 0 24 24" fill="none">` +
          `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>` +
        `</svg>` +
        `<span class="folder-name">${escHtml(folder.name)}</span>` +
        `<span class="folder-node-count">${count}</span>` +
        `<div class="folder-row-actions">` +
          `<button class="folder-action-btn" data-action="add-sub" data-id="${escAttr(folder.id)}" title="New subfolder">` +
            `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>` +
          `</button>` +
          `<button class="folder-action-btn" data-action="rename" data-id="${escAttr(folder.id)}" title="Rename">` +
            `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>` +
          `</button>` +
          `<button class="folder-action-btn delete" data-action="delete" data-id="${escAttr(folder.id)}" title="Delete">` +
            `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><polyline points="3,6 5,6 21,6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>` +
          `</button>` +
        `</div>`;

      row.addEventListener('click', e => {
        const actionBtn = e.target.closest('.folder-action-btn');
        if (actionBtn) {
          e.stopPropagation();
          handleFolderAction(actionBtn.dataset.action, actionBtn.dataset.id);
          return;
        }
        if (hasChildren && e.target.closest('.folder-arrow')) {
          isOpen ? openFolderIds.delete(folder.id) : openFolderIds.add(folder.id);
          renderFolderTree();
          return;
        }
        selectedFolderFilter = isActive ? null : folder.id;
        renderFolderTree();
        refreshMain();
      });

      container.appendChild(row);

      if (hasChildren && isOpen) {
        children.forEach(child => renderNode(child, depth + 1));
      }
    }

    roots.forEach(f => renderNode(f, 0));
  }

  // ── Folder management ───────────────────────────────────────────────────────

  function openFolderModal(mode, targetId) {
    folderModalMode = mode;
    folderModalTargetId = targetId || null;
    const titleEl = $('folderModalTitle');
    const submitEl = $('folderSubmitBtn');
    const nameInput = $('folderNameInput');
    if (mode === 'rename') {
      const folder = allFolders.find(f => f.id === targetId);
      titleEl.textContent = 'Rename Folder';
      submitEl.textContent = 'Rename';
      nameInput.value = folder ? folder.name : '';
    } else {
      titleEl.textContent = mode === 'new-sub' ? 'New Subfolder' : 'New Folder';
      submitEl.textContent = 'Create';
      nameInput.value = '';
    }
    $('folderModalOverlay').style.display = '';
    setTimeout(() => nameInput.focus(), 80);
  }

  function closeFolderModal() {
    $('folderModalOverlay').style.display = 'none';
    folderModalMode = null;
    folderModalTargetId = null;
  }

  async function handleFolderAction(action, folderId) {
    if (action === 'rename') {
      openFolderModal('rename', folderId);
    } else if (action === 'add-sub') {
      openFolderIds.add(folderId);
      openFolderModal('new-sub', folderId);
    } else if (action === 'delete') {
      const folder = allFolders.find(f => f.id === folderId);
      if (!folder) return;
      const descendants = getFolderDescendantIds(folderId);
      const affected = allBookmarks.filter(b => descendants.has(b.folderId)).length;
      const confirmMsg = affected > 0
        ? `Delete "${folder.name}" and all subfolders? ${affected} bookmark(s) will be unassigned.`
        : `Delete folder "${folder.name}"?`;
      if (!confirm(confirmMsg)) return;
      await chrome.runtime.sendMessage({ action: 'delete-folder', id: folderId });
      if (selectedFolderFilter && descendants.has(selectedFolderFilter)) {
        selectedFolderFilter = null;
      }
      await loadBookmarks();
      showToast('Folder deleted.');
    }
  }

  $('newRootFolderBtn').addEventListener('click', () => openFolderModal('new-root', null));
  $('closeFolderModal').addEventListener('click', closeFolderModal);
  $('cancelFolderEdit').addEventListener('click', closeFolderModal);

  $('folderModalOverlay').addEventListener('click', e => {
    if (e.target === $('folderModalOverlay')) closeFolderModal();
  });

  $('folderForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('folderNameInput').value.trim();
    if (!name) return;
    if (folderModalMode === 'rename') {
      await chrome.runtime.sendMessage({ action: 'update-folder', id: folderModalTargetId, name });
    } else {
      const parentId = folderModalMode === 'new-sub' ? folderModalTargetId : null;
      await chrome.runtime.sendMessage({ action: 'create-folder', name, parentId });
    }
    const wasRename = folderModalMode === 'rename';
    closeFolderModal();
    await loadBookmarks();
    showToast(wasRename ? 'Folder renamed.' : 'Folder created.');
  });

  // ── Folder select populate ──────────────────────────────────────────────────

  function populateFolderSelect(selectEl, selectedId, excludeId) {
    selectEl.innerHTML = '<option value="">— No folder —</option>';
    const addOptions = (parentId, depth) => {
      allFolders
        .filter(f => f.parentId === parentId && f.id !== excludeId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.id;
          opt.textContent = '\u00A0\u00A0'.repeat(depth * 2) + f.name;
          if (f.id === selectedId) opt.selected = true;
          selectEl.appendChild(opt);
          addOptions(f.id, depth + 1);
        });
    };
    addOptions(null, 0);
  }

  function toggleTagFilter(tag) {
    const idx = selectedTagFilters.indexOf(tag);
    if (idx >= 0) {
      selectedTagFilters.splice(idx, 1);
    } else {
      selectedTagFilters.push(tag);
    }
    renderSidebar();
    refreshMain();
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
    selectedDateFilter = null;
    selectedFolderFilter = null;
    selectedGtdFilter  = null;
    selectedTypeFilter = null;
    renderSidebar();
    renderGtdFilter();
    renderTypeFilter();
    renderDateTree();
    renderFolderTree();
    refreshMain();
  });

  // ── Active filters row ─────────────────────────────────────────────────────

  // Convenience: re-render the active-filter chips and the bookmark grid.
  // Called after any filter state change.
  function refreshMain() {
    renderActiveFilters();
    renderGrid();
  }

  function renderActiveFilters() {
    const hasTagFilters  = selectedTagFilters.length > 0;
    const hasDateFilter  = selectedDateFilter !== null;
    const hasFolderFilter = selectedFolderFilter !== null;
    const hasGtdFilter   = selectedGtdFilter !== null;
    const hasTypeFilter  = selectedTypeFilter !== null;

    if (!hasTagFilters && !hasDateFilter && !hasFolderFilter && !hasGtdFilter && !hasTypeFilter) {
      activeFiltersRow.style.display = 'none';
      return;
    }
    activeFiltersRow.style.display = '';

    const tagChipsHtml = selectedTagFilters.map(tag => {
      const ci = tagColorIndex(tag);
      return `<span class="tag-chip tc-${ci} active-filter-chip" data-tag="${escAttr(tag)}">${escHtml(tag)} ×</span>`;
    }).join('');

    const dateChipHtml = hasDateFilter
      ? `<span class="date-chip active-filter-chip" data-date="${escAttr(selectedDateFilter)}">` +
          `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/></svg>` +
          `${escHtml(formatDateFilter(selectedDateFilter))} ×</span>`
      : '';

    const folderPath = hasFolderFilter ? getFolderPath(selectedFolderFilter) : [];
    const folderChipHtml = hasFolderFilter
      ? `<span class="folder-chip active-filter-chip" data-folder="${escAttr(selectedFolderFilter)}">` +
          `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>` +
          `${escHtml(folderPath.join(' / '))} ×</span>`
      : '';

    const gtdChipHtml = hasGtdFilter
      ? `<span class="gtd-chip active-filter-chip ${GTD_CSS_CLASS[selectedGtdFilter] || ''}" data-gtd="${escAttr(selectedGtdFilter)}">${escHtml(selectedGtdFilter.charAt(0).toUpperCase() + selectedGtdFilter.slice(1))} ×</span>`
      : '';

    const typeChipHtml = hasTypeFilter
      ? `<span class="type-chip active-filter-chip ${TYPE_CSS_CLASS[selectedTypeFilter] || ''}" data-type="${escAttr(selectedTypeFilter)}">${escHtml(selectedTypeFilter.charAt(0).toUpperCase() + selectedTypeFilter.slice(1))} ×</span>`
      : '';

    activeTagChips.innerHTML = tagChipsHtml + gtdChipHtml + typeChipHtml + dateChipHtml + folderChipHtml;

    activeTagChips.querySelectorAll('.tag-chip').forEach(chip => {
      chip.addEventListener('click', () => toggleTagFilter(chip.dataset.tag));
    });
    activeTagChips.querySelectorAll('.gtd-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        selectedGtdFilter = null;
        renderGtdFilter();
        refreshMain();
      });
    });
    activeTagChips.querySelectorAll('.type-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        selectedTypeFilter = null;
        renderTypeFilter();
        refreshMain();
      });
    });
    activeTagChips.querySelectorAll('.date-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        selectedDateFilter = null;
        renderDateTree();
        refreshMain();
      });
    });
    activeTagChips.querySelectorAll('.folder-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        selectedFolderFilter = null;
        renderFolderTree();
        refreshMain();
      });
    });
  }

  // ── Search & sort ──────────────────────────────────────────────────────────

  searchInput.addEventListener('input', debounce(() => {
    searchQuery = searchInput.value.toLowerCase().trim();
    renderGrid();
  }, SEARCH_DEBOUNCE_MS));

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
    if (e.key === 'Escape') {
      if (modalOverlay.style.display !== 'none') closeEditModal();
      if ($('folderModalOverlay').style.display !== 'none') closeFolderModal();
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

    // Filter by selected date
    if (selectedDateFilter) {
      const parts = selectedDateFilter.split('-');
      list = list.filter(b => {
        const d = new Date(b.createdAt);
        if (d.getFullYear()   !== +parts[0]) return false;
        if (parts[1] != null && (d.getMonth() + 1) !== +parts[1]) return false;
        if (parts[2] != null && d.getDate()         !== +parts[2]) return false;
        return true;
      });
    }

    // Filter by selected folder (includes subfolders)
    if (selectedFolderFilter) {
      const folderIds = getFolderDescendantIds(selectedFolderFilter);
      list = list.filter(b => folderIds.has(b.folderId));
    }

    // Filter by GTD status
    if (selectedGtdFilter) {
      list = list.filter(b => b.gtdStatus === selectedGtdFilter);
    }

    // Filter by content type
    if (selectedTypeFilter) {
      list = list.filter(b => b.contentType === selectedTypeFilter);
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
        case 'score':  return calcScore(b).score - calcScore(a).score;
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
      } else if (selectedDateFilter) {
        emptyTitle.textContent = 'No bookmarks on this date';
        emptyDesc.textContent = `No bookmarks saved in ${formatDateFilter(selectedDateFilter)}. Try a different date.`;
      } else if (selectedFolderFilter) {
        const fp = getFolderPath(selectedFolderFilter);
        emptyTitle.textContent = 'No bookmarks in this folder';
        emptyDesc.textContent = `No bookmarks are saved in "${fp.join(' / ')}". Move bookmarks here by editing them.`;
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
          refreshMain();
        }
      });
    });
    bookmarkGrid.querySelectorAll('.card-favicon').forEach(img => {
      img.addEventListener('error', function () {
        const fallbackSrc = googleFaviconUrl(this.dataset.url || '');
        if (fallbackSrc && this.src !== fallbackSrc) {
          this.src = fallbackSrc;
        } else {
          this.classList.add('hidden');
          this.nextElementSibling.classList.remove('hidden');
        }
      });
    });
  }

  function googleFaviconUrl(pageUrl) {
    try {
      const host = new URL(pageUrl).hostname;
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
    } catch {
      return '';
    }
  }

  function renderCard(b) {
    const faviconSrc = escAttr(b.favIconUrl || googleFaviconUrl(b.url));
    const faviconHiddenClass = faviconSrc ? '' : ' hidden';
    const faviconFallHiddenClass = faviconSrc ? ' hidden' : '';

    const tagsHtml = (b.tags || []).map(t => {
      const ci = tagColorIndex(t);
      return `<span class="tag-chip tc-${ci} card-tag" data-tag="${escAttr(t)}" title="Filter by ${escAttr(t)}">${escHtml(t)}</span>`;
    }).join('');

    const notesHtml = b.notes
      ? `<p class="card-notes">${escHtml(b.notes)}</p>`
      : '';

    const gtdHtml = b.gtdStatus
      ? `<span class="card-badge gtd-badge gtd-${escAttr(b.gtdStatus)}">${escHtml(b.gtdStatus.charAt(0).toUpperCase() + b.gtdStatus.slice(1))}</span>`
      : '';
    const typeHtml = b.contentType
      ? `<span class="card-badge type-badge type-${escAttr(b.contentType)}">${escHtml(b.contentType.charAt(0).toUpperCase() + b.contentType.slice(1))}</span>`
      : '';
    const { action: priorityAction, score } = calcScore(b);
    const hasPriority = (b.importance && b.importance !== 'none') || (b.urgency && b.urgency !== 'none');
    const ACTION_LABEL = { 'do-now': 'Do Now', 'do': 'Do', 'schedule': 'Schedule', 'delegate': 'Delegate', 'incubate': 'Incubate', 'ignore': 'Ignore' };
    const scoreHtml = hasPriority
      ? `<span class="card-badge score-badge score-${escAttr(priorityAction)}" title="Urgency: ${escAttr(b.urgency||'none')} · Importance: ${escAttr(b.importance||'none')} · Score: ${score}">⚡ ${escHtml(ACTION_LABEL[priorityAction])}</span>`
      : '';
    const badgesHtml = (gtdHtml || typeHtml || scoreHtml)
      ? `<div class="card-badges">${scoreHtml}${gtdHtml}${typeHtml}</div>`
      : '';

    const folderPath = b.folderId ? getFolderPath(b.folderId) : null;
    const folderHtml = folderPath && folderPath.length
      ? `<div class="card-folder">` +
          `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">` +
            `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>` +
          `</svg>` +
          `${escHtml(folderPath.join(' / '))}` +
        `</div>`
      : '';

    return `
      <article class="bookmark-card${b.pinned ? ' pinned' : ''}" data-id="${escAttr(b.id)}">
        <div class="card-header">
          <img class="card-favicon${faviconHiddenClass}" src="${faviconSrc}" data-url="${escAttr(b.url)}" alt="" />
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
        ${badgesHtml}
        ${folderHtml}
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
    const card = bookmarkGrid.querySelector(`[data-id="${CSS.escape(id)}"]`);
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
    populateFolderSelect($('editFolder'), b.folderId || '');

    // Set GTD status pills
    editGtdStatus = b.gtdStatus || null;
    $('editGtdGroup').querySelectorAll('.pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === editGtdStatus);
    });

    // Set content type pills
    editContentType = b.contentType || null;
    $('editTypeGroup').querySelectorAll('.pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === editContentType);
    });

    // Set urgency pills
    editUrgency = b.urgency || null;
    $('editUrgencyGroup').querySelectorAll('.pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === editUrgency);
    });

    // Set importance pills
    editImportance = b.importance || null;
    $('editImportanceGroup').querySelectorAll('.pill-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === editImportance);
    });

    modalOverlay.style.display = '';
    setTimeout(() => editTitle.focus(), 100);
  }

  function closeEditModal() {
    modalOverlay.style.display = 'none';
    editTags = [];
    editGtdStatus = null;
    editContentType = null;
    editUrgency = null;
    editImportance = null;
    editAcItems = [];
    editAcActive = -1;
    editAcDropdown.style.display = 'none';
  }

  closeModal.addEventListener('click', closeEditModal);
  cancelEdit.addEventListener('click', closeEditModal);
  modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeEditModal();
  });

  // Pill group interactivity in edit modal
  setupPillGroup($('editGtdGroup'),        v => { editGtdStatus = v; });
  setupPillGroup($('editTypeGroup'),       v => { editContentType = v; });
  setupPillGroup($('editUrgencyGroup'),    v => { editUrgency = v; });
  setupPillGroup($('editImportanceGroup'), v => { editImportance = v; });

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
      notes: editNotes.value.trim(),
      folderId: $('editFolder').value || null,
      gtdStatus: editGtdStatus,
      contentType: editContentType,
      urgency: editUrgency,
      importance: editImportance
    };

    const result = await chrome.runtime.sendMessage({ action: 'update-bookmark', bookmark: updated });
    if (result && result.error) {
      showToast(`Error: ${result.error}`);
      return;
    }
    closeEditModal();
    await loadBookmarks();
    showToast('Bookmark updated!');
  });

  // ── Edit tag chips ─────────────────────────────────────────────────────────

  function renderEditChips() {
    renderTagChips(editTagChips, editTags);
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
    setTimeout(hideEditDropdown, BLUR_HIDE_DELAY_MS);
  });

  function addEditTag(tag) {
    tag = normalizeTag(tag);
    if (tag && !editTags.includes(tag)) {
      editTags.push(tag);
      renderEditChips();
    }
    editTagInput.value = '';
    hideEditDropdown();
  }

  function showEditAutocomplete(query) {
    if (!query) { hideEditDropdown(); return; }
    editAcItems = allTags.filter(t => t.includes(query) && !editTags.includes(t)).slice(0, AC_MAX_ITEMS);
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

  const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB
  const MAX_IMPORT_COUNT = 10000;            // max bookmark entries per import (CWE-400)

  importFileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    // Reject excessively large files before reading into memory (A05).
    if (file.size > MAX_IMPORT_BYTES) {
      showToast('Import file too large (max 5 MB).');
      importFileInput.value = '';
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      // Require a top-level array or an object with an array .bookmarks field.
      // Reject any other structure before touching the background (A08).
      const bookmarks = Array.isArray(data)
        ? data
        : (data && typeof data === 'object' && Array.isArray(data.bookmarks) ? data.bookmarks : null);
      if (!bookmarks || !bookmarks.length) { showToast('No bookmarks found in file.'); return; }
      // Cap the number of entries to prevent resource exhaustion (CWE-400).
      if (bookmarks.length > MAX_IMPORT_COUNT) {
        showToast(`Import file too large (max ${MAX_IMPORT_COUNT} bookmarks).`);
        importFileInput.value = '';
        return;
      }
      const result = await chrome.runtime.sendMessage({ action: 'import-bookmarks', bookmarks });
      showToast(`Imported ${result.count} bookmarks.`);
      await loadBookmarks();
    } catch {
      showToast('Import failed — invalid JSON.');
    }
    importFileInput.value = '';
  });

  // ── Live updates from background ───────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender) => {
    // Only accept messages from this extension's own background worker (A01).
    // A web-page content script injected into a tab shares the same process
    // but has a different sender.id, so this check prevents it from
    // triggering repeated reloads or other dashboard state changes.
    if (sender.id !== chrome.runtime.id) return;
    const refreshActions = ['bookmark-added', 'bookmark-deleted', 'bookmark-updated', 'bookmarks-imported', 'folders-updated'];
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
    toastTimer = setTimeout(() => toast.classList.remove('show'), TOAST_DURATION_MS);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  applyTheme(getTheme());
  loadBookmarks();

})();
