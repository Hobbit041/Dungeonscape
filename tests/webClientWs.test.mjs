import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWsClient } from '../web-client/src/ws.js';

/** Fake WebSocket: records sent messages, exposes _fire() to simulate server events. */
function makeFakeWebSocket() {
  const listeners = {};
  const ws = {
    readyState: 0, // CONNECTING
    sent: [],
    addEventListener(type, cb) { (listeners[type] ??= []).push(cb); },
    send(data) { ws.sent.push(data); },
    close() { ws.readyState = 3; ws._fire('close', {}); },
    _fire(type, evt) { (listeners[type] ?? []).forEach(cb => cb(evt)); },
    _open() { ws.readyState = 1; ws._fire('open', {}); },
  };
  return ws;
}

test('send() is a no-op before the socket is open', () => {
  let created;
  const FakeWebSocketImpl = function (url) { created = makeFakeWebSocket(); created.url = url; return created; };
  const client = createWsClient({ url: 'ws://x', WebSocketImpl: FakeWebSocketImpl });

  client.send({ type: 'mixer:mute', ch: 0 });
  assert.deepEqual(created.sent, []);
});

test('send() serializes and sends once the socket is open', () => {
  let created;
  const FakeWebSocketImpl = function () { created = makeFakeWebSocket(); return created; };
  const client = createWsClient({ url: 'ws://x', WebSocketImpl: FakeWebSocketImpl });

  created._open();
  client.send({ type: 'mixer:mute', ch: 0 });
  assert.deepEqual(created.sent, [JSON.stringify({ type: 'mixer:mute', ch: 0 })]);
});

test('a "state" message invokes onState with its data', () => {
  let created;
  const states = [];
  const FakeWebSocketImpl = function () { created = makeFakeWebSocket(); return created; };
  createWsClient({ url: 'ws://x', WebSocketImpl: FakeWebSocketImpl, onState: (s) => states.push(s) });

  created._fire('message', { data: JSON.stringify({ type: 'state', data: { foo: 1 } }) });
  assert.deepEqual(states, [{ foo: 1 }]);
});

test('an "event" message invokes onEvent with the whole payload', () => {
  let created;
  const events = [];
  const FakeWebSocketImpl = function () { created = makeFakeWebSocket(); return created; };
  createWsClient({ url: 'ws://x', WebSocketImpl: FakeWebSocketImpl, onEvent: (e) => events.push(e) });

  created._fire('message', { data: JSON.stringify({ type: 'event', kind: 'soundboardFlash', i: 3 }) });
  assert.deepEqual(events, [{ type: 'event', kind: 'soundboardFlash', i: 3 }]);
});

test('malformed JSON is ignored, not thrown', () => {
  let created;
  const FakeWebSocketImpl = function () { created = makeFakeWebSocket(); return created; };
  createWsClient({ url: 'ws://x', WebSocketImpl: FakeWebSocketImpl });

  assert.doesNotThrow(() => created._fire('message', { data: 'not json' }));
});

test('close() marks the socket closed and suppresses reconnect', () => {
  let createCount = 0;
  const FakeWebSocketImpl = function () { createCount++; return makeFakeWebSocket(); };
  const client = createWsClient({ url: 'ws://x', WebSocketImpl: FakeWebSocketImpl, reconnectDelayMs: 100000 });

  client.close();
  assert.equal(createCount, 1); // no reconnect attempt scheduled synchronously
});
