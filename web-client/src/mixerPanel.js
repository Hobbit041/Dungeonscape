// web-client/src/mixerPanel.js
/**
 * mixerPanel.js — builds and binds the channel strips, ambient strips,
 * master strips, and scene tabs inside #app-window-body. Mirrors
 * renderer/index.html's markup minus config/FX buttons and DnD, with
 * read-only name fields — this is a remote-control mirror, not an
 * editing surface.
 */
import { bindLiveSlider, setSliderValue } from './liveSlider.js';
import { TITLE_TEXT_EL_ID } from './desktopWindow.js';

// Must match renderer/src/templates.js's MIXER_SIZE and
// renderer/src/ambientMixer.js's AMBIENT_SIZE — not imported because
// web-client is served standalone over HTTP, not bundled with renderer/src.
const MIXER_SIZE   = 12;
const AMBIENT_SIZE = 12;

function _channelStripHtml(i) {
  return `
    <div class="channel-strip" id="box-${i}" data-channel="${i}">
      <div class="ch-img-wrap"><img id="chImg-${i}" src="" alt=""></div>
      <div class="ch-top"></div>
      <input class="ch-name" id="channelName-${i}" type="text" spellcheck="false" readonly>
      <div class="ch-buttons">
        <button class="btn-mute" id="mute-${i}">M</button>
        <button class="btn-solo" id="solo-${i}">S</button>
        <button class="btn-link" id="link-${i}">L</button>
      </div>
      <div class="ch-fader-wrap">
        <input class="ch-fader" id="volumeSlider-${i}" type="range" min="0" max="125" step="1" value="100" orient="vertical">
      </div>
      <div class="ch-label">${i + 1}</div>
      <button class="btn-play-ch" id="playSound-${i}"><i class="fas fa-play"></i></button>
      <div class="ch-nav">
        <button class="btn-nav-ch" id="prevTrack-${i}" title="Предыдущий трек">‹</button>
        <button class="btn-nav-ch" id="nextTrack-${i}" title="Следующий трек">›</button>
      </div>
    </div>`;
}

function _masterStripHtml() {
  return `
    <div class="channel-strip master-strip" id="box-master">
      <div class="ch-top" style="justify-content:center"><span class="master-label-top">Мастер</span></div>
      <div class="ch-buttons" style="justify-content:center; margin-top:4px">
        <button class="btn-mute" id="mute-master">M</button>
      </div>
      <div class="ch-fader-wrap">
        <input class="ch-fader" id="volumeSlider-master" type="range" min="0" max="125" step="1" value="100" orient="vertical">
      </div>
      <div class="ch-label" style="font-size:9px; letter-spacing:1px; text-align:center">МУЗЫКА</div>
      <button class="btn-play btn-play-master" id="playMix"><i class="fas fa-play"></i></button>
    </div>`;
}

function _ambientStripHtml(i) {
  return `
    <div class="amb-strip" id="ambBox-${i}">
      <div class="amb-img-wrap"><img id="ambImg-${i}" src="" alt=""></div>
      <input class="ch-name" id="ambName-${i}" type="text" spellcheck="false" readonly>
      <div class="amb-fader-wrap">
        <input class="amb-fader" id="ambSlider-${i}" type="range" min="0" max="125" step="1" value="100" orient="vertical">
      </div>
      <button class="btn-play-ch" id="ambPlay-${i}"><i class="fas fa-play"></i></button>
      <div class="ch-label">A${i + 1}</div>
    </div>`;
}

function _ambientMasterStripHtml() {
  return `
    <div class="amb-strip amb-master-strip" id="ambBox-master">
      <div class="amb-master-label-wrap"><span class="master-label-top">Мастер</span></div>
      <div class="amb-fader-wrap">
        <input class="amb-fader" id="ambSlider-master" type="range" min="0" max="125" step="1" value="100" orient="vertical">
      </div>
      <div class="ch-label" style="font-size:9px; letter-spacing:1px; text-align:center">ФОНОВЫЕ</div>
    </div>`;
}

