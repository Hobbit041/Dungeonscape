/**
 * mixer.js — ported from Foundry Soundscape module.
 * Removed: game.socket, Hooks, game.settings, activeUser, MixerApp (FormApplication)
 * Storage is now handled by storage.js (electron-store via IPC)
 */
import { Channel      } from './channel.js';
import { Soundboard   } from './soundboard.js';
import { AmbientMixer, AMBIENT_SIZE } from './ambientMixer.js';
import { Storage      } from './storage.js';
import { FADE_STOP_MS } from './audioFade.js';
import {
  MIXER_SIZE, SOUNDBOARD_SIZE,
  makeEmptyChannel, makeEmptyChannelArray,
  makeEmptyAmbient, makeEmptyAmbientArray,
  makeEmptySoundboardButton, makeEmptySoundboardArray
} from './templates.js';
import { migrateGlobalVolumes } from './trackCount.js';
import { makeSceneId, resolveSoundboardArray, SB_GAP } from './sbGrid.js';
import { resolveScene } from './sceneUtils.js';
import { MusicScenePlayer } from './musicScenePlayer.js';

/**
 * Fade an orphaned HTMLAudioElement to silence, then clean it up.
 * Call this before nulling ch.audioElement / ch._audio so the old audio
 * keeps playing during the crossfade while the new scene loads.
 */
function _fadeOrphan(el, node, ms, effectiveVol = 1) {
  if (!el) return;
  if (effectiveVol <= 0.001) {
    el.pause();
    el.src = '';
    if (node) { try { node.disconnect(); } catch (_) {} }
    return;
  }
  const startVol = Math.min(effectiveVol, 1);
  el.volume = startVol;
  const step = 20;
  const decrement = startVol / Math.max(1, ms / step);
  const timer = setInterval(() => {
    el.volume = Math.max(0, el.volume - decrement);
    if (el.volume <= 0.001) {
      clearInterval(timer);
      el.pause();
      el.src = '';
      if (node) { try { node.disconnect(); } catch (_) {} }
    }
  }, step);
}

export class Mixer {
  mixerSize  = MIXER_SIZE;
  currentSoundscape = 0;
  master     = null;
  channels   = [];
  name       = '';
  playing    = false;
  linkArray  = [];
  linkProportion = [];
  highestVolume = 0;
  highestVolumeIteration = 0;
  globalVolumes = null; // { channels[12], master, ambient[12], ambientMaster, soundboard } — shared across all scenes/profiles
  detachedSoundboards = new Map(); // sceneId -> Soundboard — one entry per currently-detached (non-active) soundboard scene
  detachedMusicScenes = new Map(); // sceneId -> MusicScenePlayer — one entry per currently-detached (non-active) music/ambient scene

  /** Called by app.js after construction */
  onUIUpdate     = null;  // function() — call to re-render UI
  onSceneRemoved   = null;  // (idx) => void — called after a scene is removed
  onSbSceneRemoved = null;  // (idx) => void — called after a soundboard scene is removed
  onProfileLoaded = null; // () => void — called after setSoundscape completes
  onSoundboardSceneDetached = null; // (sceneId, soundboard) => void — called right after a scene's parallel Soundboard instance + window are created, so MixerUI can register its RPC bridge
  onMusicSceneDetached = null; // (sceneId, player) => void — called right after a scene's parallel MusicScenePlayer instance + window are created, so MixerUI can register its RPC bridge
  ui             = null;  // MixerUI instance — set by app.js

  constructor() {
    this.audioCtx = new AudioContext();

    for (let i = 0; i < this.mixerSize; i++) {
      this.channels.push(new Channel(this, i));
    }
    this.master       = new Channel(this, 'master');
    this.soundboard   = new Soundboard(this);
    this.ambientMixer = new AmbientMixer(this);

    // Resume AudioContext on user interaction (browser policy)
    const resume = () => {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    };
    document.addEventListener('click', resume, { once: true });
  }

  /**
   * Load the last-used soundscape. Must be called by app.js AFTER all
   * callbacks (onUIUpdate, onProfileLoaded, …) are wired — the initial
   * setSoundscape() delivers the loaded profile to the UI only through those
   * callbacks, so wiring them first is what makes the profile paint on launch.
   */
  async init() {
    const soundscapes = await Storage.getSoundscapes();
    const saved = await Storage.getLastSoundscape();
    const startIdx = (saved > 0 && saved < soundscapes.length) ? saved : 0;

    this.globalVolumes = await Storage.getGlobalVolumes();
    if (!this.globalVolumes) {
      // First run after upgrade — seed globals from the soundscape about to
      // load instead of resetting everyone's tuned mix to defaults.
      const seed = soundscapes[startIdx] ?? {};
      this.globalVolumes = {
        channels: Array.from({ length: this.mixerSize }, (_, i) => seed.channels?.[i]?.settings?.volume ?? 1),
        master: seed.master?.settings?.volume ?? 1,
        ambient: Array.from({ length: AMBIENT_SIZE }, (_, i) => seed.ambient?.[i]?.settings?.volume ?? 1),
        ambientMaster: seed.ambientMaster?.volume ?? 1,
        soundboard: seed.soundboardGain ?? 0.75
      };
      await Storage.setGlobalVolumes(this.globalVolumes);
    } else if (migrateGlobalVolumes(this.globalVolumes)) {
      // Existing (pre-phase-2) save — pad channels/ambient volume arrays up
      // to the current MIXER_SIZE/AMBIENT_SIZE. Without this, reading a
      // missing index later throws inside the Web Audio graph and aborts
      // init() before the UI ever renders.
      await Storage.setGlobalVolumes(this.globalVolumes);
    }

    await this.setSoundscape(startIdx);
  }

  // ─── Global (cross-scene, cross-profile) volume sliders ────────────────────

  async setGlobalChannelVolume(i, v) {
    this.globalVolumes.channels[i] = v;
    // Symmetric broadcast: this preset is cross-scene (Channel.setData() reads
    // it for whichever scene is being configured), so a change reaches the
    // active scene's own live channel too — harmless/redundant when the main
    // window's own slider is what triggered this (it already set the live
    // channel itself before calling here), and is the only path that applies
    // it when a DETACHED scene's slider is what triggered this instead.
    this.channels[i].setVolume(v);
    for (const player of this.detachedMusicScenes.values()) player.channels[i].setVolume(v);
    this._deferGlobalVolumesSave();
  }

