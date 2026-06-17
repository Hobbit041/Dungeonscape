/**
 * playlistDialog.js
 * Playlist editor — shared by channel config and soundboard config.
 *
 * Usage:
 *   new PlaylistDialog({
 *     title:         'Плейлист — CH 1',
 *     panelId:       'ch-0',
 *     getSoundData:  async () => soundData,
 *     saveSoundData: async (data) => { ... },
 *     getChannel:    () => liveChannelObject,
 *     mode:          'channel' | 'soundboard' | 'ambient'   (default: 'channel')
 *   }).open();
 */
import { t }                      from './i18n.js';
import { MissingFilesRegistry } from './missingFilesRegistry.js';
import { pathToUrl }              from './pathUtils.js';
import { makeDraggable }         from './dragPanel.js';
import { showConfirm }           from './dialog.js';

const AUDIO_EXT = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'webm']);

/** Convert a list of File objects (from drop) into playlist items. */
export async function filesToPlaylistItems(files) {
  const items = [];
  for (const file of files) {
    const path = file.path ?? file;
    const ext  = path.split('.').pop().toLowerCase();
    if (AUDIO_EXT.has(ext)) {
      items.push({ path, label: path.split(/[\\/]/).pop() });
    } else {
      const folderFiles = await window.api.fs.readFolder(path);
      if (folderFiles.length) {
        const folderName = path.split(/[\\/]/).pop();
        for (const fp of folderFiles) {
          items.push({ path: fp, label: `/${folderName}/${fp.split(/[\\/]/).pop()}` });
        }
      }
    }
  }
  _sortAlphaItems(items);
  return items;
}

function _sortAlphaItems(arr) {
  arr.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
}

// ─────────────────────────────────────────────────────────────────────────────

export class PlaylistDialog {
  constructor({ title, panelId, getSoundData, saveSoundData, getChannel, mode, onClear, isAllScenes, onAllScenesToggle }) {
    this.title         = title;
    this.panelId       = panelId;
    this.getSoundData  = getSoundData;
    this.saveSoundData = saveSoundData;
    this.getChannel    = getChannel;
    this._mode         = mode ?? 'channel';
    this._onClear      = onClear ?? null;
    this._isAllScenes       = isAllScenes ?? false;
    this._onAllScenesToggle = onAllScenesToggle ?? null;
    this.playlist      = [];   // [{ path, label }] — includes folderLink items in memory
    this.folderLinks   = [];   // ['/folder/path', ...]
    this.shuffle       = false;
    this.sequential    = false;
    this.autoPlay      = false;
    this.selectedSet   = new Set();  // indices of selected rows
    this._anchorIdx    = -1;         // anchor for shift-click range
    this._dragSrcIdx   = null;
    this._playingInterval = null;
  }

