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
import { t, initI18n } from '../src/i18n.js';
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

/** Every entity this window maps is a soundboard button — always 'noteon' (see midi.js's own MIDI_ENTITIES table for the analogous main-grid case). */
function _fmtMapping(m) {
  if (!m || m.type !== 'noteon') return '';
  return t('midi.noteMapping', { note: m.note, channel: m.channel + 1 });
}

function _clearMappingControls() {
  document.querySelectorAll('.midi-map-wrap').forEach(el => el.remove());
}

function _renderMappingControls(indices, sceneId, mappings, sendMeta) {
  for (const i of indices) {
    const btn = document.getElementById(`sbButton-${i}`);
    if (!btn || btn.querySelector('.midi-map-wrap')) continue;
    const entityKey = `sb-detached-${sceneId}-${i}`;
    const mapped = !!mappings[entityKey];

    const wrap = document.createElement('span');
    wrap.className = 'midi-map-wrap';
    wrap.dataset.index = i;

    const chain = document.createElement('button');
    chain.className = 'midi-chain-btn' + (mapped ? ' midi-chain-mapped' : '');
    chain.title = mapped
      ? t('midi.mappingLabel', { mapping: _fmtMapping(mappings[entityKey]) })
      : t('midi.bindTitle');
    chain.textContent = '🔗';

    const trash = document.createElement('button');
    trash.className   = 'midi-trash-btn';
    trash.title       = t('midi.removeTitle');
    trash.textContent = '🗑';
    trash.disabled    = !mapped;

    wrap.appendChild(chain);
    wrap.appendChild(trash);
    btn.appendChild(wrap);

    chain.addEventListener('click', e => {
      e.stopPropagation();
      // Toggle off if this button is the one currently listening (mirrors
      // mixerUI.js's own _onChainClick) — otherwise there'd be no way to
      // cancel a stray listening state short of exiting mapping mode
      // entirely. The DOM class is the source of truth for "am I the one
      // listening" here since this window has no direct read access to the
      // real MidiController's _listeningFor.
      if (chain.classList.contains('midi-chain-listening')) {
        sendMeta('stopListening', { index: i });
      } else {
        chain.className = 'midi-chain-btn midi-chain-listening';
        sendMeta('startListening', { index: i });
      }
    });
    trash.addEventListener('click', e => {
      e.stopPropagation();
      sendMeta('clearMapping', { index: i });
    });
  }
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
    await initI18n();

    const { key, sceneId, cols, rows, buttons = [], mappingMode: initialMappingMode, mappings: initialMappings } = data;

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
    let mappings = initialMappings ?? {};

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
      } else if (payload.kind === 'mappingMode') {
        mappings = payload.mappings ?? {};
        if (payload.on) _renderMappingControls(indices, sceneId, mappings, sendMeta);
        else _clearMappingControls();
      } else if (payload.kind === 'mappingCaptured') {
        mappings[`sb-detached-${sceneId}-${payload.index}`] = payload.data;
        const wrap = document.querySelector(`.midi-map-wrap[data-index="${payload.index}"]`);
        const chain = wrap?.querySelector('.midi-chain-btn');
        if (chain) {
          chain.className = 'midi-chain-btn midi-chain-mapped';
          chain.title = t('midi.mappingLabel', { mapping: _fmtMapping(payload.data) });
        }
        const trash = wrap?.querySelector('.midi-trash-btn');
        if (trash) trash.disabled = false;
      } else if (payload.kind === 'listeningStop') {
        if (!payload.mapped) delete mappings[`sb-detached-${sceneId}-${payload.index}`];
        const wrap = document.querySelector(`.midi-map-wrap[data-index="${payload.index}"]`);
        const chain = wrap?.querySelector('.midi-chain-btn');
        if (chain) chain.className = 'midi-chain-btn' + (payload.mapped ? ' midi-chain-mapped' : '');
        const trash = wrap?.querySelector('.midi-trash-btn');
        if (trash) trash.disabled = !payload.mapped;
      }
    });

    // Binding mode may already be on when this window opens — render
    // controls immediately from the state that arrived via `data`, rather
    // than waiting for a later 'mappingMode' push that would only ever
    // arrive from a *subsequent* toggle. `onPush` above still handles that
    // subsequent-toggle case fine on its own, since by then this window is
    // fully loaded and listening.
    if (initialMappingMode) _renderMappingControls(indices, sceneId, mappings, sendMeta);
  } catch (err) {
    console.error('[soundboardScene-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
