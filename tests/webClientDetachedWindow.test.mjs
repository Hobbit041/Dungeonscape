import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLockedWidthResize } from '../web-client/src/detachedWindow.js';

test('dy=0 returns the starting height unchanged', () => {
  const r = computeLockedWidthResize({ startHeight: 640, top: 0, dy: 0, canvasHeight: 5000, minHeight: 300 });
  assert.equal(r.height, 640);
});

test('grows with positive dy', () => {
  const r = computeLockedWidthResize({ startHeight: 640, top: 0, dy: 100, canvasHeight: 5000, minHeight: 300 });
  assert.equal(r.height, 740);
});

test('shrinks with negative dy, floored at minHeight', () => {
  const r = computeLockedWidthResize({ startHeight: 640, top: 0, dy: -1000, canvasHeight: 5000, minHeight: 300 });
  assert.equal(r.height, 300);
});

test('caps at the canvas bottom edge', () => {
  const r = computeLockedWidthResize({ startHeight: 640, top: 100, dy: 5000, canvasHeight: 1000, minHeight: 300 });
  assert.equal(r.height, 900); // canvasHeight - top
});

test('minHeight floor takes priority over the canvas cap when they conflict', () => {
  const r = computeLockedWidthResize({ startHeight: 640, top: 950, dy: 0, canvasHeight: 1000, minHeight: 300 });
  // canvas-derived cap would be 50, but the floor wins
  assert.equal(r.height, 300);
});
