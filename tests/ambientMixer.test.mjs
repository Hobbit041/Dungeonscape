import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmbientMixer } from '../renderer/src/ambientMixer.js';

function makeFakeMainMixer() {
  const listeners = new Map();
  const fakeGainNode = { connect: () => fakeGainNode, gain: { value: 1 } };
  const fakeAudioCtx = {
    createGain: () => ({ ...fakeGainNode }),
    createMediaElementSource: () => ({ connect: () => {}, disconnect: () => {} }),
  };
  return {
    audioCtx: fakeAudioCtx,
    master: { effects: { interfaceGain: { node: fakeGainNode } } },
    globalVolumes: { ambient: new Array(12).fill(1), ambientMaster: 1 },
  };
}

test('sceneId defaults to null (active instance)', () => {
  const am = new AmbientMixer(makeFakeMainMixer());
  assert.equal(am.sceneId, null);
});

test('configure() with sceneId null reads soundscapeData.ambient directly, unchanged from before', async () => {
  const am = new AmbientMixer(makeFakeMainMixer());
  const ambientData = [{ settings: { volume: 1, name: 'Track A' }, soundData: {} }];
  await am.configure({ ambient: ambientData });
  assert.equal(am.channels[0].settings.name, 'Track A');
});

test('configure() with a non-null sceneId resolves via resolveScene() instead', async () => {
  const am = new AmbientMixer(makeFakeMainMixer(), 'scene-b');
  const ss = {
    scenes: [
      { id: 'scene-a', ambient: [{ settings: { volume: 1, name: 'Wrong scene' }, soundData: {} }] },
      { id: 'scene-b', ambient: [{ settings: { volume: 1, name: 'Right scene' }, soundData: {} }] },
    ],
  };
  await am.configure(ss);
  assert.equal(am.channels[0].settings.name, 'Right scene');
});

test('configure() with a non-existent sceneId configures every channel empty rather than throwing', async () => {
  const am = new AmbientMixer(makeFakeMainMixer(), 'does-not-exist');
  await assert.doesNotReject(() => am.configure({ scenes: [] }));
  assert.equal(am.channels[0].settings.name, '');
});
