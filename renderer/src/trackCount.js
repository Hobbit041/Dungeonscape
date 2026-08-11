/**
 * trackCount.js — configurable *visible* music/ambient track count (4-12).
 *
 * Backing structures (audio channels, DOM strips, MIDI mapping table) always
 * exist for the full MIXER_SIZE/AMBIENT_SIZE (12) — this module only pads
 * legacy 8-length saved data up to that size on load. The 4-12 "visible
 * count" is a separate, purely UI-level concern layered on top elsewhere.
 */
import { MIXER_SIZE, makeEmptyChannel, makeEmptyAmbient } from './templates.js';
import { AMBIENT_SIZE } from './ambientMixer.js';

export const TRACK_COUNT_MIN = 4;
export const TRACK_COUNT_MAX = 12;

function _pad(arr, size, makeEmpty) {
  const out = arr.slice();
  for (let i = out.length; i < size; i++) out.push(makeEmpty(i));
  return out;
}

/**
 * Pad a soundscape's `channels`/`ambient` arrays — both at the top level and
 * inside every saved scene — up to MIXER_SIZE/AMBIENT_SIZE. Mutates `ss` in
 * place (matches the existing `migrateSoundscape` convention in sbGrid.js).
 * Returns true if anything changed.
 */
export function migrateTrackCount(ss) {
  let changed = false;

  if (Array.isArray(ss.channels) && ss.channels.length < MIXER_SIZE) {
    ss.channels = _pad(ss.channels, MIXER_SIZE, makeEmptyChannel);
    changed = true;
  }
  if (Array.isArray(ss.ambient) && ss.ambient.length < AMBIENT_SIZE) {
    ss.ambient = _pad(ss.ambient, AMBIENT_SIZE, makeEmptyAmbient);
    changed = true;
  }
  for (const scene of ss.scenes ?? []) {
    if (Array.isArray(scene.channels) && scene.channels.length < MIXER_SIZE) {
      scene.channels = _pad(scene.channels, MIXER_SIZE, makeEmptyChannel);
      changed = true;
    }
    if (Array.isArray(scene.ambient) && scene.ambient.length < AMBIENT_SIZE) {
      scene.ambient = _pad(scene.ambient, AMBIENT_SIZE, makeEmptyAmbient);
      changed = true;
    }
  }
  return changed;
}
