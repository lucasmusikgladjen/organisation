/* ============================================================
   anteckningar.txt — canvas note app
   ============================================================ */

(function () {
  'use strict';

  // ---- State ----
  const state = {
    notes: [],               // { id, fields: { Område, Anteckningar, Position X, Position Y, Lösenord } }
    dirtyPositions: new Map(), // id -> { x, y }  positions that need saving
    dirtyContent: new Map(),  // id -> { field, value } content changes to save
    activeNoteId: null,
    saving: false,
    zoom: 1,                  // current zoom level
  };

  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.1;

  const CACHE_KEY = 'notecanvas_cache';
  const DIRTY_KEY = 'notecanvas_dirty';
  const SYNC_DEBOUNCE_MS = 30000;    // batch sync after 30s of no changes
  const SAVE_TIMEOUT_MS = 30000;     // safety timeout for hung save requests
  const MAX_SYNC_RETRIES = 3;        // stop auto-retrying after this many consecutive failures
  let syncTimer = null;
  let saveTimeoutTimer = null;
  let consecutiveSyncFailures = 0;

  // ---- DOM refs ----
  const canvas = document.getElementById('canvas');
  const canvasContainer = document.getElementById('canvas-container');
  const btnNew = document.getElementById('btn-new');
  const btnSave = document.getElementById('btn-save');
  const saveStatus = document.getElementById('save-status');
  const zoomIndicator = document.getElementById('zoom-indicator');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalPassword = document.getElementById('modal-password');
  const modalOk = document.getElementById('modal-ok');
  const modalCancel = document.getElementById('modal-cancel');
  const modalClose = document.querySelector('.modal-close');
  const modalError = document.getElementById('modal-error');
  const modalMessage = document.getElementById('modal-message');
  const modalTitle = document.querySelector('.modal-title');

  // New note modal refs
  const newNoteOverlay = document.getElementById('new-note-overlay');
  const newNoteTitle = document.getElementById('new-note-title');
  const newNoteLocked = document.getElementById('new-note-locked');
  const newNoteOk = document.getElementById('new-note-ok');
  const newNoteCancel = document.getElementById('new-note-cancel');
  const newNoteClose = document.querySelector('.new-note-close');
  const newNoteColors = document.getElementById('new-note-colors');

  // Color picker logic
  newNoteColors.addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (!swatch) return;
    newNoteColors.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
    swatch.classList.add('selected');
  });

  // ---- Modal state ----
  let modalResolve = null;

  // ---- API helpers ----
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API error');
    return data;
  }

  function showStatus(msg) {
    saveStatus.textContent = msg;
    setTimeout(() => {
      if (saveStatus.textContent === msg) saveStatus.textContent = '';
    }, 3000);
  }

  // ---- Cache ----
  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(state.notes));
    } catch (_) { /* quota exceeded, ignore */ }
  }

  function loadCache() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (_) { /* ignore */ }
    return null;
  }

  // ---- Dirty state persistence (crash recovery) ----
  function persistDirtyState() {
    try {
      if (state.dirtyPositions.size === 0 && state.dirtyContent.size === 0) {
        localStorage.removeItem(DIRTY_KEY);
        return;
      }
      const dirty = {
        positions: Object.fromEntries(state.dirtyPositions),
        content: Object.fromEntries(state.dirtyContent),
        ts: Date.now(),
      };
      localStorage.setItem(DIRTY_KEY, JSON.stringify(dirty));
    } catch (_) { /* quota exceeded, ignore */ }
  }

  function restoreDirtyState() {
    try {
      const saved = localStorage.getItem(DIRTY_KEY);
      if (!saved) return;
      const { positions, content, ts } = JSON.parse(saved);
      // Ignore dirty state older than 5 minutes (likely stale)
      if (ts && Date.now() - ts > 5 * 60 * 1000) {
        localStorage.removeItem(DIRTY_KEY);
        return;
      }
      if (positions) {
        for (const [id, pos] of Object.entries(positions)) {
          if (!state.dirtyPositions.has(id)) {
            state.dirtyPositions.set(id, pos);
          }
        }
      }
      if (content) {
        for (const [id, fields] of Object.entries(content)) {
          if (!state.dirtyContent.has(id)) {
            state.dirtyContent.set(id, fields);
          }
        }
      }
      localStorage.removeItem(DIRTY_KEY);
    } catch (_) { /* ignore */ }
  }

  // ---- Password modal ----
  function promptPassword(message, title) {
    return new Promise((resolve) => {
      modalMessage.textContent = message || 'Enter password:';
      modalTitle.textContent = title || 'lösenord.exe';
      modalPassword.value = '';
      modalError.classList.add('hidden');
      modalOverlay.classList.remove('hidden');
      modalPassword.focus();
      modalResolve = resolve;
    });
  }

  function closeModal(result) {
    modalOverlay.classList.add('hidden');
    if (modalResolve) {
      modalResolve(result);
      modalResolve = null;
    }
  }

  modalOk.addEventListener('click', () => closeModal(modalPassword.value));
  modalCancel.addEventListener('click', () => closeModal(null));
  modalClose.addEventListener('click', () => closeModal(null));
  modalPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeModal(modalPassword.value);
    if (e.key === 'Escape') closeModal(null);
  });
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal(null);
  });

  // ---- Note rendering ----
  function createNoteElement(note) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.id = note.id;

    const x = parseInt(note.fields['Position X']) || 50;
    const y = parseInt(note.fields['Position Y']) || 50;
    el.style.left = x + 'px';
    el.style.top = y + 'px';

    const w = parseInt(note.fields['Size W']);
    const h = parseInt(note.fields['Size H']);
    if (w) el.style.width = w + 'px';
    if (h) el.style.height = h + 'px';

    const isLocked = note.fields['Lösenord'];
    const title = note.fields['Område'] || 'untitled.txt';
    const color = note.fields['Color'] || '#000080';

    el.innerHTML = `
      <div class="note-titlebar" style="background:${escapeAttr(color)}">
        <span class="note-title-label">${escapeHtml(title)}</span>
        <div class="note-titlebar-buttons">
          ${isLocked ? '<span class="note-btn locked" title="Password protected">&#9911;</span>' : ''}
          <button class="note-btn btn-toggle" title="Minimize/Expand">_</button>
          <button class="note-btn btn-delete" title="Delete note">x</button>
        </div>
      </div>
      <div class="note-body">
        ${isLocked && !note._unlocked
          ? `<div class="note-locked-overlay">&#9911; click to unlock</div>`
          : `<textarea class="note-content" placeholder="type here..." spellcheck="false">${escapeHtml(note.fields['Anteckningar'] || '')}</textarea>`
        }
        <div class="note-resize-handle"></div>
      </div>
    `;

    // Wire up events
    setupNoteDrag(el);
    setupNoteResize(el);
    setupNoteToggle(el, note);
    setupNoteDelete(el, note);
    setupNoteContentEditing(el, note);
    setupNoteLockClick(el, note);
    setupNoteActivation(el, note);

    return el;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- Drag ----
  function setupNoteDrag(el) {
    const titlebar = el.querySelector('.note-titlebar');
    let startX, startY, origLeft, origTop;

    titlebar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.note-btn')) return;
      e.preventDefault();
      document.body.classList.add('dragging');

      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseInt(el.style.left) || 0;
      origTop = parseInt(el.style.top) || 0;

      function onMove(e2) {
        const dx = (e2.clientX - startX) / state.zoom;
        const dy = (e2.clientY - startY) / state.zoom;
        const newX = Math.max(0, origLeft + dx);
        const newY = Math.max(0, origTop + dy);
        el.style.left = newX + 'px';
        el.style.top = newY + 'px';
      }

      function onUp() {
        document.body.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        // Mark position as dirty (preserve any pending size data)
        const noteId = el.dataset.id;
        const existing = state.dirtyPositions.get(noteId) || {};
        state.dirtyPositions.set(noteId, {
          ...existing,
          x: parseInt(el.style.left),
          y: parseInt(el.style.top),
        });

        // Update local state
        const noteData = state.notes.find(n => n.id === noteId);
        if (noteData) {
          noteData.fields['Position X'] = el.style.left.replace('px', '');
          noteData.fields['Position Y'] = el.style.top.replace('px', '');
        }
        saveCache();
        consecutiveSyncFailures = 0;
        scheduleBatchSync();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---- Resize ----
  function setupNoteResize(el) {
    const handle = el.querySelector('.note-resize-handle');
    if (!handle) return;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.add('resizing');

      const startX = e.clientX;
      const startY = e.clientY;
      const startW = el.offsetWidth;
      const startH = el.offsetHeight;

      function onMove(e2) {
        const w = Math.max(180, startW + (e2.clientX - startX) / state.zoom);
        const h = Math.max(80, startH + (e2.clientY - startY) / state.zoom);
        el.style.width = w + 'px';
        el.style.height = h + 'px';
      }

      function onUp() {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        // Mark size as dirty
        const noteId = el.dataset.id;
        const existing = state.dirtyPositions.get(noteId) || {};
        state.dirtyPositions.set(noteId, {
          ...existing,
          w: parseInt(el.style.width),
          h: parseInt(el.style.height),
        });

        // Update local state
        const noteData = state.notes.find(n => n.id === noteId);
        if (noteData) {
          noteData.fields['Size W'] = el.style.width.replace('px', '');
          noteData.fields['Size H'] = el.style.height.replace('px', '');
        }
        saveCache();
        consecutiveSyncFailures = 0;
        scheduleBatchSync();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---- ASCII art for collapsed notes ----
  const ASCII_ART = [
    // === CATS ===
    '    /\\_____/\\\n   /  o   o  \\\n  ( ==  ^  == )\n   )         (\n  (           )\n ( (  )   (  ) )\n(__(__)___(__)__)',
    '  |\\      _,,,---,,_\n  /,`.-\'`\'    -.  ;-;;,_\n |,4-  ) )-,_..;\\ (  `\'-\'\n \'---\'\'(_/--\'  `-\'\\_)',
    '   /\\_/\\  ______\n  ( o.o ) |      \\\n  =_Y_=  | MEOW! |\n   /O\\   |______/\n  (_|_)\n   U U',
    '    |\\__/,|   (`\\\n  _.|o o  |_   ) )\n-(((---(((--------',
    // === BIRDS ===
    '     .--.\n    / _  \\\n   | ( \\  \\\n    \\  \\ _/\n   ,_\\\\ \\\\__\n   (___\\\\___)',
    '      ___\n   __/o o\\__\n  /    ~    \\\n | |      | |\n  \\|______|/\n    ||  ||\n   _||__||_\n  (__)(__)  ~tweet~',
    '        _\n       / )\n     ,/ /\n    / /\\/\n   / / /\n  / ( (\n (   \\ \\\n  \\   ) )\n   \\_/ /\n      (',
    '   ,_,\n  (O,O)\n  (   )\n  -"-"---  hoo hoo\n   |  |\n  _|__|_',
    // === GEOMETRY ===
    '  +------+------+\n  |\\      \\      |\n  | \\      \\     |\n  |  +------+----+\n  +--| /    |   /\n   \\ |/     |  /\n    \\+------+ /\n     --------',
    '       /\\\n      /  \\\n     / /\\ \\\n    / /  \\ \\\n   / / /\\ \\ \\\n  / / /  \\ \\ \\\n /________\\ \\ \\\n \\__________\\/',
    '    _____\n   /     \\\n  / () () \\\n |  ____  |\n  \\ \\__/ /\n   \\____/\n   /    \\\n  /______\\',
    '  *  .  *  .  *\n .  ___*___  .\n  /\\   |   /\\\n / *\\  |  / *\\\n/____\\_|_/____\\\n\\    / | \\    /\n \\ */  |  \\* /\n  \\/   |   \\/\n *  \'  *  \'  *',
    // === TECH ===
    '  +-----------+\n  | C:\\>_      |\n  | dir        |\n  | NOTES  <D> |\n  | CATS   <D> |\n  | ART.EXE    |\n  | 420 bytes  |\n  +-----------+',
    '    .---.\n   /     \\\n  | () () |\n   \\  _  /\n    |   |\n  +-+---+-+\n  | ROBOT |\n  +--+-+--+\n     | |\n    _| |_\n   |_____|',
    '  ______________\n |  __________  |\n | |          | |\n | | 01001001 | |\n | | HELLO :) | |\n | |__________| |\n |  ___  ___   |\n | |_1_||_2_|  |\n |______________|',
    '     /===\\\n    | o o |\n    |  >  |\n   /|  -  |\\\n  / |=====| \\\n |  |/M W\\|  |\n     |   |\n     |   |\n    /|   |\\\n   (_|   |_)',
    // === ALIENS ===
    '     .     .\n   .\\ | | | /.\n  -- \\   / --\n --|  O_O  |--\n  -- / | \\ --\n   \'/ | | \\\\\'\n     \'   \'\n   TAKE ME TO\n   UR LEADER',
    '   ___ooo___\n  / oo  oo \\\n | |  ()  | |\n  \\  \\__/  /\n   \\_    _/\n  ===)  (===\n     \\  /\n   __|  |__\n  (________)',
    '  {\\___/}\n  ( O O )\n   ( > )\n   /|~|\\\n  (_| |_)\n ~~AYYYY~~\n  LMAO!!',
    '      *   *\n    *  \\_/  *\n   * --|--|-- *\n    * /   \\ *\n   *  |   |  *\n      |   |\n   ~~~~~~~~~~~\n   ~UFO ZONE~',
    // === NAUGHTY/FUN ===
    '   ______\n  /      \\\n | (.)(.)|  oh\n |   __  |  my\n |  \\__/ |\n  \\  \\/  /\n   \\____/\n   *blush*',
    '      ___\n  _  /   \\ _\n ( \\/  .  \\/ )\n  \\  (  )  /\n   )  \\/  (\n  (  BEWBS )\n   \\      /\n    \\    /\n     \\  /\n      \\/\n  ( . Y . )',
    '  DING DONG!\n  =========\n  |       |\n  |  8=D  |\n  |       |\n  =========\n  hehehehe',
    // === MORE CATS ===
    '    /)  /)\n   ( ^.^ )\n   (> < )>\n   /|   |\\\n  (_|   |_)\n    \\   /\n  ~nya nya~',
    // === MORE TECH ===
    '   _______\n  |       |\n  | CLICK |\n  | HERE! |\n  | FREE! |\n  | $$$$$ |\n  |_______|\n  [  OK  ]\n  ~*~*~*~*~',
    '  __________\n |          |\n | FATAL    |\n | ERROR    |\n |          |\n | lol jk   |\n |  ;-P     |\n |__________|',
    '  .-------.\n  |  404  |\n  | BRAIN |\n  |  NOT  |\n  | FOUND |\n  \'-------\'\n   (\\ _ /)\n    ( . )\n     \\ /\n      V',
    // === MORE GEOMETRY ===
    '  .-\'\'\'\'\'\'\'\'\'-.  \n /  .-------.  \\\n|  /         \\  |\n| |    <3     | |\n|  \\         /  |\n \\  \'-------\'  /\n  \'-.........-\'',
    '     /\\/\\/\\\n    |      |\n    | {  } |\n    | |  | |\n    | |  | |\n /\\/  \\  /  \\/\\\n|    TOTEM    |\n \\____________/',
    '  *   *   *   *\n   \\ | / \\ | /\n    \\|/   \\|/\n  ---*-----*---\n    /|\\   /|\\\n   / | \\ / | \\\n  *   *   *   *\n   STARFIELD',
    '    /~~~~~\\\n   | ~   ~ |\n   |  WOW  |\n    \\ ~~~ /\n     \\   /\n      | |\n   ---+---\n  /  ===  \\\n (  AMAZE  )\n  \\_______/',
  ];

  function showCollapsedArt(el) {
    let artEl = el.querySelector('.note-collapsed-art');
    if (!artEl) {
      artEl = document.createElement('pre');
      artEl.className = 'note-collapsed-art';
      el.appendChild(artEl);
    }
    const idx = Math.floor(Math.random() * ASCII_ART.length);
    artEl.textContent = ASCII_ART[idx];
    artEl.style.display = '';
  }

  function hideCollapsedArt(el) {
    const artEl = el.querySelector('.note-collapsed-art');
    if (artEl) artEl.style.display = 'none';
  }

  // ---- Toggle (collapse/expand) ----
  function setupNoteToggle(el, note) {
    const btn = el.querySelector('.btn-toggle');
    const body = el.querySelector('.note-body');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsing = !body.classList.contains('collapsed');

      if (collapsing) {
        // Save current dimensions before collapsing
        el.dataset.expandedWidth = el.style.width || '';
        el.dataset.expandedHeight = el.style.height || '';
        // Reset to compact size
        el.style.width = '';
        el.style.height = '';
        // Show ASCII art
        showCollapsedArt(el);
      } else {
        // Restore saved dimensions
        el.style.width = el.dataset.expandedWidth || '';
        el.style.height = el.dataset.expandedHeight || '';
        // Remove ASCII art
        hideCollapsedArt(el);
      }

      body.classList.toggle('collapsed');
      el.classList.toggle('collapsed');
      btn.textContent = collapsing ? '□' : '_';
    });
  }

  // ---- Delete ----
  function setupNoteDelete(el, note) {
    const btn = el.querySelector('.btn-delete');

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pw = await promptPassword('Enter password to delete note:', 'delete.exe');
      if (pw === null) return;

      try {
        await api('DELETE', `/notes/${note.id}`, { password: pw });
        el.remove();
        state.notes = state.notes.filter(n => n.id !== note.id);
        state.dirtyPositions.delete(note.id);
        state.dirtyContent.delete(note.id);
        saveCache();
        showStatus('deleted');
      } catch (err) {
        modalError.textContent = '* ' + err.message + ' *';
        modalError.classList.remove('hidden');
        // Re-prompt
        setTimeout(() => modalError.classList.add('hidden'), 2000);
      }
    });
  }

  // ---- Content editing ----
  function setupNoteContentEditing(el, note) {
    const textarea = el.querySelector('.note-content');

    if (textarea) {
      // Allow selecting/typing in textarea without triggering drag
      textarea.addEventListener('mousedown', (e) => e.stopPropagation());
      textarea.addEventListener('input', () => {
        note.fields['Anteckningar'] = textarea.value;
        debounceSaveContent(note.id, { 'Anteckningar': textarea.value });
      });
    }
  }

  function debounceSaveContent(noteId, fields) {
    // Merge fields into pending changes
    if (!state.dirtyContent.has(noteId)) {
      state.dirtyContent.set(noteId, {});
    }
    Object.assign(state.dirtyContent.get(noteId), fields);
    saveCache();
    // New user activity resets retry budget so fresh edits get a fair attempt
    consecutiveSyncFailures = 0;
    scheduleBatchSync();
  }

  // ---- Batch sync timer ----
  function scheduleBatchSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(flushAllDirty, SYNC_DEBOUNCE_MS);
  }

  async function flushAllDirty() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    if (state.dirtyPositions.size === 0 && state.dirtyContent.size === 0) return;
    if (state.saving) {
      // Re-schedule instead of silently dropping pending changes
      scheduleBatchSync();
      return;
    }
    state.saving = true;

    // Snapshot what we're about to send so edits during the request aren't lost
    const sentPositions = new Map(state.dirtyPositions);
    const sentContent = new Map();
    for (const [id, fields] of state.dirtyContent) {
      sentContent.set(id, { ...fields });
    }

    // Merge snapshots into one records array
    const merged = new Map();
    for (const [id, pos] of sentPositions) {
      if (!merged.has(id)) merged.set(id, {});
      const fields = merged.get(id);
      if (pos.x !== undefined) fields['Position X'] = String(pos.x);
      if (pos.y !== undefined) fields['Position Y'] = String(pos.y);
      if (pos.w !== undefined) fields['Size W'] = String(pos.w);
      if (pos.h !== undefined) fields['Size H'] = String(pos.h);
    }
    for (const [id, fields] of sentContent) {
      if (!merged.has(id)) merged.set(id, {});
      Object.assign(merged.get(id), fields);
    }

    const records = [];
    for (const [id, fields] of merged) {
      records.push({ id, fields });
    }

    // Safety timeout: if request hangs, unblock saving after SAVE_TIMEOUT_MS
    saveTimeoutTimer = setTimeout(() => {
      if (state.saving) {
        console.warn('Save timed out — unblocking sync');
        state.saving = false;
        persistDirtyState();
        consecutiveSyncFailures++;
        if (consecutiveSyncFailures < MAX_SYNC_RETRIES) {
          showStatus('sync timeout, retrying... (' + consecutiveSyncFailures + '/' + MAX_SYNC_RETRIES + ')');
          scheduleBatchSync();
        } else {
          showStatus('sync timed out — click save to retry');
        }
      }
    }, SAVE_TIMEOUT_MS);

    try {
      showStatus('syncing...');
      const result = await api('PATCH', '/notes/batch', { records });

      // Handle partial success: only clear dirty state for records that succeeded
      const savedIds = new Set((result.records || []).map(r => r.id));

      for (const id of savedIds) {
        // Only clear position if it hasn't been updated since we started saving
        const currentPos = state.dirtyPositions.get(id);
        const sentPos = sentPositions.get(id);
        if (sentPos && currentPos &&
            currentPos.x === sentPos.x && currentPos.y === sentPos.y &&
            currentPos.w === sentPos.w && currentPos.h === sentPos.h) {
          state.dirtyPositions.delete(id);
        }

        // Only clear content fields if they haven't been updated since we started saving
        const currentFields = state.dirtyContent.get(id);
        const sentFields = sentContent.get(id);
        if (sentFields && currentFields) {
          let allFieldsClean = true;
          for (const key of Object.keys(sentFields)) {
            if (currentFields[key] !== sentFields[key]) {
              allFieldsClean = false;
              break;
            }
          }
          if (allFieldsClean) {
            state.dirtyContent.delete(id);
          }
        } else if (sentFields && !currentFields) {
          // Content was cleared during save — nothing to remove
        }
      }

      // Report partial failures
      if (result.errors && result.errors.length > 0) {
        console.error('Partial sync failures:', result.errors);
        persistDirtyState();
        consecutiveSyncFailures++;
        if (consecutiveSyncFailures < MAX_SYNC_RETRIES) {
          showStatus('partially synced, retrying... (' + consecutiveSyncFailures + '/' + MAX_SYNC_RETRIES + ')');
          scheduleBatchSync();
        } else {
          showStatus('sync partially failed — click save to retry');
        }
      } else {
        consecutiveSyncFailures = 0;
        showStatus('synced');
        persistDirtyState(); // clears dirty key if maps are now empty
      }
    } catch (err) {
      console.error('Batch sync failed:', err);
      persistDirtyState();
      consecutiveSyncFailures++;
      if (consecutiveSyncFailures < MAX_SYNC_RETRIES) {
        showStatus('sync failed, retrying... (' + consecutiveSyncFailures + '/' + MAX_SYNC_RETRIES + ')');
        scheduleBatchSync();
      } else {
        showStatus('sync failed — click save to retry');
      }
    } finally {
      clearTimeout(saveTimeoutTimer);
      saveTimeoutTimer = null;
      state.saving = false;
    }
  }

  // ---- Lock click (unlock) ----
  function setupNoteLockClick(el, note) {
    const overlay = el.querySelector('.note-locked-overlay');
    if (!overlay) return;

    overlay.addEventListener('click', async () => {
      const pw = await promptPassword('Enter password to view note:', 'lösenord.exe');
      if (pw === null) return;

      try {
        const data = await api('POST', `/notes/${note.id}/unlock`, { password: pw });
        note.fields['Anteckningar'] = data.content;
        note._unlocked = true;
        saveCache();

        // Replace overlay with textarea
        const body = el.querySelector('.note-body');
        overlay.remove();
        const textarea = document.createElement('textarea');
        textarea.className = 'note-content';
        textarea.placeholder = 'type here...';
        textarea.spellcheck = false;
        textarea.value = data.content;
        body.insertBefore(textarea, body.querySelector('.note-resize-handle'));

        textarea.addEventListener('mousedown', (e) => e.stopPropagation());
        textarea.addEventListener('input', () => {
          note.fields['Anteckningar'] = textarea.value;
          debounceSaveContent(note.id, { 'Anteckningar': textarea.value });
        });
      } catch (err) {
        modalOverlay.classList.remove('hidden');
        modalError.textContent = '* ' + err.message + ' *';
        modalError.classList.remove('hidden');
        setTimeout(() => {
          modalError.classList.add('hidden');
          modalOverlay.classList.add('hidden');
        }, 2000);
      }
    });
  }

  // ---- Activation (bring to front) ----
  function setupNoteActivation(el, note) {
    el.addEventListener('mousedown', () => {
      // Deactivate all
      document.querySelectorAll('.note.active').forEach(n => n.classList.remove('active'));
      el.classList.add('active');
      state.activeNoteId = note.id;
    });
  }

  // Save everything (manual save button — resets retry counter)
  async function saveAll() {
    consecutiveSyncFailures = 0;
    await flushAllDirty();
  }

  // ---- New note modal ----
  function promptNewNote() {
    return new Promise((resolve) => {
      newNoteTitle.value = '';
      newNoteLocked.checked = false;
      // Reset color picker to default (first swatch)
      newNoteColors.querySelectorAll('.color-swatch').forEach((s, i) => {
        s.classList.toggle('selected', i === 0);
      });
      newNoteOverlay.classList.remove('hidden');
      newNoteTitle.focus();

      function submit() {
        const selectedSwatch = newNoteColors.querySelector('.color-swatch.selected');
        const color = selectedSwatch ? selectedSwatch.dataset.color : '#000080';
        cleanup();
        resolve({ title: newNoteTitle.value, locked: newNoteLocked.checked, color });
      }
      function cancel() {
        cleanup();
        resolve(null);
      }
      function onKey(e) {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') cancel();
      }
      function onOverlayClick(e) {
        if (e.target === newNoteOverlay) cancel();
      }
      function cleanup() {
        newNoteOverlay.classList.add('hidden');
        newNoteOk.removeEventListener('click', submit);
        newNoteCancel.removeEventListener('click', cancel);
        newNoteClose.removeEventListener('click', cancel);
        newNoteTitle.removeEventListener('keydown', onKey);
        newNoteOverlay.removeEventListener('click', onOverlayClick);
      }

      newNoteOk.addEventListener('click', submit);
      newNoteCancel.addEventListener('click', cancel);
      newNoteClose.addEventListener('click', cancel);
      newNoteTitle.addEventListener('keydown', onKey);
      newNoteOverlay.addEventListener('click', onOverlayClick);
    });
  }

  // ---- Create new note ----
  async function createNote() {
    const result = await promptNewNote();
    if (result === null) return;

    // Find an empty spot
    const scrollLeft = canvasContainer.scrollLeft;
    const scrollTop = canvasContainer.scrollTop;
    const x = Math.floor((scrollLeft + 100) / state.zoom + Math.random() * 200);
    const y = Math.floor((scrollTop + 100) / state.zoom + Math.random() * 200);

    try {
      showStatus('creating...');
      const fields = {
        'Område': result.title,
        'Anteckningar': '',
        'Position X': String(x),
        'Position Y': String(y),
        'Color': result.color || '#000080',
      };
      if (result.locked) {
        fields['Lösenord'] = true;
      }

      const record = await api('POST', '/notes', { fields });

      const note = {
        id: record.id,
        fields: {
          'Område': result.title,
          'Anteckningar': '',
          'Position X': String(x),
          'Position Y': String(y),
          'Lösenord': !!result.locked,
          'Color': result.color || '#000080',
          ...(record.fields || {}),
        },
      };
      state.notes.push(note);
      saveCache();

      const el = createNoteElement(note);
      canvas.appendChild(el);
      showStatus('created');

      // Focus the content textarea if not locked
      if (!result.locked) {
        const textarea = el.querySelector('.note-content');
        if (textarea) textarea.focus();
      }
    } catch (err) {
      console.error('Failed to create note:', err);
      showStatus('create failed: ' + err.message);
    }
  }

  // ---- Initial load ----
  async function loadNotes() {
    // Try cache first for instant render
    const cached = loadCache();
    if (cached && cached.length > 0) {
      state.notes = cached;
      renderAllNotes();
      showStatus('loaded from cache');
    }

    // Then fetch fresh data
    try {
      const data = await api('GET', '/notes');
      state.notes = data.records;
      saveCache();
      renderAllNotes();
      showStatus('synced');
    } catch (err) {
      console.error('Failed to load notes:', err);
      if (!cached || cached.length === 0) {
        showStatus('load failed: ' + err.message);
      } else {
        showStatus('offline mode: ' + err.message);
      }
    }

    // Recover any unsaved dirty state from a previous session (crash recovery)
    restoreDirtyState();
    if (state.dirtyPositions.size > 0 || state.dirtyContent.size > 0) {
      console.log('Recovered unsaved changes, syncing...');
      showStatus('recovering unsaved changes...');
      flushAllDirty();
    }
  }

  function renderAllNotes() {
    canvas.innerHTML = '';
    for (const note of state.notes) {
      const el = createNoteElement(note);
      canvas.appendChild(el);
    }
  }

  // ---- Zoom ----
  function updateZoom(newZoom, pivotX, pivotY) {
    const oldZoom = state.zoom;
    state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));

    canvas.style.transform = `scale(${state.zoom})`;

    // Update the scroller wrapper so scrollbars reflect the zoomed size
    const scroller = document.getElementById('canvas-scroller');
    scroller.style.width = (4000 * state.zoom) + 'px';
    scroller.style.height = (4000 * state.zoom) + 'px';

    // Adjust scroll to keep the point under cursor fixed
    if (pivotX !== undefined && pivotY !== undefined) {
      const scrollLeft = canvasContainer.scrollLeft;
      const scrollTop = canvasContainer.scrollTop;

      // The canvas point under the cursor before zoom
      const canvasX = (scrollLeft + pivotX) / oldZoom;
      const canvasY = (scrollTop + pivotY) / oldZoom;

      // Where that point ends up after zoom
      canvasContainer.scrollLeft = canvasX * state.zoom - pivotX;
      canvasContainer.scrollTop = canvasY * state.zoom - pivotY;
    }

    zoomIndicator.textContent = Math.round(state.zoom * 100) + '%';
  }

  canvasContainer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();

    const rect = canvasContainer.getBoundingClientRect();
    const pivotX = e.clientX - rect.left;
    const pivotY = e.clientY - rect.top;

    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    updateZoom(state.zoom + delta, pivotX, pivotY);
  }, { passive: false });

  // Reset zoom on double-click of zoom indicator
  zoomIndicator.addEventListener('dblclick', () => {
    updateZoom(1);
    canvasContainer.scrollLeft = 0;
    canvasContainer.scrollTop = 0;
  });

  // ---- Middle mouse button pan ----
  (function setupCanvasPan() {
    let isPanning = false;
    let startX, startY, scrollX0, scrollY0;

    canvasContainer.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;          // only middle mouse button
      e.preventDefault();
      isPanning = true;
      startX = e.clientX;
      startY = e.clientY;
      scrollX0 = canvasContainer.scrollLeft;
      scrollY0 = canvasContainer.scrollTop;
      document.body.classList.add('panning');
    });

    document.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      canvasContainer.scrollLeft = scrollX0 - dx;
      canvasContainer.scrollTop = scrollY0 - dy;
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button !== 1) return;
      if (!isPanning) return;
      isPanning = false;
      document.body.classList.remove('panning');
    });

    // Prevent default middle-click auto-scroll on the container
    canvasContainer.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
  })();

  // ---- Event wiring ----
  btnNew.addEventListener('click', createNote);
  btnSave.addEventListener('click', saveAll);

  // Save before unload — one unified batch beacon
  // Also persist dirty state to localStorage as fallback in case beacon fails
  window.addEventListener('beforeunload', () => {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }

    // Always persist dirty state as a safety net (beacon may fail silently)
    persistDirtyState();

    if (state.dirtyPositions.size === 0 && state.dirtyContent.size === 0) return;

    const merged = new Map();
    for (const [id, pos] of state.dirtyPositions) {
      if (!merged.has(id)) merged.set(id, {});
      const fields = merged.get(id);
      if (pos.x !== undefined) fields['Position X'] = String(pos.x);
      if (pos.y !== undefined) fields['Position Y'] = String(pos.y);
      if (pos.w !== undefined) fields['Size W'] = String(pos.w);
      if (pos.h !== undefined) fields['Size H'] = String(pos.h);
    }
    for (const [id, fields] of state.dirtyContent) {
      if (!merged.has(id)) merged.set(id, {});
      Object.assign(merged.get(id), fields);
    }

    const records = [];
    for (const [id, fields] of merged) {
      records.push({ id, fields });
    }

    const payload = JSON.stringify({ records });
    // sendBeacon has a ~64KB limit — check before sending
    if (payload.length <= 64000) {
      navigator.sendBeacon('/api/notes/batch', new Blob(
        [payload],
        { type: 'application/json' }
      ));
    } else {
      // Payload too large for beacon — dirty state is already persisted
      // to localStorage above, so it will be recovered on next load
      console.warn('Beacon payload too large (' + payload.length + ' bytes), relying on dirty state recovery');
    }
  });

  // Save on visibility change (user switches tab)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      flushAllDirty();
    }
  });

  // Periodically persist dirty state to localStorage (crash recovery)
  setInterval(persistDirtyState, 5000);

  // ---- Boot ----
  loadNotes();
})();
