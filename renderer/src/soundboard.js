/**
 * soundboard.js — ported from Foundry Soundscape module.
 * Removed: game.socket, Hooks, game.settings, game.userId, activeUser
 */
import { Channel  } from './channel.js';
import { Storage  } from './storage.js';
import { makeEmptySoundboardButton, SOUNDBOARD_SIZE } from './templates.js';
import { FADE_STOP_MS, fadeGainNode } from './audioFade.js';
import { resolveSoundboardArray } from './sbGrid.js';
import { pathToUrl } from './pathUtils.js';

/** Extract a display name from a playlist item label. Mirrors mixer.js's own _nameFromLabel — folder items have labels like "/FolderName/file.mp3", use the folder name. */
function _nameFromLabel(label) {
  if (!label) return '';
  if (label.startsWith('/')) return label.split('/')[1] ?? '';
  return label.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

/**
 * Pushes a live-refresh signal to any open SoundboardConfigDialog/
 * PlaylistDialog window for one button — mirrors mixer.js's own
 * _notifyChannelSourcesChanged(), see its doc for the accurate-count
 * caveat. Safe to call unconditionally: childWindow.push() is a no-op when
 * the target window isn't open. Exported for mixer.js's clearSoundboardButton()
 * to reuse, rather than hand-copying the key-construction logic there.
 */
export function notifySbSourcesChanged(sceneId, targetId, count) {
  const configKey   = sceneId === null ? `soundboardConfig:${targetId}` : `soundboardConfig:scene:${sceneId}:${targetId}`;
  const playlistKey = sceneId === null ? `playlist:sb:${targetId}`      : `playlist:sbScene:${sceneId}:${targetId}`;
  window.api.childWindow?.push?.(configKey, { kind: 'sourcesChanged', count });
  window.api.childWindow?.push?.(playlistKey, { kind: 'sourcesChanged' });
}

export class Soundboard {
  soundboardSize = SOUNDBOARD_SIZE;
  channels = [];
  volume = 1;
  currentSbScene = 0; // index of the soundboard scene currently shown in the grid — only meaningful for the active (sceneId === null) instance

  /**
   * @param {Mixer} mixer
   * @param {string|null} sceneId — null (default): this is the "active"
   *   instance, reading/writing soundscapes[currentSoundscape].soundboard,
   *   exactly as before this parameter existed. A non-null sceneId binds
   *   this instance to one specific, guaranteed-non-active scene (the
   *   active scene can't be detached), read/written via
   *   resolveSoundboardArray() instead — see that function's own comment.
   */
  constructor(mixer, sceneId = null) {
    this.mixer    = mixer;
    this.sceneId  = sceneId;
    this.audioCtx = mixer.audioCtx;
    this.master   = new Channel(this, 'master');
    this._layered = []; // active one-shot instances (interrupt: false)
    for (let i = 0; i < this.soundboardSize; i++) {
      this.channels.push(new Channel(this, 100 + i));
    }
  }

  /**
   * @param {{keepPlaying?: boolean}} [opts] — when true (soundboard-scene
   *   switch/removal), a button that's currently playing is left alone
   *   instead of being stopped; the new scene's data is deferred and applied
   *   once that button's playback naturally ends (see Channel.stop()).
   */
  configure(settings, { keepPlaying = false } = {}) {
    if (!keepPlaying) this.stopAll();
    const sb = resolveSoundboardArray(settings, this.sceneId);
    if (!sb) return;
    if (this.sceneId === null) {
      this.currentSbScene = settings.currentSbScene ?? 0;
    }
    const gain = this.mixer.globalVolumes?.soundboard ?? settings.soundboardGain ?? 0.75;
    this._applyMasterGain(gain);
    for (let i = 0; i < this.soundboardSize; i++) {
      const ch = sb[i];
      if (!ch) continue;
      const btnCh = this.channels[i];
      if (keepPlaying && btnCh.playing) {
        btnCh._pendingSbData = ch;
        btnCh._sceneSwitchPending = true;
      } else {
        // A scene switch may still have this slot deferred (waiting for its
        // sound to finish naturally) from an earlier keepPlaying:true pass.
        // ch below is the authoritative data for this call — clear the stale
        // pending state first, or setSbData()'s internal stop(false) would
        // resurrect it and race the load we're about to start.
        btnCh._sceneSwitchPending = false;
        btnCh._pendingSbData = null;
        btnCh.setSbData(ch);
      }
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
    if (!ch) return;

    // Layered mode: spawn independent one-shot instances
    if (ch.settings?.interrupt === false) {
      this._playSoundLayered(ch);
      return;
    }

    // Default (interrupt) mode: a press while playing stops the sound
    if (ch.playing) { ch.fadeOutAndStop(FADE_STOP_MS); return; }

    const sequential = ch.settings?.soundData?.sequential ?? false;
    if (!sequential && ch.sourceArray?.length > 0) {
      ch.next(Math.floor(Math.random() * ch.sourceArray.length));
    } else {
      ch.next();
    }
    // Looped ("Зациклено") buttons fade in on their initial press, mirroring
    // the fade-out already applied on stop — half its duration.
    const rpt = ch.settings?.repeat?.repeat ?? ch.settings?.repeat ?? 'none';
    ch.play(undefined, rpt === 'single' ? FADE_STOP_MS / 2 : 0);
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
    const layered = { audioEl, gainNode, node };
    this._layered.push(layered);

    // Cleanup when done
    audioEl.addEventListener('ended', () => {
      try { node.disconnect(); }     catch {}
      try { gainNode.disconnect(); } catch {}
      const idx = this._layered.indexOf(layered);
      if (idx !== -1) this._layered.splice(idx, 1);
    });
  }

  stopAll() {
    for (let i = 0; i < this.soundboardSize; i++) {
      this.channels[i].fadeOutAndStop(FADE_STOP_MS);
    }
    // Fade out and stop all layered (interrupt: false) instances
    const layered = this._layered;
    this._layered = [];
    for (const { audioEl, gainNode, node } of layered) {
      fadeGainNode(gainNode, 0, FADE_STOP_MS, this.audioCtx);
      setTimeout(() => {
        try { audioEl.pause(); audioEl.currentTime = 0; } catch {}
        try { node.disconnect(); }     catch {}
        try { gainNode.disconnect(); } catch {}
      }, FADE_STOP_MS + 50);
    }
  }

  async setVolume(volume) {
    this.volume = volume;
    this._applyMasterGain(volume);
    await this.mixer.setGlobalSoundboardVolume(volume);
  }

  async swapSounds(sourceId, targetId) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const sb = resolveSoundboardArray(ss, this.sceneId);
    if (!sb) return;
    [sb[sourceId], sb[targetId]] = [sb[targetId], sb[sourceId]];
    this.configureSingle(sourceId, sb[sourceId]);
    this.configureSingle(targetId, sb[targetId]);
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  async copySounds(sourceId, targetId) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const sb = resolveSoundboardArray(ss, this.sceneId);
    if (!sb) return;
    sb[targetId] = structuredClone(sb[sourceId]);
    this.configureSingle(targetId, sb[targetId]);
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  async deleteSound(sourceId) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const sb = resolveSoundboardArray(ss, this.sceneId);
    if (!sb) return;
    const blank = this.newChannel(sourceId);
    sb[sourceId] = blank;
    this.configureSingle(sourceId, blank);
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  async newData(targetId, data) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const sb = resolveSoundboardArray(ss, this.sceneId);
    if (!sb) return;
    let ch = sb[targetId];
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

    sb[targetId] = ch;
    if (data.type === 'image') {
      // setSbData() unconditionally stops playback before reloading — dropping
      // an image (which only touches imageSrc, not the sound) onto a
      // currently-playing button would silently stop it and never resume.
      this.channels[targetId].settings.imageSrc = ch.imageSrc;
    } else {
      this.configureSingle(targetId, ch);
    }
    await Storage.setSoundscapes(soundscapes);
    this.mixer.renderUI();
  }

  newChannel(channelNr) {
    return makeEmptySoundboardButton(parseInt(channelNr));
  }

  /**
   * Apply a dropped set of playlist items to one soundboard button, honoring
   * the user's global overwrite/next/append drop-behavior setting
   * (Storage.getDropBehavior().sb) — mirrors
   * Mixer.applyChannelPlaylistDrop()/applyAmbientPlaylistDrop(). Shared by
   * the active grid's own drop handler (mixerUI.js) and a detached scene's
   * window (soundboardScene-entry.js, via the same {kind:'call'} bridge
   * onSoundboardSceneDetached() already wires to `this`) — this.sceneId
   * (set at construction) already resolves the right button array/live
   * channel for either case via resolveSoundboardArray()/this.channels, so
   * no cross-window state needs to be read to merge correctly.
   */
  async applyPlaylistDrop(targetId, newItems) {
    if (!newItems.length) return;
    const behavior = (await Storage.getDropBehavior()).sb ?? 'overwrite';
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    const sb = resolveSoundboardArray(ss, this.sceneId);
    if (!sb) return;

    const chData = sb[targetId] ?? this.newChannel(targetId);
    const existing = Array.isArray(chData.soundData?.playlist) ? chData.soundData.playlist : [];
    // See Mixer.applyChannelPlaylistDrop()'s matching comment: an empty
    // explicit playlist doesn't mean "nothing here" when folder links are
    // set (Channel.getSounds() resolves them at load time) — only a true
    // 'overwrite' should treat that as a clean slate.
    const hasFolderLinks = Array.isArray(chData.soundData?.folderLinks) && chData.soundData.folderLinks.length > 0;

    if (behavior === 'overwrite' || (!existing.length && !hasFolderLinks)) {
      const name = _nameFromLabel(newItems[0]?.label);
      chData.soundData = { playlist: newItems, shuffle: false };
      if (!chData.name && name) chData.name = name;
      sb[targetId] = chData;
      await Storage.setSoundscapes(soundscapes);
      this.configureSingle(targetId, chData);
      if (this.sceneId !== null) {
        window.api.childWindow?.push?.(`soundboardScene:${this.sceneId}`, { kind: 'nameChanged', index: targetId, name: chData.name });
      }
      // This branch's soundData is always a fresh {playlist, shuffle}
      // object with no folderLinks, so newItems.length is already the
      // accurate combined count — no need to wait on the unawaited
      // configureSingle()/setSbData() call above to resolve anything.
      notifySbSourcesChanged(this.sceneId, targetId, newItems.length);
      this.mixer.renderUI();
      return;
    }

    const ch = this.channels[targetId];
    const insertIdx = ch?.currentlyPlaying ?? 0;
    const merged = behavior === 'next'
      ? [...existing.slice(0, insertIdx + 1), ...newItems, ...existing.slice(insertIdx + 1)]
      : [...existing, ...newItems];

    chData.soundData = { ...chData.soundData, playlist: merged };
    sb[targetId] = chData;
    await Storage.setSoundscapes(soundscapes);

    // Only extends the live channel's queue — nothing about the button's
    // visible name/image/play-state changes, so (unlike the branch above)
    // there is nothing to push to a detached window here.
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
      // ch.sourceArray was just spliced synchronously above, so its length
      // is already the accurate combined count.
      notifySbSourcesChanged(this.sceneId, targetId, ch.sourceArray.length);
    }
    this.mixer.renderUI();
  }
}
