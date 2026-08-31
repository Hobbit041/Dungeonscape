import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistLiveSync } from '../renderer/src/playlistLiveSync.js';

function makeMixer() {
  return {
    channels:     [{ currentlyPlaying: 0, playing: false }],
    ambientMixer: { channels: [{ currentlyPlaying: 2, playing: true }] },
    soundboard:   { channels: [{ currentlyPlaying: 0, playing: false }] },
  };
}

test('pushes state for an open playlist key on the first tick', async () => {
  const mixer  = makeMixer();
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:ch:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();

  assert.deepEqual(pushed, [['playlist:ch:0', { currentlyPlaying: 0, playing: false }]]);
});

test('does not push again when nothing changed between ticks', async () => {
  const mixer  = makeMixer();
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:ch:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();
  await sync.tick();

  assert.equal(pushed.length, 1);
});

test('pushes again when currentlyPlaying changes between ticks', async () => {
  const mixer  = makeMixer();
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:ch:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();
  mixer.channels[0].currentlyPlaying = 5;
  await sync.tick();

  assert.equal(pushed.length, 2);
  assert.deepEqual(pushed[1], ['playlist:ch:0', { currentlyPlaying: 5, playing: false }]);
});

test('pushes again when only playing changes between ticks', async () => {
  const mixer  = makeMixer();
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:ch:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();
  mixer.channels[0].playing = true;
  await sync.tick();

  assert.equal(pushed.length, 2);
  assert.deepEqual(pushed[1], ['playlist:ch:0', { currentlyPlaying: 0, playing: true }]);
});

test('ignores keys that are not playlist windows', async () => {
  const mixer  = makeMixer();
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['fx:0', 'missingFiles'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();

  assert.deepEqual(pushed, []);
});

test('resolves ambient and soundboard keys to the right channel list', async () => {
  const mixer  = makeMixer();
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:amb:0', 'playlist:sb:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();

  const byKey = Object.fromEntries(pushed);
  assert.deepEqual(byKey['playlist:amb:0'], { currentlyPlaying: 2, playing: true });
  assert.deepEqual(byKey['playlist:sb:0'],  { currentlyPlaying: 0, playing: false });
});

test('skips a key whose channel index does not exist without throwing', async () => {
  const mixer  = makeMixer();
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:ch:99'],
    push: (key, state) => pushed.push([key, state]),
  });

  await assert.doesNotReject(() => sync.tick());
  assert.deepEqual(pushed, []);
});
