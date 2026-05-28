# Folder Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add folder-link entries to the playback queue so that dragging a folder with Ctrl (or clicking the new toolbar button) stores a folder path that is rescanned on every playlist open.

**Architecture:** `soundData.folderLinks` (string array) is the source of truth. On each `open()`, folders are scanned via the existing `window.api.fs.readFolder` IPC and their files are injected into the in-memory `playlist` as items tagged with `{ folderLink: '/path' }`. Tagged items are stripped before persisting, so only the paths array is saved. All changes are confined to `playlistDialog.js` (logic + HTML) and `style.css` (new CSS classes).

**Tech Stack:** Vanilla JS ES modules, Electron IPC (existing), CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-05-28-folder-links-design.md`

---

### Task 1: Add translation keys

**Files:**
- Modify: `translations/ru.json` — `playlist` section

- [ ] **Step 1: Add 5 keys to the `playlist` section**

Open `translations/ru.json`. At the end of the `"playlist"` block (currently ends with `"shuffle": "Перемешать"`), add:

```json
    "shuffle": "Перемешать",
    "folderLinkBtn": "Добавить ссылку на папку",
    "folderLinkHelp": "Вы можете добавлять не отдельные файлы и папки, а ссылки на папки. В таком случае при добавлении ссылки, переоткрытии списка воспроизведения или при перезапуске приложения, в очередь воспроизведения будут добавлены все файлы, которые на данный момент находятся в этой папке",
    "folderLinkTooltip": "Этот файл автоматически загружен из папки",
    "folderLinkRemove": "Удалить ссылку на эту папку",
    "folderLinkDuplicate": "Ссылка на эту папку уже добавлена"
```

- [ ] **Step 2: Verify JSON is valid**

Run:
```powershell
node -e "JSON.parse(require('fs').readFileSync('translations/ru.json','utf8')); console.log('OK')"
```
Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add translations/ru.json
git commit -m "feat: add folder-links translation keys"
```

---

### Task 2: Extend data model — constructor, `open()`, `_loadPlaylist()`, `_save()`

**Files:**
- Modify: `renderer/src/playlistDialog.js` — lines 52–68 (constructor), 70–137 (open), 141–149 (_loadPlaylist), 494–517 (_save)

- [ ] **Step 1: Add `this.folderLinks = []` to the constructor**

In `renderer/src/playlistDialog.js`, find the constructor body (around line 60, after `this.playlist = []`):

```js
    this.playlist      = [];   // [{ path, label }]
```

Replace with:

```js
    this.playlist      = [];   // [{ path, label }] — includes folderLink items in memory
    this.folderLinks   = [];   // ['/folder/path', ...]
```

- [ ] **Step 2: Load `folderLinks` and make `_loadPlaylist` async in `open()`**

Find (around line 75–77):
```js
    const soundData   = await this.getSoundData();
    this.playlist     = this._loadPlaylist(soundData);
    this.shuffle      = soundData?.shuffle ?? false;
```

Replace with:
```js
    const soundData   = await this.getSoundData();
    this.folderLinks  = soundData?.folderLinks ?? [];
    this.playlist     = await this._loadPlaylist(soundData);
    this.shuffle      = soundData?.shuffle ?? false;
```

- [ ] **Step 3: Make `_loadPlaylist` async and expand folder links**

Find the entire `_loadPlaylist` method (lines 141–149):
```js
  _loadPlaylist(soundData) {
    if (!soundData) return [];
    if (Array.isArray(soundData.playlist)) return soundData.playlist.map(i => ({ ...i }));
    // Legacy: single file
    if (soundData.soundSelect === 'filepicker_single' && soundData.source) {
      return [{ path: soundData.source, label: soundData.source.split(/[\\/]/).pop() }];
    }
    return [];
  }
```