  async open() {
    const pid = `plPanel-${this.panelId}`;
    const existing = document.getElementById(pid);
    if (existing) { existing.remove(); return; }

    const soundData   = await this.getSoundData();
    this.folderLinks  = soundData?.folderLinks ?? [];
    this.playlist     = await this._loadPlaylist(soundData);
    this.shuffle      = soundData?.shuffle ?? false;
    this.sequential   = soundData?.sequential ?? false;
    this.autoPlay     = soundData?.autoPlay ?? false;
    this.selectedSet  = new Set();
    this._anchorIdx   = -1;

    if (this.shuffle) {
      const ch = this.getChannel?.();
      if (ch?.sourceArray?.length) {
        this.playlist.sort((a, b) =>
          ch.sourceArray.indexOf(pathToUrl(a.path)) -
          ch.sourceArray.indexOf(pathToUrl(b.path))
        );
      }
    }

    const panel = document.createElement('div');
    panel.id        = pid;
    panel.className = 'fx-panel pl-panel';
    panel.innerHTML = `
      <div class="fx-header">
        <span>${this.title}</span>
        <div style="display:flex;gap:4px;align-items:center">
          ${this._onClear ? `<button class="cfg-reset-btn" id="plClear-${this.panelId}" title="${t('playlist.clearTitle')}">🗑</button>` : ''}
          <button class="fx-close" id="plClose-${this.panelId}">✕</button>
        </div>
      </div>
      <div class="pl-list-wrap" id="plListWrap-${this.panelId}">
        <div class="pl-list" id="plList-${this.panelId}"></div>
        <div class="pl-empty" id="plEmpty-${this.panelId}">${t('playlist.empty')}</div>
      </div>
      <div class="pl-toolbar">
        <button class="pl-btn"         id="plUp-${this.panelId}"   title="${t('playlist.upTitle')}"     disabled>▲</button>
        <button class="pl-btn"         id="plDown-${this.panelId}" title="${t('playlist.downTitle')}"   disabled>▼</button>
        <button class="pl-btn pl-del"  id="plDel-${this.panelId}"  title="${t('playlist.deleteTitle')}" disabled>🗑</button>
        <button class="pl-btn pl-play" id="plPlay-${this.panelId}" title="${t('playlist.playTitle')}"   disabled>▶</button>
        ${this._mode === 'soundboard'
          ? `<label class="pl-shuffle">
               <input type="checkbox" id="plSequential-${this.panelId}" ${this.sequential ? 'checked' : ''}>
               ${t('playlist.sequential')}
             </label>`
          : this._mode === 'ambient'
          ? `<div class="pl-cb-rows">
               <div class="pl-cb-row">
                 <label class="pl-shuffle">
                   <input type="checkbox" id="plAllScenes-${this.panelId}" ${this._isAllScenes ? 'checked' : ''}>
                   ${t('playlist.allScenes')}
                 </label>
                 <label class="pl-shuffle">
                   <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
                   ${t('playlist.shuffle')}
                 </label>
               </div>
               <div class="pl-cb-row">
                 <label class="pl-shuffle">
                   <input type="checkbox" id="plAutoPlay-${this.panelId}" ${this.autoPlay ? 'checked' : ''} ${this._isAllScenes ? 'disabled' : ''}>
                   ${t('playlist.autoPlay')}
                 </label>
               </div>
             </div>
             <button class="pl-btn" id="plFolderLink-${this.panelId}" title="${t('playlist.folderLinkBtn')}">📁</button>
             <button class="pl-btn pl-folder-link-help-btn" id="plFolderLinkHelp-${this.panelId}">?</button>`
          : `<label class="pl-shuffle">
               <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
               ${t('playlist.shuffle')}
             </label>
             <button class="pl-btn" id="plFolderLink-${this.panelId}" title="${t('playlist.folderLinkBtn')}">📁</button>
             <button class="pl-btn pl-folder-link-help-btn" id="plFolderLinkHelp-${this.panelId}">?</button>`
        }
      </div>
    `;

    document.body.appendChild(panel);
    this._makeDraggable(panel);
    this._renderList();
    this._bindEvents();

    // Live highlight of the currently playing track
    this._playingInterval = setInterval(() => {
      if (!document.getElementById(`plPanel-${this.panelId}`)) {
        clearInterval(this._playingInterval);
        return;
      }
      this._updatePlayingHighlight();
    }, 800);
  }

