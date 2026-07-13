// ---------- storage helper (chrome.storage with localStorage fallback) ----------
const store = {
  async get(key, fallback) {
    if (window.chrome && chrome.storage && chrome.storage.local) {
      return new Promise(res => {
        chrome.storage.local.get([key], r => res(r[key] !== undefined ? r[key] : fallback));
      });
    }
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  },
  async set(key, value) {
    if (window.chrome && chrome.storage && chrome.storage.local) {
      return new Promise(res => {
        chrome.storage.local.set({ [key]: value }, res);
      });
    }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { }
  },
  async remove(key) {
    if (window.chrome && chrome.storage && chrome.storage.local) {
      return new Promise(res => chrome.storage.local.remove(key, res));
    }
    try { localStorage.removeItem(key); } catch (e) { }
  }
};

// ---------- IndexedDB helper for media blobs ----------
// Two object stores under one DB:
//   • 'background' — single-slot blob for the active custom background
//                   (key: 'current').
//   • 'photos'     — per-photo blobs keyed by the photo's own id, used by
//                   the goals board. Migrated from the old base64-in-
//                   chrome.storage path the first time the user runs an
//                   optimised build (see initBoardPhotos below). Storing
//                   binary Blobs instead of base64 cuts both storage and
//                   load-time CPU dramatically — the browser doesn't have
//                   to decode 33%-larger base64 strings every page load.
// Nothing else should call indexedDB directly — go through mediaStore.
const mediaStore = (function () {
  const DB_NAME    = 'flashDashMedia';
  const BG_STORE   = 'background';
  const PHOTO_STORE = 'photos';
  const BG_KEY     = 'current';
  const DB_VERSION = 2; // bumped to add the 'photos' store
  let _db = null;

  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(BG_STORE)) {
          db.createObjectStore(BG_STORE);
        }
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          db.createObjectStore(PHOTO_STORE);
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function _run(storeName, mode, op) {
    return _open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = op(store);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    })).catch(() => null);
  }

  return {
    // ----- background (single-slot) -----
    async getBg()            { return (await _run(BG_STORE, 'readonly',  s => s.get(BG_KEY))) || null; },
    async setBg(blob)        { return _run(BG_STORE, 'readwrite', s => s.put(blob, BG_KEY)); },
    async clearBg()          { return _run(BG_STORE, 'readwrite', s => s.delete(BG_KEY)); },

    // ----- photos (keyed by photo.id) -----
    async getPhoto(id)       { return (await _run(PHOTO_STORE, 'readonly',  s => s.get(id))) || null; },
    async setPhoto(id, blob) { return _run(PHOTO_STORE, 'readwrite', s => s.put(blob, id)); },
    async deletePhoto(id)    { return _run(PHOTO_STORE, 'readwrite', s => s.delete(id)); },
    async clearPhotos()      { return _run(PHOTO_STORE, 'readwrite', s => s.clear()); }
  };
})();

// Back-compat alias: the rest of the file (and any user-facing imports/
// exports) still references bgMediaStore by name. New code can use
// mediaStore directly, but keeping this means zero regression risk for
// the existing call sites in initBackground().
const bgMediaStore = {
  get:   () => mediaStore.getBg(),
  set:   (blob) => mediaStore.setBg(blob),
  clear: () => mediaStore.clearBg()
};

// Convert a data: URL string back into a Blob — used during the one-time
// migration of existing photos from base64 (chrome.storage) to IndexedDB.
function dataUrlToBlob(dataUrl) {
  try {
    const [header, b64] = dataUrl.split(',');
    const mime = (header.match(/data:([^;]+)/) || [, 'image/png'])[1];
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (e) { return null; }
}

// ---------- generic app toast (export/import feedback, etc.) ----------
// Visually identical to the Pomodoro toast but kept separate since that
// one is scoped to its own widget/closure. Any feature can call this.
let _appToastTimer = null;
function showAppToast(title, body) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.className = 'pomodoro-toast app-toast';
    toast.innerHTML = '<div class="pomodoro-toast-title"></div><div class="pomodoro-toast-body"></div>';
    document.body.appendChild(toast);
  }
  toast.querySelector('.pomodoro-toast-title').textContent = title;
  toast.querySelector('.pomodoro-toast-body').textContent = body;

  toast.classList.remove('visible');
  requestAnimationFrame(() => toast.classList.add('visible'));

  clearTimeout(_appToastTimer);
  _appToastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}


// ---------- clock ----------
// Optimised: minute-by-minute updates (clock only shows HH:MM, no seconds)
// instead of every second; skips DOM writes when displayed value hasn't
// changed; auto-pauses when the tab is hidden, then resyncs on focus.
const _clockEls = {
  time: document.getElementById('time'),
  ampm: document.getElementById('ampm'),
  date: document.getElementById('date')
};
let _clockLast = { time: '', ampm: '', date: '' };
let _clockTimer = null;

function tickClock() {
  const now = new Date();
  let h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  const hStr = h.toString().padStart(2, '0');
  const timeStr = `${hStr}:${m}`;
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  if (timeStr !== _clockLast.time) { _clockEls.time.textContent = timeStr; _clockLast.time = timeStr; }
  if (ampm    !== _clockLast.ampm) { _clockEls.ampm.textContent = ampm;    _clockLast.ampm = ampm; }
  if (dateStr !== _clockLast.date) { _clockEls.date.textContent = dateStr; _clockLast.date = dateStr; }
}

// Schedule the next tick to land exactly on the next minute boundary,
// so the displayed minute is never up to ~1s late.
function scheduleClock() {
  if (_clockTimer) { clearTimeout(_clockTimer); _clockTimer = null; }
  if (document.visibilityState === 'hidden') return; // don't run while backgrounded
  const now = Date.now();
  const msToNextMinute = 60000 - (now % 60000);
  _clockTimer = setTimeout(() => {
    tickClock();
    scheduleClock();
  }, msToNextMinute + 30); // tiny offset so we're just past the boundary
}

tickClock();
scheduleClock();

// Resync immediately when the tab regains visibility so the clock isn't
// stuck on a stale minute after the user comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    tickClock();
    scheduleClock();
  } else if (_clockTimer) {
    clearTimeout(_clockTimer);
    _clockTimer = null;
  }
});

// ---------- favicon helper ----------
function faviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  } catch (e) { return ''; }
}

// ---------- bookmarks drawer ----------
const bookmarksToggle = document.getElementById('bookmarksToggle');
const bookmarksDrawer = document.getElementById('bookmarksDrawer');
const closeBookmarks = document.getElementById('closeBookmarks');
const bookmarksList = document.getElementById('bookmarksList');

bookmarksToggle.addEventListener('click', () => {
  bookmarksDrawer.classList.toggle('open');
  if (bookmarksDrawer.classList.contains('open')) {
    loadBookmarks();
  }
});

closeBookmarks.addEventListener('click', () => {
  bookmarksDrawer.classList.remove('open');
});

// Close drawer if clicking outside of it and not on the toggle button
document.addEventListener('click', (e) => {
  if (!bookmarksDrawer.contains(e.target) && !bookmarksToggle.contains(e.target)) {
    bookmarksDrawer.classList.remove('open');
  }
});

// Cache the flattened bookmark list so reopening the drawer doesn't
// re-traverse the whole tree every time. Invalidated by chrome.bookmarks
// change events (added below) so it stays in sync if the user edits
// bookmarks elsewhere.
let _bookmarksCache = null;
function _invalidateBookmarksCache() { _bookmarksCache = null; }
if (window.chrome && chrome.bookmarks) {
  ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded']
    .forEach(evt => {
      if (chrome.bookmarks[evt] && chrome.bookmarks[evt].addListener) {
        try { chrome.bookmarks[evt].addListener(_invalidateBookmarksCache); } catch (e) {}
      }
    });
}

async function loadBookmarks() {
  // Render cached list immediately if we have one (avoids a flash of
  // empty drawer); refresh in the background.
  if (_bookmarksCache) {
    renderBookmarksList(_bookmarksCache);
  } else {
    bookmarksList.innerHTML = '';
  }

  if (window.chrome && chrome.bookmarks && chrome.bookmarks.getTree) {
    chrome.bookmarks.getTree((tree) => {
      const flat = [];
      function traverse(nodes) {
        for (const node of nodes) {
          if (node.url) flat.push(node);
          if (node.children) traverse(node.children);
        }
      }
      traverse(tree);
      _bookmarksCache = flat;
      renderBookmarksList(flat);
    });
  } else {
    // Fallback mock bookmarks for non-extension testing
    const mock = [
      { title: 'Google', url: 'https://google.com' },
      { title: 'Brave Search', url: 'https://search.brave.com' },
      { title: 'GitHub', url: 'https://github.com' },
      { title: 'Hacker News', url: 'https://news.ycombinator.com' },
      { title: 'YouTube', url: 'https://youtube.com' }
    ];
    renderBookmarksList(mock);
  }
}

function renderBookmarksList(bookmarks) {
  bookmarksList.innerHTML = '';
  if (bookmarks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bookmark-empty';
    empty.textContent = 'No bookmarks found.';
    bookmarksList.appendChild(empty);
    return;
  }

  bookmarks.forEach(bm => {
    const a = document.createElement('a');
    a.className = 'bookmark-item';
    a.href = bm.url;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.chrome && chrome.tabs) {
        chrome.tabs.getCurrent((tab) => {
          if (tab) chrome.tabs.update(tab.id, { url: bm.url });
          else window.location.href = bm.url;
        });
      } else {
        window.location.href = bm.url;
      }
    });

    const img = document.createElement('img');
    img.className = 'bookmark-icon';
    img.src = faviconUrl(bm.url);
    img.alt = '';
    img.onerror = () => {
      img.remove();
      const initial = document.createElement('div');
      initial.className = 'bookmark-fallback-icon';
      initial.textContent = bm.title ? bm.title.trim().slice(0, 1).toUpperCase() : 'B';
      a.insertBefore(initial, a.firstChild);
    };
    a.appendChild(img);

    const title = document.createElement('span');
    title.className = 'bookmark-title';
    title.textContent = bm.title || bm.url;
    title.title = bm.title || bm.url;
    a.appendChild(title);

    bookmarksList.appendChild(a);
  });
}

// ---------- tasks ----------
const taskInput = document.getElementById('taskInput');
const taskList = document.getElementById('taskList');
const taskCount = document.getElementById('taskCount');

// Tasks use incremental rendering: toggling "done" or deleting a single
// task no longer rebuilds the entire list (which used to discard and
// re-create every DOM node on every click). Each .task-item carries its
// own data-task-id, and event handlers act on the matching record in the
// stored array — the DOM only mutates the affected row.
function _makeTaskRow(task) {
  const li = document.createElement('li');
  li.className = 'task-item';
  li.dataset.taskId = task.id;

  const handle = document.createElement('div');
  handle.className = 'task-drag-handle';
  handle.title = 'Drag to reorder';
  handle.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

  const check = document.createElement('div');
  check.className = 'task-check' + (task.done ? ' done' : '');

  const text = document.createElement('span');
  text.className = 'task-text' + (task.done ? ' done' : '');
  text.textContent = task.text;

  const del = document.createElement('span');
  del.className = 'task-del';
  del.textContent = '×';

  li.appendChild(handle);
  li.appendChild(check);
  li.appendChild(text);
  li.appendChild(del);
  return li;
}

function renderTasks(tasks) {
  taskList.innerHTML = '';
  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'task-empty';
    empty.textContent = 'Nothing yet.';
    taskList.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const task of tasks) frag.appendChild(_makeTaskRow(task));
  taskList.appendChild(frag);
}

function updateCount(tasks) {
  const left = tasks.filter(t => !t.done).length;
  taskCount.textContent = `${left} left`;
}

// Ensure every task has a stable id; older saved data was index-keyed.
function _ensureTaskIds(tasks) {
  let dirty = false;
  for (const t of tasks) {
    if (!t.id) {
      t.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      dirty = true;
    }
  }
  return dirty;
}

async function initTasks() {
  const tasks = await store.get('tasks', []);
  if (_ensureTaskIds(tasks)) await store.set('tasks', tasks);
  renderTasks(tasks);
  updateCount(tasks);
}
initTasks();

// One delegated click listener on the whole list handles both the
// checkbox and the × delete button — no per-row listeners to attach.
taskList.addEventListener('click', async (e) => {
  const row = e.target.closest('.task-item');
  if (!row) return;
  const id = row.dataset.taskId;
  const tasks = await store.get('tasks', []);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return;

  if (e.target.classList.contains('task-check')) {
    tasks[idx].done = !tasks[idx].done;
    await store.set('tasks', tasks);
    // Just toggle the two affected classes — no rebuild.
    e.target.classList.toggle('done', tasks[idx].done);
    const textEl = row.querySelector('.task-text');
    if (textEl) textEl.classList.toggle('done', tasks[idx].done);
    updateCount(tasks);
    return;
  }
  if (e.target.classList.contains('task-del')) {
    tasks.splice(idx, 1);
    await store.set('tasks', tasks);
    row.remove();
    if (tasks.length === 0) renderTasks(tasks); // shows the "Nothing yet" placeholder
    updateCount(tasks);
  }
});

taskInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const text = taskInput.value.trim();
  if (!text) return;
  const current = await store.get('tasks', []);
  const newTask = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    text, done: false
  };
  current.push(newTask);
  await store.set('tasks', current);
  taskInput.value = '';
  // Append-only update if there are existing rows, otherwise re-render
  // to drop the empty-state placeholder.
  if (taskList.querySelector('.task-item')) {
    taskList.appendChild(_makeTaskRow(newTask));
  } else {
    renderTasks(current);
  }
  updateCount(current);
});

// ---------- Task reordering (drag handle) ----------
// Press-and-drag the grip handle to reorder a task; crossing another
// row's vertical midpoint swaps it into that slot immediately.
//
// IMPORTANT: pointermove/pointerup/pointercancel are attached to the
// *document*, NOT to the handle. Earlier versions used
// handle.setPointerCapture(), but because we call insertBefore() on the
// dragging row mid-drag, the browser silently drops the capture on the
// handle (a child of the reparented element) — after which no further
// pointer events reach the handle listeners. That caused the exact
// reported symptom: only ONE swap happens, then nothing moves, and on
// release the pointerup never fires so the lifted state + grabbing
// cursor stay stuck until another pointerdown on the handle resets it.
// document listeners can't be lost by DOM reparenting.
(function initTaskReorder() {
  // Module-level guard against a stuck-drag if something ever throws
  // between pointerdown and pointerup — a subsequent pointerdown will
  // still find a clean slate.
  let activeDrag = null;

  function endActiveDrag() {
    if (!activeDrag) return;
    const d = activeDrag;
    activeDrag = null;
    document.removeEventListener('pointermove', d.move);
    document.removeEventListener('pointerup', d.up);
    document.removeEventListener('pointercancel', d.up);
    if (d.rafId) cancelAnimationFrame(d.rafId);
    if (d.draggingRow) d.draggingRow.classList.remove('task-dragging');
    document.body.classList.remove('task-reordering');
  }

  taskList.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const handle = e.target.closest('.task-drag-handle');
    if (!handle) return;
    const draggingRow = handle.closest('.task-item');
    if (!draggingRow) return;
    e.preventDefault();

    // If somehow a previous drag never cleaned up, tear it down first.
    if (activeDrag) endActiveDrag();

    const state = {
      draggingRow,
      rafId: 0,
      latestY: e.clientY,
      move: null,
      up: null,
    };
    activeDrag = state;

    draggingRow.classList.add('task-dragging');
    // Forces a grabbing cursor everywhere (not just over the handle) and
    // blocks text selection for the duration of the drag — without this,
    // the cursor flickers back to whatever's actually under the pointer
    // (checkmark, text, another handle) as it crosses other rows.
    document.body.classList.add('task-reordering');

    function flush() {
      state.rafId = 0;
      if (!activeDrag) return;
      const rows = taskList.querySelectorAll('.task-item');
      for (const sib of rows) {
        if (sib === draggingRow) continue;
        const r = sib.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const rel = draggingRow.compareDocumentPosition(sib);
        const sibIsBelow = !!(rel & Node.DOCUMENT_POSITION_FOLLOWING);
        const sibIsAbove = !!(rel & Node.DOCUMENT_POSITION_PRECEDING);

        // Dragging DOWN past a row that's currently below us — swap after it.
        if (sibIsBelow && state.latestY > mid) {
          taskList.insertBefore(draggingRow, sib.nextSibling);
          break;
        }
        // Dragging UP past a row that's currently above us — swap before it.
        if (sibIsAbove && state.latestY < mid) {
          taskList.insertBefore(draggingRow, sib);
          break;
        }
      }
    }

    state.move = function move(ev) {
      if (!activeDrag) return;
      state.latestY = ev.clientY;
      if (!state.rafId) state.rafId = requestAnimationFrame(flush);
    };

    state.up = async function up() {
      if (!activeDrag) return;
      // Snapshot the row before endActiveDrag clears it, and do a final
      // synchronous flush so a fast release right after a move still lands
      // the item where the cursor was.
      const row = state.draggingRow;
      if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; flush(); }
      endActiveDrag();

      const orderedIds = Array.from(taskList.querySelectorAll('.task-item')).map(r => r.dataset.taskId);
      const tasks = await store.get('tasks', []);
      const byId = new Map(tasks.map(t => [t.id, t]));
      const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
      // Only write back if every task survived the remap — guards against
      // persisting a corrupted order if something unexpected happened
      // (e.g. a task was deleted from another tab mid-drag).
      if (reordered.length === tasks.length) {
        await store.set('tasks', reordered);
      }
      void row;
    };

    document.addEventListener('pointermove', state.move, { passive: true });
    document.addEventListener('pointerup', state.up);
    document.addEventListener('pointercancel', state.up);
  });

  // Defensive: if the window loses focus mid-drag (e.g. alt-tab), the
  // pointerup may never arrive — end the drag on blur so we don't leave
  // the row stuck in its lifted state.
  window.addEventListener('blur', () => {
    if (activeDrag) endActiveDrag();
  });
})();

// ---------- theme ----------
const themeToggle = document.getElementById('themeToggle');

// Indigo is a solid-panel overlay on top of whichever base theme
// (dark/light) is active — NOT a third value of data-theme. It's its
// own attribute (data-indigo) so toggling it never touches or forgets
// the underlying dark/light choice. Persisted separately for the same
// reason: 'theme' always holds the true dark/light preference even
// while indigo is currently showing on top of it.
//   - Left-click:  toggle dark <-> light (unchanged from before; if
//                  indigo happens to be on, this does NOT touch it)
//   - Right-click: toggle indigo on/off, base theme untouched
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcons();
}

function applyIndigo(enabled) {
  if (enabled) {
    document.documentElement.setAttribute('data-indigo', 'true');
  } else {
    document.documentElement.removeAttribute('data-indigo');
  }
  updateThemeIcons();
  document.dispatchEvent(new CustomEvent('flashdash:indigochange', {
    detail: { enabled }
  }));
}

// Icon always reflects the underlying dark/light state, not indigo —
// indigo is a visual overlay, not a separate identity in the toggle's
// own iconography. There are two instances (dock + full sidebar).
function updateThemeIcons() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const icons = document.querySelectorAll('.theme-icon-svg');
  const html = theme === 'light'
    ? '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'
    : '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>';
  icons.forEach(icon => { icon.innerHTML = html; });
}

async function initTheme() {
  const theme = await store.get('theme', 'dark');
  const indigoEnabled = await store.get('indigoEnabled', false);
  applyTheme(theme);
  applyIndigo(indigoEnabled);
}
initTheme();

// Left-click: dark <-> light, exactly as before. While indigo is on,
// this still flips the underlying preference but does NOT turn indigo
// off — per spec, only a click ON the indigo-active button exits it,
// and left-click while indigo is active means "leave indigo, reveal
// whatever dark/light was already set" rather than "flip + leave".
themeToggle.addEventListener('click', async () => {
  const indigoEnabled = document.documentElement.getAttribute('data-indigo') === 'true';
  if (indigoEnabled) {
    // Exit indigo, reveal the underlying theme as-is — no flip.
    applyIndigo(false);
    await store.set('indigoEnabled', false);
    return;
  }
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await store.set('theme', next);
});

// Right-click: toggle indigo on/off, base theme preference untouched.
themeToggle.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const indigoEnabled = document.documentElement.getAttribute('data-indigo') === 'true';
  const next = !indigoEnabled;
  applyIndigo(next);
  await store.set('indigoEnabled', next);
});


// ══════════════════════════════════════════════════════════════
// Left Navigation — Sidebar (two-level)
// ──────────────────────────────────────────────────────────────
// Level 1 (.sidebar-dock) is the always-visible compact pill: the
// hamburger toggle plus the most-used actions (Sites, Add Note, Theme,
// Clear Dashboard) as real buttons.
// Level 2 (.sidebar-panel) is the full slide-out icon grid for the
// remaining actions (Add Image, Bookmarks, Pomodoro, Countdown) —
// actions already reachable from the dock are intentionally left out
// so nothing is duplicated. See the "Toolbar Layout Logic" comment
// above #sidebarList in newtab.html for how the icon grid itself works.
// While the panel is open, the dock fades out (the hamburger included)
// so the panel doesn't render on top of it — there is only ever one
// set of icons visible at a time. The panel's own back arrow (◂) is
// the "go back to the compact dock" control, not a modal-style close.
// ══════════════════════════════════════════════════════════════
(function initSidebar() {
  const dock = document.getElementById('sidebarDock');
  const toggleBtn = document.getElementById('sidebarToggleBtn');
  const panel = document.getElementById('sidebarPanel');
  const backdrop = document.getElementById('sidebarBackdrop');
  const backBtn = document.getElementById('sidebarBackBtn');

  function setOpen(open) {
    panel.classList.toggle('open', open);
    backdrop.classList.toggle('open', open);
    toggleBtn.classList.toggle('active', open);
    dock.classList.toggle('collapsed-mode', open);
    store.set('sidebarOpen', open);
  }

  function isOpen() {
    return panel.classList.contains('open');
  }

  toggleBtn.addEventListener('click', () => setOpen(!isOpen()));
  backBtn.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });

  // Icon buttons in the expanded panel still need it to close once
  // their action is performed — their own handlers (registered
  // elsewhere) run first, this just adds the "go back to the dock
  // afterwards" behavior on top.
  const panelActionIds = ['addPhotoBtn', 'bookmarksToggle', 'pomodoroToggleBtn', 'countdownToggleBtn', 'journalToggleBtn'];
  panelActionIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', () => setOpen(false));
  });

  (async function init() {
    const open = await store.get('sidebarOpen', false);
    setOpen(open);
  })();
})();


// ---------- Gallery of Goals (Glassmorphic Polaroid) + Sticky Notes ----------
const board = document.getElementById('board');
const photoInput = document.getElementById('photoInput');
const addPhotoBtn = document.getElementById('addPhotoBtn');
const addNoteBtn = document.getElementById('addNoteBtn');
const clearPhotosBtn = document.getElementById('clearPhotosBtn');

