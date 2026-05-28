/**
 * mixerUI.js
 * Replaces mixerApp.js — pure DOM manipulation, no Foundry/jQuery.
 * Handles all UI rendering and event binding.
 */
import { Storage }                from './storage.js';
import { FXDialog }               from './fxDialog.js';
import { ChannelConfigDialog }    from './channelConfigDialog.js';
import { SoundboardConfigDialog } from './soundboardConfigDialog.js';
import { filesToPlaylistItems, PlaylistDialog } from './playlistDialog.js';
import { AMBIENT_SIZE }           from './ambientMixer.js';
import { t }                      from './i18n.js';
import { MissingFilesRegistry }  from './missingFilesRegistry.js';
import { checkMissingFiles, MissingFilesDialog } from './missingFilesDialog.js';
import { pathToUrl }              from './pathUtils.js';
import { showConfirm, showAlert } from './dialog.js';
import { FADE_MS, FADE_STOP_MS }  from './audioFade.js';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif']);
const AUDIO_EXT = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'webm']);

/** Extract a display name from a playlist item label.
 *  Folder items have labels like "/FolderName/file.mp3" — use the folder name. */
function _nameFromLabel(label) {
  if (!label) return '';
  if (label.startsWith('/')) return label.split('/')[1] ?? '';
  return label.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

/** Convert a local file path to a file:// URL for use in <img src>. */
function _fileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|blob:)/i.test(p)) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

// ── MIDI entity table ────────────────────────────────────────────────────────
const MIDI_ENTITIES = [
  ...Array.from({ length: 8 }, (_, i) => [
    { key: `ch-${i}-mute`,   targetId: `mute-${i}`,         type: 'noteon',    insertInside: true },
    { key: `ch-${i}-solo`,   targetId: `solo-${i}`,         type: 'noteon',    insertInside: true },
    { key: `ch-${i}-volume`, targetId: `volumeSlider-${i}`, type: 'volume_any' },
    { key: `ch-${i}-play`,   targetId: `playSound-${i}`,    type: 'noteon'    },
    { key: `ch-${i}-prev`,   targetId: `prevTrack-${i}`,    type: 'noteon',    insertInside: true },
    { key: `ch-${i}-next`,   targetId: `nextTrack-${i}`,    type: 'noteon',    insertInside: true },
  ]).flat(),
  { key: 'master-volume', targetId: 'volumeSlider-master', type: 'volume_any' },
  { key: 'master-play',   targetId: 'playMix',             type: 'noteon'    },
  { key: 'sb-stopall',    targetId: 'sbStopAll',           type: 'noteon'    },
  ...Array.from({ length: 25 }, (_, i) => ({
    key: `sb-${i}`, targetId: `sbButton-${i}`, type: 'noteon', insertInside: true
  })),
  ...Array.from({ length: AMBIENT_SIZE }, (_, i) => [
    { key: `amb-${i}-play`,   targetId: `ambPlay-${i}`,   type: 'noteon'     },
    { key: `amb-${i}-volume`, targetId: `ambSlider-${i}`, type: 'volume_any' },
  ]).flat(),
  { key: 'amb-master-volume', targetId: 'ambSlider-master', type: 'volume_any' },
];

function _fmtMapping(m) {
  if (!m) return '';
  if (m.type === 'noteon')      return t('midi.noteMapping',      { note: m.note, channel: m.channel + 1 });
  if (m.type === 'pitchbend')   return t('midi.pitchbendMapping', { channel: m.channel + 1 });
  if (m.type === 'cc_relative') return t('midi.ccMapping',        { cc: m.cc, channel: m.channel + 1 });
  if (m.type === 'cc_auto')    return t('midi.ccAutoMapping',     { cc: m.cc, channel: m.channel + 1 });
  return '';
}
// ────────────────────────────────────────────────────────────────────────────

export class MixerUI {
  constructor(mixer) {
    this.mixer             = mixer;
    this.midi              = null;   // set by app.js after midi init
    this._dragSource       = null;
    this._controlDown      = false;
    this._mappingMode      = false;
    this._missingChannels  = new Map(); // 'music-0' → Set<path>
    this._skipMissingCheck = false;
    this._webServerRunning = false;
    this._webServerUrl     = '';

    this._bindStaticEvents();

    // Listen for playlist changes from PlaylistDialog (any panel)
    document.addEventListener('playlist-changed', (e) => {
      this._onPlaylistChanged(e.detail.panelId, e.detail.playlist);
    });

    // Sync play-state UI when playlist dialog starts a stopped channel
    document.addEventListener('channel-play-state-changed', () => this.updatePlayState());
  }

  // ─── Full render ─────────────────────────────────────────────────────────────

  async render() {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape] ?? {};

    // Header
    this._el('soundscapeName').value  = this.mixer.name ?? '';
    // Update profile list if open
    await this._refreshSoundscapeList();

    // Play button
    this._el('playMix').innerHTML = this.mixer.playing
      ? '<i class="fas fa-stop"></i>'
      : '<i class="fas fa-play"></i>';

    // Master
    const masterVol = ss.master?.settings?.volume ?? 1;
    this._el('volumeSlider-master').value  = masterVol * 100;
    this._el('volumeNumber-master').value  = Math.round(masterVol * 100);
    this._setMuteColor('mute-master', ss.master?.settings?.mute ?? false);

    // Channels
    for (let i = 0; i < 8; i++) {
      const ch   = this.mixer.channels[i];
      const data = ss.channels?.[i];
      if (!data) continue;

      const nameVal = data.settings?.name ?? '';
      this._el(`channelName-${i}`).value       = nameVal;
      this._el(`channelName-${i}`).title       = nameVal;
      this._el(`channelName-${i}`).placeholder = t('mixer.channelNamePlaceholder', { n: i + 1 });
      this._el(`volumeSlider-${i}`).value      = (data.settings?.volume ?? 1) * 100;
      this._el(`volumeNumber-${i}`).value      = Math.round((data.settings?.volume ?? 1) * 100);
      this._setMuteColor(`mute-${i}`, data.settings?.mute ?? false);
      this._setSoloColor(`solo-${i}`, data.settings?.solo ?? false);
      this._setLinkColor(`link-${i}`, data.settings?.link ?? false);
      this._el(`playSound-${i}`).innerHTML = ch.playing
        ? '<i class="fas fa-stop"></i>'
        : '<i class="fas fa-play"></i>';
      this._el(`box-${i}`)?.classList.toggle('is-playing', ch.playing);
    }

    // Scenes
    this._renderScenes(ss);

    // Ambient mixer
    const ambData      = ss.ambient ?? [];
    const ambMasterVol = ss.ambientMaster?.volume ?? 1;
    const ambSlMaster  = this._el('ambSlider-master');
    if (ambSlMaster) ambSlMaster.value = ambMasterVol * 100;
    for (let i = 0; i < AMBIENT_SIZE; i++) {
      const amb = ambData[i] ?? {};
      const nameEl = this._el(`ambName-${i}`);
      const slEl   = this._el(`ambSlider-${i}`);
      const playEl = this._el(`ambPlay-${i}`);
      const ambName = amb.settings?.name ?? '';
      if (nameEl) {
        nameEl.value       = ambName;
        nameEl.title       = ambName;
        nameEl.placeholder = t('ambient.channelNamePlaceholder', { n: i + 1 });
      }
      if (slEl)   slEl.value     = (amb.settings?.volume ?? 1) * 100;
      const ambPlaying = this.mixer.ambientMixer?.channels[i]?.playing ?? false;
      if (playEl) playEl.innerHTML = ambPlaying
        ? '<i class="fas fa-stop"></i>'
        : '<i class="fas fa-play"></i>';
      this._el(`ambBox-${i}`)?.classList.toggle('is-playing', ambPlaying);
    }

    // Soundboard scenes
    this._renderSbScenes(ss);

    // Soundboard
    const sbData = ss.soundboard ?? [];
    const sbGain = ss.soundboardGain ?? 0.75;
    this._el('sbVolume').value = sbGain / 1.5 * 100;