  // ── Data ─────────────────────────────────────────────────────────────────────

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
      if (!soundData?.shuffle) _sortAlphaItems(items);
    }
    return items;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  _renderList() {
    const listEl  = document.getElementById(`plList-${this.panelId}`);
    const emptyEl = document.getElementById(`plEmpty-${this.panelId}`);
    if (!listEl) return;

    if (emptyEl) emptyEl.style.display = this.playlist.length ? 'none' : 'flex';
    listEl.innerHTML = '';

    this.playlist.forEach((item, idx) => {
      const isMissing = MissingFilesRegistry.has(item.path);
      const row = document.createElement('div');
      row.className   = 'pl-row'
        + (this.selectedSet.has(idx) ? ' pl-row-sel' : '')
        + (isMissing                 ? ' pl-row-missing' : '');
      row.dataset.idx = idx;
      row.draggable   = true;
      const linkIcon = item.folderLink
        ? `<span class="pl-folder-link-icon" title="${t('playlist.folderLinkTooltip')}">🔗</span>`
        : '';
      row.innerHTML   = `${linkIcon}<span class="pl-row-label" title="${item.path}">${item.label}</span>`;

      row.addEventListener('click',     (e) => this._select(idx, e.shiftKey));
      if (item.folderLink) {
        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          this._showContextMenu(e.clientX, e.clientY, item.folderLink);
        });
      }
      row.addEventListener('dragstart', e   => this._onRowDragStart(e, idx, row));
      row.addEventListener('dragend',   ()  => this._onRowDragEnd());
      row.addEventListener('dragover',  e   => this._onRowDragOver(e, idx, row));
      row.addEventListener('dragleave', ()  => row.classList.remove('pl-row-over'));
      row.addEventListener('drop',      e   => this._onRowDrop(e, idx));

      listEl.appendChild(row);
    });

    // Drop zone at end of list — allows reordering items to the very end
    if (this.playlist.length > 0) {
      const endZone = document.createElement('div');
      endZone.className = 'pl-end-zone';
      endZone.style.cssText = 'height:20px;width:100%';
      endZone.addEventListener('dragover', e => {
        if (this._dragSrcIdx === null) { e.preventDefault(); return; }
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.pl-row-over').forEach(el => el.classList.remove('pl-row-over'));
        endZone.classList.add('pl-row-over');
      });
      endZone.addEventListener('dragleave', () => endZone.classList.remove('pl-row-over'));
      endZone.addEventListener('drop', e => {
        endZone.classList.remove('pl-row-over');
        if (this._dragSrcIdx === null) { e.preventDefault(); return; }
        e.preventDefault();
        e.stopPropagation();
        const from = this._dragSrcIdx;
        this._dragSrcIdx = null;
        if (this.selectedSet.size > 1 && this.selectedSet.has(from)) {
          this._moveSelectedItems(this.playlist.length);
        } else {
          const trackedPath = this._trackedPlayingPath();
          const [item] = this.playlist.splice(from, 1);
          this.playlist.push(item);
          const newIdx = this.playlist.length - 1;
          this.selectedSet = new Set([newIdx]);
          this._anchorIdx = newIdx;
          if (this._mode !== 'soundboard') this.shuffle = true;
          this._save(trackedPath);
          this._renderList();
        }
      });
      listEl.appendChild(endZone);
    }

    this._updateToolbar();
    this._updatePlayingHighlight();
  }

  _updatePlayingHighlight() {
    const ch = this.getChannel?.();
    const playingIdx = ch?.currentlyPlaying ?? -1;
    const listEl = document.getElementById(`plList-${this.panelId}`);
    if (!listEl) return;
    listEl.querySelectorAll('.pl-row').forEach(row => {
      row.classList.toggle('pl-row-playing', parseInt(row.dataset.idx) === playingIdx);
    });
  }

  _select(idx, shiftHeld = false) {
    if (shiftHeld && this._anchorIdx >= 0) {
      // Extend selection from anchor to idx
      const min = Math.min(this._anchorIdx, idx);
      const max = Math.max(this._anchorIdx, idx);
      this.selectedSet.clear();
      for (let i = min; i <= max; i++) this.selectedSet.add(i);
    } else {
      // Toggle single item; update anchor
      if (this.selectedSet.size === 1 && this.selectedSet.has(idx)) {
        this.selectedSet.clear();
        this._anchorIdx = -1;
      } else {
        this.selectedSet.clear();
        this.selectedSet.add(idx);
        this._anchorIdx = idx;
      }
    }
    this._renderList();
  }

  _updateToolbar() {
    const ok     = this.selectedSet.size > 0;
    const minSel = ok ? Math.min(...this.selectedSet) : -1;
    const maxSel = ok ? Math.max(...this.selectedSet) : -1;
    const upBtn  = this._q(`plUp-${this.panelId}`);
    const dnBtn  = this._q(`plDown-${this.panelId}`);
    const delBtn = this._q(`plDel-${this.panelId}`);
    const playBtn = this._q(`plPlay-${this.panelId}`);
    const anyFolderLinks = ok && [...this.selectedSet].some(i => this.playlist[i]?.folderLink);
    if (upBtn)  upBtn.disabled  = !ok || minSel === 0;
    if (dnBtn)  dnBtn.disabled  = !ok || maxSel === this.playlist.length - 1;
    if (delBtn) delBtn.disabled = !ok || anyFolderLinks;
    if (playBtn) {
      const ch = this.getChannel?.();
      const playingIdx = ch?.currentlyPlaying ?? -1;
      const singleSel = this.selectedSet.size === 1 ? [...this.selectedSet][0] : -1;
      playBtn.disabled = !(singleSel >= 0 && singleSel !== playingIdx);
    }

    if (this._mode === 'soundboard') {
      const seq = this._q(`plSequential-${this.panelId}`);
      if (seq) seq.checked = this.sequential;
    } else {
      if (this._mode === 'ambient') {
        const ap = this._q(`plAutoPlay-${this.panelId}`);
        if (ap) ap.checked = this.autoPlay;
      }
      const sh = this._q(`plShuffle-${this.panelId}`);
      if (sh) sh.checked = this.shuffle;
    }
  }

  // ── Internal drag (reorder single row) ──────────────────────────────────────

  _onRowDragStart(e, idx, row) {
    this._dragSrcIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    row.classList.add('pl-row-drag');
  }

  _onRowDragEnd() {
    this._dragSrcIdx = null;
    document.querySelectorAll('.pl-row-drag, .pl-row-over')
      .forEach(el => el.classList.remove('pl-row-drag', 'pl-row-over'));
  }

  _onRowDragOver(e, idx, row) {
    // OS file drag — don't highlight row, let event bubble to wrap handler
    if (this._dragSrcIdx === null) { e.preventDefault(); return; }
    if (this._dragSrcIdx === idx) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.pl-row-over').forEach(el => el.classList.remove('pl-row-over'));
    row.classList.add('pl-row-over');
  }

  _onRowDrop(e, toIdx) {
    if (this._dragSrcIdx === null) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const from = this._dragSrcIdx;
    this._dragSrcIdx = null;
    if (this.selectedSet.size > 1 && this.selectedSet.has(from)) {
      this._moveSelectedItems(toIdx);
    } else {
      if (from === toIdx) return;
      this._moveItem(from, toIdx);
    }
  }

  // ── External drop (OS) ───────────────────────────────────────────────────────

  _bindExternalDrop(wrap) {
    wrap.addEventListener('dragover', e => {
      if (this._dragSrcIdx !== null) return;
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      wrap.classList.add('pl-wrap-over');
    });
    wrap.addEventListener('dragleave', e => {
      if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('pl-wrap-over');
    });
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
  }

  // ── Toolbar events ───────────────────────────────────────────────────────────

  _bindEvents() {
    const id = this.panelId;

    this._q(`plClose-${id}`)
      ?.addEventListener('click', () => document.getElementById(`plPanel-${id}`)?.remove());

    if (this._onClear) {
      this._q(`plClear-${id}`)?.addEventListener('click', async () => {
        if (!await showConfirm(t('playlist.clearConfirm'))) return;
        await this._onClear();
        document.dispatchEvent(new CustomEvent('playlist-changed', {
          detail: { panelId: this.panelId, playlist: [] }
        }));
        document.getElementById(`plPanel-${id}`)?.remove();
      });
    }

    this._q(`plUp-${id}`)?.addEventListener('click', () => this._moveSelectionUp());
    this._q(`plDown-${id}`)?.addEventListener('click', () => this._moveSelectionDown());

    this._q(`plDel-${id}`)?.addEventListener('click', () => {
      if (this.selectedSet.size === 0) return;
      // Delete all selected, working from highest index down
      const indices = [...this.selectedSet].sort((a, b) => b - a);
      for (const idx of indices) this.playlist.splice(idx, 1);
      this.selectedSet.clear();
      this._anchorIdx = -1;
      this._save();
      this._renderList();
    });

    this._q(`plPlay-${id}`)?.addEventListener('click', () => {
      if (this.selectedSet.size !== 1) return;
      const [selectedIdx] = this.selectedSet;
      const ch = this.getChannel?.();
      if (!ch) return;
      if (ch.playing) {
        ch._crossfadeTo(selectedIdx, 3000);
      } else {
        ch.next(selectedIdx);
        ch.play();
        document.dispatchEvent(new CustomEvent('channel-play-state-changed'));
      }
      this._updatePlayingHighlight();
      this._updateToolbar();
    });

    if (this._mode === 'soundboard') {
      this._q(`plSequential-${id}`)?.addEventListener('change', async e => {
        this.sequential = e.target.checked;
        await this._save();
      });
    } else {
      if (this._mode === 'ambient') {
        if (this._onAllScenesToggle) {
          this._q(`plAllScenes-${id}`)?.addEventListener('change', async (e) => {
            const checked = e.target.checked;
            const ok = await this._onAllScenesToggle(checked);
            if (!ok) {
              e.target.checked = !checked;
              return;
            }
            this._isAllScenes = checked;
            const ap = this._q(`plAutoPlay-${id}`);
            if (ap) ap.disabled = checked;
          });
        }
        this._q(`plAutoPlay-${id}`)?.addEventListener('change', async e => {
          this.autoPlay = e.target.checked;
          await this._save();
        });
      }
      this._q(`plShuffle-${id}`)?.addEventListener('change', async e => {
        this.shuffle = e.target.checked;
        const trackedPath = this._trackedPlayingPath();
        if (this.shuffle) {
          this._shuffleInPlace();
        } else {
          _sortAlphaItems(this.playlist);
          this.selectedSet.clear();
          this._anchorIdx = -1;
        }
        await this._save(trackedPath);
        this._renderList();
      });
    }

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

  // ── Mutations ────────────────────────────────────────────────────────────────

  /** Move the entire selection up by one position. */
  _moveSelectionUp() {
    if (this.selectedSet.size === 0) return;
    const indices = [...this.selectedSet].sort((a, b) => a - b);
    if (indices[0] === 0) return;
    const trackedPath = this._trackedPlayingPath();
    for (const idx of indices) {
      const [item] = this.playlist.splice(idx, 1);
      this.playlist.splice(idx - 1, 0, item);
    }
    this.selectedSet = new Set(indices.map(i => i - 1));
    if (this._anchorIdx >= 0) this._anchorIdx--;
    if (this._mode !== 'soundboard') this.shuffle = true;
    this._save(trackedPath);
    this._renderList();
  }

  /** Move the entire selection down by one position. */
  _moveSelectionDown() {
    if (this.selectedSet.size === 0) return;
    // Process from highest index to avoid displacement
    const indices = [...this.selectedSet].sort((a, b) => b - a);
    if (indices[0] === this.playlist.length - 1) return;
    const trackedPath = this._trackedPlayingPath();
    for (const idx of indices) {
      const [item] = this.playlist.splice(idx, 1);
      this.playlist.splice(idx + 1, 0, item);
    }
    this.selectedSet = new Set(indices.map(i => i + 1));
    if (this._anchorIdx >= 0) this._anchorIdx++;
    if (this._mode !== 'soundboard') this.shuffle = true;
    this._save(trackedPath);
    this._renderList();
  }

  /** Move a single dragged row (drag-and-drop reorder). */
  _moveItem(from, to) {
    const trackedPath = this._trackedPlayingPath();
    const [item] = this.playlist.splice(from, 1);
    const insertAt = Math.min(to, this.playlist.length);
    this.playlist.splice(insertAt, 0, item);
    this.selectedSet = new Set([insertAt]);
    this._anchorIdx  = insertAt;
    if (this._mode !== 'soundboard') this.shuffle = true;
    this._save(trackedPath);
    this._renderList();
  }

  /** Move all selected rows to toIdx, preserving their relative order. */
  _moveSelectedItems(toIdx) {
    const selected = [...this.selectedSet].sort((a, b) => a - b);
    const minSel = selected[0];
    const maxSel = selected[selected.length - 1];
    if (toIdx >= minSel && toIdx <= maxSel + 1) return;
    const trackedPath = this._trackedPlayingPath();
    const before = selected.filter(i => i < toIdx).length;
    const adjustedTo = toIdx - before;
    const items = selected.map(i => this.playlist[i]);
    for (const i of [...selected].reverse()) {
      this.playlist.splice(i, 1);
    }
    this.playlist.splice(adjustedTo, 0, ...items);
    this.selectedSet = new Set(Array.from({ length: items.length }, (_, i) => adjustedTo + i));
    this._anchorIdx = adjustedTo;
    if (this._mode !== 'soundboard') this.shuffle = true;
    this._save(trackedPath);
    this._renderList();
  }

  /** Returns the path of the currently playing track, or null. */
  _trackedPlayingPath() {
    const ch = this.getChannel?.();
    if (!ch) return null;
    return this.playlist[ch.currentlyPlaying]?.path ?? null;
  }

  _shuffleInPlace() {
    for (let i = this.playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.playlist[i], this.playlist[j]] = [this.playlist[j], this.playlist[i]];
    }
  }

  async _save(trackedPath = null) {
    const persistedPlaylist = this.playlist.filter(item => !item.folderLink);
    const soundData = { playlist: persistedPlaylist, folderLinks: this.folderLinks, shuffle: this.shuffle };
    if (this._mode === 'soundboard') soundData.sequential = this.sequential;
    if (this._mode === 'ambient')    soundData.autoPlay    = this.autoPlay;
    await this.saveSoundData(soundData);

    // Notify MixerUI so it can update missing-file highlights
    document.dispatchEvent(new CustomEvent('playlist-changed', {
      detail: { panelId: this.panelId, playlist: this.playlist }
    }));
    const ch = this.getChannel();
    if (ch) {
      ch.sourceArray = this.playlist.map(item => pathToUrl(item.path)).filter(Boolean);
      if (trackedPath != null) {
        // Keep currentlyPlaying pointing at the same track after reorder
        const newIdx = this.playlist.findIndex(item => item.path === trackedPath);
        ch.currentlyPlaying = newIdx >= 0 ? newIdx : 0;
      } else if (ch.currentlyPlaying >= ch.sourceArray.length) {
        ch.currentlyPlaying = 0;
      }
      // Keep live settings in sync so playSound() sees the latest sequential flag
      if (ch.settings) ch.settings.soundData = soundData;
      // Bootstrap audio when a previously empty regular channel now has content
      if (this._mode !== 'ambient' && this._mode !== 'soundboard' && !ch.loaded && ch.sourceArray.length > 0) {
        await ch.setSource(ch.sourceArray[ch.currentlyPlaying]);
      }
    }
  }

  // ── Utils ────────────────────────────────────────────────────────────────────

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

  async _removeFolderLink(folderPath) {
    this.folderLinks = this.folderLinks.filter(f => f !== folderPath);
    this.playlist = this.playlist.filter(item => item.folderLink !== folderPath);
    this.selectedSet.clear();
    this._anchorIdx = -1;
    await this._save();
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
    menuItem.addEventListener('click', async () => {
      menu.remove();
      await this._removeFolderLink(folderPath);
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

  _q(id)  { return document.getElementById(id); }

  _makeDraggable(el) { makeDraggable(el); }
}
