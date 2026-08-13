const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');
const Store = require('electron-store');

// ─── Early startup logger ─────────────────────────────────────────────────────
// Writes to os.tmpdir() so crashes before dataDir is resolved are still captured.
// macOS:   /var/folders/…/T/dungeonscape-startup.log
// Windows: %TEMP%\dungeonscape-startup.log

const _startupLogPath = path.join(os.tmpdir(), 'dungeonscape-startup.log');
function _slog(msg) {
  try { fs.appendFileSync(_startupLogPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8'); } catch (_) {}
}

process.on('uncaughtException',  (err) => _slog(`[CRASH] ${err.message}\n${err.stack || ''}`));
process.on('unhandledRejection', (reason) => {
  const msg   = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? '') : '';
  _slog(`[REJECTION] ${msg}\n${stack}`);
});

_slog('');
_slog('='.repeat(60));
_slog(`Startup — ${new Date().toISOString()}`);
_slog(`Platform: ${process.platform} / Arch: ${process.arch}`);
_slog(`OS: ${os.type()} ${os.release()}`);
_slog(`CPUs: ${os.cpus().length}x ${(os.cpus()[0]?.model || '?').trim()}`);
_slog(`RAM: ${Math.round(os.totalmem() / 1024 / 1024)} MB`);
_slog(`Node: ${process.versions.node} / Electron: ${process.versions.electron}`);
_slog(`Packaged: ${app.isPackaged}`);
_slog(`execPath: ${process.execPath}`);
try { _slog(`appData: ${app.getPath('appData')}`); } catch (e) { _slog(`appData ERROR: ${e.message}`); }
_slog(`homedir: ${os.homedir()}`);
_slog(`startupLog: ${_startupLogPath}`);

// ─── Data directory bootstrap ─────────────────────────────────────────────────

_slog('bootstrapping APPDATA_DIR…');
const APPDATA_DIR = path.join(app.getPath('appData'), 'Dungeonscape');
try { fs.mkdirSync(APPDATA_DIR, { recursive: true }); } catch (_) {}

// Migrate from old 'soundscape' folder on first run
const _oldConfig = path.join(app.getPath('appData'), 'soundscape', 'config.json');
const _newConfig = path.join(APPDATA_DIR, 'config.json');
if (fs.existsSync(_oldConfig) && !fs.existsSync(_newConfig)) {
  try { fs.copyFileSync(_oldConfig, _newConfig); } catch (_) {}
}

_slog('creating bootstrapStore…');
const bootstrapStore = new Store({ name: 'bootstrap', cwd: APPDATA_DIR });
const launcherDir    = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')))
  : __dirname;
_slog(`launcherDir: ${launcherDir}`);

function resolveDataDir(mode, customPath) {
  if (mode === 'launcher') return path.join(launcherDir, 'Dungeonscape');
  if (mode === 'custom' && customPath) return path.join(customPath, 'Dungeonscape');
  return APPDATA_DIR;
}

let _dataMode   = bootstrapStore.get('dataLocation', 'appdata');
let _customPath = bootstrapStore.get('customPath', '');
let dataDir     = resolveDataDir(_dataMode, _customPath);
_slog(`dataDir candidate: ${dataDir} (mode=${_dataMode})`);
try { fs.mkdirSync(dataDir, { recursive: true }); }
catch (_) {
  bootstrapStore.set('dataLocation', 'appdata');
  bootstrapStore.delete('customPath');
  dataDir = APPDATA_DIR;
  _slog(`dataDir fallback to APPDATA_DIR: ${dataDir}`);
}
_slog(`dataDir resolved: ${dataDir}`);

app.setPath('userData', dataDir);

const store = new Store({ cwd: dataDir });
_slog('store ready');

// ─── Translations ─────────────────────────────────────────────────────────────
const _translations = require(path.join(__dirname, 'translations', 'ru.json'));
const nd = _translations.nativeDialogs;

// Remove default application menu
Menu.setApplicationMenu(null);

// ─── Crash logger ─────────────────────────────────────────────────────────────

const LOG_PATH     = path.join(dataDir, 'crash.log');
const MAX_LOG_SIZE = 200 * 1024; // 200 KB — trim when exceeded

function writeLog(entry) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_SIZE) {
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      fs.writeFileSync(LOG_PATH, content.slice(Math.floor(content.length / 2)), 'utf8');
    }
    fs.appendFileSync(LOG_PATH, entry + '\n', 'utf8');
  } catch (_) {}
}

