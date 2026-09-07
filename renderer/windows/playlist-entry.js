/**
 * playlist-entry.js — bootstrap for the standalone PlaylistDialog window.
 *
 * PlaylistDialog itself is completely unchanged internally — it still reads
 * getChannel().{sourceArray,currentlyPlaying,playing,loaded}, still calls
 * getChannel().{next,play,_crossfadeTo,setSource}(), still writes
 * getChannel().sourceArray/currentlyPlaying/settings.soundData in its own
 * _save(). What changes is what getChannel() returns: instead of the real
 * live Channel (which only exists in the main window's process), this
 * window builds a stub that mirrors those fields locally (so PlaylistDialog's
 * own reads keep working unchanged) and relays every write to the real
 * channel over child-window-message, handled on the other end by
 * renderer/src/playlistChannelBridge.js in the main window.
 *
 * State that changes for reasons *outside* this window (the track naturally
 * ending and auto-advancing, playback stopped from the main mixer) arrives
 * the other way: renderer/src/playlistLiveSync.js in the main window pushes
 * {currentlyPlaying, playing} over child-window-push whenever they change;
 * this window folds that into the stub's mirror, and PlaylistDialog's own
 * existing 800ms _updatePlayingHighlight() polling picks it up on its own
 * next tick — no separate re-render call needed here.
 *
 * Two CustomEvents PlaylistDialog dispatches on its own document
 * ('playlist-changed', 'channel-play-state-changed') normally reach
 * mixerUI.js's listeners because everything used to share one document —
 * they don't cross a window boundary, so this file re-dispatches them as
 * 'meta' RPC messages instead (handled in playlistChannelBridge.js).
 */
import { initI18n, t }    from '../src/i18n.js';
import { Storage }        from '../src/storage.js';
import { showConfirm }    from '../src/dialog.js';
import { PlaylistDialog } from '../src/playlistDialog.js';
import { resolveSoundboardArray } from '../src/sbGrid.js';
import { resolveScene } from '../src/sceneUtils.js';

function makeChannelStub(initial, sendCall, sendSet) {
  const state = {
    sourceArray:      initial.sourceArray      ?? [],
    currentlyPlaying: initial.currentlyPlaying ?? 0,
    playing:          initial.playing          ?? false,
    loaded:           initial.loaded           ?? false,
  };
  let soundData = null;

  return {
    get sourceArray()       { return state.sourceArray; },
    set sourceArray(v)      { state.sourceArray = v; sendSet('sourceArray', v); },
    get currentlyPlaying()  { return state.currentlyPlaying; },
    set currentlyPlaying(v) { state.currentlyPlaying = v; sendSet('currentlyPlaying', v); },
    get playing() { return state.playing; },
    get loaded()  { return state.loaded; },
    settings: {
      get soundData() { return soundData; },
      set soundData(v) { soundData = v; sendSet('settings.soundData', v); },
    },
    next(playNr) {
      state.currentlyPlaying = playNr;
      sendCall('next', playNr);
    },
    play() {
      state.playing = true;
      sendCall('play');
    },
    _crossfadeTo(newIdx, fadeMs) {
      state.currentlyPlaying = newIdx;
      sendCall('_crossfadeTo', newIdx, fadeMs);
    },
    async setSource(source, stopFirst, forcePlay) {
      state.loaded = true;
      sendCall('setSource', source, stopFirst, forcePlay);
    },
    applyPush(payload) {
      if ('currentlyPlaying' in payload) state.currentlyPlaying = payload.currentlyPlaying;
      if ('playing' in payload)          state.playing          = payload.playing;
    },
  };
}

