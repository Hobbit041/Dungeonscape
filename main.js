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
  const { cols, gap, fixedW } = _sbLayout;
  // The resize constraint keeps the aspect fixed, so a min width alone
  // determines the min height via the same ratio.
  const minW = Math.max(1000, Math.round(fixedW + cols * SB_MIN_CELL + (cols - 1) * gap));
  mainWindow.setMinimumSize(minW, _sbHeightForWidth(minW));
}

function createWindow() {
  _slog('createWindow()');
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 690,
    minWidth: 1000,
    minHeight: 530,
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
    const w = Math.round(layout.fixedW + layout.targetGridW);
    const h = Math.round(layout.fixedH + layout.targetGridH);
    // Clamp to the current display's work area
    const { screen } = require('electron');
    const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    mainWindow.setContentSize(Math.min(w, wa.width), Math.min(h, wa.height));
  }
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

  // Portable exes extract to %TEMP% before running, so process.execPath points there.
  // PORTABLE_EXECUTABLE_DIR is the real location of the exe on disk.
  const realExe = app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, path.basename(process.execPath))
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
