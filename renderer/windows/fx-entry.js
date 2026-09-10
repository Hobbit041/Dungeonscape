/**
 * fx-entry.js — bootstrap for the standalone FXDialog (EQ + Delay) window.
 *
 * FXDialog itself is completely unchanged internally (still calls
 * ch.effects.eq.setEnable(...)/setFrequency(...)/setGain(...) and
 * ch.effects.delay.setEnable(...)/setDelay(...)/setVolume(...), still reads
 * ch.effects.eq.settings / ch.effects.delay.{enable,delay,delayVolume} in
 * its own _save()). What changes is what's BEHIND `this.channel`: instead of
 * the real live Channel (which only exists in the main window's process),
 * this window builds a lightweight stub that duck-types the same
 * .effects.eq / .effects.delay surface — each stub setter updates a local
 * plain-data mirror (so FXDialog's own reads keep working unchanged) and
 * relays the same call to the main window via child-window-message, keyed
 * per-channel ('fx:<channelNr>') so multiple EQ windows for different
 * channels can be open at once without colliding.
 *
 * The frequency-response canvas (#freqResponse-N) is drawn from right here,
 * not from the real Channel's EQ instance in the main window (see
 * ../src/eqFrequencyGraph.js's own header for why: that instance's real
 * BiquadFilterNodes drive actual audio and never see this window's canvas
 * element at all). It reads this window's own local eqSettings mirror
 * (below), so it always reflects exactly what's on screen here.
 */
import { initI18n, t } from '../src/i18n.js';
import { FXDialog } from '../src/fxDialog.js';
import { finishDetachedWindowInit } from './detachedWindowChrome.js';
import { drawEqFrequencyResponse } from '../src/eqFrequencyGraph.js';

// Same defaults as EQ's own constructor (renderer/src/Effects/eq.js) and
// Delay's implied defaults (renderer/src/fxDialog.js's own open() reads
// dl.delayTime ?? 0.25 / dl.volume ?? 0.5 when displaying) — merged under
// whatever was actually saved, so a filter that's never been touched still
// has a complete {enable,frequency,q[,gain]} shape instead of a sparse one.
// Without this, toggling a never-configured filter's checkbox first would
// spread `undefined` and persist a filter object missing frequency/gain/q.
const EQ_DEFAULTS = {
  highPass: { enable: false, frequency: 50,   q: 1 },
  peaking1: { enable: false, frequency: 500,  q: 1, gain: 1 },
  peaking2: { enable: false, frequency: 1000, q: 1, gain: 1 },
  lowPass:  { enable: false, frequency: 2000, q: 1 },
};
const DELAY_DEFAULTS = { enable: false, delayTime: 0.25, volume: 0.5 };

function makeChannelStub(channelNr, effects, sendRpc, onEqChange) {
  const eqSettings = {};
  for (const filterId of Object.keys(EQ_DEFAULTS)) {
    eqSettings[filterId] = { ...EQ_DEFAULTS[filterId], ...(effects?.equalizer?.[filterId] ?? {}) };
  }
  const delaySettings = { ...DELAY_DEFAULTS, ...(effects?.delay ?? {}) };

  const eqStub = {
    settings: eqSettings,
    setEnable(filterId, enable) {
      eqSettings[filterId] = { ...eqSettings[filterId], enable };
      sendRpc('eq', 'setEnable', filterId, enable);
      onEqChange();
    },
    setFrequency(filterId, frequency) {
      eqSettings[filterId] = { ...eqSettings[filterId], frequency };
      sendRpc('eq', 'setFrequency', filterId, frequency);
      onEqChange();
    },
    setGain(filterId, gain) {
      eqSettings[filterId] = { ...eqSettings[filterId], gain };
      sendRpc('eq', 'setGain', filterId, gain);
      onEqChange();
    },
  };

  const delayStub = {
    get enable()      { return delaySettings.enable; },
    get delay()       { return delaySettings.delayTime; },
    get delayVolume() { return delaySettings.volume; },
    setEnable(v) { delaySettings.enable = v; sendRpc('delay', 'setEnable', v); },
    setDelay(v)  { delaySettings.delayTime = v; sendRpc('delay', 'setDelay', v); },
    setVolume(v) { delaySettings.volume = v; sendRpc('delay', 'setVolume', v); },
  };

  return {
    channelNr,
    settings: { effects: { equalizer: eqSettings, delay: delaySettings } },
    effects: { eq: eqStub, delay: delayStub },
  };
}

window.api.childWindow.onInit(async ({ channelNr, effects, currentSoundscape, musicSceneId } = {}) => {
  try {
    await initI18n();
    const sceneId = musicSceneId ?? null;
    // Scoped by scene so a detached scene's EQ window doesn't collide with
    // the main grid's own fx:<channelNr> key for the same channel number —
    // see mixer.js's _closeAllFxWindows(), which only ever sweeps the
    // unscoped fx:<i> keys, so this naturally isn't touched by it either
    // (same accepted trade-off as mixer.js's _closeAllDetachedMusicScenes()).
    const key = sceneId === null ? `fx:${channelNr}` : `fx:musicScene:${sceneId}:${channelNr}`;
    const sendRpc = (target, method, ...args) => {
      window.api.childWindow.send(key, { target, method, args });
    };
    const channelStub = makeChannelStub(channelNr, effects, sendRpc, () => {
      drawEqFrequencyResponse(freqCanvas, channelStub.effects.eq.settings);
    });
    const mixerStub = { currentSoundscape };
    new FXDialog(channelStub, mixerStub, sceneId).open();
    // Built by FXDialog.open() above — looked up once here and reused for
    // every later redraw (onEqChange, above) rather than re-queried each
    // time: this window's FXDialog is opened exactly once, its canvas never
    // gets rebuilt for the lifetime of the window.
    const freqCanvas = document.getElementById(`freqResponse-${channelNr}`);
    drawEqFrequencyResponse(freqCanvas, channelStub.effects.eq.settings);
    finishDetachedWindowInit(key, t('fxDialog.title', { n: channelNr + 1 }), { showTitleBar: false });
  } catch (err) {
    console.error('[fx-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
