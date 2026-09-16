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
    top: canvasHeight - stripHeight - margin,
  };
}

/**
 * DOM wiring: binds pointer drag (via `titleBarEl`) and corner resize (via
 * `resizeHandleEl`) to `windowEl`'s inline left/top/width/height, clamped
 * against `canvasEl`'s current bounding rect. Also wires `minimizeBtnEl`:
 * clicking it hides `windowEl` (its inline geometry is left untouched) and
 * moves the live title-text node into a small draggable strip pinned to
 * the canvas's bottom-left corner; the strip's own "□" button moves the
 * node back and un-hides the window. Not unit tested (no DOM in this
 * project's test setup) — verified manually elsewhere in this plan.
 */
export function initDesktopWindow({ windowEl, titleBarEl, resizeHandleEl, canvasEl, minimizeBtnEl }) {
  windowEl.style.position = 'absolute';
  windowEl.style.left     = '0px';
  windowEl.style.top      = '0px';
  windowEl.style.width    = `${BASE_WIDTH}px`;
  windowEl.style.height   = `${BASE_HEIGHT}px`;

  let dragState = null;
  titleBarEl.addEventListener('pointerdown', (e) => {
    if (e.target === minimizeBtnEl) return; // let the minimize button handle its own click — don't start a drag or capture the pointer over it
    dragState = { startLeft: windowEl.offsetLeft, startTop: windowEl.offsetTop, startX: e.clientX, startY: e.clientY };
    titleBarEl.setPointerCapture(e.pointerId);
  });
  titleBarEl.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const canvasRect = canvasEl.getBoundingClientRect();
    const { left, top } = computeDraggedPosition({
      startLeft: dragState.startLeft,
      startTop:  dragState.startTop,
      dx: e.clientX - dragState.startX,
      dy: e.clientY - dragState.startY,
      width:  windowEl.offsetWidth,
      height: windowEl.offsetHeight,
      canvasWidth:  canvasRect.width,
      canvasHeight: canvasRect.height,
    });
    windowEl.style.left = `${left}px`;
    windowEl.style.top  = `${top}px`;
  });
  titleBarEl.addEventListener('pointerup', () => { dragState = null; });
  titleBarEl.addEventListener('pointercancel', () => { dragState = null; });

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

  const titleTextEl = document.getElementById('app-window-title-text');
  let stripEl = null;

  function restoreWindow() {
    titleBarEl.insertBefore(titleTextEl, minimizeBtnEl);
    stripEl.remove();
    stripEl = null;
    windowEl.style.display = '';
  }

  minimizeBtnEl.addEventListener('click', () => {
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

    let stripDragState = null;
    stripEl.addEventListener('pointerdown', (e) => {
      if (e.target === restoreBtn) return;
      stripDragState = { startLeft: stripEl.offsetLeft, startTop: stripEl.offsetTop, startX: e.clientX, startY: e.clientY };
      stripEl.setPointerCapture(e.pointerId);
    });
    stripEl.addEventListener('pointermove', (e) => {
      if (!stripDragState) return;
      const rect = canvasEl.getBoundingClientRect();
      const { left, top } = computeDraggedPosition({
        startLeft: stripDragState.startLeft, startTop: stripDragState.startTop,
        dx: e.clientX - stripDragState.startX, dy: e.clientY - stripDragState.startY,
        width: stripEl.offsetWidth, height: stripEl.offsetHeight,
        canvasWidth: rect.width, canvasHeight: rect.height,
      });
      stripEl.style.left = `${left}px`;
      stripEl.style.top  = `${top}px`;
    });
    stripEl.addEventListener('pointerup', () => { stripDragState = null; });
    stripEl.addEventListener('pointercancel', () => { stripDragState = null; });
  });
}