function _setColor(el, on, onColor, offColor) { if (el) el.style.backgroundColor = on ? onColor : offColor; }

let _lastState = null; // read by click handlers below to know current playing/toggle state

const SCENE_DRAG_THRESHOLD = 8; // px — below this, a pointerdown+up is a click, not a drag

/** Builds the static DOM once (12 channels + master, 12 ambient + master) and binds every control's click/input handler to `send`. Call once at startup, before the first render(). */
export function buildMixerPanel(send) {
  const chRow  = document.getElementById('channel-strip-row');
  const ambRow = document.getElementById('ambient-strip-row');

  chRow.innerHTML  = Array.from({ length: MIXER_SIZE }, (_, i) => _channelStripHtml(i)).join('') + _masterStripHtml();
  ambRow.innerHTML = Array.from({ length: AMBIENT_SIZE }, (_, i) => _ambientStripHtml(i)).join('') + _ambientMasterStripHtml();

  for (let i = 0; i < MIXER_SIZE; i++) {
    bindLiveSlider(document.getElementById(`volumeSlider-${i}`), (e) => {
      send({ type: 'mixer:volume', ch: i, v: e.target.value / 100 });
    });
    document.getElementById(`mute-${i}`).addEventListener('click', () => send({ type: 'mixer:mute', ch: i }));
    document.getElementById(`solo-${i}`).addEventListener('click', () => send({ type: 'mixer:solo', ch: i }));
    document.getElementById(`link-${i}`).addEventListener('click', () => send({ type: 'mixer:link', ch: i }));
    document.getElementById(`playSound-${i}`).addEventListener('click', () => {
      const playing = _lastState?.mixer.channels[i]?.playing;
      send({ type: playing ? 'mixer:stop' : 'mixer:play', ch: i });
    });
    document.getElementById(`prevTrack-${i}`).addEventListener('click', () => send({ type: 'mixer:prev', ch: i }));
    document.getElementById(`nextTrack-${i}`).addEventListener('click', () => send({ type: 'mixer:next', ch: i }));
  }

  bindLiveSlider(document.getElementById('volumeSlider-master'), (e) => {
    send({ type: 'master:volume', v: e.target.value / 100 });
  });
  document.getElementById('mute-master').addEventListener('click', () => send({ type: 'master:mute' }));
  document.getElementById('playMix').addEventListener('click', () => {
    send({ type: _lastState?.mixer.playing ? 'mixer:stopAll' : 'mixer:playAll' });
  });

  for (let i = 0; i < AMBIENT_SIZE; i++) {
    bindLiveSlider(document.getElementById(`ambSlider-${i}`), (e) => {
      send({ type: 'ambient:volume', i, v: e.target.value / 100 });
    });
    document.getElementById(`ambPlay-${i}`).addEventListener('click', () => {
      const playing = _lastState?.ambient.channels[i]?.playing;
      send({ type: playing ? 'ambient:stop' : 'ambient:play', i });
    });
  }
  bindLiveSlider(document.getElementById('ambSlider-master'), (e) => {
    send({ type: 'ambient:masterVolume', v: e.target.value / 100 });
  });
}