  async setGlobalMasterVolume(v) {
    this.globalVolumes.master = v;
    this.master.setVolume(v);
    for (const player of this.detachedMusicScenes.values()) player.master.setVolume(v);
    this._deferGlobalVolumesSave();
  }

  async setGlobalAmbientVolume(i, v) {
    this.globalVolumes.ambient[i] = v;
    this.ambientMixer?.channels[i]?.setVolume(v);
    for (const player of this.detachedMusicScenes.values()) player.ambientMixer.channels[i].setVolume(v);
    this._deferGlobalVolumesSave();
  }

  async setGlobalAmbientMasterVolume(v) {
    this.globalVolumes.ambientMaster = v;
    this.ambientMixer?.setMasterVolume(v);
    for (const player of this.detachedMusicScenes.values()) player.ambientMixer.setMasterVolume(v);
    this._deferGlobalVolumesSave();
  }

  async setGlobalSoundboardVolume(v) {
    this.globalVolumes.soundboard = v;
    for (const sb of this.detachedSoundboards.values()) sb._applyMasterGain(v);
    this._deferGlobalVolumesSave();
  }

  /** "Остановить все звуки" must reach every detached scene's parallel instance too, not just the active one. */
  stopAllSoundboards() {
    this.soundboard.stopAll();
    for (const sb of this.detachedSoundboards.values()) sb.stopAll();
  }

  /**
   * Schedule a single Storage write 300ms after the last global-volume change.
   * Fader drags fire dozens of 'input' events per second; without this every
   * tick was an unthrottled Storage write (mirrors midi.js's own _deferSave).
   */
  _deferGlobalVolumesSave() {
    clearTimeout(this._globalVolumesSaveTimer);
    this._globalVolumesSaveTimer = setTimeout(() => {
      Storage.setGlobalVolumes(this.globalVolumes).catch(err => {
        console.error('[Mixer] deferred globalVolumes save failed:', err);
      });
    }, 300);
  }

  /** Trigger UI re-render */
  renderUI() {
    if (this.onUIUpdate) this.onUIUpdate();
  }

  // ─── Playback ─────────────────────────────────────────────────────────────

  start(channel = undefined, fadeInMs = 0) {
    this.configureSolo();
    this.playing = true;
    if (channel == undefined) {
      for (const ch of this.channels) ch.play(undefined, fadeInMs);
    } else {
      this.channels[channel].play(undefined, fadeInMs);
    }
  }

  stop(channel = undefined, fadeOut = false, force = true) {
    if (channel == undefined && fadeOut) {
      this.master.effects.gain.node.gain
        .setTargetAtTime(0, this.audioCtx.currentTime, 0.25);
    }
    if (channel == undefined) {
      this.playing = false;
      for (const ch of this.channels) {
        if (fadeOut) setTimeout(() => ch.stop(force), 1000);
        else ch.stop(force);
      }
    } else {
      this.channels[channel].stop(force);
      this.playing = false;
      for (const ch of this.channels) {
        if (ch.playing) { this.playing = true; return; }
      }
    }
  }

  // ─── Solo / Link ──────────────────────────────────────────────────────────

  configureSolo() {
    const soloOn = this.channels.some(ch => ch.getSolo());
    for (const ch of this.channels) {
      if (!soloOn || ch.getSolo()) ch.setVolume(undefined, undefined, true);
      else ch.setVolume(0, false, true);
    }
  }

  configureLink() {
    this.linkArray = [];
    let highestVolume = 0, highestVolumeIteration = 0;
    for (const ch of this.channels) {
      const link = ch.settings.link;
      this.linkArray[ch.channelNr] = ch.settings.volume > 0 ? link : false;
      if (link) {
        const v = ch.settings.volume;
        if (v > highestVolume) { highestVolume = v; highestVolumeIteration = ch.channelNr; }
        this.linkProportion[ch.channelNr] = v;
      } else {
        this.linkProportion[ch.channelNr] = 0;
      }
    }
    if (highestVolume > 0) {
      for (let i = 0; i < this.mixerSize; i++) this.linkProportion[i] /= highestVolume;
    }
    this.highestVolume = highestVolume;
    this.highestVolumeIteration = highestVolumeIteration;
  }

  async setLinkVolumes(volume, channel) {
    // If the dragged channel has no valid proportion baseline (volume was 0
    // when links were last configured, or it was excluded from the link set),
    // dividing would yield Infinity/NaN. Instead, set all linked channels to
    // the new volume and rebuild proportions so future drags work from here.
    const base = this.linkProportion[channel];
    if (!(base > 0)) {
      for (const ch of this.channels) {
        if (ch.channelNr === channel || this.linkArray[ch.channelNr]) {
          ch.setVolume(volume);
          this.globalVolumes.channels[ch.channelNr] = volume;
        }
      }
      this.configureLink();
      this._deferGlobalVolumesSave();
      return;
    }

    const diff = volume / base;
    for (const ch of this.channels) {
      if (!this.linkArray[ch.channelNr]) continue;
      const v = this.linkProportion[ch.channelNr] * diff;
      ch.setVolume(v);
      this.globalVolumes.channels[ch.channelNr] = v;
    }
    this._deferGlobalVolumesSave();
  }

  // ─── Soundscape Management ────────────────────────────────────────────────

  /**
   * Close any open per-channel FX (EQ/Delay) windows before reloading channel
   * data (scene/soundscape switch). Those windows hold a channel stub with
   * live-RPC calls that land on this.channels[i] and a static
   * currentSoundscape snapshot for _save() — after a reload, the EQ/Delay
   * instances themselves aren't replaced (setData() re-initializes them in
   * place), but their settings are, and persisting into a captured
   * soundscape/scene index could silently write into one the user is no
   * longer looking at. Awaited (not fire-and-forget) so callers block until
   * the close IPC round-trip completes, narrowing — though not eliminating —
   * the window for an already in-flight slider event from the closing
   * renderer to land after this point. switchScene() calls this too even
   * though it only reloads non-global channels (global channels' live state
   * is untouched there) — simpler than special-casing which channels are at
   * risk, at the cost of closing a few FX windows that didn't strictly need it.
   */
  async _closeAllFxWindows() {
    await Promise.all(
      Array.from({ length: this.mixerSize }, (_, i) => window.api.childWindow?.close?.(`fx:${i}`))
    );
  }

