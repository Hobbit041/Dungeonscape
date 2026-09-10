/**
 * eqFrequencyGraph.js — draws the EQ frequency-response curve for the
 * detached FX window (renderer/windows/fx-entry.js). The real EQ effect
 * (renderer/src/Effects/eq.js) only exists in the main window's process,
 * driving the real live BiquadFilterNode chain that actually processes
 * audio — this module builds its OWN throwaway, never-connected
 * AudioContext + 4 BiquadFilterNodes purely to reuse the browser's real
 * getFrequencyResponse() math (no audio is ever produced), configured from
 * the same plain-data eqSettings the detached window already mirrors
 * locally (see fx-entry.js's makeChannelStub). Module-level state is safe
 * here: each detached FX window is its own BrowserWindow with its own
 * separate JS realm, so this module's "singleton" nodes are actually
 * per-window, never shared across multiple open FX windows.
 */

// 595 log-spaced points from 20 Hz up, matching eq.js's original freqArray —
// enough resolution for a smooth curve without excess computation.
const FREQ_ARRAY = (() => {
  const arr = new Float32Array(595);
  arr[0] = 20;
  for (let i = 1; i < arr.length; i++) {
    arr[i] = arr[i - 1] * Math.pow(10, 1 / (arr.length / 3));
  }
  return arr;
})();

let _ctx, _highPass, _lowPass, _peaking1, _peaking2;

function _ensureNodes() {
  if (_ctx) return;
  _ctx = new AudioContext();
  _highPass = _ctx.createBiquadFilter();
  _lowPass  = _ctx.createBiquadFilter();
  _peaking1 = _ctx.createBiquadFilter();
  _peaking2 = _ctx.createBiquadFilter();
  _highPass.type = 'highpass';
  _lowPass.type  = 'lowpass';
  _peaking1.type = 'peaking';
  _peaking2.type = 'peaking';
}

function _configure(node, filterSettings) {
  node.frequency.value = filterSettings.frequency;
  node.Q.value = filterSettings.q ?? 1;
  if (filterSettings.gain !== undefined) node.gain.value = filterSettings.gain;
}

/**
 * @param {HTMLCanvasElement|null} canvas
 * @param {{highPass, peaking1, peaking2, lowPass}} eqSettings - same shape
 *   as EQ.settings (renderer/src/Effects/eq.js) / fx-entry.js's
 *   eqStub.settings: each a {enable, frequency, q[, gain]} object.
 */
export function drawEqFrequencyResponse(canvas, eqSettings) {
  if (!canvas) return;
  _ensureNodes();
  _configure(_highPass, eqSettings.highPass);
  _configure(_lowPass,  eqSettings.lowPass);
  _configure(_peaking1, eqSettings.peaking1);
  _configure(_peaking2, eqSettings.peaking2);

  const len = FREQ_ARRAY.length;
  const phase = new Float32Array(len);
  const hp = new Float32Array(len); const lp = new Float32Array(len);
  const p1 = new Float32Array(len); const p2 = new Float32Array(len);

  eqSettings.highPass.enable ? _highPass.getFrequencyResponse(FREQ_ARRAY, hp, phase) : hp.fill(1);
  eqSettings.lowPass.enable  ? _lowPass.getFrequencyResponse(FREQ_ARRAY, lp, phase)  : lp.fill(1);
  eqSettings.peaking1.enable ? _peaking1.getFrequencyResponse(FREQ_ARRAY, p1, phase) : p1.fill(1);
  eqSettings.peaking2.enable ? _peaking2.getFrequencyResponse(FREQ_ARRAY, p2, phase) : p2.fill(1);

  const ctx = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  const horOffset = 25; const vertOffset = 20;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 1; ctx.globalAlpha = 0.75;
  ctx.beginPath(); ctx.strokeStyle = 'red';

  for (let i = 0; i < W; i++) {
    let r = lp[i] * hp[i] * p1[i] * p2[i];
    r = 20.0 * Math.log(r) / Math.LN10;
    const dbScale = 30;
    const height = H - vertOffset;
    let y = (0.5 * height) - (0.5 * height) / dbScale * r;
    if (y > height) y = height;
    const x = i * W / len + horOffset;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}
