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
import { resolveSoundboardArray } from './sbGrid.js';
import { dispatchChildWindowMessage } from './childWindowHost.js';

const DEBOUNCE_MS  = 50;    // max broadcast frequency
const POLL_MS = 250;   // catch-up poll while a browser is connected, so local
                       // (non-MIDI, non-web, non-settings) UI interactions —
                       // which don't call mixer.onUIUpdate/onControlChange —
                       // still reach the browser within a bounded delay

export class WebBridge {
  constructor() {
    this._mixer = null;
    this._timer = null;
    this._pollTimer = null;
    this._storageQueue = Promise.resolve(); // see _withStorageLock()
  }

  /**
   * Serializes this bridge's own Storage read-modify-write sequences
   * (mixer:mute/mixer:link/master:mute below) against EACH OTHER. Each of
   * those does an unguarded getSoundscapes() → mutate → setSoundscapes();
   * two such sequences firing close together — a web client double-tap, or
   * a WS reconnect resending a buffered command — could otherwise
   * interleave: both read the same snapshot, then whichever
   * setSoundscapes() resolves last silently overwrites the other's change,
   * permanently (this corrupts the persisted file, not just a transient
   * display glitch a later poll would correct). Chaining every call
   * through one promise queue guarantees each sequence's read sees the
   * previous one's write.
   */
  _withStorageLock(fn) {
    const run = this._storageQueue.then(fn, fn); // run regardless of the previous call's outcome
    this._storageQueue = run.catch(() => {}); // don't let one failure wedge the queue for later calls
    return run;
  }

  /** Call once after Mixer and MixerUI are initialised. */
  init(mixer) {
    this._mixer = mixer;
    window.api.web.onCommand(cmd => this._dispatch(cmd));
    window.api.web.onRequestState(() => this.push());
    window.api.web.onClientConnected(() => this._startPolling());
    window.api.web.onClientDisconnected(() => this._stopPolling());
  }

