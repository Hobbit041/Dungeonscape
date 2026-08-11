/**
 * missingFilesDialog.js
 * Exports:
 *   checkMissingFiles(ss)  — scans a soundscape object for missing playlist files.
 *   MissingFilesDialog     — modal with a table + folder-search + apply.
 */
import { t } from './i18n.js';
import { makeDraggable } from './dragPanel.js';
import { SOUNDBOARD_SIZE, MIXER_SIZE } from './templates.js';

function _basename(p) { return p.split(/[\\/]/).pop(); }

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Check ───────────────────────────────────────────────────────────────────

/**
 * Scans the current working-copy of a soundscape for missing playlist files.
 * @param {object} ss  — soundscape data object (channels, ambient, soundboard)
 * @returns {Promise<MissingEntry[]>}
 *
 * MissingEntry: { path, filename, channelType, channelIdx, channelLabel, itemIdx, status, newPath }
 */
export async function checkMissingFiles(ss) {
  // 1. Collect all unique file paths
  const pathSet = new Set();
  const collect = (playlist) => {
    for (const item of (playlist ?? [])) {
      if (item?.path) pathSet.add(item.path);
    }
  };
  for (let i = 0; i < MIXER_SIZE;  i++) collect(ss.channels?.[i]?.soundData?.playlist);
  for (let i = 0; i < MIXER_SIZE;  i++) collect(ss.ambient?.[i]?.soundData?.playlist);
  for (let i = 0; i < SOUNDBOARD_SIZE; i++) collect(ss.soundboard?.[i]?.soundData?.playlist);

  if (pathSet.size === 0) return [];

  // 2. Batch-check existence
  const existMap = await window.api.fs.checkMany([...pathSet]);

  // 3. Build entries for missing paths only
  const entries = [];

  const addEntries = (playlist, channelType, channelIdx, channelLabel) => {
    const pl = playlist ?? [];
    for (let j = 0; j < pl.length; j++) {
      const item = pl[j];
      if (!item?.path) continue;
      if (existMap[item.path] === false) {
        entries.push({
          path:         item.path,
          filename:     _basename(item.path),
          channelType,
          channelIdx,
          channelLabel,
          itemIdx:      j,
          status:       'missing',
          newPath:      null
        });
      }
    }
  };

  for (let i = 0; i < MIXER_SIZE; i++) {
    const ch = ss.channels?.[i];
    addEntries(
      ch?.soundData?.playlist,
      'music', i,
      ch?.settings?.name || t('missingFiles.musicChannel', { n: i + 1 })
    );
  }
  for (let i = 0; i < MIXER_SIZE; i++) {
    const ch = ss.ambient?.[i];
    addEntries(
      ch?.soundData?.playlist,
      'ambient', i,
      ch?.settings?.name || t('missingFiles.ambientChannel', { n: i + 1 })
    );
  }
  for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
    addEntries(
      ss.soundboard?.[i]?.soundData?.playlist,
      'soundboard', i,
      t('missingFiles.soundboard')
    );
  }

  return entries;
}

// ─── Dialog ──────────────────────────────────────────────────────────────────

export class MissingFilesDialog {
  /**
   * @param {MissingEntry[]} entries
   * @param {{ onApply: (remap: Record<string,string>) => void }} opts
   */
  constructor(entries, { onApply }) {
    this._entries = entries.map(e => ({ ...e }));
    this._onApply = onApply;
  }

  open() {
    // Close any previous instance
    document.getElementById('missingFilesPanel')?.remove();
    document.getElementById('missingFilesOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'missingFilesOverlay';
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '9000';

    const panel = document.createElement('div');
    panel.id        = 'missingFilesPanel';
    panel.className = 'fx-panel mf-panel';
    panel.style.zIndex = '9001';

    panel.innerHTML = `
      <div class="fx-header settings-panel-header">
        <span>${t('missingFiles.title')}</span>
        <button class="fx-close" id="mfClose">✕</button>
      </div>
      <div class="mf-body">
        <div class="mf-scroll">
          <table class="mf-table">
            <thead>
              <tr>
                <th>${_esc(t('missingFiles.colFile'))}</th>
                <th>${_esc(t('missingFiles.colChannel'))}</th>
                <th>${_esc(t('missingFiles.colStatus'))}</th>
              </tr>
            </thead>
            <tbody id="mfTableBody"></tbody>
          </table>
        </div>
        <div class="mf-footer">
          <button class="settings-btn" id="mfSearchFolder">
            <i class="fas fa-folder-open"></i> ${_esc(t('missingFiles.searchFolder'))}
          </button>
          <button class="settings-btn" id="mfApply">
            <i class="fas fa-check"></i> ${_esc(t('missingFiles.apply'))}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    // Fill table first, then center — so offsetHeight is already final
    this._renderTable();

    panel.style.left = `${Math.round((window.innerWidth  - panel.offsetWidth)  / 2)}px`;
    panel.style.top  = `${Math.round((window.innerHeight - panel.offsetHeight) / 2)}px`;

    makeDraggable(panel, { ignoreSelector: '.fx-close' });

    document.getElementById('mfClose')
      ?.addEventListener('click', () => this._close());
    overlay.addEventListener('click', () => this._close());
    document.getElementById('mfSearchFolder')
      ?.addEventListener('click', () => this._searchFolder());
    document.getElementById('mfApply')
      ?.addEventListener('click', () => this._apply());
  }

  // ── Table ─────────────────────────────────────────────────────────────────

  _renderTable() {
    const tbody = document.getElementById('mfTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    for (const entry of this._entries) {
      const tr = document.createElement('tr');
      tr.className = entry.status === 'found' ? 'mf-row-found' : 'mf-row-missing';
      const statusHtml = entry.status === 'found'
        ? `<span class="mf-status-found">${_esc(t('missingFiles.statusFound'))}</span>`
        : `<span class="mf-status-missing">${_esc(t('missingFiles.statusMissing'))}</span>`;
      tr.innerHTML = `
        <td class="mf-col-file" title="${_esc(entry.newPath ?? entry.path)}">${_esc(entry.filename)}</td>
        <td class="mf-col-channel">${_esc(entry.channelLabel)}</td>
        <td class="mf-col-status">${statusHtml}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // ── Folder search ─────────────────────────────────────────────────────────

  async _searchFolder() {
    const paths = await window.api.fs.openDialog({ folder: true });
    if (!paths?.[0]) return;

    const missingNames = [...new Set(
      this._entries.filter(e => e.status === 'missing').map(e => e.filename)
    )];
    if (!missingNames.length) return;

    const found = await window.api.fs.findInFolder(paths[0], missingNames);

    let anyFound = false;
    for (const entry of this._entries) {
      if (entry.status === 'missing' && entry.filename in found) {
        entry.newPath = found[entry.filename];
        entry.status  = 'found';
        anyFound = true;
      }
    }

    if (anyFound) this._renderTable();
  }

  // ── Apply ─────────────────────────────────────────────────────────────────

  _apply() {
    const remap = {};
    for (const entry of this._entries) {
      if (entry.status === 'found' && entry.newPath) {
        remap[entry.path] = entry.newPath;
      }
    }
    this._onApply(remap);
    this._close();
  }

  _close() {
    document.getElementById('missingFilesPanel')?.remove();
    document.getElementById('missingFilesOverlay')?.remove();
  }
}
