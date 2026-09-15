/**
 * debounce.js — small shared debounce helper.
 *
 * Wraps a function so repeated calls in quick succession only run it once,
 * after `ms` of silence since the last one — for a UI control that fires
 * many events per user gesture (dragging a fader/slider) when only the
 * FINAL value needs to be persisted. Extracted here because mixer.js's
 * _deferGlobalVolumesSave() and midi.js's _deferSave() had already
 * independently hand-rolled the identical clearTimeout/setTimeout(...,300)
 * pattern before this existed — new debounced saves (see fxDialog.js's
 * _save()) should use this instead of hand-copying a third one.
 */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
