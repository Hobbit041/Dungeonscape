// web-client/src/mixerPanel.js
/**
 * mixerPanel.js — builds and binds the channel strips, ambient strips,
 * master strips, and scene tabs inside #app-window-body. Mirrors
 * renderer/index.html's markup minus config/FX buttons and DnD, with
 * read-only name fields — this is a remote-control mirror, not an
 * editing surface.
 */

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

/** Builds the static DOM once (12 channels + master, 12 ambient + master) and binds every control's click/input handler to `send`. Call once at startup, before the first render(). */
export function buildMixerPanel(send) {
  const chRow  = document.getElementById('channel-strip-row');
  const ambRow = document.getElementById('ambient-strip-row');

  chRow.innerHTML  = Array.from({ length: MIXER_SIZE }, (_, i) => _channelStripHtml(i)).join('') + _masterStripHtml();
  ambRow.innerHTML = Array.from({ length: AMBIENT_SIZE }, (_, i) => _ambientStripHtml(i)).join('') + _ambientMasterStripHtml();

  for (let i = 0; i < MIXER_SIZE; i++) {
    document.getElementById(`volumeSlider-${i}`).addEventListener('input', (e) => {
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

  document.getElementById('volumeSlider-master').addEventListener('input', (e) => {
    send({ type: 'master:volume', v: e.target.value / 100 });
  });
  document.getElementById('mute-master').addEventListener('click', () => send({ type: 'master:mute' }));
  document.getElementById('playMix').addEventListener('click', () => {
    send({ type: _lastState?.mixer.playing ? 'mixer:stopAll' : 'mixer:playAll' });
  });

  for (let i = 0; i < AMBIENT_SIZE; i++) {
    document.getElementById(`ambSlider-${i}`).addEventListener('input', (e) => {
      send({ type: 'ambient:volume', i, v: e.target.value / 100 });
    });
    document.getElementById(`ambPlay-${i}`).addEventListener('click', () => {
      const playing = _lastState?.ambient.channels[i]?.playing;
      send({ type: playing ? 'ambient:stop' : 'ambient:play', i });
    });
  }
  document.getElementById('ambSlider-master').addEventListener('input', (e) => {
    send({ type: 'ambient:masterVolume', v: e.target.value / 100 });
  });
}

/** Applies one state snapshot to the already-built DOM. Safe to call repeatedly. */
export function renderMixerPanel(state, send) {
  _lastState = state;

  document.getElementById('app-window-title-text').textContent = `♫ Dungeonscape — ${state.soundscapes[state.currentSoundscape]?.name ?? ''}`;

  document.body.classList.toggle('orientation-horizontal', state.orientation === 'horizontal');
  document.body.classList.toggle('hide-msl', !!state.hideMsl);

  for (let i = 0; i < MIXER_SIZE; i++) {
    const ch = state.mixer.channels[i];
    document.getElementById(`box-${i}`)?.classList.toggle('track-hidden', i >= state.trackCount);
    if (!ch) continue;

    const nameEl = document.getElementById(`channelName-${i}`);
    nameEl.value = ch.name; nameEl.title = ch.name;

    document.getElementById(`volumeSlider-${i}`).value = Math.round(ch.volume * 100);
    _setColor(document.getElementById(`mute-${i}`), ch.mute, '#ff0000', '#7f0000');
    _setColor(document.getElementById(`solo-${i}`), ch.solo, '#ffff00', '#7f7f00');
    _setColor(document.getElementById(`link-${i}`), ch.link, '#1496ff', '#0820cc');

    document.getElementById(`playSound-${i}`).innerHTML = ch.playing
      ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';
    document.getElementById(`box-${i}`)?.classList.toggle('is-playing', !!ch.playing);
  }

  document.getElementById('volumeSlider-master').value = Math.round(state.mixer.master.volume * 100);
  _setColor(document.getElementById('mute-master'), state.mixer.master.mute, '#ff0000', '#7f0000');
  document.getElementById('playMix').innerHTML = state.mixer.playing
    ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';

  document.getElementById('ambSlider-master').value = Math.round(state.ambient.masterVolume * 100);
  for (let i = 0; i < AMBIENT_SIZE; i++) {
    const amb = state.ambient.channels[i];
    document.getElementById(`ambBox-${i}`)?.classList.toggle('track-hidden', i >= state.trackCount);
    if (!amb) continue;

    const nameEl = document.getElementById(`ambName-${i}`);
    nameEl.value = amb.name; nameEl.title = amb.name;
    document.getElementById(`ambSlider-${i}`).value = Math.round(amb.volume * 100);
    document.getElementById(`ambPlay-${i}`).innerHTML = amb.playing
      ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';
    document.getElementById(`ambBox-${i}`)?.classList.toggle('is-playing', !!amb.playing);
  }

  _renderScenesRow(state, send);
}

function _renderScenesRow(state, send) {
  const row = document.getElementById('scenes-row');
  row.querySelectorAll('.scene-btn').forEach(el => el.remove());
  state.scenes.forEach((scene, idx) => {
    const btn = document.createElement('button');
    btn.className   = 'scene-btn' + (idx === state.currentScene ? ' scene-active' : '');
    btn.textContent = scene.name || `Сцена ${idx + 1}`;
    btn.addEventListener('click', () => {
      if (idx !== state.currentScene) send({ type: 'scene:switch', i: idx });
    });
    row.appendChild(btn);
  });
}
