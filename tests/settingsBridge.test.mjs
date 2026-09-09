import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindSettingsBridge } from '../renderer/src/settingsBridge.js';

function makeFakeRegister() {
  let handler;
  const register = (key, h) => { handler = h; register.lastKey = key; };
  register.fire = (msg) => handler(msg);
  return register;
}

test('call kind invokes a flat method on the target, bound to the target', () => {
  const calls = [];
  const target = { _restoreFaderWindowSize() { calls.push(this === target); } };
  const register = makeFakeRegister();

  bindSettingsBridge('settings', { getTarget: () => target }, register);
  register.fire({ kind: 'call', method: '_restoreFaderWindowSize', args: [] });

  assert.deepEqual(calls, [true]);
});

test('call kind invokes a dotted-path method, bound to the resolved sub-object', () => {
  const calls = [];
  const sbLayout = { setGridSize(cols, rows) { calls.push([this === sbLayout, cols, rows]); } };
  const target = { sbLayout };
  const register = makeFakeRegister();

  bindSettingsBridge('settings', { getTarget: () => target }, register);
  register.fire({ kind: 'call', method: 'sbLayout.setGridSize', args: [6, 5] });

  assert.deepEqual(calls, [[true, 6, 5]]);
});

test('call kind on an unknown flat method logs an error and does not throw', () => {
  const target = {};
  const register = makeFakeRegister();
  bindSettingsBridge('settings', { getTarget: () => target }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'call', method: 'nope', args: [] }));
});

test('call kind is a safe no-op when a dotted path has a missing intermediate segment', () => {
  const target = {};
  const register = makeFakeRegister();
  bindSettingsBridge('settings', { getTarget: () => target }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'call', method: 'sbLayout.setGridSize', args: [6, 5] }));
});

test('set kind assigns a flat property on the target', () => {
  const target = { _webServerRunning: false };
  const register = makeFakeRegister();
  bindSettingsBridge('settings', { getTarget: () => target }, register);

  register.fire({ kind: 'set', prop: '_webServerRunning', value: true });

  assert.equal(target._webServerRunning, true);
});

test('set kind assigns a one-level dotted property on the target', () => {
  const midi = { ledEnabled: false };
  const target = { midi };
  const register = makeFakeRegister();
  bindSettingsBridge('settings', { getTarget: () => target }, register);

  register.fire({ kind: 'set', prop: 'midi.ledEnabled', value: true });

  assert.equal(midi.ledEnabled, true);
});

test('set kind is a safe no-op when an intermediate segment is missing', () => {
  const target = {};
  const register = makeFakeRegister();
  bindSettingsBridge('settings', { getTarget: () => target }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'set', prop: 'midi.ledEnabled', value: true }));
});

test('call/set kinds are a no-op when getTarget() returns null', () => {
  const register = makeFakeRegister();
  bindSettingsBridge('settings', { getTarget: () => null }, register);

  assert.doesNotThrow(() => register.fire({ kind: 'call', method: '_restoreFaderWindowSize', args: [] }));
  assert.doesNotThrow(() => register.fire({ kind: 'set', prop: '_webServerRunning', value: true }));
});