// Shared z-index counter across photos AND notes so "bring to front" works
// consistently no matter what kind of item the user last touched.
let _boardZCounter = 10;

// ══════════════════════════════════════════════════════════════
// Stash-on-drop bootstrap
// ──────────────────────────────────────────────────────────────
// Photos and notes both use their own drag helpers (makePhotoInteractive
// and makeDraggable) which run long before the Stuff module at the bottom
// of this file has initialised. We publish a tiny controller stub here
// that the Stuff module fills in later; buildStashHooks() below just
// forwards to that stub, so a hook created early still "comes to life"
// once Stuff init has run. Any drag that begins before Stuff init simply
// gets a no-op stash (which is the correct fallback: nothing to stash to).
const _stashController = {
  begin: null,   // (kind, wrapEl, item)   -> void
  move:  null,   // (x, y)                 -> void
  end:   null    // (kind, wrapEl, item, x, y) -> bool (true = item was stashed)
};

function buildStashHooks(ctx) {
  // ctx = { kind: 'photo'|'note', item, wrapEl }
  // The returned object is what makePhotoInteractive/makeDraggable call
  // on drag start/move/end. Each method is a thin wrapper that dispatches
  // to _stashController if it's wired up, otherwise silently no-ops.
  return {
    begin(wrapEl) {
      if (_stashController.begin) _stashController.begin(ctx.kind, wrapEl, ctx.item);
    },
    move(x, y) {
      if (_stashController.move) _stashController.move(x, y);
    },
    end(x, y) {
      if (!_stashController.end) return false;
      return !!_stashController.end(ctx.kind, ctx.wrapEl, ctx.item, x, y);
    }
  };
}

// rAF-batched drag: pointermove events fire ~120-1000Hz on modern mice/
// trackpads. Writing style.left/top synchronously on every event causes
// layout thrashing and dropped frames; instead we coalesce multiple
// moves into one paint per frame.
//
// Stash-on-drop: an optional 4th argument identifies the item as a note
// (or photo) so the shared "drop over Sites button = stash" flow (defined
// far below in the Stuff module) can hook in. The drag helper itself
// stays generic — it just publishes a small drag descriptor on
// window.__activeBoardDrag while moving, and lets the Stuff module
// consult that state on pointerup / pointermove via boardDragUpdate().
function makeDraggable(el, item, onChange, stashHooks) {
  el.addEventListener('pointerdown', (e) => {
    // Skip drag-start for anything interactive — buttons, inputs, editable
    // text — so clicks on controls inside a draggable card/photo/note still
    // register normally instead of being swallowed by the drag handler.
    if (
      e.target.closest('.del') || e.target.closest('.resize') ||
      e.target.closest('.note-text') || e.target.closest('.note-dot') ||
      e.target.closest('.note-close') || e.target.closest('.note-resize') ||
      e.target.closest('button') || e.target.closest('input') ||
      e.target.closest('a') || e.target.closest('[contenteditable="true"]')
    ) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const origX = item.x, origY = item.y;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';

    // Announce the drag to the Stuff module (no-op if it hasn't loaded yet).
    if (stashHooks) stashHooks.begin(el);

    let pendingX = item.x, pendingY = item.y;
    let rafId = 0;
    const flush = () => {
      rafId = 0;
      el.style.left = pendingX + 'px';
      el.style.top  = pendingY + 'px';
    };

    function move(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      pendingX = origX + dx;
      pendingY = origY + dy;
      item.x = pendingX;
      item.y = pendingY;
      if (!rafId) rafId = requestAnimationFrame(flush);
      if (stashHooks) stashHooks.move(ev.clientX, ev.clientY);
    }
    function up(ev) {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (rafId) { cancelAnimationFrame(rafId); flush(); }
      el.style.cursor = 'grab';
      // If the drop landed on the Sites stash target, tryStash() takes
      // over: it removes the item from storage + DOM and returns true.
      // In that case we intentionally SKIP onChange() so we don't
      // re-persist a phantom position for something we just deleted.
      const stashed = stashHooks ? stashHooks.end(ev ? ev.clientX : null, ev ? ev.clientY : null) : false;
      if (!stashed) onChange();
    }
    el.addEventListener('pointermove', move, { passive: true });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

function makeResizable(el, handle, item, onChange, minW = 120, minH = 150) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origW = item.w, origH = item.h;
    handle.setPointerCapture(e.pointerId);

    let pendingW = item.w, pendingH = item.h;
    let rafId = 0;
    const flush = () => {
      rafId = 0;
      el.style.width  = pendingW + 'px';
      el.style.height = pendingH + 'px';
    };

    function move(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      pendingW = Math.max(minW, origW + dx);
      pendingH = Math.max(minH, origH + dy);
      item.w = pendingW;
      item.h = pendingH;
      if (!rafId) rafId = requestAnimationFrame(flush);
    }
    function up() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (rafId) { cancelAnimationFrame(rafId); flush(); }
      onChange();
    }
    handle.addEventListener('pointermove', move, { passive: true });
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

// ── Photo edge-resize + snap-to-neighbor system ─────────────────────────
// Photos resize from any edge/corner (hover near the border for the
// resize cursor) instead of a single corner handle, and both dragging and
// resizing snap to the edges, centers, and gap-spacing of other photos —
// with dashed guide lines while the snap is active. Scoped to photos only
// (notes keep the simpler makeDraggable/makeResizable pair above).
const RESIZE_BORDER = 8;   // px from the edge that counts as a resize zone
const SNAP_THRESHOLD = 12; // proximity in px to trigger snapping
const SNAP_GAP = 16;       // gap spacing for side-by-side snapping

function getResizeDirection(el, clientX, clientY) {
  const rect = el.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  let dir = '';
  if (y < RESIZE_BORDER) dir += 'n';
  else if (y > rect.height - RESIZE_BORDER) dir += 's';
  if (x < RESIZE_BORDER) dir += 'w';
  else if (x > rect.width - RESIZE_BORDER) dir += 'e';
  return dir;
}

function getOtherPhotoRects(excludeId) {
  const rects = [];
  board.querySelectorAll('.photo').forEach(el => {
    if (el.dataset.id === excludeId) return;
    const r = el.getBoundingClientRect();
    rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
  });
  // Also include the viewport itself as a snap target so photos snap to
  // screen center and screen edges — handy for solo photos with no
  // neighbors yet. Marked so the guide renderer can style it differently.
  return rects;
}

// ── SNAP GUIDE RENDERER (reconciled) ──────────────────────────────────
// Canva/Figma-style guides. The renderer is a KEYED RECONCILER: elements
// are pooled and re-used across frames, and only the elements whose
// position/size changed are touched. This kills the flicker you get from
// clearing and recreating all DOM nodes every frame — a guide that stays
// in the same place across many frames keeps the same DOM node, so no
// fade-in animation is retriggered and no layout thrashing happens.
//
// Guide types:
//   • edge guides   — magenta bounded lines between the moving photo and
//                     the neighbor(s) it's aligning to (edge-to-edge or
//                     gap-spaced).
//   • center guides — violet bounded lines for center-to-center alignment.
//   • dim brackets  — green pixel-dimension brackets. During RESIZE these
//                     are shown for every visible photo (dragged and all
//                     others) so you can eyeball width/height matches at
//                     any moment; during DRAG they only appear when a
//                     size-match to a neighbor is detected.
//   • spacing badges— "= 24" pills in the gaps between the moving photo
//                     and two collinear neighbors when spacing matches.
const _snapGuidePool = new Map();  // key -> HTMLElement
const _snapGuideInUse = new Set(); // keys touched during current render pass

function _guide(key, className) {
  let el = _snapGuidePool.get(key);
  if (!el) {
    el = document.createElement('div');
    el.className = className;
    document.body.appendChild(el);
    _snapGuidePool.set(key, el);
  } else if (el.className !== className) {
    el.className = className;
  }
  _snapGuideInUse.add(key);
  return el;
}

// Set a style property only if it actually changed — avoids invalidating
// styles/layout when the same guide sits at the same coordinates across
// multiple frames (the common case when a snap is "held" during a drag).
function _setStyle(el, prop, value) {
  if (el.style[prop] !== value) el.style[prop] = value;
}
function _setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// Dimension-bracket labels live in a nested <span> (not the bracket div's
// own textContent) so CSS can style the caliper line and the floating
// pixel-value pill independently. The span is created once per pooled
// element and reused across frames, same as the element itself.
function _setDimLabel(el, text) {
  let span = el.firstElementChild;
  if (!span || !span.classList.contains('snap-dim-label')) {
    span = document.createElement('span');
    span.className = 'snap-dim-label';
    el.appendChild(span);
  }
  if (span.textContent !== text) span.textContent = text;
}

function _drawVGuide(key, x, rects, kind) {
  let top = Infinity, bot = -Infinity;
  for (const r of rects) {
    if (r.top < top) top = r.top;
    if (r.bottom > bot) bot = r.bottom;
  }
  if (!isFinite(top) || !isFinite(bot)) return;
  const el = _guide(key, 'snap-guide snap-guide-v snap-guide-' + kind);
  _setStyle(el, 'left',   (x - 0.5) + 'px');
  _setStyle(el, 'top',    top + 'px');
  _setStyle(el, 'height', (bot - top) + 'px');
}

function _drawHGuide(key, y, rects, kind) {
  let left = Infinity, right = -Infinity;
  for (const r of rects) {
    if (r.left < left) left = r.left;
    if (r.right > right) right = r.right;
  }
  if (!isFinite(left) || !isFinite(right)) return;
  const el = _guide(key, 'snap-guide snap-guide-h snap-guide-' + kind);
  _setStyle(el, 'top',   (y - 0.5) + 'px');
  _setStyle(el, 'left',  left + 'px');
  _setStyle(el, 'width', (right - left) + 'px');
}

// Dimension bracket. `key` identifies which photo (and axis) so the same
// DOM node is reused across frames while a resize is in progress.
function _drawDimBracket(key, rect, axis) {
  const el = _guide(key, 'snap-guide snap-dim-bracket snap-dim-' + axis);
  if (axis === 'w') {
    _setStyle(el, 'left',   rect.left + 'px');
    _setStyle(el, 'top',    (rect.bottom + 8) + 'px');
    _setStyle(el, 'width',  (rect.right - rect.left) + 'px');
    _setStyle(el, 'height', '');
    _setDimLabel(el, Math.round(rect.right - rect.left) + ' px');
  } else {
    _setStyle(el, 'left',   (rect.right + 8) + 'px');
    _setStyle(el, 'top',    rect.top + 'px');
    _setStyle(el, 'height', (rect.bottom - rect.top) + 'px');
    _setStyle(el, 'width',  '');
    _setDimLabel(el, Math.round(rect.bottom - rect.top) + ' px');
  }
}

function _drawSpacingBadge(key, x, y, gap) {
  const el = _guide(key, 'snap-guide snap-spacing-badge');
  _setStyle(el, 'left', x + 'px');
  _setStyle(el, 'top',  y + 'px');
  _setText(el, '= ' + Math.round(gap));
}

// Remove any guide that WASN'T rendered this pass — the reconciler's
// commit step. Called at the end of renderSnapReport.
function _commitSnapGuides() {
  for (const [key, el] of _snapGuidePool) {
    if (!_snapGuideInUse.has(key)) {
      el.remove();
      _snapGuidePool.delete(key);
    }
  }
  _snapGuideInUse.clear();
}

// Hard reset — called at the end of a drag/resize.
function clearSnapGuides() {
  for (const el of _snapGuidePool.values()) el.remove();
  _snapGuidePool.clear();
  _snapGuideInUse.clear();
}

// Full guide renderer. `report` is the structured output of computeSnap.
// `mode` is 'resize' or 'drag' — controls whether dimension brackets are
// shown for every photo (resize) or only when a size-match is detected
// (drag).
function renderSnapReport(report, dragRect, mode) {
  if (!report) { clearSnapGuides(); return; }

  // Vertical guides (X-axis alignment) — grouped by their screen X.
  for (const g of report.vGuides) {
    const involved = [dragRect, ...g.rects];
    _drawVGuide('v:' + g.kind + ':' + Math.round(g.x), g.x, involved, g.kind);
  }
  // Horizontal guides (Y-axis alignment) — grouped by their screen Y.
  for (const g of report.hGuides) {
    const involved = [dragRect, ...g.rects];
    _drawHGuide('h:' + g.kind + ':' + Math.round(g.y), g.y, involved, g.kind);
  }

  if (mode === 'resize') {
    // Always draw dim brackets on the dragged photo…
    _drawDimBracket('dim:drag:w', dragRect, 'w');
    _drawDimBracket('dim:drag:h', dragRect, 'h');
    // …and on every other photo, so any potential dimension match is
    // visible from anywhere on the board without having to hit an exact
    // snap threshold first.
    if (report.allRects) {
      let i = 0;
      for (const r of report.allRects) {
        _drawDimBracket('dim:o' + i + ':w', r, 'w');
        _drawDimBracket('dim:o' + i + ':h', r, 'h');
        i++;
      }
    }
  } else {
    // Drag mode — only show brackets when a dimension actually matches.
    for (let i = 0; i < report.sizeMatches.length; i++) {
      const m = report.sizeMatches[i];
      _drawDimBracket('dim:drag:' + m.axis, dragRect, m.axis);
      _drawDimBracket('dim:m' + i + ':' + m.axis, m.rect, m.axis);
    }
  }

  // Equal-spacing badges between the three collinear rects.
  for (let i = 0; i < report.spacing.length; i++) {
    const s = report.spacing[i];
    _drawSpacingBadge('sp:' + i, s.x, s.y, s.gap);
  }

  // Reconcile: everything NOT touched this frame gets removed.
  _commitSnapGuides();
}

// Checks a dragged/resized rect against a precomputed list of other photo
// rects and returns a structured snap report:
//   { snapX, snapY, vGuides, hGuides, sizeMatches, spacing, allRects }
//
// vGuides / hGuides are ARRAYS — one entry per distinct alignment line —
// with the involved neighbor rects so the renderer can bound the line to
// just those photos (Canva/Figma style) instead of drawing it across the
// whole viewport.
//
// `others` is captured once at drag-start by the caller since only the
// dragged photo moves during its own drag.
function computeSnap(dragRect, others) {
  const dLeft = dragRect.left, dRight = dragRect.right;
  const dTop = dragRect.top, dBottom = dragRect.bottom;
  const dCenterX = (dLeft + dRight) / 2, dCenterY = (dTop + dBottom) / 2;
  const dW = dRight - dLeft, dH = dBottom - dTop;

  // ---- Axis snap selection (nearest wins) ----
  // Each candidate is { delta, guideValue, kind, rect } — delta is how far
  // the dragged rect needs to move on this axis to lock into the guide.
  const xCandidates = [];
  const yCandidates = [];

  for (const o of others) {
    const oCenterX = (o.left + o.right) / 2;
    const oCenterY = (o.top + o.bottom) / 2;

    // Edge-to-edge alignment (left-left, right-right, top-top, bottom-bottom)
    xCandidates.push({ delta: o.left  - dLeft,   guideValue: o.left,   kind: 'edge',   rect: o });
    xCandidates.push({ delta: o.right - dRight,  guideValue: o.right,  kind: 'edge',   rect: o });
    // Flush alignment (right-of-neighbor to left-of-drag and vice versa)
    xCandidates.push({ delta: o.right - dLeft,   guideValue: o.right,  kind: 'edge',   rect: o });
    xCandidates.push({ delta: o.left  - dRight,  guideValue: o.left,   kind: 'edge',   rect: o });
    // Side-by-side, gap-spaced
    xCandidates.push({ delta: (o.right + SNAP_GAP) - dLeft,  guideValue: o.right + SNAP_GAP, kind: 'edge', rect: o });
    xCandidates.push({ delta: (o.left  - SNAP_GAP) - dRight, guideValue: o.left  - SNAP_GAP, kind: 'edge', rect: o });
    // Center-to-center (accent kind so the renderer colors it differently)
    xCandidates.push({ delta: oCenterX - dCenterX, guideValue: oCenterX, kind: 'center', rect: o });

    yCandidates.push({ delta: o.top    - dTop,    guideValue: o.top,    kind: 'edge',   rect: o });
    yCandidates.push({ delta: o.bottom - dBottom, guideValue: o.bottom, kind: 'edge',   rect: o });
    yCandidates.push({ delta: o.bottom - dTop,    guideValue: o.bottom, kind: 'edge',   rect: o });
    yCandidates.push({ delta: o.top    - dBottom, guideValue: o.top,    kind: 'edge',   rect: o });
    yCandidates.push({ delta: (o.bottom + SNAP_GAP) - dTop,    guideValue: o.bottom + SNAP_GAP, kind: 'edge', rect: o });
    yCandidates.push({ delta: (o.top    - SNAP_GAP) - dBottom, guideValue: o.top    - SNAP_GAP, kind: 'edge', rect: o });
    yCandidates.push({ delta: oCenterY - dCenterY, guideValue: oCenterY, kind: 'center', rect: o });
  }

  // Pick the nearest candidate on each axis that's within threshold.
  function pickBest(cands) {
    let best = null;
    for (const c of cands) {
      const d = Math.abs(c.delta);
      if (d < SNAP_THRESHOLD && (!best || d < Math.abs(best.delta))) best = c;
    }
    return best;
  }

  const bestX = pickBest(xCandidates);
  const bestY = pickBest(yCandidates);

  const snapX = bestX ? bestX.delta : 0;
  const snapY = bestY ? bestY.delta : 0;

  // The post-snap rect (what the photo WILL be after this frame's snap).
  const finalRect = {
    left: dLeft + snapX,
    right: dRight + snapX,
    top: dTop + snapY,
    bottom: dBottom + snapY,
  };

  // ---- Group guides: any neighbor that ALSO sits exactly on the winning
  // line contributes to the same merged guide (bounded line spans them all).
  const vGuides = [];
  const hGuides = [];
  const EPS = 0.75; // sub-pixel tolerance after snap

  if (bestX !== null && bestX !== undefined) {
    const gx = bestX.guideValue;
    const rects = [];
    for (const o of others) {
      const oCenterX = (o.left + o.right) / 2;
      if (
        Math.abs(o.left - gx) < EPS ||
        Math.abs(o.right - gx) < EPS ||
        Math.abs(oCenterX - gx) < EPS ||
        Math.abs((o.right + SNAP_GAP) - gx) < EPS ||
        Math.abs((o.left - SNAP_GAP) - gx) < EPS
      ) rects.push(o);
    }
    if (rects.length === 0) rects.push(bestX.rect);
    vGuides.push({ x: gx, kind: bestX.kind, rects });
  }
  if (bestY !== null && bestY !== undefined) {
    const gy = bestY.guideValue;
    const rects = [];
    for (const o of others) {
      const oCenterY = (o.top + o.bottom) / 2;
      if (
        Math.abs(o.top - gy) < EPS ||
        Math.abs(o.bottom - gy) < EPS ||
        Math.abs(oCenterY - gy) < EPS ||
        Math.abs((o.bottom + SNAP_GAP) - gy) < EPS ||
        Math.abs((o.top - SNAP_GAP) - gy) < EPS
      ) rects.push(o);
    }
    if (rects.length === 0) rects.push(bestY.rect);
    hGuides.push({ y: gy, kind: bestY.kind, rects });
  }

  // ---- Same-size detection (width / height matches a neighbor) ----
  const sizeMatches = [];
  for (const o of others) {
    if (Math.abs((o.right - o.left) - dW) < SNAP_THRESHOLD * 0.5) {
      sizeMatches.push({ axis: 'w', rect: o });
    }
    if (Math.abs((o.bottom - o.top) - dH) < SNAP_THRESHOLD * 0.5) {
      sizeMatches.push({ axis: 'h', rect: o });
    }
  }

  // ---- Equal-spacing detection ----
  // Look for triples where the dragged photo sits between two neighbors
  // with roughly equal gaps on both sides (horizontally or vertically).
  const spacing = [];
  const finalCX = (finalRect.left + finalRect.right) / 2;
  const finalCY = (finalRect.top + finalRect.bottom) / 2;

  // Horizontal equal spacing: one neighbor to the left of drag, one to the right,
  // both vertically overlapping the drag.
  const leftNeighbors = [];
  const rightNeighbors = [];
  const topNeighbors = [];
  const botNeighbors = [];
  for (const o of others) {
    const yOverlap = Math.min(finalRect.bottom, o.bottom) - Math.max(finalRect.top, o.top);
    const xOverlap = Math.min(finalRect.right, o.right) - Math.max(finalRect.left, o.left);
    if (yOverlap > 0) {
      if (o.right <= finalRect.left) leftNeighbors.push(o);
      else if (o.left >= finalRect.right) rightNeighbors.push(o);
    }
    if (xOverlap > 0) {
      if (o.bottom <= finalRect.top) topNeighbors.push(o);
      else if (o.top >= finalRect.bottom) botNeighbors.push(o);
    }
  }
  // Nearest on each side
  leftNeighbors.sort((a, b) => b.right - a.right);
  rightNeighbors.sort((a, b) => a.left - b.left);
  topNeighbors.sort((a, b) => b.bottom - a.bottom);
  botNeighbors.sort((a, b) => a.top - b.top);

  if (leftNeighbors[0] && rightNeighbors[0]) {
    const gapL = finalRect.left - leftNeighbors[0].right;
    const gapR = rightNeighbors[0].left - finalRect.right;
    if (Math.abs(gapL - gapR) < 1 && gapL > 2) {
      spacing.push({ x: leftNeighbors[0].right + gapL / 2 - 12, y: finalCY - 10, gap: gapL });
      spacing.push({ x: finalRect.right + gapR / 2 - 12, y: finalCY - 10, gap: gapR });
    }
  }
  if (topNeighbors[0] && botNeighbors[0]) {
    const gapT = finalRect.top - topNeighbors[0].bottom;
    const gapB = botNeighbors[0].top - finalRect.bottom;
    if (Math.abs(gapT - gapB) < 1 && gapT > 2) {
      spacing.push({ x: finalCX - 12, y: topNeighbors[0].bottom + gapT / 2 - 10, gap: gapT });
      spacing.push({ x: finalCX - 12, y: finalRect.bottom + gapB / 2 - 10, gap: gapB });
    }
  }

  return {
    snapX, snapY,
    vGuides, hGuides,
    sizeMatches, spacing,
    // Pass through the full neighbor list so the renderer can draw
    // dimension brackets on every visible photo during a resize —
    // that's how the user asked the size labels to work.
    allRects: others,
    // Back-compat shims for any callers still reading these:
    guideX: bestX ? [bestX.guideValue] : [],
    guideY: bestY ? [bestY.guideValue] : [],
  };
}

// Combined drag + edge-resize handler for a single photo, with
// nearest-match snapping. Hold Alt while dragging/resizing to temporarily
// disable snapping for fine positioning.
//
// All per-pointer-event work here is just cheap arithmetic on numbers
// already in hand; the actual computeSnap pass (and every DOM write) is
// deferred into a single requestAnimationFrame callback per frame, so a
// fast mouse/trackpad firing many pointermove events between paints only
// costs one snap check and one style write per frame, not one per event.
function makePhotoInteractive(el, photo, onChange, stashHooks) {
  let interacting = false;

  // Hover-only cursor feedback (skipped while an interaction is in progress
  // so it doesn't fight with the 'grabbing' cursor set below).
  el.addEventListener('pointermove', (e) => {
    if (interacting) return;
    if (e.target.closest('.del')) { el.style.cursor = 'pointer'; return; }
    const dir = getResizeDirection(el, e.clientX, e.clientY);
    el.style.cursor = dir ? dir + '-resize' : 'grab';
  });

  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return; // ignore right/middle-click drags
    if (e.target.closest('.del')) return;
    e.preventDefault();

    const dir = getResizeDirection(el, e.clientX, e.clientY);
    const startX = e.clientX, startY = e.clientY;
    const origW = photo.w, origH = photo.h, origX = photo.x, origY = photo.y;
    el.setPointerCapture(e.pointerId);
    interacting = true;

    // Other photos don't move during this drag — only measure them once,
    // instead of on every pointermove/frame.
    const otherRects = getOtherPhotoRects(photo.id);

    let rafId = 0;
    let latestEv = null; // most recent raw pointer event; consumed once per frame

    const flush = () => {
      rafId = 0;
      if (!latestEv) return;
      const ev = latestEv;
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      const snapEnabled = !ev.altKey; // hold Alt to disable snapping

      if (dir) {
        // ---- edge/corner resize, with snapping ----
        let newW = origW, newH = origH, newX = origX, newY = origY;

        if (dir.includes('e')) { newW = Math.max(50, origW + dx); }
        else if (dir.includes('w')) {
          const pw = origW - dx;
          if (pw >= 50) { newW = pw; newX = origX + dx; }
        }
        if (dir.includes('s')) { newH = Math.max(50, origH + dy); }
        else if (dir.includes('n')) {
          const ph = origH - dy;
          if (ph >= 50) { newH = ph; newY = origY + dy; }
        }

        if (snapEnabled) {
          const tempRect = { left: newX, top: newY, right: newX + newW, bottom: newY + newH };
          const snap = computeSnap(tempRect, otherRects);
          if (dir.includes('e') && snap.snapX) { newW += snap.snapX; }
          if (dir.includes('s') && snap.snapY) { newH += snap.snapY; }
          if (dir.includes('w') && snap.snapX) { newX += snap.snapX; newW -= snap.snapX; }
          if (dir.includes('n') && snap.snapY) { newY += snap.snapY; newH -= snap.snapY; }
          // Post-snap rect — the guides render against where the photo
          // ACTUALLY lands this frame, so bounded lines line up exactly.
          const finalRect = { left: newX, top: newY, right: newX + newW, bottom: newY + newH };
          renderSnapReport(snap, finalRect, 'resize');
        } else {
          clearSnapGuides();
        }

        photo.w = Math.max(50, newW);
        photo.h = Math.max(50, newH);
        photo.x = newX;
        photo.y = newY;
      } else {
        // ---- drag, with snapping ----
        let x = origX + dx, y = origY + dy;

        const margin = 20;
        x = Math.max(margin, Math.min(window.innerWidth - photo.w - margin, x));
        y = Math.max(margin, Math.min(window.innerHeight - photo.h - margin, y));

        if (snapEnabled) {
          const tempRect = { left: x, top: y, right: x + photo.w, bottom: y + photo.h };
          const snap = computeSnap(tempRect, otherRects);
          x += snap.snapX;
          y += snap.snapY;
          const finalRect = { left: x, top: y, right: x + photo.w, bottom: y + photo.h };
          renderSnapReport(snap, finalRect, 'drag');
        } else {
          clearSnapGuides();
        }

        photo.x = x;
        photo.y = y;
      }

      el.style.left = photo.x + 'px';
      el.style.top = photo.y + 'px';
      el.style.width = photo.w + 'px';
      el.style.height = photo.h + 'px';
    };

    // Same stash-on-drop bookkeeping as makeDraggable — only relevant
    // when the interaction is a drag (dir === null). Resizes skip it.
    const isDrag = !dir;
    if (isDrag && stashHooks) stashHooks.begin(el);

    function move(ev) {
      latestEv = ev;
      if (!rafId) rafId = requestAnimationFrame(flush);
      if (isDrag && stashHooks) stashHooks.move(ev.clientX, ev.clientY);
    }
    function up(ev) {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (rafId) { cancelAnimationFrame(rafId); flush(); }
      interacting = false;
      if (!dir) el.style.cursor = 'grab';
      clearSnapGuides();
      // See makeDraggable for the rationale — stashed photos skip persist.
      const stashed = (isDrag && stashHooks)
        ? stashHooks.end(ev ? ev.clientX : null, ev ? ev.clientY : null)
        : false;
      if (!stashed) onChange();
    }

    if (!dir) el.style.cursor = 'grabbing';
    el.addEventListener('pointermove', move, { passive: true });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// Bring any board item (photo or note) to the front, flash a confirmation
// ring, and persist via the supplied callback.
function bringToFront(wrap, item, persist) {
  _boardZCounter += 1;
  item.z = _boardZCounter;
  wrap.style.zIndex = _boardZCounter;
  wrap.classList.add('photo-lifted');
  setTimeout(() => wrap.classList.remove('photo-lifted'), 350);
  persist();
}

// ── placement helper shared by photo upload & note creation ──────────────
// Scatters new items near a random existing anchor (of either kind) so
// photos and notes interleave naturally instead of stacking in one corner.
function pickPlacement(anchors, w, h) {
  let x, y;
  if (anchors.length > 0) {
    const anchor = anchors[Math.floor(Math.random() * anchors.length)];
    const minOff = 100, maxOff = 200;
    const randOff = () => (minOff + Math.random() * (maxOff - minOff)) * (Math.random() < 0.5 ? 1 : -1);
    x = anchor.x + randOff();
    y = anchor.y + randOff();
  } else {
    x = window.innerWidth / 2 - w / 2;
    y = window.innerHeight / 2 - h / 2;
  }
  const margin = 20;
  x = Math.max(margin, Math.min(window.innerWidth - w - margin, x));
  y = Math.max(margin, Math.min(window.innerHeight - h - margin, y));
  return { x, y };
}

// Track object URLs we mint for photo <img> tags so we can revoke them
// when the photo (or the whole board) is torn down. Without this, every
// re-render leaks blob: URLs and slowly grows browser memory.
const _photoObjectUrls = new Map(); // photo.id -> objectURL

function _revokePhotoUrl(id) {
  const url = _photoObjectUrls.get(id);
  if (url) { URL.revokeObjectURL(url); _photoObjectUrls.delete(id); }
}

// Resolve a photo's image src: prefers IndexedDB blob (new format),
// falls back to inline data-URL still embedded in the photo record
// (pre-migration data).
async function _resolvePhotoSrc(photo) {
  // Already-known object URL for this id
  const cached = _photoObjectUrls.get(photo.id);
  if (cached) return cached;

  const blob = await mediaStore.getPhoto(photo.id);
  if (blob) {
    const url = URL.createObjectURL(blob);
    _photoObjectUrls.set(photo.id, url);
    return url;
  }
  // Legacy fallback (shouldn't normally hit after migration runs)
  return photo.src || '';
}

async function renderPhotoEl(photo) {
  const wrap = document.createElement('div');
  wrap.className = 'photo';
  wrap.dataset.id = photo.id; // lets the snap system exclude this photo from its own neighbor checks
  wrap.style.left = photo.x + 'px';
  wrap.style.top = photo.y + 'px';
  wrap.style.width = photo.w + 'px';
  wrap.style.height = photo.h + 'px';

  // One-shot rotated-ghost pop-in for photos that were just dropped from
  // the OS. Add the class here and strip it after the animation ends so
  // it doesn't leave any lingering styles behind on the element.
  if (_droppedInPhotoIds.has(photo.id)) {
    _droppedInPhotoIds.delete(photo.id);
    wrap.classList.add('photo-dropped-in');
    wrap.addEventListener('animationend', function _clean(ev) {
      if (ev.animationName === 'photo-drop-pop') {
        wrap.classList.remove('photo-dropped-in');
        wrap.removeEventListener('animationend', _clean);
      }
    });
  }

  // Apply persisted z-index (default to 2 if none saved yet)
  const savedZ = photo.z || 2;
  wrap.style.zIndex = savedZ;
  if (savedZ > _boardZCounter) _boardZCounter = savedZ;

  const img = document.createElement('img');
  img.decoding = 'async';     // don't block layout while the bitmap decodes
  img.loading = 'lazy';       // skip decode work for off-screen photos
  img.src = await _resolvePhotoSrc(photo);
  wrap.appendChild(img);

  const del = document.createElement('div');
  del.className = 'del';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    const photos = await store.get('photos', []);
    const filtered = photos.filter(p => p.id !== photo.id);
    await store.set('photos', filtered);
    await mediaStore.deletePhoto(photo.id);
    _revokePhotoUrl(photo.id);
    wrap.remove();
  });
  wrap.appendChild(del);

  board.appendChild(wrap);

  async function persist() {
    const photos = await store.get('photos', []);
    const idx = photos.findIndex(p => p.id === photo.id);
    if (idx > -1) { photos[idx] = photo; await store.set('photos', photos); }
  }

  // Click (not drag) → bring this photo to the front
  wrap.addEventListener('pointerdown', () => bringToFront(wrap, photo, persist));

  // Photos get the edge-resize + snap-to-neighbor system (any border,
  // not just a corner handle); notes keep the simpler drag/corner-resize
  // pair since they don't participate in the photo snap grid.
  // Wire in drop-to-stash: dragging this photo onto the Sites dock button
  // (or the drawer, if it's already open) will move it into the Stuff panel
  // instead of just repositioning it.
  makePhotoInteractive(wrap, photo, persist, buildStashHooks({ kind: 'photo', item: photo, wrapEl: wrap }));
}

// One-time migration: if the saved photos array still contains inline
// `src` data-URLs (the pre-IndexedDB format), move each blob into the
// new photos object store and strip `src` from the JSON. Runs once;
// subsequent loads skip straight through it because no photo still has
// a data-URL src.
async function _migratePhotosToIDB(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return photos;
  const stale = photos.filter(p => p && typeof p.src === 'string' && p.src.startsWith('data:'));
  if (stale.length === 0) return photos;

  for (const p of stale) {
    const blob = dataUrlToBlob(p.src);
    if (blob) {
      await mediaStore.setPhoto(p.id, blob);
    }
    delete p.src; // drop the heavy string from chrome.storage forever
  }
  await store.set('photos', photos);
  return photos;
}

async function renderBoard() {
  let [photos, notes] = await Promise.all([
    store.get('photos', []),
    store.get('notes', [])
  ]);

  // Migrate-on-load (no-op after the first run).
  photos = await _migratePhotosToIDB(photos);

  // Revoke any previously-minted object URLs before wiping the board,
  // otherwise re-rendering accumulates blob refs in browser memory.
  for (const id of _photoObjectUrls.keys()) _revokePhotoUrl(id);

  board.innerHTML = '';
  // Render photos sequentially-but-non-blocking: each awaits its own
  // blob, but we don't block on Promise.all so the first photos paint
  // as soon as their data is ready.
  for (const p of photos) renderPhotoEl(p);
  notes.forEach(renderNoteEl);
}
renderBoard();

// ── shared "add photos" pipeline used by both the file picker and drag-drop ──
// Stores image data as Blobs in IndexedDB (under each photo's id) and keeps
// only lightweight metadata (id/x/y/w/h/z) in chrome.storage.local. Roughly
// 33% smaller on disk than the old base64 path and dramatically faster to
// load on subsequent page opens.
// Track ids of photos that were just dropped from the OS, so renderBoard
// can attach a one-shot rotated pop-in animation to their DOM node. The
// set is drained the first time a matching photo element is rendered.
const _droppedInPhotoIds = new Set();

// `dropPoint`, if provided, is a {x, y} in viewport coordinates — the
// spot where the OS drag was released on the board. When present we
// place photos there (fanned out slightly for multi-file drops) instead
// of using the anchored-random pickPlacement fallback.
async function addPhotoFiles(files, dropPoint = null) {
  const imageFiles = [...files].filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;

  const [photos, notes] = await Promise.all([
    store.get('photos', []),
    store.get('notes', [])
  ]);
  // Anchor pool includes existing notes too, so photos can land near them
  const existingSnapshot = [...photos, ...notes];
  const w = 220, h = 220;

  imageFiles.forEach((_, i) => { /* reserve indices for fan-out */ });

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    let x, y;
    if (dropPoint) {
      // Center the photo on the drop point. If multiple files were dropped
      // at once, fan them out in a small diagonal cascade so they don't
      // stack invisibly on top of each other.
      const offset = i * 24;
      x = dropPoint.x - w / 2 + offset;
      y = dropPoint.y - h / 2 + offset;
      const margin = 20;
      x = Math.max(margin, Math.min(window.innerWidth  - w - margin, x));
      y = Math.max(margin, Math.min(window.innerHeight - h - margin, y));
    } else {
      const pos = pickPlacement(existingSnapshot, w, h);
      x = pos.x; y = pos.y;
    }
    _boardZCounter += 1;
    const id = Date.now() + Math.random().toString(36).slice(2);
    // The file object is already a Blob — store it directly; no FileReader,
    // no base64 round-trip, no decoding cost on the next page load.
    await mediaStore.setPhoto(id, file);
    const photo = { id, x, y, w, h, z: _boardZCounter };
    photos.push(photo);
    existingSnapshot.push(photo);
    // Mark for one-shot pop-in animation when the board re-renders. Only
    // drops from the OS get the rotated ghost-style entrance — file-picker
    // additions still slide in via the default photo styling.
    if (dropPoint) _droppedInPhotoIds.add(id);
  }

  await store.set('photos', photos);
  renderBoard();
}

