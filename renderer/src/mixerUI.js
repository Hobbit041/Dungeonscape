/**
 * mixerUI.js
 * Replaces mixerApp.js — pure DOM manipulation, no Foundry/jQuery.
 * Handles all UI rendering and event binding.
 */
import { Storage }                from './storage.js';
import { filesToPlaylistItems } from './playlistDialog.js';
import { AMBIENT_SIZE }           from './ambientMixer.js';
import { SOUNDBOARD_SIZE, makeEmptySoundboardButton, MIXER_SIZE } from './templates.js';
import { migrateSoundscape, migrateMidiMappings } from './sbGrid.js';
import { resolveScene } from './sceneUtils.js';
import { migrateTrackCount } from './trackCount.js';
import { t }                      from './i18n.js';
import { MissingFilesRegistry }  from './missingFilesRegistry.js';
import { checkMissingFiles } from './missingFilesDialog.js';
import { onChildWindowMessage } from './childWindowHost.js';
import { bindPlaylistChannelBridge } from './playlistChannelBridge.js';
import { bindChannelConfigBridge }   from './channelConfigBridge.js';
import { bindSettingsBridge } from './settingsBridge.js';
import { getUpdateInfo }          from './updateChecker.js';
import { showConfirm, showAlert } from './dialog.js';
import { FADE_MS, FADE_STOP_MS }  from './audioFade.js';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif']);
const AUDIO_EXT = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'webm']);

/** Convert a local file path to a file:// URL for use in <img src>. */
function _fileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|blob:)/i.test(p)) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

/**
 * Set an <img>'s source only when the underlying path actually changed.
 * render() runs on every scene switch, mute/link toggle, sound assignment,
 * etc. — up to ~20 times for one user action — and reassigning .src
 * unconditionally forces Chromium to re-resolve/redecode the image each
 * time even when nothing changed. img.src itself can't be compared directly
 * (the browser normalizes/encodes it), so track the raw path separately.
 */
function _setImgSrc(imgEl, rawPath) {
  if (!imgEl || imgEl.dataset.srcPath === (rawPath ?? '')) return;
  imgEl.dataset.srcPath = rawPath ?? '';
  imgEl.src = _fileUrl(rawPath);
}

