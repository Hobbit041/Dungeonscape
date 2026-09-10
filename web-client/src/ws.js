/**
 * ws.js — WebSocket connection to the Electron app's remote-control server.
 * `WebSocketImpl` is injectable for unit testing (tests/webClientWs.test.mjs);
 * app.js passes the real browser `WebSocket` global.
 */
export function createWsClient({ url, WebSocketImpl, onState, onEvent, onOpen, onClose, reconnectDelayMs = 2500 }) {
  let ws = null;
  let closedByUser = false;

  function connect() {
    ws = new WebSocketImpl(url);
    ws.addEventListener('open', () => onOpen?.());
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'state') onState?.(msg.data);
      else if (msg.type === 'event') onEvent?.(msg);
    });
    ws.addEventListener('close', () => {
      onClose?.();
      if (!closedByUser) setTimeout(connect, reconnectDelayMs);
    });
    ws.addEventListener('error', () => { /* close fires next */ });
  }
  connect();

  return {
    send(cmd) {
      if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(cmd));
    },
    close() {
      closedByUser = true;
      ws?.close();
    },
  };
}