  /**
   * Close any open per-channel/ambient/soundboard-button playlist windows,
   * and any open ChannelConfig/SoundboardConfig windows, before reloading
   * channel data — same staleness/corruption risk as _closeAllFxWindows()
   * above. Closes across all key prefixes unconditionally at every call site
   * (setSoundscape/switchScene only reload channels+ambient,
   * switchSoundboardScene only reloads soundboard) — same simplifying
   * trade-off _closeAllFxWindows() already makes, rather than special-casing
   * which slots are actually at risk at each call site.
   */
  async _closeAllDialogWindows() {
    const keys = [
      ...Array.from({ length: this.mixerSize }, (_, i) => `playlist:ch:${i}`),
      ...Array.from({ length: AMBIENT_SIZE },   (_, i) => `playlist:amb:${i}`),
      ...Array.from({ length: SOUNDBOARD_SIZE }, (_, i) => `playlist:sb:${i}`),
      ...Array.from({ length: this.mixerSize }, (_, i) => `channelConfig:${i}`),
      ...Array.from({ length: SOUNDBOARD_SIZE }, (_, i) => `soundboardConfig:${i}`),
    ];
    await Promise.all(keys.map(key => window.api.childWindow?.close?.(key)));
  }

  /**
   * Close every currently-detached soundboard-scene window on a profile
   * switch — a detached scene's audio belongs to the profile being left,
   * not the one being loaded. Deliberately separate from
   * _closeAllDialogWindows()/its callers: switchSoundboardScene() also
   * calls that method (for FX/config-dialog staleness reasons unrelated to
   * this feature), but switching which scene is merely *displayed* in the
   * main grid must NOT close other scenes' detached windows — only a full
   * profile switch does. Tears down each Soundboard instance directly
   * (rather than relying on the window's native 'closed' event, which
   * fires asynchronously) so a scene never appears to "come back" mid
   * profile-switch.
   */
  async _closeAllDetachedSoundboardScenes() {
    const ids = [...this.detachedSoundboards.keys()];
    for (const id of ids) {
      this.detachedSoundboards.get(id)?.stopAll();
      this.detachedSoundboards.delete(id);
    }
    await Promise.all(ids.map(id => window.api.childWindow?.close?.(`soundboardScene:${id}`)));
  }

  /**
   * Close every currently-detached music/ambient-scene window on a profile
   * switch — a detached scene's audio belongs to the profile being left, not
   * the one being loaded. Deliberately separate from
   * _closeAllDialogWindows()/its callers: switchScene() also calls that
   * method (for FX/config-dialog staleness reasons unrelated to this
   * feature), but switching which scene is merely *displayed* in the main
   * grid must NOT close other scenes' detached windows — only a full profile
   * switch does. Tears down each MusicScenePlayer instance directly (rather
   * than relying on the window's native 'closed' event, which fires
   * asynchronously) so a scene never appears to "come back" mid
   * profile-switch.
   *
   * Known, accepted gap (same class the sibling soundboard project already
   * lives with): this does NOT close any nested ChannelConfig/Playlist/FX
   * windows a user may have left open for one of these scenes' channels
   * (keyed `channelConfig:musicScene:<id>:<i>` etc. — see Tasks 2/3/5).
   * Those become orphaned, harmlessly-inert windows pointing at a
   * now-destroyed player until the user closes them by hand.
   */
  async _closeAllDetachedMusicScenes() {
    const ids = [...this.detachedMusicScenes.keys()];
    for (const id of ids) {
      const player = this.detachedMusicScenes.get(id);
      for (const ch of player.channels) ch.stop(true);
      for (const ch of player.ambientMixer.channels) ch.stop();
      this.detachedMusicScenes.delete(id);
    }
    await Promise.all(ids.map(id => window.api.childWindow?.close?.(`musicScene:${id}`)));
  }

  async setSoundscape(newSoundscape, forceStart = false) {
    await this._closeAllFxWindows();
    await this._closeAllDialogWindows();
    await this._closeAllDetachedSoundboardScenes();
    await this._closeAllDetachedMusicScenes();
    const playingTemp = this.playing;
    this.stop(undefined, true);
    this.currentSoundscape = newSoundscape;
    await Storage.setLastSoundscape(newSoundscape);

    let soundscapes = await Storage.getSoundscapes();
    let settings = soundscapes[this.currentSoundscape];

    if (!settings) {
      settings = this.newSoundscape();
      soundscapes[this.currentSoundscape] = settings;
      await Storage.setSoundscapes(soundscapes);
    }

    // Migrate old soundscapes that lack scenes
    if (!settings.scenes) {
      settings.scenes = [{
        id: makeSceneId(),
        name: 'Scene 1',
        channels: structuredClone(settings.channels),
        ambient:  structuredClone(settings.ambient ?? [])
      }];
      settings.currentScene = 0;
      soundscapes[this.currentSoundscape] = settings;
      await Storage.setSoundscapes(soundscapes);
    }

    // Migrate old soundscapes that lack soundboard scenes
    if (!settings.sbScenes) {
      settings.sbScenes = [{ id: makeSceneId(), name: 'SB 1', soundboard: structuredClone(settings.soundboard ?? []) }];
      settings.currentSbScene = 0;
      soundscapes[this.currentSoundscape] = settings;
      await Storage.setSoundscapes(soundscapes);
    }

    this.name = settings.name;
    // Each channel loads independently — await them together so renderUI()/
    // onProfileLoaded() below never fire while a channel is still mid-load
    // (previously fire-and-forget, so render could observe stale channel state).
    await Promise.all(
      Array.from({ length: this.mixerSize }, (_, i) => this.channels[i].setData(settings.channels[i]))
    );
    this.master.setVolume(this.globalVolumes.master);
    this.master.setMute(settings.master.settings.mute);
    this.soundboard.configure(settings);
    await this.ambientMixer.configure(settings);

    this.renderUI();
    if (this.onProfileLoaded) this.onProfileLoaded();

    if (playingTemp || forceStart) {
      setTimeout(() => this.start(), 1000);
    }
  }

  // ─── Scene management ─────────────────────────────────────────────────────────

