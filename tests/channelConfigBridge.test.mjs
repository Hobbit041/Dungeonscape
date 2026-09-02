import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindChannelConfigBridge } from '../renderer/src/channelConfigBridge.js';

function makeFakeRegister() {
  let handler;
  const register = (key, h) => { handler = h; register.lastKey = key; };
  register.fire = (msg) => handler(msg);
  return register;
}

test('call kind invokes the named method on the resolved channel', () => {
  const calls = [];
  const ch = { setPan(v) { calls.push(['setPan', v]); } };
  const register = makeFakeRegister();

  bindChannelConfigBridge('channelConfig:0', { getChannel: () => ch, mixer: {} }, register);
  register.fire({ kind: 'call', method: 'setPan', args: [0.5] });

  assert.deepEqual(calls, [['setPan', 0.5]]);
});

test('call kind on an unknown method logs an error and does not throw', () => {
  const ch = {};
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:0', { getChannel: () => ch, mixer: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'call', method: 'nope', args: [] }));
});

test('set kind assigns a top-level property on the resolved channel', () => {
  const ch = { foo: 0 };
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'set', prop: 'foo', value: 42 });

  assert.equal(ch.foo, 42);
});

test('set kind with a one-level dotted prop assigns into the nested object', () => {
  const ch = { settings: { imageSrc: '' } };
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'set', prop: 'settings.imageSrc', value: '/a.png' });

  assert.equal(ch.settings.imageSrc, '/a.png');
});

test('set kind with a two-level dotted prop assigns into the doubly-nested object', () => {
  const ch = { settings: { playbackRate: { rate: 1, preservePitch: 1, random: 0 } } };
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:0', { getChannel: () => ch, mixer: {} }, register);

  register.fire({ kind: 'set', prop: 'settings.playbackRate.rate', value: 1.5 });

  assert.equal(ch.settings.playbackRate.rate, 1.5);
  assert.equal(ch.settings.playbackRate.preservePitch, 1, 'sibling fields must be untouched');
});

test('set kind is a no-op when an intermediate segment is missing', () => {
  const ch = {};
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:0', { getChannel: () => ch, mixer: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'set', prop: 'settings.playbackRate.rate', value: 1.5 }));
});

test('mixerCall kind invokes the named method on the mixer', () => {
  const calls = [];
  const mixer = { clearChannel(i) { calls.push(i); } };
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:2', { getChannel: () => null, mixer }, register);

  register.fire({ kind: 'mixerCall', method: 'clearChannel', args: [2] });

  assert.deepEqual(calls, [2]);
});

test('mixerCall kind on an unknown method logs an error and does not throw', () => {
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:2', { getChannel: () => null, mixer: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'mixerCall', method: 'nope', args: [] }));
});

test('meta kind dispatches to the matching extraHandler', () => {
  const calls = [];
  const register = makeFakeRegister();
  bindChannelConfigBridge(
    'channelConfig:2',
    { getChannel: () => null, mixer: {}, extraHandlers: { openPlaylist: (msg) => calls.push(msg) } },
    register
  );

  register.fire({ kind: 'meta', type: 'openPlaylist' });

  assert.equal(calls.length, 1);
});

test('meta kind with no matching extraHandler is a safe no-op', () => {
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:2', { getChannel: () => null, mixer: {}, extraHandlers: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'meta', type: 'unknown' }));
});

test('call/set kinds are a no-op when getChannel() returns null', () => {
  const register = makeFakeRegister();
  bindChannelConfigBridge('channelConfig:0', { getChannel: () => null, mixer: {} }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'call', method: 'setPan', args: [0] }));
  assert.doesNotThrow(() => register.fire({ kind: 'set', prop: 'settings.imageSrc', value: 'x' }));
});
