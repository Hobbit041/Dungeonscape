/**
 * webBridge.js — bridges the Mixer to the browser remote-control client.
 *
 * Flow:
 *   main.js WS client → ipcMain → 'web-command' → renderer → _dispatch()
 *   Mixer state change → push() → 'web-broadcast' → ipcMain → WS client
 */
import { Storage     } from './storage.js';
import { AMBIENT_SIZE } from './ambientMixer.js';
import { FADE_MS, FADE_STOP_MS } from './audioFade.js';

const DEBOUNCE_MS  = 50;    // max broadcast frequency

export class WebBridge {
  constructor() {
    this._mixer = null;
    this._timer = null;
  }

  /** Call once after Mixer and MixerUI are initialised. */
  init(mixer) {
    this._mixer = mixer;
    window.api.web.onCommand(cmd => this._dispatch(cmd));
    window.api.web.onRequestState(() => this.push());
  }

  /** Schedule a state broadcast (debounced). */
  push() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._doPush(), DEBOUNCE_MS);
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  async _doPush() {
    if (!this._mixer) return;
    try {
      const state = await this._buildState(this._mixer);
      await window.api.web.broadcast(state);
    } catch { /* swallow — server may not be running */ }
  }

  async _buildState(mixer) {
    // Storage is only needed for structural data (names of scenes/soundscapes,
    // soundboard button metadata). Runtime values (volumes, mute, playing…)
    // are read from in-memory objects so they are always current.
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[mixer.currentSoundscape] ?? {};

    return {
      soundscapes:       soundscapes.map(s => ({ name: s.name ?? '' })),
      currentSoundscape: mixer.currentSoundscape,
      scenes:            (ss.scenes  ?? []).map(s => ({ name: s.name ?? '' })),
      currentScene:      ss.currentScene  ?? 0,
      sbScenes:          (ss.sbScenes ?? []).map(s => ({ name: s.name ?? '' })),
      currentSbScene:    ss.currentSbScene ?? 0,

      mixer: {
        playing: mixer.playing,
        master: {
          volume: mixer.master.settings?.volume ?? 1,
          mute:   mixer.master.getMute?.()      ?? false,
        },
        channels: mixer.channels.map((ch) => ({
          name:    ch.settings.name   ?? '',
          volume:  ch.settings.volume ?? 1,
          pan:     ch.settings.pan    ?? 0,
          mute:    ch.getMute?.()     ?? ch.settings.mute ?? false,
          solo:    ch.getSolo?.()     ?? ch.settings.solo ?? false,
          link:    ch.getLink?.()     ?? ch.settings.link ?? false,
          playing: ch.playing,
        })),
      },

      soundboard: {
        // soundboard master gain is stored in soundboard.master.settings.volume
        gain: mixer.soundboard?.master?.settings?.volume ?? 0.75,
        grid: await Storage.getSbGridSize(),
        buttons: (ss.soundboard ?? []).map((d, i) => ({
          name:     d.name     ?? '',
          imageSrc: d.imageSrc ?? '',
          playing:  mixer.soundboard?.channels[i]?.playing ?? false,
        })),
      },

      ambient: {
        masterVolume: ss.ambientMaster?.volume ?? 1,
        channels: Array.from({ length: AMBIENT_SIZE }, (_, i) => {
          const ch = mixer.ambientMixer?.channels[i];
          return {
            name:    ch?.settings?.name   ?? '',
            volume:  ch?.settings?.volume ?? 1,
            playing: ch?.playing          ?? false,
          };
        }),
      },
    };
  }

  // ─── Command dispatcher ──────────────────────────────────────────────────────

  async _dispatch(cmd) {
    const mixer = this._mixer;
    if (!mixer) return;
    try {
      await this._handle(cmd, mixer);
    } catch (err) {
      console.error('[WebBridge] command error', cmd, err);
    }
    this.push();
  }

  async _handle(cmd, mixer) {
    const { type } = cmd;

    // ── Global play/stop ────────────────────────────────────────────────────
    if (type === 'mixer:playAll') {
      mixer.start(undefined, FADE_STOP_MS);
      mixer.ui?.updatePlayState();
      return;
    }
    if (type === 'mixer:stopAll') {
      const playing = mixer.channels.filter(ch => ch.playing);
      if (playing.length) await Promise.all(playing.map(ch => ch.fadeOutAndStop(FADE_STOP_MS)));
      mixer.playing = false;
      mixer.ui?.updatePlayState();
      return;
    }

    // ── Per-channel play/stop ───────────────────────────────────────────────
    if (type === 'mixer:play') {
      mixer.start(cmd.ch, FADE_STOP_MS);
      mixer.ui?.updatePlayState();
      return;
    }
    if (type === 'mixer:stop') {
      const ch = mixer.channels[cmd.ch];
      if (ch?.playing) await ch.fadeOutAndStop(FADE_STOP_MS);
      mixer.playing = mixer.channels.some(c => c.playing);
      mixer.ui?.updatePlayState();
      return;
    }

    // ── Channel volume ──────────────────────────────────────────────────────
    if (type === 'mixer:volume') {
      const ch = mixer.channels[cmd.ch];
      if (!ch) return;
      if (ch.getLink()) {
        await mixer.setLinkVolumes(cmd.v, cmd.ch);
        mixer.ui?._updateLinkedSliders(cmd.ch);
      } else {
        ch.setVolume(cmd.v);
        mixer.ui?.updateChannelVolume(cmd.ch, cmd.v);
      }
      const soundscapes = await Storage.getSoundscapes();
      if (soundscapes[mixer.currentSoundscape]?.channels[cmd.ch]?.settings) {
        soundscapes[mixer.currentSoundscape].channels[cmd.ch].settings.volume = cmd.v;
        await Storage.setSoundscapes(soundscapes);
      }
      return;
    }

    // ── Mute ────────────────────────────────────────────────────────────────
    if (type === 'mixer:mute') {
      const ch = mixer.channels[cmd.ch];
      if (!ch) return;
      const mute = !ch.getMute();
      ch.setMuteFade(mute, FADE_STOP_MS);
      mixer.ui?.updateMute(cmd.ch, mute);
      const soundscapes = await Storage.getSoundscapes();
      if (soundscapes[mixer.currentSoundscape]?.channels[cmd.ch]?.settings) {
        soundscapes[mixer.currentSoundscape].channels[cmd.ch].settings.mute = mute;
        await Storage.setSoundscapes(soundscapes);
      }
      return;
    }

    // ── Solo ────────────────────────────────────────────────────────────────
    if (type === 'mixer:solo') {
      await mixer.toggleSolo(cmd.ch, FADE_STOP_MS);
      return;
    }

    // ── Link ────────────────────────────────────────────────────────────────
    if (type === 'mixer:link') {
      const ch = mixer.channels[cmd.ch];
      if (!ch) return;
      const link = !ch.getLink();
      ch.setLink(link);
      mixer.configureLink();
      mixer.ui?._setLinkColor(`link-${cmd.ch}`, link);
      const soundscapes = await Storage.getSoundscapes();
      if (soundscapes[mixer.currentSoundscape]?.channels[cmd.ch]?.settings) {
        soundscapes[mixer.currentSoundscape].channels[cmd.ch].settings.link = link;
        await Storage.setSoundscapes(soundscapes);
      }
      return;
    }

    // ── Prev / Next ─────────────────────────────────────────────────────────
    if (type === 'mixer:prev') {
      const ch = mixer.channels[cmd.ch];
      if (!ch) return;
      if (ch.playing && ch.sourceArray?.length) {
        const idx = (ch.currentlyPlaying - 1 + ch.sourceArray.length) % ch.sourceArray.length;
        await ch._crossfadeTo(idx, FADE_MS);
      } else {
        ch.previous();
      }
      return;
    }
    if (type === 'mixer:next') {
      const ch = mixer.channels[cmd.ch];
      if (!ch) return;
      if (ch.playing && ch.sourceArray?.length) {
        const idx = (ch.currentlyPlaying + 1) % ch.sourceArray.length;
        await ch._crossfadeTo(idx, FADE_MS);
      } else {
        ch.next();
      }
      return;
    }

    // ── Master ──────────────────────────────────────────────────────────────
    if (type === 'master:volume') {
      mixer.master.setVolume(cmd.v);
      mixer.ui?.updateMasterVolume(cmd.v);
      const soundscapes = await Storage.getSoundscapes();
      if (soundscapes[mixer.currentSoundscape]) {
        soundscapes[mixer.currentSoundscape].master.settings.volume = cmd.v;
        await Storage.setSoundscapes(soundscapes);
      }
      return;
    }
    if (type === 'master:mute') {
      const mute = !mixer.master.getMute();
      mixer.master.setMuteFade(mute, FADE_STOP_MS);
      mixer.ui?._setMuteColor('mute-master', mute);
      const soundscapes = await Storage.getSoundscapes();
      if (soundscapes[mixer.currentSoundscape]) {
        soundscapes[mixer.currentSoundscape].master.settings.mute = mute;
        await Storage.setSoundscapes(soundscapes);
      }
      return;
    }

    // ── Soundboard ──────────────────────────────────────────────────────────
    if (type === 'soundboard:trigger') {
      mixer.soundboard.playSound(cmd.i);
      mixer.ui?.flashSoundboardButton(cmd.i);
      return;
    }
    if (type === 'soundboard:stopAll') {
      mixer.soundboard.stopAll();
      return;
    }
    if (type === 'soundboard:gain') {
      await mixer.soundboard.setVolume(cmd.v);
      mixer.ui?.updateSoundboardVolume(cmd.v);
      return;
    }

    // ── Ambient ─────────────────────────────────────────────────────────────
    if (type === 'ambient:play') {
      const ch = mixer.ambientMixer?.channels[cmd.i];
      if (!ch) return;
      ch.play();
      const el = document.getElementById(`ambPlay-${cmd.i}`);
      if (el) el.innerHTML = '<i class="fas fa-stop"></i>';
      return;
    }
    if (type === 'ambient:stop') {
      const ch = mixer.ambientMixer?.channels[cmd.i];
      if (!ch) return;
      ch.stop();
      const el = document.getElementById(`ambPlay-${cmd.i}`);
      if (el) el.innerHTML = '<i class="fas fa-play"></i>';
      return;
    }
    if (type === 'ambient:volume') {
      const ch = mixer.ambientMixer?.channels[cmd.i];
      if (ch) ch.setVolume(cmd.v);
      mixer.ui?.updateAmbientChannelVolume(cmd.i, cmd.v);
      const soundscapes = await Storage.getSoundscapes();
      const ss = soundscapes[mixer.currentSoundscape];
      if (ss?.ambient?.[cmd.i]) {
        ss.ambient[cmd.i].settings.volume = cmd.v;
        await Storage.setSoundscapes(soundscapes);
      }
      return;
    }
    if (type === 'ambient:masterVolume') {
      mixer.ambientMixer?.setMasterVolume(cmd.v);
      mixer.ui?.updateAmbientMasterVolume(cmd.v);
      const soundscapes = await Storage.getSoundscapes();
      const ss = soundscapes[mixer.currentSoundscape];
      if (ss) {
        if (!ss.ambientMaster) ss.ambientMaster = { volume: 1 };
        ss.ambientMaster.volume = cmd.v;
        await Storage.setSoundscapes(soundscapes);
      }
      return;
    }

    // ── Scenes ──────────────────────────────────────────────────────────────
    if (type === 'scene:switch')   { await mixer.switchScene(cmd.i);           return; }
    if (type === 'sbScene:switch') { await mixer.switchSoundboardScene(cmd.i); return; }
    if (type === 'soundscape:switch') { await mixer.setSoundscape(cmd.i);      return; }
  }
}
