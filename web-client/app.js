// web-client/app.js — entry point for the web remote-control page.
import { createWsClient } from './src/ws.js';
import { initDesktopWindow, TITLE_TEXT_EL_ID } from './src/desktopWindow.js';
import { buildMixerPanel, renderMixerPanel } from './src/mixerPanel.js';
import { buildSoundboardPanel, renderSoundboardPanel, handleSoundboardEvent } from './src/soundboardPanel.js';
import { createMusicScenePanel } from './src/detachedMusicScenePanel.js';
import { createSoundboardScenePanel } from './src/detachedSoundboardScenePanel.js';

function setStatus(connected) {
  const el = document.getElementById('wsStatus');
  el.className   = connected ? 'connected' : 'disconnected';
  el.textContent = connected ? '● связь' : '● нет связи';
}

initDesktopWindow({
  windowEl:       document.getElementById('app-window'),
  titleBarEl:     document.getElementById('app-window-title'),
  resizeHandleEl: document.getElementById('app-window-resize-handle'),
  canvasEl:       document.getElementById('canvas'),
  minimizeBtnEl:  document.getElementById('app-window-minimize'),
  titleTextEl:    document.getElementById(TITLE_TEXT_EL_ID),
});

const openMusicPanels = new Map();      // sceneId -> panel returned by createMusicScenePanel
const openSoundboardPanels = new Map(); // sceneId -> panel returned by createSoundboardScenePanel
let nextPanelOffset = 0; // staggers newly-created panels so they don't stack exactly on top of each other

function _newPanelPos() {
  const offset = (nextPanelOffset++ % 6) * 24;
  return { left: 40 + offset, top: 40 + offset };
}

function _syncDetachedPanels(state, send) {
  const liveMusicIds = new Set(state.detachedMusicScenes.map(s => s.id));
  for (const [id, panel] of openMusicPanels) {
    if (!liveMusicIds.has(id)) { panel.destroy(); openMusicPanels.delete(id); }
  }
  for (const scene of state.detachedMusicScenes) {
    let panel = openMusicPanels.get(scene.id);
    if (!panel) {
      panel = createMusicScenePanel(scene.id, scene.name, _newPanelPos(), state.trackCount, send);
      openMusicPanels.set(scene.id, panel);
    }
    panel.render(scene, state.trackCount, state.hideMsl);
  }

  const liveSbIds = new Set(state.detachedSoundboardScenes.map(s => s.id));
  for (const [id, panel] of openSoundboardPanels) {
    if (!liveSbIds.has(id)) { panel.destroy(); openSoundboardPanels.delete(id); }
  }
  for (const scene of state.detachedSoundboardScenes) {
    let panel = openSoundboardPanels.get(scene.id);
    if (!panel) {
      const { cols, rows } = state.soundboard.grid;
      panel = createSoundboardScenePanel(scene.id, scene.name, _newPanelPos(), cols, rows, send);
      openSoundboardPanels.set(scene.id, panel);
    }
    panel.render(scene);
  }
}

const ws = createWsClient({
  url: `ws://${location.hostname}:${location.port || 3000}`,
  WebSocketImpl: WebSocket,
  onOpen:  () => setStatus(true),
  onClose: () => setStatus(false),
  onState: (state) => {
    renderMixerPanel(state, ws.send);
    renderSoundboardPanel(state, ws.send);
    _syncDetachedPanels(state, ws.send);
  },
  onEvent: (evt) => {
    if (evt.kind === 'soundboardFlash') {
      if (evt.sceneId) openSoundboardPanels.get(evt.sceneId)?.handleFlash(evt.i);
      else handleSoundboardEvent(evt);
    }
  },
});

buildMixerPanel(ws.send);
buildSoundboardPanel(ws.send);