addPhotoBtn.addEventListener('click', () => {
  // Close any open panels before opening the file picker
  bookmarksDrawer.classList.remove('open');
  sitesDrawer.classList.remove('open');
  photoInput.click();
});

clearPhotosBtn.addEventListener('click', async () => {
  const [photos, notes] = await Promise.all([
    store.get('photos', []),
    store.get('notes', [])
  ]);
  const total = photos.length + notes.length;
  if (total === 0) return;

  const confirmed = confirm(`Remove all ${total} item${total === 1 ? '' : 's'} (photos & notes) from the board?`);
  if (!confirmed) return;

  // Wipe ONLY the on-board photo blobs, not the full `photos` IDB store —
  // stashed photos live in the same store keyed by their id, and blowing
  // it away would silently delete every image in the Stuff drawer too.
  const boardPhotoIds = photos.map(p => p.id).filter(Boolean);
  await Promise.all([
    store.set('photos', []),
    store.set('notes', []),
    ...boardPhotoIds.map(id => mediaStore.deletePhoto(id))
  ]);
  for (const id of _photoObjectUrls.keys()) _revokePhotoUrl(id);
  renderBoard();
});

photoInput.addEventListener('change', async (e) => {
  await addPhotoFiles(e.target.files);
  photoInput.value = '';
});

// ---------- Drag & drop image upload directly onto the board ----------
let _dragDepth = 0; // tracks nested dragenter/dragleave so the overlay doesn't flicker

function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth++;
  board.classList.add('drag-active');
});

window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
});

window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  _dragDepth = Math.max(0, _dragDepth - 1);
  if (_dragDepth === 0) board.classList.remove('drag-active');
});

window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth = 0;
  board.classList.remove('drag-active');
  // Capture the drop point so the new photo(s) appear exactly where the
  // user released them, then get the rotated glass-shadow pop-in — same
  // aesthetic as the Stuff drawer's restore ghost.
  const dropPoint = { x: e.clientX, y: e.clientY };
  await addPhotoFiles(e.dataTransfer.files, dropPoint);
});

// ---------- Sticky Notes ----------
const NOTE_COLORS = ['yellow', 'pink', 'mint', 'sky', 'lilac'];

function renderNoteEl(note) {
  const wrap = document.createElement('div');
  wrap.className = `note note-${note.color || 'yellow'}`;
  wrap.style.left = note.x + 'px';
  wrap.style.top = note.y + 'px';
  wrap.style.width = note.w + 'px';
  wrap.style.height = note.h + 'px';

  const savedZ = note.z || 2;
  wrap.style.zIndex = savedZ;
  if (savedZ > _boardZCounter) _boardZCounter = savedZ;

  async function persist() {
    const notes = await store.get('notes', []);
    const idx = notes.findIndex(n => n.id === note.id);
    if (idx > -1) { notes[idx] = note; await store.set('notes', notes); }
  }

  // Header row: accent dot (click to cycle color) + close button
  const header = document.createElement('div');
  header.className = 'note-header';

  const dot = document.createElement('button');
  dot.className = 'note-dot';
  dot.setAttribute('aria-label', 'Change note color');
  dot.title = 'Change color';
  dot.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const curIdx = NOTE_COLORS.indexOf(note.color);
    note.color = NOTE_COLORS[(curIdx + 1) % NOTE_COLORS.length];
    wrap.className = `note note-${note.color}`;
    wrap.style.left = note.x + 'px';
    wrap.style.top = note.y + 'px';
    wrap.style.width = note.w + 'px';
    wrap.style.height = note.h + 'px';
    wrap.style.zIndex = note.z || savedZ;
    persist();
  });
  header.appendChild(dot);

  const del = document.createElement('div');
  del.className = 'note-close';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    const notes = await store.get('notes', []);
    const filtered = notes.filter(n => n.id !== note.id);
    await store.set('notes', filtered);
    wrap.remove();
  });
  header.appendChild(del);

  wrap.appendChild(header);

  // Editable text area
  const text = document.createElement('div');
  text.className = 'note-text';
  text.contentEditable = 'true';
  text.setAttribute('data-placeholder', 'Type a note…');
  text.textContent = note.text || '';
  text.spellcheck = false;

  let saveTimer = null;
  text.addEventListener('input', () => {
    note.text = text.textContent;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400); // debounce so typing doesn't hammer storage
  });
  // Don't let the drag handler engage while editing, but still bring the
  // note to front so it's not buried under another item while typing.
  text.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    bringToFront(wrap, note, persist);
  });
  wrap.appendChild(text);

  const resize = document.createElement('div');
  resize.className = 'note-resize';
  wrap.appendChild(resize);

  board.appendChild(wrap);

  wrap.addEventListener('pointerdown', () => bringToFront(wrap, note, persist));

  // Drop-to-stash: dragging this note onto the Sites dock button (or the
  // already-open drawer) moves it into the Stuff panel instead of just
  // repositioning it on the board.
  makeDraggable(wrap, note, persist, buildStashHooks({ kind: 'note', item: note, wrapEl: wrap }));
  makeResizable(wrap, resize, note, persist, 160, 130);

  return wrap;
}

addNoteBtn.addEventListener('click', async () => {
  bookmarksDrawer.classList.remove('open');
  sitesDrawer.classList.remove('open');

  const [photos, notes] = await Promise.all([
    store.get('photos', []),
    store.get('notes', [])
  ]);
  const existingSnapshot = [...photos, ...notes];
  const w = 220, h = 200;
  const { x, y } = pickPlacement(existingSnapshot, w, h);

  _boardZCounter += 1;
  const note = {
    id: Date.now() + Math.random().toString(36).slice(2),
    text: '',
    color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
    x, y, w, h,
    z: _boardZCounter
  };
  notes.push(note);
  await store.set('notes', notes);

  const wrap = renderNoteEl(note);
  // Focus the new note's text area immediately so the user can start typing
  requestAnimationFrame(() => {
    const t = wrap.querySelector('.note-text');
    t.focus();
  });
});

// ---------- Sites Drawer (manual quick-access launcher) ----------
const sitesToggleBtn = document.getElementById('sitesToggleBtn');
const sitesDrawer     = document.getElementById('sitesDrawer');
// closeSitesDrawer button was removed from the UI — the drawer now closes
// only by clicking outside, hover-out, or opening a different panel.
const closeSitesDrawer = document.getElementById('closeSitesDrawer');
const sitesGrid       = document.getElementById('sitesGrid');
const sitesAddBtn     = document.getElementById('sitesAddBtn');

const siteDialogBackdrop = document.getElementById('siteDialogBackdrop');
const siteDialogTitle    = document.getElementById('siteDialogTitle');
const siteNameInput      = document.getElementById('siteNameInput');
const siteUrlInput       = document.getElementById('siteUrlInput');
const siteDialogError    = document.getElementById('siteDialogError');
const siteDialogSave     = document.getElementById('siteDialogSave');
const siteDialogClose    = document.getElementById('siteDialogClose');

const MAX_SITES = 15;
let _editingSiteId = null; // null while adding; set to a site's id while editing

// Same navigation pattern used by bookmarks, pinned shortcuts (formerly),
// and the search bar: prefer the tabs API inside the extension, fall back
// to a plain location change for non-extension/testing contexts.
function navigateTo(url) {
  if (window.chrome && chrome.tabs) {
    chrome.tabs.getCurrent(tab => {
      if (tab) chrome.tabs.update(tab.id, { url });
      else window.location.href = url;
    });
  } else {
    window.location.href = url;
  }
}

// Open / close drawer
sitesToggleBtn.addEventListener('click', () => {
  clearTimeout(_sitesOpenTimer);
  const isOpen = sitesDrawer.classList.contains('open');
  bookmarksDrawer.classList.remove('open');
  sitesDrawer.classList.toggle('open', !isOpen);
  if (!isOpen) loadSites();
});

if (closeSitesDrawer) {
  closeSitesDrawer.addEventListener('click', () => {
    clearTimeout(_sitesOpenTimer);
    clearTimeout(_sitesCloseTimer);
    sitesDrawer.classList.remove('open');
  });
}

document.addEventListener('click', (e) => {
  if (!sitesDrawer.contains(e.target) && !sitesToggleBtn.contains(e.target)) {
    clearTimeout(_sitesOpenTimer);
    clearTimeout(_sitesCloseTimer);
    sitesDrawer.classList.remove('open');
  }
});

// ---------- Hover-to-open (with intent delay) / hover-to-close ----------
// Hovering the Sites button opens the drawer after a short delay, so just
// passing the cursor over the button on the way to somewhere else doesn't
// pop it open — it only opens if the cursor actually lingers there. Once
// open, it closes automatically as soon as the cursor leaves both the
// button and the drawer itself (with a small buffer so moving the mouse
// from the button into the drawer doesn't cause a flicker-close). Clicking
// the button (above) still toggles it open/closed instantly, for
// touch/trackpad users who can't hover.
const SITES_HOVER_OPEN_DELAY = 170;
const SITES_HOVER_CLOSE_DELAY = 200;
let _sitesOpenTimer = null;
let _sitesCloseTimer = null;

