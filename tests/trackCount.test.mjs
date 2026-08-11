import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTrackCount, migrateGlobalVolumes, TRACK_COUNT_MIN, TRACK_COUNT_MAX } from '../renderer/src/trackCount.js';

test('constants', () => {
  assert.equal(TRACK_COUNT_MIN, 4);
  assert.equal(TRACK_COUNT_MAX, 12);
});

test('pads a short top-level channels array up to 12, preserving existing entries', () => {
  const ss = { channels: Array.from({ length: 8 }, (_, i) => ({ channel: i, marker: `orig-${i}` })) };
  const changed = migrateTrackCount(ss);
  assert.equal(changed, true);
  assert.equal(ss.channels.length, 12);
  for (let i = 0; i < 8; i++) assert.equal(ss.channels[i].marker, `orig-${i}`);
  for (let i = 8; i < 12; i++) assert.equal(ss.channels[i].channel, i);
});

test('pads a short top-level ambient array up to 12, preserving existing entries', () => {
  const ss = { ambient: Array.from({ length: 8 }, (_, i) => ({ channel: i, marker: `orig-${i}` })) };
  const changed = migrateTrackCount(ss);
  assert.equal(changed, true);
  assert.equal(ss.ambient.length, 12);
  for (let i = 0; i < 8; i++) assert.equal(ss.ambient[i].marker, `orig-${i}`);
  for (let i = 8; i < 12; i++) assert.equal(ss.ambient[i].channel, i);
});

test('pads channels/ambient inside every saved scene', () => {
  const ss = {
    channels: Array.from({ length: 12 }, (_, i) => ({ channel: i })),
    ambient: Array.from({ length: 12 }, (_, i) => ({ channel: i })),
    scenes: [
      { channels: Array.from({ length: 8 }, (_, i) => ({ channel: i })), ambient: Array.from({ length: 8 }, (_, i) => ({ channel: i })) },
      { channels: Array.from({ length: 12 }, (_, i) => ({ channel: i })), ambient: Array.from({ length: 12 }, (_, i) => ({ channel: i })) },
    ],
  };
  const changed = migrateTrackCount(ss);
  assert.equal(changed, true);
  assert.equal(ss.scenes[0].channels.length, 12);
  assert.equal(ss.scenes[0].ambient.length, 12);
  assert.equal(ss.scenes[1].channels.length, 12); // already full length, untouched
});

test('already-12-length data is left alone and reports no change', () => {
  const ss = {
    channels: Array.from({ length: 12 }, (_, i) => ({ channel: i })),
    ambient: Array.from({ length: 12 }, (_, i) => ({ channel: i })),
  };
  const changed = migrateTrackCount(ss);
  assert.equal(changed, false);
  assert.equal(ss.channels.length, 12);
});

test('missing channels/ambient/scenes properties do not throw', () => {
  assert.equal(migrateTrackCount({}), false);
});

test('migrateGlobalVolumes pads a short channels/ambient volume array with 1 (full volume), preserving existing values', () => {
  const gv = {
    channels: Array.from({ length: 8 }, (_, i) => i / 10),
    ambient: Array.from({ length: 8 }, (_, i) => i / 10),
    master: 0.8,
  };
  const changed = migrateGlobalVolumes(gv);
  assert.equal(changed, true);
  assert.equal(gv.channels.length, 12);
  assert.equal(gv.ambient.length, 12);
  for (let i = 0; i < 8; i++) {
    assert.equal(gv.channels[i], i / 10);
    assert.equal(gv.ambient[i], i / 10);
  }
  for (let i = 8; i < 12; i++) {
    assert.equal(gv.channels[i], 1);
    assert.equal(gv.ambient[i], 1);
  }
  assert.equal(gv.master, 0.8); // untouched
});

test('migrateGlobalVolumes leaves already-12-length data alone and reports no change', () => {
  const gv = {
    channels: Array.from({ length: 12 }, (_, i) => i / 10),
    ambient: Array.from({ length: 12 }, (_, i) => i / 10),
  };
  const changed = migrateGlobalVolumes(gv);
  assert.equal(changed, false);
  assert.equal(gv.channels.length, 12);
});

test('migrateGlobalVolumes handles null/undefined without throwing', () => {
  assert.equal(migrateGlobalVolumes(null), false);
  assert.equal(migrateGlobalVolumes(undefined), false);
});
