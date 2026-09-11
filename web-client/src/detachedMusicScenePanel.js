// web-client/src/detachedMusicScenePanel.js
/**
 * detachedMusicScenePanel.js — one floating panel per detached music/
 * ambient scene. Content mirrors mixerPanel.js's channel/ambient strips
 * (same markup, minus config/FX/DnD, read-only names) but with no master
 * strip — a detached scene has no master fader, matching the desktop's
 * own musicScene.html. Width-locked resize (see detachedWindow.js's
 * computeLockedWidthResize) — same reasoning as the desktop's own
 * musicScene-entry.js: widening past the strips' natural width would
 * just reveal empty background.
 */
import { createDetachedPanel, computeLockedWidthResize } from './detachedWindow.js';

// Must match renderer/src/templates.js's MIXER_SIZE / renderer/src/ambientMixer.js's AMBIENT_SIZE.
const MIXER_SIZE   = 12;
const AMBIENT_SIZE = 12;

const PANEL_WIDTH   = 780; // matches mixer.js's detachMusicScene's own initial w
const PANEL_HEIGHT  = 640; // matches mixer.js's detachMusicScene's own initial h
const PANEL_MIN_HEIGHT = 300;

function _channelStripHtml(sceneId, i) {
  return `
    <div class="channel-strip" id="detMusic-${sceneId}-box-${i}" data-channel="${i}">
      <div class="ch-img-wrap"><img id="detMusic-${sceneId}-chImg-${i}" src="" alt=""></div>
      <div class="ch-top"></div>
      <input class="ch-name" id="detMusic-${sceneId}-channelName-${i}" type="text" spellcheck="false" readonly>
      <div class="ch-buttons">
        <button class="btn-mute" id="detMusic-${sceneId}-mute-${i}">M</button>
        <button class="btn-solo" id="detMusic-${sceneId}-solo-${i}">S</button>
        <button class="btn-link" id="detMusic-${sceneId}-link-${i}">L</button>
      </div>
      <div class="ch-fader-wrap">
        <input class="ch-fader" id="detMusic-${sceneId}-volumeSlider-${i}" type="range" min="0" max="125" step="1" value="100" orient="vertical">
      </div>
      <div class="ch-label">${i + 1}</div>
      <button class="btn-play-ch" id="detMusic-${sceneId}-playSound-${i}"><i class="fas fa-play"></i></button>
      <div class="ch-nav">
        <button class="btn-nav-ch" id="detMusic-${sceneId}-prevTrack-${i}" title="Предыдущий трек">‹</button>
        <button class="btn-nav-ch" id="detMusic-${sceneId}-nextTrack-${i}" title="Следующий трек">›</button>
      </div>
    </div>`;
}

function _ambientStripHtml(sceneId, i) {
  return `
    <div class="amb-strip" id="detMusic-${sceneId}-ambBox-${i}">
      <div class="amb-img-wrap"><img id="detMusic-${sceneId}-ambImg-${i}" src="" alt=""></div>
      <input class="ch-name" id="detMusic-${sceneId}-ambName-${i}" type="text" spellcheck="false" readonly>
      <div class="amb-fader-wrap">
        <input class="amb-fader" id="detMusic-${sceneId}-ambSlider-${i}" type="range" min="0" max="125" step="1" value="100" orient="vertical">
      </div>
      <button class="btn-play-ch" id="detMusic-${sceneId}-ambPlay-${i}"><i class="fas fa-play"></i></button>
      <div class="ch-label">A${i + 1}</div>
    </div>`;
}

function _setColor(el, on, onColor, offColor) { if (el) el.style.backgroundColor = on ? onColor : offColor; }

/**
 * Creates a panel for one detached music scene.
 * @param {string} sceneId
 * @param {string} title
 * @param {{left:number, top:number}} pos - where to place the new panel
 * @param {(cmd:object) => void} send
 * @returns {{ render: (scene:object, trackCount:number, hideMsl:boolean) => void, destroy: () => void }}
 */
