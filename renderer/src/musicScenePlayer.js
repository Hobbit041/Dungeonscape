/**
 * musicScenePlayer.js
 *
 * A parallel, independently-playable copy of one music/ambient scene's
 * channels — the music/ambient equivalent of soundboard.js's Soundboard
 * class, built fresh here since (unlike soundboard buttons, and unlike
 * ambient tracks, already encapsulated in AmbientMixer) regular music
 * channels were never encapsulated in a reusable class before this file
 * existed; they lived directly on Mixer itself.
 *
 * Only ever constructed for a detached (necessarily non-active) scene — see
 * this project's Phase 2 for the actual detach lifecycle. Not used for the
 * main window's own active grid, which keeps using Mixer.channels[]/
 * Mixer.ambientMixer completely unchanged.
 */
import { Channel } from './channel.js';
import { AmbientMixer } from './ambientMixer.js';
import { MIXER_SIZE } from './templates.js';
import { resolveScene } from './sceneUtils.js';

export class MusicScenePlayer {
  /**
   * @param {Mixer} mixer — the real Mixer instance (for audioCtx, the
   *   shared interface gain, globalVolumes, and deferred-save scheduling).
   * @param {string} sceneId — the stable id (ss.scenes[].id) of the scene
   *   this instance is bound to. Always non-null: a MusicScenePlayer is
   *   only ever created for a detached, necessarily-non-active scene.
   */
  constructor(mixer, sceneId) {
    this.mixer   = mixer;
    this.sceneId = sceneId;
    this.audioCtx = mixer.audioCtx;
    this.channels = [];
    this.linkArray = [];
    this.linkProportion = [];
    this.highestVolume = 0;
    this.highestVolumeIteration = 0;

    for (let i = 0; i < MIXER_SIZE; i++) {
      this.channels.push(new Channel(this, i));
    }
    this.master = new Channel(this, 'sceneMaster');
    this.ambientMixer = new AmbientMixer(mixer, sceneId);
  }

  /**
   * Regular Channel.setData() reads `this.mixer.globalVolumes` to apply the
   * shared, cross-scene per-channel-number volume preset — delegate to the
   * real Mixer's own globalVolumes rather than duplicating it here.
   */
  get globalVolumes() {
    return this.mixer.globalVolumes;
  }

  /**
   * Load this instance's bound scene's channel/ambient data into the live
   * Channel objects. If the scene no longer resolves (e.g. deleted out from
   * under a still-live instance), this silently no-ops WITHOUT stopping
   * anything already playing — unlike Soundboard.configure(), which calls
   * stopAll() unconditionally before its own resolve check. That's harmless
   * today since nothing yet calls configure() a second time on a live
   * instance (Phase 2 only calls it once, right after construction), but
   * revisit this if a later phase adds a refresh/re-configure call site.
   */
  async configure(ss) {
    const scene = resolveScene(ss, this.sceneId);
    if (!scene) return;
    await Promise.all(
      this.channels.map((ch, i) => ch.setData(scene.channels[i]))
    );
    this.master.setVolume(this.mixer.globalVolumes?.master ?? 1);
    await this.ambientMixer.configure(ss);
    this.configureLink();
  }

  // ─── Solo / Link — scoped to this instance's own channels only ────────────

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
      for (let i = 0; i < MIXER_SIZE; i++) this.linkProportion[i] /= highestVolume;
    }
    this.highestVolume = highestVolume;
    this.highestVolumeIteration = highestVolumeIteration;
  }

  async setLinkVolumes(volume, channel) {
    const base = this.linkProportion[channel];
    if (!(base > 0)) {
      for (const ch of this.channels) {
        if (ch.channelNr === channel || this.linkArray[ch.channelNr]) {
          ch.setVolume(volume);
          await this.mixer.setGlobalChannelVolume(ch.channelNr, volume);
        }
      }
      this.configureLink();
      return;
    }

    const diff = volume / base;
    for (const ch of this.channels) {
      if (!this.linkArray[ch.channelNr]) continue;
      const v = this.linkProportion[ch.channelNr] * diff;
      ch.setVolume(v);
      await this.mixer.setGlobalChannelVolume(ch.channelNr, v);
    }
  }
}
