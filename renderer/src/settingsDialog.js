/**
 * settingsDialog.js
 * Floating panel for global app settings (language, missing-files check,
 * data location, drop behavior, MIDI LED, soundboard grid, track count,
 * orientation, hide M/S/L, window size, MIDI/profile export-import, remote
 * control). Extracted from mixerUI.js's former _openSettingsPanel() method
 * so it can run as a detached window: everything that used to be `this.xxx`
 * on the MixerUI instance is now `this.ui.xxx` on whatever object the
 * caller passes in — in practice always the RPC stub built by
 * renderer/windows/settings-entry.js, since this class is only ever
 * instantiated from there (mixerUI.js just opens the detached window).
 *
 * Note: the "Remote Control" start/stop/URL wiring below
 * (settingsRemoteStart/remoteActiveRow/remoteControlUrl/settingsRemoteStop)
 * targets DOM ids that don't exist anywhere in this panel's own HTML
 * template — this was already true before this extraction. Ported as-is,
 * unrelated to this change: every reference is `?.`-guarded, so it
 * silently no-ops rather than throwing.
 */
import { Storage } from './storage.js';
import { t } from './i18n.js';
import { showConfirm, showAlert } from './dialog.js';
import { TRACK_COUNT_MIN, TRACK_COUNT_MAX } from './trackCount.js';

export class SettingsDialog {
  constructor(ui) {
    this.ui = ui;
  }

