/**
 * desktopWindow.js — the draggable/resizable panel that mirrors the main
 * app window on the web canvas. Deliberately independent of the desktop
 * app's own live window-sizing rules (soundboard square-cell math,
 * trackCount/orientation deltas — see main.js) — this panel just scales
 * the app's fixed startup rectangle (1120×690, same as main.js's
 * createWindow()) uniformly, floored at a minimum size.
 */
export const BASE_WIDTH  = 1120;
export const BASE_HEIGHT = 690;
export const MIN_WIDTH   = 1000;
export const MIN_HEIGHT  = 559; // matches main.js's VERTICAL_MIN_HEIGHT
export const STRIP_MARGIN = 12; // px from the canvas's left/bottom edges to the minimized strip
export const TITLE_TEXT_EL_ID = 'app-window-title-text'; // shared with mixerPanel.js's own lookup — see its own call site

// Whichever of MIN_WIDTH/MIN_HEIGHT is the stricter fraction of the base
// rectangle wins as the floor for uniform scaling. At these constants it's
// the width (1000/1120 ≈ 0.893) — height at that scale (≈616px) sits
// comfortably above its own floor (559px), so the two constraints don't
// actually conflict; the code stays generic in case the constants change.
const MIN_SCALE = Math.max(MIN_WIDTH / BASE_WIDTH, MIN_HEIGHT / BASE_HEIGHT);

/**
 * Pure resize math for a bottom-right corner-drag: `dx` is the cumulative
 * pointer movement since THIS gesture started, `startWidth` is the panel's
 * own width at that same moment (not always BASE_WIDTH — a second resize
 * gesture must continue from wherever the first one left off). Preserves
 * the BASE_WIDTH:BASE_HEIGHT aspect ratio, capped so NEITHER the right nor
 * the bottom edge can be dragged past the canvas (the height cap is
 * converted to an equivalent max width via the fixed aspect ratio, since
 * width is what scale is computed from). The minimum-scale floor takes
 * priority over both canvas-edge caps when they conflict (a canvas smaller
 * than the minimum window size) — this app accepts an off-canvas window as
 * by-design in that degenerate case.
 */
export function computeResizedSize({ startWidth, left, top, dx, canvasWidth, canvasHeight }) {
  const candidateWidth = startWidth + dx;
  const maxWidthFromRight  = canvasWidth  - left;
  const maxWidthFromBottom = (canvasHeight - top) * (BASE_WIDTH / BASE_HEIGHT);
  const maxWidthFromCanvas = Math.min(maxWidthFromRight, maxWidthFromBottom);
  const scale = Math.max(
    MIN_SCALE,
    Math.min(candidateWidth / BASE_WIDTH, maxWidthFromCanvas / BASE_WIDTH),
  );
  return {
    width:  Math.round(BASE_WIDTH  * scale),
    height: Math.round(BASE_HEIGHT * scale),
  };
}

/**
 * Pure drag math: clamps the panel's top-left corner so an active drag
 * gesture can't push it beyond the canvas edges. A LATER canvas shrink
 * (browser window resize, handled elsewhere) is deliberately NOT re-clamped
 * by this — only the act of dragging is bounded.
 */
export function computeDraggedPosition({ startLeft, startTop, dx, dy, width, height, canvasWidth, canvasHeight }) {
  return {
    left: Math.max(0, Math.min(startLeft + dx, canvasWidth  - width)),
    top:  Math.max(0, Math.min(startTop  + dy, canvasHeight - height)),
  };
}

/**
 * Pure placement math for the minimized main-window strip: anchors its
 * top-left corner `margin` px from the canvas's left and bottom edges.
 * Only depends on the strip's own (measured) height — it's always
 * left-anchored, so canvas/strip width play no part.
 */
export function computeMinimizedStripPosition({ canvasHeight, stripHeight, margin }) {
  return {
    left: margin,
    top: Math.max(0, canvasHeight - stripHeight - margin),
  };
}

/**
 * DOM wiring shared by every draggable panel/strip on the canvas (this
 * file's own title-bar/strip drag, and detachedWindow.js's scene-panel
 * title-bar drag): binds pointer-drag on `handleEl` to reposition `el`'s
 * inline left/top, clamped against `canvasEl`'s current bounds via
 * computeDraggedPosition. `handleEl` and `el` are often the same element
 * (a strip dragged by its own body) but don't have to be (a panel dragged
 * by its title bar).
 * @param {(e: PointerEvent) => boolean} [isDragBlocker] - lets a child
 *   control (close/minimize/restore button) opt out of starting a drag on
 *   its own pointerdown. Uses `.contains()`, not `===`, so it still works
 *   if that control's own label is ever wrapped in a child element (an
 *   icon), which a plain identity check would silently miss.
 */
