# ⚡ Flash Dash Pro

> A beautiful, distraction-free new tab extension for Chrome. Big clock, Google search, a freeform photo/notes board with Canva-style alignment guides, tasks with drag-to-reorder, bookmarks, focus timer, and one-click backup — all in one sleek dashboard.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blueviolet?style=flat-square)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![No Build Step](https://img.shields.io/badge/Build-None-success?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)

---

## Changelog

**Latest**
- **Stuff drawer — stash notes & photos off the board.** The Sites drawer now
  has a second tab, **Stuff**, with a scrollable grid of everything you've
  put away. To stash, drag any note or photo onto the Sites (chest) button;
  the drawer opens toward you mid-drag with the Stuff tab already active,
  and releasing over the button or the drawer sends the item into your
  chest — the board loses it, storage keeps it. To restore, drag a stashed
  tile out of the drawer onto the board; it lands where you release. Photo
  blobs stay put in IndexedDB the whole time, so no data is re-encoded and
  restore is instant. Included in Backup export/import (`stashedItems` +
  stashed-photo blobs) so a stashed item survives a device switch.
- **Journal — one-line-a-day.** New sidebar button opens a lightweight
  dialog: type one line for today, autosaves on blur / Enter, and a
  scrollable history of every past day lives underneath (click any past
  line to edit inline, hover to reveal a delete button). Storage key
  `journalEntries` is a plain `{ "YYYY-MM-DD": { text, updatedAt } }`
  map, included in the standard backup file.
- **Backup export / import now includes images.** The old exporter only serialized `chrome.storage`, so imported boards came back with photo positions but no image data. Photo blobs (from IndexedDB) and the custom background blob are now serialized as base64 into the backup JSON and restored to IndexedDB on import. Backup format bumped to `version: 2`; v1 files still import (empty `blobs` section falls back to any legacy `src` data-URL on each photo).
- **Snap guides — Canva/Figma-style, reworked.**
  - Guide lines are now **bounded** to just the photos they align — they no longer span the entire viewport.
  - Same-line neighbors are **grouped** into a single merged guide.
  - **Edge** guides (magenta) vs **center** guides (violet) are color-coded so you can see edge-snap vs center-snap at a glance.
  - **Equal-spacing badges** (`= 24`) appear in the gaps between three collinear rects when spacing matches.
  - **Dimension brackets** (`230 px`, `229 px`) — during a resize, brackets are drawn on **every** photo (dragged and all others) so any potential width/height match is visible without hitting a snap threshold.
  - Renderer is a **keyed reconciler**: guide DOM nodes are pooled and reused across frames, so a guide that stays in the same place keeps the same node and no longer re-animates every frame — flicker is gone.
- **Task reordering — fixed for good.** Drag-and-drop across many rows in a single gesture now works: `pointermove`/`pointerup` are attached to `document`, not to the handle (which gets reparented mid-drag by `insertBefore` and used to silently drop pointer capture). A `window.blur` safety net also ends the drag if you alt-tab away, so rows can't get stuck in the lifted state.
- **Redesigned welcome overlay** — two-panel layout with a hero side (headline, animated conic-gradient border, `/` shortcut callout, CTA) and a scrollable feature list with staggered fade-in on the right. First-run users are led straight to the settings menu.

**Earlier**
- Added sticky notes.
- Added drag-and-drop for images onto the board.

---

## Features

| Feature | Description |
|---|---|
| ⚙️ **Settings menu** | Press <kbd>/</kbd> anywhere to open — the entry point to every preference and to Backup / Import. |
| 🕐 **Clock** | Large, always-visible time display with AM/PM, date, custom font, custom color, and adjustable position + size. |
| 🔍 **Google Search** | Spotlight-style search bar with autocomplete — focus with <kbd>Ctrl+G</kbd>. |
| 🖼️ **Photo Board** | Freely drag, resize (from any edge), and layer inspiration photos on a freeform canvas with **smart alignment guides**, **equal-spacing hints**, and **pixel dimension labels**. Hold <kbd>Alt</kbd> to bypass snapping. |
| 🖊️ **Sticky Notes** | Pin quick notes anywhere on the board, in 5 colors. |
| ✅ **Tasks** | Lightweight persistent to-do list on the right panel. Drag the grip handle to reorder. |
| 🔖 **Bookmarks** | Slide-out bookmark drawer + pin up to 6 shortcuts to the left toolbar. |
| 🌐 **Sites drawer** | Hover the Sites button to peek at your pinned sites — opens after a 1 s hover intent delay, closes on mouseleave. |
| 🌙 **Theme** | Dark / light mode toggle + optional indigo overlay, persisted across tabs. |
| ⏱️ **Focus Timer** | Pomodoro-style focus & break sessions, fully customizable. |
| 🎨 **Custom Background** | Set an image (or video) as your board background — stored locally as a Blob in IndexedDB. |
| 🧰 **Stuff Chest** | A second tab inside the Sites drawer that holds notes/photos you've dragged off the board. Drag any item onto the Sites button to stash it; drag a stashed tile back out to restore it. |
| 📖 **Journal** | One-line-a-day reflection. New sidebar button opens a dialog with today's input + a scrollable history of every past day; entries autosave and are inline-editable. |
| 💾 **Backup & Restore** | Export everything (data + all images + stash + journal) to one JSON file, and import it back on a new install or device. |
| 👋 **Welcome Screen** | Redesigned first-install overlay that leads new users through all features. |

---

## Photo Board — Snap Guide Cheat Sheet

While dragging or resizing a photo:

| Guide | What it means |
|---|---|
| **Magenta line** | An edge (left/right/top/bottom) is aligned with a neighbor's edge, or side-by-side at the default gap. |
| **Violet line** | Centers (horizontal or vertical) are aligned with a neighbor's center. |
| **Green bracket + `230 px`** | Pixel dimension. Always shown for every photo during a resize so you can eyeball matches instantly. |
| **`= 24` badge** | Equal spacing detected — the moving photo sits equidistant between two neighbors on that axis. |

Hold <kbd>Alt</kbd> while dragging or resizing to **disable snapping** for fine, sub-pixel positioning.

---

## Installation

> No build step required — Flash Dash is pure HTML, CSS, and JavaScript.

### 1. Download the file

Grab the release ZIP and unzip it.

### 2. Open Chrome / Brave Extensions

Navigate to `chrome://extensions` in your browser.

### 3. Enable Developer Mode

Toggle **Developer mode** in the top-right corner of the extensions page.

### 4. Load the extension

Click **Load unpacked** and select the `flash-dash/` folder (the one containing `manifest.json`).

### 5. Open a new tab

Press <kbd>Ctrl+T</kbd> — Flash Dash replaces the default new tab page.

---

## Permissions

The extension requests only the minimum permissions needed:

| Permission | Why it's needed |
|---|---|
| `storage` | Persists tasks, pinned shortcuts, theme preference, photo positions, and search history. |
| `unlimitedStorage` | Removes the 5 MB storage quota so IndexedDB can hold photo blobs and the custom background. |
| `bookmarks` | Reads your Chrome bookmarks to populate the bookmarks drawer and the pin picker. |
| `tabs` | Navigates the current tab when you click a bookmark or search result. |
| `https://suggestqueries.google.com/` | Fetches Google autocomplete suggestions for the search bar. |

---

## Project Structure

```
flash-dash/
├── manifest.json       # Chrome Extension Manifest V3 config
├── newtab.html         # New tab page markup (loaded by Chrome on Ctrl+T)
├── style.css           # All styles — design tokens, layout, components
├── script.js           # All runtime logic — clock, search, photos, tasks, etc.
├── Fonts/              # Clock display fonts (Minecraft, Vintage, Caesar, ...)
├── icons/
│   ├── icon16.png      # Toolbar icon (16×16)
│   ├── icon48.png      # Extensions page icon (48×48)
│   └── icon128.png     # Chrome Web Store icon (128×128)
└── README.md           # This file
```

---

## Storage — where things live

Flash Dash persists across two storage layers:

**`chrome.storage.local`** — small JSON records:

| Key | Type | Description |
|---|---|---|
| `welcomed` | `boolean` | Whether the user has seen the welcome overlay |
| `theme` | `"dark" \| "light"` | Current colour theme |
| `indigoEnabled` | `boolean` | Whether the indigo overlay is active on top of the theme |
| `tasks` | `Array<{id, text, done}>` | Task list |
| `notes` | `Array<{id, text, x, y, w, h, color, z}>` | Sticky notes on the board |
| `photos` | `Array<{id, x, y, w, h, z}>` | Photo positions/sizes (image blobs live in IndexedDB, keyed by `id`) |
| `stashedItems` | `Array<StashedItem>` | Items in the Stuff drawer. Photo entries are `{id, kind:'photo', w, h, savedAt}` (blob stays in IDB under `id`); note entries are `{id, kind:'note', text, color, w, h, savedAt}` (fully self-contained). |
| `journalEntries` | `{ "YYYY-MM-DD": { text, updatedAt } }` | One-line-a-day entries, keyed by local date. |
| `customSites` | `Array<{title, url, iconUrl}>` | Custom pinned sites |
| `countdownEvent` | `{ label, timestamp }` | Countdown widget target |
| `pomodoroState` | `object` | Persistent Pomodoro timer state |
| `settingsState` | `object` | Settings-menu preferences (search visibility, etc.) |
| `sidebarOpen` | `boolean` | Sidebar drawer state |
| `clockFont` / `clockFontCustom` / `clockColorHue` / `clockSize` / `clockPosition` / `dateVisible` | mixed | Clock appearance |
| `backgroundSettings` | `object` | Metadata for the active custom background |

**IndexedDB (`flashDashMedia`)** — binary blobs:

| Object store | Key | Value |
|---|---|---|
| `photos` | `photo.id` | The raw image `Blob` for each photo on the board |
| `background` | `'current'` | The active custom background `Blob` (single-slot) |

**Backup file schema (`version: 2`)**

```jsonc
{
  "app": "flash-dash",
  "version": 2,
  "exportedAt": "2026-07-10T14:34:00.000Z",
  "data":  { /* every chrome.storage.local key above */ },
  "blobs": {
    "photos":     { "<photoId>": "data:image/...;base64,..." },
    "background": "data:image/...;base64,..."   // or null
  }
}
```

The importer restores both `data` (to `chrome.storage.local`) and `blobs` (to IndexedDB). Old `version: 1` files still import — the exporter used to embed image data on each photo's `src` field, and the importer falls back to that when a `blobs.photos[id]` entry is missing.

---

## Development

### No build tooling needed

Open any file directly in your editor. Changes are reflected immediately after reloading the extension:

1. Edit a file.
2. Go to `chrome://extensions`.
3. Click the **↺ refresh** icon on the Flash Dash card.
4. Open a new tab.

### Resetting the welcome screen (for testing)

Open the Chrome DevTools console on any new tab page and run:

```js
chrome.storage.local.remove('welcomed');
```

Then open a new tab — the welcome overlay will appear again.

### Wiping all data (fresh install)

```js
chrome.storage.local.clear();
indexedDB.deleteDatabase('flashDashMedia');
```

---

## Browser Support

| Browser | Status |
|---|---|
| Chrome 109+ | ✅ Fully supported |
| Edge (Chromium) | ✅ Compatible |
| Brave | ✅ Compatible |
| Firefox | ❌ Manifest V3 not yet supported |
| Safari | ❌ Not supported |

---

## Privacy

**Flash Dash collects zero personal data.**

| What | Details |
|---|---|
| **Local storage only** | All data (tasks, photos, notes, bookmarks, settings) is stored exclusively in `chrome.storage.local` and IndexedDB on your own device. |
| **No servers** | Flash Dash has no backend, no analytics, no telemetry, and no accounts. |
| **No tracking** | No cookies, no fingerprinting, no usage tracking of any kind. |
| **Photos stay local** | Images you add to the board are stored as binary `Blob`s in IndexedDB — never uploaded anywhere. Exports stay on your device unless you choose to move the JSON file yourself. |
| **Search autocomplete** | When you type in the search bar, a request is sent directly from your browser to `suggestqueries.google.com` (Google's public autocomplete API). This is the same request Chrome itself makes natively and is subject to [Google's Privacy Policy](https://policies.google.com/privacy). |
| **Bookmarks** | The extension reads your bookmarks locally via the Chrome API to display them in the drawer. They are never transmitted externally. |

This extension is designed to be fully auditable — the entire codebase is plain HTML, CSS, and JavaScript with no minification or obfuscation.