Replace with:
```js
  async _loadPlaylist(soundData) {
    if (!soundData) return [];
    let items = [];
    if (Array.isArray(soundData.playlist)) {
      items = soundData.playlist.map(i => ({ ...i }));
    } else if (soundData.soundSelect === 'filepicker_single' && soundData.source) {
      items = [{ path: soundData.source, label: soundData.source.split(/[\\/]/).pop() }];
    }
    if (this.folderLinks.length) {
      const linkItems = await this._loadFolderLinks(this.folderLinks);
      items.push(...linkItems);
      _sortAlphaItems(items);
    }
    return items;
  }
```

- [ ] **Step 4: Filter folder-link items before persisting in `_save()`**

Find the start of `_save` (around line 494):
```js
  async _save(trackedPath = null) {
    const soundData = { playlist: this.playlist, shuffle: this.shuffle };
```

Replace with:
```js
  async _save(trackedPath = null) {
    const persistedPlaylist = this.playlist.filter(item => !item.folderLink);
    const soundData = { playlist: persistedPlaylist, folderLinks: this.folderLinks, shuffle: this.shuffle };
```

- [ ] **Step 5: Verify the app starts without errors**

Run `npm start`. Open a channel's playlist dialog. Console should show no errors. Existing playlists should load and play normally.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/playlistDialog.js
git commit -m "feat: extend playlist data model for folder links"
```

---

### Task 3: Core folder-link methods

**Files:**
- Modify: `renderer/src/playlistDialog.js` — add three methods in the `// ── Utils` section

- [ ] **Step 1: Add `_loadFolderLinks`**

Find the `// ── Utils` section at the bottom of the file (around line 519):
```js
  // ── Utils ────────────────────────────────────────────────────────────────────

  _q(id)  { return document.getElementById(id); }
```

Insert before `_q`:
```js
  async _loadFolderLinks(folderPaths) {
    const items = [];
    for (const folderPath of folderPaths) {
      const files = await window.api.fs.readFolder(folderPath);
      for (const fp of files) {
        items.push({
          path: fp,
          label: fp.split(/[\\/]/).pop(),
          folderLink: folderPath,
        });
      }
    }
    _sortAlphaItems(items);
    return items;
  }

  async _addFolderLink(folderPath) {
    if (this.folderLinks.includes(folderPath)) {
      alert(t('playlist.folderLinkDuplicate'));
      return;
    }
    this.folderLinks.push(folderPath);
    const newItems = await this._loadFolderLinks([folderPath]);
    this.playlist.push(...newItems);
    if (!this.shuffle) _sortAlphaItems(this.playlist);
    await this._save();
    this._renderList();
  }

  _removeFolderLink(folderPath) {
    this.folderLinks = this.folderLinks.filter(f => f !== folderPath);
    this.playlist = this.playlist.filter(item => item.folderLink !== folderPath);
    this.selectedSet.clear();
    this._anchorIdx = -1;
    this._save();
    this._renderList();
  }

  _toggleFolderLinkHelp() {
    const existing = document.getElementById(`plFolderLinkPopup-${this.panelId}`);
    if (existing) { existing.remove(); return; }
    const popup = document.createElement('div');
    popup.id = `plFolderLinkPopup-${this.panelId}`;
    popup.className = 'pl-folder-link-popup';
    popup.textContent = t('playlist.folderLinkHelp');
    const panel = document.getElementById(`plPanel-${this.panelId}`);
    const toolbar = panel?.querySelector('.pl-toolbar');
    toolbar?.insertAdjacentElement('afterend', popup);
  }

  _showContextMenu(x, y, folderPath) {
    document.querySelectorAll('.pl-context-menu').forEach(el => el.remove());
    const menu = document.createElement('div');
    menu.className = 'pl-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
    const menuItem = document.createElement('div');
    menuItem.className = 'pl-context-menu-item';
    menuItem.textContent = t('playlist.folderLinkRemove');
    menuItem.addEventListener('click', () => {
      menu.remove();
      this._removeFolderLink(folderPath);
    });
    menu.appendChild(menuItem);
    document.body.appendChild(menu);
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

```

