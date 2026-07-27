/**
 * ambientMixer.js
 * Mini ambient mixer — 4 channels + master.
 * No M/S/L, no prev/next. Play toggle only.
 * Playlists supported (sequential cycling).
 *
 * MIDI: pitchbend (absolute) OR cc_relative (value 1 = up, value ≥ 64 = down).
 *
 * Audio path:
 *   ambChannel.gainNode → ambMixer.masterGain
 *     → mainMixer.master.effects.gain.node    (main master volume/mute)
 *     → mainMixer.master.effects.interfaceGain.node  (global output volume)
 *     → AudioContext.destination
 */

import { makeEmptyAmbient } from './templates.js';
import { pathToUrl } from './pathUtils.js';
import { FADE_STOP_MS, fadeGainNode } from './audioFade.js';

export const AMBIENT_SIZE = 8;

export class AmbientChannel {
  constructor(ambientMixer, channelNr) {
    this.ambientMixer     = ambientMixer;
    this.channelNr        = channelNr;
    this.playing          = false;
    this.sourceArray      = [];
    this.currentlyPlaying = 0;
    this.settings         = { volume: 1, name: '' };
    this._soundData       = null;
    this._audio           = null;
    this._source          = null;
    this._fading          = false;

    this.gainNode = ambientMixer.audioCtx.createGain();
    this.gainNode.gain.value = 1;
    this.gainNode.connect(ambientMixer.masterGain);
  }

  setData(data) {
    if (!data) return;
    this.settings = {
      volume: data.settings?.volume ?? 1,
      name:   data.settings?.name   ?? ''
    };
    if (!this._fading) this.gainNode.gain.value = this.settings.volume;
    this._soundData = data.soundData ?? null;

    const playlist = data.soundData?.playlist ?? [];
    if (playlist.length) {
      this.sourceArray = playlist.map(item => pathToUrl(item.path)).filter(Boolean);
      if (this.currentlyPlaying >= this.sourceArray.length) this.currentlyPlaying = 0;
    } else {
      this.sourceArray = [];
    }
  }

  setVolume(v) {
    v = Math.max(0, Math.min(1.25, v));
    this.settings.volume = v;
    if (!this._fading) this.gainNode.gain.value = v;
  }

  play() {
    if (!this.sourceArray.length) return;
    this._startTrack(this.currentlyPlaying, true);
  }

  stop() {
    if (!this.playing && !this._audio) return;
    this.playing = false;
    const ctx = this.ambientMixer.audioCtx;
    this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
    this.gainNode.gain.setValueAtTime(this.settings.volume, ctx.currentTime);
    if (this._audio) {
      this._audio.onended = null;
      this._audio.pause();
      this._audio.src = '';
      this._audio = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch (_) {}
      this._source = null;
    }
  }

  /**
   * Fade gain to silence over `ms` ms, then stop the orphaned audio.
   * Immediately nulls _audio/_source so configure()'s stop() is a no-op.
   * Restores gainNode to settings.volume after cleanup (unless a new track
   * has started by then — _startTrack handles gain in that case).
   */
  fadeOutAndStop(ms = FADE_STOP_MS) {
    if (!this._audio) return;
    const ctx    = this.ambientMixer.audioCtx;
    const audio  = this._audio;
    const source = this._source;

    this._fading = true;
    fadeGainNode(this.gainNode, 0, ms, ctx);

    this._audio  = null;
    this._source = null;
    this.playing = false;

    setTimeout(() => {
      this._fading = false;
      audio.onended = null;
      audio.pause();
      audio.src = '';
      if (source) { try { source.disconnect(); } catch (_) {} }
      if (!this._audio) {
        // No new track started — restore gain for next play()
        this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
        this.gainNode.gain.setValueAtTime(this.settings.volume, ctx.currentTime);
      }
    }, ms + 50);
  }

  _startTrack(idx, fadeIn = false) {
    // Clean up previous track
    if (this._audio) {
      this._audio.onended = null;
      this._audio.pause();
      this._audio.src = '';
      this._audio = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch (_) {}
      this._source = null;
    }

    const url = this.sourceArray[idx];
    if (!url) { this.playing = false; return; }

    const ctx   = this.ambientMixer.audioCtx;
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    this._audio  = audio;

    const src = ctx.createMediaElementSource(audio);
    src.connect(this.gainNode);
    this._source          = src;
    this.currentlyPlaying = idx;
    this.playing          = true;

    // Fade-in from silence on explicit play(); playlist cycling resumes at full volume
    this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
    if (fadeIn) {
      this.gainNode.gain.setValueAtTime(0, ctx.currentTime);
      fadeGainNode(this.gainNode, this.settings.volume, FADE_STOP_MS, ctx);
    } else {
      this.gainNode.gain.setValueAtTime(this.settings.volume, ctx.currentTime);
    }

    audio.play().catch(() => { this.playing = false; });

    audio.onended = () => {
      const next = (this.currentlyPlaying + 1) % Math.max(1, this.sourceArray.length);
      this._startTrack(next, false); // no fade-in on auto-cycle
    };
  }
}

export class AmbientMixer {
  constructor(mainMixer) {
    this.mainMixer    = mainMixer;
    this.audioCtx     = mainMixer.audioCtx;
    this.channelCount = AMBIENT_SIZE;
    this.channels     = [];
    this._masterVol   = 1;

    // Build master gain and wire into main audio graph
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = 1;

    const mainMasterGain = mainMixer.master.effects.gain.node;
    const ifaceGain      = mainMixer.master.effects.interfaceGain.node;

    this.masterGain
      .connect(mainMasterGain)
      .connect(ifaceGain)
      .connect(this.audioCtx.destination);

    for (let i = 0; i < this.channelCount; i++) {
      this.channels.push(new AmbientChannel(this, i));
    }
  }

  async configure(soundscapeData, skipIndices = []) {
    const ambient = soundscapeData.ambient ?? [];
    const globalVolumes = this.mainMixer.globalVolumes;
    for (let i = 0; i < this.channelCount; i++) {
      if (skipIndices.includes(i)) continue;
      this.channels[i].stop();
      this.channels[i].setData(ambient[i] ?? makeEmptyAmbient(i));
      if (globalVolumes) this.channels[i].setVolume(globalVolumes.ambient[i]);
      const folderLinks = ambient[i]?.soundData?.folderLinks;
      if (Array.isArray(folderLinks) && folderLinks.length) {
        for (const fp of folderLinks) {
          try {
            const files = await window.api.fs.readFolder(fp);
            this.channels[i].sourceArray.push(...files.map(f => pathToUrl(f)).filter(Boolean));
          } catch (_) {}
        }
        if (this.channels[i].currentlyPlaying >= this.channels[i].sourceArray.length)
          this.channels[i].currentlyPlaying = 0;
      }
    }
    this._masterVol = globalVolumes?.ambientMaster ?? (soundscapeData.ambientMaster?.volume ?? 1);
    this.masterGain.gain.value = this._masterVol;
  }

  getMasterVolume() { return this._masterVol; }

  setMasterVolume(v) {
    v = Math.max(0, Math.min(1.25, v));
    this._masterVol = v;
    this.masterGain.gain.value = v;
  }
}
