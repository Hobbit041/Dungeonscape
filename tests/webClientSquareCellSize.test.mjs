// tests/webClientSquareCellSize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSquareCellSize } from '../web-client/src/soundboardPanel.js';

test('fits by width when width is the stricter axis', () => {
  // 5 cols in 500px width (gap 6): (500-4*6)/5 = 95.2 per cell from width
  // 5 rows in 1000px height: (1000-4*6)/5 = 195.2 per cell from height
  const cell = computeSquareCellSize({ cols: 5, rows: 5, availableWidth: 500, availableHeight: 1000, gap: 6 });
  assert.ok(Math.abs(cell - 95.2) < 0.01);
});

test('fits by height when height is the stricter axis', () => {
  const cell = computeSquareCellSize({ cols: 5, rows: 5, availableWidth: 1000, availableHeight: 500, gap: 6 });
  assert.ok(Math.abs(cell - 95.2) < 0.01);
});

test('handles non-square cols/rows correctly', () => {
  // 4 cols, 7 rows, in a 400x400 box, gap 6:
  // fromWidth  = (400 - 3*6)/4 = 95.5
  // fromHeight = (400 - 6*6)/7 = 51.999...
  // height is stricter
  const cell = computeSquareCellSize({ cols: 4, rows: 7, availableWidth: 400, availableHeight: 400, gap: 6 });
  assert.ok(Math.abs(cell - (400 - 6 * 6) / 7) < 0.01);
});

test('never returns negative when available space is smaller than the gaps alone', () => {
  const cell = computeSquareCellSize({ cols: 5, rows: 5, availableWidth: 10, availableHeight: 10, gap: 6 });
  assert.equal(cell, 0);
});

test('defaults gap to 6 when omitted', () => {
  const withDefault = computeSquareCellSize({ cols: 5, rows: 5, availableWidth: 500, availableHeight: 1000 });
  const explicit = computeSquareCellSize({ cols: 5, rows: 5, availableWidth: 500, availableHeight: 1000, gap: 6 });
  assert.equal(withDefault, explicit);
});