/** Applies one state snapshot to the already-built DOM. Safe to call repeatedly. */
export function renderMixerPanel(state, send) {
  _lastState = state;

  document.getElementById(TITLE_TEXT_EL_ID).textContent = `♫ Dungeonscape — ${state.soundscapes[state.currentSoundscape]?.name ?? ''}`;

  document.body.classList.toggle('orientation-horizontal', state.orientation === 'horizontal');
  document.body.classList.toggle('hide-msl', !!state.hideMsl);

  for (let i = 0; i < MIXER_SIZE; i++) {
    const ch = state.mixer.channels[i];
    document.getElementById(`box-${i}`)?.classList.toggle('track-hidden', i >= state.trackCount);
    if (!ch) continue;

    const nameEl = document.getElementById(`channelName-${i}`);
    nameEl.value = ch.name; nameEl.title = ch.name;

    const chImg = document.getElementById(`chImg-${i}`);
    const chImgSrc = ch.imageSrc ? `/api/image?path=${encodeURIComponent(ch.imageSrc)}` : '';
    if (chImg.dataset.src !== chImgSrc) {
      chImg.dataset.src = chImgSrc;
      chImg.src = chImgSrc;
      chImg.onerror = () => { chImg.src = ''; };
    }
    document.getElementById(`box-${i}`)?.classList.toggle('has-image', !!ch.imageSrc);

    setSliderValue(document.getElementById(`volumeSlider-${i}`), Math.round(ch.volume * 100));
    _setColor(document.getElementById(`mute-${i}`), ch.mute, '#ff0000', '#7f0000');
    _setColor(document.getElementById(`solo-${i}`), ch.solo, '#ffff00', '#7f7f00');
    _setColor(document.getElementById(`link-${i}`), ch.link, '#1496ff', '#0820cc');

    document.getElementById(`playSound-${i}`).innerHTML = ch.playing
      ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';
    document.getElementById(`box-${i}`)?.classList.toggle('is-playing', !!ch.playing);
  }

  setSliderValue(document.getElementById('volumeSlider-master'), Math.round(state.mixer.master.volume * 100));
  _setColor(document.getElementById('mute-master'), state.mixer.master.mute, '#ff0000', '#7f0000');
  document.getElementById('playMix').innerHTML = state.mixer.playing
    ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';

  setSliderValue(document.getElementById('ambSlider-master'), Math.round(state.ambient.masterVolume * 100));
  for (let i = 0; i < AMBIENT_SIZE; i++) {
    const amb = state.ambient.channels[i];
    document.getElementById(`ambBox-${i}`)?.classList.toggle('track-hidden', i >= state.trackCount);
    if (!amb) continue;

    const nameEl = document.getElementById(`ambName-${i}`);
    nameEl.value = amb.name; nameEl.title = amb.name;

    const ambImg = document.getElementById(`ambImg-${i}`);
    const ambImgSrc = amb.imageSrc ? `/api/image?path=${encodeURIComponent(amb.imageSrc)}` : '';
    if (ambImg.dataset.src !== ambImgSrc) {
      ambImg.dataset.src = ambImgSrc;
      ambImg.src = ambImgSrc;
      ambImg.onerror = () => { ambImg.src = ''; };
    }
    document.getElementById(`ambBox-${i}`)?.classList.toggle('has-image', !!amb.imageSrc);

    setSliderValue(document.getElementById(`ambSlider-${i}`), Math.round(amb.volume * 100));
    document.getElementById(`ambPlay-${i}`).innerHTML = amb.playing
      ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';
    document.getElementById(`ambBox-${i}`)?.classList.toggle('is-playing', !!amb.playing);
  }

  _renderScenesRow(state, send);
}

function _renderScenesRow(state, send) {
  renderSceneTabsRow(document.getElementById('scenes-row'), state.scenes, state.currentScene, {
    className: 'scene-btn',
    activeClass: 'scene-active',
    switchType: 'scene:switch',
    detachType: 'scene:detach',
    defaultName: (idx) => `Сцена ${idx + 1}`,
  }, send);
}

/**
 * Reconciles a scene-tabs row against `items` (each possibly {detached}),
 * reusing existing buttons by index so an in-progress drag's pointer
 * capture survives a poll-driven re-render (see bindSceneTabDrag's doc
 * comment above), then re-sorts the DOM to match `items`' order. Mirrors
 * renderer/src/mixerUI.js's own _renderScenes(), which needs this same
 * final re-sort step so a reattached scene's tab lands back at its
 * original position instead of always at the row's end. Shared by
 * mixerPanel.js's music scene tabs and soundboardPanel.js's soundboard
 * scene tabs.
 */
