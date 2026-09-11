/**
 * childWindowHost.js — runs only in the MAIN window's renderer.
 * Relays messages sent by detached child windows (settings, channel config,
 * missing-files, etc.) to whichever local handler registered interest in
 * that window's key. One handler per key — a later onChildWindowMessage()
 * call for the same key replaces the previous one (idempotent re-registration,
 * e.g. every time _runMissingFilesCheck() opens the dialog again).
 */
const _handlers = new Map();

export function onChildWindowMessage(key, handler) {
  _handlers.set(key, handler);
}

/**
 * Invokes the handler registered for `key` directly, bypassing the IPC
 * path `initChildWindowHost()` uses for real child windows — used by
 * webBridge.js to feed web-originated scene commands into the exact same
 * dispatch a real detached window's own messages go through, since both
 * run in this same renderer process.
 */
export function dispatchChildWindowMessage(key, payload) {
  const handler = _handlers.get(key);
  if (handler) handler(payload);
}

export function initChildWindowHost() {
  window.api.childWindow.onMessage((key, payload) => {
    const handler = _handlers.get(key);
    if (handler) handler(payload);
  });
}