  async switchScene(newSceneIdx) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.scenes || newSceneIdx < 0 || newSceneIdx >= ss.scenes.length) return;
    const curIdx = ss.currentScene ?? 0;
    if (newSceneIdx === curIdx) return;

    await this._closeAllFxWindows();
    await this._closeAllDialogWindows();

    const globalMusic   = ss.globalMusicChannels   ?? [];
    const globalAmbient = ss.globalAmbientChannels ?? [];

    // Orphan non-global music channels
    for (const ch of this.channels) {
      if (globalMusic.includes(ch.channelNr)) continue;
      _fadeOrphan(ch.audioElement, ch.node, FADE_STOP_MS, ch.effects?.gain?.gain ?? 1);
      ch.audioElement = undefined;
      ch.node         = undefined;
      ch.playing      = false;
      ch.paused       = false;
    }
    this.playing = this.channels.some(ch => globalMusic.includes(ch.channelNr) && ch.playing);

    // Orphan non-global ambient channels via gainNode fade
    for (let i = 0; i < this.ambientMixer.channels.length; i++) {
      if (globalAmbient.includes(i)) continue;
      this.ambientMixer.channels[i].fadeOutAndStop(FADE_STOP_MS);
    }

    // Save scene snapshot — for global slots preserve the old snapshot (not live data)
    const channelSnapshot = structuredClone(ss.channels);
    for (const i of globalMusic) {
      channelSnapshot[i] = structuredClone(ss.scenes[curIdx].channels?.[i] ?? makeEmptyChannel(i));
    }
    ss.scenes[curIdx].channels = channelSnapshot;

    const ambientSnapshot = structuredClone(ss.ambient ?? []);
    for (const i of globalAmbient) {
      ambientSnapshot[i] = structuredClone(ss.scenes[curIdx].ambient?.[i] ?? makeEmptyAmbient(i));
    }
    ss.scenes[curIdx].ambient = ambientSnapshot;

    // Preserve live global data before overwriting working copy
    const savedMusic   = Object.fromEntries(globalMusic.map(i => [i, ss.channels[i]]));
    const savedAmbient = Object.fromEntries(globalAmbient.map(i => [i, (ss.ambient ?? [])[i]]));

    // Load new scene into working copy
    ss.channels = structuredClone(ss.scenes[newSceneIdx].channels);
    ss.ambient  = structuredClone(ss.scenes[newSceneIdx].ambient ?? []);
    for (const i of globalMusic)   ss.channels[i] = savedMusic[i];
    for (const i of globalAmbient) ss.ambient[i]  = savedAmbient[i];

    ss.currentScene = newSceneIdx;
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);

    // Reload non-global music channels — each loads independently, so await
    // them together instead of serializing one IPC-bound setData() at a time.
    await Promise.all(
      Array.from({ length: this.mixerSize }, (_, i) => i)
        .filter(i => !globalMusic.includes(i))
        .map(i => this.channels[i].setData(ss.channels[i]))
    );
    await this.ambientMixer.configure(ss, globalAmbient);

    // Start non-global autoPlay channels (crossfade with fading orphans)
    const autoPlayChannels = this.channels.filter(
      ch => !globalMusic.includes(ch.channelNr) && ch.settings?.autoPlay && ch.sourceArray?.length
    );
    if (autoPlayChannels.length) {
      this.playing = true;
      this.configureSolo();
      for (const ch of autoPlayChannels) ch.play();
    }
    if (this.channels.some(ch => ch.playing)) this.playing = true;

    // Non-global ambient autoPlay channels
    for (let i = 0; i < this.ambientMixer.channelCount; i++) {
      if (globalAmbient.includes(i)) continue;
      const ambEntry = ss.ambient?.[i];
      if (ambEntry?.soundData?.autoPlay && this.ambientMixer.channels[i].sourceArray.length) {
        const ch = this.ambientMixer.channels[i];
        ch.play();
        const playEl = document.getElementById(`ambPlay-${i}`);
        if (playEl) playEl.innerHTML = '<i class="fas fa-stop"></i>';
      }
    }

    this.renderUI();
  }

  async addScene() {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.scenes) ss.scenes = [];
    if (ss.scenes.length >= 16) return;

    const globalMusic   = ss.globalMusicChannels   ?? [];
    const globalAmbient = ss.globalAmbientChannels ?? [];

    const newChannels = makeEmptyChannelArray(MIXER_SIZE);
    for (const i of globalMusic) {
      newChannels[i] = structuredClone(ss.channels[i]);
    }

    const newAmbient = makeEmptyAmbientArray(AMBIENT_SIZE);
    for (const i of globalAmbient) {
      newAmbient[i] = structuredClone(ss.ambient?.[i] ?? makeEmptyAmbient(i));
    }

    ss.scenes.push({
      id:       makeSceneId(),
      name:     `Scene ${ss.scenes.length + 1}`,
      channels: newChannels,
      ambient:  newAmbient
    });
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  async removeScene(idx) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.scenes || ss.scenes.length <= 1) return;

    const curIdx = ss.currentScene ?? 0;
    ss.scenes.splice(idx, 1);

    let newCurIdx = curIdx;
    if (idx === curIdx) {
      newCurIdx = Math.max(0, idx - 1);
      ss.channels = structuredClone(ss.scenes[newCurIdx].channels);
      ss.ambient  = structuredClone(ss.scenes[newCurIdx].ambient ?? []);
    } else if (idx < curIdx) {
      newCurIdx = curIdx - 1;
    }
    ss.currentScene = newCurIdx;
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);

    if (idx === curIdx) {
      for (let i = 0; i < this.mixerSize; i++) {
        await this.channels[i].setData(ss.channels[i]);
      }
      await this.ambientMixer.configure(ss);
    }
    if (this.onSceneRemoved) this.onSceneRemoved(idx);
    this.renderUI();
  }

  /**
   * Detach one non-active music/ambient scene into its own window, with its
   * own parallel MusicScenePlayer instance so it can play simultaneously
   * with whatever's active in the main grid.
   * @param {number} idx — index into ss.scenes of the scene to detach. Must
   *   not be the currently-active scene (nothing to swap it for in the main
   *   grid if it were).
   * @param {{screenX?: number, screenY?: number}} [pos] — where to place the
   *   new window, e.g. the cursor position where the user released the drag.
   */
  async detachMusicScene(idx, pos = {}) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss?.scenes || idx < 0 || idx >= ss.scenes.length) return;
    if (idx === (ss.currentScene ?? 0)) return; // can't detach the active scene
    const scene = ss.scenes[idx];
    if (this.detachedMusicScenes.has(scene.id)) return; // already detached

    const player = new MusicScenePlayer(this, scene.id);
    await player.configure(ss);
    this.detachedMusicScenes.set(scene.id, player);

    const key = `musicScene:${scene.id}`;
    const w = 780, h = 640; // fixed size — this window doesn't use the main grid's dynamic track-count/orientation system (see Task 6)
    const x = pos.screenX != null ? Math.max(0, Math.round(pos.screenX - w / 2)) : undefined;
    const y = pos.screenY != null ? Math.max(0, Math.round(pos.screenY - 20)) : undefined;

    window.api.childWindow?.open?.(key, {
      file: 'musicScene.html',
      width: w,
      height: h,
      x, y,
      title: scene.name,
      data: {
        key,
        sceneId: scene.id,
        channels: player.channels.map((ch, i) => ({
          name:     ch.settings.name ?? '',
          imageSrc: ch.settings.imageSrc ?? '',
          volume:   this.globalVolumes?.channels?.[i] ?? ch.settings.volume ?? 1,
          mute:     ch.settings.mute ?? false,
          solo:     ch.settings.solo ?? false,
          link:     ch.settings.link ?? false,
          playing:  ch.playing,
        })),
        ambient: player.ambientMixer.channels.map((ch, i) => ({
          name:     ch.settings.name ?? '',
          imageSrc: ch.settings.imageSrc ?? '',
          volume:   this.globalVolumes?.ambient?.[i] ?? ch.settings.volume ?? 1,
          playing:  ch.playing,
        })),
      },
    });

    if (this.onMusicSceneDetached) this.onMusicSceneDetached(scene.id, player);
    this.renderUI();
  }

  /**
   * Tear down a detached scene's parallel MusicScenePlayer instance and move
   * its tab to the end of the main window's row. Called when that scene's
   * window closes (see mixerUI.js's window.api.childWindow.onClosed
   * listener) — including when _closeAllDetachedMusicScenes() above closes
   * it programmatically, in which case this is a safe no-op (the registry
   * entry is already gone by the time the resulting native 'closed'
   * notification arrives).
   */
  async reattachMusicScene(sceneId) {
    const player = this.detachedMusicScenes.get(sceneId);
    if (!player) return;
    for (const ch of player.channels) ch.stop(true);
    for (const ch of player.ambientMixer.channels) ch.stop();
    this.detachedMusicScenes.delete(sceneId);

    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    const idx = ss?.scenes?.findIndex(s => s.id === sceneId) ?? -1;
    if (idx !== -1 && idx !== ss.scenes.length - 1) {
      const [moved] = ss.scenes.splice(idx, 1);
      ss.scenes.push(moved);
      let cur = ss.currentScene ?? 0;
      if (idx < cur) cur--;
      ss.currentScene = cur;
      soundscapes[this.currentSoundscape] = ss;
      await Storage.setSoundscapes(soundscapes);
    }

    this.renderUI();
  }

  // ─── Solo ─────────────────────────────────────────────────────────────────────

  /** Like configureSolo() but ramps gain nodes over fadeMs ms instead of instant jumps. */
  configureSoloFade(fadeMs) {
    const soloOn = this.channels.some(ch => ch.getSolo());
    for (const ch of this.channels) {
      const target = (!soloOn || ch.getSolo())
        ? (ch.settings.mute ? 0 : (ch.settings.volume ?? 1))
        : 0;
      ch.effects.gain.ramp(target, fadeMs / 1000);
    }
  }

  /**
   * @param {number} i
   * @param {number} [fadeMs]
   * @param {string|null} [sceneId] — null (default): toggle solo on the
   *   active scene's channel i, exactly as before this parameter existed.
   *   Non-null: toggle it on one specific detached scene's channel i instead
   *   — used by that scene's own detached window. Detached scenes never
   *   fade (MusicScenePlayer has no configureSoloFade equivalent — Phase 1
   *   only built the plain configureSolo(), and this plan doesn't need more
   *   than that), so fadeMs is ignored when sceneId is non-null.
   */
  async toggleSolo(i, fadeMs = 0, sceneId = null) {
    const player = sceneId === null ? this : this.detachedMusicScenes.get(sceneId);
    const ch = player?.channels[i];
    if (!ch) return;
    const solo = !ch.getSolo();
    ch.setSolo(solo);
    if (sceneId === null) {
      if (fadeMs > 0) this.configureSoloFade(fadeMs);
      else            this.configureSolo();
    } else {
      player.configureSolo();
    }
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    const channelsArr = sceneId === null ? ss?.channels : resolveScene(ss, sceneId)?.channels;
    if (channelsArr?.[i]?.settings) {
      channelsArr[i].settings.solo = solo;
      await Storage.setSoundscapes(soundscapes);
    }
    if (sceneId === null) this.ui?.updateSolo(i, solo);
  }

  /** @param {string|null} [sceneId] — see toggleSolo()'s doc above; same contract. */
  async toggleLink(i, sceneId = null) {
    const player = sceneId === null ? this : this.detachedMusicScenes.get(sceneId);
    const ch = player?.channels[i];
    if (!ch) return;
    const link = !ch.getLink();
    ch.setLink(link);
    player.configureLink();
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    const channelsArr = sceneId === null ? ss?.channels : resolveScene(ss, sceneId)?.channels;
    if (channelsArr?.[i]?.settings) {
      channelsArr[i].settings.link = link;
      await Storage.setSoundscapes(soundscapes);
    }
    if (sceneId === null) this.ui?.updateLink(i, link);
  }

  async setAllScenesMusic(channelNr, enable) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;
    if (!ss.globalMusicChannels) ss.globalMusicChannels = [];

    if (enable) {
      if (!ss.globalMusicChannels.includes(channelNr))
        ss.globalMusicChannels.push(channelNr);
    } else {
      for (const scene of ss.scenes ?? []) {
        if (!scene.channels) scene.channels = makeEmptyChannelArray(MIXER_SIZE);
        scene.channels[channelNr] = structuredClone(ss.channels[channelNr]);
      }
      ss.globalMusicChannels = ss.globalMusicChannels.filter(i => i !== channelNr);
    }

    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  async setAllScenesAmbient(channelNr, enable) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;
    if (!ss.globalAmbientChannels) ss.globalAmbientChannels = [];

    if (enable) {
      if (!ss.globalAmbientChannels.includes(channelNr))
        ss.globalAmbientChannels.push(channelNr);
    } else {
      for (const scene of ss.scenes ?? []) {
        if (!scene.ambient) scene.ambient = makeEmptyAmbientArray(AMBIENT_SIZE);
        scene.ambient[channelNr] = structuredClone(ss.ambient?.[channelNr] ?? makeEmptyAmbient(channelNr));
      }
      ss.globalAmbientChannels = ss.globalAmbientChannels.filter(i => i !== channelNr);
    }

    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  // ─── Soundboard scene management ──────────────────────────────────────────────

  async switchSoundboardScene(newIdx) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.sbScenes || newIdx < 0 || newIdx >= ss.sbScenes.length) return;
    const curIdx = ss.currentSbScene ?? 0;
    if (newIdx === curIdx) return;

    await this._closeAllDialogWindows();

    const globalSb = ss.globalSoundboardButtons ?? [];

    // Save snapshot (keep old snapshot data for global slots)
    const sbSnapshot = structuredClone(ss.soundboard);
    for (const i of globalSb) {
      sbSnapshot[i] = structuredClone(ss.sbScenes[curIdx].soundboard?.[i] ?? makeEmptySoundboardButton(i));
    }
    ss.sbScenes[curIdx].soundboard = sbSnapshot;

    // Preserve live global data before overwriting
    const savedSb = Object.fromEntries(globalSb.map(i => [i, ss.soundboard[i]]));

    // Load new snapshot
    ss.soundboard = structuredClone(ss.sbScenes[newIdx].soundboard);
    for (const i of globalSb) ss.soundboard[i] = savedSb[i];

    ss.currentSbScene  = newIdx;
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);

    this.soundboard.configure(ss, { keepPlaying: true });
    this.renderUI();
  }

  async addSoundboardScene() {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.sbScenes) ss.sbScenes = [];
    if (ss.sbScenes.length >= 16) return;

    const globalSb = ss.globalSoundboardButtons ?? [];
    const newSoundboard = makeEmptySoundboardArray();
    for (const i of globalSb) {
      newSoundboard[i] = structuredClone(ss.soundboard[i]);
    }

    ss.sbScenes.push({
      id:         makeSceneId(),
      name:       `SB ${ss.sbScenes.length + 1}`,
      soundboard: newSoundboard
    });
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  async removeSoundboardScene(idx) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.sbScenes || ss.sbScenes.length <= 1) return;

    const removedId = ss.sbScenes[idx]?.id;
    const curIdx = ss.currentSbScene ?? 0;
    ss.sbScenes.splice(idx, 1);

    let newCurIdx = curIdx;
    if (idx === curIdx) {
      newCurIdx = Math.max(0, idx - 1);
      ss.soundboard = structuredClone(ss.sbScenes[newCurIdx].soundboard);
    } else if (idx < curIdx) {
      newCurIdx = curIdx - 1;
    }
    ss.currentSbScene = newCurIdx;
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);

    if (idx === curIdx) {
      this.soundboard.configure(ss, { keepPlaying: true });
    } else {
      // Scene content didn't change, but its index shifted — keep the
      // soundboard's own bookkeeping (used for the play-highlight) in sync.
      this.soundboard.currentSbScene = newCurIdx;
    }
    if (this.onSbSceneRemoved) this.onSbSceneRemoved(idx, removedId);
    this.renderUI();
  }

  async renameSoundboardScene(idx, name) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.sbScenes?.[idx]) return;
    ss.sbScenes[idx].name = name;
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
  }

  async renameScene(idx, name) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.scenes?.[idx]) return;
    ss.scenes[idx].name = name;
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
  }

  async moveScene(from, insertBefore) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.scenes) return;
    const n = ss.scenes.length;
    if (from < 0 || from >= n || insertBefore < 0 || insertBefore > n) return;

    const [moved] = ss.scenes.splice(from, 1);
    let to = insertBefore > from ? insertBefore - 1 : insertBefore;
    if (to < 0) to = 0;
    if (to > ss.scenes.length) to = ss.scenes.length;
    ss.scenes.splice(to, 0, moved);

    let cur = ss.currentScene ?? 0;
    if (cur === from)                          cur = to;
    else if (from < cur && insertBefore > cur) cur--;
    else if (from > cur && insertBefore <= cur) cur++;
    ss.currentScene = cur;

    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  async moveSoundboardScene(from, insertBefore) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss.sbScenes) return;
    const n = ss.sbScenes.length;
    if (from < 0 || from >= n || insertBefore < 0 || insertBefore > n) return;

    const [moved] = ss.sbScenes.splice(from, 1);
    let to = insertBefore > from ? insertBefore - 1 : insertBefore;
    if (to < 0) to = 0;
    if (to > ss.sbScenes.length) to = ss.sbScenes.length;
    ss.sbScenes.splice(to, 0, moved);

    let cur = ss.currentSbScene ?? 0;
    if (cur === from)                          cur = to;
    else if (from < cur && insertBefore > cur) cur--;
    else if (from > cur && insertBefore <= cur) cur++;
    ss.currentSbScene = cur;
    // Reordering never changes which scene's data is loaded, only its index —
    // keep the soundboard's own bookkeeping (used for the play-highlight) in sync.
    this.soundboard.currentSbScene = cur;

    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  /**
   * Detach one non-active soundboard scene into its own window, with its
   * own parallel Soundboard instance so it can play simultaneously with
   * whatever's active in the main grid.
   * @param {number} idx — index into ss.sbScenes of the scene to detach.
   *   Must not be the currently-active scene (nothing to swap it for in the
   *   main grid if it were).
   * @param {{screenX?: number, screenY?: number}} [pos] — where to place the
   *   new window, e.g. the cursor position where the user released the drag.
   */
  async detachSoundboardScene(idx, pos = {}) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss?.sbScenes || idx < 0 || idx >= ss.sbScenes.length) return;
    if (idx === (ss.currentSbScene ?? 0)) return; // can't detach the active scene
    const scene = ss.sbScenes[idx];
    if (this.detachedSoundboards.has(scene.id)) return; // already detached

    const sb = new Soundboard(this, scene.id);
    sb.configure(ss);
    this.detachedSoundboards.set(scene.id, sb);

    const key = `soundboardScene:${scene.id}`;
    const { cols, rows } = await Storage.getSbGridSize();
    const CELL = 90; // px — fixed cell size; this window doesn't dynamically resize like the main grid does
    const w = cols * CELL + (cols - 1) * SB_GAP + 24;
    const h = rows * CELL + (rows - 1) * SB_GAP + 24;
    const x = pos.screenX != null ? Math.max(0, Math.round(pos.screenX - w / 2)) : undefined;
    const y = pos.screenY != null ? Math.max(0, Math.round(pos.screenY - 20)) : undefined;

    const sceneButtons = resolveSoundboardArray(ss, scene.id) ?? [];
    window.api.childWindow?.open?.(key, {
      file: 'soundboardScene.html',
      width: w,
      height: h,
      x, y,
      title: scene.name,
      data: {
        key,
        sceneId: scene.id,
        cols, rows,
        buttons: sceneButtons.map(b => ({ name: b?.name ?? '', imageSrc: b?.imageSrc ?? '' })),
        mappingMode: !!this.ui?._mappingMode,
        mappings: this.ui?._mappingMode ? (this.ui?.midi?.getMappings() ?? {}) : undefined,
      },
    });

    if (this.onSoundboardSceneDetached) this.onSoundboardSceneDetached(scene.id, sb);
    this.renderUI();
  }

  /**
   * Tear down a detached scene's parallel Soundboard instance and move its
   * tab to the end of the main window's row. Called when that scene's
   * window closes (see mixerUI.js's window.api.childWindow.onClosed
   * listener) — including when _closeAllDetachedSoundboardScenes() above
   * closes it programmatically, in which case this is a safe no-op (the
   * registry entry is already gone by the time the resulting native
   * 'closed' notification arrives).
   */
  async reattachSoundboardScene(sceneId) {
    const sb = this.detachedSoundboards.get(sceneId);
    if (!sb) return;
    sb.stopAll();
    this.detachedSoundboards.delete(sceneId);

    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    const idx = ss?.sbScenes?.findIndex(s => s.id === sceneId) ?? -1;
    if (idx !== -1 && idx !== ss.sbScenes.length - 1) {
      const [moved] = ss.sbScenes.splice(idx, 1);
      ss.sbScenes.push(moved);
      let cur = ss.currentSbScene ?? 0;
      if (idx < cur) cur--;
      ss.currentSbScene = cur;
      this.soundboard.currentSbScene = cur;
      soundscapes[this.currentSoundscape] = ss;
      await Storage.setSoundscapes(soundscapes);
    }

    this.renderUI();
  }

  // ─── Clear / reset ────────────────────────────────────────────────────────────

  /**
   * @param {number} channelNr
   * @param {string|null} [sceneId] — null (default): clear a channel on the
   *   active scene, exactly as before this parameter existed. Non-null:
   *   clear it on one specific detached scene instead — used by that scene's
   *   own ChannelConfigDialog. The "clear on all scenes" cascade below only
   *   applies to the active scene: a detached scene's config dialog hides
   *   the "На всех сценах" toggle entirely (see channelConfigDialog.js), so
   *   there's no UI path to mark one of ITS channels global in the first
   *   place.
   */
  async clearChannel(channelNr, sceneId = null) {
    const target = sceneId === null ? this.channels[channelNr] : this.detachedMusicScenes.get(sceneId)?.channels[channelNr];
    target?.stop(true);
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;
    const channelsArr = sceneId === null ? ss.channels : resolveScene(ss, sceneId)?.channels;
    if (sceneId !== null && !channelsArr) return;

    if (sceneId === null && ss.globalMusicChannels?.includes(channelNr)) {
      ss.globalMusicChannels = ss.globalMusicChannels.filter(i => i !== channelNr);
      for (const scene of ss.scenes ?? []) {
        if (scene.channels) scene.channels[channelNr] = makeEmptyChannel(channelNr);
      }
    }

    channelsArr[channelNr] = makeEmptyChannel(channelNr);
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    await target?.setData(channelsArr[channelNr]);
    if (sceneId !== null) {
      // A detached scene has no shared document for renderUI() below to
      // reach — push the reset directly so its own window's strip doesn't
      // keep showing the pre-clear name/image with a now-empty channel.
      const musicSceneKey = `musicScene:${sceneId}`;
      window.api.childWindow?.push?.(musicSceneKey, { kind: 'nameChanged', target: 'ch', index: channelNr, name: '' });
      window.api.childWindow?.push?.(musicSceneKey, { kind: 'imageChanged', target: 'ch', index: channelNr, src: '' });
      window.api.childWindow?.push?.(musicSceneKey, { kind: 'state', target: 'ch', index: channelNr, playing: false });
    }
    this.renderUI();
  }

  /** @param {string|null} [sceneId] — see clearChannel()'s doc above; same contract, for globalAmbientChannels/ambient. */
  async clearAmbientChannel(i, sceneId = null) {
    const player = sceneId === null ? null : this.detachedMusicScenes.get(sceneId);
    const ch = sceneId === null ? this.ambientMixer?.channels[i] : player?.ambientMixer?.channels[i];
    if (ch) ch.stop();
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;
    const scene = sceneId === null ? null : resolveScene(ss, sceneId);
    if (sceneId !== null && !scene) return;

    if (sceneId === null && ss.globalAmbientChannels?.includes(i)) {
      ss.globalAmbientChannels = ss.globalAmbientChannels.filter(j => j !== i);
      for (const s of ss.scenes ?? []) {
        if (!s.ambient) s.ambient = [];
        s.ambient[i] = makeEmptyAmbient(i);
      }
    }

    if (sceneId === null) {
      if (!ss.ambient) ss.ambient = [];
      ss.ambient[i] = makeEmptyAmbient(i);
    } else {
      if (!scene.ambient) scene.ambient = [];
      scene.ambient[i] = makeEmptyAmbient(i);
    }
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    if (ch) {
      ch.sourceArray = [];
      ch.settings = { volume: 1, name: '', imageSrc: '' };
      ch.gainNode.gain.value = 1;
    }
    if (sceneId !== null) {
      // See the matching note in clearChannel() above — this scene's own
      // window has no shared document for renderUI() below to reach.
      const musicSceneKey = `musicScene:${sceneId}`;
      window.api.childWindow?.push?.(musicSceneKey, { kind: 'nameChanged', target: 'amb', index: i, name: '' });
      window.api.childWindow?.push?.(musicSceneKey, { kind: 'imageChanged', target: 'amb', index: i, src: '' });
      window.api.childWindow?.push?.(musicSceneKey, { kind: 'state', target: 'amb', index: i, playing: false });
    }
    this.renderUI();
  }

  /**
   * @param {number} btnNr
   * @param {string|null} [sceneId] — null (default): clear a button on the
   *   active scene, exactly as before this parameter existed. Non-null:
   *   clear a button on one specific detached (non-active) scene instead —
   *   used by that scene's own SoundboardConfigDialog. The "clear on all
   *   scenes" cascade below only applies to the active scene: a detached
   *   scene's config dialog hides the "На все сцены" toggle entirely (see
   *   soundboardConfigDialog.js), so there's no UI path to mark one of ITS
   *   buttons global in the first place.
   */
  async clearSoundboardButton(btnNr, sceneId = null) {
    const target = sceneId === null ? this.soundboard : this.detachedSoundboards.get(sceneId);
    target?.channels[btnNr]?.stop(true);
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;
    const sb = resolveSoundboardArray(ss, sceneId);
    if (!sb) return;

    let cascaded = false;
    if (sceneId === null && ss.globalSoundboardButtons?.includes(btnNr)) {
      ss.globalSoundboardButtons = ss.globalSoundboardButtons.filter(i => i !== btnNr);
      for (const scene of ss.sbScenes ?? []) {
        if (scene.soundboard) scene.soundboard[btnNr] = makeEmptySoundboardButton(btnNr);
      }
      cascaded = true;
    }

    sb[btnNr] = makeEmptySoundboardButton(btnNr);
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    target?.configure(ss);
    if (cascaded) {
      // The cascade above just rewrote every scene's stored soundboard data
      // (this button was global), so every other currently-detached instance
      // is now stale and needs to be re-synced too — not just `target`.
      for (const detached of this.detachedSoundboards.values()) {
        if (detached !== target) detached.configure(ss);
      }
    }
    this.renderUI();
  }

  async setAllScenesSoundboard(btnNr, enable) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;
    if (!ss.globalSoundboardButtons) ss.globalSoundboardButtons = [];

    if (enable) {
      if (!ss.globalSoundboardButtons.includes(btnNr))
        ss.globalSoundboardButtons.push(btnNr);
    } else {
      for (const scene of ss.sbScenes ?? []) {
        if (!scene.soundboard) scene.soundboard = makeEmptySoundboardArray();
        scene.soundboard[btnNr] = structuredClone(ss.soundboard[btnNr]);
      }
      ss.globalSoundboardButtons = ss.globalSoundboardButtons.filter(i => i !== btnNr);
    }

    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  async insertSoundscape(location) {
    const soundscapes = await Storage.getSoundscapes();
    soundscapes.splice(location, 0, this.newSoundscape());
    await Storage.setSoundscapes(soundscapes);
  }

  async removeSoundscape(location) {
    let soundscapes = await Storage.getSoundscapes();
    soundscapes.splice(location, 1);
    if (this.currentSoundscape > soundscapes.length - 1)
      this.currentSoundscape = soundscapes.length - 1;
    if (soundscapes.length === 0) {
      soundscapes.push(this.newSoundscape());
      this.currentSoundscape = 0;
    }
    await Storage.setSoundscapes(soundscapes);
    await this.setSoundscape(this.currentSoundscape);
  }

  async renameSoundscape(index, name) {
    const soundscapes = await Storage.getSoundscapes();
    soundscapes[index].name = name;
    if (index === this.currentSoundscape) this.name = name;
    await Storage.setSoundscapes(soundscapes);
  }

  async newData(targetId, data) {
    const soundscapes = await Storage.getSoundscapes();
    let chSettings = soundscapes[this.currentSoundscape].channels[targetId];
    if (!chSettings) return;

    if (data.type === 'playlist') {
      chSettings.soundData = { playlist: data.playlist, shuffle: false };
      if (!chSettings.settings.name && data.name) chSettings.settings.name = data.name;
    } else if (data.type === 'filepicker_single' || data.type === 'filepicker_folder') {
      chSettings.soundData.source = data.source;
      if (!chSettings.settings.name) chSettings.settings.name = data.name ?? '';
      chSettings.soundData.soundSelect = data.type;
    } else if (data.type === 'image') {
      chSettings.settings.imageSrc = data.source;
    }

    soundscapes[this.currentSoundscape].channels[targetId] = chSettings;
    if (data.type === 'image') {
      // setData() unconditionally stops playback before reloading — dropping
      // an image (which only touches settings.imageSrc, not the sound) onto
      // a currently-playing channel would silently stop it and never resume.
      this.channels[targetId].settings.imageSrc = chSettings.settings.imageSrc;
    } else {
      this.channels[targetId].setData(chSettings);
    }
    await Storage.setSoundscapes(soundscapes);
    this.renderUI();
  }

  /**
   * Update file paths in the current soundscape's playlists without reloading.
   * @param {Record<string, string>} remap  — { oldPath: newPath }
   */
  async applyFileRemap(remap) {
    if (!Object.keys(remap).length) return;
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;

    const remapItem = (item) => (item.path in remap) ? { ...item, path: remap[item.path] } : item;

    for (let i = 0; i < this.mixerSize; i++) {
      const pl = ss.channels[i]?.soundData?.playlist;
      if (Array.isArray(pl)) ss.channels[i].soundData.playlist = pl.map(remapItem);
    }
    if (Array.isArray(ss.ambient)) {
      for (let i = 0; i < ss.ambient.length; i++) {
        const pl = ss.ambient[i]?.soundData?.playlist;
        if (Array.isArray(pl)) ss.ambient[i].soundData.playlist = pl.map(remapItem);
      }
    }
    if (Array.isArray(ss.soundboard)) {
      for (let i = 0; i < ss.soundboard.length; i++) {
        const pl = ss.soundboard[i]?.soundData?.playlist;
        if (Array.isArray(pl)) ss.soundboard[i].soundData.playlist = pl.map(remapItem);
      }
    }

    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
  }

  newSoundscape() {
    const channels   = makeEmptyChannelArray(MIXER_SIZE);
    const soundboard = makeEmptySoundboardArray();
    const ambient    = makeEmptyAmbientArray(AMBIENT_SIZE);

    return {
      name: '',
      currentScene: 0,
      scenes: [{
        id:       makeSceneId(),
        name:     'Scene 1',
        channels: structuredClone(channels),
        ambient:  structuredClone(ambient)
      }],
      channels,
      master: { settings: { volume: 1, mute: false } },
      soundboard,
      soundboardGain: 0.75,
      sbScenes: [{ id: makeSceneId(), name: 'SB 1', soundboard: structuredClone(soundboard) }],
      currentSbScene: 0,
      ambient,
      ambientMaster: { volume: 1 }
    };
  }
}
