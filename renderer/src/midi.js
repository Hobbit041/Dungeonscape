/**
 * midi.js — Web MIDI API integration.
 *
 * Supports two modes:
 *   Normal   — incoming messages are routed to mixer actions via stored mappings.
 *   Listening — waiting to capture the next matching message for a specific entity.
 *
 * Entity keys:
 *   ch-{i}-mute / solo / volume / play / prev / next
 *   master-volume / master-play
 *   sb-stopall
 *   sb-{i}   (soundboard button 0–48, 7×7 slots)
 *
 * Message types:
 *   volume entities → pitchbend  (0xE0, 14-bit, channel-scoped)
 *   all others      → noteon     (0x90, channel + note)
 */
import { Storage } from './storage.js';
import { FADE_STOP_MS } from './audioFade.js';

export class MidiController {
  constructor(mixer) {
    this.mixer          = mixer;
    this.enabled        = false;
    this.ledEnabled     = true;
    this.mappingMode    = false;
    this.devices        = [];
    this.mappings       = {};     // entityKey → { type, channel, note? }
    this._listeningFor  = null;   // entityKey currently being mapped
    this._listeningType = null;   // 'noteon' | 'pitchbend'
    this._access        = null;
    this._saveTimer     = null;   // debounce handle for deferred storage writes
    this._recentNoteOns  = new Map(); // `ch:note` → timestamp, for button debounce
    this._ccAbsoluteCache = new Map(); // `ch:cc` → true  once absolute CC detected

    // Callbacks — set by the UI
    this.onDevicesChanged  = null;  // (devices[]) → void
    this.onMappingCaptured = null;  // (entityKey, mappingData) → void
    this.onListeningStop   = null;  // (entityKey) → void  — fired on explicit stop/cancel
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async enable() {
    this.mappings   = await Storage.getMidiMappings();
    this.ledEnabled = await Storage.getMidiLed();
    if (!navigator.requestMIDIAccess) {
      console.warn('Web MIDI API not supported');
      return false;
    }
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: false });
      this._access.onstatechange = () => this._refreshDevices();
      this._refreshDevices();
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn('MIDI access denied:', err);
      return false;
    }
  }

  disable() {
    if (this._access) {
      this._access.inputs.forEach(input => { input.onmidimessage = null; });
    }
    this.enabled = false;
    this.devices = [];
  }

  _refreshDevices() {
    if (!this._access) return;
    this.devices = [];
    this._access.inputs.forEach(input => {
      input.onmidimessage = (msg) => this._onMessage(msg);
      this.devices.push({ id: input.id, name: input.name, state: input.state });
    });
    // Pre-open all outputs so send() is called on already-open ports.
    // Calling send() on a closed port triggers auto-open which hits a
    // dragEvent bug in Electron 28 Chromium internals and crashes the renderer.
    this._access.outputs.forEach(output => { output.open().catch(() => {}); });
    if (this.onDevicesChanged) this.onDevicesChanged(this.devices);
  }

  // ── Mapping capture ────────────────────────────────────────────────────────

  /**
   * Start waiting for the next MIDI message for the given entity.
   * If another entity was already listening, it is silently cancelled first
   * (fires onListeningStop for the old entity).
   */
  startListening(entityKey, type) {
    if (this._listeningFor && this._listeningFor !== entityKey) {
      // Cancel the previous listener and notify UI
      const prev = this._listeningFor;
      this._listeningFor  = null;
      this._listeningType = null;
      if (this.onListeningStop) this.onListeningStop(prev);
    }
    this._listeningFor  = entityKey;
    this._listeningType = type;
  }

  /** Explicitly cancel listening (fires onListeningStop). */
  stopListening() {
    if (!this._listeningFor) return;
    const prev = this._listeningFor;
    this._listeningFor  = null;
    this._listeningType = null;
    if (this.onListeningStop) this.onListeningStop(prev);
  }

  /** Cancel without firing any callback (used when exiting mapping mode). */
  cancelListening() {
    this._listeningFor  = null;
    this._listeningType = null;
  }

  isListening()    { return this._listeningFor !== null; }
  getListeningFor() { return this._listeningFor; }

  // ── Mapping storage ────────────────────────────────────────────────────────

  getMappings() { return this.mappings; }

  async setMapping(entityKey, data) {
    this.mappings[entityKey] = data;
    await Storage.setMidiMappings(this.mappings);
  }

  async clearMapping(entityKey) {
    delete this.mappings[entityKey];
    await Storage.setMidiMappings(this.mappings);
  }

  // ── Message handling ───────────────────────────────────────────────────────

  _onMessage(msg) {
    const [status, data1, data2] = msg.data;
    const type    = status & 0xF0;
    const channel = status & 0x0F;

    if (this._listeningFor) {
      if (this._listeningType === 'noteon' && type === 0x90 && data2 > 0) {
        this._captureMapping({ type: 'noteon', channel, note: data1 });
      } else if (this._listeningType === 'pitchbend' && type === 0xE0) {
        this._captureMapping({ type: 'pitchbend', channel });
      } else if (this._listeningType === 'volume_any') {
        // Accept PitchBend (absolute) or any CC (relative/absolute — detected at runtime)
        if (type === 0xE0) {
          this._captureMapping({ type: 'pitchbend', channel });
        } else if (type === 0xB0 && data2 > 0) {
          this._captureMapping({ type: 'cc_auto', channel, cc: data1 });
        }
      }
      return;
    }

    // Normal routing — blocked while mapping UI is open
    if (this.mappingMode) return;
    if      (type === 0x90 && data2 > 0) this._dispatchNoteOn(channel, data1);
    else if (type === 0xE0)              this._dispatchPitchBend(channel, data1, data2);
    else if (type === 0xB0)              this._dispatchCC(channel, data1, data2);
  }

  async _captureMapping(data) {
    const entityKey = this._listeningFor;
    // Clear listening state silently (no onListeningStop — onMappingCaptured handles UI)
    this._listeningFor  = null;
    this._listeningType = null;
    await this.setMapping(entityKey, data);
    if (this.onMappingCaptured) this.onMappingCaptured(entityKey, data);
  }

  // ── Normal-mode dispatch ───────────────────────────────────────────────────

  _dispatchNoteOn(channel, note) {
    // Many controllers send noteOn both on press and release (velocity > 0 both times).
    // Debounce per note: ignore if the same note fired within 150 ms.
    const nKey = `${channel}:${note}`;
    const now  = Date.now();
    if ((this._recentNoteOns.get(nKey) ?? 0) > now - 150) return;
    this._recentNoteOns.set(nKey, now);

    for (const [key, m] of Object.entries(this.mappings)) {
      if (m.type === 'noteon' && m.channel === channel && m.note === note) {
        this._executeAction(key);
        this.mixer.onControlChange?.();
      }
    }
  }

  _dispatchPitchBend(channel, lsb, msb) {
    // 14-bit pitchbend → 0..1
    const value = ((msb << 7) | lsb) / 16383;
    for (const [key, m] of Object.entries(this.mappings)) {
      if (m.type === 'pitchbend' && m.channel === channel) {
        this._executeVolumeAction(key, value * 1.25);
        this.mixer.onControlChange?.();
      }
    }
  }

  _executeAction(entityKey) {
    const mixer = this.mixer;
    if (!mixer) return;

    let m;

    if ((m = entityKey.match(/^ch-(\d+)-mute$/))) {
      const i = +m[1], ch = mixer.channels[i];
      if (ch) {
        const mute = !ch.getMute();
        ch.setMuteFade(mute, FADE_STOP_MS);
        mixer.ui?.updateMute(i, mute);
      }
      return;
    }
    if ((m = entityKey.match(/^ch-(\d+)-solo$/))) {
      mixer.toggleSolo(+m[1], FADE_STOP_MS);
      return;
    }
    if ((m = entityKey.match(/^ch-(\d+)-link$/))) {
      mixer.toggleLink(+m[1]);
      return;
    }
    if ((m = entityKey.match(/^ch-(\d+)-play$/))) {
      const i = +m[1], ch = mixer.channels[i];
      if (ch) {
        if (ch.playing) {
          ch.fadeOutAndStop(FADE_STOP_MS, false).then(() => {
            mixer.playing = mixer.channels.some(c => c.playing);
            mixer.ui?.updatePlayState();
          });
        } else {
          mixer.start(i, FADE_STOP_MS);
          mixer.ui?.updatePlayState();
        }
      }
      return;
    }
    if ((m = entityKey.match(/^ch-(\d+)-prev$/))) {
      mixer.channels[+m[1]]?.previous(); return;
    }
    if ((m = entityKey.match(/^ch-(\d+)-next$/))) {
      mixer.channels[+m[1]]?.next(); return;
    }
    if (entityKey === 'master-play') {
      if (mixer.playing) mixer.stop(); else mixer.start();
      mixer.ui?.updatePlayState();
      return;
    }
    if (entityKey === 'sb-stopall') {
      mixer.soundboard.stopAll(); return;
    }
    if ((m = entityKey.match(/^sb-(\d+)$/))) {
      const i = +m[1];
      mixer.soundboard.playSound(i);
      mixer.ui?.flashSoundboardButton(i);
      mixer.ui?._updateSbBorder(i);
      return;
    }
    if ((m = entityKey.match(/^sb-scene-(\d+)$/))) {
      mixer.switchSoundboardScene(+m[1]);
      return;
    }
    if ((m = entityKey.match(/^amb-(\d+)-play$/))) {
      const i = +m[1], ch = mixer.ambientMixer?.channels[i];
      if (ch) ch.playing ? ch.stop() : ch.play();
      mixer.ui?.updateAmbientPlayState(i);
      return;
    }
    if ((m = entityKey.match(/^scene-(\d+)$/))) {
      mixer.switchScene(+m[1]);
      return;
    }
  }

  _dispatchCC(channel, ccNum, value) {
    // Relative-encoder "safe zone": values that can only come from a step encoder
    // (1–8 = slow CW, 55–73 = CCW step centred on 64/65, 120–127 = fast CCW two-complement).
    // Any value outside this zone is treated as absolute (physical knob position 0–127).
    const inRelativeZone = (value <= 8) || (value >= 55 && value <= 73) || (value >= 120);

    for (const [key, m] of Object.entries(this.mappings)) {
      if (m.channel !== channel || m.cc !== ccNum) continue;

      if (m.type === 'cc_relative') {
        if (value === 0) continue; // relative never fires on 0
        const delta = value < 64 ? value * 0.01 : -(value - 64) * 0.01;
        this._executeRelativeVolumeAction(key, delta);
        this.mixer.onControlChange?.();

      } else if (m.type === 'cc_absolute') {
        const vol = (value / 127) * 1.25;
        this._executeVolumeAction(key, vol);
        this.mixer.onControlChange?.();

      } else if (m.type === 'cc_auto') {
        // Sticky runtime detection: once we see an out-of-relative-zone value, the
        // CC is permanently classified as absolute for this session.
        const cacheKey = `${channel}:${ccNum}`;
        if (!inRelativeZone) this._ccAbsoluteCache.set(cacheKey, true);

        if (this._ccAbsoluteCache.get(cacheKey)) {
          const vol = (value / 127) * 1.25;
          this._executeVolumeAction(key, vol);
        } else {
          if (value === 0) continue;
          const delta = value < 64 ? value * 0.01 : -(value - 64) * 0.01;
          this._executeRelativeVolumeAction(key, delta);
        }
        this.mixer.onControlChange?.();
      }
    }
  }

  _executeRelativeVolumeAction(entityKey, delta) {
    const mixer = this.mixer;
    if (!mixer) return;

    if (entityKey === 'amb-master-volume') {
      const newVol = Math.max(0, Math.min(1.25, mixer.ambientMixer.getMasterVolume() + delta));
      mixer.ambientMixer.setMasterVolume(newVol);
      mixer.ui?.updateAmbientMasterVolume(newVol);
      this._deferSave();
      return;
    }
    const m = entityKey.match(/^amb-(\d+)-volume$/);
    if (m) {
      const i = +m[1];
      const ch = mixer.ambientMixer?.channels[i];
      if (ch) {
        const newVol = Math.max(0, Math.min(1.25, ch.settings.volume + delta));
        ch.setVolume(newVol);
        mixer.ui?.updateAmbientChannelVolume(i, newVol);
        this._deferSave();
      }
    }
  }

  _executeVolumeAction(entityKey, volume) {
    const mixer = this.mixer;
    if (!mixer) return;
    volume = Math.max(0, Math.min(1.25, volume));

    if (entityKey === 'master-volume') {
      mixer.master.setVolume(volume);
      mixer.ui?.updateMasterVolume(volume);
      this._deferSave();
      return;
    }
    if (entityKey === 'amb-master-volume') {
      mixer.ambientMixer?.setMasterVolume(volume);
      mixer.ui?.updateAmbientMasterVolume(volume);
      this._deferSave();
      return;
    }
    let m = entityKey.match(/^ch-(\d+)-volume$/);
    if (m) {
      const i = +m[1], ch = mixer.channels[i];
      if (ch) {
        if (ch.getLink()) {
          // setLinkVolumes does its own Storage write — call fire-and-forget,
          // _deferSave will overwrite with final in-memory values anyway.
          mixer.setLinkVolumes(volume, i).catch(() => {});
          mixer.ui?.updateAllChannelVolumes();
        } else {
          ch.setVolume(volume);
          mixer.ui?.updateChannelVolume(i, volume);
        }
        this._deferSave();
      }
      return;
    }
    m = entityKey.match(/^amb-(\d+)-volume$/);
    if (m) {
      const i = +m[1];
      const ch = mixer.ambientMixer?.channels[i];
      if (ch) {
        ch.setVolume(volume);
        mixer.ui?.updateAmbientChannelVolume(i, volume);
        this._deferSave();
      }
    }
  }

  /**
   * Schedule a single Storage write 300 ms after the last MIDI volume event.
   * Replaces per-event getSoundscapes/setSoundscapes calls, which caused
   * hundreds of concurrent Promises holding full soundscapes copies in memory.
   */
  _deferSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        const mixer = this.mixer;
        if (!mixer) return;
        const soundscapes = await Storage.getSoundscapes();
        const ss = soundscapes[mixer.currentSoundscape];
        if (!ss) return;

        for (let i = 0; i < mixer.mixerSize; i++) {
          if (ss.channels?.[i]?.settings != null)
            ss.channels[i].settings.volume = mixer.channels[i].settings.volume ?? 1;
        }
        if (ss.master?.settings != null)
          ss.master.settings.volume = mixer.master.settings.volume ?? 1;
        if (Array.isArray(ss.ambient)) {
          for (let i = 0; i < ss.ambient.length; i++) {
            if (ss.ambient[i]?.settings != null && mixer.ambientMixer?.channels[i])
              ss.ambient[i].settings.volume = mixer.ambientMixer.channels[i].settings?.volume ?? 1;
          }
        }
        if (ss.ambientMaster != null)
          ss.ambientMaster.volume = mixer.ambientMixer?.getMasterVolume?.() ?? 1;

        soundscapes[mixer.currentSoundscape] = ss;
        await Storage.setSoundscapes(soundscapes);
      } catch (err) {
        console.error('[MIDI] deferred save failed:', err);
      }
    }, 300);
  }

  _uiUpdate() {
    if (this.mixer?.onUIUpdate) this.mixer.onUIUpdate();
  }

  /**
   * Send NoteOn to all connected outputs to set an LED on/off.
   * Only acts if the entity has a 'noteon' mapping.
   * velocity 127 = LED on, 0 = LED off (NoteOn v0 is standard "note off").
   */
  sendLed(entityKey, on) {
    if (!this._access || !this.ledEnabled) return;
    const m = this.mappings[entityKey];
    if (!m || m.type !== 'noteon') return;
    const msg = [0x90 | m.channel, m.note, on ? 127 : 0];
    setTimeout(() => {
      if (!this._access) return;
      this._access.outputs.forEach(output => {
        try { output.send(msg); } catch (_) {}
      });
    }, 0);
  }

  getDevices() { return this.devices; }
}
