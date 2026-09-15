/**
 * windowManager.js
 * Registry of child (detached) BrowserWindows, keyed by an opaque string
 * (e.g. 'settings', 'channelConfig:3'). Window creation itself is injected
 * via `createWindow` so this module's bookkeeping — dedupe/open/close/
 * broadcast — is unit-testable without a running Electron app.
 * See tests/windowManager.test.mjs.
 */

function createWindowManager({ createWindow, onClosed }) {
  const windows = new Map(); // key -> window-like object

  function open(key, options = {}) {
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      // Refresh with the caller's freshly-built data instead of leaving the
      // window showing whatever it had when first created — e.g. the
      // missing-files dialog recomputes `entries` each time it's triggered,
      // and a stale list would let the user Apply against data they can no
      // longer see. did-finish-load already fired for this window, so send
      // directly rather than waiting on it again.
      if (options.data !== undefined) {
        existing.webContents.send('child-window-init', options.data);
      }
      return existing;
    }

    const win = createWindow(key, options);
    windows.set(key, win);

    if (options.data !== undefined) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('child-window-init', options.data);
      });
    }

    // Forget this window as soon as it STARTS closing, not only once fully
    // destroyed — Electron fires 'close' synchronously when .close() (or a
    // user's native close) is requested, well before the window is actually
    // torn down and 'closed' fires. Without this, a fast reattach-then-
    // redetach of the same key (e.g. a scene.id) could still find this
    // entry here with isDestroyed() still false, so open() would push data
    // to (or just focus) a window that's already on its way out instead of
    // creating its proper replacement.
    win.once('close', () => {
      if (windows.get(key) === win) windows.delete(key);
    });

    win.on('closed', () => {
      if (windows.get(key) === win) windows.delete(key);
      onClosed?.(key);
    });

    return win;
  }

  function close(key) {
    const win = windows.get(key);
    if (win && !win.isDestroyed()) win.close();
  }

  function get(key) {
    return windows.get(key);
  }

  function has(key) {
    const win = windows.get(key);
    return !!win && !win.isDestroyed();
  }

  function getAll() {
    return [...windows.values()];
  }

  function keys() {
    return [...windows.keys()];
  }

  function closeAll() {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.close();
    }
  }

  return { open, close, get, has, getAll, keys, closeAll };
}

module.exports = { createWindowManager };