window.api.childWindow.onInit(async (data = {}) => {
  try {
    await initI18n();
    const { key, mode, index, title, currentSoundscape, isAllScenes, imageSrc, channelState, sbSceneId, musicSceneId } = data;

    const sendCall      = (method, ...args)    => window.api.childWindow.send(key, { kind: 'call', method, args });
    const sendSet       = (prop, value)        => window.api.childWindow.send(key, { kind: 'set', prop, value });
    const sendMixerCall = (method, ...args)    => window.api.childWindow.send(key, { kind: 'mixerCall', method, args });
    const sendMeta      = (type, payload = {}) => window.api.childWindow.send(key, { kind: 'meta', type, ...payload });

    const panelPrefix = mode === 'ambient' ? 'amb' : mode === 'soundboard' ? 'sb' : 'ch';
    const panelId = `${panelPrefix}-${index}`;

    const channelStub = makeChannelStub(channelState ?? {}, sendCall, sendSet);
    window.api.childWindow.onPush((payload) => channelStub.applyPush(payload));

    document.addEventListener('playlist-changed', (e) => {
      sendMeta('playlistChanged', { panelId, playlist: e.detail.playlist });
    });
    document.addEventListener('channel-play-state-changed', () => {
      sendMeta('playStateChanged');
    });

    const options = {
      title,
      panelId,
      mode,
      getChannel: () => channelStub,
    };

    if (mode === 'ambient') {
      const sceneId = musicSceneId ?? null;
      const resolveAmbient = (ss) => sceneId === null ? ss?.ambient : resolveScene(ss, sceneId)?.ambient;

      options.getSoundData = async () => {
        const ss = await Storage.getSoundscapes();
        return resolveAmbient(ss[currentSoundscape])?.[index]?.soundData;
      };
      options.saveSoundData = async (soundData) => {
        const ss = await Storage.getSoundscapes();
        const ambient = resolveAmbient(ss[currentSoundscape]);
        if (!ambient) return;
        if (!ambient[index]) {
          ambient[index] = { settings: { volume: 1, name: '' }, soundData: {} };
        }
        ambient[index].soundData = soundData;
        await Storage.setSoundscapes(ss);
      };
      options.onClear = async () => { sendMixerCall('clearAmbientChannel', index, sceneId); };
      options.imageSrc = imageSrc ?? '';
      options.onImagePick = async () => {
        const paths = await window.api.fs.openDialog({ images: true });
        if (!paths?.length) return null;
        const src = paths[0];
        sendMeta('saveAmbientImage', { src });
        return src;
      };
      options.onImageClear = async () => { sendMeta('saveAmbientImage', { src: '' }); };
      // "На всех сценах" is tied to the ACTIVE scene's globalAmbientChannels
      // (see mixer.js's setAllScenesAmbient — it always reads/writes
      // ss.ambient/ss.scenes, never a resolveScene()-resolved one), so it has
      // no meaning for a detached scene — hide it entirely, same reasoning
      // as ChannelConfigDialog's "На всех сценах" row.
      if (sceneId === null) {
        options.isAllScenes = isAllScenes ?? false;
        options.onAllScenesToggle = async (enable) => {
          if (enable) {
            const freshSoundscapes = await Storage.getSoundscapes();
            const freshSs = freshSoundscapes[currentSoundscape];
            const curScene = freshSs?.currentScene ?? 0;
            const hasOtherData = (freshSs?.scenes ?? []).some((scene, k) => {
              if (k === curScene) return false;
              const sd = scene.ambient?.[index]?.soundData;
              return (sd?.playlist?.length > 0) || !!sd?.source;
            });
            if (hasOtherData) {
              if (!await showConfirm(t('playlist.allScenesConfirm'))) return false;
            }
          }
          sendMixerCall('setAllScenesAmbient', index, enable);
          return true;
        };
      }
    } else if (mode === 'soundboard') {
      options.getSoundData = async () => {
        const ss = await Storage.getSoundscapes();
        const sb = resolveSoundboardArray(ss[currentSoundscape], sbSceneId ?? null);
        return sb?.[index]?.soundData;
      };
      options.saveSoundData = async (soundData) => {
        const ss = await Storage.getSoundscapes();
        const sb = resolveSoundboardArray(ss[currentSoundscape], sbSceneId ?? null);
        if (sb) {
          sb[index].soundData = soundData;
          await Storage.setSoundscapes(ss);
        }
      };
    } else {
      // mode === 'channel' — regular music channel
      const sceneId = musicSceneId ?? null;
      const resolveChannels = (ss) => sceneId === null ? ss?.channels : resolveScene(ss, sceneId)?.channels;

      options.getSoundData = async () => {
        const ss = await Storage.getSoundscapes();
        return resolveChannels(ss[currentSoundscape])?.[index]?.soundData;
      };
      options.saveSoundData = async (soundData) => {
        const ss = await Storage.getSoundscapes();
        const chData = resolveChannels(ss[currentSoundscape])?.[index];
        if (!chData) return;
        chData.soundData = soundData;
        if (!chData.settings.name && soundData.playlist?.length > 0) {
          const lbl  = soundData.playlist[0].label ?? '';
          const name = lbl.startsWith('/') ? (lbl.split('/')[1] ?? '') : lbl.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
          chData.settings.name = name;
          sendMeta('nameInferred', { name });
        }
        await Storage.setSoundscapes(ss);
      };
    }

    new PlaylistDialog(options).open();
  } catch (err) {
    console.error('[playlist-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
