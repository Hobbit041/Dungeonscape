/**
 * channel.js — Standalone port (no Foundry)
 * Key changes from original:
 *   - foundry.utils.duplicate  → structuredClone
 *   - game.socket / Hooks      → removed
 *   - game.playlists/FilePicker → window.api (Electron IPC)
 *   - activeUser               → removed (single-user app)
 */
import { Delay } from './Effects/delay.js';
import { Gain }  from './Effects/gain.js';
import { Pan }   from './Effects/pan.js';
import { EQ }    from './Effects/eq.js';
import { makeChannelSettings } from './templates.js';
import { pathToUrl } from './pathUtils.js';
import { showConfirm } from './dialog.js';

const DEF_SOUNDDATA = Object.freeze({
  soundSelect: 'filepicker_single',
  playlistName: '', soundName: '', source: ''
});

export class Channel {
  master           = false;
  playing          = false;
  paused           = false;
  duration         = 0;
  sourceArray      = [];
  currentlyPlaying = 0;
  loaded           = false;
  fadeStarted      = false;
  source           = null;
  firstLoop        = true;
  audioElement         = undefined;
  node                 = undefined;
  _crossfading         = false;
  _crossfadeAbortToken = null;
  _crossfadeOrphans    = [];

  constructor(mixer, channelNr) {
    this.mixer     = mixer;
    this.context   = mixer.audioCtx;
    this.channelNr = channelNr;

    this.settings  = makeChannelSettings(typeof channelNr === 'number' ? channelNr : 0);
    this.soundData = { ...DEF_SOUNDDATA };

    if (channelNr === 'master') {
      this.master = true;
      this.effects = {
        gain:          new Gain(1, this.context),
        interfaceGain: new Gain(0.5, this.context)
      };
    } else if (channelNr >= 100) {
      this.effects = { gain: new Gain(1, this.context) };
    } else {
      this.effects = {
        gain:  new Gain(1, this.context),
        pan:   new Pan(0, this.context),
        fft:   undefined,
        eq:    new EQ(this, this.context),
        delay: new Delay(this, this.context)
      };
    }
  }

  // ─── Data loading ────────────────────────────────────────────────────────────

  async setData(data) {
    this.stop(false);
    this.audioElement = undefined;
    this.settings = data.settings ?? makeChannelSettings(typeof this.channelNr === 'number' ? this.channelNr : 0);

    this.setMute(this.settings.mute);
    this.setSolo(this.settings.solo);
    this.setLink(this.settings.link);
    this.setVolume(this.settings.volume);
    if (this.effects.pan) this.setPan(this.settings.pan);

    if (!data.sourceArray) data.sourceArray = await this.getSounds(data.soundData);
    this.sourceArray = data.sourceArray ?? [];

    if (!this.sourceArray[0]) return;
    this.currentlyPlaying = data.currentlyPlaying ?? 0;
    await this.setSource(this.sourceArray[this.currentlyPlaying]);

    if (this.channelNr !== 'master') {
      this._applyPlaybackRate(this.settings.playbackRate);
      if (this.effects.delay) this.effects.delay.initialize(this.settings.effects?.delay);
      if (this.effects.eq)    this.effects.eq.initialize(this.settings.effects?.equalizer);
    }
  }

  async setSbData(data, currentlyPlaying = 0) {
    const btn = document.getElementById(`sbButton-${data.channel - 100}`);
    if (btn) {
      const rpt = data.repeat?.repeat ?? data.repeat ?? 'none';
      const isLoop = rpt === 'single' || rpt === 'all';
      btn.style.borderColor = isLoop ? 'yellow' : '';
      btn.style.boxShadow   = isLoop ? '0 0 10px yellow' : '';
    }

    this.loaded = false;
    this.stop(false);
    this.settings = data;
    this.setVolume(data.volume ?? 1);

    if (!data.sourceArray) data.sourceArray = await this.getSounds(data.soundData);
    this.sourceArray = data.sourceArray ?? [];

    if (!this.sourceArray[0]) return;
    this.currentlyPlaying = currentlyPlaying;
    await this.setSource(this.sourceArray[currentlyPlaying]);
    this._applyPlaybackRate(data.playbackRate);
  }

  // ─── File resolution ─────────────────────────────────────────────────────────

