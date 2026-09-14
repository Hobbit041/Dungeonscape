// web-client/src/liveSlider.js
/**
 * app.js's onState handler re-renders every state broadcast (webBridge.js
 * pushes one every ~50-250ms), and render() unconditionally overwrites
 * every fader's .value from server state. Mid-drag, that snaps the handle
 * back to the last broadcast value, then forward again on the next native
 * pointermove — visible jitter that doesn't track continuous input.
 *
 * bindLiveSlider marks the element while a pointer is down on it (mouse
 * and touch alike, unlike relying on focus which some browsers don't grant
 * range inputs on click); setSliderValue then skips the render-driven
 * overwrite until release, letting the browser's own drag tracking own the
 * handle position in the meantime.
 */
export function bindLiveSlider(el, onInput) {
  el.addEventListener('input', onInput);
  el.addEventListener('pointerdown', () => { el.dataset.dragging = '1'; });
  const release = () => { delete el.dataset.dragging; };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
}

export function setSliderValue(el, value) {
  if (el.dataset.dragging) return;
  el.value = value;
}
