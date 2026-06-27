# ⚡ Flash Dash

> A beautiful, distraction-free new tab extension for Chrome. Big clock, Google search, goal photos, sticky notes, tasks, countdowns, a focus timer, and quick-launch sites — all in one sleek dashboard.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blueviolet?style=flat-square)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![No Build Step](https://img.shields.io/badge/Build-None-success?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)

---
## Changelog
- Added Export / Import for backups — save notes, photos, tasks, sites, countdowns, and widget positions to one JSON file, or restore them on a new device
- Added a Settings menu (press `/` to open) for toggling Tasks and the Google search bar
- Replaced Pinned Shortcuts with a Sites Drawer for managing custom site shortcuts
- Added floating widgets for Countdown and Focus Timer (Pomodoro) — draggable, independently positioned, and toggled from the toolbar
- Added in-app toast notifications for timer and background events
- Added Sticky notes
- Added Drag and Drop feature, you can now drag and drop images from your pc or even internet without needing to download the image.
 ---

## Features

| Feature | Description |
|---|---|
| 🕐 **Clock** | Large, always-visible time display with AM/PM and date |
| 🔍 **Google Search** | Spotlight-style search bar with autocomplete — focus with `Ctrl+G` |
| 🖼️ **Photo Board** | Freely drag, resize, and layer goal/inspiration images on a freeform canvas |
| 🗒️ **Sticky Notes** | Freeform colour-coded notes on the same canvas as your photos |
| ✅ **Tasks** | Lightweight persistent to-do list on the right panel |
| ⏳ **Countdown** | Floating, draggable widget counting down to an exam or deadline |
| ⏱️ **Focus Timer** | Floating Pomodoro-style timer with custom focus/break lengths and toast/sound alerts |
| 🌐 **Sites Drawer** | Slide-out drawer for up to 15 of your own quick-launch site shortcuts |
| 🔖 **Bookmarks** | Slide-out drawer listing your Chrome bookmarks for quick access |
| ⚙️ **Settings Menu** | Press `/` to toggle the Tasks panel and search bar, or back up/restore your data |
| 💾 **Backup / Restore** | Export all your data to one JSON file, or import it on a new device |
| 🌙 **Theme** | Dark / light mode toggle, persisted across tabs |
| 👋 **Welcome Screen** | First-install overlay that walks new users through all features |

---

## Installation

> No build step required — Flash Dash is pure HTML, CSS, and JavaScript.

### 1. Download the file
```
# download and unzip the release ZIP
```

### 2. Open Chrome/brave Extensions

Navigate to `chrome://extensions` in your browser.

### 3. Enable Developer Mode

Toggle **Developer mode** in the top-right corner of the extensions page.

### 4. Load the extension

Click **Load unpacked** and select the `flash-dash/` folder (the one containing `manifest.json`).

### 5. Open a new tab

Press `Ctrl+T` — Flash Dash replaces the default new tab page.

---

## Permissions

The extension requests only the minimum permissions needed:

| Permission | Why it's needed |
|---|---|
| `storage` | Persists tasks, notes, sites, countdowns, the focus timer, widget positions, theme preference, photos, and search history |
| `unlimitedStorage` | Allows photo data URLs (base64 images) to be stored without hitting the 5 MB quota |
| `bookmarks` | Reads your Chrome bookmarks to populate the bookmarks drawer |
| `tabs` | Navigates the current tab when you click a bookmark or search result |
| `https://suggestqueries.google.com/` | Fetches Google autocomplete suggestions for the search bar |

---

## Project Structure

```
flash-dash/
├── manifest.json       # Chrome Extension Manifest V3 config
├── newtab.html         # New tab page markup (loaded by Chrome on Ctrl+T)
├── style.css           # All styles — design tokens, layout, components
├── script.js           # All runtime logic — clock, search, photos, tasks, etc.
├── icons/
│   ├── icon16.png      # Toolbar icon (16×16)
│   ├── icon48.png      # Extensions page icon (48×48)
│   └── icon128.png     # Chrome Web Store icon (128×128)
└── README.md           # This file
```

---

## Development

### No build tooling needed

Open any file directly in your editor. Changes are reflected immediately after reloading the extension:

1. Edit a file
2. Go to `chrome://extensions`
3. Click the **↺ refresh** icon on the Flash Dash card
4. Open a new tab

### Storage keys

All data is stored in `chrome.storage.local`. Key reference:

| Key | Type | Description |
|---|---|---|
| `welcomed` | `boolean` | Whether the user has seen the welcome screen |
| `theme` | `"dark" \| "light"` | Current colour theme |
| `tasks` | `Array<{text, done}>` | Task list |
| `photos` | `Array<{id, src, x, y, w, h, z}>` | Photo board state |
| `notes` | `Array<{id, text, color, x, y, w, h, z}>` | Sticky notes on the board |
| `customSites` | `Array<{id, name, url}>` | Sites Drawer shortcuts (up to 15) |
| `countdownEvent` | `{name, date}` | The exam/deadline set in the Countdown widget |
| `countdownWidget` | `{visible, x, y, z}` | Countdown widget's position and visibility |
| `pomodoroWidget` | `{visible, x, y, z}` | Focus Timer widget's position and visibility |
| `pomodoroState` | `{mode, focusMinutes, breakMinutes, running, startedAt, duration}` | Focus Timer's current session state |
| `settingsState` | `{tasksVisible, searchVisible}` | Settings menu toggle preferences |
| `searchHistory` | `string[]` | Recent search queries (max 5) |

> **Note:** `theme`, `settingsState`, and `searchHistory` are local preferences and aren't included in Export/Import backups (see below) — only the keys representing your actual content and layout are.

### Backup / Restore

Open the Settings menu (press `/`) and use **Export Data** / **Import Data** to move your dashboard between browsers or devices.

- **Export** bundles `tasks`, `photos`, `notes`, `customSites`, `countdownEvent`, `countdownWidget`, and `pomodoroWidget` into a single timestamped JSON file and downloads it.
- **Import** reads a previously exported file, asks for confirmation (it overwrites your current data), writes it back to `chrome.storage.local`, and reloads the page.

### Resetting the welcome screen (for testing)

Open the Chrome DevTools console on any new tab page and run:

```js
chrome.storage.local.remove('welcomed');
```

Then open a new tab — the welcome overlay will appear again.

---

## Browser Support

| Browser | Status |
|---|---|
| Chrome 109+ | ✅ Fully supported |
| Edge (Chromium) | ✅ Compatible |
| Firefox | ❌ Manifest V3 not yet supported |
| Safari | ❌ Not supported |


## Privacy

**Flash Dash collects zero personal data.**

| What | Details |
|---|---|
| **Local storage only** | All data (tasks, notes, photos, sites, bookmarks, settings) is stored exclusively in `chrome.storage.local` on your own device |
| **No servers** | Flash Dash has no backend, no analytics, no telemetry, and no accounts |
| **No tracking** | No cookies, no fingerprinting, no usage tracking of any kind |
| **Photos stay local** | Images you add to the board are encoded as base64 data URLs and stored locally — they are never uploaded anywhere |
| **Search autocomplete** | When you type in the search bar, a request is sent directly from your browser to `suggestqueries.google.com` (Google's public autocomplete API). This is the same request Chrome itself makes natively and is subject to [Google's Privacy Policy](https://policies.google.com/privacy) |
| **Bookmarks** | The extension reads your bookmarks locally via the Chrome API to display them in the drawer. They are never transmitted externally |
| **Backup files** | Export/Import is entirely local — the JSON file is generated and read directly in your browser and never sent anywhere |

This extension is designed to be fully auditable — the entire codebase is plain HTML, CSS, and JavaScript with no minification or obfuscation.
