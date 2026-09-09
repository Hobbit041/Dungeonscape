/**
 * settings-entry.js — bootstrap for the standalone Settings window.
 *
 * SettingsDialog itself is completely unchanged internally from what used
 * to be mixerUI.js's _openSettingsPanel() method, except for the extraction
 * itself (see settingsDialog.js's own header comment) — this file supplies
 * the `ui` object SettingsDialog's constructor expects, backed entirely by
 * RPC calls to the real MixerUI instance living in the main window,
 * dispatched by renderer/src/settingsBridge.js.
 *
 * Two values (getUpdateInfo()'s cached result, the remote-control
 * running/url status) exist only in the main window's in-memory state —
 * they're passed once as a snapshot in the child-window-init payload rather
 * than queried live, matching how e.g. ChannelConfig's initial
 * sourceArrayLength is passed. No live-sync afterward: these values only
 * change through explicit user action inside this same window (remote
 * start/stop) or once at app startup (the update check), so a stale
 * snapshot after external change is not a realistic scenario.
 */
import { initI18n, t } from '../src/i18n.js';
import { SettingsDialog } from '../src/settingsDialog.js';
import { finishDetachedWindowInit } from './detachedWindowChrome.js';

window.api.childWindow.onInit(async (data = {}) => {
  try {
    await initI18n();
    const { key, updateInfo, webServerRunning, webServerUrl } = data;

    const sendCall = (method, ...args) => window.api.childWindow.send(key, { kind: 'call', method, args });
    const sendSet  = (prop, value)     => window.api.childWindow.send(key, { kind: 'set', prop, value });

    const state = {
      webServerRunning: !!webServerRunning,
      webServerUrl: webServerUrl ?? '',
    };

    const ui = {
      updateInfo: updateInfo ?? null,
      sbLayout: {
        setGridSize(cols, rows) { sendCall('sbLayout.setGridSize', cols, rows); },
      },
      midi: {
        set ledEnabled(v) { sendSet('midi.ledEnabled', v); },
      },
      mixer: {
        onControlChange() { sendCall('mixer.onControlChange'); },
      },
      get _webServerRunning() { return state.webServerRunning; },
      set _webServerRunning(v) { state.webServerRunning = v; sendSet('_webServerRunning', v); },
      get _webServerUrl() { return state.webServerUrl; },
      set _webServerUrl(v) { state.webServerUrl = v; sendSet('_webServerUrl', v); },
      _applyTrackCount(n)           { sendCall('_applyTrackCount', n); },
      _applyOrientation(horizontal) { sendCall('_applyOrientation', horizontal); },
      _applyHideMsl(v)              { sendCall('_applyHideMsl', v); },
      _restoreFaderWindowSize()     { sendCall('_restoreFaderWindowSize'); },
      _exportMidiMappings()         { sendCall('_exportMidiMappings'); },
      _importMidiMappings()         { sendCall('_importMidiMappings'); },
      _exportProfiles()             { sendCall('_exportProfiles'); },
      _importProfiles()             { sendCall('_importProfiles'); },
      _runMissingFilesCheck(opts)   { sendCall('_runMissingFilesCheck', opts); },
    };

    new SettingsDialog(ui).open();
    finishDetachedWindowInit(key, t('settings.title'));
  } catch (err) {
    console.error('[settings-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
