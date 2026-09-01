import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindPlaylistChannelBridge } from '../renderer/src/playlistChannelBridge.js';

/** Captures the handler passed to register(key, handler) so the test can
 *  invoke it directly, standing in for the real onChildWindowMessage. */
function makeFakeRegister() {
  let handler;
  const register = (key, h) => { handler = h; register.lastKey = key; };
  register.fire = (msg) => handler(msg);
  return register;
}

test('call kind invokes the named method on the resolved channel', () => {
  const calls = [];
  const ch = { next(n) { calls.push(['next', n]); } };
  const register = makeFakeRegister();

  bindPlaylistChannelBridge('playlist:ch:0', { getChannel: () => ch, mixer: {} }, register);
  register.fire({ kind: 'call', method: 'next', args: [3] });

  assert.deepEqual(calls, [['next', 3]]);
});

test('call kind on an unknown method logs an error and does not throw', () => {
  const ch = {};
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:0', { getChannel: () => ch, mixer: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'call', method: 'nope', args: [] }));
});

test('call "next" on a channel with no next() sets currentlyPlaying instead (AmbientChannel has no next/_crossfadeTo)', () => {
  const ch = { currentlyPlaying: 0 };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:amb:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'call', method: 'next', args: [2] });

  assert.equal(ch.currentlyPlaying, 2);
});

test('call "_crossfadeTo" on a channel with no _crossfadeTo() sets currentlyPlaying and calls play()', () => {
  const playCalls = [];
  const ch = { currentlyPlaying: 0, play() { playCalls.push(this.currentlyPlaying); } };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:amb:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'call', method: '_crossfadeTo', args: [2, 3000] });

  assert.equal(ch.currentlyPlaying, 2);
  assert.deepEqual(playCalls, [2]);
});

test('call "next"/"_crossfadeTo" still use the real method when the channel actually has one', () => {
  const calls = [];
  const ch = {
    currentlyPlaying: 0,
    next(n) { calls.push(['next', n]); },
    _crossfadeTo(n, ms) { calls.push(['_crossfadeTo', n, ms]); },
  };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'call', method: 'next', args: [1] });
  register.fire({ kind: 'call', method: '_crossfadeTo', args: [2, 3000] });

  assert.deepEqual(calls, [['next', 1], ['_crossfadeTo', 2, 3000]]);
  assert.equal(ch.currentlyPlaying, 0, 'the real methods own their currentlyPlaying update, the bridge must not also set it');
});

test('set kind assigns a top-level property on the resolved channel', () => {
  const ch = { sourceArray: [] };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'set', prop: 'sourceArray', value: ['a', 'b'] });

  assert.deepEqual(ch.sourceArray, ['a', 'b']);
});

test('set kind with prop "settings.soundData" assigns into ch.settings.soundData', () => {
  const ch = { settings: {} };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'set', prop: 'settings.soundData', value: { playlist: [] } });

  assert.deepEqual(ch.settings.soundData, { playlist: [] });
});

test('set kind with prop "settings.soundData" is a no-op when ch.settings is absent', () => {
  const ch = {};
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:0', { getChannel: () => ch, mixer: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'set', prop: 'settings.soundData', value: {} }));
});

test('mixerCall kind invokes the named method on the mixer', () => {
  const calls = [];
  const mixer = { clearAmbientChannel(i) { calls.push(i); } };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:amb:2', { getChannel: () => null, mixer }, register);

  register.fire({ kind: 'mixerCall', method: 'clearAmbientChannel', args: [2] });

  assert.deepEqual(calls, [2]);
});

test('meta playlistChanged calls mixer.ui._onPlaylistChanged with panelId and playlist', () => {
  const calls = [];
  const mixer = { ui: { _onPlaylistChanged(panelId, playlist) { calls.push([panelId, playlist]); } } };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:5', { getChannel: () => null, mixer }, register);

  register.fire({ kind: 'meta', type: 'playlistChanged', panelId: 'ch-5', playlist: [{ path: 'a' }] });

  assert.deepEqual(calls, [['ch-5', [{ path: 'a' }]]]);
});

test('meta playStateChanged calls mixer.ui.updatePlayState', () => {
  let called = false;
  const mixer = { ui: { updatePlayState() { called = true; } } };
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:5', { getChannel: () => null, mixer }, register);

  register.fire({ kind: 'meta', type: 'playStateChanged' });

  assert.equal(called, true);
});

test('meta with an unrecognized type falls through to extraHandlers', () => {
  const calls = [];
  const register = makeFakeRegister();
  bindPlaylistChannelBridge(
    'playlist:amb:2',
    { getChannel: () => null, mixer: {}, extraHandlers: { saveAmbientImage: (msg) => calls.push(msg.src) } },
    register
  );

  register.fire({ kind: 'meta', type: 'saveAmbientImage', src: '/img.png' });

  assert.deepEqual(calls, ['/img.png']);
});

test('call/set kinds are a no-op when getChannel() returns null', () => {
  const register = makeFakeRegister();
  bindPlaylistChannelBridge('playlist:ch:0', { getChannel: () => null, mixer: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'call', method: 'play', args: [] }));
  assert.doesNotThrow(() => register.fire({ kind: 'set', prop: 'currentlyPlaying', value: 1 }));
});
