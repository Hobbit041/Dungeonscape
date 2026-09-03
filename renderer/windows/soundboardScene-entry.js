/**
 * soundboardScene-entry.js — bootstrap for a detached soundboard scene
 * window. Shows only that scene's button grid — no master fader, no
 * stop-all, no scene tabs. Audio plays from a second, parallel Soundboard
 * instance living in the MAIN window's renderer (see mixerUI.js's
 * onSoundboardSceneDetached); this window is a thin RPC view, reusing the
 * exact same {kind:'call'|'meta'} shape every other detached dialog in this
 * project already sends (see renderer/src/channelConfigBridge.js).
 *
 * Drag-and-drop here only supports the 'overwrite' behavior — 'next'/
 * 'append' would need to read the parallel instance's live sourceArray/
 * currentlyPlaying before merging, which no bridge in this project supports
 * (deliberately deferred).
 */
import { visibleIndices } from '../src/sbGrid.js';
import { filesToPlaylistItems } from '../src/playlistDialog.js';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif']);

/** Convert a local file path to a file:// URL for use in <img src>. */
function _fileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|blob:)/i.test(p)) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

/** Extract a display name from a playlist item label (mirrors mixerUI.js's own helper). */
function _nameFromLabel(label) {
  if (!label) return '';
  if (label.startsWith('/')) return label.split('/')[1] ?? '';
  return label.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

function _buildGrid(cols, rows, buttons) {
  const grid = document.getElementById('soundboard-grid');
  grid.style.setProperty('--sb-cols', cols);
  grid.style.setProperty('--sb-rows', rows);
  const indices = visibleIndices(cols, rows);

  let html = '';
  for (const i of indices) {
    html += `<div class="sb-cell" id="sbButton-${i}">` +
            `<div class="sb-img-wrap"><img id="sbImg-${i}" src="" alt=""></div>` +
            `<div class="sb-label" id="sbLabel-${i}"></div></div>`;
  }
  grid.innerHTML = html;

  for (const i of indices) {
    const b = buttons[i];
    document.getElementById(`sbLabel-${i}`).textContent = b?.name ?? '';
    if (b?.imageSrc) document.getElementById(`sbImg-${i}`).src = _fileUrl(b.imageSrc);
  }
  return indices;
}

window.api.childWindow.onInit(async (data = {}) => {
  try {
    const { key, cols, rows, buttons = [] } = data;

    const sendCall = (method, ...args)    => window.api.childWindow.send(key, { kind: 'call', method, args });
    const sendMeta = (type, payload = {}) => window.api.childWindow.send(key, { kind: 'meta', type, ...payload });

    const indices = _buildGrid(cols, rows, buttons);

    for (const i of indices) {
      const btn = document.getElementById(`sbButton-${i}`);

      // Left click = play
      btn.addEventListener('click', () => {
        sendCall('playSound', i);
        btn.classList.add('sb-flash');
        setTimeout(() => btn.classList.remove('sb-flash'), 200);
        btn.style.borderColor = 'yellow';
        btn.style.boxShadow   = '0 0 8px yellow';
      });

      // Right click = open this button's config dialog (in the main window's process)
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        sendMeta('openConfig', { index: i });
      });

      // Drag-and-drop — overwrite only (see file header)
      btn.addEventListener('dragover', e => { e.preventDefault(); btn.classList.add('drag-over'); });
      btn.addEventListener('dragleave', (e) => { if (!btn.contains(e.relatedTarget)) btn.classList.remove('drag-over'); });
      btn.addEventListener('drop', async (e) => {
        e.preventDefault();
        btn.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;

        const firstPath = files[0].path;
        const ext = (firstPath ?? files[0].name).split('.').pop().toLowerCase();

        if (IMAGE_EXT.has(ext)) {
          sendCall('newData', i, { type: 'image', source: firstPath });
          document.getElementById(`sbImg-${i}`).src = _fileUrl(firstPath);
        } else {
          const newItems = await filesToPlaylistItems(files);
          if (!newItems.length) return;
          const name = _nameFromLabel(newItems[0]?.label);
          sendCall('newData', i, { type: 'playlist', playlist: newItems, name });
          if (name) document.getElementById(`sbLabel-${i}`).textContent = name;
        }
      });
    }

    // Live updates pushed from the main window: playback started/stopped
    // (see mixerUI.js's onSoundboardSceneDetached), or this button's image/
    // name changed via its config dialog (see mixerUI.js's
    // _openDetachedSoundboardConfig).
    window.api.childWindow.onPush((payload) => {
      if (payload.kind === 'sbState') {
        const btn = document.getElementById(`sbButton-${payload.index}`);
        if (!btn) return;
        btn.style.borderColor = payload.playing ? 'yellow' : '';
        btn.style.boxShadow   = payload.playing ? '0 0 8px yellow' : '';
      } else if (payload.kind === 'imageChanged') {
        const img = document.getElementById(`sbImg-${payload.index}`);
        if (img) img.src = _fileUrl(payload.src);
      } else if (payload.kind === 'nameChanged') {
        const label = document.getElementById(`sbLabel-${payload.index}`);
        if (label) label.textContent = payload.name;
      }
    });
  } catch (err) {
    console.error('[soundboardScene-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
