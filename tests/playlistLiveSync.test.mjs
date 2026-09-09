import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistLiveSync } from '../renderer/src/playlistLiveSync.js';

function makeMixer() {
  return {
    channels:     [{ currentlyPlaying: 0, playing: false }],
    ambientMixer: { channels: [{ currentlyPlaying: 2, playing: true }] },
    soundboard:   { channels: [{ currentlyPlaying: 0, playing: false }] },
    detachedSoundboards: new Map(),
    detachedMusicScenes: new Map(),
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

test('resolves a detached scene playlist key to the parallel instance\'s channel', async () => {
  const mixer  = makeMixer();
  mixer.detachedSoundboards.set('scene-a', { channels: [{ currentlyPlaying: 3, playing: true }] });
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:sbScene:scene-a:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();

  assert.deepEqual(pushed, [['playlist:sbScene:scene-a:0', { currentlyPlaying: 3, playing: true }]]);
});

test('skips a detached scene playlist key whose scene is no longer detached', async () => {
  const mixer  = makeMixer(); // detachedSoundboards is empty
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:sbScene:scene-a:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await assert.doesNotReject(() => sync.tick());
  assert.deepEqual(pushed, []);
});

test('resolves a detached music scene channel playlist key to the parallel MusicScenePlayer\'s channel', async () => {
  const mixer  = makeMixer();
  mixer.detachedMusicScenes.set('scene-a', {
    channels: [{ currentlyPlaying: 4, playing: true }],
    ambientMixer: { channels: [{ currentlyPlaying: 0, playing: false }] },
  });
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:musicScene:scene-a:ch:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();

  assert.deepEqual(pushed, [['playlist:musicScene:scene-a:ch:0', { currentlyPlaying: 4, playing: true }]]);
});

test('resolves a detached music scene ambient playlist key to the parallel MusicScenePlayer\'s ambient channel', async () => {
  const mixer  = makeMixer();
  mixer.detachedMusicScenes.set('scene-a', {
    channels: [{ currentlyPlaying: 0, playing: false }],
    ambientMixer: { channels: [{ currentlyPlaying: 7, playing: true }] },
  });
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:musicScene:scene-a:amb:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await sync.tick();

  assert.deepEqual(pushed, [['playlist:musicScene:scene-a:amb:0', { currentlyPlaying: 7, playing: true }]]);
});

test('skips a detached music scene playlist key whose scene is no longer detached', async () => {
  const mixer  = makeMixer(); // detachedMusicScenes is empty
  const pushed = [];
  const sync = createPlaylistLiveSync(mixer, {
    getOpenKeys: async () => ['playlist:musicScene:scene-a:ch:0'],
    push: (key, state) => pushed.push([key, state]),
  });

  await assert.doesNotReject(() => sync.tick());
  assert.deepEqual(pushed, []);
});
