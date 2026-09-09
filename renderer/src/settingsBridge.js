/**
 * settingsBridge.js — runs in the MAIN window's renderer.
 * Wires a detached Settings window's RPC messages onto the real MixerUI
 * instance (getTarget() resolves to `this` from mixerUI.js's
 * _openSettingsPanel()) and its sbLayout/midi/mixer sub-objects.
 *
 * Unlike the other bridges, Settings touches no live audio object and no
 * per-instance index — one key ('settings'), one target root. Every
 * control is either a call to a method somewhere under that root
 * (this._applyTrackCount(), this.sbLayout.setGridSize(), ...) or a plain
 * property write (this.midi.ledEnabled = ..., this._webServerRunning = ...)
 * — so both `call` and `set` resolve an arbitrary dotted path under the
 * root, unlike channelConfigBridge.js's `call`, which only ever invokes a
 * method directly on the resolved channel. There's no `meta` kind here:
 * every Settings action reduces to "call a method" or "write a field," with
 * no caller-specific side effect that needs a hand-rolled hook.
 *
 * Message shapes sent by renderer/windows/settings-entry.js:
 *   {kind:'call', method, args}  — resolves all but the last dot-segment of
 *                                   `method` under the target, then calls
 *                                   the final segment as a method, bound to
 *                                   whatever object it was found on (so
 *                                   'sbLayout.setGridSize' correctly runs
 *                                   with `this` === the real sbLayout, not
 *                                   the MixerUI instance).
 *   {kind:'set', prop, value}    — same dotted-path walk, assigns the leaf.
 */
import { onChildWindowMessage } from './childWindowHost.js';

function _resolveParent(root, parts) {
  let obj = root;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
  }
  return obj;
}

export function bindSettingsBridge(key, { getTarget }, register = onChildWindowMessage) {
  register(key, (msg) => {
    if (msg.kind === 'call') {
      const root = getTarget();
      if (!root) return;
      const parts = msg.method.split('.');
      const obj = _resolveParent(root, parts);
      if (!obj) return;
      const fn = obj[parts[parts.length - 1]];
      if (typeof fn !== 'function') {
        console.error(`[settingsBridge] ${key} unknown method`, msg.method);
        return;
      }
      fn.apply(obj, msg.args);
      return;
    }

    if (msg.kind === 'set') {
      const root = getTarget();
      if (!root) return;
      const parts = msg.prop.split('.');
      const obj = _resolveParent(root, parts);
      if (obj) obj[parts[parts.length - 1]] = msg.value;
    }
  });
}
