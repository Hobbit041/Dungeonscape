// web-client/app.js — entry point for the web remote-control page.
import { createWsClient } from './src/ws.js';
import { initDesktopWindow } from './src/desktopWindow.js';
import { buildMixerPanel, renderMixerPanel } from './src/mixerPanel.js';
import { buildSoundboardPanel, renderSoundboardPanel, handleSoundboardEvent } from './src/soundboardPanel.js';

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
});

const ws = createWsClient({
  url: `ws://${location.hostname}:${location.port || 3000}`,
  WebSocketImpl: WebSocket,
  onOpen:  () => setStatus(true),
  onClose: () => setStatus(false),
  onState: (state) => {
    renderMixerPanel(state, ws.send);
    renderSoundboardPanel(state, ws.send);
  },
  onEvent: (evt) => handleSoundboardEvent(evt),
});

buildMixerPanel(ws.send);
buildSoundboardPanel(ws.send);
