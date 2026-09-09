import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScene } from '../renderer/src/sceneUtils.js';

test('returns null when ss is missing', () => {
  assert.equal(resolveScene(null, 'abc'), null);
  assert.equal(resolveScene(undefined, 'abc'), null);
});

test('returns null when no scene matches the given id', () => {
  const ss = { scenes: [{ id: 'a', name: 'Scene 1' }] };
  assert.equal(resolveScene(ss, 'nonexistent'), null);
});

test('returns null when ss.scenes is missing entirely', () => {
  assert.equal(resolveScene({}, 'abc'), null);
});

test('returns the matching scene object by stable id', () => {
  const sceneA = { id: 'a', name: 'Scene A', channels: [1], ambient: [2] };
  const sceneB = { id: 'b', name: 'Scene B', channels: [3], ambient: [4] };
  const ss = { scenes: [sceneA, sceneB] };
  assert.equal(resolveScene(ss, 'b'), sceneB);
});

test('finds the scene by id regardless of array position (not index-based)', () => {
  const target = { id: 'target', name: 'Target' };
  const ss = { scenes: [{ id: 'other1' }, { id: 'other2' }, target] };
  assert.equal(resolveScene(ss, 'target'), target);
});
