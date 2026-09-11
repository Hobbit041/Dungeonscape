// web-client/src/soundboardPanel.js
/**
 * soundboardPanel.js — builds and binds the 49-slot soundboard grid + its
 * scene tabs. Mirrors renderer/src/mixerUI.js's own _buildSbCells() and
 * the visibility model documented in renderer/src/sbGrid.js (slot i is
 * visible iff i % 7 < cols && floor(i/7) < rows) — the formula is small
 * enough to duplicate here rather than serving renderer/src/sbGrid.js
 * over HTTP.
 */

import { bindSceneTabDrag } from './mixerPanel.js';
const SOUNDBOARD_SIZE = 49; // must match renderer/src/templates.js's SOUNDBOARD_SIZE
const SB_GRID_MAX = 7;
const SB_GAP = 6; // px — must match #soundboard-grid's `gap` in renderer/style.css

let _lastGrid = { cols: 5, rows: 5 }; // kept in sync by renderSoundboardPanel; read when the container resizes

function _isVisible(i, cols, rows) {
  return (i % SB_GRID_MAX) < cols && Math.floor(i / SB_GRID_MAX) < rows;
}

/**
 * Pure "largest square that fits" math, shared with detached soundboard
 * scene panels (see detachedSoundboardScenePanel.js) so both compute cell
 * size identically instead of maintaining two copies of this formula.
 */
export function computeSquareCellSize({ cols, rows, availableWidth, availableHeight, gap = SB_GAP }) {
  const cellFromWidth  = (availableWidth  - (cols - 1) * gap) / cols;
  const cellFromHeight = (availableHeight - (rows - 1) * gap) / rows;
  return Math.max(0, Math.min(cellFromWidth, cellFromHeight));
}

function _applyCellSize() {
  const outer = document.getElementById('soundboard-grid-outer');
  const grid = document.getElementById('soundboard-grid');
  if (!outer || !grid) return;
  const { cols, rows } = _lastGrid;
  const outerRect = outer.getBoundingClientRect();
  const cell = computeSquareCellSize({ cols, rows, availableWidth: outerRect.width, availableHeight: outerRect.height });
  grid.style.width  = `${cols * cell + (cols - 1) * SB_GAP}px`;
  grid.style.height = `${rows * cell + (rows - 1) * SB_GAP}px`;
}

export function buildSoundboardPanel(send) {
  const grid = document.getElementById('soundboard-grid');
  let html = '';
  for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
    html += `<div class="sb-cell" id="sbButton-${i}">` +
            `<div class="sb-img-wrap"><img id="sbImg-${i}" src="" alt=""></div>` +
            `<div class="sb-label" id="sbLabel-${i}"></div></div>`;
  }
  grid.innerHTML = html;

  for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
    document.getElementById(`sbButton-${i}`).addEventListener('click', () => {
      send({ type: 'soundboard:trigger', i });
    });
  }

  // The 1.5 factor matches mixerUI.js's own sbVolume binding exactly
  // (renderer/src/mixerUI.js:444) — the slider's 0-125 HTML range does not
  // map 1:1 onto the gain float despite the matching-looking numbers.
  document.getElementById('sbVolume').addEventListener('input', (e) => {
    send({ type: 'soundboard:gain', v: e.target.value / 100 * 1.5 });
  });
  document.getElementById('sbStopAll').addEventListener('click', () => {
    send({ type: 'soundboard:stopAll' });
  });

  new ResizeObserver(() => _applyCellSize()).observe(document.getElementById('soundboard-grid-outer'));
}

export function renderSoundboardPanel(state, send) {
  const { cols, rows } = state.soundboard.grid;
  _lastGrid = { cols, rows };
  document.getElementById('soundboard-grid').style.setProperty('--sb-cols', cols);
  document.getElementById('soundboard-grid').style.setProperty('--sb-rows', rows);
  _applyCellSize();

  document.getElementById('sbVolume').value = Math.round(state.soundboard.gain / 1.5 * 100);

  for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
    const cell = document.getElementById(`sbButton-${i}`);
    cell.classList.toggle('sb-hidden', !_isVisible(i, cols, rows));

    const btn = state.soundboard.buttons[i];
    if (!btn) continue;

    document.getElementById(`sbLabel-${i}`).textContent = btn.name ?? '';

    const img = document.getElementById(`sbImg-${i}`);
    const newSrc = btn.imageSrc ? `/api/image?path=${encodeURIComponent(btn.imageSrc)}` : '';
    if (img.dataset.src !== newSrc) {
      img.dataset.src = newSrc;
      img.src = newSrc;
      img.onerror = () => { img.src = ''; };
    }

    cell.style.borderColor = btn.playing ? 'yellow' : '';
    cell.style.boxShadow   = btn.playing ? '0 0 8px yellow' : '';
  }

  _renderSbScenesRow(state, send);
}

function _renderSbScenesRow(state, send) {
  const row = document.getElementById('sb-scenes-row');
  row.querySelectorAll('.sb-scene-btn').forEach(el => el.remove());
  state.sbScenes.forEach((scene, idx) => {
    if (scene.detached) return; // shown in its own floating panel instead

    const btn = document.createElement('button');
    btn.className   = 'sb-scene-btn' + (idx === state.currentSbScene ? ' sb-scene-active' : '');
    btn.textContent = scene.name || `ЗП ${idx + 1}`;
    bindSceneTabDrag(btn, idx, { currentScene: state.currentSbScene }, send, 'sbScene:switch', 'sbScene:detach');
    row.appendChild(btn);
  });
}

/** Handles the non-debounced {kind:'soundboardFlash', i} WS event. */
export function handleSoundboardEvent(evt) {
  if (evt.kind !== 'soundboardFlash') return;
  const btn = document.getElementById(`sbButton-${evt.i}`);
  if (!btn) return;
  btn.classList.add('sb-flash');
  setTimeout(() => btn.classList.remove('sb-flash'), 200);
}
