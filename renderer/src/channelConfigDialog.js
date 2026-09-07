/**
 * channelConfigDialog.js
 * Floating config panel for a mixer channel.
 * Replaces soundConfig.js (Foundry FormApplication).
 * Covers: source, repeat, playback rate, timing.
 */
import { Storage }        from './storage.js';
import { t, tFileCount }  from './i18n.js';
import { showConfirm }    from './dialog.js';
import { resolveScene }   from './sceneUtils.js';

export class ChannelConfigDialog {
  constructor(channel, mixer, channelNr, sceneId = null) {
    this.channel   = channel;
    this.mixer     = mixer;
    this.channelNr = channelNr;
    this.sceneId   = sceneId;
    this.el        = null;
  }

  /**
   * Resolves this channel's data within a freshly-fetched soundscapes entry
   * — the active scene's mirror (`ss.channels`) when `sceneId` is null, or
   * one specific detached scene's own copy otherwise. Every read/write in
   * this class goes through here so there's exactly one place that knows
   * how "which scene" maps to "which object".
   */
  _resolveChannelData(ss) {
    return this.sceneId === null ? ss?.channels[this.channelNr] : resolveScene(ss, this.sceneId)?.channels[this.channelNr];
  }

  async open() {
    // Toggle if already open
    const existing = document.getElementById(`chCfgPanel-${this.channelNr}`);
    if (existing) { existing.remove(); return; }

    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const chData = this._resolveChannelData(ss);
    if (!chData) return;

    const s   = chData.settings;
    const sd  = chData.soundData ?? {};
    const rpt = (s.repeat && typeof s.repeat === 'object')
      ? s.repeat
      : { repeat: s.repeat ?? 'none', minDelay: 0, maxDelay: 0 };
    const pbr = s.playbackRate ?? { rate: 1, preservePitch: 1, random: 0 };
    const tmg = s.timing ?? { startTime: 0, stopTime: 0, skipFirstTiming: false, fadeIn: 0, fadeOut: 0, skipFirstFade: false };
    const plCount = Array.isArray(sd.folderLinks) && sd.folderLinks.length
      ? this.channel.sourceArray.length
      : (Array.isArray(sd.playlist) ? sd.playlist.length : (sd.source ? 1 : 0));
    const pan    = s.pan ?? 0;
    const autoPlay = s.autoPlay ?? false;
    // Forced false when detached: "all scenes" membership only has meaning
    // for the active scene (setAllScenesMusic() always reads/writes
    // ss.channels/ss.scenes, never a resolved detached scene), and this
    // value also drives the autoPlay checkbox's `disabled` attribute below
    // — which is NOT hidden when detached — so a detached scene's autoPlay
    // must never come up disabled just because the main grid's channel at
    // this same number happens to be marked global.
    const isAllScenes = this.sceneId === null && (ss?.globalMusicChannels ?? []).includes(this.channelNr);
    const imgName = s.imageSrc ? s.imageSrc.split(/[\\/]/).pop() : '—';

    const panel = document.createElement('div');
    panel.id = `chCfgPanel-${this.channelNr}`;
    panel.className = 'fx-panel cfg-panel detached-panel';
    panel.innerHTML = `
      <div class="fx-header">
        <span>${t('channelConfig.title', { n: this.channelNr + 1 })}</span>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="cfg-reset-btn" id="chCfgReset-${this.channelNr}" title="${t('channelConfig.clearTitle')}">🗑</button>
          <button class="fx-close" id="chCfgClose-${this.channelNr}">✕</button>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('channelConfig.sourcesSection')}</div>
        <div class="fx-row">
          <span class="cfg-src-name">${tFileCount(plCount)}</span>
          <button id="chCfgPlaylist-${this.channelNr}"><i class="fas fa-list"></i> ${t('channelConfig.openPlaylist')}</button>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('channelConfig.imageSection')}</div>
        <div class="fx-row">
          <span class="cfg-src-name" id="chCfgImgName-${this.channelNr}">${imgName}</span>
          <button id="chCfgPickImg-${this.channelNr}"><i class="fas fa-image"></i> ${t('channelConfig.pickImage')}</button>
          <button id="chCfgClearImg-${this.channelNr}" title="${t('channelConfig.clearImageTitle')}">✕</button>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('channelConfig.repeatSection')}</div>
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.repeatMode')}</label>
          <select class="cfg-select" id="chCfgRepeat-${this.channelNr}">
            <option value="none"   ${rpt.repeat === 'none'   ? 'selected' : ''}>${t('channelConfig.repeatNone')}</option>
            <option value="single" ${rpt.repeat === 'single' ? 'selected' : ''}>${t('channelConfig.repeatSingle')}</option>
            <option value="all"    ${rpt.repeat === 'all'    ? 'selected' : ''}>${t('channelConfig.repeatAll')}</option>
          </select>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.minDelay')}</label>
          <input class="cfg-num" type="number" id="chCfgMinDelay-${this.channelNr}" min="0" step="0.1" value="${rpt.minDelay ?? 0}">
          <span class="fx-row-unit">s</span>
          <label class="cfg-label">${t('channelConfig.maxDelay')}</label>
          <input class="cfg-num" type="number" id="chCfgMaxDelay-${this.channelNr}" min="0" step="0.1" value="${rpt.maxDelay ?? 0}">
          <span class="fx-row-unit">s</span>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('channelConfig.playbackRateSection')}</div>
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.rate')}</label>
          <input type="range" id="chCfgRate-${this.channelNr}" min="25" max="400" step="1" value="${Math.round((pbr.rate ?? 1) * 100)}">
          <span class="fx-row-val" id="chCfgRateVal-${this.channelNr}">${(pbr.rate ?? 1).toFixed(2)}×</span>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.preservePitch')}</label>
          <input type="checkbox" id="chCfgPreservePitch-${this.channelNr}" ${pbr.preservePitch ? 'checked' : ''}>
          <label class="cfg-label" style="margin-left:12px">${t('channelConfig.randomRate')}</label>
          <input type="range" id="chCfgRateRandom-${this.channelNr}" min="0" max="200" step="1" value="${Math.round((pbr.random ?? 0) * 100)}">
          <span class="fx-row-val" id="chCfgRateRandomVal-${this.channelNr}">${(pbr.random ?? 0).toFixed(2)}</span>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('channelConfig.additionalSection')}</div>
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.pan')}</label>
          <input type="range" id="chCfgPan-${this.channelNr}" min="-25" max="25" step="1" value="${Math.round(pan * 25)}">
          <span class="fx-row-val" id="chCfgPanVal-${this.channelNr}">${pan === 0 ? 'C' : (pan > 0 ? 'R' : 'L') + Math.round(Math.abs(pan * 100)) + '%'}</span>
        </div>
        <div class="fx-row" style="display:none">
          <label class="cfg-label">Start</label>
          <input class="cfg-num" type="number" id="chCfgStart-${this.channelNr}" min="0" step="0.1" value="${tmg.startTime ?? 0}">
          <span class="fx-row-unit">s</span>
          <label class="cfg-label">Stop</label>
          <input class="cfg-num" type="number" id="chCfgStop-${this.channelNr}" min="0" step="0.1" value="${tmg.stopTime ?? 0}">
          <span class="fx-row-unit">s</span>
        </div>
        <div class="fx-row" style="display:none">
          <label class="cfg-label">Skip 1st timing</label>
          <input type="checkbox" id="chCfgSkipTiming-${this.channelNr}" ${tmg.skipFirstTiming ? 'checked' : ''}>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.fadeIn')}</label>
          <input class="cfg-num" type="number" id="chCfgFadeIn-${this.channelNr}" min="0" step="0.1" value="${tmg.fadeIn ?? 0}">
          <span class="fx-row-unit">s</span>
          <label class="cfg-label">${t('channelConfig.fadeOut')}</label>
          <input class="cfg-num" type="number" id="chCfgFadeOut-${this.channelNr}" min="0" step="0.1" value="${tmg.fadeOut ?? 0}">
          <span class="fx-row-unit">s</span>
        </div>
        ${this.sceneId === null ? `
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.allScenes')}</label>
          <input type="checkbox" id="chCfgAllScenes-${this.channelNr}" ${isAllScenes ? 'checked' : ''}>
        </div>` : ''}
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.autoPlay')}</label>
          <input type="checkbox" id="chCfgAutoPlay-${this.channelNr}" ${autoPlay ? 'checked' : ''} ${isAllScenes ? 'disabled' : ''}>
        </div>
        <div class="fx-row" style="display:none">
          <label class="cfg-label">Skip 1st fade</label>
          <input type="checkbox" id="chCfgSkipFade-${this.channelNr}" ${tmg.skipFirstFade ? 'checked' : ''}>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    this.el = panel;
    this._bindEvents();
  }

  _bindEvents() {
    const i = this.channelNr;

    document.getElementById(`chCfgClose-${i}`)
      ?.addEventListener('click', () => window.close());

    // ── Reset ──
    document.getElementById(`chCfgReset-${i}`)?.addEventListener('click', async () => {
      if (!await showConfirm(t('channelConfig.clearConfirm'))) return;
      await this.mixer.clearChannel(i, this.sceneId);
      document.dispatchEvent(new CustomEvent('playlist-changed', {
        detail: { panelId: `ch-${i}`, playlist: [] }
      }));
      window.close();
    });

    // ── Источники ──
    document.getElementById(`chCfgPlaylist-${i}`)?.addEventListener('click', () => {
      this.mixer.openChannelPlaylist(i);
    });

    // ── Image ──
    document.getElementById(`chCfgPickImg-${i}`)?.addEventListener('click', async () => {
      const paths = await window.api.fs.openDialog({ images: true });
      if (!paths?.length) return;
      const src = paths[0];
      document.getElementById(`chCfgImgName-${i}`).textContent = src.split(/[\\/]/).pop();
      await this._saveSetting('imageSrc', src);
      document.dispatchEvent(new CustomEvent('channel-image-changed', { detail: { src } }));
    });

    document.getElementById(`chCfgClearImg-${i}`)?.addEventListener('click', async () => {
      document.getElementById(`chCfgImgName-${i}`).textContent = '—';
      await this._saveSetting('imageSrc', '');
      document.dispatchEvent(new CustomEvent('channel-image-changed', { detail: { src: '' } }));
    });

    // ── Pan ──
    document.getElementById(`chCfgPan-${i}`)?.addEventListener('input', async (e) => {
      const val = e.target.value / 25;
      const label = Math.abs(Math.round(val * 100));
      document.getElementById(`chCfgPanVal-${i}`).textContent =
        val === 0 ? 'C' : (val > 0 ? `R${label}%` : `L${label}%`);
      this.channel.setPan(val);
      await this._saveSetting('pan', val);
    });

    // ── Repeat ──
    document.getElementById(`chCfgRepeat-${i}`)?.addEventListener('change', async (e) => {
      await this._saveRepeat('repeat', e.target.value);
    });
    document.getElementById(`chCfgMinDelay-${i}`)?.addEventListener('change', async (e) => {
      await this._saveRepeat('minDelay', parseFloat(e.target.value) || 0);
    });
    document.getElementById(`chCfgMaxDelay-${i}`)?.addEventListener('change', async (e) => {
      await this._saveRepeat('maxDelay', parseFloat(e.target.value) || 0);
    });

    // ── Playback Rate ──
    document.getElementById(`chCfgRate-${i}`)?.addEventListener('input', async (e) => {
      const rate = e.target.value / 100;
      document.getElementById(`chCfgRateVal-${i}`).textContent = `${rate.toFixed(2)}×`;
      await this._savePlaybackRate('rate', rate);
      if (this.channel.settings.playbackRate) this.channel.settings.playbackRate.rate = rate;
    });
    document.getElementById(`chCfgPreservePitch-${i}`)?.addEventListener('change', async (e) => {
      const v = e.target.checked ? 1 : 0;
      await this._savePlaybackRate('preservePitch', v);
      if (this.channel.settings.playbackRate) this.channel.settings.playbackRate.preservePitch = v;
    });
    document.getElementById(`chCfgRateRandom-${i}`)?.addEventListener('input', async (e) => {
      const rnd = e.target.value / 100;
      document.getElementById(`chCfgRateRandomVal-${i}`).textContent = rnd.toFixed(2);
      await this._savePlaybackRate('random', rnd);
      if (this.channel.settings.playbackRate) this.channel.settings.playbackRate.random = rnd;
    });

    // ── Timing ──
    document.getElementById(`chCfgStart-${i}`)?.addEventListener('change', async (e) => {
      await this._saveTiming('startTime', parseFloat(e.target.value) || 0);
    });
    document.getElementById(`chCfgStop-${i}`)?.addEventListener('change', async (e) => {
      await this._saveTiming('stopTime', parseFloat(e.target.value) || 0);
    });
    document.getElementById(`chCfgSkipTiming-${i}`)?.addEventListener('change', async (e) => {
      await this._saveTiming('skipFirstTiming', e.target.checked);
    });
    document.getElementById(`chCfgFadeIn-${i}`)?.addEventListener('change', async (e) => {
      await this._saveTiming('fadeIn', parseFloat(e.target.value) || 0);
    });
    document.getElementById(`chCfgFadeOut-${i}`)?.addEventListener('change', async (e) => {
      await this._saveTiming('fadeOut', parseFloat(e.target.value) || 0);
    });
    document.getElementById(`chCfgSkipFade-${i}`)?.addEventListener('change', async (e) => {
      await this._saveTiming('skipFirstFade', e.target.checked);
    });

    // ── Auto-play on scene switch ──
    document.getElementById(`chCfgAutoPlay-${i}`)?.addEventListener('change', async (e) => {
      await this._saveSetting('autoPlay', e.target.checked);
    });

    // ── All scenes (main-grid channel only — see the template's sceneId guard) ──
    if (this.sceneId === null) {
      document.getElementById(`chCfgAllScenes-${i}`)?.addEventListener('change', async (e) => {
        const enable = e.target.checked;
        if (enable) {
          const soundscapes = await Storage.getSoundscapes();
          const ss = soundscapes[this.mixer.currentSoundscape];
          const curScene = ss?.currentScene ?? 0;
          const hasOtherData = (ss?.scenes ?? []).some((scene, k) => {
            if (k === curScene) return false;
            const sd = scene.channels?.[i]?.soundData;
            return (sd?.playlist?.length > 0) || !!sd?.source;
          });
          if (hasOtherData) {
            if (!await showConfirm(t('channelConfig.allScenesConfirm'))) {
              e.target.checked = false;
              return;
            }
          }
        }
        await this.mixer.setAllScenesMusic(i, enable);
        const autoPlayEl = document.getElementById(`chCfgAutoPlay-${i}`);
        if (autoPlayEl) autoPlayEl.disabled = enable;
      });
    }
  }

  // ── Storage helpers ──────────────────────────────────────────────────────────

  async _saveSetting(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const chData = this._resolveChannelData(ss);
    if (!chData) return;
    chData.settings[key] = value;
    this.channel.settings[key] = value;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveRepeat(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const chData = this._resolveChannelData(ss);
    if (!chData) return;
    let rpt = chData.settings.repeat;
    if (!rpt || typeof rpt === 'string') rpt = { repeat: rpt ?? 'none', minDelay: 0, maxDelay: 0 };
    rpt[key] = value;
    chData.settings.repeat = rpt;
    this.channel.settings.repeat = rpt;
    await Storage.setSoundscapes(soundscapes);
  }

  async _savePlaybackRate(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const chData = this._resolveChannelData(ss);
    if (!chData) return;
    let pbr = chData.settings.playbackRate ?? { rate: 1, preservePitch: 1, random: 0 };
    pbr[key] = value;
    chData.settings.playbackRate = pbr;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveTiming(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const chData = this._resolveChannelData(ss);
    if (!chData) return;
    let tmg = chData.settings.timing
      ?? { startTime: 0, stopTime: 0, skipFirstTiming: false, fadeIn: 0, fadeOut: 0, skipFirstFade: false };
    tmg[key] = value;
    chData.settings.timing = tmg;
    this.channel.settings.timing = tmg;
    await Storage.setSoundscapes(soundscapes);
  }
}