export function renderSceneTabsRow(row, items, activeIdx, { className, activeClass, switchType, detachType, defaultName }, send) {
  const existing = new Map(
    [...row.querySelectorAll(`.${className}[data-idx]`)].map(b => [+b.dataset.idx, b])
  );

  items.forEach((item, idx) => {
    if (item.detached) {
      existing.get(idx)?.remove();
      existing.delete(idx);
      return;
    }

    let btn = existing.get(idx);
    if (btn) {
      existing.delete(idx);
      btn.classList.toggle(activeClass, idx === activeIdx);
      btn.textContent = item.name || defaultName(idx);
    } else {
      btn = document.createElement('button');
      btn.dataset.idx = idx;
      btn.className = className + (idx === activeIdx ? ` ${activeClass}` : '');
      btn.textContent = item.name || defaultName(idx);
      bindSceneTabDrag(btn, idx, send, switchType, detachType, activeClass);
      row.appendChild(btn);
    }
  });

  existing.forEach(btn => btn.remove());

  // appendChild on an already-attached node moves it — walking indices in
  // order re-sorts the row to match `items` instead of leaving reused/newly
  // created buttons wherever they happened to land above. But appendChild
  // ALWAYS detaches-then-reinserts, even when a button is already exactly
  // where it belongs, and per the Pointer Events spec that implicitly ends
  // any active setPointerCapture() on it — silently killing a still-in-
  // progress press-and-hold-to-detach gesture on every ~250ms poll tick,
  // well before the user's hold ever turns into a drag-out. So: skip the
  // reorder entirely once the row is already in the right order (the
  // overwhelmingly common case — this only needs to do real work right
  // after a scene is added/removed/reattached).
  const sorted = [...row.querySelectorAll(`.${className}[data-idx]`)]
    .sort((a, b) => +a.dataset.idx - +b.dataset.idx);
  const alreadyInOrder = sorted.every((btn, i) => row.children[i] === btn);
  if (!alreadyInOrder) sorted.forEach(btn => row.appendChild(btn));
}

/**
 * Click switches the scene; dragging the tab out past #app-window's
 * bounds and releasing detaches it instead — mirrors the desktop's own
 * hold+drag-past-window-edge gesture. Shared by mixerPanel.js's music
 * scene tabs and soundboardPanel.js's soundboard scene tabs (same
 * mechanics, different WS command types/active-class names).
 *
 * Reads the button's OWN current active-class (via `activeClass`)
 * rather than a closed-over "current scene index" — the render
 * functions above REUSE existing button elements across renders
 * (rebuilding them every ~250ms poll would rip the element out from
 * under an in-progress drag gesture, breaking pointer capture), so a
 * value captured once at bind time would go stale the moment the
 * active scene changes without that particular button being rebuilt.
 */
export function bindSceneTabDrag(btn, idx, send, switchType, detachType, activeClass) {
  let dragState = null;
  let didDragOut = false;

  btn.addEventListener('pointerdown', (e) => {
    dragState = { startX: e.clientX, startY: e.clientY };
    didDragOut = false;
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.hypot(dx, dy) < SCENE_DRAG_THRESHOLD) return;
    const winRect = document.getElementById('app-window').getBoundingClientRect();
    didDragOut = e.clientX < winRect.left || e.clientX > winRect.right || e.clientY < winRect.top || e.clientY > winRect.bottom;
  });
  btn.addEventListener('pointerup', () => {
    if (didDragOut) {
      send({ type: detachType, i: idx });
    } else if (!btn.classList.contains(activeClass)) {
      send({ type: switchType, i: idx });
    }
    dragState = null;
    didDragOut = false;
  });
  btn.addEventListener('pointercancel', () => { dragState = null; didDragOut = false; });
}