export function bindDrag(handleEl, el, canvasEl, isDragBlocker = () => false) {
  let dragState = null;
  handleEl.addEventListener('pointerdown', (e) => {
    if (isDragBlocker(e)) return;
    dragState = { startLeft: el.offsetLeft, startTop: el.offsetTop, startX: e.clientX, startY: e.clientY };
    handleEl.setPointerCapture(e.pointerId);
  });
  handleEl.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const { left, top } = computeDraggedPosition({
      startLeft: dragState.startLeft,
      startTop:  dragState.startTop,
      dx: e.clientX - dragState.startX,
      dy: e.clientY - dragState.startY,
      width:  el.offsetWidth,
      height: el.offsetHeight,
      canvasWidth:  canvasRect.width,
      canvasHeight: canvasRect.height,
    });
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
  });
  handleEl.addEventListener('pointerup', () => { dragState = null; });
  handleEl.addEventListener('pointercancel', () => { dragState = null; });
}

/**
 * DOM wiring: binds pointer drag (via `titleBarEl`) and corner resize (via
 * `resizeHandleEl`) to `windowEl`'s inline left/top/width/height, clamped
 * against `canvasEl`'s current bounding rect. Also wires `minimizeBtnEl`:
 * clicking it hides `windowEl` (its inline geometry is left untouched) and
 * moves `titleTextEl` into a small draggable strip pinned to the canvas's
 * bottom-left corner; the strip's own "□" button moves the node back and
 * un-hides the window. Not unit tested (no DOM in this project's test
 * setup) — verified manually elsewhere in this plan.
 */
export function initDesktopWindow({ windowEl, titleBarEl, resizeHandleEl, canvasEl, minimizeBtnEl, titleTextEl }) {
  windowEl.style.position = 'absolute';
  windowEl.style.left     = '0px';
  windowEl.style.top      = '0px';
  windowEl.style.width    = `${BASE_WIDTH}px`;
  windowEl.style.height   = `${BASE_HEIGHT}px`;

  bindDrag(titleBarEl, windowEl, canvasEl, (e) => minimizeBtnEl.contains(e.target));

  let resizeState = null;
  resizeHandleEl.addEventListener('pointerdown', (e) => {
    resizeState = { startX: e.clientX, startWidth: windowEl.offsetWidth };
    resizeHandleEl.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  resizeHandleEl.addEventListener('pointermove', (e) => {
    if (!resizeState) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const { width, height } = computeResizedSize({
      startWidth: resizeState.startWidth,
      left: windowEl.offsetLeft,
      top: windowEl.offsetTop,
      dx: e.clientX - resizeState.startX,
      canvasWidth: canvasRect.width,
      canvasHeight: canvasRect.height,
    });
    windowEl.style.width  = `${width}px`;
    windowEl.style.height = `${height}px`;
  });
  resizeHandleEl.addEventListener('pointerup', () => { resizeState = null; });
  resizeHandleEl.addEventListener('pointercancel', () => { resizeState = null; });

  let stripEl = null;

  function restoreWindow() {
    if (!stripEl) return; // already restored (or never minimized) — nothing to undo
    titleBarEl.insertBefore(titleTextEl, minimizeBtnEl);
    stripEl.remove();
    stripEl = null;
    windowEl.style.display = '';
  }

  minimizeBtnEl.addEventListener('click', () => {
    if (stripEl) return; // already minimized — a second trigger (e.g. a programmatic click) would orphan the first strip
    windowEl.style.display = 'none';

    stripEl = document.createElement('div');
    stripEl.className = 'detached-title-bar minimized-window-strip';
    stripEl.appendChild(titleTextEl);

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'detached-title-bar-btn';
    restoreBtn.title = 'Развернуть';
    restoreBtn.textContent = '□'; // □ — same glyph the desktop app uses for maximize/restore
    restoreBtn.addEventListener('click', restoreWindow);
    stripEl.appendChild(restoreBtn);

    canvasEl.appendChild(stripEl);

    const canvasRect = canvasEl.getBoundingClientRect();
    const { left, top } = computeMinimizedStripPosition({
      canvasHeight: canvasRect.height,
      stripHeight: stripEl.offsetHeight,
      margin: STRIP_MARGIN,
    });
    stripEl.style.left = `${left}px`;
    stripEl.style.top  = `${top}px`;

    bindDrag(stripEl, stripEl, canvasEl, (e) => restoreBtn.contains(e.target));
  });
}