function formatCrash(source, message, stack, detail) {
  const ts    = new Date().toISOString();
  const lines = [`[${ts}] [${source}] ${message}`];
  if (detail) lines.push(`  at ${detail}`);
  if (stack)  lines.push(stack);
  lines.push('');
  return lines.join('\n');
}

process.on('uncaughtException',  (err) => {
  _slog(`[CRASH] ${err.message}\n${err.stack || ''}`);
  writeLog(formatCrash('MAIN', err.message, err.stack, ''));
});
process.on('unhandledRejection', (reason) => {
  const msg   = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? '') : '';
  _slog(`[REJECTION] ${msg}\n${stack}`);
  writeLog(formatCrash('MAIN/PROMISE', msg, stack, ''));
});

// ─────────────────────────────────────────────────────────────────────────────

let mainWindow;

// ─── Soundboard grid ↔ window coupling ───────────────────────────────────────
// Renderer reports the fixed chrome around the soundboard grid; we keep the
// window sized so grid cells are exactly square during manual resize.
let _sbLayout = null;   // { cols, rows, gap, fixedW, fixedH }

const SB_MIN_CELL = 50; // px — lower bound for a usable cell

// Fixed window-height floor for VERTICAL track orientation. Unlike width
// (which grows/shrinks with track count via _trackCountWidthDelta below),
// height in vertical mode never changes — tracks sit side by side, so
// adding/removing one only affects row width, never row height. Kept as a
// flat constant rather than derived from soundboard aspect math so it can't
// drift when track count or soundboard grid size changes (see
// _sbApplyMinSize's vertical branch).
const VERTICAL_MIN_HEIGHT = 559;

// Cumulative delta applied by the track-count-resize IPC below (0 at the
// default trackCount=8), one per axis. Only one is "live" at a time
// depending on orientation (width in vertical mode, height in horizontal),
// but both persist independently so switching orientation and switching
// back doesn't lose either one. _sbApplyMinSize() folds whichever is
// relevant into its own floor so a later soundboard-grid-size change
// doesn't silently discard it.
let _trackCountWidthDelta = 0;
let _trackCountHeightDelta = 0;
let _orientationHorizontal = false;

// The mixer's own measured width in horizontal mode (fixed per-column,
// independent of track count). Without this, _sbApplyMinSize() below had no
// mixer-driven floor at all on that axis, computing it purely from the
// soundboard's own square-cell aspect ratio — which let the window be
// resized narrower than the mixer's own strips actually need, compressing
// them. Updated only from orientation-resize (this dimension doesn't change
// with track count). Vertical mode has no equivalent — its non-track-count
// axis (height) is VERTICAL_MIN_HEIGHT, a flat constant, above.
let _horizontalContentWidth = 0;

function _sbHeightForWidth(w) {
  const { cols, rows, gap, fixedW, fixedH } = _sbLayout;
  const cell = (w - fixedW - (cols - 1) * gap) / cols;
  return Math.round(fixedH + rows * cell + (rows - 1) * gap);
}

function _sbWidthForHeight(h) {
  const { cols, rows, gap, fixedW, fixedH } = _sbLayout;
  const cell = (h - fixedH - (rows - 1) * gap) / rows;
  return Math.round(fixedW + cols * cell + (cols - 1) * gap);
}

function _sbApplyMinSize() {
  if (!_sbLayout || !mainWindow) return;
  const { cols, rows, gap, fixedW, fixedH } = _sbLayout;
  if (_orientationHorizontal) {
    // Height is the track-count-driven axis here; width follows via the
    // same square-cell aspect relationship, just computed from height —
    // floored against the mixer's own measured width so the soundboard's
    // aspect math can't shrink the window narrower than the strips need.
    const minH = Math.max(530 + _trackCountHeightDelta, Math.round(fixedH + rows * SB_MIN_CELL + (rows - 1) * gap));
    const minW = Math.max(_horizontalContentWidth, _sbWidthForHeight(minH));
    mainWindow.setMinimumSize(minW, minH);
  } else {
    // Height is fixed (VERTICAL_MIN_HEIGHT) rather than derived from the
    // soundboard's square-cell aspect ratio — only width is track-count-
    // driven in vertical mode, so the height floor must stay constant
    // regardless of track count OR soundboard grid size.
    const minW = Math.max(1000 + _trackCountWidthDelta, Math.round(fixedW + cols * SB_MIN_CELL + (cols - 1) * gap));
    mainWindow.setMinimumSize(minW, VERTICAL_MIN_HEIGHT);
  }
}

