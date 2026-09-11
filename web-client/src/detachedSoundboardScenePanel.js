// web-client/src/detachedSoundboardScenePanel.js
/**
 * detachedSoundboardScenePanel.js — one floating panel per detached
 * soundboard scene. Just the button grid — no master volume, no stop-all
 * (matching the desktop's own soundboardScene.html, which has neither).
 * Square-cell letterbox resize: dragging the resize handle sets a
 * candidate box (startSize + cumulative drag delta, capped at the canvas
 * edges), then the panel snaps to the largest exact cols×rows square-cell
 * fit within that candidate — reuses soundboardPanel.js's
 * computeSquareCellSize so both soundboards (main + detached) use
 * identical math.
 */
import { createDetachedPanel } from './detachedWindow.js';
import { computeSquareCellSize } from './soundboardPanel.js';

const SOUNDBOARD_SIZE = 49; // must match renderer/src/templates.js's SOUNDBOARD_SIZE
const SB_GRID_MAX = 7;
const SB_GAP = 6; // px — must match #soundboard-grid's `gap` in renderer/style.css
const SB_CELL = 90; // px — matches renderer/src/sbGrid.js's SB_CELL, the desktop's own initial-size estimate for a detached soundboard scene window

// Rough estimate of the title bar's height — only affects the panel's
// INITIAL size before the first real layout; self-corrects on the first
// resize since computeSquareCellSize is re-run against the panel's actual
// current box, not this estimate, on every subsequent resize.
const CHROME_HEIGHT_ESTIMATE = 28;

function _isVisible(i, cols, rows) {
  return (i % SB_GRID_MAX) < cols && Math.floor(i / SB_GRID_MAX) < rows;
}

/**
 * @param {string} sceneId
 * @param {string} title
 * @param {{left:number, top:number}} pos
 * @param {number} cols
 * @param {number} rows
 * @param {(cmd:object) => void} send
 * @returns {{ render: (scene:object) => void, handleFlash: (index:number) => void, destroy: () => void }}
 */
export function createSoundboardScenePanel(sceneId, title, pos, cols, rows, send) {
  const initialWidth  = cols * SB_CELL + (cols - 1) * SB_GAP;
  const initialHeight = rows * SB_CELL + (rows - 1) * SB_GAP + CHROME_HEIGHT_ESTIMATE;

  const panel = createDetachedPanel({
    id: `sb-${sceneId}`,
    title,
    left: pos.left, top: pos.top,
    width: initialWidth, height: initialHeight,
    onResize: (ctx) => {
      // Capped against the canvas edges (same as computeResizedSize does for
      // the main app-window in Phase A) before the letterbox fit runs, so
      // the panel can't be dragged larger than the canvas.
      const maxWidth  = ctx.canvasRect.width  - ctx.left;
      const maxHeight = ctx.canvasRect.height - ctx.top;
      const candidateWidth  = Math.min(ctx.startWidth  + ctx.dx, maxWidth);
      const candidateHeight = Math.min(ctx.startHeight + ctx.dy, maxHeight) - CHROME_HEIGHT_ESTIMATE;
      const cell = computeSquareCellSize({ cols, rows, availableWidth: candidateWidth, availableHeight: candidateHeight });
      return {
        width:  Math.round(cols * cell + (cols - 1) * SB_GAP),
        height: Math.round(rows * cell + (rows - 1) * SB_GAP + CHROME_HEIGHT_ESTIMATE),
      };
    },
    onClose: () => send({ type: 'sbScene:reattach', sceneId }),
  });

  const grid = document.createElement('div');
  grid.id = `detSb-${sceneId}-grid`;
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  grid.style.gap = `${SB_GAP}px`;
  grid.style.width = '100%';
  grid.style.height = '100%';
  panel.bodyEl.appendChild(grid);

  let html = '';
  for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
    html += `<div class="sb-cell" id="detSb-${sceneId}-sbButton-${i}">` +
            `<div class="sb-img-wrap"><img id="detSb-${sceneId}-sbImg-${i}" src="" alt=""></div>` +
            `<div class="sb-label" id="detSb-${sceneId}-sbLabel-${i}"></div></div>`;
  }
  grid.innerHTML = html;

  for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
    document.getElementById(`detSb-${sceneId}-sbButton-${i}`).addEventListener('click', () => {
      send({ type: 'sbSceneCh:trigger', sceneId, index: i });
    });
    document.getElementById(`detSb-${sceneId}-sbButton-${i}`)?.classList.toggle('sb-hidden', !_isVisible(i, cols, rows));
  }

  function render(scene) {
    for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
      const cell = document.getElementById(`detSb-${sceneId}-sbButton-${i}`);
      const btn = scene.buttons[i];
      if (!btn) continue;
      document.getElementById(`detSb-${sceneId}-sbLabel-${i}`).textContent = btn.name ?? '';
      const img = document.getElementById(`detSb-${sceneId}-sbImg-${i}`);
      const newSrc = btn.imageSrc ? `/api/image?path=${encodeURIComponent(btn.imageSrc)}` : '';
      if (img.dataset.src !== newSrc) { img.dataset.src = newSrc; img.src = newSrc; img.onerror = () => { img.src = ''; }; }
      cell.style.borderColor = btn.playing ? 'yellow' : '';
      cell.style.boxShadow   = btn.playing ? '0 0 8px yellow' : '';
    }
  }

  function handleFlash(index) {
    const btn = document.getElementById(`detSb-${sceneId}-sbButton-${index}`);
    if (!btn) return;
    btn.classList.add('sb-flash');
    setTimeout(() => btn.classList.remove('sb-flash'), 200);
  }

  return { render, handleFlash, destroy: panel.destroy };
}
