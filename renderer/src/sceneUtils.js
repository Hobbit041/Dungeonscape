/**
 * sceneUtils.js — helpers for resolving a music/ambient scene (ss.scenes[])
 * by its stable id, for use by a MusicScenePlayer instance bound to a
 * specific (necessarily non-active — see musicScenePlayer.js) scene.
 * Mirrors sbGrid.js's resolveSoundboardArray() for soundboard scenes, but
 * returns the whole scene object (not a single array) since a music/ambient
 * scene player needs both `.channels` and `.ambient` from the same scene.
 */

/**
 * Resolve one scene by its stable id.
 * @param {object} ss — a soundscape object (one entry from Storage.getSoundscapes()).
 * @param {string} sceneId — the scene's stable id (see makeSceneId() in sbGrid.js).
 * @returns {object|null} the matching entry in ss.scenes[], or null if ss is
 *   missing or no scene matches (e.g. the scene was deleted out from under
 *   a still-live MusicScenePlayer instance).
 *
 * Returned by reference — callers are expected to mutate the scene object
 * directly (e.g. write a channel's data into `.channels`) and then persist
 * the containing soundscapes object themselves.
 */
export function resolveScene(ss, sceneId) {
  if (!ss) return null;
  return ss.scenes?.find(s => s.id === sceneId) ?? null;
}