  open() {
    const existing = document.getElementById('settingsPanel');
    if (existing) {
      existing.remove();
      return;
    }

    const DROP_OPTIONS = `
      <option value="overwrite">${t('settings.dropOverwrite')}</option>
      <option value="next">${t('settings.dropNext')}</option>
      <option value="append">${t('settings.dropAppend')}</option>
    `;

    const GRID_OPTIONS = [4, 5, 6, 7]
      .map(n => `<option value="${n}">${n}</option>`).join('');

    const TRACK_COUNT_OPTIONS = Array.from(
      { length: TRACK_COUNT_MAX - TRACK_COUNT_MIN + 1 }, (_, i) => i + TRACK_COUNT_MIN
    ).map(n => `<option value="${n}">${n}</option>`).join('');

    const updateInfo = this.ui.updateInfo;
    const _updateBadge = updateInfo
      ? `<a id="settingsUpdateBadge" class="settings-update-badge">${t('update.badge')}</a>`
      : '';

    const panel = document.createElement('div');
    panel.id        = 'settingsPanel';
    panel.className = 'settings-panel fx-panel detached-panel';
    panel.innerHTML = `
      <div class="fx-header settings-panel-header">
        <span>${t('settings.title')}</span>
        <button class="fx-close" id="settingsPanelClose">✕</button>
      </div>
      <div class="settings-panel-body">
        <div class="settings-layout">

          <div class="settings-sidebar">
            <div class="settings-nav">
              <button class="settings-nav-item active" data-page="general">${t('settings.navGeneral')}</button>
              <button class="settings-nav-item" data-page="appearance">${t('settings.navAppearance')}</button>
              <button class="settings-nav-item" data-page="profiles">${t('settings.navProfiles')}</button>
            </div>
            <div class="settings-sidebar-footer">
              <span id="settingsVersion"></span>
              ${_updateBadge}
              <span>© Максим &lsquo;Роланд&rsquo; Тренин</span>
            </div>
          </div>

          <div class="settings-content">

            <div class="settings-page" data-page="general">

              <div class="settings-section">
                <div class="settings-section-title">${t('settings.language')}</div>
                <select class="settings-select" id="settingsLanguage">
                  <option value="ru">${t('settings.langRu')}</option>
                </select>
              </div>

              <div class="settings-section">
                <button class="settings-btn" id="settingsCheckFiles">
                  <i class="fas fa-search"></i> ${t('settings.checkMissingFiles')}
                </button>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">${t('settings.dataLocationSection')}</div>
                <div class="settings-drop-grid">
                  <label class="settings-drop-label">${t('settings.dataLocationLabel')}</label>
                  <select class="settings-select" id="settingsDataLocation">
                    <option value="appdata">${t('settings.dataLocationAppData')}</option>
                    <option value="launcher">${t('settings.dataLocationLauncher')}</option>
                    <option value="custom">${t('settings.dataLocationCustom')}</option>
                  </select>
                </div>
                <p class="settings-drop-hint settings-drop-hint-static" id="settingsDataLocationHint" style="margin-top:6px;word-break:break-all"></p>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">${t('settings.dropBehaviorSection')}</div>
                <p class="settings-drop-hint settings-drop-hint-static">${t('settings.dropBehaviorDesc')}</p>
                <div class="settings-drop-grid">
                  <label class="settings-drop-label">${t('settings.dropMusic')}</label>
                  <select class="settings-select" id="dropBehaviorMusic">${DROP_OPTIONS}</select>
                  <label class="settings-drop-label">${t('settings.dropBg')}</label>
                  <select class="settings-select" id="dropBehaviorBg">${DROP_OPTIONS}</select>
                  <label class="settings-drop-label">${t('settings.dropSb')}</label>
                  <select class="settings-select" id="dropBehaviorSb">${DROP_OPTIONS}</select>
                </div>
                <p class="settings-drop-hint" id="dropBehaviorHint"></p>
              </div>

            </div>

            <div class="settings-page" data-page="appearance" style="display:none">

              <div class="settings-section">
                <div class="settings-row settings-row-toggle">
                  <label class="settings-toggle-label" for="settingsMidiLed">${t('settings.midiLed')}</label>
                  <label class="settings-toggle">
                    <input type="checkbox" id="settingsMidiLed">
                    <span class="settings-toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">${t('settings.sbGridSection')}</div>
                <div class="settings-drop-grid">
                  <label class="settings-drop-label">${t('settings.sbGridCols')}</label>
                  <select class="settings-select" id="settingsSbCols">${GRID_OPTIONS}</select>
                  <label class="settings-drop-label">${t('settings.sbGridRows')}</label>
                  <select class="settings-select" id="settingsSbRows">${GRID_OPTIONS}</select>
                  <label class="settings-drop-label">${t('settings.trackCount')}</label>
                  <select class="settings-select" id="settingsTrackCount">${TRACK_COUNT_OPTIONS}</select>
                </div>
                <div class="settings-row settings-row-toggle" style="margin-top:8px">
                  <label class="settings-toggle-label" for="settingsOrientation">${t('settings.orientation')}</label>
                  <label class="settings-toggle">
                    <input type="checkbox" id="settingsOrientation">
                    <span class="settings-toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-row settings-row-toggle">
                  <label class="settings-toggle-label" for="settingsHideMsl">${t('settings.hideMsl')}</label>
                  <label class="settings-toggle">
                    <input type="checkbox" id="settingsHideMsl">
                    <span class="settings-toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-section">
                <button class="settings-btn" id="settingsRestoreWindowSize">
                  <i class="fas fa-expand"></i> ${t('settings.restoreWindowSize')}
                </button>
              </div>

            </div>

            <div class="settings-page" data-page="profiles" style="display:none">

              <div class="settings-section">
                <div class="settings-section-title">${t('settings.midiSection')}</div>
                <div class="settings-row">
                  <button class="settings-btn" id="settingsMidiExport">
                    <i class="fas fa-file-export"></i> ${t('settings.exportMidi')}
                  </button>
                  <button class="settings-btn" id="settingsMidiImport">
                    <i class="fas fa-file-import"></i> ${t('settings.importMidi')}
                  </button>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-row">
                  <button class="settings-btn" id="settingsProfileExport">
                    <i class="fas fa-file-export"></i> ${t('settings.exportProfiles')}
                  </button>
                  <button class="settings-btn" id="settingsProfileImport">
                    <i class="fas fa-file-import"></i> ${t('settings.importProfiles')}
                  </button>
                </div>
              </div>

            </div>

          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Fill version asynchronously
    window.api.getAppVersion().then(v => {
      const el = document.getElementById('settingsVersion');
      if (el) el.textContent = `v${v}`;
    }).catch(() => {});

    if (updateInfo) {
      document.getElementById('settingsUpdateBadge')?.addEventListener('click', () => {
        window.api.shell.openExternal(updateInfo.url);
      });
    }

    // Fix the panel's height to the tallest category page so switching
    // sidebar tabs doesn't resize the whole window. A plain min-height on
    // .settings-content wouldn't bubble up: .settings-panel-body/.settings-layout
    // use `flex:1; min-height:0` (needed so .settings-content can scroll instead
    // of overflowing), and inside an auto-height ancestor a flex-basis:0 item's
    // content size doesn't count toward that ancestor's auto height. Setting an
    // explicit pixel height on .settings-panel itself sidesteps that: it gives
    // the flex chain a definite height to fill, so it stays constant regardless
    // of which page is visible.
    const headerHeight = panel.querySelector('.settings-panel-header').offsetHeight;
    const pages         = panel.querySelectorAll('.settings-page');
    // Batch all display writes before any scrollHeight read, and all restore
    // writes after — interleaving write/read/write per page (as before)
    // forces a synchronous layout recalculation on every single iteration.
    const prevDisplays = Array.from(pages, p => p.style.display);
    pages.forEach(p => { p.style.display = ''; });
    let maxPageHeight = 0;
    pages.forEach(p => { maxPageHeight = Math.max(maxPageHeight, p.scrollHeight); });
    pages.forEach((p, i) => { p.style.display = prevDisplays[i]; });
    panel.style.height = `${headerHeight + maxPageHeight + 50}px`;

    const closeSettings = () => {
      window.close();
    };

    // Sidebar navigation — page-switcher, resets to "general" every time the panel opens
    const navButtons = panel.querySelectorAll('.settings-nav-item');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        navButtons.forEach(b => b.classList.toggle('active', b === btn));
        pages.forEach(p => { p.style.display = (p.dataset.page === page) ? '' : 'none'; });
      });
    });

    // MIDI buttons
    document.getElementById('settingsPanelClose')
      ?.addEventListener('click', closeSettings);
    document.getElementById('settingsMidiExport')
      ?.addEventListener('click', () => this.ui._exportMidiMappings());
    document.getElementById('settingsMidiImport')
      ?.addEventListener('click', () => this.ui._importMidiMappings());

    // MIDI LED toggle
    Storage.getMidiLed().then(val => {
      const el = document.getElementById('settingsMidiLed');
      if (el) el.checked = val;
    });
    document.getElementById('settingsMidiLed')?.addEventListener('change', async (e) => {
      const val = e.target.checked;
      await Storage.setMidiLed(val);
      if (this.ui.midi) this.ui.midi.ledEnabled = val;
    });

    // Soundboard grid size
    Storage.getSbGridSize().then(({ cols, rows }) => {
      const c = document.getElementById('settingsSbCols');
      const r = document.getElementById('settingsSbRows');
      if (c) c.value = String(cols);
      if (r) r.value = String(rows);
    });
    const _onGridChange = async () => {
      const cols = parseInt(document.getElementById('settingsSbCols')?.value ?? '5', 10);
      const rows = parseInt(document.getElementById('settingsSbRows')?.value ?? '5', 10);
      await this.ui.sbLayout?.setGridSize(cols, rows);
      this.ui.mixer.onControlChange?.();   // push new grid to web remote
    };
    document.getElementById('settingsSbCols')?.addEventListener('change', _onGridChange);
    document.getElementById('settingsSbRows')?.addEventListener('change', _onGridChange);

    // Hide M/S/L toggle
    Storage.getHideMsl().then(val => {
      const el = document.getElementById('settingsHideMsl');
      if (el) el.checked = val;
    });
    document.getElementById('settingsHideMsl')?.addEventListener('change', async (e) => {
      const val = e.target.checked;
      await Storage.setHideMsl(val);
      this.ui._applyHideMsl(val);
    });

    // Track count
    Storage.getTrackCount().then(n => {
      const el = document.getElementById('settingsTrackCount');
      if (el) el.value = String(n);
    });
    document.getElementById('settingsTrackCount')?.addEventListener('change', async (e) => {
      const n = parseInt(e.target.value, 10);
      await Storage.setTrackCount(n);
      await this.ui._applyTrackCount(n);
    });

    // Orientation
    Storage.getOrientation().then(o => {
      const el = document.getElementById('settingsOrientation');
      if (el) el.checked = o === 'horizontal';
    });
    document.getElementById('settingsOrientation')?.addEventListener('change', async (e) => {
      const horizontal = e.target.checked;
      await Storage.setOrientation(horizontal ? 'horizontal' : 'vertical');
      await this.ui._applyOrientation(horizontal);
    });

    // Restore window size (grows/shrinks window height only, so music/
    // ambient faders land exactly at their 140px cap)
    document.getElementById('settingsRestoreWindowSize')
      ?.addEventListener('click', () => this.ui._restoreFaderWindowSize());

    // Profile export/import
    document.getElementById('settingsProfileExport')
      ?.addEventListener('click', () => this.ui._exportProfiles());
    document.getElementById('settingsProfileImport')
      ?.addEventListener('click', () => this.ui._importProfiles());

    // Missing files check
    document.getElementById('settingsCheckFiles')?.addEventListener('click', async () => {
      closeSettings();
      await this.ui._runMissingFilesCheck({ silent: false, forceDialog: true });
    });

    // Remote control
    const _updateRemoteUI = (running, url) => {
      const startBtn  = document.getElementById('settingsRemoteStart');
      const activeRow = document.getElementById('remoteActiveRow');
      const urlCode   = document.getElementById('remoteControlUrl');
      if (startBtn)  startBtn.style.display  = running ? 'none' : '';
      if (activeRow) activeRow.style.display  = running ? 'flex' : 'none';
      if (urlCode)   urlCode.textContent      = url ?? '';
    };
    document.getElementById('settingsRemoteStart')?.addEventListener('click', async () => {
      const { url } = await window.api.web.serverStart();
      this.ui._webServerRunning = true;
      this.ui._webServerUrl     = url;
      _updateRemoteUI(true, url);
    });
    document.getElementById('remoteControlUrl')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.ui._webServerUrl).catch(() => {});
    });
    document.getElementById('settingsRemoteStop')?.addEventListener('click', async () => {
      await window.api.web.serverStop();
      this.ui._webServerRunning = false;
      this.ui._webServerUrl     = '';
      _updateRemoteUI(false, '');
    });

    // Drag-behaviour — load saved values, update hint, save on change
    const HINTS = {
      overwrite: t('settings.dropHintOverwrite'),
      next:      t('settings.dropHintNext'),
      append:    t('settings.dropHintAppend'),
    };
    const hintEl    = document.getElementById('dropBehaviorHint');
    const selectIds = ['dropBehaviorMusic', 'dropBehaviorBg', 'dropBehaviorSb'];
    const updateHint = (value) => {
      hintEl.textContent = HINTS[value] ?? '';
    };

    // Seed selects from storage, then update hint
    Storage.getDropBehavior().then(saved => {
      const musicEl = document.getElementById('dropBehaviorMusic');
      const bgEl    = document.getElementById('dropBehaviorBg');
      const sbEl    = document.getElementById('dropBehaviorSb');
      if (musicEl) musicEl.value = saved.music ?? 'overwrite';
      if (bgEl)    bgEl.value    = saved.bg    ?? 'overwrite';
      if (sbEl)    sbEl.value    = saved.sb    ?? 'overwrite';
      updateHint(musicEl?.value ?? 'overwrite');
    });

    const BEHAVIOR_KEYS = {
      dropBehaviorMusic: 'music',
      dropBehaviorBg:    'bg',
      dropBehaviorSb:    'sb',
    };
    for (const id of selectIds) {
      document.getElementById(id)?.addEventListener('change', async (e) => {
        updateHint(e.target.value);
        const saved = await Storage.getDropBehavior();
        saved[BEHAVIOR_KEYS[id]] = e.target.value;
        await Storage.setDropBehavior(saved);
      });
    }

    // Data location
    const dlSelect = document.getElementById('settingsDataLocation');
    const dlHint   = document.getElementById('settingsDataLocationHint');
    let   _dlCustomPath = '';

    window.api.dataLocation.get().then(({ mode, customPath, dataDir }) => {
      _dlCustomPath = customPath || '';
      if (mode === 'custom' && customPath) {
        const opt = dlSelect?.querySelector('option[value="custom"]');
        if (opt) opt.textContent = customPath;
      }
      if (dlSelect) dlSelect.value = mode;
      if (dlHint)   dlHint.textContent = dataDir || '';
    }).catch(() => {});

    dlSelect?.addEventListener('change', async (e) => {
      const mode = e.target.value;
      if (mode === 'custom') {
        const picked = await window.api.dataLocation.pick();
        if (!picked) {
          const { mode: curMode } = await window.api.dataLocation.get();
          dlSelect.value = curMode;
          return;
        }
        _dlCustomPath = picked;
        const opt = dlSelect.querySelector('option[value="custom"]');
        if (opt) opt.textContent = picked;
      }
      const confirmed = await showConfirm(t('settings.dataLocationConfirm'));
      if (!confirmed) {
        const { mode: curMode } = await window.api.dataLocation.get();
        dlSelect.value = curMode;
        return;
      }
      const result = await window.api.dataLocation.set(mode, _dlCustomPath);
      if (!result?.ok) {
        await showAlert(t('settings.dataLocationError'));
        const { mode: curMode } = await window.api.dataLocation.get();
        dlSelect.value = curMode;
      }
    });
  }
}