function createWindow() {
  _slog('createWindow()');
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 690,
    minWidth: 1000,
    minHeight: VERTICAL_MIN_HEIGHT,
    backgroundColor: '#1a1a1e',
    title: 'Dungeonscape',
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow local audio files to be loaded
      webSecurity: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  _slog('loadFile called');

  // Keep soundboard cells square during manual resize: the dragged axis wins,
  // the other follows. Skipped when maximized (grid centers with stripes).
  mainWindow.on('will-resize', (e, newBounds, details) => {
    if (!_sbLayout || mainWindow.isMaximized()) return;
    const edge = details?.edge ?? 'right';
    const b = { ...newBounds };
    if (edge === 'top' || edge === 'bottom') {
      b.width = _sbWidthForHeight(b.height);
    } else {
      b.height = _sbHeightForWidth(b.width);
    }
    e.preventDefault();
    mainWindow.setBounds(b);
  });
}

app.whenReady().then(() => {
  _slog('app.whenReady fired');
  writeLog(`\n${'='.repeat(60)}\nSession started ${new Date().toISOString()}\nstartupLog: ${_startupLogPath}\n${'='.repeat(60)}`);
  createWindow();
  // Restore renderer keyboard focus when the OS window regains focus
  mainWindow.on('focus', () => mainWindow.webContents.focus());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Window controls IPC ─────────────────────────────────────────────────────

ipcMain.handle('window-minimize',   () => mainWindow?.minimize());
ipcMain.handle('window-maximize',   () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('window-close',      () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ─── Soundboard grid layout IPC ──────────────────────────────────────────────

ipcMain.handle('sb-grid-layout', (_, layout) => {
  _sbLayout = layout;
  _sbApplyMinSize();
  if (layout.targetGridW != null && mainWindow && !mainWindow.isMaximized()) {
    const { screen } = require('electron');
    const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    // Clamp the target CELL to what fits the work area, so both grid axes
    // shrink together — independent width/height clamping would letterbox
    // the grid and ratchet the renderer's stored base cell size down.
    const { cols, rows, gap, fixedW, fixedH } = layout;
    const cellTarget = (layout.targetGridW - (cols - 1) * gap) / cols;
    const cellMax = Math.min(
      (wa.width  - fixedW - (cols - 1) * gap) / cols,
      (wa.height - fixedH - (rows - 1) * gap) / rows,
    );
    const cell = Math.min(cellTarget, cellMax);
    // Floor against the CURRENT minimum size (just recomputed above by
    // _sbApplyMinSize(), which folds in _trackCountWidthDelta/HeightDelta)
    // rather than trusting setContentSize to clamp on its own — this square-
    // cell math has zero awareness of what the mixer column needs, and
    // without an explicit floor here it silently shrinks the window back
    // down whenever it disagrees with that requirement.
    const [minW, minH] = mainWindow.getMinimumSize();
    const w = Math.max(minW, Math.round(fixedW + cols * cell + (cols - 1) * gap));
    const h = Math.max(minH, Math.round(fixedH + rows * cell + (rows - 1) * gap));
    mainWindow.setContentSize(w, h);
  }
});

// ─── Track-count window resize IPC ───────────────────────────────────────────
// Vertical orientation only — horizontal's track-count changes go through
// orientation-resize instead (see MixerUI._applyTrackCount's own comment for
// why: a recompute-from-scratch there can't accumulate drift the way this
// handler's own delta bookkeeping can, which matters more in horizontal mode
// since track count drives its whole-window-height axis rather than just a
// share preserved alongside an untouched soundboard).
//
// Channel-strip width is fixed-per-item (unlike soundboard cells), so unlike
// the sb-grid-layout coupling above this needs no aspect-ratio math: the
// renderer measures the actual pixel delta from toggling strip visibility
// and we just apply that same delta to the window's width and minimum width.
ipcMain.handle('track-count-resize', (_, delta) => {
  if (!mainWindow || !delta) return;

  _trackCountWidthDelta += delta;

  if (_sbLayout) {
    // Soundboard state exists — let _sbApplyMinSize() be the single source
    // of truth for minimum size, so it accounts for both constraints
    // instead of the two systems overwriting each other's minimumSize.
    _sbApplyMinSize();
  } else {
    const [curMinW, curMinH] = mainWindow.getMinimumSize();
    // 600 is only an emergency floor (guards against a degenerate 0/negative
    // min size) — real per-track-count minimums always sit comfortably above it.
    mainWindow.setMinimumSize(Math.max(600, curMinW + delta), curMinH);
  }

  // Grow/shrink actual bounds by the SAME delta just applied to the minimum
  // (floored at that fresh minimum, not snapped to it) — this preserves the
  // soundboard's own share of the window untouched. Track count only
  // changes how much the MIXER column needs; the soundboard's available
  // width (window width minus that mixer need) has no reason to move at
  // all, per the mixer's own fixed-per-item strip width (see this handler's
  // own header comment). Snapping straight to minW instead (as an earlier
  // version did) discarded any extra width the window had gained from
  // elsewhere — e.g. the settings panel's "Restore window size" action,
  // which deliberately widens the window so the soundboard grid has no
  // letterbox gap at the current height — silently shrinking the soundboard
  // back into a gap on the very next track-count change.
  const [minW] = mainWindow.getMinimumSize();
  const b = mainWindow.getBounds();
  const newWidth = Math.max(minW, b.width + delta);
  const bounds = { ...b, width: newWidth };

  // Keep the window on-screen if growing it would push an edge past the
  // display's work area (e.g. window sitting near that edge already).
  if (!mainWindow.isMaximized()) {
    const { screen } = require('electron');
    const wa = screen.getDisplayMatching(b).workArea;
    if (bounds.x + newWidth > wa.x + wa.width) {
      bounds.x = Math.max(wa.x, wa.x + wa.width - newWidth);
    }
  }

  mainWindow.setBounds(bounds);
});

// ─── Orientation-switch window resize IPC ────────────────────────────────────
// Switching orientation flips which axis is track-count-driven. contentWidth
// is always the mixer's raw own-width measurement (not a delta) — used
// as-is for horizontal's _horizontalContentWidth floor. This matters: an
// earlier version derived the persisted delta from the window's post-resize
// bounds, which _sbApplyMinSize() can already have inflated above the
// mixer's true need (its floor is a max() against the soundboard's own
// square-cell minimum). Feeding that back in as if it were the mixer's own
// requirement created a ratchet — each toggle could only hold or grow the
// minimum size, never shrink it back down, because the previous toggle's
// soundboard-inflated bounds got relabeled as "what the mixer needs" and
// then compounded further on the next round. Deriving the active axis
// purely from a fresh DOM measurement breaks that feedback loop: it
// reflects only the current content, never a prior resize's outcome.
//
// HEIGHT (horizontal) arrives as an already-computed WINDOW-height delta
// (how much more/less than the mixer's CURRENTLY ALLOCATED share of the
// window its true content needs — see MixerUI._resizeOnce's own comment).
// An earlier version sent an absolute mixer-only content measurement
// instead and treated it as directly comparable to a window-height
// baseline (530) via subtraction — not the same quantity (the mixer's own
// content span excludes #header entirely), which undershot the true window
// height needed and left a scrollbar on the very strips it was supposed to
// fully reveal.
//
// WIDTH (vertical) arrives as widthTarget — already the exact
// _trackCountWidthDelta value, not a measurement to convert at all (see
// MixerUI._resizeOnce's own comment for why: no available content-box
// measurement reliably maps onto the 1000-at-8-tracks window-width baseline,
// so it's computed as a direct visible-track-count product instead). An
// earlier version tried the same window-relative-delta approach height
// uses, which relies on the mixer's width share being unambiguous — but
// #mixer-section's own scrollWidth (vertical mode stacks its children, so
// its width is whichever child happens to be widest — not guaranteed to be
// the channel-strip row) made that reference frame itself unstable,
// landing anywhere from ~20px to ~100px off and opening a letterbox gap
// above/below the soundboard grid (e.g. 895px instead of 1000px at 8
// tracks).
//
// Only the axis BECOMING active is updated — the other axis's delta is left
// untouched, still representing that orientation's own last-known-accurate
// need, so switching back to it later doesn't need to be re-measured to be
// correct in the meantime.
ipcMain.handle('orientation-resize', (_, { horizontal, contentWidth, heightDelta, widthTarget }) => {
  if (!mainWindow) return;
  _orientationHorizontal = !!horizontal;

  const hasMeasurement = contentWidth != null;
  if (hasMeasurement) {
    if (_orientationHorizontal) {
      const newWindowHeight = mainWindow.getBounds().height + Math.round(heightDelta ?? 0);
      _trackCountHeightDelta = newWindowHeight - 530;
      _horizontalContentWidth = Math.round(contentWidth);
    } else {
      // widthTarget is already the exact _trackCountWidthDelta value (see
      // MixerUI._resizeOnce's own comment for why it's computed as a direct
      // visible-track-count × per-track-width product rather than derived
      // from any single content-box measurement here).
      _trackCountWidthDelta = Math.round(widthTarget ?? 0);
    }
  }

  if (_sbLayout) {
    _sbApplyMinSize();
  } else if (hasMeasurement) {
    if (_orientationHorizontal) {
      const [curMinW] = mainWindow.getMinimumSize();
      mainWindow.setMinimumSize(curMinW, Math.max(400, 530 + _trackCountHeightDelta));
    } else {
      mainWindow.setMinimumSize(Math.max(600, 1000 + _trackCountWidthDelta), VERTICAL_MIN_HEIGHT);
    }
  }

  // The window should end up exactly at its minimum size after a switch —
  // skipped for the boot-time flag-sync call (resize:false, no measurement),
  // which fires before _applyTrackCount has hidden the boot-time track count
  // down to its real size, so any measurement taken here would be premature.
  if (hasMeasurement) {
    const [minW, minH] = mainWindow.getMinimumSize();
    mainWindow.setBounds({ ...mainWindow.getBounds(), width: minW, height: minH });
  }
});

// ─── Fader-size window restore IPC ───────────────────────────────────────────
// Settings-panel action (vertical orientation only): the renderer has already
// computed the exact height delta needed for music/ambient faders to land at
// their 140px cap (see MixerUI._restoreFaderWindowSize's own comment for the
// linear-ratio math) — this applies it to the window's height, then — same as
// will-resize's own bottom/top-edge drag case — re-derives WIDTH from that
// height via _sbWidthForHeight so the soundboard grid still fills its box
// with no letterbox gap. Track count's own width delta is untouched by this:
// _trackCountWidthDelta only tracks how much wider/narrower the MIXER's
// visible strips need, which hasn't changed — only the soundboard's share of
// the window has — so later track-count changes keep applying their own
// delta on top of whatever width this leaves behind, never touching height.
ipcMain.handle('restore-fader-window-size', (_, deltaHeight) => {
  if (!mainWindow || !deltaHeight) return;
  const [minW, minH] = mainWindow.getMinimumSize();
  const b = mainWindow.getBounds();
  const height = Math.max(minH, Math.round(b.height + deltaHeight));
  const width  = _sbLayout ? Math.max(minW, _sbWidthForHeight(height)) : b.width;
  const bounds = { ...b, width, height };

  // Keep the window on-screen if growing it would push an edge past the
  // display's work area (same safety net track-count-resize's own handler
  // uses below).
  if (!mainWindow.isMaximized()) {
    const { screen } = require('electron');
    const wa = screen.getDisplayMatching(b).workArea;
    if (bounds.x + width > wa.x + wa.width) {
      bounds.x = Math.max(wa.x, wa.x + wa.width - width);
    }
    if (bounds.y + height > wa.y + wa.height) {
      bounds.y = Math.max(wa.y, wa.y + wa.height - height);
    }
  }

  mainWindow.setBounds(bounds);
});

// ─── Storage IPC ─────────────────────────────────────────────────────────────

ipcMain.handle('store-get', (_, key, defaultValue) => {
  return store.get(key, defaultValue);
});

ipcMain.handle('store-set', (_, key, value) => {
  store.set(key, value);
});

ipcMain.handle('store-delete', (_, key) => {
  store.delete(key);
});

// ─── File System IPC ─────────────────────────────────────────────────────────

// Check if a file exists
ipcMain.handle('file-exists', (_, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
});

// Read all audio files from a folder
ipcMain.handle('read-folder', (_, folderPath) => {
  try {
    if (!fs.existsSync(folderPath)) return [];
    const audioExtensions = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.opus', '.webm'];
    const files = fs.readdirSync(folderPath);
    return files
      .filter(f => audioExtensions.includes(path.extname(f).toLowerCase()))
      .map(f => path.join(folderPath, f).replace(/\\/g, '/'));
  } catch {
    return [];
  }
});

// Open a native file picker dialog
ipcMain.handle('open-file-dialog', async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: options?.folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    filters: options?.folder
      ? []
      : options?.images
        ? [{ name: nd.imageFilesFilter, extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
        : [{ name: nd.audioFilesFilter, extensions: ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'webm'] }]
  });
  if (result.canceled) return null;
  return result.filePaths.map(p => p.replace(/\\/g, '/'));
});

// Save a .soundscapeData file
ipcMain.handle('save-soundscape-file', async (_, data, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: nd.exportSoundscapeTitle,
    defaultPath: (defaultName || 'soundscape') + '.soundscapeData',
    filters: [{ name: nd.soundscapeDataFilter, extensions: ['soundscapeData'] }]
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return true;
});

// Load a .soundscapeData file
ipcMain.handle('load-soundscape-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: nd.importSoundscapeTitle,
    filters: [{ name: nd.soundscapeDataFilter, extensions: ['soundscapeData', 'json'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  return JSON.parse(raw);
});

// Save a .midimap file
ipcMain.handle('save-midi-file', async (_, data) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: nd.exportMidiTitle,
    defaultPath: 'midi-mapping.midimap',
    filters: [{ name: nd.midiMappingFilter, extensions: ['midimap'] }]
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return true;
});

// Load a .midimap file
ipcMain.handle('load-midi-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: nd.importMidiTitle,
    filters: [{ name: nd.midiMappingFilter, extensions: ['midimap', 'json'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  return JSON.parse(raw);
});

// Batch file existence check: returns { [path]: boolean }
ipcMain.handle('check-files-exist', (_, paths) => {
  const result = {};
  for (const p of paths) {
    try { result[p] = fs.existsSync(p); }
    catch (_) { result[p] = false; }
  }
  return result;
});

// Search filenames in a folder and one level of subdirectories
// Returns { [filename]: foundAbsolutePath }
ipcMain.handle('find-files-in-folder', (_, folderPath, filenames) => {
  const nameSet = new Set(filenames);
  const found   = {};

  const scanDir = (dir) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && nameSet.has(e.name) && !(e.name in found)) {
          found[e.name] = path.join(dir, e.name).replace(/\\/g, '/');
        }
      }
    } catch (_) {}
  };

  scanDir(folderPath);
  try {
    for (const e of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (e.isDirectory()) scanDir(path.join(folderPath, e.name));
    }
  } catch (_) {}

  return found;
});

// Save a .soundscapeProfiles file (all profiles)
ipcMain.handle('save-profiles-file', async (_, data) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: nd.exportProfilesTitle,
    defaultPath: 'soundscape-profiles.soundscapeProfiles',
    filters: [{ name: nd.profilesDataFilter, extensions: ['soundscapeProfiles'] }]
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return true;
});

