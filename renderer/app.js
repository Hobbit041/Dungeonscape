/**
 * app.js — renderer entry point
 * Replaces soundscape.js (Foundry entry point)
 */
import { Mixer }            from './src/mixer.js';
import { MixerUI }          from './src/mixerUI.js';
import { MidiController }   from './src/midi.js';
import { Storage }          from './src/storage.js';
import { ChannelDrag }      from './src/channelDrag.js';
import { initI18n, t }      from './src/i18n.js';
import { WebBridge }        from './src/webBridge.js';
import { SbLayout }         from './src/sbLayout.js';
import { checkForUpdates }  from './src/updateChecker.js';
import { migrateSoundscape, migrateMidiMappings } from './src/sbGrid.js';
import { makeEmptySoundboardButton } from './src/templates.js';

let mixer;
let midi;

// ─── Window controls ───────────────────────────────────────────────────────
document.getElementById('winMinimize')?.addEventListener('click', () => window.api.win.minimize());
document.getElementById('winClose')?.addEventListener('click',    () => window.api.win.close());
document.getElementById('winMaximize')?.addEventListener('click', async () => {
  await window.api.win.maximize();
  const maximized = await window.api.win.isMaximized();
  const btn = document.getElementById('winMaximize');
  if (btn) btn.title   = maximized ? t('header.winRestore') : t('header.winMaximize');
  if (btn) btn.innerHTML = maximized ? '&#9635;' : '&#9633;';
});

/** Apply data-i18n* attributes to all static DOM elements. Called once after initI18n(). */
function _applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

async function main() {
  await initI18n();
  _applyI18n();

  // One-time migration: legacy 25-slot (5-wide) soundboards → 49-slot 7×7 model
  const soundscapes = await Storage.getSoundscapes();
  let migrated = false;
  for (const ss of soundscapes) {
    if (migrateSoundscape(ss, makeEmptySoundboardButton)) migrated = true;
  }
  if (migrated) await Storage.setSoundscapes(soundscapes);
  if ((await Storage.get('sbGridVersion', 1)) < 2) {
    // Flag first: a crash between the two writes leaves mappings in the old
    // (still valid) numbering rather than risking a double migration. The
    // residual cost is that such mappings stay un-migrated — acceptable for
    // two adjacent store writes.
    const midiMappings = await Storage.getMidiMappings();
    await Storage.set('sbGridVersion', 2);
    await Storage.setMidiMappings(migrateMidiMappings(midiMappings));
  }

  mixer = new Mixer();
  window.mixer = mixer; // for debugging

  const ui = new MixerUI(mixer);
  mixer.ui = ui;

  // Soundboard grid layout (visibility, square cells, window coupling)
  const sbLayout = new SbLayout();
  ui.sbLayout = sbLayout;
  await sbLayout.init();

  // Web remote bridge
  const bridge = new WebBridge();
  bridge.init(mixer);

  // Called after any Electron-side control interaction to sync browser
  mixer.onControlChange = () => bridge.push();

  // Wire up rendering: called whenever mixer state changes
  mixer.onUIUpdate     = () => { ui.render(); bridge.push(); };
  mixer.onSceneRemoved   = (idx) => ui.onSceneRemoved(idx);
  mixer.onSbSceneRemoved = (idx) => ui.onSbSceneRemoved(idx);
  mixer.onProfileLoaded = () => ui._runMissingFilesCheck();

  // MIDI
  midi = new MidiController(mixer);
  midi.onDevicesChanged  = (devices) => ui.updateMIDIStatus(devices.map(d => d.name));
  midi.onMappingCaptured = (key, data) => ui.onMappingCaptured(key, data);
  midi.onListeningStop   = (key)       => ui.onListeningStop(key);
  ui.midi = midi;
  await midi.enable();

  // Apply stored global volume to interface gain
  const vol = await Storage.getVolume();
  mixer.master.effects.interfaceGain.set(vol);

  // Drag-and-drop reordering for channels, ambients, soundboard buttons
  new ChannelDrag(mixer).bindAll();

  // Load the last-used soundscape now that every callback (onUIUpdate,
  // onProfileLoaded, MIDI, web bridge) is wired — otherwise the initial
  // render fires into null callbacks and the profile opens empty on launch.
  await mixer.init();
}

main()
  .then(() => { void checkForUpdates(); })
  .catch((err) => {
    console.error(err);
    window.api.log.crash('RENDERER/MAIN', err.message ?? String(err), err.stack ?? '', '');
  });

// ─── Global renderer error handlers ───────────────────────────────────────

window.addEventListener('error', (e) => {
  const msg   = e.error?.message ?? e.message ?? String(e);
  const stack = e.error?.stack   ?? '';
  const detail = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '';
  window.api.log.crash('RENDERER', msg, stack, detail);
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const msg   = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? '') : '';
  window.api.log.crash('RENDERER/PROMISE', msg, stack, '');
});
