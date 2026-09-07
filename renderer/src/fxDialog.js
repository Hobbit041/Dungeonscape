/**
 * fxDialog.js
 * Replaces FXConfig FormApplication from Foundry.
 * Creates a floating panel with EQ + Delay controls.
 */
import { Storage }      from './storage.js';
import { t }            from './i18n.js';
import { resolveScene } from './sceneUtils.js';

export class FXDialog {
  constructor(channel, mixer, sceneId = null) {
    this.channel = channel;
    this.mixer   = mixer;
    this.sceneId = sceneId;
    this.el      = null;
  }

  open() {
    // Close if already open
    const existing = document.getElementById(`fxPanel-${this.channel.channelNr}`);
    if (existing) { existing.remove(); return; }

    const s = this.channel.settings.effects ?? {};
    const eq = s.equalizer ?? {};
    const dl = s.delay     ?? {};

    const panel = document.createElement('div');
    panel.id = `fxPanel-${this.channel.channelNr}`;
    panel.className = 'fx-panel detached-panel';
    panel.innerHTML = `
      <div class="fx-header">
        <span>${t('fxDialog.title', { n: this.channel.channelNr + 1 })}</span>
        <button class="fx-close" id="fxClose-${this.channel.channelNr}">✕</button>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('fxDialog.eq.title')}</div>

        <div class="fx-row">
          <label>${t('fxDialog.eq.highPass')}</label>
          <input type="checkbox" id="fxHPEn-${this.channel.channelNr}" ${eq.highPass?.enable ? 'checked' : ''}>
          <label>${t('fxDialog.eq.frequency')}</label>
          <input type="range" id="fxHPFreq-${this.channel.channelNr}" min="20" max="2000" value="${eq.highPass?.frequency ?? 50}">
          <span id="fxHPFreqVal-${this.channel.channelNr}">${eq.highPass?.frequency ?? 50} Hz</span>
        </div>

        <div class="fx-row">
          <label>${t('fxDialog.eq.peak1')}</label>
          <input type="checkbox" id="fxP1En-${this.channel.channelNr}" ${eq.peaking1?.enable ? 'checked' : ''}>
          <label>${t('fxDialog.eq.frequency')}</label>
          <input type="range" id="fxP1Freq-${this.channel.channelNr}" min="200" max="5000" value="${eq.peaking1?.frequency ?? 500}">
          <span id="fxP1FreqVal-${this.channel.channelNr}">${eq.peaking1?.frequency ?? 500} Hz</span>
          <label>${t('fxDialog.eq.gain')}</label>
          <input type="range" id="fxP1Gain-${this.channel.channelNr}" min="-12" max="12" value="${eq.peaking1?.gain ?? 0}">
          <span id="fxP1GainVal-${this.channel.channelNr}">${eq.peaking1?.gain ?? 0} dB</span>
        </div>

        <div class="fx-row">
          <label>${t('fxDialog.eq.peak2')}</label>
          <input type="checkbox" id="fxP2En-${this.channel.channelNr}" ${eq.peaking2?.enable ? 'checked' : ''}>
          <label>${t('fxDialog.eq.frequency')}</label>
          <input type="range" id="fxP2Freq-${this.channel.channelNr}" min="500" max="15000" value="${eq.peaking2?.frequency ?? 1000}">
          <span id="fxP2FreqVal-${this.channel.channelNr}">${eq.peaking2?.frequency ?? 1000} Hz</span>
          <label>${t('fxDialog.eq.gain')}</label>
          <input type="range" id="fxP2Gain-${this.channel.channelNr}" min="-12" max="12" value="${eq.peaking2?.gain ?? 0}">
          <span id="fxP2GainVal-${this.channel.channelNr}">${eq.peaking2?.gain ?? 0} dB</span>
        </div>

        <div class="fx-row">
          <label>${t('fxDialog.eq.lowPass')}</label>
          <input type="checkbox" id="fxLPEn-${this.channel.channelNr}" ${eq.lowPass?.enable ? 'checked' : ''}>
          <label>${t('fxDialog.eq.frequency')}</label>
          <input type="range" id="fxLPFreq-${this.channel.channelNr}" min="500" max="20000" value="${eq.lowPass?.frequency ?? 2000}">
          <span id="fxLPFreqVal-${this.channel.channelNr}">${eq.lowPass?.frequency ?? 2000} Hz</span>
        </div>

        <canvas id="freqResponse-${this.channel.channelNr}" class="freq-canvas" width="300" height="80"></canvas>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('fxDialog.delay.title')}</div>
        <div class="fx-row">
          <label>${t('fxDialog.delay.enable')}</label>
          <input type="checkbox" id="fxDelEn-${this.channel.channelNr}" ${dl.enable ? 'checked' : ''}>
          <label>${t('fxDialog.delay.time')}</label>
          <input type="range" id="fxDelTime-${this.channel.channelNr}" min="0" max="500" value="${Math.round((dl.delayTime ?? 0.25) * 1000)}">
          <span id="fxDelTimeVal-${this.channel.channelNr}">${Math.round((dl.delayTime ?? 0.25) * 1000)} ms</span>
          <label>${t('fxDialog.delay.volume')}</label>
          <input type="range" id="fxDelVol-${this.channel.channelNr}" min="0" max="100" value="${Math.round((dl.volume ?? 0.5) * 100)}">
          <span id="fxDelVolVal-${this.channel.channelNr}">${Math.round((dl.volume ?? 0.5) * 100)}%</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    this.el = panel;
    this._bindEvents();
  }

  _bindEvents() {
    const ch = this.channel;
    const i  = ch.channelNr;

    // Close
    document.getElementById(`fxClose-${i}`)?.addEventListener('click', () => {
      window.close();
    });

    // High Pass
    this._bind(`fxHPEn-${i}`,   'change', e => { ch.effects.eq.setEnable('highPass', e.target.checked); this._save(); });
    this._bind(`fxHPFreq-${i}`, 'input',  e => {
      const v = parseInt(e.target.value);
      document.getElementById(`fxHPFreqVal-${i}`).textContent = `${v} Hz`;
      ch.effects.eq.setFrequency('highPass', v); this._save();
    });

    // Peaking 1
    this._bind(`fxP1En-${i}`,   'change', e => { ch.effects.eq.setEnable('peaking1', e.target.checked); this._save(); });
    this._bind(`fxP1Freq-${i}`, 'input',  e => {
      const v = parseInt(e.target.value);
      document.getElementById(`fxP1FreqVal-${i}`).textContent = `${v} Hz`;
      ch.effects.eq.setFrequency('peaking1', v); this._save();
    });
    this._bind(`fxP1Gain-${i}`, 'input',  e => {
      const v = parseInt(e.target.value);
      document.getElementById(`fxP1GainVal-${i}`).textContent = `${v} dB`;
      ch.effects.eq.setGain('peaking1', v); this._save();
    });

    // Peaking 2
    this._bind(`fxP2En-${i}`,   'change', e => { ch.effects.eq.setEnable('peaking2', e.target.checked); this._save(); });
    this._bind(`fxP2Freq-${i}`, 'input',  e => {
      const v = parseInt(e.target.value);
      document.getElementById(`fxP2FreqVal-${i}`).textContent = `${v} Hz`;
      ch.effects.eq.setFrequency('peaking2', v); this._save();
    });
    this._bind(`fxP2Gain-${i}`, 'input',  e => {
      const v = parseInt(e.target.value);
      document.getElementById(`fxP2GainVal-${i}`).textContent = `${v} dB`;
      ch.effects.eq.setGain('peaking2', v); this._save();
    });

    // Low Pass
    this._bind(`fxLPEn-${i}`,   'change', e => { ch.effects.eq.setEnable('lowPass', e.target.checked); this._save(); });
    this._bind(`fxLPFreq-${i}`, 'input',  e => {
      const v = parseInt(e.target.value);
      document.getElementById(`fxLPFreqVal-${i}`).textContent = `${v} Hz`;
      ch.effects.eq.setFrequency('lowPass', v); this._save();
    });

    // Delay
    this._bind(`fxDelEn-${i}`,   'change', e => { ch.effects.delay.setEnable(e.target.checked); this._save(); });
    this._bind(`fxDelTime-${i}`, 'input',  e => {
      const ms = parseInt(e.target.value);
      document.getElementById(`fxDelTimeVal-${i}`).textContent = `${ms} ms`;
      ch.effects.delay.setDelay(ms / 1000); this._save();
    });
    this._bind(`fxDelVol-${i}`,  'input',  e => {
      const v = parseInt(e.target.value);
      document.getElementById(`fxDelVolVal-${i}`).textContent = `${v}%`;
      ch.effects.delay.setVolume(v / 100); this._save();
    });
  }

  _bind(id, evt, fn) {
    document.getElementById(id)?.addEventListener(evt, fn);
  }

  async _save() {
    const i = this.channel.channelNr;
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    const chData = this.sceneId === null ? ss.channels[i] : resolveScene(ss, this.sceneId)?.channels[i];
    if (!chData) return;

    const eq = this.channel.effects.eq.settings;
    const dl = this.channel.effects.delay;

    chData.settings.effects = {
      equalizer: structuredClone(eq),
      delay: {
        enable:    dl.enable,
        delayTime: dl.delay,
        volume:    dl.delayVolume
      }
    };
    await Storage.setSoundscapes(soundscapes);
  }
}
