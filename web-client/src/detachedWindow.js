/**
 * detachedWindow.js — generic floating-panel chrome for a detached scene
 * window on the web canvas (one instance per currently-detached music or
 * soundboard scene — see detachedMusicScenePanel.js/
 * detachedSoundboardScenePanel.js, which supply the actual content and
 * their own resize math via the `onResize` callback). Shares drag math
 * with the main app-window panel (desktopWindow.js's
 * computeDraggedPosition) but not its resize math — music scenes
 * (width-locked, see computeLockedWidthResize below) and soundboard
 * scenes (square-cell letterbox, see soundboardPanel.js's
 * computeSquareCellSize) need different rules, supplied per-instance by
 * the caller rather than built into this generic module.
 */
import { computeDraggedPosition } from './desktopWindow.js';

let _nextZIndex = 10; // detached panels stack above #app-window and above each other in click order

/**
 * Pure resize math for a width-locked panel (music scenes): only height
 * changes, floored at minHeight and capped at the canvas edge. `dy` is the
 * cumulative pointer movement since the resize gesture started, `startHeight`
 * the panel's own height at that moment — mirrors desktopWindow.js's
 * computeResizedSize's own startWidth parameter for the same reason (a
 * second resize gesture must continue from wherever the first left off).
 * The floor takes priority over the canvas-edge cap when they conflict,
 * matching computeResizedSize's own precedence rule.
 */
export function computeLockedWidthResize({ startHeight, top, dy, canvasHeight, minHeight }) {
  const maxHeight = canvasHeight - top;
  return { height: Math.max(minHeight, Math.min(startHeight + dy, maxHeight)) };
}

/**
 * @param {object} opts
 * @param {string} opts.id - unique suffix for this panel's DOM element ids
 * @param {string} opts.title
 * @param {number} opts.left
 * @param {number} opts.top
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {(ctx: {dx:number, dy:number, startWidth:number, startHeight:number, left:number, top:number, canvasRect:DOMRect}) => {width:number, height:number}} opts.onResize
 *   Called on every resize-handle pointermove; returns the new size to apply.
 * @param {() => void} opts.onClose - called when the close button is clicked
 * @returns {{ bodyEl: HTMLElement, destroy: () => void }}
 */
export function createDetachedPanel({ id, title, left, top, width, height, onResize, onClose }) {
  const canvas = document.getElementById('canvas');

  const el = document.createElement('div');
  el.className = 'detached-scene-panel';
  el.id = `detached-panel-${id}`;
  el.style.position = 'absolute';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.style.zIndex = String(_nextZIndex++);

  const titleBar = document.createElement('div');
  titleBar.className = 'detached-title-bar';
  const nameEl = document.createElement('span');
  nameEl.className = 'detached-title-bar-name';
  nameEl.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'detached-title-bar-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => onClose());
  titleBar.appendChild(nameEl);
  titleBar.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'detached-scene-panel-body';

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'detached-scene-panel-resize-handle';

  el.appendChild(titleBar);
  el.appendChild(body);
  el.appendChild(resizeHandle);
  canvas.appendChild(el);

  // Bring to front on interaction, so overlapping panels are easy to reach.
  el.addEventListener('pointerdown', () => { el.style.zIndex = String(_nextZIndex++); });

  let dragState = null;
  titleBar.addEventListener('pointerdown', (e) => {
    if (e.target === closeBtn) return; // let the close button handle its own click — don't start a drag or capture the pointer over it
    dragState = { startLeft: el.offsetLeft, startTop: el.offsetTop, startX: e.clientX, startY: e.clientY };
    titleBar.setPointerCapture(e.pointerId);
  });
  titleBar.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const canvasRect = canvas.getBoundingClientRect();
    const { left: newLeft, top: newTop } = computeDraggedPosition({
      startLeft: dragState.startLeft, startTop: dragState.startTop,
      dx: e.clientX - dragState.startX, dy: e.clientY - dragState.startY,
      width: el.offsetWidth, height: el.offsetHeight,
      canvasWidth: canvasRect.width, canvasHeight: canvasRect.height,
    });
    el.style.left = `${newLeft}px`;
    el.style.top  = `${newTop}px`;
  });
  titleBar.addEventListener('pointerup', () => { dragState = null; });
  titleBar.addEventListener('pointercancel', () => { dragState = null; });

  let resizeState = null;
  resizeHandle.addEventListener('pointerdown', (e) => {
    resizeState = { startX: e.clientX, startY: e.clientY, startWidth: el.offsetWidth, startHeight: el.offsetHeight };
    resizeHandle.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!resizeState) return;
    const canvasRect = canvas.getBoundingClientRect();
    const { width: newWidth, height: newHeight } = onResize({
      dx: e.clientX - resizeState.startX, dy: e.clientY - resizeState.startY,
      startWidth: resizeState.startWidth, startHeight: resizeState.startHeight,
      left: el.offsetLeft, top: el.offsetTop, canvasRect,
    });
    el.style.width  = `${newWidth}px`;
    el.style.height = `${newHeight}px`;
  });
  resizeHandle.addEventListener('pointerup', () => { resizeState = null; });
  resizeHandle.addEventListener('pointercancel', () => { resizeState = null; });

  return {
    bodyEl: body,
    setWidth(px) { el.style.width = `${px}px`; },
    destroy() { el.remove(); },
  };
}