function openSitesDrawerViaHover() {
  bookmarksDrawer.classList.remove('open');
  if (!sitesDrawer.classList.contains('open')) {
    sitesDrawer.classList.add('open');
    loadSites();
  }
}

function scheduleSitesClose() {
  clearTimeout(_sitesCloseTimer);
  _sitesCloseTimer = setTimeout(() => {
    sitesDrawer.classList.remove('open');
  }, SITES_HOVER_CLOSE_DELAY);
}

function cancelSitesClose() {
  clearTimeout(_sitesCloseTimer);
}

sitesToggleBtn.addEventListener('mouseenter', () => {
  cancelSitesClose();
  clearTimeout(_sitesOpenTimer);
  _sitesOpenTimer = setTimeout(openSitesDrawerViaHover, SITES_HOVER_OPEN_DELAY);
});

sitesToggleBtn.addEventListener('mouseleave', () => {
  clearTimeout(_sitesOpenTimer);
  if (sitesDrawer.classList.contains('open')) scheduleSitesClose();
});

sitesDrawer.addEventListener('mouseenter', cancelSitesClose);
sitesDrawer.addEventListener('mouseleave', () => {
  if (sitesDrawer.classList.contains('open')) scheduleSitesClose();
});

async function loadSites() {
  const sites = await store.get('customSites', []);
  renderSitesGrid(sites);
}

function renderSitesGrid(sites) {
  sitesGrid.innerHTML = '';

  sites.forEach(site => {
    const tile = document.createElement('div');
    tile.className = 'site-tile';

    const open = document.createElement('button');
    open.className = 'site-tile-open';
    open.title = site.name;

    const img = document.createElement('img');
    img.className = 'site-tile-icon';
    img.src = faviconUrl(site.url);
    img.alt = '';
    img.onerror = () => {
      img.remove();
      const fb = document.createElement('div');
      fb.className = 'site-tile-fallback';
      fb.textContent = (site.name || '?').trim().slice(0, 1).toUpperCase();
      open.insertBefore(fb, open.firstChild);
    };
    open.appendChild(img);

    const label = document.createElement('span');
    label.className = 'site-tile-name';
    label.textContent = site.name;
    open.appendChild(label);

    open.addEventListener('click', () => navigateTo(site.url));
    open.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showSiteContextMenu(e.clientX, e.clientY, site);
    });

    tile.appendChild(open);
    sitesGrid.appendChild(tile);
  });

  // Pad remaining slots up to 15 with empty placeholders so the 3x5 grid
  // shape stays fixed regardless of how many sites are saved.
  for (let i = sites.length; i < MAX_SITES; i++) {
    const empty = document.createElement('div');
    empty.className = 'site-tile site-tile-empty';
    sitesGrid.appendChild(empty);
  }

  syncSitesAddBtn(sites.length);
}

// ---------- Right-click context menu for site tiles ----------
const siteContextMenu = document.getElementById('siteContextMenu');
const siteCtxEdit = document.getElementById('siteCtxEdit');
const siteCtxDelete = document.getElementById('siteCtxDelete');

let _siteCtxTarget = null; // the site object currently right-clicked

function showSiteContextMenu(x, y, site) {
  _siteCtxTarget = site;
  siteContextMenu.style.display = 'block';

  // Position: prefer right/below cursor, flip if too close to an edge.
  const menuW = siteContextMenu.offsetWidth || 160;
  const menuH = siteContextMenu.offsetHeight || 80;
  const left = (x + menuW > window.innerWidth) ? x - menuW : x;
  const top  = (y + menuH > window.innerHeight) ? y - menuH : y;

  siteContextMenu.style.left = left + 'px';
  siteContextMenu.style.top = top + 'px';

  // Re-trigger the entrance animation each time it opens.
  siteContextMenu.style.animation = 'none';
  requestAnimationFrame(() => { siteContextMenu.style.animation = ''; });
}

function hideSiteContextMenu() {
  siteContextMenu.style.display = 'none';
  _siteCtxTarget = null;
}

document.addEventListener('click', (e) => {
  if (!siteContextMenu.contains(e.target)) hideSiteContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSiteContextMenu();
});
// A right-click elsewhere (e.g. another tile) should also close the menu
// before the new one opens, rather than leaving a stale one behind.
sitesGrid.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.site-tile-open')) hideSiteContextMenu();
});

siteCtxEdit.addEventListener('click', () => {
  if (!_siteCtxTarget) return;
  openSiteDialog(_siteCtxTarget);
  hideSiteContextMenu();
});

siteCtxDelete.addEventListener('click', async () => {
  if (!_siteCtxTarget) return;
  const current = await store.get('customSites', []);
  const updated = current.filter(s => s.id !== _siteCtxTarget.id);
  await store.set('customSites', updated);
  renderSitesGrid(updated);
  syncSitesAddBtn(updated.length);
  hideSiteContextMenu();
});

function syncSitesAddBtn(count) {
  sitesAddBtn.style.display = count >= MAX_SITES ? 'none' : '';
}

// ---------- Add / Edit Site dialog ----------
function normaliseSiteUrl(raw) {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return 'https://' + t;
}

function isValidSiteUrl(raw) {
  try {
    const u = new URL(normaliseSiteUrl(raw));
    return !!u.hostname && u.hostname.includes('.');
  } catch (e) {
    return false;
  }
}

function openSiteDialog(site) {
  _editingSiteId = site ? site.id : null;
  siteDialogTitle.textContent = site ? 'Edit Site' : 'Add Site';
  siteNameInput.value = site ? site.name : '';
  siteUrlInput.value = site ? site.url : '';
  siteDialogError.textContent = '';
  siteDialogBackdrop.classList.add('open');
  setTimeout(() => siteNameInput.focus(), 50);
}

function closeSiteDialog() {
  siteDialogBackdrop.classList.remove('open');
  _editingSiteId = null;
}

sitesAddBtn.addEventListener('click', () => openSiteDialog(null));
siteDialogClose.addEventListener('click', closeSiteDialog);
siteDialogBackdrop.addEventListener('click', (e) => {
  if (e.target === siteDialogBackdrop) closeSiteDialog();
});

siteDialogSave.addEventListener('click', async () => {
  const name = siteNameInput.value.trim();
  const urlRaw = siteUrlInput.value.trim();

  if (!name || !urlRaw) {
    siteDialogError.textContent = 'Please fill in both fields.';
    return;
  }
  if (!isValidSiteUrl(urlRaw)) {
    siteDialogError.textContent = 'Please enter a valid URL.';
    return;
  }

  const url = normaliseSiteUrl(urlRaw);
  const current = await store.get('customSites', []);

  if (_editingSiteId) {
    const idx = current.findIndex(s => s.id === _editingSiteId);
    if (idx > -1) current[idx] = { ...current[idx], name, url };
  } else {
    if (current.length >= MAX_SITES) {
      siteDialogError.textContent = `You can pin up to ${MAX_SITES} sites.`;
      return;
    }
    current.push({ id: Date.now() + Math.random().toString(36).slice(2), name, url });
  }

  await store.set('customSites', current);
  renderSitesGrid(current);
  closeSiteDialog();
});

// Init sites add-button visibility on load
(async () => {
  const sites = await store.get('customSites', []);
  syncSitesAddBtn(sites.length);
})();


// ══════════════════════════════════════════════════════════════
// Settings Menu — opened with "/"
// ──────────────────────────────────────────────────────────────
// For now just two visibility toggles (Tasks, Google search bar).
// Built to grow: future items (e.g. export/import JSON backup) just
// add another .settings-row + a small handler, following this same
// pattern of "settingsState key -> apply function -> toggle handler".
// ══════════════════════════════════════════════════════════════
(function initSettingsMenu() {
  const backdrop = document.getElementById('settingsBackdrop');
  const closeBtn = document.getElementById('settingsClose');
  const toggleTasksBtn = document.getElementById('settingsToggleTasks');
  const toggleSearchBtn = document.getElementById('settingsToggleSearch');

  const tasksCard = document.getElementById('tasksCard');
  const searchWrapper = document.getElementById('searchBarWrapper');

  const DEFAULT_SETTINGS = { tasksVisible: true, searchVisible: true };
  let settings = { ...DEFAULT_SETTINGS };

  function applyTasksVisibility() {
    tasksCard.style.display = settings.tasksVisible ? '' : 'none';
    toggleTasksBtn.setAttribute('aria-checked', String(settings.tasksVisible));
    // Lets other modules (e.g. clock position, which can only go to the
    // right while Tasks is hidden) react without polling storage.
    document.dispatchEvent(new CustomEvent('flashdash:tasksvisibility', {
      detail: { visible: settings.tasksVisible }
    }));
  }

  function applySearchVisibility() {
    searchWrapper.style.display = settings.searchVisible ? '' : 'none';
    toggleSearchBtn.setAttribute('aria-checked', String(settings.searchVisible));
  }

  async function persist() {
    await store.set('settingsState', settings);
  }

  function openSettings() {
    backdrop.classList.add('open');
  }

  function closeSettings() {
    backdrop.classList.remove('open');
  }

  closeBtn.addEventListener('click', closeSettings);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSettings();
  });

  toggleTasksBtn.addEventListener('click', async () => {
    settings.tasksVisible = !settings.tasksVisible;
    applyTasksVisibility();
    await persist();
  });

  toggleSearchBtn.addEventListener('click', async () => {
    settings.searchVisible = !settings.searchVisible;
    applySearchVisibility();
    await persist();
  });

  // ── Backup: Export / Import ──────────────────────────────────
  // Bundles every piece of user data Flash Dash stores into one JSON
  // file the user can save externally, and can restore it later —
  // e.g. after a browser reinstall or when moving to a new device.
  // v2 fixes the "photos come back broken after import" bug: user data
  // lives in TWO places, not one — chrome.storage.local for JSON records
  // (photo positions/sizes, notes, tasks, etc.) AND IndexedDB for the
  // actual image Blobs (photo blobs keyed by photo id, plus the custom
  // background blob). The old exporter only serialized chrome.storage,
  // so on import the `photos` array came back with the right positions
  // but no image data to load. v2 now also snapshots every photo blob
  // (and the background blob) as base64, includes them under `blobs.*`
  // in the JSON, and restores them into IndexedDB on import.
  // Every chrome.storage key the app actually writes. Anything not
  // listed here won't be exported/restored, so keep this list in sync
  // with new features that persist state. `welcomed` is included so an
  // imported install doesn't re-show the first-run overlay.
  const BACKUP_KEYS = [
    // Board & content
    'notes', 'photos', 'tasks', 'customSites', 'countdownEvent',
    // Stashed items (Stuff drawer) + one-line-a-day journal
    'stashedItems', 'journalEntries',
    // Theme & appearance
    'theme', 'indigoEnabled', 'backgroundSettings',
    // Clock
    'clockColorHue', 'clockFont', 'clockFontCustom',
    'clockPosition', 'clockSize', 'dateVisible',
    // Widgets / misc
    'pomodoroState', 'settingsState', 'sidebarOpen', 'welcomed'
  ];

  const exportBtn = document.getElementById('settingsExportBtn');
  const importBtn = document.getElementById('settingsImportBtn');
  const importFile = document.getElementById('settingsImportFile');

  // Blob ↔ base64 helpers. Using a data-URL round-trip is the simplest
  // portable path that survives JSON serialization and preserves the
  // MIME type without an extra field.
  function _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  // dataUrlToBlob is defined near the top of this file (used by the old
  // base64 → IndexedDB migration path) — reuse it here.

  async function exportData() {
    try {
      const data = {};
      await Promise.all(BACKUP_KEYS.map(async (key) => {
        data[key] = await store.get(key, null);
      }));

      // Snapshot every photo blob so the images actually come back on
      // import. Photos with no blob in IndexedDB are silently skipped —
      // that includes the pre-migration base64 case, where the image
      // data is already embedded in the `photos` array's `src` field.
      //
      // Stashed photos (living in the Stuff drawer) also keep their blobs
      // in the same IDB `photos` store — they are not in the `photos`
      // array, so we walk `stashedItems` too and include their blobs, or
      // the images would come back missing after an import.
      const photoBlobs = {};
      const photos = Array.isArray(data.photos) ? data.photos : [];
      for (const p of photos) {
        if (!p || !p.id) continue;
        const blob = await mediaStore.getPhoto(p.id);
        if (blob) {
          try { photoBlobs[p.id] = await _blobToDataUrl(blob); }
          catch (e) { /* skip unreadable blob */ }
        }
      }
      const stashed = Array.isArray(data.stashedItems) ? data.stashedItems : [];
      for (const s of stashed) {
        if (!s || s.kind !== 'photo' || !s.id) continue;
        if (photoBlobs[s.id]) continue; // already snapshotted (shouldn't overlap, but be safe)
        const blob = await mediaStore.getPhoto(s.id);
        if (blob) {
          try { photoBlobs[s.id] = await _blobToDataUrl(blob); }
          catch (e) { /* skip */ }
        }
      }

      // Custom background blob (single-slot).
      let bgBlob = null;
      const bgBlobRaw = await mediaStore.getBg();
      if (bgBlobRaw) {
        try { bgBlob = await _blobToDataUrl(bgBlobRaw); }
        catch (e) { bgBlob = null; }
      }

      const payload = {
        app: 'flash-dash',
        version: 2,
        exportedAt: new Date().toISOString(),
        data,
        blobs: {
          photos: photoBlobs,      // { photoId: dataUrl }
          background: bgBlob       // dataUrl | null
        }
      };

      // Not pretty-printed — base64 image data is huge, and indentation
      // multiplies the file size for no user-visible benefit.
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dateStamp = new Date().toISOString().slice(0, 10);

      const a = document.createElement('a');
      a.href = url;
      a.download = `flash-dash-backup-${dateStamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const nBlobs = Object.keys(photoBlobs).length + (bgBlob ? 1 : 0);
      showAppToast(
        'Backup Exported',
        nBlobs
          ? `Saved your data and ${nBlobs} image${nBlobs === 1 ? '' : 's'}.`
          : 'Your data has been saved to a file.'
      );
    } catch (err) {
      showAppToast('Export Failed', 'Something went wrong creating the backup.');
    }
  }

  async function importData(file) {
    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (err) {
      showAppToast('Import Failed', 'That file is not valid JSON.');
      return;
    }

    const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
    if (!data) {
      showAppToast('Import Failed', 'This file doesn\'t look like a Flash Dash backup.');
      return;
    }
    const blobs = parsed.blobs && typeof parsed.blobs === 'object' ? parsed.blobs : null;
    const photoBlobs = blobs && blobs.photos && typeof blobs.photos === 'object' ? blobs.photos : {};
    const bgDataUrl = blobs && typeof blobs.background === 'string' ? blobs.background : null;

    const confirmed = window.confirm(
      'Importing will overwrite your current notes, photos, tasks, sites, countdowns, background, and widget positions with the contents of this file. This cannot be undone. Continue?'
    );
    if (!confirmed) return;

    try {
      // 1) Clear existing photo blobs so orphaned images from the old
      //    session don't linger in IndexedDB after the import overwrites
      //    the `photos` array with a smaller / different set.
      await mediaStore.clearPhotos();
      await mediaStore.clearBg();

      // 2) Restore the JSON side of the app state.
      await Promise.all(BACKUP_KEYS.map(async (key) => {
        if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null) {
          await store.set(key, data[key]);
        }
      }));

      // 3) Restore photo blobs into IndexedDB, keyed by photo id.
      //    Old v1 backups won't have a `blobs` section — fall back to any
      //    embedded `src` data-URL on the photo record itself (that's
      //    the pre-migration format the app used to store photos in).
      //    Also restore blobs for stashed photos (Stuff drawer) so they
      //    still render as thumbnails after the import.
      const importedPhotos = Array.isArray(data.photos) ? data.photos : [];
      let restoredBlobs = 0;
      for (const p of importedPhotos) {
        if (!p || !p.id) continue;
        let dataUrl = photoBlobs[p.id] || null;
        if (!dataUrl && typeof p.src === 'string' && p.src.startsWith('data:')) {
          dataUrl = p.src;
        }
        if (!dataUrl) continue;
        const blob = dataUrlToBlob(dataUrl);
        if (blob) {
          await mediaStore.setPhoto(p.id, blob);
          restoredBlobs++;
        }
      }
      const importedStashed = Array.isArray(data.stashedItems) ? data.stashedItems : [];
      for (const s of importedStashed) {
        if (!s || s.kind !== 'photo' || !s.id) continue;
        const dataUrl = photoBlobs[s.id];
        if (!dataUrl) continue;
        const blob = dataUrlToBlob(dataUrl);
        if (blob) {
          await mediaStore.setPhoto(s.id, blob);
          restoredBlobs++;
        }
      }

      // 4) Restore the custom background blob if the file has one.
      if (bgDataUrl) {
        const blob = dataUrlToBlob(bgDataUrl);
        if (blob) await mediaStore.setBg(blob);
      }

      showAppToast(
        'Backup Imported',
        restoredBlobs
          ? `Restored your data and ${restoredBlobs} image${restoredBlobs === 1 ? '' : 's'}. Reloading…`
          : 'Reloading to apply your restored data…'
      );
      setTimeout(() => window.location.reload(), 1400);
    } catch (err) {
      showAppToast('Import Failed', 'Something went wrong restoring the backup.');
    }
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportData);
  }

  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = ''; // allow re-selecting the same file later
      if (file) importData(file);
    });
  }

  // "/" opens the settings menu — but only when the user isn't actively
  // typing somewhere (input/textarea/contenteditable), since "/" is a
  // normal character in task text, notes, the search bar, site fields, etc.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const overlay = document.getElementById('welcomeOverlay');
    if (overlay && overlay.classList.contains('visible')) return;

    const active = document.activeElement;
    const tag = active ? active.tagName : '';
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' ||
      (active && active.isContentEditable);
    if (isEditable) return;

    // If some other modal/drawer is already open, let "/" type normally
    // there instead of stacking the settings menu on top of it.
    if (backdrop.classList.contains('open')) {
      e.preventDefault();
      closeSettings();
      return;
    }

    e.preventDefault();
    openSettings();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) closeSettings();
  });

  (async function init() {
    const saved = await store.get('settingsState', null);
    settings = saved ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
    applyTasksVisibility();
    applySearchVisibility();
  })();
})();


// ---------- Google Search Bar (enhanced) ----------
(function () {
  const searchBarInput   = document.getElementById('searchBarInput');
  const searchBarWrapper = document.getElementById('searchBarWrapper');
  const suggestionsBox   = document.getElementById('searchSuggestions');
  if (!searchBarInput) return;

  const HISTORY_KEY  = 'searchHistory';
  const MAX_HISTORY  = 5;
  const URL_PATTERN  = /^(https?:\/\/|ftp:\/\/|\S+\.\S{2,}(\/\S*)?$)/i;

  let focusedIdx   = -1;   // keyboard nav index in suggestions
  let currentItems = [];   // flat list of rendered suggestion elements
  let debounceTimer = null;

  // ── helpers ──────────────────────────────────────────────────
  async function getHistory() {
    return store.get(HISTORY_KEY, []);
  }

  async function addToHistory(query) {
    let hist = await getHistory();
    hist = hist.filter(h => h !== query);
    hist.unshift(query);
    if (hist.length > MAX_HISTORY) hist = hist.slice(0, MAX_HISTORY);
    store.set(HISTORY_KEY, hist);
  }

  async function deleteHistoryEntry(query) {
    let hist = await getHistory();
    hist = hist.filter(h => h !== query);
    store.set(HISTORY_KEY, hist);
    // Re-render suggestions with the current input value
    await renderSuggestions(searchBarInput.value.trim());
  }

  function isUrl(text) {
    return URL_PATTERN.test(text.trim());
  }

  function normaliseUrl(text) {
    const t = text.trim();
    if (/^https?:\/\//i.test(t)) return t;
    return 'https://' + t;
  }

  function navigate(target) {
    if (window.chrome && chrome.tabs) {
      chrome.tabs.getCurrent(tab => chrome.tabs.update(tab.id, { url: target }));
    } else {
      window.location.href = target;
    }
  }

  function googleSearch(query) {
    navigate(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
  }

  // ── spotlight (active) state ──────────────────────────────────
  function setActive(on) {
    searchBarWrapper.classList.toggle('active', on);
  }

  // ── Google autocomplete (fetch-based, CSP-compliant for MV3) ──
  // Optimisations vs. the original:
  //   1. Small LRU-style Map cache so repeating a query doesn't refetch.
  //   2. AbortController on the previous request, so fast typers don't end
  //      up with stale responses racing each other to render.
  const _suggestCache = new Map();
  const _SUGGEST_CACHE_MAX = 30;
  let _suggestAbort = null;
  function fetchGoogleSuggestions(query) {
    if (_suggestCache.has(query)) {
      // Refresh recency by re-inserting.
      const v = _suggestCache.get(query);
      _suggestCache.delete(query);
      _suggestCache.set(query, v);
      return Promise.resolve(v);
    }
    // Use client=firefox to get a plain JSON array response (no JSONP needed).
    // This avoids dynamic <script> injection which is blocked by MV3 CSP.
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;

    if (_suggestAbort) { try { _suggestAbort.abort(); } catch (e) {} }
    _suggestAbort = new AbortController();
    const signal = _suggestAbort.signal;

    return fetch(url, { signal })
      .then(r => r.json())
      .then(data => {
        const out = Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 6) : [];
        _suggestCache.set(query, out);
        if (_suggestCache.size > _SUGGEST_CACHE_MAX) {
          // Drop the oldest entry (Map iteration order is insertion order).
          const firstKey = _suggestCache.keys().next().value;
          _suggestCache.delete(firstKey);
        }
        return out;
      })
      .catch(() => []);
  }

  // ── render suggestions ────────────────────────────────────────
  function svgIcon(path, size = 14) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8">${path}</svg>`;
  }

  const ICON_HISTORY  = svgIcon('<path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/>');
  const ICON_SEARCH   = svgIcon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>');
  const ICON_NAVIGATE = svgIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>');

  function highlightMatch(text, query) {
    if (!query) return document.createTextNode(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return document.createTextNode(text);
    const span = document.createElement('span');
    span.className = 'suggestion-text';
    span.innerHTML =
      escapeHtml(text.slice(0, idx)) +
      `<mark>${escapeHtml(text.slice(idx, idx + query.length))}</mark>` +
      escapeHtml(text.slice(idx + query.length));
    return span;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function buildItem({ icon, label, query, badge, onActivate }) {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.setAttribute('role', 'option');
    div.tabIndex = -1;

    const iconEl = document.createElement('span');
    iconEl.className = 'suggestion-icon';
    iconEl.innerHTML = icon;

    const textEl = document.createElement('span');
    textEl.className = 'suggestion-text';

    const hl = highlightMatch(label, query);
    if (hl instanceof Node) {
      if (hl.nodeType === Node.TEXT_NODE) {
        textEl.textContent = label;
      } else {
        textEl.innerHTML = hl.innerHTML;
      }
    }

    div.appendChild(iconEl);
    div.appendChild(textEl);

    if (badge) {
      const b = document.createElement('span');
      b.className = 'suggestion-type-badge';
      b.textContent = badge;
      div.appendChild(b);
    }

    div.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur before click
      onActivate();
    });

    return div;
  }

  // History item = regular item + a × delete button
  function buildHistoryItem({ label, query, onActivate }) {
    const div = buildItem({ icon: ICON_HISTORY, label, query, onActivate });

    const del = document.createElement('button');
    del.className = 'suggestion-delete-btn';
    del.setAttribute('aria-label', 'Remove from history');
    del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    del.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't trigger the item's onActivate
      deleteHistoryEntry(label);
    });

    div.appendChild(del);
    return div;
  }

  function sectionLabel(text) {
    const el = document.createElement('div');
    el.className = 'suggestion-section-label';
    el.textContent = text;
    return el;
  }

  async function renderSuggestions(query) {
    suggestionsBox.innerHTML = '';
    focusedIdx = -1;
    currentItems = [];

    if (!query) {
      // Show recent history
      const hist = await getHistory();
      if (hist.length === 0) { hideSuggestions(); return; }
      suggestionsBox.appendChild(sectionLabel('Recent'));
      hist.forEach(h => {
        const item = buildHistoryItem({
          label: h,
          query: '',
          onActivate: () => commitQuery(h)
        });
        suggestionsBox.appendChild(item);
        currentItems.push(item);
      });
      showSuggestions();
      return;
    }

    // Detect URL
    const looksLikeUrl = isUrl(query);

    // Always offer the direct action first
    if (looksLikeUrl) {
      const item = buildItem({
        icon: ICON_NAVIGATE,
        label: query,
        query,
        badge: 'Go to site',
        onActivate: () => { addToHistory(query); navigate(normaliseUrl(query)); }
      });
      suggestionsBox.appendChild(item);
      currentItems.push(item);
    } else {
      const item = buildItem({
        icon: ICON_SEARCH,
        label: `Search: ${query}`,
        query,
        badge: 'Google',
        onActivate: () => commitQuery(query)
      });
      suggestionsBox.appendChild(item);
      currentItems.push(item);
    }

    showSuggestions();

    // History matches
    const hist = await getHistory();
    const histMatches = hist.filter(h => h.toLowerCase().includes(query.toLowerCase()) && h !== query);
    if (histMatches.length) {
      suggestionsBox.appendChild(sectionLabel('Recent'));
      histMatches.slice(0, 3).forEach(h => {
        const item = buildHistoryItem({
          label: h,
          query,
          onActivate: () => commitQuery(h)
        });
        suggestionsBox.appendChild(item);
        currentItems.push(item);
      });
    }

    // Google suggestions (async — append when ready)
    if (!looksLikeUrl) {
      // Capture a snapshot of currentItems so we only append if the
      // suggestions box hasn't been reset by a newer renderSuggestions call.
      const itemsAtDispatch = currentItems;
      fetchGoogleSuggestions(query).then(suggestions => {
        // Only show if the input hasn't changed AND this render is still active
        if (searchBarInput.value.trim() !== query) return;
        if (currentItems !== itemsAtDispatch) return;
        const newSuggestions = suggestions.filter(s => s !== query);
        if (!newSuggestions.length) return;

        const label = sectionLabel('Suggestions');
        suggestionsBox.appendChild(label);

        newSuggestions.forEach(s => {
          const item = buildItem({
            icon: ICON_SEARCH,
            label: s,
            query,
            onActivate: () => commitQuery(s)
          });
          suggestionsBox.appendChild(item);
          currentItems.push(item);
        });
      });
    }
  }

  function showSuggestions() {
    suggestionsBox.classList.add('visible');
  }

  function hideSuggestions() {
    suggestionsBox.classList.remove('visible');
    suggestionsBox.innerHTML = '';
    focusedIdx = -1;
    currentItems = [];
  }

  function commitQuery(text) {
    const t = text.trim();
    if (!t) return;
    if (isUrl(t)) {
      addToHistory(t);
      navigate(normaliseUrl(t));
    } else {
      addToHistory(t);
      googleSearch(t);
    }
  }

  // ── keyboard navigation ───────────────────────────────────────
  function moveFocus(delta) {
    const items = suggestionsBox.querySelectorAll('.suggestion-item');
    if (!items.length) return;
    items.forEach(el => el.classList.remove('focused'));
    // When starting from -1 and going up, jump straight to the last item
    if (focusedIdx === -1 && delta === -1) {
      focusedIdx = items.length - 1;
    } else {
      focusedIdx = (focusedIdx + delta + items.length) % items.length;
    }
    items[focusedIdx].classList.add('focused');
    // Fill input with the hovered suggestion text
    const labelEl = items[focusedIdx].querySelector('.suggestion-text');
    if (labelEl) {
      const raw = labelEl.textContent.replace(/^Search:\s/, '');
      searchBarInput.value = raw;
    }
  }

  searchBarInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveFocus(-1); return; }

    if (e.key === 'Enter') {
      e.preventDefault();
      const focused = suggestionsBox.querySelector('.suggestion-item.focused');
      if (focused) {
        focused.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      } else {
        const q = searchBarInput.value.trim();
        if (q) commitQuery(q);
      }
      return;
    }

    if (e.key === 'Escape') {
      hideSuggestions();
      searchBarInput.blur();
    }
  });

  // ── input handler (debounced) ─────────────────────────────────
  searchBarInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderSuggestions(searchBarInput.value.trim());
    }, 160);
  });

  // ── focus / blur ──────────────────────────────────────────────
  searchBarInput.addEventListener('focus', async () => {
    setActive(true);
    await renderSuggestions(searchBarInput.value.trim());
  });

  searchBarInput.addEventListener('blur', () => {
    // Delay so mousedown on a suggestion fires first
    setTimeout(() => {
      setActive(false);
      hideSuggestions();
    }, 180);
  });

  // ── Ctrl+G shortcut ───────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'g') {
      const active = document.activeElement;
      const tag = active ? active.tagName : '';
      if (tag === 'INPUT' && active !== searchBarInput) return;
      if (tag === 'TEXTAREA') return;
      e.preventDefault();
      searchBarInput.focus();
      searchBarInput.select();
    }
  });
})();


