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
  };

  const CACHE_KEY = 'notecanvas_cache';
  const SAVE_DEBOUNCE_MS = 3000;    // debounce content saves by 3s
  const IDLE_SAVE_MS = 10000;        // save positions after 10s idle
  let idleTimer = null;
  let contentTimers = {};            // per-note debounce timers for content

  // ---- DOM refs ----
  const canvas = document.getElementById('canvas');
  const btnNew = document.getElementById('btn-new');
  const btnSave = document.getElementById('btn-save');
  const saveStatus = document.getElementById('save-status');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalPassword = document.getElementById('modal-password');
  const modalOk = document.getElementById('modal-ok');
  const modalCancel = document.getElementById('modal-cancel');
  const modalClose = document.querySelector('.modal-close');
  const modalError = document.getElementById('modal-error');
  const modalMessage = document.getElementById('modal-message');
  const modalTitle = document.querySelector('.modal-title');

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

    const isLocked = note.fields['Lösenord'];
    const title = note.fields['Område'] || 'untitled.txt';

    el.innerHTML = `
      <div class="note-titlebar">
        <span class="note-title-text">${escapeHtml(title)}</span>
        <div class="note-titlebar-buttons">
          ${isLocked ? '<span class="note-btn locked" title="Password protected">&#9911;</span>' : ''}
          <button class="note-btn btn-toggle" title="Minimize/Expand">_</button>
          <button class="note-btn btn-delete" title="Delete note">x</button>
        </div>
      </div>
      <div class="note-body">
        <input class="note-title-input" value="${escapeAttr(note.fields['Område'] || '')}" placeholder="title..." spellcheck="false">
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

      const rect = el.getBoundingClientRect();
      const containerRect = canvas.parentElement.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseInt(el.style.left) || 0;
      origTop = parseInt(el.style.top) || 0;

      function onMove(e2) {
        const dx = e2.clientX - startX;
        const dy = e2.clientY - startY;
        const newX = Math.max(0, origLeft + dx);
        const newY = Math.max(0, origTop + dy);
        el.style.left = newX + 'px';
        el.style.top = newY + 'px';
      }

      function onUp() {
        document.body.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        // Mark position as dirty
        const noteId = el.dataset.id;
        state.dirtyPositions.set(noteId, {
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
        resetIdleTimer();
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
        const w = Math.max(180, startW + (e2.clientX - startX));
        const h = Math.max(80, startH + (e2.clientY - startY));
        el.style.width = w + 'px';
        el.style.height = h + 'px';
      }

      function onUp() {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---- Toggle (collapse/expand) ----
  function setupNoteToggle(el, note) {
    const btn = el.querySelector('.btn-toggle');
    const body = el.querySelector('.note-body');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      body.classList.toggle('collapsed');
      el.classList.toggle('collapsed');
      btn.textContent = body.classList.contains('collapsed') ? '□' : '_';
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
    const titleInput = el.querySelector('.note-title-input');
    const textarea = el.querySelector('.note-content');

    // Allow selecting/typing in inputs without triggering drag
    [titleInput, textarea].forEach(input => {
      if (!input) return;
      input.addEventListener('mousedown', (e) => e.stopPropagation());
    });

    if (titleInput) {
      titleInput.addEventListener('input', () => {
        const val = titleInput.value;
        note.fields['Område'] = val;
        el.querySelector('.note-title-text').textContent = val || 'untitled.txt';
        debounceSaveContent(note.id, { 'Område': val });
      });
    }

    if (textarea) {
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

    // Debounce the API call
    if (contentTimers[noteId]) clearTimeout(contentTimers[noteId]);
    contentTimers[noteId] = setTimeout(() => {
      flushContentSave(noteId);
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushContentSave(noteId) {
    const fields = state.dirtyContent.get(noteId);
    if (!fields) return;
    state.dirtyContent.delete(noteId);
    delete contentTimers[noteId];

    try {
      await api('PATCH', `/notes/${noteId}`, { fields });
      showStatus('saved');
    } catch (err) {
      console.error('Failed to save content:', err);
      showStatus('save failed!');
      // Re-queue the dirty content
      if (!state.dirtyContent.has(noteId)) {
        state.dirtyContent.set(noteId, {});
      }
      Object.assign(state.dirtyContent.get(noteId), fields);
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

  // ---- Idle timer for batch position save ----
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(flushPositions, IDLE_SAVE_MS);
  }

  async function flushPositions() {
    if (state.dirtyPositions.size === 0) return;
    if (state.saving) return;
    state.saving = true;

    const records = [];
    for (const [id, pos] of state.dirtyPositions) {
      records.push({
        id,
        fields: {
          'Position X': String(pos.x),
          'Position Y': String(pos.y),
        },
      });
    }

    try {
      showStatus('saving positions...');
      await api('PATCH', '/notes/batch', { records });
      state.dirtyPositions.clear();
      showStatus('positions saved');
    } catch (err) {
      console.error('Failed to save positions:', err);
      showStatus('position save failed!');
    } finally {
      state.saving = false;
    }
  }

  // Flush all dirty content saves
  async function flushAllContent() {
    const promises = [];
    for (const [noteId] of state.dirtyContent) {
      if (contentTimers[noteId]) clearTimeout(contentTimers[noteId]);
      promises.push(flushContentSave(noteId));
    }
    await Promise.all(promises);
  }

  // Save everything
  async function saveAll() {
    showStatus('saving...');
    await Promise.all([flushPositions(), flushAllContent()]);
    showStatus('all saved');
  }

  // ---- Create new note ----
  async function createNote() {
    // Find an empty spot
    const scrollLeft = canvas.parentElement.scrollLeft;
    const scrollTop = canvas.parentElement.scrollTop;
    const x = scrollLeft + 100 + Math.floor(Math.random() * 200);
    const y = scrollTop + 100 + Math.floor(Math.random() * 200);

    try {
      showStatus('creating...');
      const record = await api('POST', '/notes', {
        fields: {
          'Område': '',
          'Anteckningar': '',
          'Position X': String(x),
          'Position Y': String(y),
        },
      });

      const note = {
        id: record.id,
        fields: {
          'Område': '',
          'Anteckningar': '',
          'Position X': String(x),
          'Position Y': String(y),
          'Lösenord': false,
          ...(record.fields || {}),
        },
      };
      state.notes.push(note);
      saveCache();

      const el = createNoteElement(note);
      canvas.appendChild(el);
      showStatus('created');

      // Focus the title input
      const titleInput = el.querySelector('.note-title-input');
      if (titleInput) titleInput.focus();
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

      // Preserve unlock state from cache
      if (cached) {
        for (const note of state.notes) {
          const cachedNote = cached.find(c => c.id === note.id);
          if (cachedNote && cachedNote._unlocked) {
            note._unlocked = true;
            note.fields['Anteckningar'] = cachedNote.fields['Anteckningar'];
          }
        }
      }

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
  }

  function renderAllNotes() {
    canvas.innerHTML = '';
    for (const note of state.notes) {
      const el = createNoteElement(note);
      canvas.appendChild(el);
    }
  }

  // ---- Event wiring ----
  btnNew.addEventListener('click', createNote);
  btnSave.addEventListener('click', saveAll);

  // Save before unload
  window.addEventListener('beforeunload', () => {
    // Use sendBeacon for reliable save on tab close
    if (state.dirtyPositions.size > 0) {
      const records = [];
      for (const [id, pos] of state.dirtyPositions) {
        records.push({
          id,
          fields: { 'Position X': String(pos.x), 'Position Y': String(pos.y) },
        });
      }
      navigator.sendBeacon('/api/notes/batch', new Blob(
        [JSON.stringify({ records })],
        { type: 'application/json' }
      ));
    }

    // Also try to save content
    for (const [noteId, fields] of state.dirtyContent) {
      navigator.sendBeacon(`/api/notes/${noteId}`, new Blob(
        [JSON.stringify({ fields })],
        { type: 'application/json' }
      ));
    }
  });

  // Save on visibility change (user switches tab)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveAll();
    }
  });

  // ---- Boot ----
  loadNotes();
})();