// ── MIDI entity table ────────────────────────────────────────────────────────
const MIDI_ENTITIES = [
  ...Array.from({ length: MIXER_SIZE }, (_, i) => [
    { key: `ch-${i}-mute`,   targetId: `mute-${i}`,         type: 'noteon',    insertInside: true },
    { key: `ch-${i}-solo`,   targetId: `solo-${i}`,         type: 'noteon',    insertInside: true },
    { key: `ch-${i}-link`,   targetId: `link-${i}`,         type: 'noteon',    insertInside: true },
    { key: `ch-${i}-volume`, targetId: `volumeSlider-${i}`, type: 'volume_any' },
    { key: `ch-${i}-play`,   targetId: `playSound-${i}`,    type: 'noteon'    },
    { key: `ch-${i}-prev`,   targetId: `prevTrack-${i}`,    type: 'noteon',    insertInside: true },
    { key: `ch-${i}-next`,   targetId: `nextTrack-${i}`,    type: 'noteon',    insertInside: true },
  ]).flat(),
  { key: 'master-volume', targetId: 'volumeSlider-master', type: 'volume_any' },
  { key: 'master-play',   targetId: 'playMix',             type: 'noteon'    },
  { key: 'sb-stopall',    targetId: 'sbStopAll',           type: 'noteon'    },
  ...Array.from({ length: SOUNDBOARD_SIZE }, (_, i) => ({
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

/** Build all 49 soundboard cells. Must run before any event binding. */
function _buildSbCells() {
  const grid = document.getElementById('soundboard-grid');
  if (!grid) { console.warn('_buildSbCells: #soundboard-grid not found'); return; }
  if (grid.children.length) return;
  let html = '';
  for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
    html += `<div class="sb-cell" id="sbButton-${i}">` +
            `<div class="sb-img-wrap"><img id="sbImg-${i}" src="" alt=""></div>` +
            `<div class="sb-label" id="sbLabel-${i}"></div></div>`;
  }
  grid.innerHTML = html;
}

export class MixerUI {
  constructor(mixer) {
    _buildSbCells();
    this.mixer             = mixer;
    this.midi              = null;   // set by app.js after midi init
    this._dragSource       = null;
    this._controlDown      = false;
    this._mappingMode      = false;
    this._missingChannels  = new Map(); // 'music-0' → Set<path>
    this._skipMissingCheck = false;
    // {kind:'scene'|'sbScene', idx} while a scene-tab rename editor is open,
    // else null — see _renderScenes()/_renderSbScenes()'s own use of this.
    this._editingScene     = null;
    this._webServerRunning = false;
    this._webServerUrl     = '';

    Storage.getHideMsl().then(val => document.body.classList.toggle('hide-msl', val));

    // Reattach a soundboard scene whose window the user closed (native ✕).
    // A no-op if the scene was already reattached programmatically (e.g. a
    // profile switch closed it first — see Mixer._closeAllDetachedSoundboardScenes).
    window.api.childWindow.onClosed((key) => {
      const sbm = /^soundboardScene:(.+)$/.exec(key);
      if (sbm) { this.mixer.reattachSoundboardScene(sbm[1]); return; }
      const mm = /^musicScene:(.+)$/.exec(key);
      if (mm) this.mixer.reattachMusicScene(mm[1]);
    });

    // Exposed so app.js can await it before sbLayout.init() runs — sbLayout
    // measures "window width minus soundboard grid" as its fixed-chrome
    // baseline, which must reflect the final trackCount/orientation-adjusted
    // size, not whatever the window happened to be mid-resize. Orientation
    // is applied first (resize:false — no IPC round trip needed at boot,
    // the initial HTML/CSS already reflects it once the class lands) so
    // _applyTrackCount measures the correct (already-oriented) axis.
    //
    // _applyTrackCount itself is also resize:false here — main.js's minimum-
    // size baseline (1000/VERTICAL_MIN_HEIGHT) assumes settling to the saved
    // trackCount at boot is silent, exactly like orientation above. The raw
    // HTML always starts with all MIXER_SIZE strips visible (untoggled), so
    // a resize:true boot call would measure a spurious "hide down to n"
    // delta against that full-width DOM and bake it into main.js's window-
    // size floor as if it were a real, user-driven track-count change.
    this.trackCountReady = Storage.getOrientation()
      .then(o => this._applyOrientation(o === 'horizontal', { resize: false }))
      .then(() => Storage.getTrackCount())
      .then(n => this._applyTrackCount(n, { resize: false }));

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
    this.midi?.sendLed('master-play', this.mixer.playing);

    // Master
    const masterVol = this.mixer.globalVolumes?.master ?? ss.master?.settings?.volume ?? 1;
    this._el('volumeSlider-master').value  = masterVol * 100;
    this._setMuteColor('mute-master', ss.master?.settings?.mute ?? false);

    // Channels
    for (let i = 0; i < MIXER_SIZE; i++) {
      const ch   = this.mixer.channels[i];
      const data = ss.channels?.[i];
      if (!data) continue;

      const nameVal = data.settings?.name ?? '';
      this._el(`channelName-${i}`).value       = nameVal;
      this._el(`channelName-${i}`).title       = nameVal;
      this._el(`channelName-${i}`).placeholder = t('mixer.channelNamePlaceholder', { n: i + 1 });
      const chVol = this.mixer.globalVolumes?.channels?.[i] ?? data.settings?.volume ?? 1;
      this._el(`volumeSlider-${i}`).value      = chVol * 100;
      this._setMuteColor(`mute-${i}`, data.settings?.mute ?? false);
      this._setSoloColor(`solo-${i}`, data.settings?.solo ?? false);
      this._setLinkColor(`link-${i}`, data.settings?.link ?? false);
      const chImgSrc = data.settings?.imageSrc ?? '';
      const chImgEl  = this._el(`chImg-${i}`);
      _setImgSrc(chImgEl, chImgSrc);
      this._el(`box-${i}`)?.classList.toggle('has-image', !!chImgSrc);
      this._el(`playSound-${i}`).innerHTML = ch.playing
        ? '<i class="fas fa-stop"></i>'
        : '<i class="fas fa-play"></i>';
      this._el(`box-${i}`)?.classList.toggle('is-playing', ch.playing);
      this.midi?.sendLed(`ch-${i}-play`, ch.playing);
    }

    // Global track highlights
    const globalMusicChannels     = ss.globalMusicChannels     ?? [];
    const globalAmbientChannels   = ss.globalAmbientChannels   ?? [];
    const globalSoundboardButtons = ss.globalSoundboardButtons ?? [];
    for (let i = 0; i < MIXER_SIZE; i++) {
      this._el(`box-${i}`)?.classList.toggle('channel-global', globalMusicChannels.includes(i));
    }
    for (let i = 0; i < AMBIENT_SIZE; i++) {
      this._el(`ambBox-${i}`)?.classList.toggle('channel-global', globalAmbientChannels.includes(i));
    }
    for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
      this._el(`sbButton-${i}`)?.classList.toggle('channel-global', globalSoundboardButtons.includes(i));
    }

    // Scenes
    this._renderScenes(ss);

    // Ambient mixer
    const ambData      = ss.ambient ?? [];
    const ambMasterVol = this.mixer.globalVolumes?.ambientMaster ?? ss.ambientMaster?.volume ?? 1;
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
      if (slEl)   slEl.value     = (this.mixer.globalVolumes?.ambient?.[i] ?? amb.settings?.volume ?? 1) * 100;
      const ambImgSrc = amb.settings?.imageSrc ?? '';
      const ambImgEl  = this._el(`ambImg-${i}`);
      _setImgSrc(ambImgEl, ambImgSrc);
      this._el(`ambBox-${i}`)?.classList.toggle('has-image', !!ambImgSrc);
      const ambPlaying = this.mixer.ambientMixer?.channels[i]?.playing ?? false;
      if (playEl) playEl.innerHTML = ambPlaying
        ? '<i class="fas fa-stop"></i>'
        : '<i class="fas fa-play"></i>';
      this._el(`ambBox-${i}`)?.classList.toggle('is-playing', ambPlaying);
      this.midi?.sendLed(`amb-${i}-play`, ambPlaying);
    }

    // Soundboard scenes
    this._renderSbScenes(ss);

    // Soundboard
    const sbData = ss.soundboard ?? [];
    const sbGain = this.mixer.globalVolumes?.soundboard ?? ss.soundboardGain ?? 0.75;
    this._el('sbVolume').value = sbGain / 1.5 * 100;

    for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
      const btn = this._el(`sbButton-${i}`);
      if (!btn) continue;
      const d = sbData[i] ?? {};
      this._updateSbBorder(i);

      const label = this._el(`sbLabel-${i}`);
      if (label) label.textContent = d.name ?? '';

      // Image
      const img = this._el(`sbImg-${i}`);
      _setImgSrc(img, d.imageSrc);
    }
  }

  /** Any channel or ambient track playing in ANY currently-detached music scene — the master play/stop icon reacts to this too, not just the active scene. */
  _anyMusicScenePlaying() {
    for (const player of this.mixer.detachedMusicScenes.values()) {
      if (player.channels.some(ch => ch.playing)) return true;
      if (player.ambientMixer.channels.some(ch => ch.playing)) return true;
    }
    return false;
  }

  updatePlayState() {
    const playing = this.mixer.playing || this._anyMusicScenePlaying();
    this._el('playMix').innerHTML = playing
      ? '<i class="fas fa-stop"></i>'
      : '<i class="fas fa-play"></i>';
    this.midi?.sendLed('master-play', playing);
    for (let i = 0; i < MIXER_SIZE; i++) {
      const chPlaying = this.mixer.channels[i].playing;
      const btn = this._el(`playSound-${i}`);
      if (btn) btn.innerHTML = chPlaying
        ? '<i class="fas fa-stop"></i>'
        : '<i class="fas fa-play"></i>';
      this._el(`box-${i}`)?.classList.toggle('is-playing', chPlaying);
      this.midi?.sendLed(`ch-${i}-play`, chPlaying);
    }
  }

  updateChannelVolume(channelNr, volume) {
    const sl = this._el(`volumeSlider-${channelNr}`);
    if (sl) sl.value = volume * 100;
  }

  updateMasterVolume(volume) {
    const sl = this._el('volumeSlider-master');
    if (sl) sl.value = volume * 100;
  }

  updateSoundboardVolume(volume) {
    const el = this._el('sbVolume');
    if (el) el.value = volume / 1.5 * 100;
  }

  /** Update all channel + master volume sliders from live channel state (used by MIDI). */
  updateAllChannelVolumes() {
    for (let i = 0; i < MIXER_SIZE; i++) {
      const vol = this.mixer.channels[i].settings.volume ?? 1;
      const sl = this._el(`volumeSlider-${i}`);
      if (sl) sl.value = vol * 100;
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
    this.midi?.sendLed(`amb-${i}-play`, ch.playing);
  }

  updateMute(channelNr, mute) {
    this._setMuteColor(`mute-${channelNr}`, mute);
  }

  updateSolo(channelNr, solo) {
    this._setSoloColor(`solo-${channelNr}`, solo);
  }

  updateLink(channelNr, link) {
    this._setLinkColor(`link-${channelNr}`, link);
  }

  flashSoundboardButton(index) {
    const btn = this._el(`sbButton-${index}`);
    if (!btn) return;
    btn.classList.add('sb-flash');
    setTimeout(() => btn.classList.remove('sb-flash'), 200);
    this.mixer.onSoundboardFlash?.(index);
  }

  _updateSbBorder(index) {
    const btn = this._el(`sbButton-${index}`);
    if (!btn) return;
    const sb = this.mixer.soundboard;
    const ch = sb?.channels[index];
    // Only highlight while the button belongs to the soundboard scene that's
    // actually on screen — a scene switch can leave a sound playing in the
    // background (see Soundboard.configure keepPlaying) without it being for
    // the scene now displayed.
    const isPlaying = !!ch?.playing && ch._playingSbScene === (sb?.currentSbScene ?? 0);
    btn.style.borderColor = isPlaying ? 'yellow' : '';
    btn.style.boxShadow   = isPlaying ? '0 0 8px yellow' : '';
    this.midi?.sendLed(`sb-${index}`, isPlaying);
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
      if (this.mixer.playing || this._anyMusicScenePlaying()) {
        const playing = this.mixer.channels.filter(ch => ch.playing);
        // Remove is-playing immediately so visual fade runs in parallel with audio fade
        for (const ch of playing) this._el(`box-${ch.channelNr}`)?.classList.remove('is-playing');
        if (playing.length) await Promise.all(playing.map(ch => ch.fadeOutAndStop(FADE_STOP_MS)));
        this.mixer.playing = false;
        // Stop reaches every detached scene too — deliberately asymmetric
        // with the start path below, which only ever starts the active
        // scene (a detached scene is independently controlled; there's no
        // "start everything, everywhere" the way there's a "stop
        // everything, everywhere" — same asymmetry as stopAllSoundboards()).
        await this.mixer.stopAllMusicScenes();
      } else {
        this.mixer.start(undefined, FADE_STOP_MS);
      }
      this.updatePlayState();
    });

    // ── Master volume ──
    this._on('volumeSlider-master', 'input', async (e) => {
      const val = e.target.value / 100;
      this.mixer.master.setVolume(val);
      await this.mixer.setGlobalMasterVolume(val);
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
      this.mixer.stopAllSoundboards();
      for (let j = 0; j < SOUNDBOARD_SIZE; j++) this._updateSbBorder(j);
    });

    // ── Import / Export ──
    this._on('btnExport', 'click', () => this._exportData());
    this._on('btnImport', 'click', () => this._importData());

    // ── Per-channel events (delegated) ──
    for (let i = 0; i < MIXER_SIZE; i++) {
      this._bindChannelEvents(i);
    }

    // ── Soundboard buttons ──
    for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
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
      await this.mixer.setGlobalAmbientMasterVolume(val);
    });

    // ── Settings ──
    this._on('settingsBtn', 'click', () => this._openSettingsPanel());

    // ── Add scene ──
    this._on('addScene', 'click', () => this.mixer.addScene());

    // ── Add soundboard scene ──
    this._on('addSbScene', 'click', () => this.mixer.addSoundboardScene());
  }

  /**
   * True rendered content height of a strip row's VISIBLE (non track-hidden)
   * children, top of the first to bottom of the last, plus the row's own
   * padding. Unlike scrollHeight, this doesn't get masked by a row that's
   * being stretched taller than its content by a flex-row ancestor (see
   * callers' own comments for why that masking happens in horizontal mode).
   * A child's own rendered box size never depends on whether its container
   * clips/stretches around it, so summing via getBoundingClientRect is safe
   * regardless.
   */
  _rowVisibleSpan(row) {
    const visible = [...row.children].filter(el => !el.classList.contains('track-hidden'));
    if (!visible.length) return 0;
    const top = visible[0].getBoundingClientRect().top;
    const bottom = visible[visible.length - 1].getBoundingClientRect().bottom;
    const cs = getComputedStyle(row);
    return (bottom - top) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  }

  /**
   * Show/hide channel strips 0..MIXER_SIZE-1 for the given visible count,
   * and (unless resize:false) resize the window to match. Called both at
   * startup (constructor) and from the settings select's change handler.
   *
   * Vertical mode pushes a WIDTH delta (row.scrollWidth before/after —
   * accurate there, see _resizeOnce's own comment on why horizontal's
   * WIDTH measurement is equally safe) through track-count-resize, which
   * grows/shrinks the window by that same delta, preserving the
   * soundboard's own share of the window untouched (see that handler's own
   * comment in main.js).
   *
   * Horizontal mode instead re-runs _resizeOnce(true) — the SAME
   * recompute-from-scratch resize _applyOrientation uses when switching
   * orientation — rather than accumulating a HEIGHT delta the same way.
   * Track count there changes the row's own content height, not a
   * mixer-column width the soundboard needs to stay clear of, so there's no
   * "preserve the soundboard's share" reason to prefer a delta. A delta
   * would also need to keep main.js's _trackCountHeightDelta bookkeeping
   * (window height relative to a fixed baseline) in perfect sync with
   * reality across every accumulated change — one slightly-off measurement
   * anywhere in that chain silently drifts every resize after it. Recompute
   * fixes that by construction: each call derives the target fresh from the
   * CURRENT DOM and CURRENT window bounds, so it can't accumulate drift.
   */
  async _applyTrackCount(n, { resize = true } = {}) {
    const row = document.getElementById('channel-strip-row');
    const horizontal = document.body.classList.contains('orientation-horizontal');
    const before = (resize && row && !horizontal) ? row.scrollWidth : 0;

    for (let i = 0; i < MIXER_SIZE; i++) {
      const hidden = i >= n;
      this._el(`box-${i}`)?.classList.toggle('track-hidden', hidden);
      this._el(`ambBox-${i}`)?.classList.toggle('track-hidden', hidden);
    }

    // Keep every currently-detached music scene window's own track
    // visibility (and width, see musicScene-entry.js's 'trackCountChanged'
    // handler) in sync with this setting too — independent of `resize`
    // above, which only governs the MAIN window's own resize pass.
    for (const sceneId of this.mixer.detachedMusicScenes.keys()) {
      window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'trackCountChanged', trackCount: n });
    }

    if (!resize || !row) return;

    if (horizontal) {
      await this._resizeOnce(true);
      return;
    }

    const delta = row.scrollWidth - before;
    if (delta !== 0) {
      // Re-measure fixedW/fixedH BEFORE resizing, not after: the
      // track-hidden classes above already changed the mixer column's
      // width in the live DOM (fixedW = window width minus the
      // soundboard's own share is timing-independent — the mixer's
      // natural width doesn't depend on the window's current size), but
      // main.js's cached copy otherwise stays pinned to whatever track
      // count was visible at the last resize-target push. The very next
      // line's resizeWindow() calls _sbApplyMinSize() synchronously
      // inside its own IPC handler, so refreshing after would be one
      // transition too late — this resize's own safety-floor term would
      // still read the stale value (see refreshFixedDims's own doc).
      await this.sbLayout?.refreshFixedDims();
      try { await window.api.trackCount?.resizeWindow(delta); } catch { /* main not ready */ }
    }
  }

  /**
   * Toggle horizontal orientation, and (unless resize:false) push the NEW
   * state's absolute mixer content size to main. Deliberately NOT a
   * before/after delta off the window's current bounds: main.js's minimum
   * size can already be inflated above the mixer's true need by the
   * soundboard's own square-cell floor, and a delta computed against that
   * inflated baseline would bake the inflation in as if it were the mixer's
   * own requirement — then compound further on every subsequent toggle.
   * Sending a pure, fresh content measurement each time (matching
   * _applyTrackCount's own `delta`, which has always been a pure content
   * measurement, never bounds-derived) keeps this reproducible from the
   * current DOM state alone, with no memory of prior resizes to drift from.
   * Called both at startup (constructor) and from the settings checkbox's
   * change handler.
   *
   * The orientation-resize IPC call always fires, even with resize:false
   * (no measurement) — it's the only place main.js's own _orientationHorizontal
   * flag gets set, and that flag is what routes the very next
   * _applyTrackCount() call to the correct axis. Skipping the call entirely
   * when there's nothing to resize left main.js permanently out of sync for
   * anyone who boots directly into a saved horizontal orientation.
   */
  async _applyOrientation(horizontal, { resize = true } = {}) {
    document.body.classList.toggle('orientation-horizontal', horizontal);

    if (!resize) {
      // Boot-time flag-sync only (no measurement) — still needs main.js's
      // own _orientationHorizontal flag set (see this method's own doc for
      // why), but there's nothing to measure or resize yet.
      try {
        await window.api.orientation?.resizeWindow({ horizontal });
      } catch { /* main not ready */ }
      return;
    }

    // Two passes. #soundboard-header wraps to a second line when the
    // soundboard's available WIDTH is too narrow (its title+controls don't
    // fit on one line) — which taller/shorter that makes it, in turn
    // changes fixedH (soundboard's own vertical chrome). The FIRST pass's
    // _resizeOnce() necessarily measures fixedH at the OLD orientation's
    // width (still narrower/wider than the new target, since we haven't
    // resized yet) — if that's on the wrong side of the wrap threshold, the
    // resulting target height bakes in a wrap state the window won't
    // actually be in once resized, leaving a stale-chrome-sized gap around
    // the soundboard grid. The SECOND pass re-measures at the now-actual
    // (settled) width from the first pass's own resize, which is the width
    // the window will truly have — always correct, since nothing narrows
    // it further afterward. One correction pass is enough: the first pass
    // already put width in the right ballpark, so the header's wrap state
    // can't flip again between passes.
    await this._resizeOnce(horizontal);
    await this._resizeOnce(horizontal);
  }

  /**
   * One measure-refresh-resize round: recomputes the window's target size
   * from scratch off the CURRENT DOM state and pushes it via the
   * orientation-resize IPC (same one _applyOrientation uses when actually
   * switching orientation). Shared by three callers that all want the same
   * "make the window exactly fit right now, no scroll, no soundboard
   * letterbox" outcome — _applyOrientation itself (called twice in a row;
   * see its own comment for why), _applyTrackCount's horizontal branch, and
   * _restoreFaderWindowSize's horizontal branch (see each one's own
   * comment for why they prefer this over an accumulated delta).
   */
  async _resizeOnce(horizontal) {
    const section = document.getElementById('mixer-section');
    const chRow   = document.getElementById('channel-strip-row');
    const ambRow  = document.getElementById('ambient-strip-row');
    if (!section || !chRow || !ambRow) return;

    // #mixer-section's own scrollWidth is safe to read directly for
    // horizontal (where it becomes _horizontalContentWidth) — #mixer-section
    // there is a ROW of chRow/ambRow/scenes-section side by side, so its
    // scrollWidth is their SUM, matching what horizontal's own single fixed
    // mixer column actually needs. Vertical mode stacks those same three
    // sections in a COLUMN instead, so #mixer-section's width there is
    // whichever child is WIDEST — normally chRow, but not guaranteed (e.g.
    // scenes-section can wrap wider under some track counts) — an unstable
    // stand-in for "the mixer's width" that produced 17-90px-off targets in
    // practice. See the widthTarget comment below for what vertical uses
    // instead.
    const contentWidth = section.scrollWidth;

    // Height (horizontal only): chRow/ambRow sit SIDE BY SIDE in horizontal
    // mode, each stretched (align-items:stretch, their cross axis in
    // #mixer-section's row layout) to the FULL current mixer height
    // regardless of content — not split between them the way vertical mode
    // splits its own shared height. So instead of an absolute content
    // measurement (which main.js would have no correct way to turn into a
    // window height — see its own handler comment), send how much MORE (or
    // less) than each row's CURRENTLY ALLOCATED space (clientHeight) its
    // true content (_rowVisibleSpan, immune to that same stretch) needs.
    // Since row height == mixer-section height == window height minus
    // #header (1:1, no splitting), this delta maps directly onto a
    // window-height delta — take whichever row needs more.
    const heightDelta = horizontal
      ? Math.max(
          this._rowVisibleSpan(chRow) - chRow.clientHeight,
          this._rowVisibleSpan(ambRow) - ambRow.clientHeight,
        )
      : undefined;

    // Width target (vertical only): NOT derived from any single content-box
    // measurement — main.js's 1000-at-8-tracks baseline is a WINDOW-width
    // quantity (mixer share + a soundboard-width margin baked in), while
    // every available DOM measurement of "the mixer's width" (contentWidth
    // above, or window width minus the soundboard's current width) excludes
    // that margin. Subtracting or cross-referencing between those two
    // different reference frames (an earlier version tried both ways)
    // reliably lands off by anywhere from ~20px to ~100px, opening a
    // letterbox gap above/below the soundboard grid on every switch back to
    // vertical. Sidestepping that entirely: count the VISIBLE strips
    // directly and multiply by their own measured per-strip footprint
    // (width + row gap, from two adjacent strips' actual left-edge
    // spacing — immune to whichever section #mixer-section's own scrollWidth
    // happens to be widest-bound by) to get the exact 60px-per-track
    // relationship the window-sizing scheme is built on (1000 at 8 tracks,
    // 940 at 7, 880 at 6, …) directly, with no window-relative conversion
    // needed at all.
    let widthTarget;
    if (!horizontal) {
      const strips = [...chRow.querySelectorAll('.channel-strip:not(.master-strip):not(.track-hidden)')];
      const perStripWidth = strips.length >= 2
        ? strips[1].getBoundingClientRect().left - strips[0].getBoundingClientRect().left
        : 60; // TRACK_COUNT_MIN keeps at least 2 visible in practice
      widthTarget = Math.round((strips.length - 8) * perStripWidth);
    }

    // Refresh main.js's cached fixedW/fixedH BEFORE resizing, not after —
    // main.js's _sbApplyMinSize() (called synchronously inside the very
    // next resizeWindow() call, below) reads whatever fixedW/fixedH is
    // CURRENTLY cached; refreshing only after would fix it for NEXT time
    // while leaving THIS resize's own bounds sized off the stale value
    // (mirrors _applyTrackCount's identical ordering fix above).
    //
    // refreshFixedDims (not refreshChrome/_pushLayout(true)) specifically:
    // a WITH-target push would ALSO fight the resizeWindow() call below by
    // re-resizing off the PERSISTED base cell size — computes width/height
    // from a shared cell value but floors each axis independently against
    // the current minimum, so whichever axis's cell-derived size falls
    // below its own floor gets clamped while the other (with room to
    // spare) doesn't, breaking the square relationship _sbApplyMinSize()
    // establishes and reopening a letterbox gap around the soundboard grid.
    await this.sbLayout?.refreshFixedDims();

    try {
      await window.api.orientation?.resizeWindow({ horizontal, contentWidth, heightDelta, widthTarget });
    } catch { /* main not ready */ }
  }

  /**
   * Settings-panel action: grow/shrink the window's HEIGHT ONLY (width is
   * left untouched — track count already owns width exclusively in vertical
   * mode) so music channel faders land exactly at their 140px cap.
   *
   * #channel-strip-row and #ambient-strip-row are both `flex:1` competing
   * for the same leftover vertical space in #mixer-section, with #header
   * and #scenes-section fixed — so any window-height change splits 50/50
   * between the two rows, and each row's fader-wrap (the only flex:1 child
   * within its strip's column) absorbs 100% of its own row's share. That
   * makes the relationship exactly linear: growing the window by 2px grows
   * a channel strip's fader-wrap by 1px. Measuring box-0's current wrap
   * height and solving that ratio for a 140px target avoids any need to
   * iterate/re-measure — one resize lands exactly on target. Ambient rows
   * need less chrome than music ones, so by the time music's wrap reaches
   * 140 ambient's already has (it hits the cap first with room to spare).
   *
   * Horizontal mode has no growable fader (each strip is a fixed 275x56
   * bar) — "restore" there instead means the same thing _applyOrientation's
   * own switch-to-horizontal resize means: snap the window to exactly fit
   * the current tracks, no scroll, no soundboard letterbox. Reuses
   * _resizeOnce(true) rather than its own math for the same reason
   * _applyTrackCount's horizontal branch does (see that method's own
   * comment) — a recompute-from-scratch can't drift the way accumulated
   * deltas can, and this button exists specifically to fix drift/mismatch
   * the user is already seeing, so it should use the more robust of the
   * two approaches available.
   */
  async _restoreFaderWindowSize() {
    if (document.body.classList.contains('orientation-horizontal')) {
      await this._resizeOnce(true);
      return;
    }
    const wrap = document.querySelector('#box-0 .ch-fader-wrap');
    if (!wrap) return;
    const currentWrapHeight = wrap.getBoundingClientRect().height;
    const deltaHeight = Math.round(2 * (140 - currentWrapHeight));
    if (!deltaHeight) return;
    try {
      await window.api.faderSize?.restoreWindow(deltaHeight);
    } catch { /* main not ready */ }
  }

  _bindChannelEvents(i) {
    // Volume slider
    this._on(`volumeSlider-${i}`, 'input', async (e) => {
      const val = e.target.value / 100;
      if (this.mixer.channels[i].getLink()) {
        await this.mixer.setLinkVolumes(val, i);
        this._updateLinkedSliders(i);
      } else {
        this.mixer.channels[i].setVolume(val);
        await this.mixer.setGlobalChannelVolume(i, val);
      }
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
    this._on(`config-${i}`, 'click', () => this._openChannelConfig(i));

    // FX panel (EQ + Delay)
    this._on(`fx-${i}`, 'click', () => {
      this._openFxDialog(`fx:${i}`, this.mixer.channels[i], i, t('fxDialog.title', { n: i + 1 }));
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

        const firstPath = files[0].path;
        const firstExt  = (firstPath ?? files[0].name).split('.').pop().toLowerCase();
        if (IMAGE_EXT.has(firstExt)) {
          await this.mixer.newData(i, { type: 'image', source: firstPath });
          _setImgSrc(this._el(`chImg-${i}`), firstPath);
          box.classList.add('has-image');
          return;
        }

        if (e.ctrlKey) {
          const folders = files.filter(f => !AUDIO_EXT.has(f.name.split('.').pop().toLowerCase()));
          if (folders.length) { await this.mixer.addFolderLinksToChannel(i, folders); return; }
        }

        const newItems = await filesToPlaylistItems(files);
        await this.mixer.applyChannelPlaylistDrop(i, newItems);
      });
    }
  }

  _bindSoundboardButton(i) {
    const btn = this._el(`sbButton-${i}`);
    if (!btn) return;

    // When the channel stops (naturally or explicitly), sync border + LED
    const ch = this.mixer.soundboard?.channels[i];
    if (ch) ch.onStop = () => this.midi?.sendLed(`sb-${i}`, false);

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
      this._openSoundboardConfig(i);
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
        _setImgSrc(this._el(`sbImg-${i}`), firstPath);
      } else {
        const newItems = await filesToPlaylistItems(files);
        if (!newItems.length) return;
        await this.mixer.soundboard.applyPlaylistDrop(i, newItems);
      }
    });
  }

  _bindAmbientChannel(i) {
    // Volume fader
    this._on(`ambSlider-${i}`, 'input', async (e) => {
      const val = e.target.value / 100;
      this.mixer.ambientMixer?.channels[i].setVolume(val);
      await this.mixer.setGlobalAmbientVolume(i, val);
    });

    // Play/stop toggle
    this._on(`ambPlay-${i}`, 'click', () => {
      const ch = this.mixer.ambientMixer?.channels[i];
      if (!ch) return;
      if (ch.playing) ch.fadeOutAndStop();
      else            ch.play();
      this.updateAmbientPlayState(i);
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

        const firstPath = files[0].path;
        const firstExt  = (firstPath ?? files[0].name).split('.').pop().toLowerCase();
        if (IMAGE_EXT.has(firstExt)) {
          await this._saveAmbientImage(i, firstPath);
          return;
        }

        if (e.ctrlKey) {
          const folders = files.filter(f => !AUDIO_EXT.has(f.name.split('.').pop().toLowerCase()));
          if (folders.length) {
            const newName = await this.mixer.addFolderLinksToAmbient(i, folders);
            if (newName != null) {
              const nameEl = this._el(`ambName-${i}`);
              if (nameEl) nameEl.value = newName;
            }
            return;
          }
        }

        const newItems = await filesToPlaylistItems(files);
        if (!newItems.length) return;
        const newName = await this.mixer.applyAmbientPlaylistDrop(i, newItems);
        if (newName != null) {
          const nameEl = this._el(`ambName-${i}`);
          if (nameEl) nameEl.value = newName;
        }

        // Restore slider value — Chromium may alter range inputs during OS drag-and-drop
        const slEl = this._el(`ambSlider-${i}`);
        if (slEl) slEl.value = (this.mixer.globalVolumes?.ambient?.[i] ?? this.mixer.ambientMixer?.channels[i]?.settings.volume ?? 1) * 100;
      });
    }
  }

  /**
   * Opens the Playlist dialog for one channel-like entity — a music
   * channel, ambient track, or soundboard button, active or a detached
   * scene's. Centralizes the bindPlaylistChannelBridge()+childWindow.open()
   * pairing the six call sites below all need, so a fix made for one (e.g.
   * the imageSrc field, previously hardcoded to '' for a detached scene's
   * ambient tracks instead of being resolved like its active-grid sibling)
   * can't be forgotten on another.
   * @param {string} key
   * @param {() => object} getChannel
   * @param {'channel'|'ambient'|'soundboard'} mode
   * @param {number} index
   * @param {string} title
   * @param {object} [extraData] — mode-specific `data` fields (imageSrc,
   *   isAllScenes, musicSceneId, sbSceneId).
   * @param {object} [extraHandlers] — passed through to bindPlaylistChannelBridge.
   * @param {string|null} [configKey] — this entity's sibling
   *   ChannelConfigDialog/SoundboardConfigDialog window key, if one exists
   *   (ambient has none). When given, every 'playlistChanged' meta message
   *   this window sends (on its own _save()) also pushes a live 'sources:
   *   N' refresh to that window — the two dialogs otherwise go stale
   *   relative to each other until closed and reopened.
   */
  _openPlaylistDialog(key, getChannel, mode, index, title, extraData = {}, extraHandlers = {}, configKey = null) {
    let boundHandlers = extraHandlers;
    if (configKey) {
      const userPlaylistChanged = extraHandlers.playlistChanged;
      boundHandlers = {
        ...extraHandlers,
        playlistChanged: (msg) => {
          if (userPlaylistChanged) userPlaylistChanged(msg);
          else this._onPlaylistChanged(msg.panelId, msg.playlist);
          window.api.childWindow?.push?.(configKey, { kind: 'sourcesChanged', count: msg.playlist.length });
        },
      };
    }
    bindPlaylistChannelBridge(key, { getChannel, mixer: this.mixer, extraHandlers: boundHandlers });

    const ch = getChannel();
    window.api.childWindow.open(key, {
      file: 'playlist.html',
      width: 520,
      height: 560,
      title,
      data: {
        key,
        mode,
        index,
        title,
        currentSoundscape: this.mixer.currentSoundscape,
        channelState: {
          sourceArray:      ch?.sourceArray      ?? [],
          currentlyPlaying: ch?.currentlyPlaying ?? 0,
          playing:          ch?.playing          ?? false,
          loaded:           ch?.loaded           ?? false,
        },
        ...extraData,
      },
    });
  }

  async _openAmbientPlaylist(i) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const isAllScenes = (ss?.globalAmbientChannels ?? []).includes(i);
    const imageSrc = ss?.ambient?.[i]?.settings?.imageSrc ?? '';

    this._openPlaylistDialog(
      `playlist:amb:${i}`,
      () => this.mixer.ambientMixer?.channels[i],
      'ambient', i, t('ambient.playlistTitle', { n: i + 1 }),
      { isAllScenes, imageSrc },
      {
        saveAmbientImage: (msg) => this._saveAmbientImage(i, msg.src),
        nameInferred: (msg) => {
          const ch = this.mixer.ambientMixer?.channels[i];
          if (ch) ch.settings.name = msg.name;
          const nameEl = this._el(`ambName-${i}`);
          if (nameEl) nameEl.value = msg.name;
        },
      },
    );
  }

  /**
   * Opens ChannelConfigDialog for one channel-like entity — a music channel
   * or soundboard button, active or a detached scene's. Centralizes the
   * bindChannelConfigBridge()+childWindow.open() pairing the four call
   * sites below all need.
   * @param {string} key
   * @param {() => object} getChannel
   * @param {'channel'|'soundboard'} mode
   * @param {number} index
   * @param {number} height — 640 for a channel, 680 for a soundboard button
   *   (its extra source-select row).
   * @param {string} title
   * @param {object} [extraData] — mode-specific `data` fields
   *   (sourceArrayLength, musicSceneId, sbSceneId).
   * @param {object} [extraHandlers] — passed through to bindChannelConfigBridge.
   */
  _openChannelConfigDialog(key, getChannel, mode, index, height, title, extraData = {}, extraHandlers = undefined) {
    bindChannelConfigBridge(key, { getChannel, mixer: this.mixer, extraHandlers });

    window.api.childWindow.open(key, {
      file: 'channelConfig.html',
      width: 460,
      height,
      title,
      data: {
        key,
        mode,
        index,
        currentSoundscape: this.mixer.currentSoundscape,
        ...extraData,
      },
    });
  }

  _openChannelConfig(i) {
    const key = `channelConfig:${i}`;
    this._openChannelConfigDialog(
      key, () => this.mixer.channels[i], 'channel', i, 640,
      t('channelConfig.title', { n: i + 1 }),
      { sourceArrayLength: this.mixer.channels[i]?.sourceArray?.length ?? 0 },
      {
        openPlaylist: () => this._openChannelPlaylistFromConfig(i),
        imageChanged: (msg) => {
          _setImgSrc(this._el(`chImg-${i}`), msg.src);
          this._el(`box-${i}`)?.classList.toggle('has-image', !!msg.src);
        },
        playlistChanged: (msg) => this._onPlaylistChanged(msg.panelId, msg.playlist),
      },
    );
  }

  _openChannelPlaylistFromConfig(i) {
    this._openPlaylistDialog(
      `playlist:ch:${i}`,
      () => this.mixer.channels[i],
      'channel', i, t('channelConfig.playlistTitle', { n: i + 1 }),
      {},
      {
        nameInferred: (msg) => {
          this.mixer.channels[i].settings.name = msg.name;
          const nameEl = this._el(`channelName-${i}`);
          if (nameEl) { nameEl.value = msg.name; nameEl.title = msg.name; }
        },
      },
      `channelConfig:${i}`,
    );
  }

  _openSoundboardConfig(i) {
    const key = `soundboardConfig:${i}`;
    this._openChannelConfigDialog(
      key, () => this.mixer.soundboard.channels[i], 'soundboard', i, 680,
      t('soundboardConfig.title', { n: i + 1 }),
      { sourceArrayLength: this.mixer.soundboard.channels[i]?.sourceArray?.length ?? 0 },
      {
        openPlaylist: () => this._openSoundboardPlaylistFromConfig(i),
        imageChanged: (msg) => {
          _setImgSrc(this._el(`sbImg-${i}`), msg.src);
        },
        nameChanged: (msg) => {
          const label = this._el(`sbLabel-${i}`);
          if (label) label.textContent = msg.name;
        },
        playlistChanged: (msg) => this._onPlaylistChanged(msg.panelId, msg.playlist),
      },
    );
  }

  _openSoundboardPlaylistFromConfig(i) {
    this._openPlaylistDialog(
      `playlist:sb:${i}`,
      () => this.mixer.soundboard.channels[i],
      'soundboard', i, t('soundboardConfig.playlistTitle', { n: i + 1 }),
      {},
      {
        nameInferred: (msg) => {
          const ch = this.mixer.soundboard.channels[i];
          if (ch) ch.settings.name = msg.name;
          const label = this._el(`sbLabel-${i}`);
          if (label) label.textContent = msg.name;
        },
      },
      `soundboardConfig:${i}`,
    );
  }

  /**
   * Called by Mixer right after it creates a detached scene's parallel
   * Soundboard instance and opens its window (see mixer.js's
   * detachSoundboardScene). Registers the same channelConfigBridge dispatch
   * every other detached dialog uses — here getChannel() resolves to the
   * Soundboard instance itself (not a single button's Channel), which is
   * exactly what its 'call' messages (playSound/newData) target.
   */
  onSoundboardSceneDetached(sceneId, sb) {
    const key = `soundboardScene:${sceneId}`;
    bindChannelConfigBridge(key, {
      getChannel: () => sb,
      mixer: this.mixer,
      extraHandlers: {
        openConfig: (msg) => this._openDetachedSoundboardConfig(sceneId, msg.index),
        startListening: (msg) => this.midi?.startListening(`sb-detached-${sceneId}-${msg.index}`, 'noteon'),
        // Lets a detached button toggle off its own listening state (mirrors
        // _onChainClick's same-entity check in the main window) — without
        // this, the only way to cancel a stray listening state on a
        // detached button would be exiting mapping mode entirely. Guarded by
        // entity identity (not just "cancel whatever's listening") so a
        // stale cancel click can't cut off a listen that's since moved to a
        // different entity.
        stopListening: (msg) => {
          const entityKey = `sb-detached-${sceneId}-${msg.index}`;
          if (this.midi?.getListeningFor() === entityKey) this.midi.stopListening();
        },
        clearMapping: async (msg) => {
          const entityKey = `sb-detached-${sceneId}-${msg.index}`;
          await this.midi?.clearMapping(entityKey);
          // clearMapping() (unlike setMapping via _captureMapping) fires no
          // callback of its own — tell the window directly that this entity
          // is now unmapped, reusing the same shape onListeningStop already
          // pushes below so the window has one code path for both.
          window.api.childWindow.push(key, { kind: 'listeningStop', index: msg.index, mapped: false });
        },
      },
    });
    // Wrapped (not left to the bridge's generic 'call' dispatch) so a click
    // on an empty button — where playSound() silently no-ops per
    // Channel.play()'s `if (!this.loaded...) return;` guard, meaning
    // `playing` never becomes true and onStop() below never fires — doesn't
    // leave the grid window's optimistic "now playing" border stuck on
    // forever. Pushing the real resulting state right after every call
    // self-corrects that case without the grid needing to know why. Also
    // drives the controller's own LED, mirroring how _updateSbBorder()
    // already does this for the active grid's own sb-<slot> mapping.
    const realPlaySound = sb.playSound.bind(sb);
    sb.playSound = (i) => {
      realPlaySound(i);
      const playing = sb.channels[i].playing;
      window.api.childWindow.push(key, { kind: 'sbState', index: i, playing });
      this.midi?.sendLed(`sb-detached-${sceneId}-${i}`, playing);
      this.mixer.onSoundboardFlash?.(i, sceneId);
    };
    for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
      sb.channels[i].onStop = () => {
        window.api.childWindow.push(key, { kind: 'sbState', index: i, playing: false });
        this.midi?.sendLed(`sb-detached-${sceneId}-${i}`, false);
      };
    }
  }

  /**
   * Called by Mixer right after it creates a detached scene's parallel
   * MusicScenePlayer instance and opens its window (see mixer.js's
   * detachMusicScene). Registers a bespoke dispatch for this window's own
   * direct interactions (one key covers all 12 channels + 12 ambient
   * tracks, addressed by {target, index} — unlike channelConfigBridge.js,
   * which addresses a single channel per key), plus wires the nested
   * Config/Playlist/FX dialogs' bridges to point at this player instead of
   * the real Mixer's own active-scene channels.
   */
  onMusicSceneDetached(sceneId) {
    const key = `musicScene:${sceneId}`;
    const getCh = (p, target, index) => target === 'amb' ? p.ambientMixer.channels[index] : p.channels[index];

    onChildWindowMessage(key, async (msg) => {
      // Re-resolve from the live registry on every message rather than
      // trusting the `player` closed over above: this handler stays
      // registered for the lifetime of the app (onChildWindowMessage has no
      // per-window teardown — see childWindowHost.js), so a message already
      // in flight when the scene is reattached (mixer.js's
      // reattachMusicScene/_closeAllDetachedMusicScenes deletes the registry
      // entry and stops every channel, but can't retroactively cancel an
      // IPC call already on its way) must become a safe no-op instead of
      // operating on an orphaned, stopped MusicScenePlayer — mirrors the
      // liveness guard _openDetachedSoundboardConfig/_openDetachedSoundboardPlaylist
      // already have for the sibling soundboard-scene feature.
      const live = this.mixer.detachedMusicScenes.get(sceneId);
      if (!live) return;

      if (msg.kind === 'call') {
        const ch = getCh(live, msg.target, msg.index);
        if (!ch) return;

        if (msg.method === 'togglePlay') {
          if (msg.target === 'amb') await this._detachedAmbientTogglePlay(sceneId, msg.index);
          else                      await this._detachedChannelTogglePlay(sceneId, msg.index);
          return;
        }
        if (msg.method === 'toggleMute') { await this._detachedChannelToggleMute(sceneId, msg.index); return; }
        if (msg.method === 'toggleSolo') { await this.mixer.toggleSolo(msg.index, 0, sceneId); return; }
        if (msg.method === 'toggleLink') { await this.mixer.toggleLink(msg.index, sceneId); return; }
        if (msg.method === 'previous')   { ch.previous?.(); return; }
        if (msg.method === 'next')       { ch.next?.(); return; }
        console.error(`[mixerUI] ${key} unknown call`, msg.target, msg.method);
        return;
      }

      if (msg.kind === 'volume') {
        const ch = getCh(live, msg.target, msg.index);
        if (!ch) return;
        if (msg.target === 'ch' && ch.getLink()) {
          // Known limitation: unlike the main grid's own linked-volume
          // handler (which calls _updateLinkedSliders(i) right after to move
          // every OTHER linked channel's fader thumb to its new proportional
          // position), this window has no push for that — the audio volume
          // of every linked channel updates correctly, but their displayed
          // fader positions go stale until next touched. Same class of
          // accepted gap as musicScene-entry.js's documented play/stop and
          // mute/solo/link color self-correction limitations.
          await live.setLinkVolumes(msg.value, msg.index);
        } else if (msg.target === 'ch') {
          ch.setVolume(msg.value);
          await this.mixer.setGlobalChannelVolume(msg.index, msg.value);
        } else {
          ch.setVolume(msg.value);
          await this.mixer.setGlobalAmbientVolume(msg.index, msg.value);
        }
        return;
      }

      if (msg.kind === 'meta') {
        if (msg.type === 'openConfig')   { this._openDetachedChannelConfig(sceneId, live, msg.index); return; }
        if (msg.type === 'openPlaylist') {
          if (msg.target === 'amb') this._openDetachedAmbientPlaylist(sceneId, live, msg.index);
          else                      this._openDetachedChannelPlaylist(sceneId, live, msg.index);
          return;
        }
        if (msg.type === 'openFx')      { this._openDetachedFx(sceneId, live, msg.index); return; }
        if (msg.type === 'nameChanged') { this._saveDetachedName(sceneId, msg.target, msg.index, msg.name); return; }
        // A channel/ambient strip has up to seven independently-bindable
        // actions (unlike a soundboard slot's single 'play'), so this
        // window sends its own full entity key back verbatim (msg.key)
        // instead of a bare index the bridge would have to reconstruct.
        // msg.mapType (not msg.type — that's already this dispatch's own
        // discriminator) carries the MIDI capture type ('noteon' for
        // buttons, 'volume_any' for faders).
        if (msg.type === 'startListening') { this.midi?.startListening(msg.key, msg.mapType); return; }
        if (msg.type === 'stopListening') {
          if (this.midi?.getListeningFor() === msg.key) this.midi.stopListening();
          return;
        }
        if (msg.type === 'clearMapping') {
          await this.midi?.clearMapping(msg.key);
          // clearMapping() (unlike setMapping via _captureMapping) fires no
          // callback of its own — tell the window directly that this entity
          // is now unmapped, reusing the same shape onListeningStop already
          // pushes below so the window has one code path for both.
          window.api.childWindow.push(key, { kind: 'listeningStop', key: msg.key, mapped: false });
          return;
        }
        if (msg.type === 'dropImage') {
          // Ambient images are Storage-only (no live-channel field to set —
          // see _saveDetachedAmbientImage's own doc comment), reused as-is
          // from Phase 2. Channel images go through newData(), which is
          // sceneId-aware as of this plan's Task 1.
          if (msg.target === 'amb') await this._saveDetachedAmbientImage(sceneId, msg.index, msg.path);
          else                      await this.mixer.newData(msg.index, { type: 'image', source: msg.path }, sceneId);
          return;
        }
        if (msg.type === 'dropPlaylist') {
          if (msg.target === 'amb') await this.mixer.applyAmbientPlaylistDrop(msg.index, msg.items, sceneId);
          else                      await this.mixer.applyChannelPlaylistDrop(msg.index, msg.items, sceneId);
          return;
        }
        if (msg.type === 'dropFolders') {
          if (msg.target === 'amb') await this.mixer.addFolderLinksToAmbient(msg.index, msg.folders, sceneId);
          else                      await this.mixer.addFolderLinksToChannel(msg.index, msg.folders, sceneId);
          return;
        }
      }
    });
  }

  /**
   * Shared by the detached window's own play/stop click (via
   * onMusicSceneDetached's bridge) AND MIDI dispatch (midi.js's
   * ch-detached-*-play branch) — one code path that always pushes the
   * resulting state to the window and drives the controller's LED,
   * regardless of what triggered it.
   */
  async _detachedChannelTogglePlay(sceneId, index) {
    const live = this.mixer.detachedMusicScenes.get(sceneId);
    const ch = live?.channels[index];
    if (!ch) return;
    if (ch.playing) {
      await ch.fadeOutAndStop(FADE_STOP_MS);
    } else {
      // Mirrors Mixer.start(i, fadeMs)'s own sequence exactly: reapply solo
      // before playing, so a just-started channel is correctly silenced if
      // some OTHER channel in this scene is currently soloed.
      live.configureSolo();
      ch.play(undefined, FADE_STOP_MS);
    }
    window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'state', target: 'ch', index, playing: ch.playing });
    this.midi?.sendLed(`ch-detached-${sceneId}-${index}-play`, ch.playing);
    // The master play/stop icon reacts to any detached scene's playing
    // state too (see _anyMusicScenePlaying()), not just the active scene's.
    this.updatePlayState();
  }

  /** Ambient analog of _detachedChannelTogglePlay() above — no configureSolo() (ambient has no solo concept) and the default fade (no FADE_STOP_MS), matching the active scene's own ambient play/stop. */
  async _detachedAmbientTogglePlay(sceneId, index) {
    const live = this.mixer.detachedMusicScenes.get(sceneId);
    const ch = live?.ambientMixer.channels[index];
    if (!ch) return;
    if (ch.playing) await ch.fadeOutAndStop();
    else ch.play();
    window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'state', target: 'amb', index, playing: ch.playing });
    this.midi?.sendLed(`amb-detached-${sceneId}-${index}-play`, ch.playing);
    this.updatePlayState();
  }

  /**
   * Shared by the detached window's own mute click AND MIDI dispatch
   * (midi.js's ch-detached-*-mute branch). Closes a previously-accepted
   * gap: before this method existed, a detached scene's mute color only
   * ever changed via that window's own optimistic local click-coloring —
   * nothing pushed the confirmed state back, which was fine as long as
   * mute could only be toggled from that one window. MIDI breaks that
   * assumption (a controller can toggle it while the window is open, from
   * outside its own click), so this now pushes a 'muteState' the window
   * uses to (re)color the button correctly either way.
   */
  async _detachedChannelToggleMute(sceneId, index) {
    const live = this.mixer.detachedMusicScenes.get(sceneId);
    const ch = live?.channels[index];
    if (!ch) return;
    const mute = !ch.getMute();
    ch.setMuteFade(mute, FADE_STOP_MS);
    await this._saveDetachedChannelSetting(sceneId, index, 'mute', mute);
    window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'muteState', index, mute });
    this.midi?.sendLed(`ch-detached-${sceneId}-${index}-mute`, mute);
  }

  /** Storage-only — mirrors _saveChannelSetting/_saveAmbientSetting's own "no live-channel write" behavior for 'name'. */
  async _saveDetachedName(sceneId, target, index, name) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const scene = resolveScene(ss, sceneId);
    if (!scene) return;
    if (target === 'amb') {
      if (!scene.ambient) scene.ambient = [];
      if (!scene.ambient[index]) scene.ambient[index] = { settings: { volume: 1, name: '' }, soundData: {} };
      scene.ambient[index].settings.name = name;
    } else {
      scene.channels[index].settings.name = name;
    }
    await Storage.setSoundscapes(soundscapes);
  }

  /** Storage-only persistence for a detached scene's channel setting (currently just 'mute' — solo/link go through mixer.js's own toggleSolo/toggleLink instead, since those also drive configureSolo()/configureLink()). */
  async _saveDetachedChannelSetting(sceneId, index, key, value) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const scene = resolveScene(ss, sceneId);
    if (!scene?.channels[index]?.settings) return;
    scene.channels[index].settings[key] = value;
    await Storage.setSoundscapes(soundscapes);
  }

  /** Opens ChannelConfigDialog for one channel of a detached scene. */
  _openDetachedChannelConfig(sceneId, player, i) {
    const key      = `channelConfig:musicScene:${sceneId}:${i}`;
    const sceneKey = `musicScene:${sceneId}`;
    this._openChannelConfigDialog(
      key, () => player.channels[i], 'channel', i, 640,
      t('channelConfig.title', { n: i + 1 }),
      { musicSceneId: sceneId, sourceArrayLength: player.channels[i]?.sourceArray?.length ?? 0 },
      {
        openPlaylist: () => this._openDetachedChannelPlaylist(sceneId, player, i),
        imageChanged: (msg) => window.api.childWindow.push(sceneKey, { kind: 'imageChanged', target: 'ch', index: i, src: msg.src }),
        playlistChanged: () => {}, // this scene's own missing-file highlighting isn't built — intentionally inert
      },
    );
  }

  /** Opens the nested Playlist dialog for one music channel of a detached scene. */
  _openDetachedChannelPlaylist(sceneId, player, i) {
    const ch = player.channels[i];
    this._openPlaylistDialog(
      `playlist:musicScene:${sceneId}:ch:${i}`,
      () => player.channels[i],
      'channel', i, t('channelConfig.playlistTitle', { n: i + 1 }),
      { musicSceneId: sceneId },
      {
        nameInferred: (msg) => this._saveDetachedName(sceneId, 'ch', i, msg.name)
          .then(() => window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'nameChanged', target: 'ch', index: i, name: msg.name })),
        playStateChanged: () => {
          window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'state', target: 'ch', index: i, playing: ch.playing });
          this.updatePlayState(); // see the matching note in onMusicSceneDetached's togglePlay
        },
        // Without this override, playlistChannelBridge.js's default handling
        // would apply THIS scene's missing-file highlight to the MAIN
        // window's same-numbered channel (panelId 'ch-<i>' is scene-agnostic).
        // This scene's own highlighting isn't built — intentionally inert
        // rather than wrong. (_openPlaylistDialog's configKey wiring still
        // fires the sources-changed push regardless of this no-op.)
        playlistChanged: () => {},
      },
      `channelConfig:musicScene:${sceneId}:${i}`,
    );
  }

  /**
   * Opens the nested Playlist dialog for one ambient track of a detached
   * scene. imageSrc is resolved from storage (mirroring _openAmbientPlaylist's
   * own active-grid lookup, and _saveDetachedAmbientImage's own write target
   * below) rather than off the live Channel — previously hardcoded to '',
   * which permanently disabled the dialog's clear-image button even when an
   * image was genuinely set.
   */
  async _openDetachedAmbientPlaylist(sceneId, player, i) {
    const soundscapes = await Storage.getSoundscapes();
    const scene = resolveScene(soundscapes[this.mixer.currentSoundscape], sceneId);
    const imageSrc = scene?.ambient?.[i]?.settings?.imageSrc ?? '';

    const ch = player.ambientMixer.channels[i];
    this._openPlaylistDialog(
      `playlist:musicScene:${sceneId}:amb:${i}`,
      () => player.ambientMixer.channels[i],
      'ambient', i, t('ambient.playlistTitle', { n: i + 1 }),
      { musicSceneId: sceneId, imageSrc },
      {
        saveAmbientImage: (msg) => this._saveDetachedAmbientImage(sceneId, i, msg.src),
        nameInferred: (msg) => this._saveDetachedName(sceneId, 'amb', i, msg.name)
          .then(() => window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'nameChanged', target: 'amb', index: i, name: msg.name })),
        playStateChanged: () => {
          window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'state', target: 'amb', index: i, playing: ch.playing });
          this.updatePlayState(); // see the matching note in onMusicSceneDetached's togglePlay
        },
        playlistChanged: () => {}, // see the matching note in _openDetachedChannelPlaylist above
      },
    );
  }

  /** Persists a detached scene's ambient image AND pushes the visual update to its window. */
  async _saveDetachedAmbientImage(sceneId, i, src) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const scene = resolveScene(ss, sceneId);
    if (!scene) return;
    if (!scene.ambient) scene.ambient = [];
    if (!scene.ambient[i]) scene.ambient[i] = { settings: { volume: 1, name: '' }, soundData: {} };
    scene.ambient[i].settings.imageSrc = src;
    await Storage.setSoundscapes(soundscapes);
    window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'imageChanged', target: 'amb', index: i, src });
  }

  /**
   * Opens FXDialog (EQ + Delay) for one channel — active or a detached
   * scene's. Centralizes the onChildWindowMessage()+childWindow.open()
   * pairing shared by this and the inline `fx-${i}` click handler in
   * _bindChannelControls() above.
   */
  _openFxDialog(key, ch, i, title, musicSceneId = undefined) {
    onChildWindowMessage(key, ({ target, method, args }) => {
      const fn = ch.effects?.[target]?.[method];
      if (typeof fn !== 'function') {
        console.error(`[mixerUI] ${key} received unknown target/method`, target, method);
        return;
      }
      fn.apply(ch.effects[target], args);
    });
    window.api.childWindow.open(key, {
      file: 'fx.html',
      width: 480,
      height: 580,
      title,
      data: {
        channelNr: i,
        musicSceneId,
        // Read from the live EQ/Delay instances, NOT ch.settings.effects —
        // fxDialog.js's _save() only ever persists into a freshly-fetched
        // Storage copy (soundscapes[...].channels[i].settings.effects), it
        // never writes back into the live channel's own .settings.effects.
        // Reading that field here would show whatever was loaded at the
        // last setData() (channel/scene/soundscape load), not what's
        // actually been applied and is currently audible this session.
        effects: {
          equalizer: ch.effects.eq.settings,
          delay: {
            enable:    ch.effects.delay.enable,
            delayTime: ch.effects.delay.delay,
            volume:    ch.effects.delay.delayVolume,
          },
        },
        currentSoundscape: this.mixer.currentSoundscape,
      },
    });
  }

  /** Opens FXDialog for one channel of a detached scene. */
  _openDetachedFx(sceneId, player, i) {
    this._openFxDialog(`fx:musicScene:${sceneId}:${i}`, player.channels[i], i, t('fxDialog.title', { n: i + 1 }), sceneId);
  }

  /** Opens SoundboardConfigDialog for one button of a detached scene. */
  _openDetachedSoundboardConfig(sceneId, i) {
    const sb = this.mixer.detachedSoundboards.get(sceneId);
    if (!sb) return;
    const key      = `soundboardConfig:scene:${sceneId}:${i}`;
    const sceneKey = `soundboardScene:${sceneId}`;
    this._openChannelConfigDialog(
      key, () => sb.channels[i], 'soundboard', i, 680,
      t('soundboardConfig.title', { n: i + 1 }),
      { sbSceneId: sceneId, sourceArrayLength: sb.channels[i]?.sourceArray?.length ?? 0 },
      {
        openPlaylist: () => this._openDetachedSoundboardPlaylist(sceneId, i),
        imageChanged: (msg) => window.api.childWindow.push(sceneKey, { kind: 'imageChanged', index: i, src: msg.src }),
        nameChanged:  (msg) => window.api.childWindow.push(sceneKey, { kind: 'nameChanged',  index: i, name: msg.name }),
      },
    );
  }

  /**
   * Opens the nested Playlist dialog for one button of a detached scene.
   * Its 'playlistChanged' meta message still updates the main grid's
   * missing-files highlight for button `i` there, not this scene's button
   * `i` — a narrow, self-correcting cosmetic gap (see plan Task 4).
   */
  _openDetachedSoundboardPlaylist(sceneId, i) {
    const sb = this.mixer.detachedSoundboards.get(sceneId);
    if (!sb) return;
    this._openPlaylistDialog(
      `playlist:sbScene:${sceneId}:${i}`,
      () => sb.channels[i],
      'soundboard', i, t('soundboardConfig.playlistTitle', { n: i + 1 }),
      { sbSceneId: sceneId },
      {
        nameInferred: (msg) => {
          const ch = sb.channels[i];
          if (ch) ch.settings.name = msg.name;
          window.api.childWindow.push(`soundboardScene:${sceneId}`, { kind: 'nameChanged', index: i, name: msg.name });
        },
      },
      `soundboardConfig:scene:${sceneId}:${i}`,
    );
  }

  // ─── Scenes ──────────────────────────────────────────────────────────────────

  /**
   * Config table shared by _renderSceneTabs()/_editSceneTab(): everything
   * that differs between the music-scene and soundboard-scene tab rows
   * boils down to these fields — the render/edit algorithms themselves are
   * identical.
   */
  _sceneTabConfig(kind) {
    const isMusic = kind === 'scene';
    return {
      listKey:          isMusic ? 'scenes' : 'sbScenes',
      curKey:           isMusic ? 'currentScene' : 'currentSbScene',
      addBtnId:         isMusic ? 'addScene' : 'addSbScene',
      btnClass:         isMusic ? 'scene-btn' : 'sb-scene-btn',
      activeClass:      isMusic ? 'scene-active' : 'sb-scene-active',
      editWrapClass:    isMusic ? 'scene-edit-wrap' : 'sb-scene-edit-wrap scene-edit-wrap',
      editWrapSelector: isMusic ? '.scene-edit-wrap' : '.sb-scene-edit-wrap',
      idxProp:          isMusic ? 'sceneIdx' : 'sbSceneIdx',
      idxAttr:          isMusic ? 'data-scene-idx' : 'data-sb-scene-idx',
      nameProp:         isMusic ? 'sceneName' : 'sbSceneName',
      detached:         isMusic ? this.mixer.detachedMusicScenes : this.mixer.detachedSoundboards,
      defaultNameKey:   isMusic ? 'scenes.defaultName' : 'scenes.sbDefaultName',
      deleteTitleKey:   isMusic ? 'scenes.deleteTitle' : 'scenes.sbDeleteTitle',
      ledPrefix:        isMusic ? 'scene-' : 'sb-scene-',
      injectMapping:    () => isMusic ? this._injectSceneMappingControls() : this._injectSbSceneMappingControls(),
      remove:           (idx) => isMusic ? this.mixer.removeScene(idx) : this.mixer.removeSoundboardScene(idx),
      rename:           (idx, name) => isMusic ? this.mixer.renameScene(idx, name) : this.mixer.renameSoundboardScene(idx, name),
    };
  }

  _renderSceneTabs(kind, ss) {
    const cfg     = this._sceneTabConfig(kind);
    const scenes  = ss[cfg.listKey] ?? [];
    const current = ss[cfg.curKey] ?? 0;
    const addBtn  = this._el(cfg.addBtnId);
    if (!addBtn) return;

    const row = addBtn.parentElement;

    // A rename editor open on one tab (see _editSceneTab()) must survive an
    // unrelated renderUI() call — renderUI() fires from dozens of mutation
    // paths having nothing to do with renaming (volume/mute toggles, MIDI,
    // remote commands, other scenes changing), and this method used to
    // unconditionally strip EVERY open edit wrap on every call. Removing a
    // still-focused <input> from the DOM fires a native blur on it, which
    // finishEdit() treats exactly like the user clicking away — silently
    // committing whatever partial text was typed so far via rename().
    const editingIdx = this._editingScene?.kind === kind ? this._editingScene.idx : -1;

    // Remove edit wraps only — scene buttons are reused in-place so that
    // CSS transitions fire correctly when the active scene changes. Leaves
    // the currently-being-edited tab's wrap (if any) untouched.
    row.querySelectorAll(cfg.editWrapSelector).forEach(el => {
      if (+el.dataset[cfg.idxProp] === editingIdx) return;
      el.remove();
    });

    // Index existing scene buttons by their scene index
    const existing = new Map(
      [...row.querySelectorAll(`.${cfg.btnClass}[${cfg.idxAttr}]`)]
        .map(b => [+b.dataset[cfg.idxProp], b])
    );

    scenes.forEach((scene, idx) => {
      // Currently being renamed — its button was already replaced by the
      // edit wrap preserved above; leave it alone entirely rather than
      // trying to diff/rebuild a button that no longer exists.
      if (idx === editingIdx) return;

      // Hidden while detached — shown in its own window instead. Explicitly
      // remove any stale button too: this method DIFFS and REUSES existing
      // <button> elements, so a scene that just BECAME detached without
      // being removed from the list still has a leftover button here that
      // a plain "skip creating a new one" wouldn't clean up.
      if (cfg.detached.has(scene.id)) {
        existing.get(idx)?.remove();
        existing.delete(idx);
        return;
      }

      const isActive = idx === current;
      const name = scene.name || t(cfg.defaultNameKey, { n: idx + 1 });
      let btn = existing.get(idx);

      if (btn) {
        existing.delete(idx);
        btn.classList.toggle(cfg.activeClass, isActive);
        btn.textContent = name;
        btn.dataset[cfg.nameProp] = name;
      } else {
        btn = document.createElement('button');
        btn.dataset[cfg.idxProp]  = idx;
        btn.dataset[cfg.nameProp] = name;
        btn.className = cfg.btnClass + (isActive ? ' ' + cfg.activeClass : '');
        btn.textContent = name;

        if (kind === 'scene') {
          btn.addEventListener('click', () => {
            const curIdx = this._currentSceneFromRow();
            if (curIdx === null || idx === curIdx) return;
            // Swap classes immediately so the CSS transition fires on
            // click, not after the async switchScene IPC round-trips
            // complete. (Soundboard tabs have no such CSS transition, so
            // switchSoundboardScene() below just waits for the render.)
            const curBtn = row.querySelector(`.scene-btn[data-scene-idx="${curIdx}"]`);
            if (curBtn) curBtn.classList.remove('scene-active');
            btn.classList.add('scene-active');
            this.mixer.switchScene(idx);
          });
        } else {
          btn.addEventListener('click', () => {
            this.mixer.switchSoundboardScene(idx);
          });
        }

        btn.addEventListener('contextmenu', e => {
          e.preventDefault();
          const sceneCount = row.querySelectorAll(`.${cfg.btnClass}[${cfg.idxAttr}]`).length;
          this._editSceneTab(kind, btn, idx, btn.dataset[cfg.nameProp] || t(cfg.defaultNameKey, { n: idx + 1 }), sceneCount);
        });

        this._bindSceneDrag(btn, idx, kind);
        row.insertBefore(btn, addBtn);
      }
    });

    // Remove buttons for deleted scenes
    existing.forEach(btn => btn.remove());

    // Ensure DOM order matches scene index order after additions/removals
    [...row.querySelectorAll(`.${cfg.btnClass}[${cfg.idxAttr}]`)]
      .sort((a, b) => +a.dataset[cfg.idxProp] - +b.dataset[cfg.idxProp])
      .forEach(btn => row.insertBefore(btn, addBtn));

    addBtn.style.display = scenes.length >= 16 ? 'none' : '';
    if (this._mappingMode) cfg.injectMapping();

    // Sync scene LEDs to active state
    scenes.forEach((_, idx) => {
      this.midi?.sendLed(`${cfg.ledPrefix}${idx}`, idx === current);
    });
  }

  _renderScenes(ss)   { this._renderSceneTabs('scene', ss); }
  _renderSbScenes(ss) { this._renderSceneTabs('sbScene', ss); }

  _currentSceneFromRow() {
    const active = document.querySelector('.scene-btn.scene-active');
    return active ? parseInt(active.dataset.sceneIdx) : null;
  }

  _editSceneTab(kind, btn, idx, currentName, sceneCount) {
    const cfg = this._sceneTabConfig(kind);

    const wrap = document.createElement('span');
    wrap.className = cfg.editWrapClass;
    wrap.dataset[cfg.idxProp] = idx; // read by _renderSceneTabs() to protect this wrap from an unrelated re-render

    const input = document.createElement('input');
    input.className  = 'scene-name-input';
    input.type       = 'text';
    input.value      = currentName;
    input.spellcheck = false;

    const trash = document.createElement('button');
    trash.className   = 'scene-trash-btn';
    trash.title       = t(cfg.deleteTitleKey);
    trash.textContent = '🗑';
    trash.disabled    = sceneCount <= 1;

    wrap.appendChild(input);
    wrap.appendChild(trash);
    btn.replaceWith(wrap);
    input.focus();
    input.select();
    this._editingScene = { kind, idx };

    let trashClicked = false;
    let cancelled = false;

    trash.addEventListener('mousedown', () => { trashClicked = true; });

    trash.addEventListener('click', async () => {
      this._editingScene = null;
      await cfg.remove(idx);
      // render() is called by remove → renderUI()
    });

    const finishEdit = async () => {
      if (trashClicked) return;  // trash click handles its own re-render via remove → renderUI
      this._editingScene = null;
      if (!cancelled) {
        const newName = input.value.trim() || t(cfg.defaultNameKey, { n: idx + 1 });
        await cfg.rename(idx, newName);
      }
      // Re-render this tab row only
      const soundscapes = await Storage.getSoundscapes();
      this._renderSceneTabs(kind, soundscapes[this.mixer.currentSoundscape]);
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { input.blur(); }
      if (e.key === 'Escape') { cancelled = true; input.blur(); }
    });
  }

  _editScene(btn, idx, currentName, sceneCount)   { this._editSceneTab('scene', btn, idx, currentName, sceneCount); }
  _editSbScene(btn, idx, currentName, sceneCount) { this._editSceneTab('sbScene', btn, idx, currentName, sceneCount); }

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

        // Read the button's OWN current class rather than a value captured
        // back when this button was created: both _renderScenes() and
        // _renderSbScenes() diff and REUSE existing buttons across renders,
        // so a reused button's active/inactive status can change later
        // without ever re-calling _bindSceneDrag on it.
        const activeClass = type === 'scene' ? 'scene-active' : 'sb-scene-active';
        const canDetach = !btn.classList.contains(activeClass);

        const onMove = (ev) => {
          ghost.style.left = `${ev.clientX - offsetX}px`;
          ghost.style.top  = `${ev.clientY - offsetY}px`;

          // Detect the cursor leaving the actual OS window using SCREEN
          // (absolute) coordinates compared against the window's own
          // on-screen rectangle — not viewport-relative clientX/clientY vs.
          // innerWidth/innerHeight. Chromium keeps delivering mousemove for
          // the whole drag even once the cursor is outside the window (this
          // window retains implicit capture), but clientX/clientY don't
          // reliably reflect that — they stay within/near the viewport
          // range regardless. screenX/screenY are true OS cursor positions
          // and aren't subject to that clamping.
          if (canDetach) {
            const isOutside = ev.screenX < window.screenX || ev.screenY < window.screenY ||
              ev.screenX > window.screenX + window.outerWidth ||
              ev.screenY > window.screenY + window.outerHeight;
            if (isOutside) {
              clearIndicator();
              dragState = { outside: true, screenX: ev.screenX, screenY: ev.screenY };
              return;
            }
          }

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

          if (state?.outside) {
            ghost.remove();
            btn.classList.remove('ch-drag-source');
            if (type === 'scene') await this.mixer.detachMusicScene(idx, { screenX: state.screenX, screenY: state.screenY });
            else                  await this.mixer.detachSoundboardScene(idx, { screenX: state.screenX, screenY: state.screenY });
            return;
          }

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
        onMove({ clientX: curX, clientY: curY, screenX: e.screenX, screenY: e.screenY });
      }, 600);
    });
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
    const dm = id.match(/^mute-(\d+)$/);
    if (dm) this.midi?.sendLed(`ch-${dm[1]}-mute`, mute);
  }

  _setSoloColor(id, solo) {
    const el = this._el(id);
    if (el) el.style.backgroundColor = solo ? '#ffff00' : '#7f7f00';
    const dm = id.match(/^solo-(\d+)$/);
    if (dm) this.midi?.sendLed(`ch-${dm[1]}-solo`, solo);
  }

  _setLinkColor(id, link) {
    const el = this._el(id);
    if (el) el.style.backgroundColor = link ? '#1496ff' : '#0820cc';
    const dm = id.match(/^link-(\d+)$/);
    if (dm) this.midi?.sendLed(`ch-${dm[1]}-link`, link);
  }

  _updateLinkedSliders(excludeIdx) {
    for (let j = 0; j < MIXER_SIZE; j++) {
      if (j === excludeIdx || !this.mixer.linkArray[j]) continue;
      const v = this.mixer.channels[j].settings.volume;
      const slider = this._el(`volumeSlider-${j}`);
      if (slider) slider.value = v * 100;
    }
  }

  async _applyHideMsl(val) {
    document.body.classList.toggle('hide-msl', val);
    // Keep every currently-detached music scene window's own M/S/L
    // visibility in sync too (see musicScene-entry.js's 'hideMslChanged'
    // handler) — without this a detached window only picked up the setting
    // at the moment it was opened, never while already open.
    for (const sceneId of this.mixer.detachedMusicScenes.keys()) {
      window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'hideMslChanged', hideMsl: val });
    }
  }

  _openSettingsPanel() {
    const key = 'settings';
    bindSettingsBridge(key, { getTarget: () => this });
    window.api.childWindow.open(key, {
      file: 'settings.html',
      width: 640,
      height: 640,
      title: t('settings.title'),
      data: {
        key,
        updateInfo: getUpdateInfo(),
        webServerRunning: this._webServerRunning,
        webServerUrl: this._webServerUrl,
      },
    });
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

  async _saveChannelSetting(i, key, val) {
    const soundscapes = await Storage.getSoundscapes();
    if (soundscapes[this.mixer.currentSoundscape]) {
      soundscapes[this.mixer.currentSoundscape].channels[i].settings[key] = val;
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

  async _saveAmbientSetting(i, key, val) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;
    if (!ss.ambient) ss.ambient = [];
    if (!ss.ambient[i]) ss.ambient[i] = { settings: { volume: 1, name: '' }, soundData: null };
    ss.ambient[i].settings[key] = val;
    await Storage.setSoundscapes(soundscapes);
  }

  async _saveAmbientImage(i, src) {
    await this._saveAmbientSetting(i, 'imageSrc', src);
    _setImgSrc(this._el(`ambImg-${i}`), src);
    this._el(`ambBox-${i}`)?.classList.toggle('has-image', !!src);
  }

  // ─── MIDI mapping mode ───────────────────────────────────────────────────────

  _toggleMappingMode() {
    if (this._mappingMode) this._exitMappingMode();
    else this._enterMappingMode();
  }

  _enterMappingMode() {
    this._mappingMode = true;
    if (this.midi) this.midi.mappingMode = true;
    const el = this._el('midiStatus');
    if (el) el.classList.add('midi-mapping-active');
    this._injectMappingControls();
    this._broadcastMappingMode(true);
  }

  _exitMappingMode() {
    this.midi?.cancelListening();
    this._mappingMode = false;
    if (this.midi) this.midi.mappingMode = false;
    const el = this._el('midiStatus');
    if (el) el.classList.remove('midi-mapping-active');
    document.querySelectorAll('.midi-map-wrap').forEach(el => el.remove());
    this._broadcastMappingMode(false);
  }

  /** Pushes the current binding-mode state + full mapping table to every open detached scene window. */
  _broadcastMappingMode(on) {
    const mappings = this.midi?.getMappings() ?? {};
    for (const sceneId of this.mixer.detachedSoundboards.keys()) {
      window.api.childWindow.push(`soundboardScene:${sceneId}`, { kind: 'mappingMode', on, mappings });
    }
    for (const sceneId of this.mixer.detachedMusicScenes.keys()) {
      window.api.childWindow.push(`musicScene:${sceneId}`, { kind: 'mappingMode', on, mappings });
    }
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
    this._injectSbSceneMappingControls();
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

  _injectSbSceneMappingControls() {
    document.querySelectorAll('.midi-map-wrap[data-entity^="sb-scene-"]').forEach(el => el.remove());

    const mappings = this.midi?.getMappings() ?? {};
    document.querySelectorAll('.sb-scene-btn').forEach(btn => {
      const idx = btn.dataset.sbSceneIdx;
      if (idx == null) return;
      const key    = `sb-scene-${idx}`;
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

  /**
   * Shared by onSceneRemoved()/onSbSceneRemoved(): clears the removed
   * scene's own MIDI mapping, shifts every mapping above it down by one
   * index, and purges any per-entity mappings the scene built up while
   * detached (Phase 3's entity key scheme).
   * @param {string} keyPrefix — 'scene-' | 'sb-scene-'
   * @param {string[]} detachedPrefixes — per-entity detached-key prefixes
   *   to purge for this scene, e.g. ['ch-detached-', 'amb-detached-'].
   */
  async _cleanupRemovedSceneMidi(keyPrefix, idx, sceneId, detachedPrefixes) {
    if (!this.midi) return;
    await this.midi.clearMapping(`${keyPrefix}${idx}`);
    // Remap remaining scene keys: keyPrefixN+1 → keyPrefixN for indices
    // above removed. MUST process in ascending index order —
    // Object.entries() only reflects insertion order, which can put e.g.
    // scene-4 before scene-3. Processing scene-4 first would write its
    // value into scene-3 before scene-3's own (still-pending) clear+set
    // step runs, and that step's clearMapping call would then immediately
    // wipe out the value just written there.
    const re = new RegExp(`^${keyPrefix}(\\d+)$`);
    const mappings = this.midi.getMappings();
    const toRemap = Object.entries(mappings)
      .filter(([k]) => { const m = k.match(re); return m && +m[1] > idx; })
      .sort(([a], [b]) => +a.match(re)[1] - +b.match(re)[1]);
    for (const [key, val] of toRemap) {
      const newIdx = +key.match(re)[1] - 1;
      await this.midi.clearMapping(key);
      await this.midi.setMapping(`${keyPrefix}${newIdx}`, val);
    }

    // A deleted scene may have built up its own per-entity mapping set from
    // an earlier detach — purge it too, or it sits in storage forever with
    // no scene left to reference it.
    if (sceneId) {
      const prefixes = detachedPrefixes.map(p => `${p}${sceneId}-`);
      for (const key of Object.keys(this.midi.getMappings())) {
        if (prefixes.some(p => key.startsWith(p))) await this.midi.clearMapping(key);
      }
    }
  }

  /** Called by app.js via mixer.onSceneRemoved */
  async onSceneRemoved(idx, sceneId) {
    return this._cleanupRemovedSceneMidi('scene-', idx, sceneId, ['ch-detached-', 'amb-detached-']);
  }

  /** Called by app.js via mixer.onSbSceneRemoved */
  async onSbSceneRemoved(idx, sceneId) {
    return this._cleanupRemovedSceneMidi('sb-scene-', idx, sceneId, ['sb-detached-']);
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
    const dm = entityKey.match(/^sb-detached-(.+)-(\d+)$/);
    if (dm) {
      window.api.childWindow.push(`soundboardScene:${dm[1]}`, { kind: 'mappingCaptured', index: +dm[2], data });
      return;
    }
    const mm = entityKey.match(/^(?:ch|amb)-detached-(.+)-\d+-\w+$/);
    if (mm) {
      window.api.childWindow.push(`musicScene:${mm[1]}`, { kind: 'mappingCaptured', key: entityKey, data });
      return;
    }
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
    const dm = prevEntityKey.match(/^sb-detached-(.+)-(\d+)$/);
    if (dm) {
      window.api.childWindow.push(`soundboardScene:${dm[1]}`, { kind: 'listeningStop', index: +dm[2], mapped });
      return;
    }
    const mm = prevEntityKey.match(/^(?:ch|amb)-detached-(.+)-\d+-\w+$/);
    if (mm) {
      window.api.childWindow.push(`musicScene:${mm[1]}`, { kind: 'listeningStop', key: prevEntityKey, mapped });
      return;
    }
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
    await window.api.midi.saveMappings({ __sbGridVersion: 2, mappings });
  }

  async _importMidiMappings() {
    let data = await window.api.midi.loadMappings();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    // v2 files: { __sbGridVersion: 2, mappings }; legacy files are the bare
    // mappings object with sb-N keys in the old 5-wide numbering.
    data = data.__sbGridVersion >= 2 ? data.mappings : migrateMidiMappings(data);
    if (!data || typeof data !== 'object') return;
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
    for (const ss of toAdd) { migrateSoundscape(ss, makeEmptySoundboardButton); migrateTrackCount(ss); }
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

      onChildWindowMessage('missingFiles', async (remap) => {
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
      });

      await window.api.childWindow.open('missingFiles', {
        file: 'missingFiles.html',
        width: 640,
        height: 480,
        title: t('missingFiles.title'),
        data: { entries },
      });
    }
  }

  /** Add/remove .has-missing-files class on channel elements. */
  _applyMissingHighlights() {
    for (let i = 0; i < MIXER_SIZE; i++) {
      const el = this._el(`box-${i}`);
      if (el) el.classList.toggle('has-missing-files',
        (this._missingChannels.get(`music-${i}`)?.size ?? 0) > 0);
    }
    for (let i = 0; i < AMBIENT_SIZE; i++) {
      const el = this._el(`ambBox-${i}`);
      if (el) el.classList.toggle('has-missing-files',
        (this._missingChannels.get(`ambient-${i}`)?.size ?? 0) > 0);
    }
    for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
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
    for (const ss of data) { migrateSoundscape(ss, makeEmptySoundboardButton); migrateTrackCount(ss); }

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