// ══════════════════════════════════════════════════════════════
// Welcome Overlay — show only on first install
// ══════════════════════════════════════════════════════════════
(async function initWelcome() {
  const overlay  = document.getElementById('welcomeOverlay');
  const dismissBtn = document.getElementById('welcomeDismiss');
  if (!overlay || !dismissBtn) return;

  // Check if the user has already been welcomed
  const welcomed = await store.get('welcomed', false);
  if (welcomed) return; // not first install — do nothing

  // First install: reveal the overlay
  // Use rAF to ensure the CSS transition fires properly after display
  requestAnimationFrame(() => {
    overlay.classList.add('visible');
  });

  // "Get Started" — animate out, then hide & persist the flag
  dismissBtn.addEventListener('click', async () => {
    // Immediately cut pointer-events so double-clicks can't fire
    overlay.style.pointerEvents = 'none';
    overlay.classList.add('dismissing');
    await store.set('welcomed', true);
    // Wait for the CSS transition to finish before fully hiding
    overlay.addEventListener('transitionend', () => {
      overlay.style.display = 'none';
    }, { once: true });
    // Fallback: hide after 450 ms even if transitionend never fires
    setTimeout(() => { overlay.style.display = 'none'; }, 450);
  });
})();


// ══════════════════════════════════════════════════════════════
// Floating Dashboard Widgets (Countdown, Pomodoro)
// ──────────────────────────────────────────────────────────────
// Reuses the board's drag/z-index conventions (makeDraggable,
// bringToFront, the shared _boardZCounter) but for widgets that live
// outside the board canvas as independent position:fixed elements,
// so they never get mixed in with photos/notes or clipped by the board.
// ══════════════════════════════════════════════════════════════

// Default placement mirrors where these cards used to sit in the
// right-panel stack, so existing users see them roughly where they expect.
const FLOATING_WIDGET_DEFAULTS = {
  countdownWidget: { visible: true, x: null, y: 22, z: 6 }, // x resolved at init (right-aligned)
  pomodoroWidget:  { visible: true, x: null, y: 200, z: 6 }
};

// Sets up drag + persisted position/visibility + bring-to-front for a
// single floating widget. Returns helpers the caller can use to react
// to visibility toggles from the toolbar.
function initFloatingWidget(key, el, toggleBtn, closeBtn, defaultWidthForX) {
  let widget = null;

  async function persist() {
    await store.set(key, widget);
  }

  function applyPosition() {
    el.style.left = widget.x + 'px';
    el.style.top = widget.y + 'px';
  }

  function applyVisibility(animate) {
    if (widget.visible) {
      el.style.display = '';
      // Force a reflow so the fade-in transition actually fires when
      // toggled back on from display:none.
      if (animate) {
        el.classList.remove('widget-visible');
        requestAnimationFrame(() => el.classList.add('widget-visible'));
      } else {
        el.classList.add('widget-visible');
      }
      toggleBtn.classList.add('active');
    } else {
      el.classList.remove('widget-visible');
      toggleBtn.classList.remove('active');
      if (animate) {
        setTimeout(() => { if (!widget.visible) el.style.display = 'none'; }, 220);
      } else {
        el.style.display = 'none';
      }
    }
  }

  function bringWidgetToFront() {
    if (!widget) return;
    _boardZCounter += 1;
    widget.z = _boardZCounter;
    el.style.zIndex = _boardZCounter;
    persist();
  }

  makeDraggable(el, widget_proxy(), () => persist());

  // makeDraggable expects an {x, y} item it can mutate live during drag;
  // we proxy reads/writes straight through to `widget` itself once it's
  // loaded, so dragging keeps working after init() replaces the object.
  function widget_proxy() {
    return {
      get x() { return widget ? widget.x : 0; },
      set x(v) { if (widget) widget.x = v; },
      get y() { return widget ? widget.y : 0; },
      set y(v) { if (widget) widget.y = v; }
    };
  }

  el.addEventListener('pointerdown', () => bringWidgetToFront());

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!widget) return;
    widget.visible = false;
    applyVisibility(true);
    persist();
  });

  toggleBtn.addEventListener('click', () => {
    if (!widget) return;
    widget.visible = !widget.visible;
    if (widget.visible) bringWidgetToFront();
    applyVisibility(true);
    persist();
  });

  (async function init() {
    const saved = await store.get(key, null);
    const defaults = FLOATING_WIDGET_DEFAULTS[key];
    widget = saved ? { ...defaults, ...saved } : { ...defaults };

    // Resolve a right-aligned default x the first time this widget is
    // ever shown, now that we know the viewport and card width.
    if (widget.x === null || widget.x === undefined) {
      widget.x = Math.max(20, window.innerWidth - defaultWidthForX - 22);
    }

    if (widget.z > _boardZCounter) _boardZCounter = widget.z;
    el.style.zIndex = widget.z;
    applyPosition();
    applyVisibility(false);
  })();
}


// ══════════════════════════════════════════════════════════════
// Exam Countdown Card
// ══════════════════════════════════════════════════════════════
(function initCountdown() {
  const card = document.getElementById('countdownCard');
  const daysEl = document.getElementById('countdownDays');
  const nameEl = document.getElementById('countdownName');
  const dateEl = document.getElementById('countdownDate');
  const editBtn = document.getElementById('countdownEditBtn');

  const backdrop = document.getElementById('countdownDialogBackdrop');
  const nameInput = document.getElementById('countdownNameInput');
  const dateInput = document.getElementById('countdownDateInput');
  const saveBtn = document.getElementById('countdownDialogSave');
  const closeBtn = document.getElementById('countdownDialogClose');

  if (!card) return;

  // Midnight-to-midnight day diff, immune to DST/hour drift.
  function daysBetween(fromDate, toDate) {
    const a = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const b = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.round((b - a) / 86400000);
  }

  function formatEventDate(d) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  async function render() {
    const event = await store.get('countdownEvent', null);
    card.classList.remove('is-today', 'is-past');

    if (!event || !event.date || !event.name) {
      daysEl.textContent = '—';
      nameEl.textContent = 'Set up your countdown';
      dateEl.textContent = '';
      return;
    }

    // event.date is an HTML <input type="date"> value: "YYYY-MM-DD".
    // Parse as local time (not UTC) so the displayed day matches what was picked.
    const [y, m, d] = event.date.split('-').map(Number);
    const eventDate = new Date(y, m - 1, d);
    const today = new Date();
    const diff = daysBetween(today, eventDate);

    nameEl.textContent = event.name;

    if (diff > 0) {
      daysEl.textContent = `${diff} Day${diff === 1 ? '' : 's'} Left`;
      dateEl.textContent = formatEventDate(eventDate);
    } else if (diff === 0) {
      card.classList.add('is-today');
      daysEl.textContent = 'Today!';
      dateEl.textContent = formatEventDate(eventDate);
    } else {
      card.classList.add('is-past');
      daysEl.textContent = 'Event Completed';
      dateEl.textContent = formatEventDate(eventDate);
    }
  }

  function openDialog() {
    store.get('countdownEvent', null).then(event => {
      nameInput.value = event && event.name ? event.name : '';
      dateInput.value = event && event.date ? event.date : '';
      backdrop.classList.add('open');
      setTimeout(() => nameInput.focus(), 50);
    });
  }

  function closeDialog() {
    backdrop.classList.remove('open');
  }

  editBtn.addEventListener('click', openDialog);
  closeBtn.addEventListener('click', closeDialog);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeDialog();
  });

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const date = dateInput.value;
    if (!name || !date) return; // require both fields
    await store.set('countdownEvent', { name, date });
    closeDialog();
    render();
  });

  render();

  // Recompute periodically so "days left" rolls over at midnight without
  // needing a reload. 5 minutes is plenty — visibilitychange + focus below
  // also fire on tab re-entry, so any midnight rollover is caught the
  // moment the user looks at the tab. Cuts background timer work 5×.
  setInterval(render, 5 * 60 * 1000);

  // Also recompute the instant the tab regains visibility/focus, which
  // catches day-rollovers that happened while the tab sat in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render();
  });
  window.addEventListener('focus', render);

  // Make this card a draggable, hideable floating widget.
  const closeWidgetBtn = document.getElementById('countdownCloseBtn');
  const toggleWidgetBtn = document.getElementById('countdownToggleBtn');
  initFloatingWidget('countdownWidget', card, toggleWidgetBtn, closeWidgetBtn, 240);
})();


// ══════════════════════════════════════════════════════════════
// Pomodoro / Focus Timer Card
// ══════════════════════════════════════════════════════════════
(function initPomodoro() {
  const card = document.querySelector('.pomodoro-card');
  const modeLabel = document.getElementById('pomodoroModeLabel');
  const timeEl = document.getElementById('pomodoroTime');
  const ringProgress = document.getElementById('pomodoroRingProgress');
  const startPauseBtn = document.getElementById('pomodoroStartPause');
  const resetBtn = document.getElementById('pomodoroReset');
  const settingsBtn = document.getElementById('pomodoroSettingsBtn');

  const backdrop = document.getElementById('pomodoroDialogBackdrop');
  const focusInput = document.getElementById('pomodoroFocusInput');
  const breakInput = document.getElementById('pomodoroBreakInput');
  const saveBtn = document.getElementById('pomodoroDialogSave');
  const closeBtn = document.getElementById('pomodoroDialogClose');

  // Fullscreen overlay refs — optional (fail gracefully if template is
  // missing them; keeps this init function backwards-compatible).
  const fsOverlay        = document.getElementById('pomodoroFullscreen');
  const fsMode           = document.getElementById('pomodoroFsMode');
  const fsTime           = document.getElementById('pomodoroFsTime');
  const fsRingProgress   = document.getElementById('pomodoroFsRingProgress');
  const fsStartPauseBtn  = document.getElementById('pomodoroFsStartPause');
  const fsResetBtn       = document.getElementById('pomodoroFsReset');
  const fsPresetsWrap    = document.getElementById('pomodoroFsPresets');
  const expandBtn        = document.getElementById('pomodoroExpandBtn');
  const collapseBtn      = document.getElementById('pomodoroCollapseBtn');

  if (!card) return;

  const RING_CIRCUMFERENCE = 326.7256; // 2 * PI * 52, matches the SVG r=52 circle
  const DEFAULT_STATE = {
    mode: 'focus',
    focusMinutes: 25,
    breakMinutes: 5,
    running: false,
    startedAt: null,
    duration: 25 * 60
  };

  let state = null;
  let tickHandle = null;

  // Tiny two-tone chime built with the Web Audio API — no audio file needed,
  // and it still works the first time without waiting on a network asset.
  function playChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      [880, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.18);
        osc.stop(now + i * 0.18 + 0.4);
      });
      setTimeout(() => ctx.close(), 1200);
    } catch (e) { /* Web Audio unavailable — fail silently */ }
  }

  function notify(title, body) {
    if (window.Notification && Notification.permission === 'granted') {
      try { new Notification(title, { body, silent: true }); } catch (e) { }
    }
    playChime();
  }

  // In-page toast for session-complete events — independent of the
  // OS Notification permission, so it always shows something even if
  // notifications were never granted.
  let _toastTimer = null;
  function showToast(title, body) {
    let toast = document.getElementById('pomodoroToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pomodoroToast';
      toast.className = 'pomodoro-toast';
      toast.innerHTML = '<div class="pomodoro-toast-title"></div><div class="pomodoro-toast-body"></div>';
      document.body.appendChild(toast);
    }
    toast.querySelector('.pomodoro-toast-title').textContent = title;
    toast.querySelector('.pomodoro-toast-body').textContent = body;

    toast.classList.remove('visible');
    // Re-trigger the animation even if a toast is already showing.
    requestAnimationFrame(() => toast.classList.add('visible'));

    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
  }

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const r = (s % 60).toString().padStart(2, '0');
    return `${m}:${r}`;
  }

  async function persist() {
    await store.set('pomodoroState', state);
  }

  // Derives "how many seconds are left in the current session right now"
  // purely from startedAt + duration — never from counting setInterval ticks.
  // This is what makes the timer survive tab close/reopen and stay accurate.
  function remainingSeconds() {
    if (!state.running || !state.startedAt) return state.duration;
    const elapsed = (Date.now() - state.startedAt) / 1000;
    return state.duration - elapsed;
  }

  function applyModeVisuals() {
    card.classList.toggle('is-break', state.mode === 'break');
    const label = state.mode === 'focus' ? 'Focus Session' : 'Break Time';
    modeLabel.textContent = label;
    if (fsMode) fsMode.textContent = label;
    if (fsOverlay) fsOverlay.classList.toggle('is-break', state.mode === 'break');
    syncPresetHighlight();
  }

  // Highlight the preset button that matches the current focus duration
  // (or clear all highlights if the value doesn't match any preset).
  function syncPresetHighlight() {
    if (!fsPresetsWrap) return;
    const current = state ? state.focusMinutes : null;
    fsPresetsWrap.querySelectorAll('.pomodoro-fs-preset').forEach(btn => {
      const min = parseInt(btn.dataset.min, 10);
      btn.classList.toggle('active', min === current);
    });
  }

  // Switches focus<->break, starts the new session immediately if the
  // previous one was running, persists, and chimes.
  //
  // Special case: if a focus session just finished and breakMinutes is 0,
  // a break duration of 0 is a deliberate user setting meaning "no break" —
  // not a missing value to fall back from. In that case we stay in focus
  // mode, reset to idle, and skip starting anything automatically.
  async function advanceSession(autoStart) {
    const finishedMode = state.mode;

    if (finishedMode === 'focus' && state.breakMinutes === 0) {
      state.mode = 'focus';
      state.duration = state.focusMinutes * 60;
      state.running = false;
      state.startedAt = null;
      stopTicking();
      await persist();
      applyModeVisuals();
      renderTick();
      notify('Focus Session Complete', 'Timer Reset');
      showToast('Focus Session Complete', 'Timer Reset');
      return;
    }

    state.mode = state.mode === 'focus' ? 'break' : 'focus';
    state.duration = (state.mode === 'focus' ? state.focusMinutes : state.breakMinutes) * 60;
    state.running = !!autoStart;
    state.startedAt = autoStart ? Date.now() : null;
    await persist();
    applyModeVisuals();
    if (autoStart) {
      // Make sure a display-refresh interval is actually running for the
      // new session — needed both when this fires from inside renderTick's
      // own interval (already ticking) and from init's catch-up path
      // (no interval exists yet in this tab).
      startTicking();
    } else {
      stopTicking();
    }
    renderTick();
    const title = finishedMode === 'focus' ? 'Focus session complete' : 'Break complete';
    const body = state.mode === 'focus' ? 'Time to focus.' : 'Time for a short break.';
    notify(title, body);
    showToast(title, body);
  }

  // Cache last-rendered values so a tick that doesn't change the
  // displayed time/ring/button skips DOM writes entirely.
  let _lastTimeStr = '';
  let _lastDashoffset = '';
  let _lastBtnLabel = '';

  function renderTick() {
    let remaining = remainingSeconds();

    // Session boundary crossed while we weren't actively watching (e.g. the
    // tab was backgrounded) — settle it before painting anything.
    if (state.running && remaining <= 0) {
      advanceSession(true);
      return;
    }

    const timeStr = formatTime(remaining);
    if (timeStr !== _lastTimeStr) {
      timeEl.textContent = timeStr;
      if (fsTime) fsTime.textContent = timeStr;
      _lastTimeStr = timeStr;
    }
    const fraction = Math.min(1, Math.max(0, 1 - remaining / state.duration));
    const dash = (RING_CIRCUMFERENCE * fraction).toFixed(2);
    if (dash !== _lastDashoffset) {
      ringProgress.style.strokeDashoffset = dash;
      if (fsRingProgress) fsRingProgress.style.strokeDashoffset = dash;
      _lastDashoffset = dash;
    }
    const btnLabel = state.running ? 'Pause' : 'Start';
    if (btnLabel !== _lastBtnLabel) {
      startPauseBtn.textContent = btnLabel;
      if (fsStartPauseBtn) fsStartPauseBtn.textContent = btnLabel;
      _lastBtnLabel = btnLabel;
    }
  }

  function startTicking() {
    stopTicking();
    // No display-refresh interval while the tab is backgrounded —
    // remainingSeconds() is wall-clock based so it'll catch up on resume.
    if (document.visibilityState === 'hidden') return;
    // setInterval here only drives the *display* refresh; the actual
    // remaining-time math always comes from remainingSeconds() above.
    tickHandle = setInterval(renderTick, 1000);
  }
  function stopTicking() {
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  }

  async function toggleStartPause() {
    if (state.running) {
      // Pause: bank the exact remaining time into `duration` so resuming
      // later (possibly after the browser was closed) is still accurate.
      state.duration = Math.max(0, remainingSeconds());
      state.running = false;
      state.startedAt = null;
      stopTicking();
    } else {
      state.running = true;
      state.startedAt = Date.now();
      startTicking();
    }
    await persist();
    renderTick();
  }

  async function resetTimer() {
    state.mode = 'focus';
    state.duration = state.focusMinutes * 60;
    state.running = false;
    state.startedAt = null;
    stopTicking();
    await persist();
    applyModeVisuals();
    renderTick();
  }

  startPauseBtn.addEventListener('click', () => { if (state) toggleStartPause(); });
  resetBtn.addEventListener('click', () => { if (state) resetTimer(); });

  // ---------- settings dialog ----------
  function openSettings() {
    focusInput.value = state.focusMinutes;
    breakInput.value = state.breakMinutes;
    backdrop.classList.add('open');
  }
  function closeSettings() {
    backdrop.classList.remove('open');
  }
  settingsBtn.addEventListener('click', () => { if (state) openSettings(); });
  closeBtn.addEventListener('click', closeSettings);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSettings();
  });

  saveBtn.addEventListener('click', async () => {
    const focusMin = Math.min(180, Math.max(1, parseInt(focusInput.value, 10) || 25));
    // Break duration of 0 is valid and means "no break" — only fall back to
    // the 5-minute default when the field was left empty/non-numeric, never
    // when the user explicitly entered 0.
    const breakRaw = breakInput.value.trim();
    const breakParsed = breakRaw === '' ? 5 : parseInt(breakRaw, 10);
    const breakMin = Math.min(60, Math.max(0, Number.isNaN(breakParsed) ? 5 : breakParsed));
    state.focusMinutes = focusMin;
    state.breakMinutes = breakMin;

    // If the timer isn't currently running, also refresh the displayed
    // duration for the current mode so the new setting is reflected right away.
    if (!state.running) {
      state.duration = (state.mode === 'focus' ? focusMin : breakMin) * 60;
    }
    stopTicking();
    if (state.running) startTicking();
    await persist();
    closeSettings();
    applyModeVisuals();
    renderTick();
  });

  // ---------- init: load persisted state and catch up on elapsed time ----------
  (async function init() {
    const saved = await store.get('pomodoroState', null);
    state = saved ? { ...DEFAULT_STATE, ...saved } : { ...DEFAULT_STATE };

    // If a session was running while this tab (or another) was closed,
    // catch up immediately — possibly rolling through a completed session.
    if (state.running && state.startedAt) {
      if (remainingSeconds() <= 0) {
        await advanceSession(true);
      } else {
        startTicking();
      }
    }

    applyModeVisuals();
    renderTick();
  })();

  // Catch up instantly when the tab regains focus, rather than waiting
  // for the next 1s tick — keeps multi-tab usage feeling immediate.
  // Also restart/stop the interval to avoid spending CPU on a hidden tab.
  document.addEventListener('visibilitychange', () => {
    if (!state) return;
    if (document.visibilityState === 'visible') {
      renderTick();
      if (state.running) startTicking();
    } else {
      stopTicking();
    }
  });

  // ──── Fullscreen expand / collapse ────
  // Toggle the overlay open/closed. When open:
  //   • Small floating card is hidden via body class
  //   • Spacebar pauses/plays
  //   • Escape collapses
  // The timer state itself is shared — renderTick() writes to both DOMs
  // in the same pass so the two views stay perfectly in sync.
  function openFullscreen() {
    if (!fsOverlay) return;
    fsOverlay.classList.add('open');
    fsOverlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('pomodoro-fs-open');
    // Paint the current state onto the fullscreen DOM immediately so it
    // doesn't briefly show default placeholders before the next tick.
    _lastTimeStr = ''; _lastDashoffset = ''; _lastBtnLabel = '';
    renderTick();
    syncPresetHighlight();
  }

  function closeFullscreen() {
    if (!fsOverlay) return;
    fsOverlay.classList.remove('open');
    fsOverlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('pomodoro-fs-open');
  }

  function isFullscreenOpen() {
    return fsOverlay && fsOverlay.classList.contains('open');
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      // Don't let the click bubble up to the widget's drag handler.
      e.stopPropagation();
      openFullscreen();
    });
    // The card is a draggable floating widget — stop pointerdown from
    // being interpreted as "start dragging the card" when the user
    // clicks the expand button.
    expandBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  if (collapseBtn) collapseBtn.addEventListener('click', closeFullscreen);

  // Fullscreen mirror controls — delegate to the same toggle/reset paths
  // so state, persistence, and chimes all flow through one code path.
  if (fsStartPauseBtn) fsStartPauseBtn.addEventListener('click', () => { if (state) toggleStartPause(); });
  if (fsResetBtn)      fsResetBtn.addEventListener('click',      () => { if (state) resetTimer();      });

  // Time presets: clicking a preset sets focusMinutes AND immediately
  // resets the timer to that new focus duration (idle state). Keeping
  // this scoped to focus (not break) matches the mental model of
  // "quick-pick a work session length".
  if (fsPresetsWrap) {
    fsPresetsWrap.addEventListener('click', async (e) => {
      const btn = e.target.closest('.pomodoro-fs-preset');
      if (!btn || !state) return;
      const min = parseInt(btn.dataset.min, 10);
      if (!Number.isFinite(min) || min < 1) return;
      state.focusMinutes = min;
      state.mode = 'focus';
      state.duration = min * 60;
      state.running = false;
      state.startedAt = null;
      stopTicking();
      await persist();
      applyModeVisuals();
      _lastTimeStr = ''; _lastDashoffset = ''; _lastBtnLabel = '';
      renderTick();
    });
  }

  // Keyboard shortcuts — active ONLY while the fullscreen overlay is
  // open, so we don't grab Space or Escape globally when the user is
  // just looking at the small card, typing in a note, editing tasks, etc.
  document.addEventListener('keydown', (e) => {
    if (!isFullscreenOpen() || !state) return;
    // Ignore shortcuts while the user is typing in an input/textarea/
    // contenteditable inside the overlay (there aren't any today, but
    // this stays safe if someone adds one later).
    const t = e.target;
    const inField = t && (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    );
    if (inField) return;

    if (e.code === 'Space') {
      e.preventDefault();
      toggleStartPause();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFullscreen();
    }
  });

  // Clicking the dimmed backdrop (but not the inner content) also closes.
  if (fsOverlay) {
    fsOverlay.addEventListener('click', (e) => {
      if (e.target === fsOverlay) closeFullscreen();
    });
  }

  // Make this card a draggable, hideable floating widget.
  const closeWidgetBtn = document.getElementById('pomodoroCloseBtn');
  const toggleWidgetBtn = document.getElementById('pomodoroToggleBtn');
  initFloatingWidget('pomodoroWidget', card, toggleWidgetBtn, closeWidgetBtn, 240);
})();