// Load a .soundscapeProfiles file
ipcMain.handle('load-profiles-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: nd.importProfilesTitle,
    filters: [{ name: nd.profilesDataFilter, extensions: ['soundscapeProfiles', 'json'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  return JSON.parse(raw);
});

// ─── Crash log IPC ───────────────────────────────────────────────────────────

ipcMain.handle('log-crash', (_, source, message, stack, detail) => {
  writeLog(formatCrash(source, message, stack, detail));
});

ipcMain.handle('get-log-path', () => LOG_PATH);

ipcMain.handle('open-log-folder', () => shell.showItemInFolder(LOG_PATH));

// ─── i18n IPC ─────────────────────────────────────────────────────────────────

ipcMain.handle('get-i18n', () => _translations);

// ─── App version ─────────────────────────────────────────────────────────────

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('shell-open-external', (_, url) => shell.openExternal(url));

// ─── Data location IPC ───────────────────────────────────────────────────────

ipcMain.handle('get-data-location', () => ({
  mode:       bootstrapStore.get('dataLocation', 'appdata'),
  customPath: bootstrapStore.get('customPath', ''),
  dataDir,
}));

ipcMain.handle('set-data-location', async (_, mode, customPath) => {
  const newDir = resolveDataDir(mode, customPath);
  try { fs.mkdirSync(newDir, { recursive: true }); }
  catch (_) { return { ok: false }; }

  const srcConfig = path.join(dataDir, 'config.json');
  const dstConfig = path.join(newDir, 'config.json');
  if (fs.existsSync(srcConfig) && !fs.existsSync(dstConfig)) {
    try { fs.copyFileSync(srcConfig, dstConfig); } catch (_) {}
  }

  const srcLog = path.join(dataDir, 'crash.log');
  const dstLog = path.join(newDir, 'crash.log');
  if (fs.existsSync(srcLog) && !fs.existsSync(dstLog)) {
    try { fs.copyFileSync(srcLog, dstLog); } catch (_) {}
  }

  bootstrapStore.set('dataLocation', mode);
  if (mode === 'custom') bootstrapStore.set('customPath', customPath);
  else bootstrapStore.delete('customPath');

  // Portable exes extract to %TEMP% before running, so process.execPath points
  // there — and the extracted name (Dungeonscape.exe) differs from the real
  // file on disk, so DIR + basename(execPath) does not exist. Relaunching the
  // temp copy dies when the portable launcher cleans up on quit; only
  // PORTABLE_EXECUTABLE_FILE reliably names the real exe.
  const realExe = app.isPackaged
    ? (process.env.PORTABLE_EXECUTABLE_FILE
       || (process.env.PORTABLE_EXECUTABLE_DIR
           ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, path.basename(process.execPath))
           : null))
    : null;
  if (realExe && fs.existsSync(realExe)) app.relaunch({ execPath: realExe });
  else app.relaunch();
  app.quit();
  return { ok: true };
});

ipcMain.handle('get-launcher-dir', () => launcherDir);

ipcMain.handle('pick-data-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ─── Web Remote Server ───────────────────────────────────────────────────────

const WEB_PORT = 3000;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

let _webServer = null;
let _wss       = null;
let _wsClient  = null;

function _getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function _serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function _startWebServer() {
  if (_webServer) return;

  _webServer = http.createServer((req, res) => {
    const url      = new URL(req.url, `http://localhost:${WEB_PORT}`);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      _serveFile(res, path.join(__dirname, 'web-client', 'index.html'), 'text/html; charset=utf-8');
    } else if (pathname === '/app.js') {
      _serveFile(res, path.join(__dirname, 'web-client', 'app.js'), 'application/javascript; charset=utf-8');
    } else if (pathname === '/style.css') {
      _serveFile(res, path.join(__dirname, 'renderer', 'style.css'), 'text/css; charset=utf-8');
    } else if (pathname === '/api/image') {
      const filePath = url.searchParams.get('path') || '';
      const ext = path.extname(filePath).toLowerCase();
      if (!filePath || !IMAGE_EXTS.has(ext)) { res.writeHead(404); res.end(); return; }
      try {
        if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': IMAGE_MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } catch { res.writeHead(500); res.end(); }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  _wss = new WebSocketServer({ server: _webServer });

  _wss.on('connection', (ws) => {
    if (_wsClient && _wsClient.readyState === 1 /* OPEN */) _wsClient.close();
    _wsClient = ws;

    // Ask renderer for current state snapshot
    mainWindow?.webContents.send('web-request-state');

    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        mainWindow?.webContents.send('web-command', cmd);
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => { if (_wsClient === ws) _wsClient = null; });
    ws.on('error', () => { if (_wsClient === ws) _wsClient = null; });
  });

  _webServer.listen(WEB_PORT);
}

function _stopWebServer() {
  if (_wsClient) { _wsClient.close(); _wsClient = null; }
  if (_wss)       { _wss.close(); _wss = null; }
  if (_webServer) { _webServer.close(); _webServer = null; }
}

ipcMain.handle('web-server-start', () => {
  _startWebServer();
  return { url: `http://${_getLocalIP()}:${WEB_PORT}` };
});

ipcMain.handle('web-server-stop', () => { _stopWebServer(); });

ipcMain.handle('web-broadcast', (_, state) => {
  if (_wsClient?.readyState === 1 /* OPEN */) {
    _wsClient.send(JSON.stringify({ type: 'state', data: state }));
  }
});

app.on('before-quit', () => { _stopWebServer(); });
