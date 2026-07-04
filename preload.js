const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('api', {

  // ─── Storage ──────────────────────────────────────────────────────────────
  store: {
    get: (key, defaultValue) => ipcRenderer.invoke('store-get', key, defaultValue),
    set: (key, value) => ipcRenderer.invoke('store-set', key, value),
    delete: (key) => ipcRenderer.invoke('store-delete', key),
  },

  // ─── File System ──────────────────────────────────────────────────────────
  fs: {
    /** Check if a file exists on disk */
    exists: (filePath) => ipcRenderer.invoke('file-exists', filePath),

    /** Returns array of audio file paths from a folder */
    readFolder: (folderPath) => ipcRenderer.invoke('read-folder', folderPath),

    /** Open native file/folder picker. Returns array of paths or null */
    openDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),

    /** Batch existence check: returns { [path]: boolean } */
    checkMany: (paths) => ipcRenderer.invoke('check-files-exist', paths),

    /** Search filenames in folder + 1 level of subdirs: { [filename]: foundPath } */
    findInFolder: (folderPath, names) => ipcRenderer.invoke('find-files-in-folder', folderPath, names),
  },

  // ─── Import / Export ──────────────────────────────────────────────────────
  data: {
    save: (data, defaultName) => ipcRenderer.invoke('save-soundscape-file', data, defaultName),
    load: () => ipcRenderer.invoke('load-soundscape-file'),
  },

  // ─── MIDI mapping import / export ─────────────────────────────────────────
  midi: {
    saveMappings: (data) => ipcRenderer.invoke('save-midi-file', data),
    loadMappings: () => ipcRenderer.invoke('load-midi-file'),
  },

  // ─── Profiles import / export ─────────────────────────────────────────────
  profiles: {
    save: (data) => ipcRenderer.invoke('save-profiles-file', data),
    load: () => ipcRenderer.invoke('load-profiles-file'),
  },

  // ─── Data location ────────────────────────────────────────────────────────
  dataLocation: {
    get:            ()                 => ipcRenderer.invoke('get-data-location'),
    set:            (mode, customPath) => ipcRenderer.invoke('set-data-location', mode, customPath),
    getLauncherDir: ()                 => ipcRenderer.invoke('get-launcher-dir'),
    pick:           ()                 => ipcRenderer.invoke('pick-data-folder'),
  },

  // ─── Window controls ──────────────────────────────────────────────────────
  win: {
    minimize:    () => ipcRenderer.invoke('window-minimize'),
    maximize:    () => ipcRenderer.invoke('window-maximize'),
    close:       () => ipcRenderer.invoke('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  },

  // ─── Crash log ────────────────────────────────────────────────────────────
  log: {
    crash:      (source, message, stack, detail) => ipcRenderer.invoke('log-crash', source, message, stack, detail),
    getPath:    () => ipcRenderer.invoke('get-log-path'),
    openFolder: () => ipcRenderer.invoke('open-log-folder'),
  },

  // ─── Translations ─────────────────────────────────────────────────────────
  getI18n: () => ipcRenderer.invoke('get-i18n'),

  // ─── App info ─────────────────────────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // ─── Shell ───────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell-open-external', url),
  },

  // ─── Soundboard grid / window coupling ────────────────────────────────────
  sbGrid: {
    updateLayout: (layout) => ipcRenderer.invoke('sb-grid-layout', layout),
  },

  // ─── Web Remote Control ───────────────────────────────────────────────────
  web: {
    serverStart:    ()      => ipcRenderer.invoke('web-server-start'),
    serverStop:     ()      => ipcRenderer.invoke('web-server-stop'),
    broadcast:      (state) => ipcRenderer.invoke('web-broadcast', state),
    onCommand:      (cb)    => ipcRenderer.on('web-command',       (_, cmd) => cb(cmd)),
    onRequestState: (cb)    => ipcRenderer.on('web-request-state', ()       => cb()),
  },
});
