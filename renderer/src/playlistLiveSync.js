/**
 * playlistLiveSync.js — runs in the MAIN window's renderer.
 *
 * Every tick, for each currently-open detached PlaylistDialog window, diffs
 * its channel's {currentlyPlaying, playing} against the last value pushed to
 * that window and pushes only on an actual change. Covers state changes that
 * happen for reasons *outside* that window — a track naturally ending and
 * auto-advancing, playback stopped from the main mixer or soundboard while
 * the playlist window is open. Actions taken *inside* the detached window
 * update its own local mirror immediately instead (see
 * renderer/windows/playlist-entry.js's channel stub) — this loop only
 * handles the external case, and deliberately does not poll every possible
 * channel/ambient/soundboard slot every tick (getOpenKeys() is one cheap
 * query telling it which windows actually exist right now).
 */

const KEY_RE             = /^playlist:(ch|amb|sb):(\d+)$/;
const SCENE_KEY_RE       = /^playlist:sbScene:([^:]+):(\d+)$/;
const MUSIC_SCENE_KEY_RE = /^playlist:musicScene:([^:]+):(ch|amb):(\d+)$/;

function _resolveChannel(mixer, kind, index) {
  if (kind === 'ch')  return mixer.channels[index];
  if (kind === 'amb') return mixer.ambientMixer?.channels[index];
  if (kind === 'sb')  return mixer.soundboard?.channels[index];
  return undefined;
}

function _resolveMusicSceneChannel(mixer, sceneId, kind, index) {
  const player = mixer.detachedMusicScenes?.get(sceneId);
  if (!player) return undefined;
  return kind === 'amb' ? player.ambientMixer.channels[index] : player.channels[index];
}

export function createPlaylistLiveSync(mixer, { getOpenKeys, push }) {
  const lastKnown = new Map(); // key -> { currentlyPlaying, playing }

  async function tick() {
    const keys = await getOpenKeys();
    for (const key of keys) {
      let ch;
      const m = KEY_RE.exec(key);
      if (m) {
        ch = _resolveChannel(mixer, m[1], Number(m[2]));
      } else {
        const sm = SCENE_KEY_RE.exec(key);
        if (sm) {
          ch = mixer.detachedSoundboards?.get(sm[1])?.channels[Number(sm[2])];
        } else {
          const mm = MUSIC_SCENE_KEY_RE.exec(key);
          if (!mm) continue;
          ch = _resolveMusicSceneChannel(mixer, mm[1], mm[2], Number(mm[3]));
        }
      }
      if (!ch) continue;

      const state = { currentlyPlaying: ch.currentlyPlaying, playing: ch.playing };
      const prev = lastKnown.get(key);
      if (prev && prev.currentlyPlaying === state.currentlyPlaying && prev.playing === state.playing) {
        continue;
      }
      lastKnown.set(key, state);
      push(key, state);
    }
  }

  return { tick };
}
