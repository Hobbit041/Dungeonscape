import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SB_SLOTS, SB_GRID_MAX, SB_GAP,
  slotCol, slotRow, isVisible, visibleIndices,
  migrateIndex, needsMigration, migrateSoundboardArray,
  migrateSoundscape, migrateMidiMappings,
  cellFromBase, gridSizeFor, baseFromCell,
} from '../renderer/src/sbGrid.js';

const makeEmpty = (i) => ({ channel: 100 + i, name: '', empty: true });

test('constants', () => {
  assert.equal(SB_GRID_MAX, 7);
  assert.equal(SB_SLOTS, 49);
});

test('slot coordinates', () => {
  assert.equal(slotCol(0), 0);
  assert.equal(slotRow(0), 0);
  assert.equal(slotCol(8), 1);   // row 1, col 1
  assert.equal(slotRow(8), 1);
  assert.equal(slotCol(48), 6);
  assert.equal(slotRow(48), 6);
});

test('isVisible: 5x5 window', () => {
  assert.ok(isVisible(0, 5, 5));
  assert.ok(isVisible(4, 5, 5));        // row 0, col 4
  assert.ok(!isVisible(5, 5, 5));       // row 0, col 5 — hidden
  assert.ok(isVisible(7, 5, 5));        // row 1, col 0
  assert.ok(isVisible(32, 5, 5));       // row 4, col 4
  assert.ok(!isVisible(35, 5, 5));      // row 5 — hidden
});

test('visibleIndices 4x4 has 16 entries, row-major', () => {
  const v = visibleIndices(4, 4);
  assert.equal(v.length, 16);
  assert.deepEqual(v.slice(0, 5), [0, 1, 2, 3, 7]);
});

test('migrateIndex maps old 5-wide index to 7-wide, preserving row/col', () => {
  assert.equal(migrateIndex(0), 0);
  assert.equal(migrateIndex(4), 4);
  assert.equal(migrateIndex(5), 7);     // old row1 col0
  assert.equal(migrateIndex(12), 16);   // old row2 col2
  assert.equal(migrateIndex(24), 32);   // old row4 col4
});

test('needsMigration', () => {
  assert.ok(needsMigration(new Array(25).fill({})));
  assert.ok(!needsMigration(new Array(49).fill({})));
  assert.ok(!needsMigration([]));       // empty stays empty
  assert.ok(!needsMigration(undefined));
});

test('migrateSoundboardArray: data lands on same row/col, channel renumbered', () => {
  const old = Array.from({ length: 25 }, (_, i) => ({ channel: 100 + i, name: `b${i}` }));
  const out = migrateSoundboardArray(old, makeEmpty);
  assert.equal(out.length, 49);
  assert.equal(out[7].name, 'b5');      // old idx 5 → new idx 7
  assert.equal(out[7].channel, 107);
  assert.equal(out[32].name, 'b24');
  assert.ok(out[5].empty);              // new column slot is empty
});

test('migrateSoundscape migrates soundboard, sbScenes and global buttons; idempotent', () => {
  const ss = {
    soundboard: Array.from({ length: 25 }, (_, i) => ({ channel: 100 + i, name: `b${i}` })),
    sbScenes: [{ name: 'SB 1', soundboard: Array.from({ length: 25 }, (_, i) => ({ channel: 100 + i, name: `s${i}` })) }],
    globalSoundboardButtons: [5, 24],
  };
  assert.ok(migrateSoundscape(ss, makeEmpty));
  assert.equal(ss.soundboard.length, 49);
  assert.equal(ss.soundboard[7].name, 'b5');
  assert.equal(ss.sbScenes[0].soundboard[32].name, 's24');
  assert.deepEqual(ss.globalSoundboardButtons, [7, 32]);
  assert.ok(!migrateSoundscape(ss, makeEmpty));   // second run: no changes
});

test('migrateMidiMappings rekeys only sb-N', () => {
  const out = migrateMidiMappings({
    'sb-5':      { type: 'noteon', channel: 0, note: 40 },
    'sb-stopall':{ type: 'noteon', channel: 0, note: 41 },
    'ch-5-play': { type: 'noteon', channel: 0, note: 42 },
  });
  assert.ok(out['sb-7']);
  assert.ok(!out['sb-5']);
  assert.ok(out['sb-stopall']);
  assert.ok(out['ch-5-play']);
});

test('geometry: divisions >= 5 keep base cell', () => {
  assert.equal(cellFromBase(100, 5, 5), 100);
  assert.equal(cellFromBase(100, 7, 6), 100);
});

test('geometry: any axis at 4 enlarges the cell to (5S+gap)/4', () => {
  assert.equal(cellFromBase(100, 4, 5), (5 * 100 + SB_GAP) / 4);
  assert.equal(cellFromBase(100, 5, 4), (5 * 100 + SB_GAP) / 4);
});

test('geometry: 4x4 grid pixel size equals 5x5 (window unchanged)', () => {
  const five = gridSizeFor(100, 5, 5);
  const four = gridSizeFor(100, 4, 4);
  assert.ok(Math.abs(five.w - four.w) < 1e-9);
  assert.ok(Math.abs(five.h - four.h) < 1e-9);
});

test('geometry: 6x5 grows width by one cell+gap, height unchanged', () => {
  const five = gridSizeFor(100, 5, 5);
  const six  = gridSizeFor(100, 6, 5);
  assert.ok(Math.abs(six.w - (five.w + 100 + SB_GAP)) < 1e-9);
  assert.ok(Math.abs(six.h - five.h) < 1e-9);
});

test('baseFromCell inverts cellFromBase', () => {
  for (const [cols, rows] of [[5, 5], [4, 5], [7, 4], [6, 7]]) {
    const c = cellFromBase(100, cols, rows);
    assert.ok(Math.abs(baseFromCell(c, cols, rows) - 100) < 1e-9);
  }
});
