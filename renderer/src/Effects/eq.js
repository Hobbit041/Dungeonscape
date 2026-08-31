/**
 * EQ effect — ported from Foundry Soundscape module.
 * All game.socket / game.user.isGM calls removed (standalone app).
 */
export class EQ {
  constructor(channel, context) {
    this.context = context;
    this.channel = channel;
    this.anyEnable = false;

    this.highPass  = context.createBiquadFilter();
    this.lowPass   = context.createBiquadFilter();
    this.peaking1  = context.createBiquadFilter();
    this.peaking2  = context.createBiquadFilter();
    this.gain      = context.createGain();

    this.peaking1.type = 'peaking';
    this.peaking2.type = 'peaking';
    this.highPass.type = 'highpass';

    this.settings = {
      highPass:  { enable: false, frequency: 50,   q: 1 },
      peaking1:  { enable: false, frequency: 500,  q: 1, gain: 1 },
      peaking2:  { enable: false, frequency: 1000, q: 1, gain: 1 },
      lowPass:   { enable: false, frequency: 2000, q: 1 }
    };

    this.freqArray = new Float32Array(595);
    this.freqArray[0] = 20;
    for (let i = 1; i < this.freqArray.length; i++) {
      this.freqArray[i] = this.freqArray[i - 1] * Math.pow(10, 1 / (this.freqArray.length / 3));
    }
  }

  initialize(settings) {
    if (!settings) return;
    this.setAll('lowPass',  settings.lowPass?.enable,  settings.lowPass?.frequency,  settings.lowPass?.q);
    this.setAll('highPass', settings.highPass?.enable, settings.highPass?.frequency, settings.highPass?.q);
    this.setAll('peaking1', settings.peaking1?.enable, settings.peaking1?.frequency, settings.peaking1?.q, settings.peaking1?.gain);
    this.setAll('peaking2', settings.peaking2?.enable, settings.peaking2?.frequency, settings.peaking2?.q, settings.peaking2?.gain);
  }

  setFrequency(filterId, frequency) {
    this.settings[filterId].frequency = frequency;
    this.getThisNode(filterId).frequency.setValueAtTime(frequency, this.context.currentTime);
    setTimeout(() => this.getFrequencyResponse(), 100);
  }

  setQ(filterId, qualityFactor) {
    this.settings[filterId].q = qualityFactor;
    this.getThisNode(filterId).Q.value = qualityFactor;
    setTimeout(() => this.getFrequencyResponse(), 100);
  }

  setGain(filterId, gain) {
    this.settings[filterId].gain = gain;
    this.getThisNode(filterId).gain.setValueAtTime(gain, this.context.currentTime);
    setTimeout(() => this.getFrequencyResponse(), 100);
  }

  setEnable(filterId, enable) {
    if (enable) {
      this.anyEnable = true;
      this.getPreviousNode(filterId).disconnect();
      this.getPreviousNode(filterId)
        .connect(this.getThisNode(filterId))
        .connect(this.getNextNode(filterId));
    } else if (this.getEnable(filterId)) {
      try {
        this.getPreviousNode(filterId).disconnect(this.getThisNode(filterId));
        this.getPreviousNode(filterId).connect(this.getNextNode(filterId));
      } catch (_) {}
    }
    this.settings[filterId].enable = enable;
    setTimeout(() => this.getFrequencyResponse(), 50);
  }

  getEnable(filterId) {
    return this.settings?.[filterId]?.enable ?? false;
  }

  /** Whether any filter is currently enabled (unlike anyEnable, this reflects live state). */
  hasEnabledFilter() {
    return this.settings.highPass.enable || this.settings.lowPass.enable ||
           this.settings.peaking1.enable || this.settings.peaking2.enable;
  }

  setAll(filterId, enable, frequency, q, gain) {
    if (enable    !== undefined) this.setEnable(filterId, enable);
    if (frequency !== undefined) this.setFrequency(filterId, frequency);
    if (q         !== undefined) this.setQ(filterId, q);
    if (gain      !== undefined) this.setGain(filterId, gain);
  }

  getThisNode(n) {
    return { lowPass: this.lowPass, highPass: this.highPass, peaking1: this.peaking1, peaking2: this.peaking2 }[n];
  }

  getNextNode(n) {
    const s = this.settings;
    if (n === 'highPass') {
      if (s.peaking1.enable) return this.peaking1;
      if (s.peaking2.enable) return this.peaking2;
      if (s.lowPass.enable)  return this.lowPass;
      return this.gain;
    }
    if (n === 'peaking1') {
      if (s.peaking2.enable) return this.peaking2;
      if (s.lowPass.enable)  return this.lowPass;
      return this.gain;
    }
    if (n === 'peaking2') return s.lowPass.enable ? this.lowPass : this.gain;
    if (n === 'lowPass')  return this.gain;
  }

  getPreviousNode(n) {
    const s = this.settings;
    const src = this.channel.effects.gain.node;
    if (n === 'highPass') return src;
    if (n === 'peaking1') return s.highPass.enable ? this.highPass : src;
    if (n === 'peaking2') {
      if (s.peaking1.enable) return this.peaking1;
      if (s.highPass.enable) return this.highPass;
      return src;
    }
    if (n === 'lowPass') {
      if (s.peaking2.enable) return this.peaking2;
      if (s.peaking1.enable) return this.peaking1;
      if (s.highPass.enable) return this.highPass;
      return src;
    }
  }

  async getFrequencyResponse() {
    const canvas = document.getElementById(`freqResponse-${this.channel.channelNr}`);
    if (!canvas || !this.anyEnable) return;
    const ctx = canvas.getContext('2d');
    const len = this.freqArray.length;
    const phase = new Float32Array(len);
    const lp = new Float32Array(len); const hp = new Float32Array(len);
    const p1 = new Float32Array(len); const p2 = new Float32Array(len);

    this.settings.highPass.enable  ? this.highPass.getFrequencyResponse(this.freqArray, hp, phase) : hp.fill(1);
    this.settings.lowPass.enable   ? this.lowPass.getFrequencyResponse(this.freqArray, lp, phase)  : lp.fill(1);
    this.settings.peaking1.enable  ? this.peaking1.getFrequencyResponse(this.freqArray, p1, phase) : p1.fill(1);
    this.settings.peaking2.enable  ? this.peaking2.getFrequencyResponse(this.freqArray, p2, phase) : p2.fill(1);

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
}
