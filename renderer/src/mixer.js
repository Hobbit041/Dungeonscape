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
  MIXER_SIZE,
  makeEmptyChannel, makeEmptyChannelArray,
  makeEmptyAmbient, makeEmptyAmbientArray,
  makeEmptySoundboardButton, makeEmptySoundboardArray
} from './templates.js';

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

  /** Called by app.js after construction */
  onUIUpdate     = null;  // function() — call to re-render UI
  onSceneRemoved   = null;  // (idx) => void — called after a scene is removed
  onSbSceneRemoved = null;  // (idx) => void — called after a soundboard scene is removed
  onProfileLoaded = null; // () => void — called after setSoundscape completes
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
    }

    await this.setSoundscape(startIdx);
  }

  // ─── Global (cross-scene, cross-profile) volume sliders ────────────────────

  async setGlobalChannelVolume(i, v) {
    this.globalVolumes.channels[i] = v;
    await Storage.setGlobalVolumes(this.globalVolumes);
  }

  async setGlobalMasterVolume(v) {
    this.globalVolumes.master = v;
    await Storage.setGlobalVolumes(this.globalVolumes);
  }

  async setGlobalAmbientVolume(i, v) {
    this.globalVolumes.ambient[i] = v;
    await Storage.setGlobalVolumes(this.globalVolumes);
  }

  async setGlobalAmbientMasterVolume(v) {
    this.globalVolumes.ambientMaster = v;
    await Storage.setGlobalVolumes(this.globalVolumes);
  }

  async setGlobalSoundboardVolume(v) {
    this.globalVolumes.soundboard = v;
    await Storage.setGlobalVolumes(this.globalVolumes);
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
      await Storage.setGlobalVolumes(this.globalVolumes);
      return;
    }

    const diff = volume / base;
    for (const ch of this.channels) {
      if (!this.linkArray[ch.channelNr]) continue;
      const v = this.linkProportion[ch.channelNr] * diff;
      ch.setVolume(v);
      this.globalVolumes.channels[ch.channelNr] = v;
    }
    await Storage.setGlobalVolumes(this.globalVolumes);
  }

  // ─── Soundscape Management ────────────────────────────────────────────────

  async setSoundscape(newSoundscape, forceStart = false) {
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
      settings.sbScenes = [{ name: 'SB 1', soundboard: structuredClone(settings.soundboard ?? []) }];
      settings.currentSbScene = 0;
      soundscapes[this.currentSoundscape] = settings;
      await Storage.setSoundscapes(soundscapes);
    }

    this.name = settings.name;
    for (let i = 0; i < this.mixerSize; i++) {
      this.channels[i].setData(settings.channels[i]);
    }
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

    // Reload non-global music channels
    for (let i = 0; i < this.mixerSize; i++) {
      if (globalMusic.includes(i)) continue;
      await this.channels[i].setData(ss.channels[i]);
    }
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

  async toggleSolo(i, fadeMs = 0) {
    const ch = this.channels[i];
    if (!ch) return;
    const solo = !ch.getSolo();
    ch.setSolo(solo);
    if (fadeMs > 0) this.configureSoloFade(fadeMs);
    else            this.configureSolo();
    const soundscapes = await Storage.getSoundscapes();
    if (soundscapes[this.currentSoundscape]?.channels[i]?.settings) {
      soundscapes[this.currentSoundscape].channels[i].settings.solo = solo;
      await Storage.setSoundscapes(soundscapes);
    }
    this.ui?.updateSolo(i, solo);
  }

  async toggleLink(i) {
    const ch = this.channels[i];
    if (!ch) return;
    const link = !ch.getLink();
    ch.setLink(link);
    this.configureLink();
    const soundscapes = await Storage.getSoundscapes();
    if (soundscapes[this.currentSoundscape]?.channels[i]?.settings) {
      soundscapes[this.currentSoundscape].channels[i].settings.link = link;
      await Storage.setSoundscapes(soundscapes);
    }
    this.ui?.updateLink(i, link);
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
    if (this.onSbSceneRemoved) this.onSbSceneRemoved(idx);
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

  // ─── Clear / reset ────────────────────────────────────────────────────────────

  async clearChannel(channelNr) {
    this.channels[channelNr].stop(true);
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;

    if (ss.globalMusicChannels?.includes(channelNr)) {
      ss.globalMusicChannels = ss.globalMusicChannels.filter(i => i !== channelNr);
      for (const scene of ss.scenes ?? []) {
        if (scene.channels) scene.channels[channelNr] = makeEmptyChannel(channelNr);
      }
    }

    ss.channels[channelNr] = makeEmptyChannel(channelNr);
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    await this.channels[channelNr].setData(ss.channels[channelNr]);
    this.renderUI();
  }

  async clearAmbientChannel(i) {
    const ch = this.ambientMixer?.channels[i];
    if (ch) ch.stop();
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;

    if (ss.globalAmbientChannels?.includes(i)) {
      ss.globalAmbientChannels = ss.globalAmbientChannels.filter(j => j !== i);
      for (const scene of ss.scenes ?? []) {
        if (!scene.ambient) scene.ambient = [];
        scene.ambient[i] = makeEmptyAmbient(i);
      }
    }

    if (!ss.ambient) ss.ambient = [];
    ss.ambient[i] = makeEmptyAmbient(i);
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    if (ch) {
      ch.sourceArray = [];
      ch.settings = { volume: 1, name: '', imageSrc: '' };
      ch.gainNode.gain.value = 1;
    }
    this.renderUI();
  }

  async clearSoundboardButton(btnNr) {
    this.soundboard.channels[btnNr]?.stop(true);
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.currentSoundscape];
    if (!ss) return;

    if (ss.globalSoundboardButtons?.includes(btnNr)) {
      ss.globalSoundboardButtons = ss.globalSoundboardButtons.filter(i => i !== btnNr);
      for (const scene of ss.sbScenes ?? []) {
        if (scene.soundboard) scene.soundboard[btnNr] = makeEmptySoundboardButton(btnNr);
      }
    }

    ss.soundboard[btnNr] = makeEmptySoundboardButton(btnNr);
    soundscapes[this.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);
    this.soundboard.configure(ss);
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
    this.channels[targetId].setData(chSettings);
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
        name:     'Scene 1',
        channels: structuredClone(channels),
        ambient:  structuredClone(ambient)
      }],
      channels,
      master: { settings: { volume: 1, mute: false } },
      soundboard,
      soundboardGain: 0.75,
      sbScenes: [{ name: 'SB 1', soundboard: structuredClone(soundboard) }],
      currentSbScene: 0,
      ambient,
      ambientMaster: { volume: 1 }
    };
  }
}
