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
  }
};

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
function tickClock() {
  const now = new Date();
  let h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  document.getElementById('time').textContent = `${h}:${m}`;
  document.getElementById('ampm').textContent = ampm;

  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  document.getElementById('date').textContent = dateStr;
}
tickClock();
setInterval(tickClock, 1000);

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

async function loadBookmarks() {
  bookmarksList.innerHTML = '';

  if (window.chrome && chrome.bookmarks && chrome.bookmarks.getTree) {
    chrome.bookmarks.getTree((tree) => {
      const flat = [];
      function traverse(nodes) {
        nodes.forEach(node => {
          if (node.url) {
            flat.push(node);
          }
          if (node.children) {
            traverse(node.children);
          }
        });
      }
      traverse(tree);
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

function renderTasks(tasks) {
  taskList.innerHTML = '';
  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'task-empty';
    empty.textContent = 'Nothing yet.';
    taskList.appendChild(empty);
  }
  tasks.forEach((task, idx) => {
    const li = document.createElement('li');
    li.className = 'task-item';

    const check = document.createElement('div');
    check.className = 'task-check' + (task.done ? ' done' : '');
    check.addEventListener('click', async () => {
      const current = await store.get('tasks', []);
      current[idx].done = !current[idx].done;
      await store.set('tasks', current);
      renderTasks(current);
      updateCount(current);
    });

    const text = document.createElement('span');
    text.className = 'task-text' + (task.done ? ' done' : '');
    text.textContent = task.text;

    const del = document.createElement('span');
    del.className = 'task-del';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      const current = await store.get('tasks', []);
      current.splice(idx, 1);
      await store.set('tasks', current);
      renderTasks(current);
      updateCount(current);
    });

    li.appendChild(check);
    li.appendChild(text);
    li.appendChild(del);
    taskList.appendChild(li);
  });
}

function updateCount(tasks) {
  const left = tasks.filter(t => !t.done).length;
  taskCount.textContent = `${left} left`;
}

async function initTasks() {
  const tasks = await store.get('tasks', []);
  renderTasks(tasks);
  updateCount(tasks);
}
initTasks();

taskInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const text = taskInput.value.trim();
  if (!text) return;
  const current = await store.get('tasks', []);
  current.push({ text, done: false });
  await store.set('tasks', current);
  taskInput.value = '';
  renderTasks(current);
  updateCount(current);
});

// ---------- theme ----------
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // sun for light, moon for dark
  if (theme === 'light') {
    themeIcon.innerHTML = '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>';
  } else {
    themeIcon.innerHTML = '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>';
  }
}

async function initTheme() {
  const theme = await store.get('theme', 'dark');
  applyTheme(theme);
}
initTheme();

themeToggle.addEventListener('click', async () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await store.set('theme', next);
});

// ---------- Gallery of Goals (Glassmorphic Polaroid) + Sticky Notes ----------
const board = document.getElementById('board');
const photoInput = document.getElementById('photoInput');
const addPhotoBtn = document.getElementById('addPhotoBtn');
const addNoteBtn = document.getElementById('addNoteBtn');
const clearPhotosBtn = document.getElementById('clearPhotosBtn');

// Shared z-index counter across photos AND notes so "bring to front" works
// consistently no matter what kind of item the user last touched.
let _boardZCounter = 10;

