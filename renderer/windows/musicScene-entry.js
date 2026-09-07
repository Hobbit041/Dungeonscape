/**
 * musicScene-entry.js — bootstrap for a detached music/ambient scene window.
 *
 * Shows the full existing panel for every music channel and ambient track of
 * one scene — play/stop, mute/solo/link, volume, prev/next, image/name,
 * config/playlist/EQ buttons — but no scene-tab row and no global controls
 * (music master fader, ambient master fader, global play/stop): those stay
 * exclusively in the main window (see
 * docs/superpowers/specs/2026-09-04-detachable-music-ambient-scenes-design.md).
 * Audio plays from a second, parallel MusicScenePlayer instance living in the
 * MAIN window's renderer (see mixerUI.js's onMusicSceneDetached); this window
 * is a thin RPC view, reusing the exact channel-strip/amb-strip markup and
 * CSS classes from the main grid (renderer/index.html, renderer/style.css) so
 * it looks identical without needing its own stylesheet.
 *
 * Deliberately deferred: drag-and-drop of audio/image files from the OS
 * directly onto a strip here (not listed among the design doc's required
 * controls), and live-syncing the play/stop icon when playback stops for a
 * reason OTHER than clicking this window's own play button (e.g. a playlist
 * naturally reaching its end with no repeat) — the icon reflects direct
 * interaction correctly but won't self-correct without reopening the window
 * in that one case.
 */
import { initI18n, t } from '../src/i18n.js';

function _fileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|blob:)/i.test(p)) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

function _buildChannelStrip(i, ch) {
  return `
    <div class="channel-strip" id="box-${i}" data-channel="${i}">
      <div class="ch-img-wrap"><img id="chImg-${i}" src="" alt=""></div>
      <div class="ch-top">
        <button class="btn-config" id="config-${i}" title="${t('mixer.channelLoadAudioTitle')}"><i class="fas fa-folder-open"></i></button>
        <button class="btn-fx" id="fx-${i}">FX</button>
      </div>
      <input class="ch-name" id="channelName-${i}" type="text" spellcheck="false" value="${ch.name ?? ''}" title="${ch.name ?? ''}" placeholder="${t('mixer.channelNamePlaceholder', { n: i + 1 })}">
      <div class="ch-buttons">
        <button class="btn-mute" id="mute-${i}">M</button>
        <button class="btn-solo" id="solo-${i}">S</button>
        <button class="btn-link" id="link-${i}">L</button>
      </div>
      <div class="ch-fader-wrap"><input class="ch-fader" id="volumeSlider-${i}" type="range" min="0" max="125" step="1" value="${(ch.volume ?? 1) * 100}" orient="vertical"></div>
      <div class="ch-label">${i + 1}</div>
      <button class="btn-play-ch" id="playSound-${i}"><i class="fas fa-${ch.playing ? 'stop' : 'play'}"></i></button>
      <div class="ch-nav">
        <button class="btn-nav-ch" id="prevTrack-${i}" title="${t('mixer.prevTrack')}">‹</button>
        <button class="btn-nav-ch" id="nextTrack-${i}" title="${t('mixer.nextTrack')}">›</button>
      </div>
    </div>`;
}

function _buildAmbientStrip(i, amb) {
  return `
    <div class="amb-strip" id="ambBox-${i}">
      <div class="amb-img-wrap"><img id="ambImg-${i}" src="" alt=""></div>
      <button class="btn-config amb-cfg" id="ambConfig-${i}"><i class="fas fa-folder-open"></i></button>
      <input class="ch-name" id="ambName-${i}" type="text" spellcheck="false" value="${amb.name ?? ''}" title="${amb.name ?? ''}" placeholder="${t('ambient.channelNamePlaceholder', { n: i + 1 })}">
      <div class="amb-fader-wrap"><input class="amb-fader" id="ambSlider-${i}" type="range" min="0" max="125" step="1" value="${(amb.volume ?? 1) * 100}" orient="vertical"></div>
      <button class="btn-play-ch" id="ambPlay-${i}"><i class="fas fa-${amb.playing ? 'stop' : 'play'}"></i></button>
      <div class="ch-label">A${i + 1}</div>
    </div>`;
}

function _setColor(el, on, onColor, offColor) { if (el) el.style.backgroundColor = on ? onColor : offColor; }