- [ ] **Step 2: Run the app, verify no errors**

Run `npm start`. Console should be clean. Playlist dialogs open normally.

- [ ] **Step 3: Commit**

```bash
git add renderer/src/playlistDialog.js
git commit -m "feat: add folder-link core methods"
```

---

### Task 4: CSS for new UI elements

**Files:**
- Modify: `renderer/style.css` — after line 631 (`.pl-shuffle input` rule)

- [ ] **Step 1: Add CSS rules**

Find the line (around 631):
```css
.pl-shuffle input { cursor: pointer; accent-color: var(--accent); }
```

Insert after it:
```css

.pl-folder-link-icon {
  font-size: 11px;
  margin-right: 4px;
  cursor: default;
  flex-shrink: 0;
}

.pl-folder-link-popup {
  margin: 0 12px 8px;
  padding: 8px 10px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.5;
}

.pl-folder-link-help-btn {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  padding: 0;
  font-size: 11px;
  min-width: unset;
  line-height: 1;
}

.pl-context-menu {
  position: fixed;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 200px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  z-index: 9999;
}

.pl-context-menu-item {
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}

.pl-context-menu-item:hover {
  background: var(--accent-dim);
  color: var(--accent);
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/style.css
git commit -m "feat: add CSS for folder-link UI elements"
```

---

### Task 5: Toolbar buttons + event bindings

**Files:**
- Modify: `renderer/src/playlistDialog.js` — toolbar HTML in `open()` (lines 102–121) and `_bindEvents()` (lines 348–407)

- [ ] **Step 1: Add folder + help buttons to toolbar HTML**

In `open()`, find the toolbar template section (lines 102–121):

```js
        ${this._mode === 'soundboard'
          ? `<label class="pl-shuffle">
               <input type="checkbox" id="plSequential-${this.panelId}" ${this.sequential ? 'checked' : ''}>
               ${t('playlist.sequential')}
             </label>`
          : this._mode === 'ambient'
          ? `<label class="pl-shuffle">
               <input type="checkbox" id="plAutoPlay-${this.panelId}" ${this.autoPlay ? 'checked' : ''}>
               ${t('playlist.autoPlay')}
             </label>
             <label class="pl-shuffle">
               <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
               ${t('playlist.shuffle')}
             </label>`
          : `<label class="pl-shuffle">
               <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
               ${t('playlist.shuffle')}
             </label>`
        }
```

Replace with:

```js
        ${this._mode === 'soundboard'
          ? `<label class="pl-shuffle">
               <input type="checkbox" id="plSequential-${this.panelId}" ${this.sequential ? 'checked' : ''}>
               ${t('playlist.sequential')}
             </label>`
          : this._mode === 'ambient'
          ? `<label class="pl-shuffle">
               <input type="checkbox" id="plAutoPlay-${this.panelId}" ${this.autoPlay ? 'checked' : ''}>
               ${t('playlist.autoPlay')}
             </label>
             <label class="pl-shuffle">
               <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
               ${t('playlist.shuffle')}
             </label>
             <button class="pl-btn" id="plFolderLink-${this.panelId}" title="${t('playlist.folderLinkBtn')}">📁</button>
             <button class="pl-btn pl-folder-link-help-btn" id="plFolderLinkHelp-${this.panelId}">?</button>`
          : `<label class="pl-shuffle">
               <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
               ${t('playlist.shuffle')}
             </label>
             <button class="pl-btn" id="plFolderLink-${this.panelId}" title="${t('playlist.folderLinkBtn')}">📁</button>
             <button class="pl-btn pl-folder-link-help-btn" id="plFolderLinkHelp-${this.panelId}">?</button>`
        }
```

- [ ] **Step 2: Wire up button events in `_bindEvents()`**

Find the end of `_bindEvents()`, just before the closing of the method (around line 405–407):