// ════════════════════════════════════════════════════════════
// Custom Background Feature
// ────────────────────────────────────────────────────────────
// Storage split:
//   • bgMediaStore (IndexedDB) — raw Blob/File for the active background.
//     Only one slot (\'current\'), replaced on every Apply.
//   • store (\'backgroundSettings\') — small JSON object with
//     { type, mimeType, position:{x,y}, blur:{enabled,amount},
//       brightness, sound }.
//     Consulted on page load to know whether a background is set at all
//     without pulling the full blob out of IDB first.
//
// The live background element lives in #bgLayer (z-index:-1), behind
// .bg-glow and the board.  When no background is set, #bgLayer is empty
// and the plain var(--bg) on <body> shows as normal.
// ════════════════════════════════════════════════════════════

// Tracks the current object URL for the live background, so we can revoke
// it before creating a new one (avoids memory leaks from orphaned blob URLs).
let _bgObjectUrl = null;

// Applies a background from an already-resolved object URL.
// settings: the backgroundSettings object from store.
// objectUrl: URL.createObjectURL() result for the blob.
function applyBackground(settings, objectUrl) {
  const layer = document.getElementById('bgLayer');
  if (!layer) return;

  // Clear previous media element
  layer.innerHTML = '';

  const pos = settings.position || { x: 50, y: 50 };
  const blurPx = (settings.blur && settings.blur.enabled)
    ? `blur(${settings.blur.amount || 0}px) ` : '';
  const brightness = settings.brightness != null ? settings.brightness : 100;
  const filterVal = `${blurPx}brightness(${brightness}%)`;
  const objPos    = `${pos.x}% ${pos.y}%`;

  let media;
  if (settings.type === 'video') {
    media = document.createElement('video');
    media.autoplay = true;
    media.loop     = true;
    media.playsInline = true;
    // Attempt sound if user requested it; browsers may block unmuted autoplay.
    // We always start muted and then try to unmute, falling back gracefully.
    media.muted = true;
    media.src   = objectUrl;
    if (settings.sound) {
      // Try unmuting after the video can play; if the browser blocks it,
      // it stays muted and we don't throw or show an error.
      media.addEventListener('canplay', () => {
        try {
          media.muted = false;
          media.play().catch(() => { media.muted = true; });
        } catch (e) { media.muted = true; }
      }, { once: true });
    }

  } else {
    media = document.createElement('img');
    media.alt = '';
    media.src = objectUrl;
  }

  media.style.objectPosition = objPos;
  media.style.filter = filterVal;
  layer.appendChild(media);
}

// Global listener to pause the background video when the tab is hidden,
// and resume it when visible. Reuses a single listener instead of stacking
// them per-apply.
document.addEventListener('visibilitychange', () => {
  const media = document.querySelector('#bgLayer video');
  if (media) {
    if (document.visibilityState === 'hidden') {
      media.pause();
    } else {
      media.play().catch(() => {}); // ignore DOMException if still blocked
    }
  }
});

// On page load: check if a background is configured and restore it.
(async function initBackgroundOnLoad() {
  const settings = await store.get('backgroundSettings', null);
  if (!settings) return; // no custom background — nothing to do

  const blob = await bgMediaStore.get();
  if (!blob) {
    // Settings key exists but blob was lost (e.g. IDB cleared) — clean up.
    await store.remove('backgroundSettings');
    return;
  }

  // Revoke any leftover URL from a previous load (shouldn\'t exist, but
  // guard anyway to avoid accumulating blob references.
  if (_bgObjectUrl) URL.revokeObjectURL(_bgObjectUrl);
  _bgObjectUrl = URL.createObjectURL(blob);
  applyBackground(settings, _bgObjectUrl);
})();


// ════════════════════════════════════════════════════════════
// initBackground — Background Settings + Editor dialogs
// ════════════════════════════════════════════════════════════
(function initBackground() {

  // ── Element references ──────────────────────────────────────────────
  const settingsOpenBgBtn    = document.getElementById('settingsOpenBgBtn');
  const settingsBackdrop     = document.getElementById('settingsBackdrop');

  // Background Settings dialog
  const bgSettingsBackdrop = document.getElementById('bgSettingsBackdrop');
  const bgSettingsClose    = document.getElementById('bgSettingsClose');
  const bgUploadPhotoBtn   = document.getElementById('bgUploadPhotoBtn');
  const bgUploadVideoBtn   = document.getElementById('bgUploadVideoBtn');
  const bgResetBtn         = document.getElementById('bgResetBtn');
  const bgPhotoInput       = document.getElementById('bgPhotoInput');
  const bgVideoInput       = document.getElementById('bgVideoInput');

  // Background Editor dialog
  const bgEditorBackdrop    = document.getElementById('bgEditorBackdrop');
  const bgEditorClose       = document.getElementById('bgEditorClose');
  const bgPreviewFrame      = document.getElementById('bgPreviewFrame');
  const bgBlurToggle        = document.getElementById('bgBlurToggle');
  const bgBlurSliderWrap    = document.getElementById('bgBlurSliderWrap');
  const bgBlurSlider        = document.getElementById('bgBlurSlider');
  const bgBlurLabel         = document.getElementById('bgBlurLabel');
  const bgSoundToggle       = document.getElementById('bgSoundToggle');
  const bgBrightnessSlider  = document.getElementById('bgBrightnessSlider');
  const bgBrightnessLabel   = document.getElementById('bgBrightnessLabel');
  const bgEditorCancel      = document.getElementById('bgEditorCancel');
  const bgEditorApply       = document.getElementById('bgEditorApply');

  if (!settingsOpenBgBtn || !bgSettingsBackdrop || !bgEditorBackdrop) return;

  // ── Editor state for the current editing session ────────────────────
  // Cleared/reset every time a new file is picked.
  let _editorState = null;
  /*
    _editorState = {
      file:         File,
      type:         'photo' | 'video',
      objectUrl:    string,        // URL.createObjectURL(file)
      mediaEl:      HTMLElement,   // the <img> or <video> inside #bgPreviewFrame
      panX:         number,        // 0–100 percent
      panY:         number,        // 0–100 percent
      blurEnabled:  boolean,
      blurAmount:   number,        // px
      brightness:   number,        // %
      sound:        boolean
    }
  */

  // ── Background Settings dialog helpers ──────────────────────────────
  function openBgSettings() {
    bgSettingsBackdrop.classList.add('open');
    updateResetBtnState();
  }
  function closeBgSettings() {
    bgSettingsBackdrop.classList.remove('open');
  }

  async function updateResetBtnState() {
    const settings = await store.get('backgroundSettings', null);
    bgResetBtn.disabled = !settings;
  }

  bgSettingsClose.addEventListener('click', closeBgSettings);
  bgSettingsBackdrop.addEventListener('click', e => {
    if (e.target === bgSettingsBackdrop) closeBgSettings();
  });

  // "Customize…" in the Settings menu: close Settings, open BgSettings
  settingsOpenBgBtn.addEventListener('click', () => {
    settingsBackdrop.classList.remove('open');
    openBgSettings();
  });

  // Upload buttons trigger the hidden file inputs
  bgUploadPhotoBtn.addEventListener('click', () => bgPhotoInput.click());
  bgUploadVideoBtn.addEventListener('click', () => bgVideoInput.click());

  bgPhotoInput.addEventListener('change', () => {
    const file = bgPhotoInput.files && bgPhotoInput.files[0];
    bgPhotoInput.value = ''; // allow re-picking same file
    if (file) openEditor(file, 'photo');
  });

  bgVideoInput.addEventListener('change', () => {
    const file = bgVideoInput.files && bgVideoInput.files[0];
    bgVideoInput.value = '';
    if (file) openEditor(file, 'video');
  });

  // ── Reset to Default ────────────────────────────────────────────────
  bgResetBtn.addEventListener('click', async () => {
    // Clear both storage locations
    await Promise.all([
      store.remove('backgroundSettings'),
      bgMediaStore.clear()
    ]);

    // Remove live background layer content
    const layer = document.getElementById('bgLayer');
    if (layer) layer.innerHTML = '';

    // Revoke the object URL that was in use
    if (_bgObjectUrl) {
      URL.revokeObjectURL(_bgObjectUrl);
      _bgObjectUrl = null;
    }

    // Update button state and show feedback toast
    bgResetBtn.disabled = true;
    closeBgSettings();
    showAppToast('Background Reset', 'Back to default.');
  });

  // ── Background Editor dialog ────────────────────────────────────────
  function openEditor(file, type) {
    // Close the background settings dialog while editor is open
    closeBgSettings();

    // Clean up any previous editor session
    if (_editorState && _editorState.objectUrl) {
      URL.revokeObjectURL(_editorState.objectUrl);
    }

    const objectUrl = URL.createObjectURL(file);

    _editorState = {
      file,
      type,
      objectUrl,
      mediaEl:     null,
      panX:        50,
      panY:        50,
      blurEnabled: false,
      blurAmount:  4,
      brightness:  100,
      sound:       false
    };

    // ── Build preview media element ──────────────────────────────
    bgPreviewFrame.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'bg-drag-hint';
    hint.textContent = 'Drag to reposition';

    let mediaEl;
    if (type === 'video') {
      mediaEl = document.createElement('video');
      mediaEl.autoplay = true;
      mediaEl.loop     = true;
      mediaEl.muted    = true; // always muted inside the editor preview
      mediaEl.playsInline = true;
      mediaEl.src = objectUrl;
    } else {
      mediaEl = document.createElement('img');
      mediaEl.alt = '';
      mediaEl.src = objectUrl;
    }
    _editorState.mediaEl = mediaEl;

    bgPreviewFrame.appendChild(mediaEl);
    bgPreviewFrame.appendChild(hint);

    // ── Set preview frame aspect ratio to the actual viewport ────
    const vwRatio = window.innerWidth / window.innerHeight;
    bgPreviewFrame.style.aspectRatio = `${window.innerWidth} / ${window.innerHeight}`;

    // ── Reset controls to default state ─────────────────────────
    bgBlurToggle.textContent = 'Blur: Off';
    bgBlurToggle.classList.remove('active');
    bgBlurToggle.setAttribute('aria-pressed', 'false');
    bgBlurSliderWrap.classList.remove('visible');
    bgBlurSlider.value = 4;
    bgBlurLabel.textContent = '4px';

    bgBrightnessSlider.value = 100;
    bgBrightnessLabel.textContent = '100%';

    bgSoundToggle.style.display = type === 'video' ? '' : 'none';
    bgSoundToggle.textContent = 'Sound: Off';
    bgSoundToggle.classList.remove('active');
    bgSoundToggle.setAttribute('aria-pressed', 'false');

    // Apply initial filter to preview
    updatePreviewFilter();
    updatePreviewPosition();

    // Open the editor dialog
    bgEditorBackdrop.classList.add('open');
  }

  function closeEditor() {
    bgEditorBackdrop.classList.remove('open');
    bgPreviewFrame.innerHTML = '';
    if (_editorState && _editorState.objectUrl) {
      URL.revokeObjectURL(_editorState.objectUrl);
    }
    _editorState = null;
  }

  function updatePreviewFilter() {
    if (!_editorState || !_editorState.mediaEl) return;
    const blurPart = _editorState.blurEnabled
      ? `blur(${_editorState.blurAmount}px) ` : '';
    _editorState.mediaEl.style.filter =
      `${blurPart}brightness(${_editorState.brightness}%)`;
  }

  function updatePreviewPosition() {
    if (!_editorState || !_editorState.mediaEl) return;
    _editorState.mediaEl.style.objectPosition =
      `${_editorState.panX}% ${_editorState.panY}%`;
  }

  // ── Pan gesture inside the preview frame ─────────────────────────────
  // Pointer events are used (works for mouse and touch).
  // Drag delta in pixels is converted to a change in the object-position
  // percentage (inverted: dragging right moves the \'crop window\' left,
  // i.e. the image appears to move right, which matches user expectation).
  let _panDrag = null;

  bgPreviewFrame.addEventListener('pointerdown', e => {
    if (!_editorState) return;
    e.preventDefault();
    bgPreviewFrame.setPointerCapture(e.pointerId);
    _panDrag = {
      startX:  e.clientX,
      startY:  e.clientY,
      origPanX: _editorState.panX,
      origPanY: _editorState.panY
    };
  });

  bgPreviewFrame.addEventListener('pointermove', e => {
    if (!_panDrag || !_editorState) return;
    const frameW = bgPreviewFrame.offsetWidth;
    const frameH = bgPreviewFrame.offsetHeight;

    // Convert pixel drag distance to percentage offset.
    // Dragging right by X pixels shifts panX by -(X / frameW * 100)%
    // so the media appears to scroll in the natural direction.
    const dxPct = ((_panDrag.startX - e.clientX) / frameW) * 100;
    const dyPct = ((_panDrag.startY - e.clientY) / frameH) * 100;

    _editorState.panX = Math.max(0, Math.min(100, _panDrag.origPanX + dxPct));
    _editorState.panY = Math.max(0, Math.min(100, _panDrag.origPanY + dyPct));
    updatePreviewPosition();
  });

  bgPreviewFrame.addEventListener('pointerup', () => { _panDrag = null; });
  bgPreviewFrame.addEventListener('pointercancel', () => { _panDrag = null; });

  // ── Blur toggle ───────────────────────────────────────────────────────
  bgBlurToggle.addEventListener('click', () => {
    if (!_editorState) return;
    _editorState.blurEnabled = !_editorState.blurEnabled;
    const on = _editorState.blurEnabled;
    bgBlurToggle.textContent = on ? 'Blur: On' : 'Blur: Off';
    bgBlurToggle.classList.toggle('active', on);
    bgBlurToggle.setAttribute('aria-pressed', String(on));
    bgBlurSliderWrap.classList.toggle('visible', on);
    updatePreviewFilter();
  });

  bgBlurSlider.addEventListener('input', () => {
    if (!_editorState) return;
    _editorState.blurAmount = parseFloat(bgBlurSlider.value);
    bgBlurLabel.textContent = `${_editorState.blurAmount}px`;
    updatePreviewFilter();
  });

  // ── Brightness slider ──────────────────────────────────────────────────
  bgBrightnessSlider.addEventListener('input', () => {
    if (!_editorState) return;
    _editorState.brightness = parseInt(bgBrightnessSlider.value, 10);
    bgBrightnessLabel.textContent = `${_editorState.brightness}%`;
    updatePreviewFilter();
  });

  // ── Sound toggle (video only) ─────────────────────────────────────────
  bgSoundToggle.addEventListener('click', () => {
    if (!_editorState) return;
    _editorState.sound = !_editorState.sound;
    const on = _editorState.sound;
    bgSoundToggle.textContent = on ? 'Sound: On' : 'Sound: Off';
    bgSoundToggle.classList.toggle('active', on);
    bgSoundToggle.setAttribute('aria-pressed', String(on));
  });

  // ── Cancel ────────────────────────────────────────────────────────────
  bgEditorClose.addEventListener('click', () => {
    closeEditor();
    openBgSettings(); // return to background settings dialog
  });
  bgEditorCancel.addEventListener('click', () => {
    closeEditor();
    openBgSettings();
  });
  bgEditorBackdrop.addEventListener('click', e => {
    if (e.target === bgEditorBackdrop) {
      closeEditor();
      openBgSettings();
    }
  });

  // ── Apply ────────────────────────────────────────────────────────────
  bgEditorApply.addEventListener('click', async () => {
    if (!_editorState) return;

    const { file, type, panX, panY, blurEnabled, blurAmount, brightness, sound } = _editorState;

    const settings = {
      type,
      mimeType:   file.type,
      position:   { x: Math.round(panX * 10) / 10, y: Math.round(panY * 10) / 10 },
      blur:       { enabled: blurEnabled, amount: blurAmount },
      brightness,
      sound:      type === 'video' ? sound : undefined
    };

    // Persist blob to IndexedDB (replaces any previous background)
    await bgMediaStore.set(file);
    // Persist settings object to chrome.storage.local
    await store.set('backgroundSettings', settings);

    // Build a fresh object URL for the live background layer.
    // (Don\'t revoke _editorState.objectUrl here — closeEditor does that.)
    if (_bgObjectUrl) URL.revokeObjectURL(_bgObjectUrl);
    _bgObjectUrl = URL.createObjectURL(file);
    applyBackground(settings, _bgObjectUrl);

    // Close dialogs
    closeEditor();
    // Don\'t re-open bgSettings — Apply means \'done\'

    // Update reset button state for next time the dialog opens
    await updateResetBtnState();
    showAppToast('Background Applied', 'Your new background is live.');
  });

  // ── Keyboard: Escape closes editor (falling through to settings) ──────
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (bgEditorBackdrop.classList.contains('open')) {
      e.stopImmediatePropagation();
      closeEditor();
      openBgSettings();
    } else if (bgSettingsBackdrop.classList.contains('open')) {
      closeBgSettings();
    }
  });

  // ── Init: sync reset button state on load ────────────────────────────
  updateResetBtnState();

})();


