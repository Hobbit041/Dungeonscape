/**
 * detachedWindowChrome.js — shared by every renderer/windows/*-entry.js
 * bootstrap script. Provides three composable pieces used, in different
 * combinations, once each window has fully built its own content:
 *   - injectTitleBar(key, title, scene): adds the custom title bar (native
 *     title bar removed via `frame: false` in main.js's window creation).
 *     Only called by windows that don't already have their own adequate
 *     in-page "fake title bar" (musicScene/soundboardScene, which never had
 *     one; settings/missingFiles, whose existing .fx-header offers nothing
 *     beyond a title+close that this bar already provides). fx/channelConfig/
 *     playlist skip this — their .fx-header already has extra buttons
 *     (clear/trash, image pick) this generic bar can't replace, so THEIR
 *     .fx-header stays as the window's sole header instead (see
 *     .detached-panel .fx-header's own drag-region rule in style.css).
 *   - measureNaturalContentSize(): measures the window's true natural
 *     content size (see its own doc comment for why this needs more than a
 *     plain scrollWidth/scrollHeight read).
 *   - finishDetachedWindowInit(key, title, opts): the common-case
 *     convenience wrapper combining both, used by every window except
 *     soundboardScene (which needs a different, square-cell-aware
 *     measurement instead of the generic natural-content-size one — see
 *     soundboardScene-entry.js).
 * Whichever combination a window uses, the LAST step is always reporting
 * the final size to the main process (window.api.childWindow.
 * reportContentSize), which resizes the still-hidden window to match before
 * finally showing it — see main.js's 'child-window-content-size' handler.
 */

/**
 * Every window sharing renderer/style.css inherits its global reset
 * (`html, body { height: 100%; overflow: hidden; }`). That's exactly right
 * ONCE a window is already correctly sized, but it's actively wrong for
 * MEASURING, on BOTH axes, for two different reasons:
 *   - Height: a flex-shrink layout (e.g. musicScene.html's
 *     #channel-strip-row/#ambient-strip-row, both flex:1; min-height:0)
 *     doesn't overflow when squeezed into a too-small height:100% body — it
 *     just shrinks its children to fit, so scrollHeight would silently
 *     under-report.
 *   - Width: CSS's auto-sizing is asymmetric between the two axes for a
 *     block-level element — auto HEIGHT shrink-wraps to content by default,
 *     but auto WIDTH instead fills the containing block (the current
 *     viewport) by default. body has no explicit width rule at all, so
 *     without an explicit override, body.scrollWidth reports (at minimum)
 *     the window's CURRENT width — still the old hardcoded value from
 *     whichever caller opened it, since the real resize hasn't happened yet
 *     — rather than shrinking to whatever the content actually needs. This
 *     is why, before this fix, every window measured as at least as wide as
 *     its original hardcoded open() width regardless of actual content
 *     (e.g. a music/ambient scene with fewer than the max 12 tracks visible
 *     still measured at the width tuned for all 12).
 * Both temporary overrides are restored immediately after reading, before
 * the window is ever shown, so there's no visible flash.
 */
export function measureNaturalContentSize() {
  const prevBodyHeight    = document.body.style.height;
  const prevBodyWidth     = document.body.style.width;
  const prevBodyOverflow  = document.body.style.overflow;
  const prevHtmlOverflow  = document.documentElement.style.overflow;

  document.body.style.height = 'auto';
  document.body.style.width = 'fit-content';
  document.body.style.overflow = 'visible';
  document.documentElement.style.overflow = 'visible';

  const width  = document.body.scrollWidth;
  const height = document.body.scrollHeight;

  document.body.style.height   = prevBodyHeight;
  document.body.style.width    = prevBodyWidth;
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
 * @param {false|'music'|'soundboard'} [scene] - styles the title text like
 *   the main window's own active-scene tab (orange) for a detached SCENE
 *   window only — 'music' sizes it like .scene-btn (#scenes-row, music/
 *   ambient scene tabs), 'soundboard' like the smaller .sb-scene-btn
 *   (#sb-scenes-row). Every other detached window omits this (false).
 * @returns {HTMLElement} the inserted title-bar element (its offsetHeight
 *   is needed by soundboardScene-entry.js's own square-cell-aware sizing).
 */
export function injectTitleBar(key, title, scene = false) {
  const bar = document.createElement('div');
  bar.className = 'detached-title-bar';

  const name = document.createElement('span');
  name.className = 'detached-title-bar-name'
    + (scene ? ' detached-title-bar-name-scene' : '')
    + (scene === 'soundboard' ? ' detached-title-bar-name-scene-sb' : '');
  name.textContent = title;

  const close = document.createElement('button');
  close.className = 'detached-title-bar-close';
  close.textContent = '✕';
  close.addEventListener('click', () => window.api.childWindow.close(key));

  bar.appendChild(name);
  bar.appendChild(close);
  document.body.insertBefore(bar, document.body.firstChild);
  return bar;
}

/**
 * @param {{scene?: false|'music'|'soundboard', showTitleBar?: boolean, lockWidth?: boolean}} [opts]
 *   `scene`: see injectTitleBar(). `showTitleBar` (default true): pass false
 *   for windows whose own dialog content already has an adequate header (see
 *   this file's own header comment) — measurement still runs either way.
 *   `lockWidth` (default false): pass true to have main.js's
 *   'child-window-content-size' handler pin the window's width at this
 *   measured value — manual resize can still grow/shrink height, but never
 *   width. Used by musicScene-entry.js: without it, widening the window past
 *   its visible tracks' natural width just reveals blank background exactly
 *   where the (deliberately hidden, per the current track-count setting)
 *   remaining tracks would sit — no CSS growth rule can fill that space
 *   meaningfully, so the width simply isn't resizable at all, matching how
 *   the main window's own mixer section never changes width on window
 *   resize either (see main.js's #mixer-section: flex-shrink:0 in style.css).
 */
export function finishDetachedWindowInit(key, title, { scene = false, showTitleBar = true, lockWidth = false } = {}) {
  if (showTitleBar) injectTitleBar(key, title, scene);
  const size = measureNaturalContentSize();
  window.api.childWindow.reportContentSize(key, lockWidth ? { ...size, lockWidth: true } : size);
}
