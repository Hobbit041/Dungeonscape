/**
 * soundboardConfigDialog.js
 * Floating config panel for a soundboard button.
 * Replaces soundboardConfig.js (Foundry FormApplication).
 * Covers: name, source, image, volume, repeat, playback rate.
 */
import { Storage }        from './storage.js';
import { PlaylistDialog } from './playlistDialog.js';
import { t, tFileCount }  from './i18n.js';
import { pathToUrl }      from './pathUtils.js';
import { makeDraggable }  from './dragPanel.js';
import { showConfirm }    from './dialog.js';

export class SoundboardConfigDialog {
  constructor(soundboard, mixer, btnNr) {
    this.soundboard = soundboard;
    this.mixer      = mixer;
    this.btnNr      = btnNr;
    this.el         = null;
  }

  async open() {
    // Toggle if already open
    const existing = document.getElementById(`sbCfgPanel-${this.btnNr}`);
    if (existing) { existing.remove(); return; }

    const soundscapes = await Storage.getSoundscapes();
    const data = soundscapes[this.mixer.currentSoundscape]?.soundboard?.[this.btnNr];
    if (!data) return;

    const isAllScenes = (soundscapes[this.mixer.currentSoundscape]?.globalSoundboardButtons ?? []).includes(this.btnNr);
    const sd  = data.soundData ?? {};
    const pbr = data.playbackRate ?? { rate: 1, preservePitch: 1, random: 0 };
    const rpt = (data.repeat && typeof data.repeat === 'object')
      ? data.repeat
      : { repeat: data.repeat ?? 'none', minDelay: 0, maxDelay: 0 };
    const interrupt = data.interrupt === true;
    const plCount   = Array.isArray(sd.playlist) ? sd.playlist.length : (sd.source ? 1 : 0);
    const imgName   = data.imageSrc ? data.imageSrc.split(/[\\/]/).pop() : '—';
    const vol  = Math.round((data.volume ?? 1) * 100);
    const rvol = Math.round((data.randomizeVolume ?? 0) * 100);

    const panel = document.createElement('div');
    panel.id = `sbCfgPanel-${this.btnNr}`;
    panel.className = 'fx-panel cfg-panel';
    panel.innerHTML = `
      <div class="fx-header">
        <span>${t('soundboardConfig.title', { n: this.btnNr + 1 })}</span>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="cfg-reset-btn" id="sbCfgReset-${this.btnNr}" title="${t('soundboardConfig.clearTitle')}">🗑</button>
          <button class="fx-close" id="sbCfgClose-${this.btnNr}">✕</button>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('soundboardConfig.nameSection')}</div>
        <div class="fx-row">
          <input class="cfg-text" type="text" id="sbCfgName-${this.btnNr}"
            value="${(data.name ?? '').replace(/"/g, '&quot;')}"
            placeholder="${t('soundboardConfig.namePlaceholder')}" spellcheck="false">
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.allScenes')}</label>
          <input type="checkbox" id="sbCfgAllScenes-${this.btnNr}" ${isAllScenes ? 'checked' : ''}>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.interrupt')}</label>
          <input type="checkbox" id="sbCfgInterrupt-${this.btnNr}" ${interrupt ? 'checked' : ''}>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('soundboardConfig.sourcesSection')}</div>
        <div class="fx-row">
          <span class="cfg-src-name">${tFileCount(plCount)}</span>
          <button id="sbCfgPlaylist-${this.btnNr}"><i class="fas fa-list"></i> ${t('soundboardConfig.openPlaylist')}</button>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('soundboardConfig.imageSection')}</div>
        <div class="fx-row">
          <span class="cfg-src-name" id="sbCfgImgName-${this.btnNr}">${imgName}</span>
          <button id="sbCfgPickImg-${this.btnNr}"><i class="fas fa-image"></i> ${t('soundboardConfig.pickImage')}</button>
          <button id="sbCfgClearImg-${this.btnNr}" title="${t('soundboardConfig.clearImageTitle')}">✕</button>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('soundboardConfig.volumeSection')}</div>
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.volume')}</label>
          <input type="range" id="sbCfgVol-${this.btnNr}" min="0" max="125" step="1" value="${vol}">
          <span class="fx-row-val" id="sbCfgVolVal-${this.btnNr}">${vol}%</span>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.randomVolume')}</label>
          <input type="range" id="sbCfgRVol-${this.btnNr}" min="0" max="100" step="1" value="${rvol}">
          <span class="fx-row-val" id="sbCfgRVolVal-${this.btnNr}">${rvol}%</span>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('soundboardConfig.repeatSection')}</div>
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.repeatMode')}</label>
          <select class="cfg-select" id="sbCfgRepeat-${this.btnNr}">
            <option value="none"   ${rpt.repeat === 'none'   ? 'selected' : ''}>${t('soundboardConfig.repeatNone')}</option>
            <option value="single" ${rpt.repeat === 'single' ? 'selected' : ''}>${t('soundboardConfig.repeatSingle')}</option>
            <option value="all"    ${rpt.repeat === 'all'    ? 'selected' : ''}>${t('soundboardConfig.repeatAll')}</option>
          </select>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.minDelay')}</label>
          <input class="cfg-num" type="number" id="sbCfgMinDelay-${this.btnNr}" min="0" step="0.1" value="${rpt.minDelay ?? 0}">
          <span class="fx-row-unit">s</span>
          <label class="cfg-label">${t('soundboardConfig.maxDelay')}</label>
          <input class="cfg-num" type="number" id="sbCfgMaxDelay-${this.btnNr}" min="0" step="0.1" value="${rpt.maxDelay ?? 0}">
          <span class="fx-row-unit">s</span>
        </div>
      </div>

      <div class="fx-section">
        <div class="fx-section-title">${t('soundboardConfig.playbackRateSection')}</div>
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.rate')}</label>
          <input type="range" id="sbCfgRate-${this.btnNr}" min="25" max="400" step="1" value="${Math.round((pbr.rate ?? 1) * 100)}">
          <span class="fx-row-val" id="sbCfgRateVal-${this.btnNr}">${(pbr.rate ?? 1).toFixed(2)}×</span>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('soundboardConfig.preservePitch')}</label>
          <input type="checkbox" id="sbCfgPreservePitch-${this.btnNr}" ${pbr.preservePitch ? 'checked' : ''}>
          <label class="cfg-label" style="margin-left:12px">${t('soundboardConfig.randomRate')}</label>
          <input type="range" id="sbCfgRateRandom-${this.btnNr}" min="0" max="200" step="1" value="${Math.round((pbr.random ?? 0) * 100)}">
          <span class="fx-row-val" id="sbCfgRateRandomVal-${this.btnNr}">${(pbr.random ?? 0).toFixed(2)}</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    this.el = panel;
    this._makeDraggable(panel);
    this._bindEvents();
  }

  _bindEvents() {
    const i = this.btnNr;

    document.getElementById(`sbCfgClose-${i}`)
      ?.addEventListener('click', () => document.getElementById(`sbCfgPanel-${i}`)?.remove());

    // ── Reset ──
    document.getElementById(`sbCfgReset-${i}`)?.addEventListener('click', async () => {
      if (!await showConfirm(t('soundboardConfig.clearConfirm'))) return;
      await this.mixer.clearSoundboardButton(i);
      document.dispatchEvent(new CustomEvent('playlist-changed', {
        detail: { panelId: `sb-${i}`, playlist: [] }
      }));
      document.getElementById(`sbCfgPanel-${i}`)?.remove();
    });

    // ── All scenes ──
    document.getElementById(`sbCfgAllScenes-${i}`)?.addEventListener('change', async (e) => {
      const enable = e.target.checked;
      if (enable) {
        const soundscapes = await Storage.getSoundscapes();
        const ss = soundscapes[this.mixer.currentSoundscape];
        const curScene = ss?.currentSbScene ?? 0;
        const hasOtherData = (ss?.sbScenes ?? []).some((scene, k) => {
          if (k === curScene) return false;
          const sd = scene.soundboard?.[i]?.soundData;
          return (sd?.playlist?.length > 0) || !!sd?.source;
        });
        if (hasOtherData) {
          if (!await showConfirm(t('soundboardConfig.allScenesConfirm'))) {
            e.target.checked = false;
            return;
          }
        }
      }
      await this.mixer.setAllScenesSoundboard(i, enable);
    });

    // ── Interrupt ──
    document.getElementById(`sbCfgInterrupt-${i}`)?.addEventListener('change', async (e) => {
      await this._saveField('interrupt', e.target.checked);
    });

    // ── Name ──
    document.getElementById(`sbCfgName-${i}`)?.addEventListener('change', async (e) => {
      const name = e.target.value;
      await this._saveField('name', name);
      const label = document.getElementById(`sbLabel-${i}`);
      if (label) label.textContent = name;
    });

    // ── Источники ──
    document.getElementById(`sbCfgPlaylist-${i}`)?.addEventListener('click', () => {
      new PlaylistDialog({
        title:         t('soundboardConfig.playlistTitle', { n: i + 1 }),
        panelId:       `sb-${i}`,
        mode:          'soundboard',
        getSoundData:  async () => {
          const ss = await Storage.getSoundscapes();
          return ss[this.mixer.currentSoundscape]?.soundboard?.[i]?.soundData;
        },
        saveSoundData: async (data) => {
          const ss = await Storage.getSoundscapes();
          if (ss[this.mixer.currentSoundscape]) {
            ss[this.mixer.currentSoundscape].soundboard[i].soundData = data;
            await Storage.setSoundscapes(ss);
          }
        },
        getChannel: () => this.mixer.soundboard.channels[i]
      }).open();
    });

    // ── Image ──
    document.getElementById(`sbCfgPickImg-${i}`)?.addEventListener('click', async () => {
      const paths = await window.api.fs.openDialog({ images: true });
      if (!paths?.length) return;
      const src = paths[0];
      document.getElementById(`sbCfgImgName-${i}`).textContent = src.split(/[\\/]/).pop();
      await this._saveField('imageSrc', src);
      const img = document.getElementById(`sbImg-${i}`);
      if (img) img.src = pathToUrl(src);
    });

    document.getElementById(`sbCfgClearImg-${i}`)?.addEventListener('click', async () => {
      document.getElementById(`sbCfgImgName-${i}`).textContent = '—';
      await this._saveField('imageSrc', '');
      const img = document.getElementById(`sbImg-${i}`);
      if (img) img.src = '';
    });

    // ── Volume ──
    document.getElementById(`sbCfgVol-${i}`)?.addEventListener('input', async (e) => {
      const vol = e.target.value / 100;
      document.getElementById(`sbCfgVolVal-${i}`).textContent = `${e.target.value}%`;
      await this._saveField('volume', vol);
      this.mixer.soundboard.channels[i].setVolume(vol);
    });

    document.getElementById(`sbCfgRVol-${i}`)?.addEventListener('input', async (e) => {
      const rv = e.target.value / 100;
      document.getElementById(`sbCfgRVolVal-${i}`).textContent = `${e.target.value}%`;
      await this._saveField('randomizeVolume', rv);
      this.mixer.soundboard.channels[i].settings.randomizeVolume = rv;
    });

    // ── Repeat ──
    document.getElementById(`sbCfgRepeat-${i}`)?.addEventListener('change', async (e) => {
      await this._saveRepeat('repeat', e.target.value);
    });
    document.getElementById(`sbCfgMinDelay-${i}`)?.addEventListener('change', async (e) => {
      await this._saveRepeat('minDelay', parseFloat(e.target.value) || 0);
    });
    document.getElementById(`sbCfgMaxDelay-${i}`)?.addEventListener('change', async (e) => {
      await this._saveRepeat('maxDelay', parseFloat(e.target.value) || 0);
    });

    // ── Playback Rate ──
    document.getElementById(`sbCfgRate-${i}`)?.addEventListener('input', async (e) => {
      const rate = e.target.value / 100;
      document.getElementById(`sbCfgRateVal-${i}`).textContent = `${rate.toFixed(2)}×`;
      await this._savePlaybackRate('rate', rate);
    });
    document.getElementById(`sbCfgPreservePitch-${i}`)?.addEventListener('change', async (e) => {
      await this._savePlaybackRate('preservePitch', e.target.checked ? 1 : 0);
    });
    document.getElementById(`sbCfgRateRandom-${i}`)?.addEventListener('input', async (e) => {
      const rnd = e.target.value / 100;
      document.getElementById(`sbCfgRateRandomVal-${i}`).textContent = rnd.toFixed(2);
      await this._savePlaybackRate('random', rnd);
    });
  }

  // ── Storage helpers ──────────────────────────────────────────────────────────

  async _saveField(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    ss.soundboard[this.btnNr][key] = value;
    // Sync live settings where applicable
    const liveCh = this.mixer.soundboard.channels[this.btnNr];
    if (liveCh) liveCh.settings[key] = value;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveRepeat(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    let rpt = ss.soundboard[this.btnNr].repeat;
    if (!rpt || typeof rpt === 'string') rpt = { repeat: rpt ?? 'none', minDelay: 0, maxDelay: 0 };
    rpt[key] = value;
    ss.soundboard[this.btnNr].repeat = rpt;
    const liveCh = this.mixer.soundboard.channels[this.btnNr];
    if (liveCh) liveCh.settings.repeat = rpt;
    await Storage.setSoundscapes(soundscapes);
  }

  async _savePlaybackRate(key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    let pbr = ss.soundboard[this.btnNr].playbackRate ?? { rate: 1, preservePitch: 1, random: 0 };
    pbr[key] = value;
    ss.soundboard[this.btnNr].playbackRate = pbr;
    const liveCh = this.mixer.soundboard.channels[this.btnNr];
    if (liveCh && liveCh.settings) liveCh.settings.playbackRate = pbr;
    await Storage.setSoundscapes(soundscapes);
  }

  _makeDraggable(el) { makeDraggable(el); }
}
