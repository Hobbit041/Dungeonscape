/**
 * web-client/app.js — browser remote control for Soundscapes.
 * Connects to the Electron app via WebSocket, receives state snapshots,
 * and sends commands back to control audio playback.
 */

'use strict';

// ─── State & WebSocket ────────────────────────────────────────────────────────

let state  = null;
let ws     = null;
const dragging = new Set(); // IDs of inputs currently being interacted with

function connect() {
  const wsUrl = `ws://${location.hostname}:${location.port || 3000}`;
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    setStatus(true);
  });

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        state = msg.data;
        render(state);
      }
    } catch { /* ignore malformed */ }
  });

  ws.addEventListener('close',  () => { setStatus(false); setTimeout(connect, 2500); });
  ws.addEventListener('error',  () => { /* close fires next */ });
}

function send(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
}

function setStatus(connected) {
  const el = document.getElementById('wsStatus');
  if (!el) return;
  if (connected) {
    el.className   = 'connected';
    el.textContent = '● связь';
  } else {
    el.className   = 'disconnected';
    el.textContent = '● нет связи';
  }
}

// ─── Soundboard grid construction ─────────────────────────────────────────────

let sbGridKey = '';   // "cols x rows" of the currently built grid

function buildSbCells(grid) {
  const cols = grid?.cols ?? 5;
  const rows = grid?.rows ?? 5;
  const key  = `${cols}x${rows}`;
  if (key === sbGridKey) return;
  sbGridKey = key;

  const el = document.getElementById('soundboard-grid');
  if (!el) return;
  el.style.setProperty('--sb-cols', cols);

  // Visible slot indices in a fixed 7-wide model (index = row*7 + col)
  let html = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * 7 + c;
      html += `<div class="sb-cell" id="sbButton-${i}">` +
              `<div class="sb-img-wrap"><img id="sbImg-${i}" src="" alt=""></div>` +
              `<div class="sb-label" id="sbLabel-${i}"></div></div>`;
    }
  }
  el.innerHTML = html;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * 7 + c;
      document.getElementById(`sbButton-${i}`)
        ?.addEventListener('click', () => send({ type: 'soundboard:trigger', i }));
    }
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function render(s) {
  renderHeader(s);
  renderChannels(s);
  renderMaster(s);
  renderAmbient(s);
  renderScenes(s);
  renderSoundboard(s);
  renderSbScenes(s);
}

function renderHeader(s) {
  const ss = s.soundscapes[s.currentSoundscape];
  const el = document.getElementById('soundscapeName');
  if (el) el.value = ss?.name ?? '';
}

function renderChannels(s) {
  for (let i = 0; i < 8; i++) {
    const ch = s.mixer.channels[i];
    if (!ch) continue;

    const nameEl = document.getElementById(`channelName-${i}`);
    if (nameEl) { nameEl.value = ch.name; nameEl.title = ch.name; }

    if (!dragging.has(`volumeSlider-${i}`)) {
      const sl = document.getElementById(`volumeSlider-${i}`);
      const nb = document.getElementById(`volumeNumber-${i}`);
      if (sl) sl.value = Math.round(ch.volume * 100);
      if (nb) nb.value = Math.round(ch.volume * 100);
    }

    _setColor(`mute-${i}`, ch.mute ? '#e03030' : '#7a1010');
    _setColor(`solo-${i}`, ch.solo ? '#e0e000' : '#6a6a00');
    _setColor(`link-${i}`, ch.link ? '#1496ff' : '#0820cc');

    const playEl = document.getElementById(`playSound-${i}`);
    if (playEl) playEl.innerHTML = ch.playing
      ? '■'
      : '▶';
  }
}

function renderMaster(s) {
  const m = s.mixer.master;

  const playEl = document.getElementById('playMix');
  if (playEl) playEl.innerHTML = s.mixer.playing ? '■' : '▶';

  if (!dragging.has('volumeSlider-master')) {
    const sl = document.getElementById('volumeSlider-master');
    const nb = document.getElementById('volumeNumber-master');
    if (sl) sl.value = Math.round(m.volume * 100);
    if (nb) nb.value = Math.round(m.volume * 100);
  }

  _setColor('mute-master', m.mute ? '#e03030' : '#7a1010');
}

function renderAmbient(s) {
  if (!dragging.has('ambSlider-master')) {
    const sl = document.getElementById('ambSlider-master');
    if (sl) sl.value = Math.round(s.ambient.masterVolume * 100);
  }

  for (let i = 0; i < s.ambient.channels.length; i++) {
    const ch = s.ambient.channels[i];

    const nameEl = document.getElementById(`ambName-${i}`);
    if (nameEl) { nameEl.value = ch.name; nameEl.title = ch.name; }

    if (!dragging.has(`ambSlider-${i}`)) {
      const sl = document.getElementById(`ambSlider-${i}`);
      if (sl) sl.value = Math.round(ch.volume * 100);
    }

    const playEl = document.getElementById(`ambPlay-${i}`);
    if (playEl) playEl.innerHTML = ch.playing
      ? '■'
      : '▶';
  }
}