export function createMusicScenePanel(sceneId, title, pos, send) {
  const panel = createDetachedPanel({
    id: `music-${sceneId}`,
    title,
    left: pos.left, top: pos.top,
    width: PANEL_WIDTH, height: PANEL_HEIGHT,
    onResize: (ctx) => ({
      width: ctx.startWidth,
      height: computeLockedWidthResize({
        startHeight: ctx.startHeight, top: ctx.top, dy: ctx.dy,
        canvasHeight: ctx.canvasRect.height, minHeight: PANEL_MIN_HEIGHT,
      }).height,
    }),
    onClose: () => send({ type: 'scene:reattach', sceneId }),
  });

  const chRow  = document.createElement('div');
  chRow.id = `detMusic-${sceneId}-channel-strip-row`;
  chRow.style.display = 'flex';
  chRow.style.flexDirection = 'row';
  chRow.style.flex = '1';
  chRow.style.minHeight = '0';
  chRow.style.padding = '8px 6px';
  chRow.style.gap = '4px';

  const ambRow = document.createElement('div');
  ambRow.id = `detMusic-${sceneId}-ambient-strip-row`;
  ambRow.style.display = 'flex';
  ambRow.style.flexDirection = 'row';
  ambRow.style.flex = '1';
  ambRow.style.minHeight = '0';
  ambRow.style.padding = '7.5px 6px';
  ambRow.style.gap = '4px';
  panel.bodyEl.appendChild(chRow);
  panel.bodyEl.appendChild(ambRow);

  chRow.innerHTML  = Array.from({ length: MIXER_SIZE },   (_, i) => _channelStripHtml(sceneId, i)).join('');
  ambRow.innerHTML = Array.from({ length: AMBIENT_SIZE }, (_, i) => _ambientStripHtml(sceneId, i)).join('');

  let lastScene = null;

  for (let i = 0; i < MIXER_SIZE; i++) {
    document.getElementById(`detMusic-${sceneId}-volumeSlider-${i}`).addEventListener('input', (e) => {
      send({ type: 'sceneCh:volume', sceneId, target: 'ch', index: i, value: e.target.value / 100 });
    });
    document.getElementById(`detMusic-${sceneId}-mute-${i}`).addEventListener('click', () => send({ type: 'sceneCh:mute', sceneId, index: i }));
    document.getElementById(`detMusic-${sceneId}-solo-${i}`).addEventListener('click', () => send({ type: 'sceneCh:solo', sceneId, index: i }));
    document.getElementById(`detMusic-${sceneId}-link-${i}`).addEventListener('click', () => send({ type: 'sceneCh:link', sceneId, index: i }));
    document.getElementById(`detMusic-${sceneId}-playSound-${i}`).addEventListener('click', () => send({ type: 'sceneCh:play', sceneId, target: 'ch', index: i }));
    document.getElementById(`detMusic-${sceneId}-prevTrack-${i}`).addEventListener('click', () => send({ type: 'sceneCh:prev', sceneId, index: i }));
    document.getElementById(`detMusic-${sceneId}-nextTrack-${i}`).addEventListener('click', () => send({ type: 'sceneCh:next', sceneId, index: i }));
  }
  for (let i = 0; i < AMBIENT_SIZE; i++) {
    document.getElementById(`detMusic-${sceneId}-ambSlider-${i}`).addEventListener('input', (e) => {
      send({ type: 'sceneCh:volume', sceneId, target: 'amb', index: i, value: e.target.value / 100 });
    });
    document.getElementById(`detMusic-${sceneId}-ambPlay-${i}`).addEventListener('click', () => send({ type: 'sceneCh:play', sceneId, target: 'amb', index: i }));
  }

  function render(scene, trackCount, hideMsl) {
    lastScene = scene;
    document.body.classList.toggle('hide-msl', !!hideMsl); // global setting, same class the main window already toggles

    for (let i = 0; i < MIXER_SIZE; i++) {
      const ch = scene.channels[i];
      document.getElementById(`detMusic-${sceneId}-box-${i}`)?.classList.toggle('track-hidden', i >= trackCount);
      if (!ch) continue;
      const nameEl = document.getElementById(`detMusic-${sceneId}-channelName-${i}`);
      nameEl.value = ch.name; nameEl.title = ch.name;
      document.getElementById(`detMusic-${sceneId}-volumeSlider-${i}`).value = Math.round(ch.volume * 100);
      _setColor(document.getElementById(`detMusic-${sceneId}-mute-${i}`), ch.mute, '#ff0000', '#7f0000');
      _setColor(document.getElementById(`detMusic-${sceneId}-solo-${i}`), ch.solo, '#ffff00', '#7f7f00');
      _setColor(document.getElementById(`detMusic-${sceneId}-link-${i}`), ch.link, '#1496ff', '#0820cc');
      document.getElementById(`detMusic-${sceneId}-playSound-${i}`).innerHTML = ch.playing
        ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';
      document.getElementById(`detMusic-${sceneId}-box-${i}`)?.classList.toggle('is-playing', !!ch.playing);
      const img = document.getElementById(`detMusic-${sceneId}-chImg-${i}`);
      const newSrc = ch.imageSrc ? `/api/image?path=${encodeURIComponent(ch.imageSrc)}` : '';
      if (img.dataset.src !== newSrc) { img.dataset.src = newSrc; img.src = newSrc; img.onerror = () => { img.src = ''; }; }
      document.getElementById(`detMusic-${sceneId}-box-${i}`)?.classList.toggle('has-image', !!ch.imageSrc);
    }

    for (let i = 0; i < AMBIENT_SIZE; i++) {
      const amb = scene.ambient[i];
      document.getElementById(`detMusic-${sceneId}-ambBox-${i}`)?.classList.toggle('track-hidden', i >= trackCount);
      if (!amb) continue;
      const nameEl = document.getElementById(`detMusic-${sceneId}-ambName-${i}`);
      nameEl.value = amb.name; nameEl.title = amb.name;
      document.getElementById(`detMusic-${sceneId}-ambSlider-${i}`).value = Math.round(amb.volume * 100);
      document.getElementById(`detMusic-${sceneId}-ambPlay-${i}`).innerHTML = amb.playing
        ? '<i class="fas fa-stop"></i>' : '<i class="fas fa-play"></i>';
      document.getElementById(`detMusic-${sceneId}-ambBox-${i}`)?.classList.toggle('is-playing', !!amb.playing);
      const img = document.getElementById(`detMusic-${sceneId}-ambImg-${i}`);
      const newSrc = amb.imageSrc ? `/api/image?path=${encodeURIComponent(amb.imageSrc)}` : '';
      if (img.dataset.src !== newSrc) { img.dataset.src = newSrc; img.src = newSrc; img.onerror = () => { img.src = ''; }; }
      document.getElementById(`detMusic-${sceneId}-ambBox-${i}`)?.classList.toggle('has-image', !!amb.imageSrc);
    }
  }

  return { render, destroy: panel.destroy };
}
