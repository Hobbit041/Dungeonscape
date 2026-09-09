/**
 * detachedWindowChrome.js — shared by every renderer/windows/*-entry.js
 * bootstrap script. Called once, after that window's own content has been
 * fully built, to: (1) inject a custom title bar (native title bar removed
 * via `frame: false` in main.js's window creation) with the window's name
 * on the left and a close button on the right, and (2) measure the window's
 * true natural content size and report it to the main process, which
 * resizes the still-hidden window to match before finally showing it — see
 * main.js's 'child-window-content-size' handler.
 */

/**
 * Every window sharing renderer/style.css inherits its global reset
 * (`html, body { height: 100%; overflow: hidden; }`). That's exactly right
 * ONCE a window is already correctly sized, but it's actively wrong for
 * MEASURING: a flex-shrink layout (e.g. musicScene.html's #channel-strip-row/
 * #ambient-strip-row, both flex:1; min-height:0) doesn't overflow when
 * squeezed into a too-small height:100% body — it just shrinks its children
 * to fit, so scrollHeight would silently under-report. Temporarily letting
 * body grow to its own natural height (and un-hiding overflow) reveals the
 * real size; both are restored immediately after reading, before the window
 * is ever shown, so there's no visible flash.
 */
function _measureNaturalContentSize() {
  const prevBodyHeight    = document.body.style.height;
  const prevBodyOverflow  = document.body.style.overflow;
  const prevHtmlOverflow  = document.documentElement.style.overflow;

  document.body.style.height = 'auto';
  document.body.style.overflow = 'visible';
  document.documentElement.style.overflow = 'visible';

  const width  = document.body.scrollWidth;
  const height = document.body.scrollHeight;

  document.body.style.height   = prevBodyHeight;
  document.body.style.overflow = prevBodyOverflow;
  document.documentElement.style.overflow = prevHtmlOverflow;

  return { width, height };
}

/**
 * @param {string} key - this window's own child-window key (already
 *   present in every *-entry.js's onInit data as `data.key`), used both for
 *   the close button and for reporting the measured size to the right
 *   window.
 * @param {string} title - text shown on the left of the title bar.
 * @param {boolean} [scene] - true for a detached SCENE window (musicScene,
 *   soundboardScene) only — styles the title text like the main window's
 *   own active-scene tab (orange). Every other detached window omits this.
 */
export function finishDetachedWindowInit(key, title, scene = false) {
  const bar = document.createElement('div');
  bar.className = 'detached-title-bar';

  const name = document.createElement('span');
  name.className = 'detached-title-bar-name' + (scene ? ' detached-title-bar-name-scene' : '');
  name.textContent = title;

  const close = document.createElement('button');
  close.className = 'detached-title-bar-close';
  close.textContent = '✕';
  close.addEventListener('click', () => window.api.childWindow.close(key));

  bar.appendChild(name);
  bar.appendChild(close);
  document.body.insertBefore(bar, document.body.firstChild);

  const size = _measureNaturalContentSize();
  window.api.childWindow.reportContentSize(key, size);
}