  /** Schedule a state broadcast (debounced). */
  push() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._doPush(), DEBOUNCE_MS);
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this.push(), POLL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  /** Immediate, non-debounced notification — bypasses push()'s 50ms
   *  coalescing so a quick soundboard tap isn't swallowed by it.
   *  sceneId is omitted/null for the main grid's soundboard, set for a
   *  detached soundboard scene's own grid. */
  sendFlash(index, sceneId = null) {
    window.api.web.sendEvent({ kind: 'soundboardFlash', i: index, sceneId });
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
    const currentSbScene = ss.currentSbScene ?? 0;

    return {
      soundscapes:       soundscapes.map(s => ({ name: s.name ?? '' })),
      currentSoundscape: mixer.currentSoundscape,
      scenes: (ss.scenes ?? []).map(s => ({
        id:       s.id,
        name:     s.name ?? '',
        detached: mixer.detachedMusicScenes.has(s.id),
      })),
      currentScene: ss.currentScene ?? 0,
      sbScenes: (ss.sbScenes ?? []).map(s => ({
        id:       s.id,
        name:     s.name ?? '',
        detached: mixer.detachedSoundboards.has(s.id),
      })),
      currentSbScene,

      // Full live data for every currently-detached scene, regardless of
      // whether it was detached from the desktop or the web — the web
      // client's periodic poll (WebBridge._startPolling, Phase A) is what
      // keeps these in sync with any interaction source (desktop click,
      // MIDI, or a web-originated sceneCh:* command), same as it already
      // does for the main mixer/soundboard state.
      detachedMusicScenes: [...mixer.detachedMusicScenes.entries()].map(([id, player]) => ({
        id,
        name: ss.scenes?.find(s => s.id === id)?.name ?? '',
        channels: player.channels.map((ch) => ({
          name:     ch.settings.name     ?? '',
          imageSrc: ch.settings.imageSrc ?? '',
          volume:   ch.settings.volume   ?? 1,
          mute:     ch.getMute?.()       ?? ch.settings.mute ?? false,
          solo:     ch.getSolo?.()       ?? ch.settings.solo ?? false,
          link:     ch.getLink?.()       ?? ch.settings.link ?? false,
          playing:  ch.playing,
        })),
        ambient: player.ambientMixer.channels.map((ch) => ({
          name:     ch?.settings?.name     ?? '',
          imageSrc: ch?.settings?.imageSrc ?? '',
          volume:   ch?.settings?.volume   ?? 1,
          playing:  ch?.playing            ?? false,
        })),
      })),
      detachedSoundboardScenes: [...mixer.detachedSoundboards.entries()].map(([id, sb]) => {
        const arr = resolveSoundboardArray(ss, id) ?? [];
        return {
          id,
          name: ss.sbScenes?.find(s => s.id === id)?.name ?? '',
          buttons: arr.map((d, i) => ({
            name:     d?.name     ?? '',
            imageSrc: d?.imageSrc ?? '',
            playing:  sb.channels[i]?.playing ?? false,
          })),
        };
      }),

      trackCount:  await Storage.getTrackCount(),
      orientation: await Storage.getOrientation(),
      hideMsl:     await Storage.getHideMsl(),

      mixer: {
        playing: mixer.playing,
        master: {
          volume: mixer.master.settings?.volume ?? 1,
          mute:   mixer.master.getMute?.()      ?? false,
        },
        channels: mixer.channels.map((ch) => ({
          name:     ch.settings.name     ?? '',
          imageSrc: ch.settings.imageSrc ?? '',
          volume:   ch.settings.volume   ?? 1,
          pan:      ch.settings.pan      ?? 0,
          mute:     ch.getMute?.()       ?? ch.settings.mute ?? false,
          solo:     ch.getSolo?.()       ?? ch.settings.solo ?? false,
          link:     ch.getLink?.()       ?? ch.settings.link ?? false,
          playing:  ch.playing,
        })),
      },

      soundboard: {
        // soundboard master gain is stored in soundboard.master.settings.volume
        gain: mixer.soundboard?.master?.settings?.volume ?? 0.75,
        grid: await Storage.getSbGridSize(),
        buttons: (ss.soundboard ?? []).map((d, i) => {
          const ch = mixer.soundboard?.channels[i];
          return {
            name:     d.name     ?? '',
            imageSrc: d.imageSrc ?? '',
            // Matches mixerUI.js's own _updateSbBorder condition — a sound
            // left playing in the background from a DIFFERENT soundboard
            // scene than the one currently on screen must not show as
            // "playing" here either.
            playing: !!ch?.playing && ch._playingSbScene === currentSbScene,
          };
        }),
      },

      ambient: {
        masterVolume: mixer.ambientMixer?.getMasterVolume?.() ?? 1,
        channels: Array.from({ length: AMBIENT_SIZE }, (_, i) => {
          const ch = mixer.ambientMixer?.channels[i];
          return {
            name:     ch?.settings?.name     ?? '',
            imageSrc: ch?.settings?.imageSrc ?? '',
            volume:   ch?.settings?.volume   ?? 1,
            playing:  ch?.playing            ?? false,
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
      // Matches the desktop's own playMix-stop handler (mixerUI.js) — reach
      // every detached music scene too, or the web remote's "stop all"
      // leaves a detached scene's own window playing while claiming
      // everything stopped.
      await mixer.stopAllMusicScenes();
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
        await mixer.setGlobalChannelVolume(cmd.ch, cmd.v);
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
      await this._withStorageLock(async () => {
        const soundscapes = await Storage.getSoundscapes();
        if (soundscapes[mixer.currentSoundscape]?.channels[cmd.ch]?.settings) {
          soundscapes[mixer.currentSoundscape].channels[cmd.ch].settings.mute = mute;
          await Storage.setSoundscapes(soundscapes);
        }
      });
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
      await this._withStorageLock(async () => {
        const soundscapes = await Storage.getSoundscapes();
        if (soundscapes[mixer.currentSoundscape]?.channels[cmd.ch]?.settings) {
          soundscapes[mixer.currentSoundscape].channels[cmd.ch].settings.link = link;
          await Storage.setSoundscapes(soundscapes);
        }
      });
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
      await mixer.setGlobalMasterVolume(cmd.v);
      return;
    }
    if (type === 'master:mute') {
      const mute = !mixer.master.getMute();
      mixer.master.setMuteFade(mute, FADE_STOP_MS);
      mixer.ui?._setMuteColor('mute-master', mute);
      await this._withStorageLock(async () => {
        const soundscapes = await Storage.getSoundscapes();
        if (soundscapes[mixer.currentSoundscape]) {
          soundscapes[mixer.currentSoundscape].master.settings.mute = mute;
          await Storage.setSoundscapes(soundscapes);
        }
      });
      return;
    }

    // ── Soundboard ──────────────────────────────────────────────────────────
    if (type === 'soundboard:trigger') {
      mixer.soundboard.playSound(cmd.i);
      mixer.ui?.flashSoundboardButton(cmd.i);
      return;
    }
    if (type === 'soundboard:stopAll') {
      // Matches the desktop's own sbStopAll click handler (mixerUI.js),
      // which calls stopAllSoundboards() specifically so a detached
      // soundboard scene's own window also stops — mixer.soundboard.stopAll()
      // alone only reaches the active grid's instance.
      mixer.stopAllSoundboards();
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
      ch.fadeOutAndStop();
      const el = document.getElementById(`ambPlay-${cmd.i}`);
      if (el) el.innerHTML = '<i class="fas fa-play"></i>';
      return;
    }
    if (type === 'ambient:volume') {
      const ch = mixer.ambientMixer?.channels[cmd.i];
      if (ch) ch.setVolume(cmd.v);
      mixer.ui?.updateAmbientChannelVolume(cmd.i, cmd.v);
      await mixer.setGlobalAmbientVolume(cmd.i, cmd.v);
      return;
    }
    if (type === 'ambient:masterVolume') {
      mixer.ambientMixer?.setMasterVolume(cmd.v);
      mixer.ui?.updateAmbientMasterVolume(cmd.v);
      await mixer.setGlobalAmbientMasterVolume(cmd.v);
      return;
    }

    // ── Scenes ──────────────────────────────────────────────────────────────
    if (type === 'scene:switch')   { await mixer.switchScene(cmd.i);           return; }
    if (type === 'sbScene:switch') { await mixer.switchSoundboardScene(cmd.i); return; }
    if (type === 'soundscape:switch') { await mixer.setSoundscape(cmd.i);      return; }

    // ── Scene detach / reattach ────────────────────────────────────────────
    // Reuses the exact same mixer methods the desktop's own drag gesture
    // calls — nothing scene-detach-specific needs to know whether it was
    // triggered from the desktop or the web.
    if (type === 'scene:detach')     { await mixer.detachMusicScene(cmd.i, {});        return; }
    if (type === 'scene:reattach')   { await mixer.reattachMusicScene(cmd.sceneId);    return; }
    if (type === 'sbScene:detach')   { await mixer.detachSoundboardScene(cmd.i, {});   return; }
    if (type === 'sbScene:reattach') { await mixer.reattachSoundboardScene(cmd.sceneId); return; }

    // ── Detached music scene: channel/ambient controls ─────────────────────
    // Each command hardcodes its own `method` string server-side rather than
    // accepting one from the client — a generic {method,args} passthrough
    // would let a WS client on the local network invoke arbitrary methods on
    // a live channel object, which was an acceptable trust level for a
    // same-process Electron child window but not for a remote browser.
    if (type === 'sceneCh:mute') {
      dispatchChildWindowMessage(`musicScene:${cmd.sceneId}`, { kind: 'call', target: 'ch', index: cmd.index, method: 'toggleMute', args: [] });
      return;
    }
    if (type === 'sceneCh:solo') {
      dispatchChildWindowMessage(`musicScene:${cmd.sceneId}`, { kind: 'call', target: 'ch', index: cmd.index, method: 'toggleSolo', args: [] });
      return;
    }
    if (type === 'sceneCh:link') {
      dispatchChildWindowMessage(`musicScene:${cmd.sceneId}`, { kind: 'call', target: 'ch', index: cmd.index, method: 'toggleLink', args: [] });
      return;
    }
    if (type === 'sceneCh:play') {
      dispatchChildWindowMessage(`musicScene:${cmd.sceneId}`, { kind: 'call', target: cmd.target, index: cmd.index, method: 'togglePlay', args: [] });
      return;
    }
    if (type === 'sceneCh:prev') {
      dispatchChildWindowMessage(`musicScene:${cmd.sceneId}`, { kind: 'call', target: 'ch', index: cmd.index, method: 'previous', args: [] });
      return;
    }
    if (type === 'sceneCh:next') {
      dispatchChildWindowMessage(`musicScene:${cmd.sceneId}`, { kind: 'call', target: 'ch', index: cmd.index, method: 'next', args: [] });
      return;
    }
    if (type === 'sceneCh:volume') {
      dispatchChildWindowMessage(`musicScene:${cmd.sceneId}`, { kind: 'volume', target: cmd.target, index: cmd.index, value: cmd.value });
      return;
    }

    // ── Detached soundboard scene: trigger ──────────────────────────────────
    if (type === 'sbSceneCh:trigger') {
      dispatchChildWindowMessage(`soundboardScene:${cmd.sceneId}`, { kind: 'call', method: 'playSound', args: [cmd.index] });
      return;
    }
  }
}
