/**
 * channelConfigBridge.js — runs in the MAIN window's renderer.
 * Wires a detached ChannelConfigDialog/SoundboardConfigDialog window's RPC
 * messages onto a live channel (a regular music channel or a soundboard
 * button — whichever getChannel() resolves to) and, for mixer-level actions
 * (clearChannel/clearSoundboardButton, setAllScenesMusic/
 * setAllScenesSoundboard), onto the mixer itself.
 *
 * Message shapes sent by renderer/windows/channelConfig-entry.js:
 *   {kind:'call', method, args}       — ch[method](...args)
 *   {kind:'set', prop, value}         — assigns into ch at an arbitrary
 *                                        dotted path (e.g. 'settings.imageSrc'
 *                                        or the doubly-nested
 *                                        'settings.playbackRate.rate') —
 *                                        walks every segment but the last,
 *                                        then assigns the leaf. A missing
 *                                        intermediate segment is a silent
 *                                        no-op rather than a crash, since the
 *                                        detached window's settings stub is
 *                                        write-only and doesn't guarantee the
 *                                        same shape as the real channel ahead
 *                                        of the first write to each branch.
 *   {kind:'mixerCall', method, args}  — mixer[method](...args)
 *   {kind:'meta', type, ...}          — entirely caller-specific, looked up
 *                                        in extraHandlers (openPlaylist,
 *                                        imageChanged, nameChanged,
 *                                        playlistChanged — see mixerUI.js's
 *                                        two call sites). Unlike
 *                                        playlistChannelBridge.js, no meta
 *                                        type is handled centrally here — the
 *                                        two dialogs' meta needs don't
 *                                        overlap enough to share code.
 */
import { onChildWindowMessage } from './childWindowHost.js';

export function bindChannelConfigBridge(key, { getChannel, mixer, extraHandlers = {} }, register = onChildWindowMessage) {
  register(key, (msg) => {
    if (msg.kind === 'call') {
      const ch = getChannel();
      if (!ch) return;
      const fn = ch[msg.method];
      if (typeof fn !== 'function') {
        console.error(`[channelConfigBridge] ${key} unknown channel method`, msg.method);
        return;
      }
      fn.apply(ch, msg.args);
      return;
    }

    if (msg.kind === 'set') {
      const ch = getChannel();
      if (!ch) return;
      const parts = msg.prop.split('.');
      let obj = ch;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj?.[parts[i]];
      }
      if (obj) obj[parts[parts.length - 1]] = msg.value;
      return;
    }

    if (msg.kind === 'mixerCall') {
      const fn = mixer?.[msg.method];
      if (typeof fn !== 'function') {
        console.error(`[channelConfigBridge] ${key} unknown mixer method`, msg.method);
        return;
      }
      fn.apply(mixer, msg.args);
      return;
    }

    if (msg.kind === 'meta') {
      extraHandlers[msg.type]?.(msg);
    }
  });
}