  async getSounds(soundData) {
    if (!soundData) return [];

    // New playlist format
    if (Array.isArray(soundData.playlist)) {
      const paths = soundData.playlist.map(item => pathToUrl(item.path));
      if (Array.isArray(soundData.folderLinks) && soundData.folderLinks.length) {
        for (const folderPath of soundData.folderLinks) {
          const files = await window.api.fs.readFolder(folderPath);
          paths.push(...files.map(fp => pathToUrl(fp)));
        }
      }
      return paths.filter(Boolean);
    }

    // Legacy: single file
    let paths = [];
    if (soundData.soundSelect === 'filepicker_single') {
      const src = soundData.source;
      if (!src) return [];
      const exists = await window.api.fs.exists(src);
      if (!exists) {
        const newPath = await this._promptRelink(src);
        if (!newPath) return [];
        soundData.source = newPath;
        paths = [newPath];
      } else {
        paths = [src];
      }
    } else if (soundData.soundSelect === 'filepicker_folder') {
      const src = soundData.source;
      if (!src) return [];
      paths = await window.api.fs.readFolder(src);
      if (paths.length === 0) {
        const newFolder = await this._promptRelinkFolder(src);
        if (newFolder) {
          soundData.source = newFolder;
          paths = await window.api.fs.readFolder(newFolder);
        }
      }
    }

    const valid = paths.map(pathToUrl).filter(Boolean);
    return this.settings.randomize ? this._shuffle(valid) : valid;
  }

  async _promptRelink(originalPath) {
    if (!await showConfirm(`File not found:\n${originalPath}\n\nWould you like to locate it?`)) return null;
    const paths = await window.api.fs.openDialog({});
    return paths?.[0] ?? null;
  }

  async _promptRelinkFolder(originalPath) {
    if (!await showConfirm(`Folder not found:\n${originalPath}\n\nWould you like to locate it?`)) return null;
    const paths = await window.api.fs.openDialog({ folder: true });
    return paths?.[0] ?? null;
  }