    for (let i = 0; i < 25; i++) {
      const btn = this._el(`sbButton-${i}`);
      if (!btn) continue;
      const d = sbData[i] ?? {};
      const isPlaying = this.mixer.soundboard?.channels[i]?.playing ?? false;
      btn.style.borderColor = isPlaying ? 'yellow' : '';
      btn.style.boxShadow   = isPlaying ? '0 0 8px yellow' : '';

      const label = this._el(`sbLabel-${i}`);
      if (label) label.textContent = d.name ?? '';

      // Image
      const img = this._el(`sbImg-${i}`);
      if (img) img.src = _fileUrl(d.imageSrc);
    }
  }

  updatePlayState() {
    const playing = this.mixer.playing;
    this._el('playMix').innerHTML = playing
      ? '<i class="fas fa-stop"></i>'
      : '<i class="fas fa-play"></i>';
    for (let i = 0; i < 8; i++) {
      const chPlaying = this.mixer.channels[i].playing;
      const btn = this._el(`playSound-${i}`);
      if (btn) btn.innerHTML = chPlaying
        ? '<i class="fas fa-stop"></i>'
        : '<i class="fas fa-play"></i>';
      this._el(`box-${i}`)?.classList.toggle('is-playing', chPlaying);
    }
  }

  updateChannelVolume(channelNr, volume) {
    const sl = this._el(`volumeSlider-${channelNr}`);
    const nb = this._el(`volumeNumber-${channelNr}`);
    if (sl) sl.value = volume * 100;
    if (nb) nb.value = Math.round(volume * 100);
  }

  updateMasterVolume(volume) {
    const sl = this._el('volumeSlider-master');
    const nb = this._el('volumeNumber-master');
    if (sl) sl.value = volume * 100;
    if (nb) nb.value = Math.round(volume * 100);
  }

  updateSoundboardVolume(volume) {
    const el = this._el('sbVolume');
    if (el) el.value = volume / 1.5 * 100;
  }

  /** Update all channel + master volume sliders from live channel state (used by MIDI). */
  updateAllChannelVolumes() {
    for (let i = 0; i < 8; i++) {
      const vol = this.mixer.channels[i].settings.volume ?? 1;
      const sl = this._el(`volumeSlider-${i}`);
      const nb = this._el(`volumeNumber-${i}`);
      if (sl) sl.value = vol * 100;
      if (nb) nb.value = Math.round(vol * 100);
    }
  }

  updateAmbientChannelVolume(i, volume) {
    const sl = this._el(`ambSlider-${i}`);
    if (sl) sl.value = volume * 100;
  }

  updateAmbientMasterVolume(volume) {
    const sl = this._el('ambSlider-master');
    if (sl) sl.value = volume * 100;
  }

  updateAmbientPlayState(i) {
    const ch = this.mixer.ambientMixer?.channels[i];
    if (!ch) return;
    const btn = this._el(`ambPlay-${i}`);
    if (btn) btn.innerHTML = ch.playing ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';
    this._el(`ambBox-${i}`)?.classList.toggle('is-playing', ch.playing);
  }

  updateMute(channelNr, mute) {
    this._setMuteColor(`mute-${channelNr}`, mute);
  }

  updateSolo(channelNr, solo) {
    this._setSoloColor(`solo-${channelNr}`, solo);
  }

  flashSoundboardButton(index) {
    const btn = this._el(`sbButton-${index}`);
    if (!btn) return;
    btn.classList.add('sb-flash');
    setTimeout(() => btn.classList.remove('sb-flash'), 200);
  }

  _updateSbBorder(index) {
    const btn = this._el(`sbButton-${index}`);
    if (!btn) return;
    const isPlaying = this.mixer.soundboard?.channels[index]?.playing ?? false;
    btn.style.borderColor = isPlaying ? 'yellow' : '';
    btn.style.boxShadow   = isPlaying ? '0 0 8px yellow' : '';
  }

  updateMIDIStatus(devices) {
    const el = this._el('midiStatus');
    if (!el) return;
    el.textContent = devices.length > 0
      ? t('header.midiStatusDevices', { devices: devices.join(', ') })
      : t('header.midiStatusNoDevices');
  }

  // ─── Static event binding (called once) ──────────────────────────────────────

  _bindStaticEvents() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Control' || e.key === 'Meta') this._controlDown = true;
      if (e.key === 'F4') { e.preventDefault(); window.api.log.openFolder(); }
    });
    document.addEventListener('keyup',   e => { if (e.key === 'Control' || e.key === 'Meta') this._controlDown = false; });

    // ── MIDI mapping mode ──
    this._on('midiStatus', 'click', () => this._toggleMappingMode());

    // ── Profile list ──
    this._on('soundscapeList', 'click', () => this._openSoundscapeList());

    // ── Soundscape name ──
    this._on('soundscapeName', 'change', async (e) => {
      await this.mixer.renameSoundscape(this.mixer.currentSoundscape, e.target.value);
    });

    // ── Global play/stop ──
    this._on('playMix', 'click', async () => {
      if (this.mixer.playing) {
        const playing = this.mixer.channels.filter(ch => ch.playing);
        // Remove is-playing immediately so visual fade runs in parallel with audio fade
        for (const ch of playing) this._el(`box-${ch.channelNr}`)?.classList.remove('is-playing');
        if (playing.length) await Promise.all(playing.map(ch => ch.fadeOutAndStop(FADE_STOP_MS)));
        this.mixer.playing = false;
      } else {
        this.mixer.start(undefined, FADE_STOP_MS);
      }
      this.updatePlayState();
    });

    // ── Master volume ──
    this._on('volumeSlider-master', 'input', async (e) => {
      const val = e.target.value / 100;
      this._el('volumeNumber-master').value = Math.round(val * 100);
      this.mixer.master.setVolume(val);
      await this._saveMasterVolume(val);
    });
    this._on('volumeNumber-master', 'change', async (e) => {
      const val = e.target.value / 100;
      this._el('volumeSlider-master').value = val * 100;
      this.mixer.master.setVolume(val);
      await this._saveMasterVolume(val);
    });
    this._on('mute-master', 'click', async () => {
      const mute = !this.mixer.master.getMute();
      this.mixer.master.setMuteFade(mute, FADE_STOP_MS);
      this._setMuteColor('mute-master', mute);
      await this._saveMasterMute(mute);
    });

    // ── Soundboard volume & stop ──
    this._on('sbVolume', 'input', async (e) => {
      await this.mixer.soundboard.setVolume(e.target.value / 100 * 1.5);
    });
    this._on('sbStopAll', 'click', () => {
      this.mixer.soundboard.stopAll();
      for (let j = 0; j < 25; j++) this._updateSbBorder(j);
    });

    // ── Import / Export ──
    this._on('btnExport', 'click', () => this._exportData());
    this._on('btnImport', 'click', () => this._importData());

    // ── Per-channel events (delegated) ──
    for (let i = 0; i < 8; i++) {
      this._bindChannelEvents(i);
    }

    // ── Soundboard buttons ──
    for (let i = 0; i < 25; i++) {
      this._bindSoundboardButton(i);
    }

    // ── Ambient channels ──
    for (let i = 0; i < AMBIENT_SIZE; i++) {
      this._bindAmbientChannel(i);
    }

    // ── Ambient master fader ──
    this._on('ambSlider-master', 'input', async (e) => {
      const val = e.target.value / 100;
      this.mixer.ambientMixer?.setMasterVolume(val);
      await this._saveAmbientMasterVolume(val);
    });

    // ── Settings ──
    this._on('settingsBtn', 'click', () => this._openSettingsPanel());

    // ── Add scene ──
    this._on('addScene', 'click', () => this.mixer.addScene());

    // ── Add soundboard scene ──
    this._on('addSbScene', 'click', () => this.mixer.addSoundboardScene());
  }

  _bindChannelEvents(i) {
    // Volume slider
    this._on(`volumeSlider-${i}`, 'input', async (e) => {
      const val = e.target.value / 100;
      this._el(`volumeNumber-${i}`).value = Math.round(val * 100);
      if (this.mixer.channels[i].getLink()) {
        await this.mixer.setLinkVolumes(val, i);
        this._updateLinkedSliders(i);
      } else {
        this.mixer.channels[i].setVolume(val);
      }
      await this._saveChannelVolume(i, val);
    });
    this._on(`volumeNumber-${i}`, 'change', async (e) => {
      const val = e.target.value / 100;
      this._el(`volumeSlider-${i}`).value = val * 100;
      if (this.mixer.channels[i].getLink()) {
        await this.mixer.setLinkVolumes(val, i);
        this._updateLinkedSliders(i);
      } else {
        this.mixer.channels[i].setVolume(val);
      }
      await this._saveChannelVolume(i, val);
    });

    // Mute
    this._on(`mute-${i}`, 'click', async () => {
      const mute = !this.mixer.channels[i].getMute();
      this.mixer.channels[i].setMuteFade(mute, FADE_STOP_MS);
      this._setMuteColor(`mute-${i}`, mute);
      await this._saveChannelSetting(i, 'mute', mute);
    });

    // Solo
    this._on(`solo-${i}`, 'click', () => { this.mixer.toggleSolo(i, FADE_STOP_MS); });

    // Link
    this._on(`link-${i}`, 'click', async () => {
      const link = !this.mixer.channels[i].getLink();
      this.mixer.channels[i].setLink(link);
      this.mixer.configureLink();
      this._setLinkColor(`link-${i}`, link);
      await this._saveChannelSetting(i, 'link', link);
    });

    // Play/stop individual channel
    this._on(`playSound-${i}`, 'click', async () => {
      const ch = this.mixer.channels[i];
      if (ch.playing) {
        // Remove is-playing immediately so visual fade runs in parallel with audio fade
        this._el(`box-${i}`)?.classList.remove('is-playing');
        await ch.fadeOutAndStop(FADE_STOP_MS);
        this.mixer.playing = this.mixer.channels.some(c => c.playing);
      } else {
        this.mixer.start(i, FADE_STOP_MS);
      }
      this.updatePlayState();
    });

    // Prev / Next track — crossfade when playing, plain advance otherwise
    this._on(`prevTrack-${i}`, 'click', async () => {
      const ch = this.mixer.channels[i];
      if (ch.playing && ch.sourceArray?.length) {
        const newIdx = (ch.currentlyPlaying - 1 + ch.sourceArray.length) % ch.sourceArray.length;
        await ch._crossfadeTo(newIdx, FADE_MS);
      } else {
        ch.previous();
      }
    });
    this._on(`nextTrack-${i}`, 'click', async () => {
      const ch = this.mixer.channels[i];
      if (ch.playing && ch.sourceArray?.length) {
        const newIdx = (ch.currentlyPlaying + 1) % ch.sourceArray.length;
        await ch._crossfadeTo(newIdx, FADE_MS);
      } else {
        ch.next();
      }
    });

    // Config dialog (repeat / timing / playback rate / source)
    this._on(`config-${i}`, 'click', () => {
      new ChannelConfigDialog(this.mixer.channels[i], this.mixer, i).open();
    });

    // FX panel (EQ + Delay)
    this._on(`fx-${i}`, 'click', () => {
      new FXDialog(this.mixer.channels[i], this.mixer).open();
    });

    // Channel name
    this._on(`channelName-${i}`, 'change', async (e) => {
      e.target.title = e.target.value;
      await this._saveChannelSetting(i, 'name', e.target.value);
    });

    // Drag-and-drop from OS (channel box)
    const box = this._el(`box-${i}`);
    if (box) {
      box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag-over'); });
      box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag-over'); });
      box.addEventListener('drop', async (e) => {
        e.preventDefault();
        box.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;

        if (e.ctrlKey) {
          const folders = files.filter(f => !AUDIO_EXT.has(f.name.split('.').pop().toLowerCase()));
          if (folders.length) { await this._addFolderLinksToChannel(i, folders); return; }
        }

        const newItems = await filesToPlaylistItems(files);
        if (!newItems.length) return;

        const behavior = (await Storage.getDropBehavior()).music ?? 'overwrite';

        if (behavior === 'overwrite') {
          const name = _nameFromLabel(newItems[0]?.label);
          await this.mixer.newData(i, { type: 'playlist', playlist: newItems, name });
          return;
        }

        const ss = await Storage.getSoundscapes();
        const chData = ss[this.mixer.currentSoundscape]?.channels[i];
        if (!chData) return;
        const existing = Array.isArray(chData.soundData?.playlist) ? chData.soundData.playlist : [];

        if (!existing.length) {
          // Nothing in the queue yet — treat as overwrite
          const name = _nameFromLabel(newItems[0]?.label);
          await this.mixer.newData(i, { type: 'playlist', playlist: newItems, name });
          return;
        }

        const ch = this.mixer.channels[i];
        const insertIdx = ch.currentlyPlaying ?? 0;
        const merged = behavior === 'next'
          ? [...existing.slice(0, insertIdx + 1), ...newItems, ...existing.slice(insertIdx + 1)]
          : [...existing, ...newItems];

        chData.soundData = { playlist: merged, shuffle: chData.soundData?.shuffle ?? false };
        ss[this.mixer.currentSoundscape].channels[i] = chData;
        await Storage.setSoundscapes(ss);

        const newUrls = newItems.map(item => pathToUrl(item.path)).filter(Boolean);
        if (behavior === 'next') {
          ch.sourceArray = [
            ...ch.sourceArray.slice(0, insertIdx + 1),
            ...newUrls,
            ...ch.sourceArray.slice(insertIdx + 1),
          ];
        } else {
          ch.sourceArray.push(...newUrls);
        }
        this.mixer.renderUI();
      });
    }
  }

  _bindSoundboardButton(i) {
    const btn = this._el(`sbButton-${i}`);
    if (!btn) return;

    // Left click = play
    btn.addEventListener('click', (e) => {
      if (e.target.classList.contains('sbConfig')) return;
      this.mixer.soundboard.playSound(i);
      this.flashSoundboardButton(i);
      this._updateSbBorder(i);
    });

    // Right click = open config dialog
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      new SoundboardConfigDialog(this.mixer.soundboard, this.mixer, i).open();
    });

    // Drag-and-drop
    btn.addEventListener('dragover', e => { e.preventDefault(); btn.classList.add('drag-over'); });
    btn.addEventListener('dragleave', (e) => { if (!btn.contains(e.relatedTarget)) btn.classList.remove('drag-over'); });
    btn.addEventListener('drop', async (e) => {
      e.preventDefault();
      btn.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;

      const firstPath = files[0].path;
      const ext = (firstPath ?? files[0].name).split('.').pop().toLowerCase();

      if (IMAGE_EXT.has(ext)) {
        // Set as button icon
        await this.mixer.soundboard.newData(i, { type: 'image', source: firstPath });
        const img = this._el(`sbImg-${i}`);
        if (img) img.src = _fileUrl(firstPath);
      } else {
        const newItems = await filesToPlaylistItems(files);
        if (!newItems.length) return;

        const behavior = (await Storage.getDropBehavior()).sb ?? 'overwrite';

        if (behavior === 'overwrite') {
          const name = _nameFromLabel(newItems[0]?.label);
          await this.mixer.soundboard.newData(i, { type: 'playlist', playlist: newItems, name });
        } else {
          const ss = await Storage.getSoundscapes();
          const sbData = ss[this.mixer.currentSoundscape]?.soundboard[i];
          if (!sbData) return;
          const existing = Array.isArray(sbData.soundData?.playlist) ? sbData.soundData.playlist : [];

          if (!existing.length) {
            const name = _nameFromLabel(newItems[0]?.label);
            await this.mixer.soundboard.newData(i, { type: 'playlist', playlist: newItems, name });
          } else {
            const ch = this.mixer.soundboard.channels[i];
            const insertIdx = ch.currentlyPlaying ?? 0;
            const merged = behavior === 'next'
              ? [...existing.slice(0, insertIdx + 1), ...newItems, ...existing.slice(insertIdx + 1)]
              : [...existing, ...newItems];

            sbData.soundData = { ...sbData.soundData, playlist: merged };
            ss[this.mixer.currentSoundscape].soundboard[i] = sbData;
            await Storage.setSoundscapes(ss);

            const newUrls = newItems.map(item => pathToUrl(item.path)).filter(Boolean);
            if (behavior === 'next') {
              ch.sourceArray = [
                ...ch.sourceArray.slice(0, insertIdx + 1),
                ...newUrls,
                ...ch.sourceArray.slice(insertIdx + 1),
              ];
            } else {
              ch.sourceArray.push(...newUrls);
            }
            this.mixer.renderUI();
          }
        }
      }
    });
  }

  _bindAmbientChannel(i) {
    // Volume fader
    this._on(`ambSlider-${i}`, 'input', async (e) => {
      const val = e.target.value / 100;
      this.mixer.ambientMixer?.channels[i].setVolume(val);
      await this._saveAmbientVolume(i, val);
    });

    // Play/stop toggle
    this._on(`ambPlay-${i}`, 'click', () => {
      const ch = this.mixer.ambientMixer?.channels[i];
      if (!ch) return;
      if (ch.playing) ch.stop();
      else            ch.play();
      const btn = this._el(`ambPlay-${i}`);
      if (btn) btn.innerHTML = ch.playing
        ? '<i class="fas fa-stop"></i>'
        : '<i class="fas fa-play"></i>';
      this._el(`ambBox-${i}`)?.classList.toggle('is-playing', ch.playing);
    });

    // Config button → open playlist dialog
    this._on(`ambConfig-${i}`, 'click', () => this._openAmbientPlaylist(i));

    // Name input
    this._on(`ambName-${i}`, 'change', async (e) => {
      e.target.title = e.target.value;
      await this._saveAmbientSetting(i, 'name', e.target.value);
      const ch = this.mixer.ambientMixer?.channels[i];
      if (ch) ch.settings.name = e.target.value;
    });

    // Drag-and-drop + right-click
    const box = this._el(`ambBox-${i}`);
    if (box) {
      box.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._openAmbientPlaylist(i);
      });

      box.addEventListener('dragover',  e => { e.preventDefault(); box.classList.add('drag-over'); });
      box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag-over'); });
      box.addEventListener('drop', async (e) => {
        e.preventDefault();
        box.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;

        if (e.ctrlKey) {
          const folders = files.filter(f => !AUDIO_EXT.has(f.name.split('.').pop().toLowerCase()));
          if (folders.length) { await this._addFolderLinksToAmbient(i, folders); return; }
        }

        const newItems = await filesToPlaylistItems(files);
        if (!newItems.length) return;

        const behavior = (await Storage.getDropBehavior()).bg ?? 'overwrite';

        const ss = await Storage.getSoundscapes();
        if (!ss[this.mixer.currentSoundscape]) return;
        if (!ss[this.mixer.currentSoundscape].ambient)
          ss[this.mixer.currentSoundscape].ambient = [];
        if (!ss[this.mixer.currentSoundscape].ambient[i])
          ss[this.mixer.currentSoundscape].ambient[i] =
            { settings: { volume: 1, name: '' }, soundData: {} };

        const ambEntry = ss[this.mixer.currentSoundscape].ambient[i];
        const existing = Array.isArray(ambEntry.soundData?.playlist) ? ambEntry.soundData.playlist : [];
        const ch = this.mixer.ambientMixer?.channels[i];

        if (behavior === 'overwrite' || !existing.length) {
          ambEntry.soundData = { playlist: newItems, shuffle: ambEntry.soundData?.shuffle ?? false };
          const newName = (newItems[0]?.label ?? '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
          if (!ambEntry.settings.name && newName) ambEntry.settings.name = newName;
          await Storage.setSoundscapes(ss);

          if (ch) {
            const urls = newItems.map(item => pathToUrl(item.path)).filter(Boolean);
            ch.sourceArray = urls;
            ch.settings.name = ambEntry.settings.name;
          }

          // Update name input in DOM
          const nameEl = this._el(`ambName-${i}`);
          if (nameEl) nameEl.value = ambEntry.settings.name;
        } else {
          const insertIdx = ch?.currentlyPlaying ?? 0;
          const merged = behavior === 'next'
            ? [...existing.slice(0, insertIdx + 1), ...newItems, ...existing.slice(insertIdx + 1)]
            : [...existing, ...newItems];

          ambEntry.soundData = { playlist: merged, shuffle: ambEntry.soundData?.shuffle ?? false };
          await Storage.setSoundscapes(ss);

          if (ch) {
            const newUrls = newItems.map(item => pathToUrl(item.path)).filter(Boolean);
            if (behavior === 'next') {
              ch.sourceArray = [
                ...ch.sourceArray.slice(0, insertIdx + 1),
                ...newUrls,
                ...ch.sourceArray.slice(insertIdx + 1),
              ];
            } else {
              ch.sourceArray.push(...newUrls);
            }
          }
        }

        // Restore slider value — Chromium may alter range inputs during OS drag-and-drop
        const slEl = this._el(`ambSlider-${i}`);
        if (slEl) slEl.value = (ambEntry.settings.volume ?? 1) * 100;
      });
    }
  }

  _openAmbientPlaylist(i) {
    new PlaylistDialog({
      title:         t('ambient.playlistTitle', { n: i + 1 }),
      panelId:       `amb-${i}`,
      getSoundData:  async () => {
        const ss = await Storage.getSoundscapes();
        return ss[this.mixer.currentSoundscape]?.ambient?.[i]?.soundData;
      },
      saveSoundData: async (data) => {
        const ss = await Storage.getSoundscapes();
        if (ss[this.mixer.currentSoundscape]) {
          if (!ss[this.mixer.currentSoundscape].ambient)
            ss[this.mixer.currentSoundscape].ambient = [];
          if (!ss[this.mixer.currentSoundscape].ambient[i])
            ss[this.mixer.currentSoundscape].ambient[i] =
              { settings: { volume: 1, name: '' }, soundData: {} };
          ss[this.mixer.currentSoundscape].ambient[i].soundData = data;
          await Storage.setSoundscapes(ss);
        }
      },
      getChannel: () => this.mixer.ambientMixer?.channels[i],
      mode:       'ambient',
      onClear:    async () => { await this.mixer.clearAmbientChannel(i); }
    }).open();
  }

  // ─── Scenes ──────────────────────────────────────────────────────────────────

  _renderScenes(ss) {
    const scenes       = ss.scenes ?? [];
    const currentScene = ss.currentScene ?? 0;
    const addBtn       = this._el('addScene');
    if (!addBtn) return;

    const row = addBtn.parentElement;

    // Remove edit wraps only — scene buttons are reused in-place so that
    // CSS transitions fire correctly when the active scene changes.
    row.querySelectorAll('.scene-edit-wrap').forEach(el => el.remove());

    // Index existing scene buttons by their scene index
    const existing = new Map(
      [...row.querySelectorAll('.scene-btn[data-scene-idx]')]
        .map(b => [+b.dataset.sceneIdx, b])
    );

    scenes.forEach((scene, idx) => {
      const isActive = idx === currentScene;
      const name = scene.name || t('scenes.defaultName', { n: idx + 1 });
      let btn = existing.get(idx);

      if (btn) {
        existing.delete(idx);
        btn.classList.toggle('scene-active', isActive);
        btn.textContent = name;
        btn.dataset.sceneName = name;
      } else {
        btn = document.createElement('button');
        btn.dataset.sceneIdx  = idx;
        btn.dataset.sceneName = name;
        btn.className = 'scene-btn' + (isActive ? ' scene-active' : '');
        btn.textContent = name;

        btn.addEventListener('click', () => {
          const curIdx = this._currentSceneFromRow();
          if (curIdx === null || idx === curIdx) return;
          // Swap classes immediately so the CSS transition fires on click,
          // not after the async switchScene IPC round-trips complete.
          const curBtn = row.querySelector(`.scene-btn[data-scene-idx="${curIdx}"]`);
          if (curBtn) curBtn.classList.remove('scene-active');
          btn.classList.add('scene-active');
          this.mixer.switchScene(idx);
        });

        btn.addEventListener('contextmenu', e => {
          e.preventDefault();
          const sceneCount = row.querySelectorAll('.scene-btn[data-scene-idx]').length;
          this._editScene(btn, idx, btn.dataset.sceneName || t('scenes.defaultName', { n: idx + 1 }), sceneCount);
        });

        this._bindSceneDrag(btn, idx, 'scene');
        row.insertBefore(btn, addBtn);
      }
    });

    // Remove buttons for deleted scenes
    existing.forEach(btn => btn.remove());

    // Ensure DOM order matches scene index order after additions/removals
    [...row.querySelectorAll('.scene-btn[data-scene-idx]')]
      .sort((a, b) => +a.dataset.sceneIdx - +b.dataset.sceneIdx)
      .forEach(btn => row.insertBefore(btn, addBtn));

    addBtn.style.display = scenes.length >= 16 ? 'none' : '';
    if (this._mappingMode) this._injectSceneMappingControls();
  }

  _currentSceneFromRow() {
    const active = document.querySelector('.scene-btn.scene-active');
    return active ? parseInt(active.dataset.sceneIdx) : null;
  }

  _editScene(btn, idx, currentName, sceneCount) {
    const wrap = document.createElement('span');
    wrap.className = 'scene-edit-wrap';

    const input = document.createElement('input');
    input.className  = 'scene-name-input';
    input.type       = 'text';
    input.value      = currentName;
    input.spellcheck = false;

    const trash = document.createElement('button');
    trash.className   = 'scene-trash-btn';
    trash.title       = t('scenes.deleteTitle');
    trash.textContent = '🗑';
    trash.disabled    = sceneCount <= 1;

    wrap.appendChild(input);
    wrap.appendChild(trash);
    btn.replaceWith(wrap);
    input.focus();
    input.select();

    let trashClicked = false;
    let cancelled = false;

    trash.addEventListener('mousedown', () => { trashClicked = true; });

    trash.addEventListener('click', async () => {
      await this.mixer.removeScene(idx);
      // render() is called by removeScene → renderUI()
    });

    const finishEdit = async () => {
      if (trashClicked) return;  // trash click handles its own re-render via removeScene → renderUI
      if (!cancelled) {
        const newName = input.value.trim() || t('scenes.defaultName', { n: idx + 1 });
        await this.mixer.renameScene(idx, newName);
      }
      // Re-render scenes only
      const soundscapes = await Storage.getSoundscapes();
      this._renderScenes(soundscapes[this.mixer.currentSoundscape]);
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { input.blur(); }
      if (e.key === 'Escape') { cancelled = true; input.blur(); }
    });
  }

  // ─── Soundboard Scenes ───────────────────────────────────────────────────────

  _renderSbScenes(ss) {
    const sbScenes       = ss.sbScenes ?? [];
    const currentSbScene = ss.currentSbScene ?? 0;
    const addBtn         = this._el('addSbScene');
    if (!addBtn) return;

    const row = addBtn.parentElement;
    row.querySelectorAll('.sb-scene-btn, .sb-scene-edit-wrap').forEach(el => el.remove());

    sbScenes.forEach((scene, idx) => {
      const btn = document.createElement('button');
      btn.className = 'sb-scene-btn' + (idx === currentSbScene ? ' sb-scene-active' : '');
      btn.dataset.sbSceneIdx = idx;
      btn.textContent = scene.name || t('scenes.sbDefaultName', { n: idx + 1 });

      btn.addEventListener('click', () => {
        this.mixer.switchSoundboardScene(idx);
      });

      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        this._editSbScene(btn, idx, scene.name || t('scenes.sbDefaultName', { n: idx + 1 }), sbScenes.length);
      });

      this._bindSceneDrag(btn, idx, 'sbScene');

      row.insertBefore(btn, addBtn);
    });

    addBtn.style.display = sbScenes.length >= 16 ? 'none' : '';
  }

  _editSbScene(btn, idx, currentName, sceneCount) {
    const wrap = document.createElement('span');
    wrap.className = 'sb-scene-edit-wrap scene-edit-wrap';

    const input = document.createElement('input');
    input.className  = 'scene-name-input';
    input.type       = 'text';
    input.value      = currentName;
    input.spellcheck = false;

    const trash = document.createElement('button');
    trash.className   = 'scene-trash-btn';
    trash.title       = t('scenes.sbDeleteTitle');
    trash.textContent = '🗑';
    trash.disabled    = sceneCount <= 1;

    wrap.appendChild(input);
    wrap.appendChild(trash);
    btn.replaceWith(wrap);
    input.focus();
    input.select();

    let trashClicked = false;
    let cancelled = false;

    trash.addEventListener('mousedown', () => { trashClicked = true; });

    trash.addEventListener('click', async () => {
      await this.mixer.removeSoundboardScene(idx);
    });

    const finishEdit = async () => {
      if (trashClicked) return;  // trash click handles its own re-render via removeSoundboardScene → renderUI
      if (!cancelled) {
        const newName = input.value.trim() || t('scenes.sbDefaultName', { n: idx + 1 });
        await this.mixer.renameSoundboardScene(idx, newName);
      }
      const soundscapes = await Storage.getSoundscapes();
      this._renderSbScenes(soundscapes[this.mixer.currentSoundscape]);
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { input.blur(); }
      if (e.key === 'Escape') { cancelled = true; input.blur(); }
    });
  }

  // ─── Scene button hold-to-drag reordering ────────────────────────────────────

  _bindSceneDrag(btn, idx, type) {
    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      let curX = e.clientX, curY = e.clientY;

      const trackMouse = (ev) => { curX = ev.clientX; curY = ev.clientY; };
      const cancel = () => {
        clearTimeout(timer);
        document.removeEventListener('mousemove', trackMouse);
        document.removeEventListener('mouseup',   cancel);
        btn.removeEventListener('mouseleave',     cancel);
      };
      document.addEventListener('mousemove', trackMouse);
      document.addEventListener('mouseup',   cancel);
      btn.addEventListener('mouseleave',     cancel);

      const timer = setTimeout(() => {
        document.removeEventListener('mousemove', trackMouse);
        document.removeEventListener('mouseup',   cancel);
        btn.removeEventListener('mouseleave',     cancel);

        const rect    = btn.getBoundingClientRect();
        const offsetX = curX - rect.left;
        const offsetY = curY - rect.top;

        // Build ghost clone
        const ghost = btn.cloneNode(true);
        ghost.removeAttribute('id');
        ghost.querySelectorAll('[id]').forEach(c => c.removeAttribute('id'));
        ghost.classList.add('ch-drag-ghost');
        Object.assign(ghost.style, {
          position:        'fixed',
          left:            `${rect.left}px`,
          top:             `${rect.top}px`,
          width:           `${rect.width}px`,
          height:          `${rect.height}px`,
          zIndex:          '9999',
          pointerEvents:   'none',
          opacity:         '0.85',
          transform:       'scale(1)',
          transformOrigin: 'center center',
          transition:      'transform 0.2s ease',
          margin:          '0',
        });
        document.body.appendChild(ghost);
        requestAnimationFrame(() => { ghost.style.transform = 'scale(0.9)'; });

        btn.classList.add('ch-drag-source');

        const suppressClick = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          btn.removeEventListener('click', suppressClick, true);
        };
        btn.addEventListener('click', suppressClick, true);

        const selector = type === 'scene' ? '.scene-btn' : '.sb-scene-btn';
        // { target, insertBefore } — current drop indicator state
        let dragState = null;

        const clearIndicator = () => {
          if (dragState?.target) {
            dragState.target.classList.remove('scene-drag-before', 'scene-drag-after');
          }
          dragState = null;
        };

        const onMove = (ev) => {
          ghost.style.left = `${ev.clientX - offsetX}px`;
          ghost.style.top  = `${ev.clientY - offsetY}px`;

          const under  = document.elementFromPoint(ev.clientX, ev.clientY);
          const target = under?.closest(selector) ?? null;
          if (!target || target === btn) { clearIndicator(); return; }

          const tRect       = target.getBoundingClientRect();
          const isBefore    = ev.clientX < tRect.left + tRect.width / 2;
          const toIdx       = parseInt(type === 'scene'
            ? (target.dataset.sceneIdx   ?? '-1')
            : (target.dataset.sbSceneIdx ?? '-1'));
          const insertBefore = isBefore ? toIdx : toIdx + 1;

          if (dragState?.target === target && dragState?.insertBefore === insertBefore) return;
          clearIndicator();
          target.classList.add(isBefore ? 'scene-drag-before' : 'scene-drag-after');
          dragState = { target, insertBefore };
        };

        const onUp = async () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup',   onUp);
          const state = dragState;
          clearIndicator();

          if (state) {
            if (type === 'scene') await this.mixer.moveScene(idx, state.insertBefore);
            else                  await this.mixer.moveSoundboardScene(idx, state.insertBefore);
            ghost.remove();
            btn.classList.remove('ch-drag-source');
            return;
          }

          // Animate back to original position
          ghost.style.transition = 'left 0.22s ease, top 0.22s ease, transform 0.22s ease';
          ghost.style.left       = `${rect.left}px`;
          ghost.style.top        = `${rect.top}px`;
          ghost.style.transform  = 'scale(1)';
          setTimeout(() => {
            ghost.remove();
            btn.classList.remove('ch-drag-source');
          }, 240);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        onMove({ clientX: curX, clientY: curY });
      }, 600);
    });
  }

  // ─── Folder-link helpers ─────────────────────────────────────────────────────

  async _addFolderLinksToChannel(i, files) {
    const ss = await Storage.getSoundscapes();
    const chData = ss[this.mixer.currentSoundscape]?.channels[i];
    if (!chData) return;
    const soundData = chData.soundData ?? {};
    const folderLinks = Array.isArray(soundData.folderLinks) ? [...soundData.folderLinks] : [];

    for (const file of files) {
      const folderPath = file.path;
      if (!folderPath || folderLinks.includes(folderPath)) continue;
      folderLinks.push(folderPath);
    }

    // playlist must be an array so getSounds() takes the playlist branch and sees folderLinks
    soundData.playlist    = soundData.playlist ?? [];
    soundData.folderLinks = folderLinks;
    chData.soundData      = soundData;

    if (!chData.settings.name && files[0]?.name) chData.settings.name = files[0].name;

    ss[this.mixer.currentSoundscape].channels[i] = chData;
    await Storage.setSoundscapes(ss);

    // Re-initialize channel: builds sourceArray via getSounds (which reads folderLinks) and primes audio
    await this.mixer.channels[i].setData(chData);
    this.mixer.renderUI();
  }

  async _addFolderLinksToAmbient(i, files) {
    const ss = await Storage.getSoundscapes();
    if (!ss[this.mixer.currentSoundscape]) return;
    if (!ss[this.mixer.currentSoundscape].ambient)
      ss[this.mixer.currentSoundscape].ambient = [];
    if (!ss[this.mixer.currentSoundscape].ambient[i])
      ss[this.mixer.currentSoundscape].ambient[i] =
        { settings: { volume: 1, name: '' }, soundData: {} };

    const ambEntry = ss[this.mixer.currentSoundscape].ambient[i];
    const soundData = ambEntry.soundData ?? {};
    const folderLinks = Array.isArray(soundData.folderLinks) ? [...soundData.folderLinks] : [];

    for (const file of files) {
      const folderPath = file.path;
      if (!folderPath || folderLinks.includes(folderPath)) continue;
      folderLinks.push(folderPath);
    }

    soundData.playlist    = soundData.playlist ?? [];
    soundData.folderLinks = folderLinks;
    ambEntry.soundData    = soundData;

    if (!ambEntry.settings.name && files[0]?.name) ambEntry.settings.name = files[0].name;

    await Storage.setSoundscapes(ss);

    // AmbientChannel.setData is sync and only reads playlist — build sourceArray manually
    const ch = this.mixer.ambientMixer?.channels[i];
    if (ch) {
      const folderUrls = [];
      for (const fp of folderLinks) {
        const newFiles = await window.api.fs.readFolder(fp);
        folderUrls.push(...newFiles.map(f => pathToUrl(f)).filter(Boolean));
      }
      ch.sourceArray = [
        ...soundData.playlist.map(item => pathToUrl(item.path)).filter(Boolean),
        ...folderUrls,
      ];
      ch.settings.name = ambEntry.settings.name;
      const nameEl = this._el(`ambName-${i}`);
      if (nameEl) nameEl.value = ambEntry.settings.name;
    }
    this.mixer.renderUI();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _el(id) { return document.getElementById(id); }

  _on(id, event, handler) {
    const el = this._el(id);
    if (!el) return;
    el.addEventListener(event, (...args) => {
      const result = handler(...args);
      // Fire immediately (before Storage writes) so the debounce timer is tied
      // to user actions, not to async IPC completion. If we waited for the Promise,
      // each Storage write would reset the 50ms timer, causing multi-second delays
      // when the user drags a slider continuously.
      if (event === 'input' || event === 'click' || event === 'change') {
        this.mixer.onControlChange?.();
      }
      return result;
    });
  }

  _setMuteColor(id, mute) {
    const el = this._el(id);
    if (el) el.style.backgroundColor = mute ? '#ff0000' : '#7f0000';
  }

  _setSoloColor(id, solo) {
    const el = this._el(id);
    if (el) el.style.backgroundColor = solo ? '#ffff00' : '#7f7f00';
  }

  _setLinkColor(id, link) {
    const el = this._el(id);
    if (el) el.style.backgroundColor = link ? '#1496ff' : '#0820cc';
  }

  _updateLinkedSliders(excludeIdx) {
    for (let j = 0; j < 8; j++) {
      if (j === excludeIdx || !this.mixer.linkArray[j]) continue;
      const v = this.mixer.channels[j].settings.volume;
      const slider = this._el(`volumeSlider-${j}`);
      const number = this._el(`volumeNumber-${j}`);
      if (slider) slider.value = v * 100;
      if (number) number.value = Math.round(v * 100);
    }
  }

  // ─── Settings panel ──────────────────────────────────────────────────────────

  _openSettingsPanel() {
    const existing = document.getElementById('settingsPanel');
    if (existing) {
      existing.remove();
      document.getElementById('settingsOverlay')?.remove();
      return;
    }

    const DROP_OPTIONS = `
      <option value="overwrite">${t('settings.dropOverwrite')}</option>
      <option value="next">${t('settings.dropNext')}</option>
      <option value="append">${t('settings.dropAppend')}</option>
    `;

    const panel = document.createElement('div');
    panel.id        = 'settingsPanel';
    panel.className = 'settings-panel fx-panel';
    panel.innerHTML = `
      <div class="fx-header settings-panel-header">
        <span>${t('settings.title')}</span>
        <button class="fx-close" id="settingsPanelClose">✕</button>
      </div>
      <div class="settings-panel-body">

        <div class="settings-section">
          <div class="settings-section-title">${t('settings.midiSection')}</div>
          <div class="settings-row">
            <button class="settings-btn" id="settingsMidiExport">
              <i class="fas fa-file-export"></i> ${t('settings.exportMidi')}
            </button>
            <button class="settings-btn" id="settingsMidiImport">
              <i class="fas fa-file-import"></i> ${t('settings.importMidi')}
            </button>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">${t('settings.dropBehaviorSection')}</div>
          <p class="settings-drop-hint settings-drop-hint-static">${t('settings.dropBehaviorDesc')}</p>
          <div class="settings-drop-grid">
            <label class="settings-drop-label">${t('settings.dropMusic')}</label>
            <select class="settings-select" id="dropBehaviorMusic">${DROP_OPTIONS}</select>
            <label class="settings-drop-label">${t('settings.dropBg')}</label>
            <select class="settings-select" id="dropBehaviorBg">${DROP_OPTIONS}</select>
            <label class="settings-drop-label">${t('settings.dropSb')}</label>
            <select class="settings-select" id="dropBehaviorSb">${DROP_OPTIONS}</select>
          </div>
          <p class="settings-drop-hint" id="dropBehaviorHint"></p>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">${t('settings.otherSection')}</div>
          <div class="settings-drop-grid">
            <label class="settings-drop-label">${t('settings.language')}</label>
            <select class="settings-select" id="settingsLanguage">
              <option value="ru">${t('settings.langRu')}</option>
            </select>
          </div>
          <div class="settings-row">
            <button class="settings-btn" id="settingsProfileExport">
              <i class="fas fa-file-export"></i> ${t('settings.exportProfiles')}
            </button>
            <button class="settings-btn" id="settingsProfileImport">
              <i class="fas fa-file-import"></i> ${t('settings.importProfiles')}
            </button>
          </div>
          <div class="settings-row" style="margin-top:8px">
            <button class="settings-btn" id="settingsCheckFiles">
              <i class="fas fa-search"></i> ${t('settings.checkMissingFiles')}
            </button>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">${t('settings.dataLocationSection')}</div>
          <div class="settings-drop-grid">
            <label class="settings-drop-label">${t('settings.dataLocationLabel')}</label>
            <select class="settings-select" id="settingsDataLocation">
              <option value="appdata">${t('settings.dataLocationAppData')}</option>
              <option value="launcher">${t('settings.dataLocationLauncher')}</option>
              <option value="custom">${t('settings.dataLocationCustom')}</option>
            </select>
          </div>
          <p class="settings-drop-hint settings-drop-hint-static" id="settingsDataLocationHint" style="margin-top:6px;word-break:break-all"></p>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">${t('settings.remoteControlSection')}</div>
          <div class="settings-row" id="remoteControlRow">
            <button class="settings-btn" id="settingsRemoteStart"
              style="${this._webServerRunning ? 'display:none' : ''}">
              <i class="fas fa-wifi"></i> ${t('settings.remoteControlStart')}
            </button>
            <div id="remoteActiveRow" style="display:${this._webServerRunning ? 'flex' : 'none'}; align-items:center; gap:8px; flex-wrap:wrap">
              <code id="remoteControlUrl" class="settings-remote-url"
                title="${t('settings.remoteControlCopy')}">${this._webServerUrl}</code>
              <button class="settings-btn settings-btn-danger" id="settingsRemoteStop">
                <i class="fas fa-stop"></i> ${t('settings.remoteControlStop')}
              </button>
            </div>
          </div>
        </div>

        <div class="settings-copyright">
          <span id="settingsVersion"></span>
          <span>© Максим &lsquo;Роланд&rsquo; Тренин</span>
        </div>

      </div>
    `;
    // Overlay
    const overlay = document.createElement('div');
    overlay.id        = 'settingsOverlay';
    overlay.className = 'settings-overlay';
    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    // Fill version asynchronously
    window.api.getAppVersion().then(v => {
      const el = document.getElementById('settingsVersion');
      if (el) el.textContent = `v${v}`;
    }).catch(() => {});

    // Center on screen
    panel.style.left = `${Math.round((window.innerWidth  - panel.offsetWidth)  / 2)}px`;
    panel.style.top  = `${Math.round((window.innerHeight - panel.offsetHeight) / 2)}px`;

    const closeSettings = () => {
      document.getElementById('settingsPanel')?.remove();
      document.getElementById('settingsOverlay')?.remove();
    };

    // MIDI buttons
    document.getElementById('settingsPanelClose')
      ?.addEventListener('click', closeSettings);
    document.getElementById('settingsMidiExport')
      ?.addEventListener('click', () => this._exportMidiMappings());
    document.getElementById('settingsMidiImport')
      ?.addEventListener('click', () => this._importMidiMappings());

    // Profile export/import
    document.getElementById('settingsProfileExport')
      ?.addEventListener('click', () => this._exportProfiles());
    document.getElementById('settingsProfileImport')
      ?.addEventListener('click', () => this._importProfiles());

    // Missing files check
    document.getElementById('settingsCheckFiles')?.addEventListener('click', async () => {
      closeSettings();
      await this._runMissingFilesCheck({ silent: false, forceDialog: true });
    });

    // Remote control
    const _updateRemoteUI = (running, url) => {
      const startBtn  = document.getElementById('settingsRemoteStart');
      const activeRow = document.getElementById('remoteActiveRow');
      const urlCode   = document.getElementById('remoteControlUrl');
      if (startBtn)  startBtn.style.display  = running ? 'none' : '';
      if (activeRow) activeRow.style.display  = running ? 'flex' : 'none';
      if (urlCode)   urlCode.textContent      = url ?? '';
    };
    document.getElementById('settingsRemoteStart')?.addEventListener('click', async () => {
      const { url } = await window.api.web.serverStart();
      this._webServerRunning = true;
      this._webServerUrl     = url;
      _updateRemoteUI(true, url);
    });
    document.getElementById('remoteControlUrl')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this._webServerUrl).catch(() => {});
    });
    document.getElementById('settingsRemoteStop')?.addEventListener('click', async () => {
      await window.api.web.serverStop();
      this._webServerRunning = false;
      this._webServerUrl     = '';
      _updateRemoteUI(false, '');
    });

    // Drag-behaviour — load saved values, update hint, save on change
    const HINTS = {
      overwrite: t('settings.dropHintOverwrite'),
      next:      t('settings.dropHintNext'),
      append:    t('settings.dropHintAppend'),
    };
    const hintEl    = document.getElementById('dropBehaviorHint');
    const selectIds = ['dropBehaviorMusic', 'dropBehaviorBg', 'dropBehaviorSb'];
    const updateHint = (value) => {
      hintEl.textContent = HINTS[value] ?? '';
    };

    // Seed selects from storage, then update hint
    Storage.getDropBehavior().then(saved => {
      const musicEl = document.getElementById('dropBehaviorMusic');
      const bgEl    = document.getElementById('dropBehaviorBg');
      const sbEl    = document.getElementById('dropBehaviorSb');
      if (musicEl) musicEl.value = saved.music ?? 'overwrite';
      if (bgEl)    bgEl.value    = saved.bg    ?? 'overwrite';
      if (sbEl)    sbEl.value    = saved.sb    ?? 'overwrite';
      updateHint(musicEl?.value ?? 'overwrite');
    });

    const BEHAVIOR_KEYS = {
      dropBehaviorMusic: 'music',
      dropBehaviorBg:    'bg',
      dropBehaviorSb:    'sb',
    };
    for (const id of selectIds) {
      document.getElementById(id)?.addEventListener('change', async (e) => {
        updateHint(e.target.value);
        const saved = await Storage.getDropBehavior();
        saved[BEHAVIOR_KEYS[id]] = e.target.value;
        await Storage.setDropBehavior(saved);
      });
    }

    // Data location
    const dlSelect = document.getElementById('settingsDataLocation');
    const dlHint   = document.getElementById('settingsDataLocationHint');
    let   _dlCustomPath = '';

    window.api.dataLocation.get().then(({ mode, customPath, dataDir }) => {
      _dlCustomPath = customPath || '';
      if (mode === 'custom' && customPath) {
        const opt = dlSelect?.querySelector('option[value="custom"]');
        if (opt) opt.textContent = customPath;
      }
      if (dlSelect) dlSelect.value = mode;
      if (dlHint)   dlHint.textContent = dataDir || '';
    }).catch(() => {});

    dlSelect?.addEventListener('change', async (e) => {
      const mode = e.target.value;
      if (mode === 'custom') {
        const picked = await window.api.dataLocation.pick();
        if (!picked) {
          const { mode: curMode } = await window.api.dataLocation.get();
          dlSelect.value = curMode;
          return;
        }
        _dlCustomPath = picked;
        const opt = dlSelect.querySelector('option[value="custom"]');
        if (opt) opt.textContent = picked;
      }
      const confirmed = await showConfirm(t('settings.dataLocationConfirm'));
      if (!confirmed) {
        const { mode: curMode } = await window.api.dataLocation.get();
        dlSelect.value = curMode;
        return;
      }
      const result = await window.api.dataLocation.set(mode, _dlCustomPath);
      if (!result?.ok) {
        await showAlert(t('settings.dataLocationError'));
        const { mode: curMode } = await window.api.dataLocation.get();
        dlSelect.value = curMode;
      }
    });

    // Close on outside click
    const onOutside = (e) => {
      const p = document.getElementById('settingsPanel');
      const b = document.getElementById('settingsBtn');
      if (p && !p.contains(e.target) && !b?.contains(e.target)) {
        closeSettings();
        document.removeEventListener('mousedown', onOutside);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  }

  // ─── Profile list panel ──────────────────────────────────────────────────────

  _openSoundscapeList() {
    const existing = document.getElementById('ssListPanel');
    if (existing) { existing.remove(); return; }
    this._renderSoundscapeListPanel();
  }

  async _renderSoundscapeListPanel() {
    const soundscapes = await Storage.getSoundscapes();
    const current = this.mixer.currentSoundscape;

    const panel = document.createElement('div');
    panel.id        = 'ssListPanel';
    panel.className = 'ss-list-panel';

    // Position below the trigger button
    const btn = document.getElementById('soundscapeList');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      panel.style.top  = `${rect.bottom + 4}px`;
      panel.style.left = `${Math.max(4, rect.right - 220)}px`;
    }

    const scroll = document.createElement('div');
    scroll.className = 'ss-list-scroll';
    scroll.id        = 'ssListScroll';

    soundscapes.forEach((ss, idx) => {
      scroll.appendChild(this._makeSsRow(ss, idx, current));
    });

    const footer = document.createElement('div');
    footer.className = 'ss-list-footer';
    footer.innerHTML = `
      <button id="ssListAdd" title="${t('profiles.addTitle')}"><i class="fas fa-plus"></i></button>
      <button id="ssListDel" title="${t('profiles.deleteTitle')}" class="btn-danger"><i class="fas fa-trash"></i></button>
    `;

    panel.appendChild(scroll);
    panel.appendChild(footer);
    document.body.appendChild(panel);

    document.getElementById('ssListAdd')?.addEventListener('click', async () => {
      const list = await Storage.getSoundscapes();
      const newIdx = list.length;
      await this.mixer.insertSoundscape(newIdx);
      await this.mixer.renameSoundscape(newIdx, t('profiles.defaultName'));
      await this._refreshSoundscapeList();
    });

    document.getElementById('ssListDel')?.addEventListener('click', async () => {
      if (!await showConfirm(t('profiles.deleteConfirm'))) return;
      document.getElementById('ssListPanel')?.remove();
      this._ssOutsideOff?.();
      await this.mixer.removeSoundscape(this.mixer.currentSoundscape);
    });

    // Close on outside click
    const onOutside = (e) => {
      const p = document.getElementById('ssListPanel');
      const b = document.getElementById('soundscapeList');
      if (p && !p.contains(e.target) && !b?.contains(e.target)) {
        p.remove();
        document.removeEventListener('mousedown', onOutside);
        this._ssOutsideOff = null;
      }
    };
    this._ssOutsideOff = () => {
      document.removeEventListener('mousedown', onOutside);
      this._ssOutsideOff = null;
    };
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  }

  _makeSsRow(ss, idx, current) {
    const row = document.createElement('div');
    row.className   = 'ss-row' + (idx === current ? ' ss-row-active' : '');
    row.dataset.idx = String(idx);
    row.draggable   = true;
    row.textContent = ss.name || t('profiles.defaultNameN', { n: idx + 1 });

    // Track drag start to suppress click-on-drag-end
    let wasDragged = false;

    row.addEventListener('click', async () => {
      if (wasDragged) { wasDragged = false; return; }
      document.getElementById('ssListPanel')?.remove();
      this._ssOutsideOff?.();
      if (idx !== this.mixer.currentSoundscape) {
        await this.mixer.setSoundscape(idx);
      }
    });

    row.addEventListener('dragstart', e => {
      wasDragged = true;
      this._ssDragSrc = idx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
      row.classList.add('ss-row-dragging');
    });

    row.addEventListener('dragend', () => {
      this._ssDragSrc = null;
      document.querySelectorAll('.ss-row-above, .ss-row-below, .ss-row-dragging')
        .forEach(el => el.classList.remove('ss-row-above', 'ss-row-below', 'ss-row-dragging'));
      // Reset flag after a tick so click handler (which fires before dragend in some browsers) sees it
      setTimeout(() => { wasDragged = false; }, 0);
    });

    row.addEventListener('dragover', e => {
      if (this._ssDragSrc === null || this._ssDragSrc === idx) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const upper = e.clientY < rect.top + rect.height / 2;
      document.querySelectorAll('.ss-row-above, .ss-row-below')
        .forEach(el => el.classList.remove('ss-row-above', 'ss-row-below'));
      row.classList.add(upper ? 'ss-row-above' : 'ss-row-below');
    });

    row.addEventListener('dragleave', e => {
      if (!row.contains(e.relatedTarget)) {
        row.classList.remove('ss-row-above', 'ss-row-below');
      }
    });

    row.addEventListener('drop', async e => {
      e.preventDefault();
      const from = this._ssDragSrc;
      if (from === null || from === idx) return;
      const rect    = row.getBoundingClientRect();
      const upper   = e.clientY < rect.top + rect.height / 2;
      // insertBefore index (in original array)
      const insertBefore = upper ? idx : idx + 1;
      await this._moveSoundscape(from, insertBefore);
    });

    return row;
  }

  async _refreshSoundscapeList() {
    const scroll = document.getElementById('ssListScroll');
    if (!scroll) return;
    const soundscapes = await Storage.getSoundscapes();
    const current = this.mixer.currentSoundscape;
    scroll.innerHTML = '';
    soundscapes.forEach((ss, idx) => {
      scroll.appendChild(this._makeSsRow(ss, idx, current));
    });
  }

  async _moveSoundscape(from, insertBefore) {
    const soundscapes = await Storage.getSoundscapes();
    const [moved] = soundscapes.splice(from, 1);
    // Adjust target after removal
    let to = insertBefore > from ? insertBefore - 1 : insertBefore;
    if (to < 0) to = 0;
    if (to > soundscapes.length) to = soundscapes.length;
    soundscapes.splice(to, 0, moved);

    // Keep currentSoundscape pointing at the same entry
    let cur = this.mixer.currentSoundscape;
    if (cur === from) {
      cur = to;
    } else if (from < cur && insertBefore > cur) {
      cur--;
    } else if (from > cur && insertBefore <= cur) {
      cur++;
    }
    this.mixer.currentSoundscape = cur;

    await Storage.setSoundscapes(soundscapes);

    // Update header name
    this.mixer.name = soundscapes[cur].name;
    const nameEl = this._el('soundscapeName');
    if (nameEl) nameEl.value = this.mixer.name ?? '';

    await this._refreshSoundscapeList();
  }

  async _saveChannelVolume(i, val) {
    const soundscapes = await Storage.getSoundscapes();
    if (soundscapes[this.mixer.currentSoundscape]) {
      soundscapes[this.mixer.currentSoundscape].channels[i].settings.volume = val;
      await Storage.setSoundscapes(soundscapes);
    }
  }

  async _saveChannelSetting(i, key, val) {
    const soundscapes = await Storage.getSoundscapes();
    if (soundscapes[this.mixer.currentSoundscape]) {
      soundscapes[this.mixer.currentSoundscape].channels[i].settings[key] = val;
      await Storage.setSoundscapes(soundscapes);
    }
  }

  async _saveMasterVolume(val) {
    const soundscapes = await Storage.getSoundscapes();
    if (soundscapes[this.mixer.currentSoundscape]) {
      soundscapes[this.mixer.currentSoundscape].master.settings.volume = val;
      await Storage.setSoundscapes(soundscapes);
    }
  }

  async _saveMasterMute(mute) {
    const soundscapes = await Storage.getSoundscapes();
    if (soundscapes[this.mixer.currentSoundscape]) {
      soundscapes[this.mixer.currentSoundscape].master.settings.mute = mute;
      await Storage.setSoundscapes(soundscapes);
    }
  }

  async _saveAmbientVolume(i, val) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    if (!ss.ambient) ss.ambient = [];
    if (!ss.ambient[i]) ss.ambient[i] = { settings: { volume: 1, name: '' }, soundData: null };
    ss.ambient[i].settings.volume = val;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveAmbientSetting(i, key, val) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    if (!ss.ambient) ss.ambient = [];
    if (!ss.ambient[i]) ss.ambient[i] = { settings: { volume: 1, name: '' }, soundData: null };
    ss.ambient[i].settings[key] = val;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveAmbientMasterVolume(val) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    if (!ss.ambientMaster) ss.ambientMaster = { volume: 1 };
    ss.ambientMaster.volume = val;
    await Storage.setSoundscapes(soundscapes);
  }

  // ─── MIDI mapping mode ───────────────────────────────────────────────────────

  _toggleMappingMode() {
    if (this._mappingMode) this._exitMappingMode();
    else this._enterMappingMode();
  }

  _enterMappingMode() {
    this._mappingMode = true;
    const el = this._el('midiStatus');
    if (el) el.classList.add('midi-mapping-active');
    this._injectMappingControls();
  }

  _exitMappingMode() {
    this.midi?.cancelListening();
    this._mappingMode = false;
    const el = this._el('midiStatus');
    if (el) el.classList.remove('midi-mapping-active');
    document.querySelectorAll('.midi-map-wrap').forEach(el => el.remove());
  }

  _injectMappingControls() {
    const mappings = this.midi?.getMappings() ?? {};
    for (const entity of MIDI_ENTITIES) {
      const target = document.getElementById(entity.targetId);
      if (!target) continue;
      const mapped = !!mappings[entity.key];

      const wrap = document.createElement('span');
      wrap.className = 'midi-map-wrap';
      wrap.dataset.entity = entity.key;

      const chain = document.createElement('button');
      chain.className = 'midi-chain-btn' + (mapped ? ' midi-chain-mapped' : '');
      chain.title = mapped
        ? t('midi.mappingLabel', { mapping: _fmtMapping(mappings[entity.key]) })
        : t('midi.bindTitle');
      chain.textContent = '🔗';

      const trash = document.createElement('button');
      trash.className   = 'midi-trash-btn';
      trash.title       = t('midi.removeTitle');
      trash.textContent = '🗑';
      trash.disabled    = !mapped;

      wrap.appendChild(chain);
      wrap.appendChild(trash);

      if (entity.insertInside) {
        target.appendChild(wrap);
      } else {
        target.parentNode?.insertBefore(wrap, target.nextSibling);
      }

      chain.addEventListener('click', e => { e.stopPropagation(); this._onChainClick(entity.key, entity.type, chain); });
      trash.addEventListener('click', e => { e.stopPropagation(); this._onTrashClick(entity.key); });
    }
    this._injectSceneMappingControls();
  }

  _injectSceneMappingControls() {
    // Remove stale scene wraps before re-injecting (scene buttons may have been rebuilt)
    document.querySelectorAll('.midi-map-wrap[data-entity^="scene-"]').forEach(el => el.remove());

    const mappings = this.midi?.getMappings() ?? {};
    document.querySelectorAll('.scene-btn').forEach(btn => {
      const idx = btn.dataset.sceneIdx;
      if (idx == null) return;
      const key    = `scene-${idx}`;
      const mapped = !!mappings[key];

      const wrap = document.createElement('span');
      wrap.className = 'midi-map-wrap';
      wrap.dataset.entity = key;

      const chain = document.createElement('button');
      chain.className = 'midi-chain-btn' + (mapped ? ' midi-chain-mapped' : '');
      chain.title = mapped
        ? t('midi.mappingLabel', { mapping: _fmtMapping(mappings[key]) })
        : t('midi.bindTitle');
      chain.textContent = '🔗';

      const trash = document.createElement('button');
      trash.className   = 'midi-trash-btn';
      trash.title       = t('midi.removeTitle');
      trash.textContent = '🗑';
      trash.disabled    = !mapped;

      wrap.appendChild(chain);
      wrap.appendChild(trash);
      btn.appendChild(wrap);

      chain.addEventListener('click', e => { e.stopPropagation(); this._onChainClick(key, 'noteon', chain); });
      trash.addEventListener('click', e => { e.stopPropagation(); this._onTrashClick(key); });
    });
  }

  /** Called by app.js via mixer.onSceneRemoved */
  async onSceneRemoved(idx) {
    if (!this.midi) return;
    await this.midi.clearMapping(`scene-${idx}`);
    // Remap remaining scene keys: scene-N+1 → scene-N for indices above removed
    const mappings = this.midi.getMappings();
    const toRemap = Object.entries(mappings)
      .filter(([k]) => { const m = k.match(/^scene-(\d+)$/); return m && +m[1] > idx; });
    for (const [key, val] of toRemap) {
      const newIdx = +key.match(/^scene-(\d+)$/)[1] - 1;
      await this.midi.clearMapping(key);
      await this.midi.setMapping(`scene-${newIdx}`, val);
    }
  }

  _onChainClick(entityKey, type, chainBtn) {
    if (!this.midi) return;
    if (this.midi.getListeningFor() === entityKey) {
      // Toggle off: cancel listening
      this.midi.stopListening();
    } else {
      // Start listening (startListening auto-cancels any previous listener)
      this.midi.startListening(entityKey, type);
      chainBtn.className = 'midi-chain-btn midi-chain-listening';
    }
  }

  async _onTrashClick(entityKey) {
    if (!this.midi) return;
    if (this.midi.getListeningFor() === entityKey) this.midi.stopListening();
    await this.midi.clearMapping(entityKey);
    const wrap = document.querySelector(`.midi-map-wrap[data-entity="${entityKey}"]`);
    if (wrap) {
      const chain = wrap.querySelector('.midi-chain-btn');
      if (chain) { chain.className = 'midi-chain-btn'; chain.title = t('midi.bindTitle'); }
      const trash = wrap.querySelector('.midi-trash-btn');
      if (trash) trash.disabled = true;
    }
  }

  /** Called by midi.onMappingCaptured — mapping was just saved. */
  onMappingCaptured(entityKey, data) {
    const wrap = document.querySelector(`.midi-map-wrap[data-entity="${entityKey}"]`);
    if (wrap) {
      const chain = wrap.querySelector('.midi-chain-btn');
      if (chain) {
        chain.className = 'midi-chain-btn midi-chain-mapped';
        chain.title = t('midi.mappingLabel', { mapping: _fmtMapping(data) });
      }
      const trash = wrap.querySelector('.midi-trash-btn');
      if (trash) trash.disabled = false;
    }
  }

  /** Called by midi.onListeningStop — listening was cancelled or transferred. */
  onListeningStop(prevEntityKey) {
    if (!prevEntityKey) return;
    const mapped = !!this.midi?.getMappings()[prevEntityKey];
    const wrap = document.querySelector(`.midi-map-wrap[data-entity="${prevEntityKey}"]`);
    const chain = wrap?.querySelector('.midi-chain-btn');
    if (chain) chain.className = 'midi-chain-btn' + (mapped ? ' midi-chain-mapped' : '');
  }

  // ─── Data export / import ────────────────────────────────────────────────────

  async _exportMidiMappings() {
    const mappings = this.midi?.getMappings() ?? {};
    if (!Object.keys(mappings).length) {
      await showAlert(t('midi.noMappingsAlert'));
      return;
    }
    await window.api.midi.saveMappings(mappings);
  }

  async _importMidiMappings() {
    const data = await window.api.midi.loadMappings();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    await Storage.setMidiMappings(data);
    if (this.midi) this.midi.mappings = data;
    // Refresh mapping controls if mapping mode is active
    if (this._mappingMode) {
      this._exitMappingMode();
      this._enterMappingMode();
    }
  }

  async _exportData() {
    const soundscapes = await Storage.getSoundscapes();
    const current = soundscapes[this.mixer.currentSoundscape];
    if (!current) return;
    const defaultName = (current.name || t('profiles.defaultNameN', { n: this.mixer.currentSoundscape + 1 }))
      .replace(/[\\/:*?"<>|]/g, '_');
    await window.api.data.save(current, defaultName);
  }

  async _importData() {
    const data = await window.api.data.load();
    if (!data) return;
    const existing = await Storage.getSoundscapes();
    // Support both single-profile objects and legacy full-array exports
    const toAdd = Array.isArray(data) ? data : [data];
    await Storage.setSoundscapes(existing.concat(toAdd));
    await this.mixer.setSoundscape(this.mixer.currentSoundscape);
  }

  // ─── Missing files check & highlight ────────────────────────────────────────

  /**
   * Run the missing-files check for the current soundscape.
   * @param {{ silent?: boolean, forceDialog?: boolean }} opts
   *   silent      — don't open the dialog even if files are missing (just update highlights)
   *   forceDialog — open dialog even when 0 missing files (manual trigger)
   */
  async _runMissingFilesCheck({ silent = false, forceDialog = false } = {}) {
    if (this._skipMissingCheck) {
      this._skipMissingCheck = false;
      return;
    }

    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;

    const entries = await checkMissingFiles(ss);

    // Update registry
    MissingFilesRegistry.setAll(entries.map(e => e.path));

    // Rebuild channel map
    this._missingChannels.clear();
    for (const entry of entries) {
      const key = `${entry.channelType}-${entry.channelIdx}`;
      if (!this._missingChannels.has(key)) this._missingChannels.set(key, new Set());
      this._missingChannels.get(key).add(entry.path);
    }

    this._applyMissingHighlights();

    if (!silent && (entries.length > 0 || forceDialog)) {
      if (entries.length === 0) {
        await showAlert(t('missingFiles.noMissing'));
        return;
      }
      new MissingFilesDialog(entries, {
        onApply: async (remap) => {
          if (!Object.keys(remap).length) return;
          await this.mixer.applyFileRemap(remap);

          // Reload soundscape without re-triggering the check
          this._skipMissingCheck = true;
          await this.mixer.setSoundscape(this.mixer.currentSoundscape);

          // Remove fixed paths from tracking
          const fixedPaths = new Set(Object.keys(remap));
          MissingFilesRegistry.removeMany(fixedPaths);
          for (const paths of this._missingChannels.values()) {
            for (const p of fixedPaths) paths.delete(p);
          }
          for (const [key, paths] of this._missingChannels) {
            if (paths.size === 0) this._missingChannels.delete(key);
          }
          this._applyMissingHighlights();
        }
      }).open();
    }
  }

  /** Add/remove .has-missing-files class on channel elements. */
  _applyMissingHighlights() {
    for (let i = 0; i < 8; i++) {
      const el = this._el(`box-${i}`);
      if (el) el.classList.toggle('has-missing-files',
        (this._missingChannels.get(`music-${i}`)?.size ?? 0) > 0);
    }
    for (let i = 0; i < AMBIENT_SIZE; i++) {
      const el = this._el(`ambBox-${i}`);
      if (el) el.classList.toggle('has-missing-files',
        (this._missingChannels.get(`ambient-${i}`)?.size ?? 0) > 0);
    }
    for (let i = 0; i < 25; i++) {
      const el = this._el(`sbButton-${i}`);
      if (el) el.classList.toggle('has-missing-files',
        (this._missingChannels.get(`soundboard-${i}`)?.size ?? 0) > 0);
    }
  }

  /**
   * Called via 'playlist-changed' custom event after any PlaylistDialog._save().
   * Removes deleted missing paths from tracking and updates highlights.
   */
  _onPlaylistChanged(panelId, playlist) {
    let channelType, channelIdx;
    const m1 = panelId.match(/^ch-(\d+)$/);
    const m2 = panelId.match(/^amb-(\d+)$/);
    const m3 = panelId.match(/^sb-(\d+)$/);
    if      (m1) { channelType = 'music';      channelIdx = +m1[1]; }
    else if (m2) { channelType = 'ambient';    channelIdx = +m2[1]; }
    else if (m3) { channelType = 'soundboard'; channelIdx = +m3[1]; }
    else return;

    const key = `${channelType}-${channelIdx}`;
    const channelMissing = this._missingChannels.get(key);
    if (!channelMissing || channelMissing.size === 0) return;

    const newPaths = new Set(playlist.map(item => item.path));
    const removed  = [...channelMissing].filter(p => !newPaths.has(p));
    if (!removed.length) return;

    MissingFilesRegistry.removeMany(removed);
    for (const p of removed) channelMissing.delete(p);
    if (channelMissing.size === 0) this._missingChannels.delete(key);
    this._applyMissingHighlights();
  }

  async _exportProfiles() {
    const soundscapes = await Storage.getSoundscapes();
    if (!soundscapes.length) {
      await showAlert(t('settings.noProfilesAlert'));
      return;
    }
    await window.api.profiles.save(soundscapes);
  }

  async _importProfiles() {
    const data = await window.api.profiles.load();
    if (!data || !Array.isArray(data) || !data.length) return;

    const existing = await Storage.getSoundscapes();
    const existingNames = new Set(existing.map(ss => ss.name));
    const conflicts = data.filter(ss => existingNames.has(ss.name));

    let choice = 'keepboth';
    if (conflicts.length) {
      choice = await this._showProfileConflictDialog(conflicts.map(ss => ss.name));
      if (choice === null) return;
    }

    let merged;
    if (choice === 'overwrite') {
      // Replace existing profiles that have a matching name, then append non-conflicting imports
      merged = existing.map(ex => data.find(im => im.name === ex.name) ?? ex);
      const nonConflicting = data.filter(ss => !existingNames.has(ss.name));
      merged = merged.concat(nonConflicting);
    } else if (choice === 'skip') {
      // Append only imported profiles whose names don't already exist
      const nonConflicting = data.filter(ss => !existingNames.has(ss.name));
      merged = existing.concat(nonConflicting);
    } else {
      // 'keepboth' — append all imported profiles as-is
      merged = existing.concat(data);
    }

    await Storage.setSoundscapes(merged);
    await this.mixer.setSoundscape(this.mixer.currentSoundscape);
  }

  _showProfileConflictDialog(conflictNames) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'settings-overlay';
      overlay.style.zIndex = '9000';

      const panel = document.createElement('div');
      panel.className = 'fx-panel settings-panel';
      panel.style.zIndex = '9001';

      const namesList = conflictNames
        .map(n => `<li>${n.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</li>`)
        .join('');

      panel.innerHTML = `
        <div class="fx-header settings-panel-header">
          <span>${t('settings.profileConflictTitle')}</span>
          <button class="fx-close" id="profileConflictClose">✕</button>
        </div>
        <div class="settings-panel-body">
          <div class="settings-section">
            <p class="settings-drop-hint settings-drop-hint-static">${t('settings.profileConflictDesc')}</p>
            <ul class="conflict-names-list">${namesList}</ul>
            <div class="settings-row">
              <button class="settings-btn" id="profileConflictOverwrite">${t('settings.profileConflictOverwrite')}</button>
              <button class="settings-btn" id="profileConflictKeepBoth">${t('settings.profileConflictKeepBoth')}</button>
              <button class="settings-btn" id="profileConflictSkip">${t('settings.profileConflictSkip')}</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      document.body.appendChild(panel);

      panel.style.left = `${Math.round((window.innerWidth  - panel.offsetWidth)  / 2)}px`;
      panel.style.top  = `${Math.round((window.innerHeight - panel.offsetHeight) / 2)}px`;

      const close = (result) => {
        overlay.remove();
        panel.remove();
        resolve(result);
      };

      document.getElementById('profileConflictClose')?.addEventListener('click',   () => close(null));
      document.getElementById('profileConflictOverwrite')?.addEventListener('click', () => close('overwrite'));
      document.getElementById('profileConflictKeepBoth')?.addEventListener('click', () => close('keepboth'));
      document.getElementById('profileConflictSkip')?.addEventListener('click',     () => close('skip'));
      overlay.addEventListener('click', () => close(null));
    });
  }
}
