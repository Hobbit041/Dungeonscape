/**
 * windowManager.js
 * Registry of child (detached) BrowserWindows, keyed by an opaque string
 * (e.g. 'settings', 'channelConfig:3'). Window creation itself is injected
 * via `createWindow` so this module's bookkeeping — dedupe/open/close/
 * broadcast — is unit-testable without a running Electron app.
 * See tests/windowManager.test.mjs.
 */

function createWindowManager({ createWindow }) {
  const windows = new Map(); // key -> window-like object

  function open(key, options = {}) {
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return existing;
    }

    const win = createWindow(key, options);
    windows.set(key, win);

    if (options.data !== undefined) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('child-window-init', options.data);
      });
    }

    win.on('closed', () => {
      if (windows.get(key) === win) windows.delete(key);
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

  function closeAll() {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.close();
    }
  }

  return { open, close, get, has, getAll, closeAll };
}

module.exports = { createWindowManager };