```js
    const wrap = document.getElementById(`plListWrap-${id}`);
    if (wrap) this._bindExternalDrop(wrap);
  }
```

Replace with:

```js
    if (this._mode !== 'soundboard') {
      this._q(`plFolderLink-${id}`)?.addEventListener('click', async () => {
        const paths = await window.api.fs.openDialog({ folder: true });
        if (!paths?.length) return;
        await this._addFolderLink(paths[0]);
      });
      this._q(`plFolderLinkHelp-${id}`)?.addEventListener('click', () => {
        this._toggleFolderLinkHelp();
      });
    }

    const wrap = document.getElementById(`plListWrap-${id}`);
    if (wrap) this._bindExternalDrop(wrap);
  }
```

- [ ] **Step 3: Run the app, verify buttons appear**

Run `npm start`. Open a channel playlist dialog. You should see a 📁 button and a round `?` button next to the Shuffle checkbox. Clicking `?` should show/hide the help text. Clicking 📁 should open a folder picker dialog; selecting a folder should populate the playlist with its audio files, marked with 📎 (this will be visible after Task 6).

- [ ] **Step 4: Commit**

```bash
git add renderer/src/playlistDialog.js
git commit -m "feat: add folder-link toolbar buttons and event bindings"
```

---

### Task 6: Row rendering — 📎 icon and right-click context menu

**Files:**
- Modify: `renderer/src/playlistDialog.js` — `_renderList()` method (lines 153–220)

- [ ] **Step 1: Add 📎 icon and context menu to folder-link rows**

In `_renderList()`, find the row `innerHTML` assignment (around line 168–169):

```js
      row.innerHTML   = `<span class="pl-row-label" title="${item.path}">${item.label}</span>`;
```

Replace with:

```js
      const linkIcon = item.folderLink
        ? `<span class="pl-folder-link-icon" title="${t('playlist.folderLinkTooltip')}">📎</span>`
        : '';
      row.innerHTML   = `${linkIcon}<span class="pl-row-label" title="${item.path}">${item.label}</span>`;
```

- [ ] **Step 2: Add context menu listener for folder-link rows**

In `_renderList()`, find where event listeners are added to `row` (around lines 171–176):

```js
      row.addEventListener('click',     (e) => this._select(idx, e.shiftKey));
      row.addEventListener('dragstart', e   => this._onRowDragStart(e, idx, row));
```

Add after the `click` listener:

```js
      row.addEventListener('click',     (e) => this._select(idx, e.shiftKey));
      if (item.folderLink) {
        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          this._showContextMenu(e.clientX, e.clientY, item.folderLink);
        });
      }
      row.addEventListener('dragstart', e   => this._onRowDragStart(e, idx, row));
```

- [ ] **Step 3: Run the app and verify**

Run `npm start`.
1. Open a playlist, click 📁, select a folder with audio files → files appear with 📎 icons.
2. Hover over 📎 → tooltip «Этот файл автоматически загружен из папки».
3. Right-click a 📎 row → context menu appears with «Удалить ссылку на эту папку».
4. Click that item → all files from the folder disappear.
5. Close and reopen the playlist → files reappear (folder link persisted).

- [ ] **Step 4: Commit**

```bash
git add renderer/src/playlistDialog.js
git commit -m "feat: render folder-link icon and right-click context menu"
```

---

### Task 7: Ctrl+drag and Up/Down toolbar fix

**Files:**
- Modify: `renderer/src/playlistDialog.js` — `_bindExternalDrop()` (lines 322–344) and `_updateToolbar()` (lines 253–275)

- [ ] **Step 1: Handle Ctrl+drag in `_bindExternalDrop()`**

Find the drop handler in `_bindExternalDrop()` (around lines 332–344):

