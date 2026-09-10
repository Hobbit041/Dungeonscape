import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_WIDTH, BASE_HEIGHT, MIN_WIDTH, MIN_HEIGHT,
  computeResizedSize, computeDraggedPosition,
} from '../web-client/src/desktopWindow.js';

test('base constants match main.js\'s own startup window size', () => {
  assert.equal(BASE_WIDTH, 1120);
  assert.equal(BASE_HEIGHT, 690);
  assert.equal(MIN_WIDTH, 1000);
  assert.equal(MIN_HEIGHT, 559);
});

test('computeResizedSize with dx=0 returns the base size unchanged', () => {
  const r = computeResizedSize({ startWidth: BASE_WIDTH, left: 0, top: 0, dx: 0, canvasWidth: 5000, canvasHeight: 5000 });
  assert.deepEqual(r, { width: 1120, height: 690 });
});

test('computeResizedSize grows proportionally', () => {
  const r = computeResizedSize({ startWidth: BASE_WIDTH, left: 0, top: 0, dx: 200, canvasWidth: 5000, canvasHeight: 5000 });
  assert.equal(r.width, 1320);
  assert.equal(r.height, Math.round(690 * 1320 / 1120));
});

test('computeResizedSize floors at the minimum scale (width-bound)', () => {
  const r = computeResizedSize({ startWidth: BASE_WIDTH, left: 0, top: 0, dx: -500, canvasWidth: 5000, canvasHeight: 5000 });
  assert.equal(r.width, MIN_WIDTH); // 1000 — the binding floor
  assert.ok(r.height > MIN_HEIGHT); // height floor is never actually reached
});

test('MIN_SCALE floor overrides the canvas cap when the canvas is smaller than the minimum window size', () => {
  const r = computeResizedSize({ startWidth: BASE_WIDTH, left: 0, top: 0, dx: -2000, canvasWidth: 500, canvasHeight: 500 });
  assert.equal(r.width, MIN_WIDTH);
});

test('computeResizedSize caps at the canvas RIGHT edge when there is room above the min', () => {
  // left=50, canvasWidth=2000 → at most 1950px wide, well above MIN_WIDTH's scale
  const r = computeResizedSize({ startWidth: BASE_WIDTH, left: 50, top: 0, dx: 5000, canvasWidth: 2000, canvasHeight: 5000 });
  const maxWidth = 2000 - 50; // 1950
  assert.equal(r.width, maxWidth);
});

test('computeResizedSize caps at the canvas BOTTOM edge when that is the stricter, still-above-minimum axis', () => {
  // canvasHeight=678 (top=0) caps height at 678px, i.e. scale ≈0.9826 —
  // well above MIN_SCALE (≈0.893, so this exercises the real cap, not the
  // minimum-size floor) and well below what the generous width/dx inputs
  // would otherwise allow.
  const r = computeResizedSize({ startWidth: BASE_WIDTH, left: 0, top: 0, dx: 5000, canvasWidth: 5000, canvasHeight: 678 });
  const expectedScale = 678 / BASE_HEIGHT;
  assert.equal(r.width, Math.round(BASE_WIDTH * expectedScale));
  assert.equal(r.height, Math.round(BASE_HEIGHT * expectedScale));
  assert.ok(r.width > MIN_WIDTH);
});

test('a second resize gesture starts from the CURRENT width, not the base width', () => {
  // First gesture already grew the window to 1320 wide; a second gesture's
  // startWidth must be 1320, not BASE_WIDTH, or the corner would jump.
  const r = computeResizedSize({ startWidth: 1320, left: 0, top: 0, dx: 0, canvasWidth: 5000, canvasHeight: 5000 });
  assert.equal(r.width, 1320);
});

test('computeDraggedPosition moves normally within bounds', () => {
  const r = computeDraggedPosition({
    startLeft: 100, startTop: 50, dx: 20, dy: -10,
    width: 1120, height: 690, canvasWidth: 3000, canvasHeight: 2000,
  });
  assert.deepEqual(r, { left: 120, top: 40 });
});

test('computeDraggedPosition clamps at the top-left of the canvas', () => {
  const r = computeDraggedPosition({
    startLeft: 10, startTop: 10, dx: -1000, dy: -1000,
    width: 1120, height: 690, canvasWidth: 3000, canvasHeight: 2000,
  });
  assert.deepEqual(r, { left: 0, top: 0 });
});

test('computeDraggedPosition clamps at the bottom-right of the canvas', () => {
  const r = computeDraggedPosition({
    startLeft: 10, startTop: 10, dx: 5000, dy: 5000,
    width: 1120, height: 690, canvasWidth: 3000, canvasHeight: 2000,
  });
  assert.deepEqual(r, { left: 3000 - 1120, top: 2000 - 690 });
});

test('computeDraggedPosition never throws when the window is larger than the canvas', () => {
  const r = computeDraggedPosition({
    startLeft: 10, startTop: 10, dx: 5, dy: 5,
    width: 4000, height: 3000, canvasWidth: 800, canvasHeight: 600,
  });
  assert.deepEqual(r, { left: 0, top: 0 });
});
