/**
 * soundboard.js — ported from Foundry Soundscape module.
 * Removed: game.socket, Hooks, game.settings, game.userId, activeUser
 */
import { Channel  } from './channel.js';
import { Storage  } from './storage.js';
import { makeEmptySoundboardButton, SOUNDBOARD_SIZE } from './templates.js';

export class Soundboard {
  soundboardSize = SOUNDBOARD_SIZE;
  channels = [];
  volume = 1;

  constructor(mixer) {
    this.mixer    = mixer;
    this.audioCtx = mixer.audioCtx;
    this.master   = new Channel(this, 'master');
    this._layered = []; // active one-shot instances (interrupt: false)
    for (let i = 0; i < this.soundboardSize; i++) {
      this.channels.push(new Channel(this, 100 + i));
    }
  }

  configure(settings) {
    this.stopAll();
    this._applyMasterGain(settings.soundboardGain ?? 0.75);
    for (let i = 0; i < this.soundboardSize; i++) {
      const ch = settings.soundboard[i];
      if (ch) this.channels[i].setSbData(ch);
    }
  }

  /** Set soundboard master gain directly, bypassing Channel's 1.25 clamp. */
  _applyMasterGain(gain) {
    gain = Math.max(0, gain);
    this.master.settings.volume = gain;
    if (this.master.effects.gain) this.master.effects.gain.set(gain);
  }

  configureSingle(channelNr, settings) {
    this.channels[channelNr].setSbData(settings);
  }

  playSound(soundboardNr) {
    const ch = this.channels[soundboardNr];

    // Layered mode: spawn independent one-shot instances
    if (ch.settings?.interrupt === false) {
      this._playSoundLayered(ch);
      return;
    }

    // Default (interrupt) mode: a press while playing stops the sound
    if (ch.playing) { ch.stop(); return; }

    const sequential = ch.settings?.soundData?.sequential ?? false;
    if (!sequential && ch.sourceArray?.length > 0) {
      ch.next(Math.floor(Math.random() * ch.sourceArray.length));
    } else {
      ch.next();
    }
    ch.play();
  }

  /** Play a one-shot copy that layers on top of anything already playing. */
  _playSoundLayered(ch) {
    if (!ch.sourceArray?.length) return;

    // Pick URL: random by default, sequential if flag set
    const sequential = ch.settings?.soundData?.sequential ?? false;
    let url;
    if (sequential) {
      url = ch.sourceArray[ch.currentlyPlaying];
      ch.currentlyPlaying = (ch.currentlyPlaying + 1) % ch.sourceArray.length;
    } else {
      url = ch.sourceArray[Math.floor(Math.random() * ch.sourceArray.length)];
    }

    if (!url) return;

    // Build a fresh audio element + gain node
    const audioEl = document.createElement('audio');
    audioEl.src   = url;
    audioEl.volume = 1;

    // Playback rate
    const pbr  = ch.settings.playbackRate ?? { rate: 1, preservePitch: 1, random: 0 };
    let rate   = pbr.rate ?? 1;
    if (pbr.random) rate += (Math.random() - 0.5) * pbr.random;
    audioEl.playbackRate   = Math.max(0.25, Math.min(4, rate));
    audioEl.preservesPitch = !!pbr.preservePitch;

    // Volume with optional randomization
    let vol = ch.settings.volume ?? 1;
    const rv = ch.settings.randomizeVolume ?? 0;
    if (rv > 0) vol += (Math.random() - 0.5) * rv;
    vol = Math.max(0, Math.min(1.25, vol));

    const gainNode = this.audioCtx.createGain();
    gainNode.gain.value = vol;

    const node = this.audioCtx.createMediaElementSource(audioEl);
    node
      .connect(gainNode)
      .connect(this.master.effects.gain.node)
      .connect(this.mixer.master.effects.interfaceGain.node)
      .connect(this.audioCtx.destination);

    audioEl.play().catch(() => {});

    // Track so stopAll() can reach it
    this._layered.push(audioEl);

    // Cleanup when done
    audioEl.addEventListener('ended', () => {
      try { node.disconnect(); }     catch {}
      try { gainNode.disconnect(); } catch {}
      const idx = this._layered.indexOf(audioEl);
      if (idx !== -1) this._layered.splice(idx, 1);
    });
  }

  stopAll() {
    for (let i = 0; i < this.soundboardSize; i++) {
      this.channels[i].stop();
    }
    // Stop all layered (interrupt: false) instances
    for (const audioEl of this._layered) {
      try { audioEl.pause(); audioEl.currentTime = 0; } catch {}
    }
    this._layered = [];
  }

  async setVolume(volume) {
    this.volume = volume;
    this._applyMasterGain(volume);
    // Persist
    const soundscapes = await Storage.getSoundscapes();
    soundscapes[this.mixer.currentSoundscape].soundboardGain = volume;
    await Storage.setSoundscapes(soundscapes);
  }

  async swapSounds(sourceId, targetId) {
    const soundscapes = await Storage.getSoundscapes();
    const sb = soundscapes[this.mixer.currentSoundscape].soundboard;
    [sb[sourceId], sb[targetId]] = [sb[targetId], sb[sourceId]];
    this.configureSingle(sourceId, sb[sourceId]);
    this.configureSingle(targetId, sb[targetId]);
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  async copySounds(sourceId, targetId) {
    const soundscapes = await Storage.getSoundscapes();
    const sb = soundscapes[this.mixer.currentSoundscape].soundboard;
    sb[targetId] = structuredClone(sb[sourceId]);
    this.configureSingle(targetId, sb[targetId]);
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  async deleteSound(sourceId) {
    const soundscapes = await Storage.getSoundscapes();
    const blank = this.newChannel(sourceId);
    soundscapes[this.mixer.currentSoundscape].soundboard[sourceId] = blank;
    this.configureSingle(sourceId, blank);
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  async newData(targetId, data) {
    const soundscapes = await Storage.getSoundscapes();
    let ch = soundscapes[this.mixer.currentSoundscape].soundboard[targetId];
    if (!ch) ch = this.newChannel(targetId);

    if (data.type === 'playlist') {
      ch.soundData = { playlist: data.playlist, shuffle: false };
      if (!ch.name && data.name) ch.name = data.name;
    } else if (data.type === 'image') {
      ch.imageSrc = data.source;
    } else if (data.type === 'filepicker_single' || data.type === 'filepicker_folder') {
      ch.soundData.source = data.source;
      if (!ch.name) ch.name = data.name ?? '';
      ch.soundData.soundSelect = data.type;
    }

    soundscapes[this.mixer.currentSoundscape].soundboard[targetId] = ch;
    this.configureSingle(targetId, ch);
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  newChannel(channelNr) {
    return makeEmptySoundboardButton(parseInt(channelNr));
  }
}
