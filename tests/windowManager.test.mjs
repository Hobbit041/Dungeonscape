import { test } from 'node:test';
import assert from 'node:assert/strict';
import wmModule from '../windowManager.js';
const { createWindowManager } = wmModule;

/** Fake BrowserWindow-like object satisfying the subset of the API
 *  windowManager.js relies on, with manual event-firing helpers for tests. */
function makeFakeWindow() {
  const onceHandlers = {};
  const onHandlers = {};
  const win = {
    destroyed: false,
    focusCalls: 0,
    sent: [],
    webContents: {
      once(event, cb) { (onceHandlers[event] ??= []).push(cb); },
      send(channel, payload) { win.sent.push([channel, payload]); },
      _fire(event) {
        const cbs = onceHandlers[event] ?? [];
        onceHandlers[event] = [];
        cbs.forEach(cb => cb());
      },
    },
    on(event, cb) { (onHandlers[event] ??= []).push(cb); },
    focus() { win.focusCalls++; },
    close() {
      if (win.destroyed) return;
      win.destroyed = true;
      (onHandlers.closed ?? []).forEach(cb => cb());
    },
    isDestroyed() { return win.destroyed; },
  };
  return win;
}

test('open() creates a window via the injected factory and registers it under the key', () => {
  const created = [];
  const wm = createWindowManager({
    createWindow: (key, options) => {
      created.push({ key, options });
      return makeFakeWindow();
    },
  });

  const win = wm.open('settings', { file: 'settings.html' });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], { key: 'settings', options: { file: 'settings.html' } });
  assert.equal(wm.get('settings'), win);
  assert.equal(wm.has('settings'), true);
});

test('open() with an already-open key focuses the existing window instead of creating a new one', () => {
  let createCount = 0;
  const wm = createWindowManager({
    createWindow: () => { createCount++; return makeFakeWindow(); },
  });

  const first  = wm.open('settings', {});
  const second = wm.open('settings', {});

  assert.equal(createCount, 1);
  assert.equal(second, first);
  assert.equal(first.focusCalls, 1);
});

test('two different keys create two independent windows', () => {
  let createCount = 0;
  const wm = createWindowManager({ createWindow: () => { createCount++; return makeFakeWindow(); } });

  wm.open('settings', {});
  wm.open('channelConfig:3', {});

  assert.equal(createCount, 2);
  assert.equal(wm.getAll().length, 2);
});

test('open() with data sends child-window-init once the window finishes loading', () => {
  const wm = createWindowManager({ createWindow: () => makeFakeWindow() });
  const win = wm.open('missingFiles', { file: 'missingFiles.html', data: { entries: [1, 2, 3] } });

  assert.deepEqual(win.sent, []); // not sent yet — waiting on did-finish-load
  win.webContents._fire('did-finish-load');
  assert.deepEqual(win.sent, [['child-window-init', { entries: [1, 2, 3] }]]);
});

test('open() without data never sends child-window-init', () => {
  const wm = createWindowManager({ createWindow: () => makeFakeWindow() });
  const win = wm.open('settings', { file: 'settings.html' });

  win.webContents._fire('did-finish-load');
  assert.deepEqual(win.sent, []);
});

test('close() closes the window and removes it from the registry', () => {
  const wm = createWindowManager({ createWindow: () => makeFakeWindow() });
  const win = wm.open('settings', {});

  wm.close('settings');

  assert.equal(win.destroyed, true);
  assert.equal(wm.has('settings'), false);
  assert.equal(wm.get('settings'), undefined);
});

test('close() on an unknown key is a no-op', () => {
  const wm = createWindowManager({ createWindow: () => makeFakeWindow() });
  assert.doesNotThrow(() => wm.close('nonexistent'));
});

test('a window closed by the user (not via wm.close) is still removed from the registry', () => {
  const wm = createWindowManager({ createWindow: () => makeFakeWindow() });
  const win = wm.open('settings', {});

  win.close(); // simulates the user clicking the native OS close button

  assert.equal(wm.has('settings'), false);
});

test('reopening a key after the user closed its window creates a fresh window', () => {
  let createCount = 0;
  const wm = createWindowManager({ createWindow: () => { createCount++; return makeFakeWindow(); } });

  const first = wm.open('settings', {});
  first.close();
  wm.open('settings', {});

  assert.equal(createCount, 2);
});

test('closeAll() closes every open window and empties the registry', () => {
  const wm = createWindowManager({ createWindow: () => makeFakeWindow() });
  const a = wm.open('settings', {});
  const b = wm.open('channelConfig:3', {});

  wm.closeAll();

  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, true);
  assert.equal(wm.getAll().length, 0);
});

test('closeAll() on an empty manager does not throw', () => {
  const wm = createWindowManager({ createWindow: () => makeFakeWindow() });
  assert.doesNotThrow(() => wm.closeAll());
});