function makeDraggable(el, item, onChange) {
  el.addEventListener('pointerdown', (e) => {
    // Skip drag-start for anything interactive — buttons, inputs, editable
    // text — so clicks on controls inside a draggable card/photo/note still
    // register normally instead of being swallowed by the drag handler.
    // (.del/.resize/etc. are kept explicitly for clarity/back-compat even
    // though the generic checks below already cover them.)
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

    function move(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      item.x = origX + dx;
      item.y = origY + dy;
      el.style.left = item.x + 'px';
      el.style.top = item.y + 'px';
    }
    function up() {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.style.cursor = 'grab';
      onChange();
    }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

function makeResizable(el, handle, item, onChange, minW = 120, minH = 150) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origW = item.w, origH = item.h;
    handle.setPointerCapture(e.pointerId);

    function move(ev) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      item.w = Math.max(minW, origW + dx);
      item.h = Math.max(minH, origH + dy);
      el.style.width = item.w + 'px';
      el.style.height = item.h + 'px';
    }
    function up() {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      onChange();
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
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

function renderPhotoEl(photo) {
  const wrap = document.createElement('div');
  wrap.className = 'photo';
  wrap.style.left = photo.x + 'px';
  wrap.style.top = photo.y + 'px';
  wrap.style.width = photo.w + 'px';
  wrap.style.height = photo.h + 'px';

  // Apply persisted z-index (default to 2 if none saved yet)
  const savedZ = photo.z || 2;
  wrap.style.zIndex = savedZ;
  if (savedZ > _boardZCounter) _boardZCounter = savedZ;

  const img = document.createElement('img');
  img.src = photo.src;
  wrap.appendChild(img);

  const del = document.createElement('div');
  del.className = 'del';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    const photos = await store.get('photos', []);
    const filtered = photos.filter(p => p.id !== photo.id);
    await store.set('photos', filtered);
    wrap.remove();
  });
  wrap.appendChild(del);

  const resize = document.createElement('div');
  resize.className = 'resize';
  wrap.appendChild(resize);

  board.appendChild(wrap);

  async function persist() {
    const photos = await store.get('photos', []);
    const idx = photos.findIndex(p => p.id === photo.id);
    if (idx > -1) { photos[idx] = photo; await store.set('photos', photos); }
  }

  // Click (not drag) → bring this photo to the front
  wrap.addEventListener('pointerdown', () => bringToFront(wrap, photo, persist));

  makeDraggable(wrap, photo, persist);
  makeResizable(wrap, resize, photo, persist);
}

async function renderBoard() {
  const [photos, notes] = await Promise.all([
    store.get('photos', []),
    store.get('notes', [])
  ]);
  board.innerHTML = '';
  photos.forEach(renderPhotoEl);
  notes.forEach(renderNoteEl);
}
renderBoard();

// ── shared "add photos" pipeline used by both the file picker and drag-drop ──
async function addPhotoFiles(files) {
  const imageFiles = [...files].filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;

  const [photos, notes] = await Promise.all([
    store.get('photos', []),
    store.get('notes', [])
  ]);
  // Anchor pool includes existing notes too, so photos can land near them
  const existingSnapshot = [...photos, ...notes];
  const w = 220, h = 220;

  for (const file of imageFiles) {
    const dataUrl = await new Promise((res) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.readAsDataURL(file);
    });

    const { x, y } = pickPlacement(existingSnapshot, w, h);

    _boardZCounter += 1;
    const photo = {
      id: Date.now() + Math.random().toString(36).slice(2),
      src: dataUrl,
      x, y, w, h,
      z: _boardZCounter
    };
    photos.push(photo);
    existingSnapshot.push(photo);
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

  await Promise.all([store.set('photos', []), store.set('notes', [])]);
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
  await addPhotoFiles(e.dataTransfer.files);
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

  makeDraggable(wrap, note, persist);
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
  const isOpen = sitesDrawer.classList.contains('open');
  bookmarksDrawer.classList.remove('open');
  sitesDrawer.classList.toggle('open', !isOpen);
  if (!isOpen) loadSites();
});

closeSitesDrawer.addEventListener('click', () => {
  sitesDrawer.classList.remove('open');
});

document.addEventListener('click', (e) => {
  if (!sitesDrawer.contains(e.target) && !sitesToggleBtn.contains(e.target)) {
    sitesDrawer.classList.remove('open');
  }
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
  const BACKUP_KEYS = [
    'notes', 'photos', 'tasks', 'customSites',
    'countdownEvent', 'countdownWidget', 'pomodoroWidget'
  ];

  const exportBtn = document.getElementById('settingsExportBtn');
  const importBtn = document.getElementById('settingsImportBtn');
  const importFile = document.getElementById('settingsImportFile');

  async function exportData() {
    try {
      const data = {};
      await Promise.all(BACKUP_KEYS.map(async (key) => {
        data[key] = await store.get(key, null);
      }));

      const payload = {
        app: 'flash-dash',
        version: 1,
        exportedAt: new Date().toISOString(),
        data
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const dateStamp = new Date().toISOString().slice(0, 10);

      const a = document.createElement('a');
      a.href = url;
      a.download = `flash-dash-backup-${dateStamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      showAppToast('Backup Exported', 'Your data has been saved to a file.');
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

    const confirmed = window.confirm(
      'Importing will overwrite your current notes, photos, tasks, sites, countdowns, and widget positions with the contents of this file. This cannot be undone. Continue?'
    );
    if (!confirmed) return;

    try {
      await Promise.all(BACKUP_KEYS.map(async (key) => {
        if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null) {
          await store.set(key, data[key]);
        }
      }));
      showAppToast('Backup Imported', 'Reloading to apply your restored data…');
      setTimeout(() => window.location.reload(), 1200);
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
  function fetchGoogleSuggestions(query) {
    // Use client=firefox to get a plain JSON array response (no JSONP needed).
    // This avoids dynamic <script> injection which is blocked by MV3 CSP.
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;
    return fetch(url)
      .then(r => r.json())
      .then(data => {
        // Response format: [query, [suggestions]]
        return Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 6) : [];
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
  // needing a reload — cheap to check every minute since it's just a diff.
  setInterval(render, 60 * 1000);

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
    modeLabel.textContent = state.mode === 'focus' ? 'Focus Session' : 'Break Time';
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

  function renderTick() {
    let remaining = remainingSeconds();

    // Session boundary crossed while we weren't actively watching (e.g. the
    // tab was backgrounded) — settle it before painting anything.
    if (state.running && remaining <= 0) {
      advanceSession(true);
      return;
    }

    timeEl.textContent = formatTime(remaining);
    const fraction = Math.min(1, Math.max(0, 1 - remaining / state.duration));
    ringProgress.style.strokeDashoffset = (RING_CIRCUMFERENCE * fraction).toFixed(2);
    startPauseBtn.textContent = state.running ? 'Pause' : 'Start';
  }

  function startTicking() {
    stopTicking();
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state) renderTick();
  });

  // Make this card a draggable, hideable floating widget.
  const closeWidgetBtn = document.getElementById('pomodoroCloseBtn');
  const toggleWidgetBtn = document.getElementById('pomodoroToggleBtn');
  initFloatingWidget('pomodoroWidget', card, toggleWidgetBtn, closeWidgetBtn, 240);
})();
