/**
 * channelConfig-entry.js — bootstrap for the standalone
 * ChannelConfigDialog/SoundboardConfigDialog window.
 *
 * Both dialog classes are completely unchanged internally except the
 * mechanical adaptations from Task 1/2 (drop drag, close via window.close(),
 * open the nested Playlist via mixer.openChannelPlaylist()/
 * openSoundboardPlaylist() instead of an inline bindPlaylistChannelBridge()
 * call, dispatch a CustomEvent instead of touching the main window's own DOM
 * for image/name updates). Almost everything else these dialogs do already
 * goes through Storage.get/setSoundscapes(), which is IPC-transparent and
 * needs no bridging at all — open() calls it directly here exactly as it
 * always has.
 *
 * What's behind `this.channel`/`this.soundboard` and `this.mixer` in this
 * window is a stub: every write forwards to the real object in the main
 * window over child-window-message, handled by
 * renderer/src/channelConfigBridge.js. The settings stub is write-only (see
 * this plan's header for why that's sufficient) — it starts near-empty and
 * is filled in lazily by whatever the dialog happens to write.
 *
 * The three CustomEvents these dialogs dispatch on their own document
 * ('playlist-changed', 'channel-image-changed'/'soundboard-image-changed',
 * 'soundboard-name-changed') don't cross the window boundary on their own —
 * this file re-dispatches them as 'meta' RPC messages instead, handled by
 * whichever extraHandler mixerUI.js registered for this key.
 */
import { initI18n } from '../src/i18n.js';
import { ChannelConfigDialog }    from '../src/channelConfigDialog.js';
import { SoundboardConfigDialog } from '../src/soundboardConfigDialog.js';

function makePlaybackRateProxy(sendSet, initial) {
  const state = { rate: 1, preservePitch: 1, random: 0, ...initial };
  return new Proxy(state, {
    set(obj, prop, value) {
      obj[prop] = value;
      sendSet(`settings.playbackRate.${String(prop)}`, value);
      return true;
    },
  });
}

function makeSettingsStub(sendSet) {
  const state = { playbackRate: makePlaybackRateProxy(sendSet) };
  return new Proxy(state, {
    set(obj, prop, value) {
      if (prop === 'playbackRate') {
        obj.playbackRate = makePlaybackRateProxy(sendSet, value);
      } else {
        obj[prop] = value;
      }
      sendSet(`settings.${String(prop)}`, value);
      return true;
    },
  });
}

window.api.childWindow.onInit(async (data = {}) => {
  try {
    await initI18n();
    const { key, mode, index, currentSoundscape, sourceArrayLength } = data;

    const sendCall      = (method, ...args) => window.api.childWindow.send(key, { kind: 'call', method, args });
    const sendSet       = (prop, value)     => window.api.childWindow.send(key, { kind: 'set', prop, value });
    const sendMixerCall = (method, ...args) => window.api.childWindow.send(key, { kind: 'mixerCall', method, args });
    const sendMeta      = (type, payload = {}) => window.api.childWindow.send(key, { kind: 'meta', type, ...payload });

    document.addEventListener('playlist-changed', (e) => {
      sendMeta('playlistChanged', { panelId: e.detail.panelId, playlist: e.detail.playlist });
    });
    document.addEventListener('channel-image-changed', (e) => sendMeta('imageChanged', e.detail));
    document.addEventListener('soundboard-image-changed', (e) => sendMeta('imageChanged', e.detail));
    document.addEventListener('soundboard-name-changed', (e) => sendMeta('nameChanged', e.detail));

    if (mode === 'soundboard') {
      const channelStub = {
        setVolume(v) { sendCall('setVolume', v); },
        settings: makeSettingsStub(sendSet),
      };
      const mixerStub = {
        currentSoundscape,
        soundboard: { channels: { [index]: channelStub } },
        clearSoundboardButton(i)          { sendMixerCall('clearSoundboardButton', i); },
        setAllScenesSoundboard(i, enable) { sendMixerCall('setAllScenesSoundboard', i, enable); },
        openSoundboardPlaylist(i)         { sendMeta('openPlaylist'); },
      };
      new SoundboardConfigDialog(channelStub, mixerStub, index).open();
    } else {
      const channelStub = {
        sourceArray: new Array(sourceArrayLength ?? 0),
        setPan(v) { sendCall('setPan', v); },
        settings: makeSettingsStub(sendSet),
      };
      const mixerStub = {
        currentSoundscape,
        channels: { [index]: channelStub },
        clearChannel(i)             { sendMixerCall('clearChannel', i); },
        setAllScenesMusic(i, enable) { sendMixerCall('setAllScenesMusic', i, enable); },
        openChannelPlaylist(i)      { sendMeta('openPlaylist'); },
      };
      new ChannelConfigDialog(channelStub, mixerStub, index).open();
    }
  } catch (err) {
    console.error('[channelConfig-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
