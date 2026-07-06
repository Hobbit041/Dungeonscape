import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SB_SLOTS, SB_GRID_MAX, SB_GRID_MIN, SB_GRID_DEF, SB_GAP,
  slotCol, slotRow, isVisible, visibleIndices,
  migrateIndex, needsMigration, migrateSoundboardArray,
  migrateSoundscape, migrateMidiMappings,
  cellFromBase, gridSizeFor, baseFromCell,
} from '../renderer/src/sbGrid.js';

const makeEmpty = (i) => ({ channel: 100 + i, name: '', empty: true });

test('constants', () => {
  assert.equal(SB_GRID_MAX, 7);
  assert.equal(SB_SLOTS, 49);
  assert.equal(SB_GRID_MIN, 4);
  assert.equal(SB_GRID_DEF, 5);
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

test('7x7 window covers all 49 slots', () => {
  const v = visibleIndices(7, 7);
  assert.equal(v.length, 49);
  assert.ok(isVisible(48, 7, 7));
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
  assert.equal(old[5].channel, 105);    // input not mutated
  assert.notEqual(out[7], old[5]);      // output is a clone, not the same object
});

// Mixed arrays: an old app version run against migrated data writes legacy
// indices 0–24, while global-button slots ≥ 25 keep 7-wide coords (with null
// holes from the array extension).
test('migrateSoundboardArray: mixed array keeps slots >= 25 in place', () => {
  const mixed = new Array(33).fill(null);
  mixed[5]  = { channel: 105, name: 'legacy5' };    // legacy → slot 7
  mixed[22] = { channel: 122, name: 'legacy22' };   // legacy → slot 30
  mixed[31] = { channel: 131, name: 'global31' };   // already 7-wide — stays
  mixed[32] = { channel: 132, name: 'global32' };
  const out = migrateSoundboardArray(mixed, makeEmpty);
  assert.equal(out.length, 49);
  assert.equal(out[7].name, 'legacy5');
  assert.equal(out[30].name, 'legacy22');
  assert.equal(out[31].name, 'global31');
  assert.equal(out[31].channel, 131);
  assert.equal(out[32].name, 'global32');
});

test('migrateSoundboardArray: collision moves legacy button to first free slot', () => {
  const mixed = new Array(33).fill(null);
  mixed[23] = { channel: 123, name: 'legacy23' };   // wants slot 31 — taken
  mixed[31] = { channel: 131, name: 'global31' };   // keeps slot 31
  const out = migrateSoundboardArray(mixed, makeEmpty);
  assert.equal(out[31].name, 'global31');
  assert.equal(out[0].name, 'legacy23');            // first free slot
  assert.equal(out[0].channel, 100);
});

test('migrateSoundboardArray: content-less buttons do not block collision placement', () => {
  // Full legacy board of empty buttons + one real button whose target is taken
  const mixed = Array.from({ length: 25 }, (_, i) => ({ channel: 100 + i, name: '', soundData: { source: '', playlist: [] }, imageSrc: '' }));
  mixed[0]  = { channel: 100, name: 'first' };
  mixed[23] = { channel: 123, name: 'legacy23' };   // wants slot 31 — taken
  mixed[31] = { channel: 131, name: 'global31' };
  const out = migrateSoundboardArray(mixed, makeEmpty);
  assert.equal(out[0].name, 'first');
  assert.equal(out[31].name, 'global31');
  assert.equal(out[1].name, 'legacy23');            // empty slot 1 not blocked
  assert.ok(out[3].empty);                          // untouched slots stay makeEmpty
});

test('migrateSoundscape keeps global-button indices >= 25 as-is', () => {
  const ss = {
    soundboard: Array.from({ length: 25 }, (_, i) => ({ channel: 100 + i, name: `b${i}` })),
    globalSoundboardButtons: [4, 31, 32],
  };
  assert.ok(migrateSoundscape(ss, makeEmpty));
  assert.deepEqual(ss.globalSoundboardButtons, [4, 31, 32]);
});

test('migrateMidiMappings keeps sb-N keys with N >= 25', () => {
  const out = migrateMidiMappings({
    'sb-5':  { note: 40 },
    'sb-31': { note: 41 },
  });
  assert.ok(out['sb-7']);
  assert.ok(out['sb-31']);
  assert.ok(!out['sb-5']);
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