window.api.childWindow.onInit(async (data = {}) => {
  try {
    await initI18n();
    const { key, sceneId, channels = [], ambient = [] } = data;

    const sendCall = (target, index, method, ...args) =>
      window.api.childWindow.send(key, { kind: 'call', target, index, method, args });
    const sendVolume = (target, index, value) =>
      window.api.childWindow.send(key, { kind: 'volume', target, index, value });
    const sendMeta = (type, payload = {}) =>
      window.api.childWindow.send(key, { kind: 'meta', type, ...payload });

    const chRow  = document.getElementById('channel-strip-row');
    const ambRow = document.getElementById('ambient-strip-row');
    chRow.innerHTML  = channels.map((ch, i) => _buildChannelStrip(i, ch)).join('');
    ambRow.innerHTML = ambient.map((amb, i) => _buildAmbientStrip(i, amb)).join('');

    // ── Channels ──
    channels.forEach((ch, i) => {
      if (ch.imageSrc) document.getElementById(`chImg-${i}`).src = _fileUrl(ch.imageSrc);
      document.getElementById(`box-${i}`)?.classList.toggle('has-image', !!ch.imageSrc);
      _setColor(document.getElementById(`mute-${i}`), ch.mute, '#ff0000', '#7f0000');
      _setColor(document.getElementById(`solo-${i}`), ch.solo, '#ffff00', '#7f7f00');
      _setColor(document.getElementById(`link-${i}`), ch.link, '#1496ff', '#0820cc');
      document.getElementById(`box-${i}`)?.classList.toggle('is-playing', !!ch.playing);

      let mute = ch.mute, solo = ch.solo, link = ch.link;

      document.getElementById(`volumeSlider-${i}`)?.addEventListener('input', (e) => {
        sendVolume('ch', i, e.target.value / 100);
      });
      document.getElementById(`mute-${i}`)?.addEventListener('click', () => {
        mute = !mute;
        _setColor(document.getElementById(`mute-${i}`), mute, '#ff0000', '#7f0000');
        sendCall('ch', i, 'toggleMute');
      });
      document.getElementById(`solo-${i}`)?.addEventListener('click', () => {
        solo = !solo;
        _setColor(document.getElementById(`solo-${i}`), solo, '#ffff00', '#7f7f00');
        sendCall('ch', i, 'toggleSolo');
      });
      document.getElementById(`link-${i}`)?.addEventListener('click', () => {
        link = !link;
        _setColor(document.getElementById(`link-${i}`), link, '#1496ff', '#0820cc');
        sendCall('ch', i, 'toggleLink');
      });
      document.getElementById(`playSound-${i}`)?.addEventListener('click', () => {
        sendCall('ch', i, 'togglePlay');
      });
      document.getElementById(`prevTrack-${i}`)?.addEventListener('click', () => {
        sendCall('ch', i, 'previous');
      });
      document.getElementById(`nextTrack-${i}`)?.addEventListener('click', () => {
        sendCall('ch', i, 'next');
      });
      document.getElementById(`config-${i}`)?.addEventListener('click', () => {
        sendMeta('openConfig', { target: 'ch', index: i });
      });
      document.getElementById(`fx-${i}`)?.addEventListener('click', () => {
        sendMeta('openFx', { index: i });
      });
      document.getElementById(`channelName-${i}`)?.addEventListener('change', (e) => {
        e.target.title = e.target.value;
        sendMeta('nameChanged', { target: 'ch', index: i, name: e.target.value });
      });
    });

    // ── Ambient ──
    ambient.forEach((amb, i) => {
      if (amb.imageSrc) document.getElementById(`ambImg-${i}`).src = _fileUrl(amb.imageSrc);
      document.getElementById(`ambBox-${i}`)?.classList.toggle('has-image', !!amb.imageSrc);
      document.getElementById(`ambBox-${i}`)?.classList.toggle('is-playing', !!amb.playing);

      document.getElementById(`ambSlider-${i}`)?.addEventListener('input', (e) => {
        sendVolume('amb', i, e.target.value / 100);
      });
      document.getElementById(`ambPlay-${i}`)?.addEventListener('click', () => {
        sendCall('amb', i, 'togglePlay');
      });
      document.getElementById(`ambConfig-${i}`)?.addEventListener('click', () => {
        sendMeta('openPlaylist', { target: 'amb', index: i });
      });
      document.getElementById(`ambBox-${i}`)?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        sendMeta('openPlaylist', { target: 'amb', index: i });
      });
      document.getElementById(`ambName-${i}`)?.addEventListener('change', (e) => {
        e.target.title = e.target.value;
        sendMeta('nameChanged', { target: 'amb', index: i, name: e.target.value });
      });
    });

    // Live updates pushed from the main window: playback started/stopped by
    // a direct click (see mixerUI.js's onMusicSceneDetached), or this
    // channel/track's image/name changed via its config/playlist dialog.
    window.api.childWindow.onPush((payload) => {
      if (payload.kind === 'state') {
        const boxId  = payload.target === 'amb' ? `ambBox-${payload.index}` : `box-${payload.index}`;
        const playId = payload.target === 'amb' ? `ambPlay-${payload.index}` : `playSound-${payload.index}`;
        document.getElementById(boxId)?.classList.toggle('is-playing', !!payload.playing);
        const playEl = document.getElementById(playId);
        if (playEl) playEl.innerHTML = `<i class="fas fa-${payload.playing ? 'stop' : 'play'}"></i>`;
      } else if (payload.kind === 'imageChanged') {
        const imgId = payload.target === 'amb' ? `ambImg-${payload.index}` : `chImg-${payload.index}`;
        const boxId = payload.target === 'amb' ? `ambBox-${payload.index}` : `box-${payload.index}`;
        const img = document.getElementById(imgId);
        if (img) img.src = _fileUrl(payload.src);
        document.getElementById(boxId)?.classList.toggle('has-image', !!payload.src);
      } else if (payload.kind === 'nameChanged') {
        const nameId = payload.target === 'amb' ? `ambName-${payload.index}` : `channelName-${payload.index}`;
        const el = document.getElementById(nameId);
        if (el) { el.value = payload.name; el.title = payload.name; }
      }
    });
  } catch (err) {
    console.error('[musicScene-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
