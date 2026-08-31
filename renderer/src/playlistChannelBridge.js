/**
 * playlistChannelBridge.js — runs in the MAIN window's renderer.
 * Wires a detached PlaylistDialog window's RPC messages onto a live channel
 * (a regular music channel, an ambient channel, or a soundboard button —
 * whichever getChannel() resolves to for this key) and, for the two
 * mixer-level actions ambient's PlaylistDialog can trigger (onClear,
 * onAllScenesToggle), onto the mixer itself.
 *
 * Message shapes sent by renderer/windows/playlist-entry.js:
 *   {kind:'call', method, args}       — ch[method](...args)
 *   {kind:'set', prop, value}         — ch[prop] = value
 *                                        (prop 'settings.soundData' is the
 *                                        one nested exception: ch.settings.soundData = value)
 *   {kind:'mixerCall', method, args}  — mixer[method](...args)
 *   {kind:'meta', type, ...}          — 'playlistChanged'/'playStateChanged'
 *                                        are handled here (missing-file
 *                                        highlight bookkeeping and play/pause
 *                                        icon refresh, both normally driven by
 *                                        CustomEvents that don't cross the
 *                                        window boundary); anything else is
 *                                        looked up in extraHandlers, for the
 *                                        few callbacks that are specific to
 *                                        one caller (channel-name inference
 *                                        in ChannelConfigDialog, ambient image
 *                                        persistence in mixerUI.js).
 */
import { onChildWindowMessage } from './childWindowHost.js';

export function bindPlaylistChannelBridge(key, { getChannel, mixer, extraHandlers = {} }, register = onChildWindowMessage) {
  register(key, (msg) => {
    if (msg.kind === 'call') {
      const ch = getChannel();
      if (!ch) return;
      const fn = ch[msg.method];
      if (typeof fn !== 'function') {
        console.error(`[playlistChannelBridge] ${key} unknown channel method`, msg.method);
        return;
      }
      fn.apply(ch, msg.args);
      return;
    }

    if (msg.kind === 'set') {
      const ch = getChannel();
      if (!ch) return;
      if (msg.prop === 'settings.soundData') {
        if (ch.settings) ch.settings.soundData = msg.value;
      } else {
        ch[msg.prop] = msg.value;
      }
      return;
    }

    if (msg.kind === 'mixerCall') {
      const fn = mixer?.[msg.method];
      if (typeof fn !== 'function') {
        console.error(`[playlistChannelBridge] ${key} unknown mixer method`, msg.method);
        return;
      }
      fn.apply(mixer, msg.args);
      return;
    }

    if (msg.kind === 'meta') {
      if (msg.type === 'playlistChanged')  { mixer?.ui?._onPlaylistChanged(msg.panelId, msg.playlist); return; }
      if (msg.type === 'playStateChanged') { mixer?.ui?.updatePlayState(); return; }
      extraHandlers[msg.type]?.(msg);
    }
  });
}