function renderScenes(s) {
  const row = document.getElementById('scenes-row');
  if (!row) return;
  row.querySelectorAll('.scene-btn').forEach(el => el.remove());

  s.scenes.forEach((scene, idx) => {
    const btn = document.createElement('button');
    btn.className   = 'scene-btn' + (idx === s.currentScene ? ' scene-active' : '');
    btn.textContent = scene.name || `Сцена ${idx + 1}`;
    btn.addEventListener('click', () => {
      if (idx !== (state?.currentScene ?? -1)) send({ type: 'scene:switch', i: idx });
    });
    row.appendChild(btn);
  });
}

function renderSoundboard(s) {
  buildSbCells(s.soundboard.grid);

  if (!dragging.has('sbVolume')) {
    const sl = document.getElementById('sbVolume');
    // gain is 0–1.5 float; slider is 0–100
    if (sl) sl.value = Math.round(s.soundboard.gain / 1.5 * 100);
  }

  for (let i = 0; i < 49; i++) {
    const btn = s.soundboard.buttons[i];
    if (!btn) continue;

    const label = document.getElementById(`sbLabel-${i}`);
    if (label) label.textContent = btn.name ?? '';

    const img = document.getElementById(`sbImg-${i}`);
    if (img) {
      const newSrc = btn.imageSrc
        ? `/api/image?path=${encodeURIComponent(btn.imageSrc)}`
        : '';
      if (img.dataset.src !== newSrc) {
        img.dataset.src = newSrc;
        img.src         = newSrc;
        img.onerror     = () => { img.src = ''; };
      }
    }

    // Highlight looping buttons
    const cell = document.getElementById(`sbButton-${i}`);
    if (cell) {
      const rpt = s.soundboard.buttons[i]?.repeat?.repeat
               ?? s.soundboard.buttons[i]?.repeat
               ?? 'none';
      const isLoop = rpt === 'single' || rpt === 'all';
      cell.style.borderColor = isLoop ? 'yellow' : '';
      cell.style.boxShadow   = isLoop ? '0 0 8px yellow' : '';
    }
  }
}

function renderSbScenes(s) {
  const row = document.getElementById('sb-scenes-row');
  if (!row) return;
  row.querySelectorAll('.sb-scene-btn').forEach(el => el.remove());

  s.sbScenes.forEach((scene, idx) => {
    const btn = document.createElement('button');
    btn.className   = 'sb-scene-btn' + (idx === s.currentSbScene ? ' sb-scene-active' : '');
    btn.textContent = scene.name || `ЗП ${idx + 1}`;
    btn.addEventListener('click', () => send({ type: 'sbScene:switch', i: idx }));
    row.appendChild(btn);
  });
}

// ─── Event helpers ────────────────────────────────────────────────────────────

function _setColor(id, color) {
  const el = document.getElementById(id);
  if (el) el.style.backgroundColor = color;
}

/** Track pointer down/up to avoid overwriting a slider the user is dragging. */
function _trackDrag(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('pointerdown', () => dragging.add(id));
  el.addEventListener('pointerup',   () => dragging.delete(id));
  el.addEventListener('pointercancel', () => dragging.delete(id));
}

// ─── Event binding ────────────────────────────────────────────────────────────

function bindEvents() {
  // ── Channels ──
  for (let i = 0; i < 8; i++) bindChannel(i);

  // ── Master volume ──
  _trackDrag('volumeSlider-master');
  const msl = document.getElementById('volumeSlider-master');
  msl?.addEventListener('input', e => {
    const v = e.target.value / 100;
    const nb = document.getElementById('volumeNumber-master');
    if (nb) nb.value = Math.round(v * 100);
    send({ type: 'master:volume', v });
  });
  const mnb = document.getElementById('volumeNumber-master');
  mnb?.addEventListener('change', e => {
    const v = Math.min(1.25, Math.max(0, e.target.value / 100));
    const sl = document.getElementById('volumeSlider-master');
    if (sl) sl.value = Math.round(v * 100);
    send({ type: 'master:volume', v });
  });
  document.getElementById('mute-master')
    ?.addEventListener('click', () => send({ type: 'master:mute' }));

  // ── Global play ──
  document.getElementById('playMix')?.addEventListener('click', () => {
    if (state?.mixer.playing) send({ type: 'mixer:stopAll' });
    else send({ type: 'mixer:playAll' });
  });

  // ── Soundboard ──
  _trackDrag('sbVolume');
  document.getElementById('sbVolume')?.addEventListener('input', e => {
    const v = e.target.value / 100 * 1.5;
    send({ type: 'soundboard:gain', v });
  });
  document.getElementById('sbStopAll')
    ?.addEventListener('click', () => send({ type: 'soundboard:stopAll' }));
  // Soundboard cell clicks are bound inside buildSbCells()

  // ── Ambient ──
  _trackDrag('ambSlider-master');
  document.getElementById('ambSlider-master')?.addEventListener('input', e => {
    send({ type: 'ambient:masterVolume', v: e.target.value / 100 });
  });
  for (let i = 0; i < 8; i++) bindAmbient(i);

  // ── Soundscape list ──
  document.getElementById('soundscapeList')
    ?.addEventListener('click', toggleSoundscapeList);
}

