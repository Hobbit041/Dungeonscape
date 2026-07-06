/**
 * storage.js
 * Replaces game.settings from Foundry VTT.
 * Uses Electron's electron-store (via IPC) for persistent storage.
 */

export const Storage = {
  async get(key, defaultValue = undefined) {
    return await window.api.store.get(key, defaultValue);
  },

  async set(key, value) {
    await window.api.store.set(key, value);
  },

  async delete(key) {
    await window.api.store.delete(key);
  },

  // ─── Soundscapes ────────────────────────────────────────────────────────
  async getSoundscapes() {
    return await this.get('soundscapes', []);
  },

  async setSoundscapes(data) {
    await this.set('soundscapes', data);
  },

  async getVolume() {
    return await this.get('volume', 0.5);
  },

  async setVolume(v) {
    await this.set('volume', v);
  },

  // ─── MIDI mappings ───────────────────────────────────────────────────────
  async getMidiMappings() {
    return await this.get('midiMappings', {});
  },

  async setMidiMappings(data) {
    await this.set('midiMappings', data);
  },

  // ─── Last active soundscape ──────────────────────────────────────────────
  async getLastSoundscape() {
    return await this.get('lastSoundscape', 0);
  },

  async setLastSoundscape(idx) {
    await this.set('lastSoundscape', idx);
  },

  // ─── MIDI LED feedback ───────────────────────────────────────────────────
  async getMidiLed() {
    return await this.get('midiLed', true);
  },

  async setMidiLed(v) {
    await this.set('midiLed', v);
  },

  // ─── Drop behavior ───────────────────────────────────────────────────────
  async getDropBehavior() {
    return await this.get('dropBehavior', { music: 'overwrite', bg: 'overwrite', sb: 'overwrite' });
  },

  async setDropBehavior(data) {
    await this.set('dropBehavior', data);
  },

  // ─── Soundboard grid size ─────────────────────────────────────────────────
  async getSbGridSize() {
    const v = await this.get('sbGridSize', null);
    const clamp = (n) => Math.max(4, Math.min(7, parseInt(n, 10) || 5));
    return v ? { cols: clamp(v.cols), rows: clamp(v.rows) } : { cols: 5, rows: 5 };
  },

  async setSbGridSize(v) {
    await this.set('sbGridSize', v);
  }
};