// ════════════════════════════════════════════════════════════
// initClockFont — "Modify Clock" typeface picker
// ────────────────────────────────────────────────────────────
// Persists a small settings object via `store` under 'clockFont':
//   { id: 'default' | 'adventuro' | 'caesar' | 'bubble' | 'garamond'
//         | 'minecraft' | 'redaction' | 'vintage' | 'custom' }
// A custom upload additionally stores its base64 data URL and the
// original filename in the same object — kept in chrome.storage.local
// (not IndexedDB) since a single .ttf/.otf comfortably fits within
// the unlimitedStorage-backed quota, and this mirrors how every other
// small piece of app state already goes through `store`.
//
// Picking a tile applies immediately — there's no separate "Apply"
// step here, unlike the Background editor, since there's no preview
// positioning/cropping involved, just a direct font swap.
// ════════════════════════════════════════════════════════════
(function initClockFont() {

  // ── Element references ──────────────────────────────────────────────
  const settingsOpenClockFontBtn = document.getElementById('settingsOpenClockFontBtn');
  const settingsBackdrop         = document.getElementById('settingsBackdrop');

  const clockFontBackdrop  = document.getElementById('clockFontBackdrop');
  const clockFontClose     = document.getElementById('clockFontClose');
  const clockFontGrid      = document.getElementById('clockFontGrid');
  const clockFontFileInput = document.getElementById('clockFontFileInput');
  const removeRow          = document.getElementById('clockFontRemoveRow');
  const removeBtn          = document.getElementById('clockFontRemoveBtn');

  const clockTabTypeface      = document.getElementById('clockTabTypeface');
  const clockTabOther         = document.getElementById('clockTabOther');
  const clockTabPanelTypeface = document.getElementById('clockTabPanelTypeface');
  const clockTabPanelOther    = document.getElementById('clockTabPanelOther');

  if (!settingsOpenClockFontBtn || !clockFontBackdrop || !clockFontGrid) return;

  // ── Tab switching (Typeface / Other Changes) ─────────────────────────
  function switchClockTab(tab) {
    const toOther = tab === 'other';
    clockTabTypeface.classList.toggle('active', !toOther);
    clockTabOther.classList.toggle('active', toOther);
    clockTabTypeface.setAttribute('aria-selected', String(!toOther));
    clockTabOther.setAttribute('aria-selected', String(toOther));
    clockTabPanelTypeface.classList.toggle('active', !toOther);
    clockTabPanelOther.classList.toggle('active', toOther);
  }
  if (clockTabTypeface && clockTabOther) {
    clockTabTypeface.addEventListener('click', () => switchClockTab('typeface'));
    clockTabOther.addEventListener('click', () => switchClockTab('other'));
  }

  // ── Font catalogue ───────────────────────────────────────────────────
  // family: the CSS font-family name to apply (matches the @font-face
  // declarations in style.css). weight: most bundled files are a single
  // regular weight, so we drop to 400 for those rather than force a
  // faux-bold synthesis the browser would otherwise apply.
  const BUNDLED_FONTS = [
    { id: 'adventuro', label: 'Adventuro', family: "'ClockFont-Adventuro'", weight: '400' },
    { id: 'caesar',    label: 'Caesar',    family: "'ClockFont-Caesar'",    weight: '400' },
    { id: 'bubble',    label: 'Bubble',    family: "'ClockFont-Bubble'",    weight: '400' },
    { id: 'garamond',  label: 'Garamond',  family: "'ClockFont-Garamond'",  weight: '400' },
    { id: 'minecraft', label: 'Minecraft', family: "'ClockFont-Minecraft'", weight: '400' },
    { id: 'redaction', label: 'Redaction', family: "'ClockFont-Redaction'", weight: '400' },
    { id: 'vintage',   label: 'Vintage',   family: "'ClockFont-Vintage'",  weight: '400' },
  ];
  const DEFAULT_FONT = { id: 'default', family: "'Space Grotesk', sans-serif", weight: '700' };
  const CUSTOM_FONT_FAMILY = 'ClockFont-Custom'; // registered dynamically via FontFace API

  let currentId = 'default';
  let customMeta = null; // { dataUrl, fileName } when a custom font is stored
  let customFontFace = null; // the registered FontFace instance, once loaded

  // ── Apply a font to the live clock (CSS variables on <html>) ────────
  function applyToClock(family, weight) {
    document.documentElement.style.setProperty('--clock-font', family);
    document.documentElement.style.setProperty('--clock-font-weight', weight);
  }

  // ── Register a custom font's base64 data with the FontFace API ──────
  // Returns true on success, false if the file couldn't be parsed as a
  // valid font (e.g. user picked a corrupt or non-font file).
  async function registerCustomFont(dataUrl) {
    try {
      if (customFontFace) {
        document.fonts.delete(customFontFace);
        customFontFace = null;
      }
      const face = new FontFace(CUSTOM_FONT_FAMILY, `url(${dataUrl})`);
      await face.load();
      document.fonts.add(face);
      customFontFace = face;
      return true;
    } catch (e) {
      return false;
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // ── Build the 9 tiles: Default, 7 bundled, Custom ────────────────────
  function renderGrid() {
    clockFontGrid.innerHTML = '';

    const tiles = [
      { id: 'default', label: 'Default', family: DEFAULT_FONT.family, weight: DEFAULT_FONT.weight },
      ...BUNDLED_FONTS,
    ];

    tiles.forEach(t => {
      const tile = document.createElement('button');
      tile.className = 'clock-font-tile';
      tile.type = 'button';
      tile.dataset.fontId = t.id;
      if (t.id === currentId) tile.classList.add('active');

      const sample = document.createElement('span');
      sample.className = 'clock-font-sample';
      sample.style.fontFamily = t.family;
      sample.style.fontWeight = t.weight;
      sample.textContent = '07:24';

      const label = document.createElement('span');
      label.className = 'clock-font-tile-label';
      label.textContent = t.label;

      tile.appendChild(sample);
      tile.appendChild(label);
      tile.addEventListener('click', () => selectFont(t.id, t.family, t.weight));

      clockFontGrid.appendChild(tile);
    });

    // Custom tile — appended last, always
    const customTile = document.createElement('button');
    customTile.className = 'clock-font-tile clock-font-tile-custom';
    customTile.type = 'button';
    customTile.dataset.fontId = 'custom';
    if (currentId === 'custom' && customMeta) customTile.classList.add('active', 'has-font');

    const customSample = document.createElement('span');
    customSample.className = 'clock-font-sample';

    const customLabel = document.createElement('span');
    customLabel.className = 'clock-font-tile-label';

    if (customMeta) {
      // A custom font is already stored — preview it in its own face,
      // label shows the original filename (trimmed).
      customSample.style.fontFamily = `'${CUSTOM_FONT_FAMILY}'`;
      customSample.textContent = '07:24';
      customLabel.textContent = customMeta.fileName || 'Custom';
    } else {
      customSample.textContent = '+';
      customSample.style.fontWeight = '400';
      customLabel.textContent = 'Custom';
    }

    customTile.appendChild(customSample);
    customTile.appendChild(customLabel);
    customTile.addEventListener('click', onCustomTileClick);
    clockFontGrid.appendChild(customTile);

    removeRow.classList.toggle('visible', !!customMeta);
  }

  // ── Selecting a bundled or default tile ──────────────────────────────
  async function selectFont(id, family, weight) {
    currentId = id;
    applyToClock(family, weight);
    // Only the active id changes here — the custom font's own data (if
    // any) is stored under a separate key and stays put, so switching to
    // a bundled font and back to Custom later doesn't lose the upload.
    await store.set('clockFont', { id });
    renderGrid();
  }

  // ── Clicking the Custom tile ──────────────────────────────────────────
  // If a custom font is already stored, clicking it just re-selects/
  // re-applies it (consistent with every other tile being a one-click
  // "use this" action). To replace it, remove it first, then upload again.
  async function onCustomTileClick() {
    if (customMeta) {
      currentId = 'custom';
      applyToClock(`'${CUSTOM_FONT_FAMILY}'`, '400');
      await store.set('clockFont', { id: 'custom' });
      renderGrid();
    } else {
      clockFontFileInput.click();
    }
  }

  clockFontFileInput.addEventListener('change', async () => {
    const file = clockFontFileInput.files && clockFontFileInput.files[0];
    clockFontFileInput.value = ''; // allow re-picking the same file later
    if (!file) return;

    const nameOk = /\.(ttf|otf)$/i.test(file.name);
    if (!nameOk) {
      showAppToast('Unsupported File', 'Please choose a .ttf or .otf font file.');
      return;
    }

    const dataUrl = await fileToDataUrl(file);
    const ok = await registerCustomFont(dataUrl);
    if (!ok) {
      showAppToast('Font Failed to Load', 'That file could not be read as a font.');
      return;
    }

    customMeta = { dataUrl, fileName: file.name };
    currentId = 'custom';
    applyToClock(`'${CUSTOM_FONT_FAMILY}'`, '400');
    // Custom font data lives in its own key, independent of which font
    // is currently selected — see selectFont()'s comment above.
    await store.set('clockFontCustom', { dataUrl, fileName: file.name });
    await store.set('clockFont', { id: 'custom' });
    renderGrid();
    showAppToast('Custom Font Applied', file.name);
  });

  removeBtn.addEventListener('click', async () => {
    customMeta = null;
    if (customFontFace) {
      document.fonts.delete(customFontFace);
      customFontFace = null;
    }
    if (currentId === 'custom') {
      currentId = 'default';
      applyToClock(DEFAULT_FONT.family, DEFAULT_FONT.weight);
    }
    await store.remove('clockFontCustom');
    await store.set('clockFont', { id: currentId });
    renderGrid();
    showAppToast('Custom Font Removed', 'Back to the default typeface.');
  });

  // ── Dialog open/close — mirrors the Background Settings dialog ──────
  function openClockFontDialog() {
    switchClockTab('typeface');
    clockFontBackdrop.classList.add('open');
    // Lets other modules (e.g. Other Changes' clock-position control)
    // re-sync against current storage/state every time the dialog is
    // actually shown, rather than relying solely on possibly-missed
    // cross-module events fired while the dialog was closed.
    document.dispatchEvent(new CustomEvent('flashdash:clockdialogopen'));
  }
  function closeClockFontDialog() {
    clockFontBackdrop.classList.remove('open');
  }

  clockFontClose.addEventListener('click', closeClockFontDialog);
  document.getElementById('clockFontBack').addEventListener('click', () => {
    closeClockFontDialog();
    settingsBackdrop.classList.add('open');
  });
  clockFontBackdrop.addEventListener('click', e => {
    if (e.target === clockFontBackdrop) closeClockFontDialog();
  });

  settingsOpenClockFontBtn.addEventListener('click', () => {
    settingsBackdrop.classList.remove('open');
    openClockFontDialog();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && clockFontBackdrop.classList.contains('open')) {
      closeClockFontDialog();
    }
  });

  // ── Init: restore persisted choice on load ───────────────────────────
  (async function init() {
    // Custom font data (if any) is loaded regardless of which font is
    // currently active, so the Custom tile shows the right preview/
    // filename even if the user is currently on a bundled font.
    const savedCustom = await store.get('clockFontCustom', null);
    if (savedCustom && savedCustom.dataUrl) {
      customMeta = { dataUrl: savedCustom.dataUrl, fileName: savedCustom.fileName };
    }

    const saved = await store.get('clockFont', null);
    const savedId = saved && saved.id;

    if (savedId === 'custom' && customMeta) {
      const ok = await registerCustomFont(customMeta.dataUrl);
      if (ok) {
        currentId = 'custom';
        applyToClock(`'${CUSTOM_FONT_FAMILY}'`, '400');
      } else {
        // Stored font failed to load (corrupted data) — fall back safely,
        // but keep customMeta so the tile still offers it; if it keeps
        // failing the user can just remove and re-upload.
        currentId = 'default';
        applyToClock(DEFAULT_FONT.family, DEFAULT_FONT.weight);
      }
    } else {
      const match = BUNDLED_FONTS.find(f => f.id === savedId);
      if (match) {
        currentId = match.id;
        applyToClock(match.family, match.weight);
      } else {
        currentId = 'default';
        applyToClock(DEFAULT_FONT.family, DEFAULT_FONT.weight);
      }
    }
    renderGrid();
  })();

})();


// ════════════════════════════════════════════════════════════
// initClockOtherChanges — "Modify Clock" → Other Changes tab
// ────────────────────────────────────────────────────────────
// Four independent clock tweaks, each persisted under its own key:
//   clockColorHue   : 0-359 — only ever applied while Indigo is on;
//                      stored regardless so the slider remembers the
//                      user's pick even if they leave Indigo and come
//                      back. Applied via --clock-accent-custom, which
//                      [data-indigo="true"] reads as a fallback chain
//                      (see style.css) — so it's a no-op outside Indigo
//                      even if somehow left set on <html>.
//   clockSize        : 'default' | 'compact'
//   clockPosition     : 'default' | 'right' — 'right' is only
//                      reachable while Tasks is hidden; if Tasks comes
//                      back on (from the Settings menu, elsewhere) while
//                      position is 'right', it auto-reverts to 'default'
//                      per spec, so the two can never overlap.
//   dateVisible       : boolean
// ════════════════════════════════════════════════════════════
(function initClockOtherChanges() {
  const colorSwatch   = document.getElementById('clockColorSwatch');
  const colorSpectrum = document.getElementById('clockColorSpectrum');
  const colorHint      = document.getElementById('clockColorHint');

  const sizeDefaultBtn  = document.getElementById('clockSizeDefault');
  const sizeCompactBtn  = document.getElementById('clockSizeCompact');

  const posDefaultBtn  = document.getElementById('clockPositionDefault');
  const posRightBtn    = document.getElementById('clockPositionRight');
  const posHint         = document.getElementById('clockPositionHint');

  const dateToggle = document.getElementById('clockDateToggle');

  if (!colorSpectrum || !sizeDefaultBtn || !posDefaultBtn || !dateToggle) return;

  let hue = 0;
  let indigoActive = document.documentElement.getAttribute('data-indigo') === 'true';
  let tasksVisible = true; // refined by the live event + a direct storage read below

  // ── 1. Clock color ────────────────────────────────────────────────
  function hueToHex(h) {
    // Fixed, fairly saturated/light values so every hue stays readable
    // against the Indigo theme's light panel background.
    const s = 75, l = 45;
    const c = (1 - Math.abs(2 * l / 100 - 1)) * (s / 100);
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l / 100 - c / 2;
    let r, g, b;
    if (h < 60)       { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function applyColor() {
    if (indigoActive) {
      const hex = hueToHex(hue);
      document.documentElement.style.setProperty('--clock-accent-custom', hex);
      colorSwatch.style.background = hex;
    } else {
      // Outside Indigo the clock color is fixed to the theme's normal
      // text color — clear any override so dark/light are untouched.
      document.documentElement.style.removeProperty('--clock-accent-custom');
      colorSwatch.style.background = '';
    }
    colorSpectrum.disabled = !indigoActive;
    colorHint.style.display = indigoActive ? 'none' : '';
  }

  colorSpectrum.addEventListener('input', async () => {
    hue = parseInt(colorSpectrum.value, 10) || 0;
    applyColor();
    await store.set('clockColorHue', hue);
  });

  // React live if Indigo gets toggled while this dialog happens to be open
  // (or in the background) rather than requiring a reopen to notice.
  document.addEventListener('flashdash:indigochange', (e) => {
    indigoActive = !!e.detail.enabled;
    applyColor();
  });

  // ── 2. Clock size ────────────────────────────────────────────────
  function applySize(size) {
    document.documentElement.classList.toggle('clock-size-compact', size === 'compact');
    sizeDefaultBtn.classList.toggle('active', size === 'default');
    sizeCompactBtn.classList.toggle('active', size === 'compact');
    sizeDefaultBtn.setAttribute('aria-checked', String(size === 'default'));
    sizeCompactBtn.setAttribute('aria-checked', String(size === 'compact'));
  }

  sizeDefaultBtn.addEventListener('click', async () => {
    applySize('default');
    await store.set('clockSize', 'default');
  });
  sizeCompactBtn.addEventListener('click', async () => {
    applySize('compact');
    await store.set('clockSize', 'compact');
  });

  // ── 3. Clock position ────────────────────────────────────────────
  function applyPosition(position) {
    document.documentElement.classList.toggle('clock-position-right', position === 'right');
    posDefaultBtn.classList.toggle('active', position === 'default');
    posRightBtn.classList.toggle('active', position === 'right');
    posDefaultBtn.setAttribute('aria-checked', String(position === 'default'));
    posRightBtn.setAttribute('aria-checked', String(position === 'right'));
  }

  function updatePositionAvailability() {
    // Spec: "Right" is only selectable while the Tasks panel is HIDDEN —
    // i.e. disable Right when Tasks is visible (they would overlap), and
    // enable it when Tasks is hidden. The hint underneath explains *why*
    // Right is disabled, so it's only shown in the disabled case.
    posRightBtn.disabled = tasksVisible;
    posHint.style.display = tasksVisible ? '' : 'none';
  }

  // Re-reads Tasks visibility straight from storage — the single source
  // of truth — and re-applies button availability + the auto-revert
  // rule. Called both at module init and every time the Clock dialog is
  // (re)opened, so this never depends on a live cross-module event
  // having fired while the dialog happened to be closed.
  async function refreshTasksVisibility() {
    const savedSettings = await store.get('settingsState', null);
    tasksVisible = !(savedSettings && savedSettings.tasksVisible === false);
    updatePositionAvailability();
    if (tasksVisible && document.documentElement.classList.contains('clock-position-right')) {
      applyPosition('default');
      await store.set('clockPosition', 'default');
    }
  }

  posDefaultBtn.addEventListener('click', async () => {
    applyPosition('default');
    await store.set('clockPosition', 'default');
  });
  posRightBtn.addEventListener('click', async () => {
    if (tasksVisible) return; // guarded by disabled state too, but belt & suspenders
    applyPosition('right');
    await store.set('clockPosition', 'right');
  });

  // Live updates while the dialog (or page) is already open/active.
  document.addEventListener('flashdash:tasksvisibility', (e) => {
    tasksVisible = !!e.detail.visible;
    updatePositionAvailability();
    if (tasksVisible && document.documentElement.classList.contains('clock-position-right')) {
      applyPosition('default');
      store.set('clockPosition', 'default');
    }
  });

  // Authoritative re-sync every time the Clock dialog is opened — this
  // is what actually fixes stale/incorrect button state, independent of
  // whether the live event above fired while the dialog was closed.
  document.addEventListener('flashdash:clockdialogopen', refreshTasksVisibility);

  // ── 4. Date visibility ───────────────────────────────────────────
  function applyDateVisible(visible) {
    document.documentElement.classList.toggle('clock-date-hidden', !visible);
    dateToggle.setAttribute('aria-checked', String(visible));
  }

  dateToggle.addEventListener('click', async () => {
    const next = dateToggle.getAttribute('aria-checked') !== 'true';
    applyDateVisible(next);
    await store.set('dateVisible', next);
  });

  // ── Init ─────────────────────────────────────────────────────────
  (async function init() {
    const savedHue = await store.get('clockColorHue', 0);
    hue = Number.isFinite(savedHue) ? savedHue : 0;
    colorSpectrum.value = String(hue);

    const savedSize = await store.get('clockSize', 'default');
    applySize(savedSize === 'compact' ? 'compact' : 'default');

    // Restore the saved clock position first (optimistic), then run the
    // same authoritative refresh used on every dialog-open — it reads
    // Tasks visibility fresh from storage and corrects/auto-reverts
    // position if the saved state turns out to be stale.
    const savedPosition = await store.get('clockPosition', 'default');
    applyPosition(savedPosition === 'right' ? 'right' : 'default');
    await refreshTasksVisibility();

    const savedDateVisible = await store.get('dateVisible', true);
    applyDateVisible(savedDateVisible !== false);

    indigoActive = document.documentElement.getAttribute('data-indigo') === 'true';
    applyColor();
  })();
})();

// ══════════════════════════════════════════════════════════════════════
// Stuff Drawer — stash notes / photos off the board
// ─────────────────────────────────────────────────────────────────────
// This module owns everything about the "Stuff" tab inside the existing
// Sites drawer:
//   • Drawer tab switching (Sites ↔ Stuff)
//   • The stashedItems storage schema
//   • The drop-target flow that hooks into a live board-item drag:
//     drag a photo or note over the Sites dock button and release, and
//     it's removed from the board and appears in the Stuff tab instead.
//   • The reverse flow: grab a stashed tile, drag it OUT of the drawer,
//     and it lands back on the board where you released it.
//
// Storage schema (chrome.storage.local key 'stashedItems'):
//   Array<StashedItem>
//   StashedItem = one of:
//     • Photo: { id, kind: 'photo', w, h, savedAt }
//         The image blob stays in IndexedDB under the same `id` in the
//         `photos` object store. Nothing else changes — the photo just
//         drops out of the `photos` array while it's stashed.
//     • Note:  { id, kind: 'note', text, color, w, h, savedAt }
//         Fully self-contained; notes are small so we keep everything
//         inline rather than adding another object store.
//
// The drop target is the whole "Sites" dock button; the drawer already
// opens on hover, so a user dragging an item toward the button will see
// the drawer expand mid-drag and can either release on the button OR
// keep going into the drawer body and release there. Both work.
// ══════════════════════════════════════════════════════════════════════
(function initStuff() {
  // ── DOM handles ───────────────────────────────────────────────────
  const drawer      = document.getElementById('sitesDrawer');
  const dockBtn     = document.getElementById('sitesToggleBtn');
  const tabsBar     = document.getElementById('sitesDrawerTabs');
  const tabSites    = document.getElementById('sitesTabSites');
  const tabStuff    = document.getElementById('sitesTabStuff');
  const panelSites  = document.getElementById('sitesPanelSites');
  const panelStuff  = document.getElementById('sitesPanelStuff');
  const list        = document.getElementById('stuffList');

  if (!drawer || !tabsBar || !list) return; // defensive; template must be present

  // ── Tab switching ────────────────────────────────────────────────
  function setActiveTab(name) {
    const isSites = name === 'sites';
    tabSites.classList.toggle('active', isSites);
    tabStuff.classList.toggle('active', !isSites);
    tabSites.setAttribute('aria-selected', String(isSites));
    tabStuff.setAttribute('aria-selected', String(!isSites));
    panelSites.classList.toggle('active', isSites);
    panelStuff.classList.toggle('active', !isSites);
    if (!isSites) renderStuff(); // refresh on entry so it's always current
  }
  tabSites.addEventListener('click', () => setActiveTab('sites'));
  tabStuff.addEventListener('click', () => setActiveTab('stuff'));

  // ── Storage helpers ──────────────────────────────────────────────
  async function loadStashed()          { return await store.get('stashedItems', []); }
  async function saveStashed(items)     { return await store.set('stashedItems', items); }

  // ── Rendering ────────────────────────────────────────────────────
  // Object URLs for stashed-photo thumbnails. Separate from the board's
  // _photoObjectUrls map so we don't accidentally revoke one while the
  // other is still using it (a photo can be stashed then re-added later,
  // during which time both maps might briefly hold the same id — we
  // want each map's lifecycle to be independent).
  const _stashObjectUrls = new Map();
  function _revokeStashUrl(id) {
    const url = _stashObjectUrls.get(id);
    if (url) { URL.revokeObjectURL(url); _stashObjectUrls.delete(id); }
  }
  function _revokeAllStashUrls() {
    for (const id of _stashObjectUrls.keys()) _revokeStashUrl(id);
  }

  async function renderStuff() {
    const items = await loadStashed();
    // Newest first so recently-stashed things are always in reach.
    const sorted = [...items].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    _revokeAllStashUrls();
    list.innerHTML = '';

    for (const item of sorted) {
      list.appendChild(await buildTile(item));
    }
  }

  async function buildTile(item) {
    const tile = document.createElement('div');
    tile.className = 'stuff-tile ' + (item.kind === 'note' ? 'stuff-tile-note ' : 'stuff-tile-photo ');
    if (item.kind === 'note') tile.classList.add('stuff-color-' + (item.color || 'yellow'));
    tile.dataset.id = item.id;
    tile.dataset.kind = item.kind;
    tile.title = item.kind === 'note' ? 'Note — drag out to restore' : 'Photo — drag out to restore';

    if (item.kind === 'photo') {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      const blob = await mediaStore.getPhoto(item.id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        _stashObjectUrls.set(item.id, url);
        img.src = url;
      }
      tile.appendChild(img);
    } else {
      // Note tile — text preview only.
      const preview = document.createElement('div');
      preview.className = 'stuff-note-preview';
      const t = (item.text || '').trim();
      if (t) {
        preview.textContent = t;
      } else {
        preview.classList.add('stuff-note-empty');
        preview.textContent = 'Empty note';
      }
      tile.appendChild(preview);
    }

    // Delete-forever button (top-right). Confirms first because this is
    // destructive — the blob (for photos) is dropped from IndexedDB too.
    const del = document.createElement('button');
    del.className = 'stuff-tile-del';
    del.textContent = '×';
    del.title = 'Delete forever';
    del.setAttribute('aria-label', 'Delete this stashed item');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = item.kind === 'note' ? 'this stashed note' : 'this stashed photo';
      if (!confirm(`Delete ${label} permanently? This can't be undone.`)) return;
      await removeStashed(item.id, /*alsoDeleteBlob*/ true);
      _revokeStashUrl(item.id);
      renderStuff();
    });
    tile.appendChild(del);

    // Drag-out-to-restore: pointerdown on the tile starts a ghost drag.
    // If released outside the drawer, restore to board; if inside, cancel.
    tile.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      if (e.target.closest('.stuff-tile-del')) return;
      startRestoreDrag(e, tile, item);
    });

    return tile;
  }

  async function removeStashed(id, alsoDeleteBlob) {
    const items = await loadStashed();
    const filtered = items.filter(x => x.id !== id);
    await saveStashed(filtered);
    if (alsoDeleteBlob) {
      // Only photos have a blob in IDB.
      const target = items.find(x => x.id === id);
      if (target && target.kind === 'photo') {
        await mediaStore.deletePhoto(id);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Drop-to-stash flow
  // ─────────────────────────────────────────────────────────────────
  // A board-item drag is in progress. On pointerdown of the item, the
  // photo / note drag helper calls _controller.begin(). We publish
  // "stashing is possible" via a body class (so CSS lights up the Sites
  // button), then on every pointermove we test whether the cursor is
  // over the stash drop zone and toggle a hot state. On pointerup, if
  // the cursor is in the drop zone, we perform the stash and RETURN
  // TRUE to the drag helper — that tells it to skip its usual "persist
  // updated position" step, because we've just removed the item from
  // storage entirely.
  //
  // The Sites drawer already auto-opens on hover of the button; that
  // works to our advantage — a user dragging a photo toward the button
  // gets the drawer expanding to meet them, and can drop anywhere
  // inside the button+drawer combined footprint.
  // ══════════════════════════════════════════════════════════════════
  let hotSurface = null; // 'button' | 'drawer' | null — the currently-hot drop target
  let dragCtx    = null; // {kind, wrapEl, item} for the drag in progress
  // Delay a hover-based drawer open by a couple of frames so a fast
  // fly-by doesn't pop the drawer mid-drag when the user is just
  // dragging past the button.
  let hoverOpenTimer = null;
  const DRAG_HOVER_OPEN_DELAY = 220; // ms

  function pointIsOverButton(x, y) {
    if (x == null || y == null) return false;
    const r = dockBtn.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  function pointIsOverDrawer(x, y) {
    if (x == null || y == null) return false;
    if (!drawer.classList.contains('open')) return false;
    const r = drawer.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function setHot(surface) {
    if (hotSurface === surface) return;
    if (hotSurface === 'button') dockBtn.classList.remove('stash-hot');
    if (hotSurface === 'drawer') drawer.classList.remove('stash-hot');
    hotSurface = surface;
    if (surface === 'button') dockBtn.classList.add('stash-hot');
    if (surface === 'drawer') drawer.classList.add('stash-hot');
  }

  _stashController.begin = function begin(kind, wrapEl, item) {
    dragCtx = { kind, wrapEl, item };
    document.body.classList.add('stashing-active');
  };

  _stashController.move = function move(x, y) {
    if (!dragCtx) return;
    if (pointIsOverButton(x, y)) {
      setHot('button');
      // Not open yet? Trigger the same hover-open as a stationary hover.
      if (!drawer.classList.contains('open') && !hoverOpenTimer) {
        hoverOpenTimer = setTimeout(() => {
          hoverOpenTimer = null;
          // Only open if we're still hot on the button — user may have moved on.
          if (hotSurface === 'button') {
            drawer.classList.add('open');
            // When the drawer opens mid-drag, jump straight to the Stuff
            // tab so the user sees where their item will land.
            setActiveTab('stuff');
          }
        }, DRAG_HOVER_OPEN_DELAY);
      }
    } else if (pointIsOverDrawer(x, y)) {
      setHot('drawer');
      // Any time the pointer is inside the (open) drawer during a stash
      // drag, make sure the Stuff tab is showing so the drop is meaningful.
      if (!panelStuff.classList.contains('active')) setActiveTab('stuff');
    } else {
      setHot(null);
      if (hoverOpenTimer) { clearTimeout(hoverOpenTimer); hoverOpenTimer = null; }
    }
  };

  _stashController.end = function end(kind, wrapEl, item, x, y) {
    const wasOverStash = pointIsOverButton(x, y) || pointIsOverDrawer(x, y);
    // Always clean up the visual state, regardless of whether we stash.
    document.body.classList.remove('stashing-active');
    setHot(null);
    if (hoverOpenTimer) { clearTimeout(hoverOpenTimer); hoverOpenTimer = null; }
    dragCtx = null;

    if (!wasOverStash) return false;

    // Perform the actual stash. This is async but we can't await here
    // (the drag helper is sync), so we fire-and-forget. The DOM removal
    // of the wrap happens synchronously below so there's no flicker
    // where the item briefly reappears on the board before disappearing.
    performStash(kind, wrapEl, item).catch(err => {
      console.error('[flash-dash] stash failed', err);
    });
    return true;
  };

  async function performStash(kind, wrapEl, item) {
    // 1) Remove the wrap element from the board so the user sees it vanish
    //    right at the moment they released the pointer.
    if (wrapEl && wrapEl.parentNode) wrapEl.parentNode.removeChild(wrapEl);

    // 2) Persist the change: pull from the source array, push onto stashed.
    if (kind === 'photo') {
      const [photos, stashed] = await Promise.all([
        store.get('photos', []),
        loadStashed()
      ]);
      const idx = photos.findIndex(p => p.id === item.id);
      const src = idx > -1 ? photos[idx] : item;
      // Remove from board array (but LEAVE the blob in IDB — it stays
      // keyed by the same id so we can restore it later).
      const newPhotos = photos.filter(p => p.id !== item.id);
      const stashedItem = {
        id: src.id,
        kind: 'photo',
        w: src.w,
        h: src.h,
        savedAt: Date.now()
      };
      stashed.push(stashedItem);
      await Promise.all([
        store.set('photos', newPhotos),
        saveStashed(stashed)
      ]);
    } else if (kind === 'note') {
      const [notes, stashed] = await Promise.all([
        store.get('notes', []),
        loadStashed()
      ]);
      const idx = notes.findIndex(n => n.id === item.id);
      const src = idx > -1 ? notes[idx] : item;
      const newNotes = notes.filter(n => n.id !== item.id);
      const stashedItem = {
        id: src.id,
        kind: 'note',
        text: src.text || '',
        color: src.color || 'yellow',
        w: src.w,
        h: src.h,
        savedAt: Date.now()
      };
      stashed.push(stashedItem);
      await Promise.all([
        store.set('notes', newNotes),
        saveStashed(stashed)
      ]);
    }

    // 3) If the Stuff panel is visible, re-render it so the new tile
    //    appears immediately. If not, it'll refresh next time the user
    //    opens it (renderStuff is also called on tab switch).
    if (panelStuff.classList.contains('active')) {
      renderStuff();
    }

    // 4) Small confirmation so the stash is unambiguous, especially
    //    when the drawer wasn't open at drop time.
    showAppToast(
      'Stashed',
      kind === 'note' ? 'Note saved to your chest.' : 'Photo saved to your chest.'
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // Restore-from-stash flow
  // ─────────────────────────────────────────────────────────────────
  // Pointerdown on a tile starts a lightweight "ghost" drag: a floating
  // preview follows the cursor everywhere, and on release we test
  // whether the pointer is OUTSIDE the drawer — if so, restore to
  // board at that position; if not, do nothing (cancel).
  // ══════════════════════════════════════════════════════════════════
  let restoreCtx = null;

  function startRestoreDrag(e, tile, item) {
    e.preventDefault();
    if (restoreCtx) return; // one at a time

    // Build the floating ghost. We snapshot the tile's current visuals
    // so the drag preview mirrors what the user grabbed.
    const ghost = document.createElement('div');
    ghost.className = 'stuff-drag-ghost';
    if (item.kind === 'photo') {
      // Use the same object URL the tile is already displaying.
      const tileImg = tile.querySelector('img');
      if (tileImg && tileImg.src) {
        const img = document.createElement('img');
        img.src = tileImg.src;
        ghost.appendChild(img);
      }
      ghost.style.width  = '120px';
      ghost.style.height = '120px';
    } else {
      ghost.classList.add('is-note', 'stuff-tile-note', 'stuff-color-' + (item.color || 'yellow'));
      const preview = document.createElement('div');
      preview.className = 'stuff-note-preview';
      const t = (item.text || '').trim();
      preview.textContent = t || 'Empty note';
      if (!t) preview.classList.add('stuff-note-empty');
      ghost.appendChild(preview);
      ghost.style.width  = '140px';
      ghost.style.height = '110px';
    }
    ghost.style.left = e.clientX + 'px';
    ghost.style.top  = e.clientY + 'px';
    document.body.appendChild(ghost);
    tile.classList.add('stuff-tile-dragging');

    restoreCtx = { tile, item, ghost, move: null, up: null };

    restoreCtx.move = function move(ev) {
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top  = ev.clientY + 'px';
    };
    restoreCtx.up = async function up(ev) {
      const ctx = restoreCtx;
      if (!ctx) return;
      document.removeEventListener('pointermove', ctx.move);
      document.removeEventListener('pointerup', ctx.up);
      document.removeEventListener('pointercancel', ctx.up);
      ctx.tile.classList.remove('stuff-tile-dragging');
      ctx.ghost.remove();
      restoreCtx = null;

      const x = ev ? ev.clientX : 0, y = ev ? ev.clientY : 0;
      // Cancel restore if released back on top of the drawer.
      if (pointIsOverDrawer(x, y) || pointIsOverButton(x, y)) return;

      await performRestore(ctx.item, x, y);
    };

    document.addEventListener('pointermove', restoreCtx.move, { passive: true });
    document.addEventListener('pointerup', restoreCtx.up);
    document.addEventListener('pointercancel', restoreCtx.up);
  }

  async function performRestore(item, x, y) {
    // Coordinates are viewport-based; the board itself covers the
    // whole viewport, so we can use them directly. We center the item
    // on the release point, then clamp to a reasonable margin so it
    // never lands off-screen.
    const w = item.w || (item.kind === 'note' ? 220 : 220);
    const h = item.h || (item.kind === 'note' ? 200 : 220);
    const margin = 20;
    let placedX = Math.round(x - w / 2);
    let placedY = Math.round(y - h / 2);
    placedX = Math.max(margin, Math.min(window.innerWidth  - w - margin, placedX));
    placedY = Math.max(margin, Math.min(window.innerHeight - h - margin, placedY));

    // Bump the shared z-counter so the restored item lands on top.
    _boardZCounter += 1;

    if (item.kind === 'photo') {
      const photos = await store.get('photos', []);
      const restored = { id: item.id, x: placedX, y: placedY, w, h, z: _boardZCounter };
      photos.push(restored);
      await store.set('photos', photos);
      // The blob is still in IDB under the same id — no extra work needed.
      renderPhotoEl(restored);
    } else {
      const notes = await store.get('notes', []);
      const restored = {
        id: item.id,
        text: item.text || '',
        color: item.color || 'yellow',
        x: placedX, y: placedY, w, h,
        z: _boardZCounter
      };
      notes.push(restored);
      await store.set('notes', notes);
      renderNoteEl(restored);
    }

    // Remove from stash (blob stays where it is; the board owns it now).
    await removeStashed(item.id, /*alsoDeleteBlob*/ false);
    _revokeStashUrl(item.id);
    renderStuff();

    showAppToast(
      'Restored',
      item.kind === 'note' ? 'Note is back on your board.' : 'Photo is back on your board.'
    );
  }

  // Defensive: if the user alt-tabs mid-restore, kill the ghost so it
  // doesn't get stuck onscreen.
  window.addEventListener('blur', () => {
    if (restoreCtx && restoreCtx.up) restoreCtx.up(null);
  });

  // Also render on init in case the drawer was left on the Stuff tab
  // last time — but we don't persist the active tab, so this is just
  // a safety net; the panel actually renders on tab-switch anyway.
  // Kept as a passive warm-up so the first tab click feels instant.
  renderStuff();
})();


// ══════════════════════════════════════════════════════════════════════
// Journal — one-line-a-day
// ─────────────────────────────────────────────────────────────────────
// A tiny, low-ceremony daily reflection widget: one line per calendar
// day, autosaved on blur / Enter. Past entries live in a scrollable
// history list underneath today's input; each past entry is inline-
// editable (click to edit, blur to save) or deletable on hover.
//
// Storage schema (chrome.storage.local key 'journalEntries'):
//   { "YYYY-MM-DD": { text: string, updatedAt: number } }
//
// Included in BACKUP_KEYS so export/import round-trips journal history.
// Opened via the sidebar-panel Journal button (see #journalToggleBtn in
// newtab.html) — no keyboard shortcut, to avoid colliding with 'J' as a
// possible future search hotkey.
// ══════════════════════════════════════════════════════════════════════
(function initJournal() {
  const backdrop  = document.getElementById('journalBackdrop');
  const dialog    = document.getElementById('journalDialog');
  const closeBtn  = document.getElementById('journalClose');
  const toggleBtn = document.getElementById('journalToggleBtn');

  const todayDateEl = document.getElementById('journalTodayDate');
  const todayInput  = document.getElementById('journalTodayInput');
  const countEl     = document.getElementById('journalCount');
  const savedEl     = document.getElementById('journalSaved');

  const historyEl   = document.getElementById('journalHistory');
  const historyCountEl = document.getElementById('journalHistoryCount');

  if (!backdrop || !toggleBtn) return;

  const MAX_LEN = 160;

  // ── Date helpers ─────────────────────────────────────────────────
  // Local-time YYYY-MM-DD (not UTC) so "today" matches the user's
  // calendar day, matching the countdown widget's date parsing.
  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function formatFullDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
  }
  function formatShortDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  // ── State ────────────────────────────────────────────────────────
  // In-memory mirror of journalEntries; loaded on first open, and kept
  // in sync with storage from that point on. Every mutation writes back.
  let entries = null;

  async function loadEntries() {
    if (entries) return entries;
    const raw = await store.get('journalEntries', {});
    // Defensive: ensure we always get an object even if storage was corrupted.
    entries = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return entries;
  }
  async function persistEntries() {
    await store.set('journalEntries', entries);
  }

  // ── UI: character count ──────────────────────────────────────────
  function updateCount() {
    const len = todayInput.value.length;
    countEl.textContent = `${len} / ${MAX_LEN}`;
    countEl.classList.toggle('is-near-limit', len >= MAX_LEN - 20 && len < MAX_LEN);
    countEl.classList.toggle('is-at-limit', len >= MAX_LEN);
  }

  // ── UI: "saved" indicator ────────────────────────────────────────
  let savedFlashTimer = null;
  function flashSaved() {
    savedEl.textContent = 'Saved';
    savedEl.classList.add('visible');
    clearTimeout(savedFlashTimer);
    savedFlashTimer = setTimeout(() => savedEl.classList.remove('visible'), 1400);
  }

  // ── Save today's line ────────────────────────────────────────────
  // Called on blur, Enter, and periodically while typing (debounced).
  let saveDebounce = null;
  async function saveToday(immediate) {
    const key = todayKey();
    const text = todayInput.value.trim().slice(0, MAX_LEN);
    await loadEntries();

    if (!text) {
      // Empty ⇒ removing today's entry entirely, so a day the user
      // typed into and then wiped doesn't clutter the history list.
      if (entries[key]) {
        delete entries[key];
        await persistEntries();
        renderHistory();
      }
      return;
    }

    const prior = entries[key];
    if (prior && prior.text === text) return; // no-op if unchanged
    entries[key] = { text, updatedAt: Date.now() };
    await persistEntries();
    flashSaved();
    // Only re-render history if it's an update to an existing past entry
    // OR the very first entry ever — today's entry is intentionally NOT
    // duplicated in the history list (the top slot IS today).
    renderHistory();
  }

  function scheduleSave() {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => saveToday(false), 500);
  }

  // ── UI: render past entries ──────────────────────────────────────
  function renderHistory() {
    const today = todayKey();
    // Every day EXCEPT today, newest first.
    const keys = Object.keys(entries)
      .filter(k => k !== today)
      .sort((a, b) => (a < b ? 1 : -1)); // string sort works for YYYY-MM-DD

    historyEl.innerHTML = '';
    for (const key of keys) {
      historyEl.appendChild(buildEntryRow(key, entries[key]));
    }
    historyCountEl.textContent = String(keys.length);
  }

  function buildEntryRow(key, entry) {
    const row = document.createElement('div');
    row.className = 'journal-entry';
    row.dataset.key = key;

    const date = document.createElement('div');
    date.className = 'journal-entry-date';
    date.textContent = formatShortDate(key);
    row.appendChild(date);

    const text = document.createElement('div');
    text.className = 'journal-entry-text';
    text.textContent = entry.text;
    text.title = 'Click to edit';
    text.spellcheck = false;
    // contenteditable is toggled on/off around the edit to keep the
    // whole row from being a click target for cursor placement.
    text.addEventListener('click', () => beginEditEntry(row, text, key));
    row.appendChild(text);

    const del = document.createElement('button');
    del.className = 'journal-entry-del';
    del.title = 'Delete this entry';
    del.setAttribute('aria-label', 'Delete this journal entry');
    del.innerHTML = '&times;';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete the entry for ${formatFullDate(key)}? This can't be undone.`)) return;
      delete entries[key];
      await persistEntries();
      renderHistory();
    });
    row.appendChild(del);

    return row;
  }

  function beginEditEntry(row, textEl, key) {
    if (textEl.getAttribute('contenteditable') === 'true') return; // already editing
    textEl.setAttribute('contenteditable', 'true');
    textEl.focus();
    // Place caret at end.
    const sel = window.getSelection();
    const rng = document.createRange();
    rng.selectNodeContents(textEl);
    rng.collapse(false);
    sel.removeAllRanges();
    sel.addRange(rng);

    // Save-on-blur/Enter, cancel-on-Escape.
    function commit() {
      cleanup();
      const next = textEl.textContent.trim().slice(0, MAX_LEN);
      if (!next) {
        // Empty ⇒ delete the entry entirely (same rule as today).
        delete entries[key];
      } else if (!entries[key] || entries[key].text !== next) {
        entries[key] = { text: next, updatedAt: Date.now() };
      } else {
        // No change — nothing to persist, but still re-render so the
        // row visually settles back to non-edit state.
        renderHistory();
        return;
      }
      persistEntries().then(renderHistory);
    }
    function cancel() {
      cleanup();
      textEl.textContent = entries[key] ? entries[key].text : '';
    }
    function cleanup() {
      textEl.removeAttribute('contenteditable');
      textEl.removeEventListener('blur', commit);
      textEl.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }
    textEl.addEventListener('blur', commit);
    textEl.addEventListener('keydown', onKey);
  }

  // ── Open / close ─────────────────────────────────────────────────
  async function open() {
    await loadEntries();

    const key = todayKey();
    todayDateEl.textContent = formatFullDate(key);
    todayInput.value = entries[key] ? entries[key].text : '';
    updateCount();
    savedEl.classList.remove('visible');
    renderHistory();

    backdrop.classList.add('open');
    // Autofocus but only after the entrance transition — otherwise the
    // caret jumps in before the dialog has finished sliding into place.
    setTimeout(() => todayInput.focus(), 90);
  }
  function close() {
    // Flush any pending debounced save so nothing gets dropped on close.
    if (saveDebounce) {
      clearTimeout(saveDebounce);
      saveDebounce = null;
      saveToday(true);
    }
    backdrop.classList.remove('open');
  }

  toggleBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  // Escape closes when the dialog itself has focus (matches the other
  // mini-dialogs' behavior).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) close();
  });

  // ── Input handlers ───────────────────────────────────────────────
  todayInput.addEventListener('input', () => {
    // Enforce the same char limit visually (the maxlength attr already
    // handles input, but we still update the counter live).
    if (todayInput.value.length > MAX_LEN) {
      todayInput.value = todayInput.value.slice(0, MAX_LEN);
    }
    updateCount();
    scheduleSave();
  });
  todayInput.addEventListener('blur', () => {
    if (saveDebounce) { clearTimeout(saveDebounce); saveDebounce = null; }
    saveToday(true);
  });
  todayInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      todayInput.blur(); // triggers save above
    }
  });
})();