```js
    wrap.addEventListener('drop', async e => {
      if (this._dragSrcIdx !== null) return;
      e.preventDefault();
      wrap.classList.remove('pl-wrap-over');
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      const newItems = await filesToPlaylistItems(files);
      this.playlist.push(...newItems);
      if (this._mode === 'soundboard' || !this.shuffle) _sortAlphaItems(this.playlist);
      await this._save();
      this._renderList();
    });
```

Replace with:

```js
    wrap.addEventListener('drop', async e => {
      if (this._dragSrcIdx !== null) return;
      e.preventDefault();
      wrap.classList.remove('pl-wrap-over');
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      if (e.ctrlKey) {
        for (const file of files) {
          const filePath = file.path ?? file;
          const ext = filePath.split('.').pop().toLowerCase();
          if (!AUDIO_EXT.has(ext)) await this._addFolderLink(filePath);
        }
        return;
      }
      const newItems = await filesToPlaylistItems(files);
      this.playlist.push(...newItems);
      if (this._mode === 'soundboard' || !this.shuffle) _sortAlphaItems(this.playlist);
      await this._save();
      this._renderList();
    });
```

- [ ] **Step 2: Disable Up/Down when all selected items are folder-link items**

In `_updateToolbar()`, find (around lines 260–262):

```js
    if (upBtn)  upBtn.disabled  = !ok || minSel === 0;
    if (dnBtn)  dnBtn.disabled  = !ok || maxSel === this.playlist.length - 1;
```

Replace with:

```js
    const allFolderLinks = ok && [...this.selectedSet].every(i => this.playlist[i]?.folderLink);
    if (upBtn)  upBtn.disabled  = !ok || minSel === 0 || allFolderLinks;
    if (dnBtn)  dnBtn.disabled  = !ok || maxSel === this.playlist.length - 1 || allFolderLinks;
```

- [ ] **Step 3: Run the app and verify**

Run `npm start`.
1. Hold Ctrl and drag a folder onto the playlist area → folder is added as a link (files appear with 📎), NOT expanded inline.
2. Click a 📎 row → Up and Down toolbar buttons are disabled.
3. Click a regular row → Up and Down are enabled normally.

- [ ] **Step 4: Commit**

```bash
git add renderer/src/playlistDialog.js
git commit -m "feat: ctrl+drag adds folder link; disable up/down for link items"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Drag folder + Ctrl → `_bindExternalDrop` Ctrl branch (Task 7)
- ✅ Toolbar 📁 button → Task 5
- ✅ Toolbar `?` help button + popup → Task 5 (`_toggleFolderLinkHelp`)
- ✅ Rescan on playlist open → `_loadPlaylist` calls `_loadFolderLinks` (Task 2)
- ✅ Rescan on app restart → same path (soundData is loaded fresh each time)
- ✅ 📎 icon in rows → Task 6
- ✅ 📎 tooltip → Task 6
- ✅ Right-click → «Удалить ссылку на эту папку» → Task 6
- ✅ Remove clears all related rows + the folderLinks entry → `_removeFolderLink` (Task 3)
- ✅ Duplicate warning → `_addFolderLink` alert (Task 3)
- ✅ Delete button on 📎 row removes from session, comes back on reopen → no special handling needed (folderLinks unchanged; Task 2 load path re-expands)
- ✅ Shuffle mixes folder-link files with regular files → they live in the same `this.playlist` array
- ✅ Up/Down disabled for link items → Task 7
- ✅ Translation keys → Task 1
- ✅ No changes to main.js / preload.js / channel.js / storage.js

**Type/name consistency:**
- `folderLink` property (string | undefined) used consistently across all tasks ✅
- `_loadFolderLinks`, `_addFolderLink`, `_removeFolderLink`, `_toggleFolderLinkHelp`, `_showContextMenu` — referenced in bind events and render, all defined in Task 3 ✅
- `t('playlist.folderLinkBtn/Help/Tooltip/Remove/Duplicate')` — all defined in Task 1 ✅
- `AUDIO_EXT` — used in Task 7 Ctrl+drag check; already defined at module top (line 21) ✅