  _shuffle(array) {
    const a = [...array];
    for (let i = a.length - 1; i >= 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ─── Playback ────────────────────────────────────────────────────────────────

  play(currentTime = undefined, fadeInMs = 0) {
    if (!this.loaded || (this.playing && !this.paused && this.channelNr < 100)) return;

    if (!this.audioElement) {
      if (!this.sourceArray?.length) return;
      this.setSource(this.sourceArray[this.currentlyPlaying], false, true);
      return;
    }

    if (this.channelNr >= 100) {
      this._applyPlaybackRate(this.settings.playbackRate ?? { rate: 1, preservePitch: 1, random: 0 });
      this.randomizeVolume();
      const btn = document.getElementById(`sbButton-${this.channelNr - 100}`);
      if (btn) {
        const rpt = this.settings.repeat?.repeat ?? this.settings.repeat ?? 'none';
        btn.style.borderColor = (rpt === 'single' || rpt === 'all') ? 'green' : '';
        btn.style.boxShadow   = (rpt === 'single' || rpt === 'all') ? '0 0 10px green' : '';
      }
    } else {
      this._applyPlaybackRate(this.settings.playbackRate);
    }

    let timing = this.settings.timing ?? { startTime: 0, stopTime: 0, skipFirstTiming: false, fadeIn: 0, fadeOut: 0, skipFirstFade: false };

    if (!this.paused && (!timing.skipFirstTiming || !this.firstLoop)) {
      this.audioElement.currentTime = timing.startTime ?? 0;
    }
    if (timing.fadeIn > 0 && (!timing.skipFirstFade || !this.firstLoop)) {
      if (!this.fadeStarted) this.fade(0, this.settings.volume, timing.fadeIn);
    }
    this.firstLoop = false;

    if (currentTime !== undefined) this.audioElement.currentTime = currentTime;
    if (this.context.state !== 'running') return;

    this.audioElement.play().catch(() => {});
    this.playing = true;
    this.paused  = false;

    // Quick fade-in — skip when timing.fadeIn already handles it
    if (fadeInMs > 0 && (timing.fadeIn ?? 0) <= 0) {
      this.audioElement.volume = 0;
      this._fadeAudioElement(0, 1, fadeInMs);
    }

    const playBtn = document.getElementById(`playSound-${this.channelNr}`);
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-stop"></i>';
  }

  pause() {
    if (!this.audioElement || this.paused || !this.playing) return;
    this.audioElement.pause();
    this.paused = true;
  }

  stop(advanceNext = true) {
    this.firstLoop = true;
    if (!this.audioElement || (!this.playing && !this.paused)) return;

    this.audioElement.pause();
    this.audioElement.currentTime = 0;
    this.playing = false;
    this.paused  = false;

    if (advanceNext) this.next();

    if (this.channelNr >= 100) {
      const btn = document.getElementById(`sbButton-${this.channelNr - 100}`);
      if (btn) {
        const rpt = this.settings.repeat?.repeat ?? this.settings.repeat ?? 'none';
        const isLoop = rpt === 'single' || rpt === 'all';
        btn.style.borderColor = isLoop ? 'yellow' : '';
        btn.style.boxShadow   = isLoop ? '0 0 10px yellow' : '';
      }
    }

    const playBtn = document.getElementById(`playSound-${this.channelNr}`);
    if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
  }

  next(playNr = undefined) {
    if (!this.sourceArray?.length) return;
    if (playNr !== undefined) {
      this.currentlyPlaying = playNr;
    } else {
      this.currentlyPlaying++;
      if (this.currentlyPlaying > this.sourceArray.length - 1) this.currentlyPlaying = 0;
    }
    this.setSource(this.sourceArray[this.currentlyPlaying]);
  }

  previous() {
    if (!this.sourceArray?.length) return;
    this.currentlyPlaying--;
    if (this.currentlyPlaying < 0) this.currentlyPlaying = this.sourceArray.length - 1;
    this.setSource(this.sourceArray[this.currentlyPlaying]);
  }

  restart() {
    if (this.audioElement) this.audioElement.currentTime = 0;
  }

  // ─── Source / Audio graph ────────────────────────────────────────────────────

  async setSource(source, stopFirst = false, forcePlay = false) {
    if (!source) return;
    const wasPlaying = this.playing;
    if (this.playing) this.stop(false);

    if (this.node) { try { this.node.disconnect(); } catch {} }

    this.soundData.source = source;
    this.source = source;

    const url = source.startsWith('file://') ? source : pathToUrl(source);

    this.audioElement = document.createElement('audio');
    this.audioElement.crossOrigin = 'anonymous';
    this.audioElement.src = url;
    this.audioElement.volume = 1;

    this.node = this.context.createMediaElementSource(this.audioElement);
    this.configureConnections();
    this.loaded = true;

    if ((wasPlaying && !stopFirst) || forcePlay) this.play();

    this.audioElement.addEventListener('loadeddata', () => {
      this.duration = this.audioElement.duration;
    });
    this.audioElement.addEventListener('timeupdate', () => this._onTimeUpdate());
  }

  _onTimeUpdate() {
    if (this.context.state !== 'running' || !this.audioElement) return;

    let timing = this.settings.timing;
    if (!timing) timing = { startTime: 0, stopTime: 0, fadeIn: 0, fadeOut: 0 };

    let repeat = this.settings.repeat;
    if (!repeat || typeof repeat === 'string') repeat = { repeat: repeat ?? 'none', minDelay: 0, maxDelay: 0 };
    if (repeat.minDelay == null) repeat.minDelay = 0;
    if (repeat.maxDelay == null) repeat.maxDelay = 0;

    let delayTime = repeat.minDelay;
    if (repeat.maxDelay > repeat.minDelay) {
      delayTime = Math.random() * (repeat.maxDelay - repeat.minDelay) * 1000;
    }

    if (this.playing && this.audioElement.paused) {
      if (repeat.repeat === 'none') {
        this.stop();
      } else if (repeat.repeat === 'single') {
        this.randomizeVolume();
        setTimeout(() => {
          if (!this.audioElement) return;
          this.audioElement.currentTime = timing.startTime ?? 0;
          if (this.playing) this.audioElement.play().catch(() => {});
        }, delayTime);
      } else if (repeat.repeat === 'all') {
        this.randomizeVolume();
        setTimeout(() => {
          // Soundboard channels respect the sequential/random playlist setting
          if (this.channelNr >= 100) {
            const sequential = this.settings?.soundData?.sequential ?? false;
            if (!sequential && this.sourceArray?.length > 0) {
              this.next(Math.floor(Math.random() * this.sourceArray.length));
            } else {
              this.next();
            }
          } else {
            this.next();
          }
        }, delayTime);
      }
    }

    if (timing.stopTime > 0 && this.audioElement.currentTime >= timing.stopTime && !this.fadeStarted) {
      if (repeat.repeat === 'none') {
        this.stop();
      } else if (repeat.repeat === 'single') {
        if (timing.fadeIn > 0) this.fade(0, this.settings.volume, timing.fadeIn);
        this.audioElement.currentTime = timing.startTime ?? 0;
      } else if (repeat.repeat === 'all') {
        this.next();
      }
    }

    if (timing.fadeOut > 0 && timing.stopTime > 0 &&
        this.audioElement.currentTime + timing.fadeOut >= timing.stopTime && !this.fadeStarted) {
      this.fade(this.settings.volume, 0, timing.fadeOut);
    }
  }

  configureConnections() {
    if (!this.node) return;
    try { this.node.disconnect(); } catch {}

    if (this.channelNr >= 100) {
      const sbMasterGain = this.mixer.master.effects.gain.node;
      const ifaceGain    = this.mixer.mixer.master.effects.interfaceGain.node;
      this.node
        .connect(this.effects.gain.node)
        .connect(sbMasterGain)
        .connect(ifaceGain)
        .connect(this.context.destination);
    } else {
      const masterGain = this.mixer.master.effects.gain.node;
      const ifaceGain  = this.mixer.master.effects.interfaceGain.node;
      this.node
        .connect(this.effects.gain.node)
        .connect(this.effects.eq.gain)
        .connect(this.effects.pan.node)
        .connect(masterGain)
        .connect(ifaceGain)
        .connect(this.context.destination);
    }
  }

  // ─── Controls ────────────────────────────────────────────────────────────────

  setVolume(volume = this.settings.volume, save = true, solo = false) {
    if (volume == null) volume = this.settings.volume;
    if (volume > 1.25) volume = 1.25;
    if (volume < 0)    volume = 0;
    if (save && !solo) this.settings.volume = volume;
    const actual = this.settings.mute ? 0 : volume;
    if (this.effects.gain) this.effects.gain.set(actual);
  }

  setMute(mute) {
    this.settings.mute = mute;
    if (this.effects.gain) this.effects.gain.set(mute ? 0 : this.settings.volume);
  }

  getMute()  { return this.settings.mute;  }
  setSolo(s) { this.settings.solo = s;     }
  getSolo()  { return this.settings.solo;  }
  setLink(l) { this.settings.link = l;     }
  getLink()  { return this.settings.link;  }

  setPan(pan) {
    this.settings.pan = pan;
    if (this.effects.pan) this.effects.pan.set(pan);
  }

  setPlaybackRate(pbr = this.settings.playbackRate) {
    this._applyPlaybackRate(pbr);
  }

  _applyPlaybackRate(pbr) {
    if (!this.audioElement || !pbr) return;
    let rate = pbr.rate ?? 1;
    if (pbr.random && pbr.random !== 0) {
      rate += (Math.random() - 0.5) * pbr.random;
    }
    rate = Math.max(0.25, Math.min(4, rate));
    if (pbr === this.settings.playbackRate) this.settings.playbackRate = { ...pbr, rate };
    this.audioElement.playbackRate  = rate;
    this.audioElement.preservesPitch = !!pbr.preservePitch;
  }

  /** Linearly fade an audio element's volume from `from` to `to` over `ms` ms. Returns a Promise.
   *  Uses `this.audioElement` when `el` is omitted.
   *  Pass an `abortToken` object `{ cancelled: false }` to allow early cancellation. */
  _fadeAudioElement(from, to, ms, el = null, abortToken = null) {
    const target = el ?? this.audioElement;
    return new Promise(resolve => {
      if (!target || ms <= 0) {
        if (target) target.volume = Math.max(0, Math.min(1, to));
        resolve();
        return;
      }
      const steps = Math.max(1, Math.round(ms / 20));
      const stepSize = (to - from) / steps;
      let volume = from;
      let counter = 0;
      target.volume = Math.max(0, Math.min(1, from));
      const interval = setInterval(() => {
        if (abortToken?.cancelled) {
          clearInterval(interval);
          resolve();
          return;
        }
        volume += stepSize;
        counter++;
        target.volume = Math.max(0, Math.min(1, volume));
        if (counter >= steps) {
          target.volume = Math.max(0, Math.min(1, to));
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });
  }

  /**
   * Crossfade to a track by index: fade out the current element while fading in the new one
   * simultaneously.
   *
   * If called while a crossfade is already in progress, the running fades are immediately
   * aborted, all intermediate audio elements are force-stopped, and the new track starts
   * without any fade-in.
   */
  async _crossfadeTo(newIdx, fadeMs) {
    const newSource = this.sourceArray[newIdx];
    if (!newSource) return;

    // ── Interrupt path: a crossfade is already running ──────────────────────────
    if (this._crossfading) {
      // Cancel the running fade intervals immediately
      if (this._crossfadeAbortToken) this._crossfadeAbortToken.cancelled = true;

      // Force-stop all elements that were part of the in-progress crossfade
      for (const { el, node } of this._crossfadeOrphans) {
        try { el.pause(); }       catch {}
        try { node?.disconnect(); } catch {}
      }
      this._crossfadeOrphans = [];
      this._crossfading      = false;

      // Start the new track immediately, no fade
      this.currentlyPlaying = newIdx;
      await this.setSource(newSource, false, true);
      return;
    }

    // ── Normal crossfade path ────────────────────────────────────────────────────
    this._crossfading = true;
    const abortToken  = { cancelled: false };
    this._crossfadeAbortToken = abortToken;

    const outgoingEl   = this.audioElement;
    const outgoingNode = this.node;

    this.currentlyPlaying = newIdx;
    this.source           = newSource;
    this.soundData.source = newSource;

    const url = newSource.startsWith('file://') ? newSource : pathToUrl(newSource);

    const newEl = document.createElement('audio');
    newEl.crossOrigin = 'anonymous';
    newEl.src    = url;
    newEl.volume = 0;

    if (this.settings.playbackRate) {
      const pbr = this.settings.playbackRate;
      newEl.playbackRate   = Math.max(0.25, Math.min(4, pbr.rate ?? 1));
      newEl.preservesPitch = !!pbr.preservePitch;
    }

    const timing = this.settings.timing ?? {};
    newEl.currentTime = timing.startTime ?? 0;

    const newNode = this.context.createMediaElementSource(newEl);
    newNode.connect(this.effects.gain.node);

    // Track both elements so an interrupt can clean them up
    this._crossfadeOrphans = [
      { el: outgoingEl, node: outgoingNode },
      { el: newEl,      node: newNode      },
    ];

    if (this.context.state === 'running') newEl.play().catch(() => {});

    await Promise.all([
      outgoingEl
        ? this._fadeAudioElement(outgoingEl.volume, 0, fadeMs, outgoingEl, abortToken)
        : Promise.resolve(),
      this._fadeAudioElement(0, 1, fadeMs, newEl, abortToken),
    ]);

    // If the crossfade was interrupted mid-fade, bail out — the interrupt handler
    // already cleaned up orphans and started the next track.
    if (abortToken.cancelled) return;

    if (outgoingEl) outgoingEl.pause();
    try { outgoingNode?.disconnect(); } catch {}

    this.audioElement = newEl;
    this.node         = newNode;
    this.loaded       = true;
    this.firstLoop    = false;

    newEl.addEventListener('loadeddata', () => { this.duration = newEl.duration; });
    newEl.addEventListener('timeupdate', () => this._onTimeUpdate());

    this._crossfading         = false;
    this._crossfadeAbortToken = null;
    this._crossfadeOrphans    = [];
  }

  /** Fade out audio then stop. Resolves after stop() is called. */
  async fadeOutAndStop(ms, advanceNext = true) {
    if (!this.audioElement || !this.playing) {
      this.stop(advanceNext);
      return;
    }
    await this._fadeAudioElement(this.audioElement.volume, 0, ms);
    this.stop(advanceNext);
    // Restore volume for next play() (setSource also resets it, this covers the no-advance case)
    if (this.audioElement) this.audioElement.volume = 1;
  }

  /** Mute/unmute with a smooth gain ramp over `ms` ms. */
  setMuteFade(mute, ms) {
    this.settings.mute = mute;
    const target = mute ? 0 : (this.settings.volume ?? 1);
    if (ms > 0 && this.effects.gain) {
      this.effects.gain.ramp(target, ms / 1000);
    } else {
      if (this.effects.gain) this.effects.gain.set(target);
    }
  }

  fade(start, end, time) {
    if (!this.audioElement || time <= 0) return;
    this.fadeStarted = true;
    const stepSize = (end - start) / (time * 50);
    let volume = start;
    let counter = 0;
    this.audioElement.volume = Math.max(0, Math.min(1, start));

    const interval = setInterval(() => {
      volume += stepSize;
      counter++;
      this.audioElement.volume = Math.max(0, Math.min(1, volume));
      if (counter >= time * 50 - 1) {
        this.audioElement.volume = Math.max(0, Math.min(1, end));
        this.fadeStarted = false;
        clearInterval(interval);
      }
    }, 20);
  }

  randomizeVolume() {
    let volume = this.settings.volume;
    const rv = this.settings.randomizeVolume ?? 0;
    if (rv > 0) {
      volume += (Math.random() - 0.5) * rv;
      volume = Math.max(0, Math.min(1.25, volume));
    }
    if (this.effects.gain) this.effects.gain.set(volume);
  }
}