function bindChannel(i) {
  const slId = `volumeSlider-${i}`;
  _trackDrag(slId);

  const sl = document.getElementById(slId);
  sl?.addEventListener('input', e => {
    const v = e.target.value / 100;
    const nb = document.getElementById(`volumeNumber-${i}`);
    if (nb) nb.value = Math.round(v * 100);
    send({ type: 'mixer:volume', ch: i, v });
  });

  const nb = document.getElementById(`volumeNumber-${i}`);
  nb?.addEventListener('change', e => {
    const v = Math.min(1.25, Math.max(0, e.target.value / 100));
    const slEl = document.getElementById(slId);
    if (slEl) slEl.value = Math.round(v * 100);
    send({ type: 'mixer:volume', ch: i, v });
  });

  document.getElementById(`mute-${i}`)
    ?.addEventListener('click', () => send({ type: 'mixer:mute', ch: i }));
  document.getElementById(`solo-${i}`)
    ?.addEventListener('click', () => send({ type: 'mixer:solo', ch: i }));
  document.getElementById(`link-${i}`)
    ?.addEventListener('click', () => send({ type: 'mixer:link', ch: i }));

  document.getElementById(`playSound-${i}`)?.addEventListener('click', () => {
    const playing = state?.mixer.channels[i]?.playing;
    send({ type: playing ? 'mixer:stop' : 'mixer:play', ch: i });
  });
  document.getElementById(`prevTrack-${i}`)
    ?.addEventListener('click', () => send({ type: 'mixer:prev', ch: i }));
  document.getElementById(`nextTrack-${i}`)
    ?.addEventListener('click', () => send({ type: 'mixer:next', ch: i }));
}

function bindAmbient(i) {
  const slId = `ambSlider-${i}`;
  _trackDrag(slId);

  document.getElementById(slId)?.addEventListener('input', e => {
    send({ type: 'ambient:volume', i, v: e.target.value / 100 });
  });

  document.getElementById(`ambPlay-${i}`)?.addEventListener('click', () => {
    const playing = state?.ambient.channels[i]?.playing;
    send({ type: playing ? 'ambient:stop' : 'ambient:play', i });
  });
}

// ─── Soundscape list panel ────────────────────────────────────────────────────

let _ssOutsideOff = null;

function toggleSoundscapeList() {
  const existing = document.getElementById('ssListPanel');
  if (existing) { existing.remove(); _ssOutsideOff?.(); return; }
  if (!state) return;

  const panel = document.createElement('div');
  panel.id        = 'ssListPanel';
  panel.className = 'ss-list-panel';

  const triggerBtn = document.getElementById('soundscapeList');
  if (triggerBtn) {
    const rect = triggerBtn.getBoundingClientRect();
    panel.style.top  = `${rect.bottom + 4}px`;
    panel.style.left = `${Math.max(4, rect.right - 220)}px`;
  }

  const scroll = document.createElement('div');
  scroll.className = 'ss-list-scroll';

  state.soundscapes.forEach((ss, idx) => {
    const row = document.createElement('div');
    row.className   = 'ss-row' + (idx === state.currentSoundscape ? ' ss-row-active' : '');
    row.textContent = ss.name || `Профиль ${idx + 1}`;
    row.addEventListener('click', () => {
      panel.remove();
      _ssOutsideOff?.();
      if (idx !== state.currentSoundscape) send({ type: 'soundscape:switch', i: idx });
    });
    scroll.appendChild(row);
  });

  panel.appendChild(scroll);
  document.body.appendChild(panel);

  const onOutside = (e) => {
    const p = document.getElementById('ssListPanel');
    const b = document.getElementById('soundscapeList');
    if (p && !p.contains(e.target) && !b?.contains(e.target)) {
      p.remove();
      document.removeEventListener('mousedown', onOutside);
      _ssOutsideOff = null;
    }
  };
  _ssOutsideOff = () => {
    document.removeEventListener('mousedown', onOutside);
    _ssOutsideOff = null;
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

bindEvents();
connect();
