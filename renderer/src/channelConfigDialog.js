/**
 * channelConfigDialog.js
 * Floating config panel for a mixer channel.
 * Replaces soundConfig.js (Foundry FormApplication).
 * Covers: source, repeat, playback rate, timing.
 */
import { Storage }        from './storage.js';
import { PlaylistDialog } from './playlistDialog.js';
import { t, tFileCount }  from './i18n.js';
import { makeDraggable }  from './dragPanel.js';
import { showConfirm }    from './dialog.js';

export class ChannelConfigDialog {
  constructor(channel, mixer, channelNr) {
    this.channel   = channel;
    this.mixer     = mixer;
    this.channelNr = channelNr;
    this.el        = null;
  }

  async open() {
    // Toggle if already open
    const existing = document.getElementById(`chCfgPanel-${this.channelNr}`);
    if (existing) { existing.remove(); return; }

    const soundscapes = await Storage.getSoundscapes();
    const chData = soundscapes[this.mixer.currentSoundscape]?.channels[this.channelNr];
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
    const isAllScenes = (soundscapes[this.mixer.currentSoundscape]?.globalMusicChannels ?? []).includes(this.channelNr);

    const panel = document.createElement('div');
    panel.id = `chCfgPanel-${this.channelNr}`;
    panel.className = 'fx-panel cfg-panel';
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
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.allScenes')}</label>
          <input type="checkbox" id="chCfgAllScenes-${this.channelNr}" ${isAllScenes ? 'checked' : ''}>
        </div>
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
    this._makeDraggable(panel);
    this._bindEvents();
  }

  _bindEvents() {
    const i = this.channelNr;

    document.getElementById(`chCfgClose-${i}`)
      ?.addEventListener('click', () => document.getElementById(`chCfgPanel-${i}`)?.remove());

    // ── Reset ──
    document.getElementById(`chCfgReset-${i}`)?.addEventListener('click', async () => {
      if (!await showConfirm(t('channelConfig.clearConfirm'))) return;
      await this.mixer.clearChannel(i);
      document.dispatchEvent(new CustomEvent('playlist-changed', {
        detail: { panelId: `ch-${i}`, playlist: [] }
      }));
      document.getElementById(`chCfgPanel-${i}`)?.remove();
    });

    // ── Источники ──
    document.getElementById(`chCfgPlaylist-${i}`)?.addEventListener('click', () => {
      new PlaylistDialog({
        title:         t('channelConfig.playlistTitle', { n: i + 1 }),
        panelId:       `ch-${i}`,
        getSoundData:  async () => {
          const ss = await Storage.getSoundscapes();
          return ss[this.mixer.currentSoundscape]?.channels[i]?.soundData;
        },
        saveSoundData: async (data) => {
          const ss = await Storage.getSoundscapes();
          if (ss[this.mixer.currentSoundscape]) {
            const chData = ss[this.mixer.currentSoundscape].channels[i];
            chData.soundData = data;
            if (!chData.settings.name && data.playlist?.length > 0) {
              const lbl  = data.playlist[0].label ?? '';
              const name = lbl.startsWith('/') ? (lbl.split('/')[1] ?? '') : lbl.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
              chData.settings.name = name;
              this.channel.settings.name = name;
              const nameEl = document.getElementById(`channelName-${i}`);
              if (nameEl) { nameEl.value = name; nameEl.title = name; }
            }
            await Storage.setSoundscapes(ss);
          }
        },
        getChannel: () => this.mixer.channels[i]
      }).open();
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

    // ── All scenes ──
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

  // ── Storage helpers ──────────────────────────────────────────────────────────

  async _saveSetting(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    ss.channels[this.channelNr].settings[key] = value;
    this.channel.settings[key] = value;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveRepeat(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    let rpt = ss.channels[this.channelNr].settings.repeat;
    if (!rpt || typeof rpt === 'string') rpt = { repeat: rpt ?? 'none', minDelay: 0, maxDelay: 0 };
    rpt[key] = value;
    ss.channels[this.channelNr].settings.repeat = rpt;
    this.channel.settings.repeat = rpt;
    await Storage.setSoundscapes(soundscapes);
  }

  async _savePlaybackRate(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    let pbr = ss.channels[this.channelNr].settings.playbackRate ?? { rate: 1, preservePitch: 1, random: 0 };
    pbr[key] = value;
    ss.channels[this.channelNr].settings.playbackRate = pbr;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveTiming(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    let tmg = ss.channels[this.channelNr].settings.timing
      ?? { startTime: 0, stopTime: 0, skipFirstTiming: false, fadeIn: 0, fadeOut: 0, skipFirstFade: false };
    tmg[key] = value;
    ss.channels[this.channelNr].settings.timing = tmg;
    this.channel.settings.timing = tmg;
    await Storage.setSoundscapes(soundscapes);
  }

  _makeDraggable(el) { makeDraggable(el); }
}
