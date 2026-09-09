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
 * Drag-and-drop of audio/image files (and Ctrl+drop folder-links) from the
 * OS onto a strip here has full parity with the main grid's own strips —
 * see docs/superpowers/specs/2026-09-09-detached-music-scene-drag-drop-design.md.
 * Files are converted to playlist items locally in this window's own
 * process (this file has no Node filesystem access itself beyond what
 * window.api exposes), then handed to the main renderer via 'meta' RPC
 * (dropImage/dropPlaylist/dropFolders), which applies them through the
 * same scene-aware Mixer methods the main grid's own drop handlers use.
 *
 * Deliberately deferred: live-syncing the play/stop icon when playback
 * stops for a reason OTHER than clicking this window's own play button
 * (e.g. a playlist naturally reaching its end with no repeat) — the icon
 * reflects direct interaction correctly but won't self-correct without
 * reopening the window in that one case. Mute/solo/link color DOES now
 * self-correct regardless of trigger source (own click or MIDI — see
 * Phase 3's muteState/soloState/linkState pushes), closing what used to be
 * the same class of gap as play/stop's remaining one above.
 */
import { initI18n, t } from '../src/i18n.js';
import { filesToPlaylistItems } from '../src/playlistDialog.js';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif']);
const AUDIO_EXT = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'webm']);

function _fileUrl(p) {
  if (!p) return '';
  if (/^(https?:|file:|blob:)/i.test(p)) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

/** Escapes '"' so a name containing one can't break out of an attribute value/close a tag early once inserted via innerHTML — same fix already used by soundboardConfigDialog.js/missingFilesDialog.js for this exact pattern. */
function _escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}

function _buildChannelStrip(i, ch) {
  const name = _escapeAttr(ch.name);
  return `
    <div class="channel-strip" id="box-${i}" data-channel="${i}">
      <div class="ch-img-wrap"><img id="chImg-${i}" src="" alt=""></div>
      <div class="ch-top">
        <button class="btn-config" id="config-${i}" title="${t('mixer.channelLoadAudioTitle')}"><i class="fas fa-folder-open"></i></button>
        <button class="btn-fx" id="fx-${i}">FX</button>
      </div>
      <input class="ch-name" id="channelName-${i}" type="text" spellcheck="false" value="${name}" title="${name}" placeholder="${t('mixer.channelNamePlaceholder', { n: i + 1 })}">
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
  const name = _escapeAttr(amb.name);
  return `
    <div class="amb-strip" id="ambBox-${i}">
      <div class="amb-img-wrap"><img id="ambImg-${i}" src="" alt=""></div>
      <button class="btn-config amb-cfg" id="ambConfig-${i}"><i class="fas fa-folder-open"></i></button>
      <input class="ch-name" id="ambName-${i}" type="text" spellcheck="false" value="${name}" title="${name}" placeholder="${t('ambient.channelNamePlaceholder', { n: i + 1 })}">
      <div class="amb-fader-wrap"><input class="amb-fader" id="ambSlider-${i}" type="range" min="0" max="125" step="1" value="${(amb.volume ?? 1) * 100}" orient="vertical"></div>
      <button class="btn-play-ch" id="ambPlay-${i}"><i class="fas fa-${amb.playing ? 'stop' : 'play'}"></i></button>
      <div class="ch-label">A${i + 1}</div>
    </div>`;
}

function _setColor(el, on, onColor, offColor) { if (el) el.style.backgroundColor = on ? onColor : offColor; }

/**
 * Every bindable MIDI target for one detached scene, mirroring
 * mixerUI.js's own MIDI_ENTITIES table shape but scoped to this one scene
 * (entity keys carry sceneId) and with no master-fader entries (a detached
 * scene has no master fader of its own — see this feature's design doc).
 */
function _detachedMidiEntities(sceneId, channelCount, ambientCount) {
  return [
    ...Array.from({ length: channelCount }, (_, i) => [
      { key: `ch-detached-${sceneId}-${i}-mute`,   targetId: `mute-${i}`,         type: 'noteon',    insertInside: true },
      { key: `ch-detached-${sceneId}-${i}-solo`,   targetId: `solo-${i}`,         type: 'noteon',    insertInside: true },
      { key: `ch-detached-${sceneId}-${i}-link`,   targetId: `link-${i}`,         type: 'noteon',    insertInside: true },
      { key: `ch-detached-${sceneId}-${i}-volume`, targetId: `volumeSlider-${i}`, type: 'volume_any' },
      { key: `ch-detached-${sceneId}-${i}-play`,   targetId: `playSound-${i}`,    type: 'noteon'    },
      { key: `ch-detached-${sceneId}-${i}-prev`,   targetId: `prevTrack-${i}`,    type: 'noteon',    insertInside: true },
      { key: `ch-detached-${sceneId}-${i}-next`,   targetId: `nextTrack-${i}`,    type: 'noteon',    insertInside: true },
    ]).flat(),
    ...Array.from({ length: ambientCount }, (_, i) => [
      { key: `amb-detached-${sceneId}-${i}-play`,   targetId: `ambPlay-${i}`,   type: 'noteon'     },
      { key: `amb-detached-${sceneId}-${i}-volume`, targetId: `ambSlider-${i}`, type: 'volume_any' },
    ]).flat(),
  ];
}

/** All four mapping types (unlike soundboardScene-entry.js's noteon-only version — channel/ambient volume sliders are volume_any, which can capture pitchbend or CC). Mirrors mixerUI.js's own _fmtMapping. */
function _fmtMapping(m) {
  if (!m) return '';
  if (m.type === 'noteon')      return t('midi.noteMapping',      { note: m.note, channel: m.channel + 1 });
  if (m.type === 'pitchbend')   return t('midi.pitchbendMapping', { channel: m.channel + 1 });
  if (m.type === 'cc_relative') return t('midi.ccMapping',        { cc: m.cc, channel: m.channel + 1 });
  if (m.type === 'cc_auto')     return t('midi.ccAutoMapping',    { cc: m.cc, channel: m.channel + 1 });
  return '';
}

function _clearMappingControls() {
  document.querySelectorAll('.midi-map-wrap').forEach(el => el.remove());
}

function _renderMappingControls(entities, mappings, sendMeta) {
  for (const entity of entities) {
    const target = document.getElementById(entity.targetId);
    if (!target || target.parentNode?.querySelector(`.midi-map-wrap[data-entity="${entity.key}"]`)) continue;
    const mapped = !!mappings[entity.key];

    const wrap = document.createElement('span');
    wrap.className = 'midi-map-wrap';
    wrap.dataset.entity = entity.key;

    const chain = document.createElement('button');
    chain.className = 'midi-chain-btn' + (mapped ? ' midi-chain-mapped' : '');
    chain.title = mapped
      ? t('midi.mappingLabel', { mapping: _fmtMapping(mappings[entity.key]) })
      : t('midi.bindTitle');
    chain.textContent = '🔗';

    const trash = document.createElement('button');
    trash.className   = 'midi-trash-btn';
    trash.title       = t('midi.removeTitle');
    trash.textContent = '🗑';
    trash.disabled    = !mapped;

    wrap.appendChild(chain);
    wrap.appendChild(trash);
    if (entity.insertInside) target.appendChild(wrap);
    else target.parentNode?.insertBefore(wrap, target.nextSibling);

    chain.addEventListener('click', e => {
      e.stopPropagation();
      // Toggle off if this control is the one currently listening (mirrors
      // mixerUI.js's own _onChainClick) — otherwise there'd be no way to
      // cancel a stray listening state short of exiting mapping mode
      // entirely. The DOM class is the source of truth for "am I the one
      // listening" here since this window has no direct read access to the
      // real MidiController's _listeningFor.
      if (chain.classList.contains('midi-chain-listening')) {
        sendMeta('stopListening', { key: entity.key });
      } else {
        chain.className = 'midi-chain-btn midi-chain-listening';
        sendMeta('startListening', { key: entity.key, mapType: entity.type });
      }
    });
    trash.addEventListener('click', e => {
      e.stopPropagation();
      sendMeta('clearMapping', { key: entity.key });
    });
  }
}

window.api.childWindow.onInit(async (data = {}) => {
  try {
    await initI18n();
    const { key, sceneId, channels = [], ambient = [], trackCount, mappingMode: initialMappingMode, mappings: initialMappings } = data;

    const sendCall = (target, index, method, ...args) =>
      window.api.childWindow.send(key, { kind: 'call', target, index, method, args });
    // Its own message kind rather than a plain {kind:'call', method:'setVolume'}
    // forward: unlike every other call here, a volume change needs mixer-level
    // link-aware branching on the receiving end (setLinkVolumes() vs. a plain
    // setVolume() + global-preset broadcast), not just ch[method](...args).
    const sendVolume = (target, index, value) =>
      window.api.childWindow.send(key, { kind: 'volume', target, index, value });
    const sendMeta = (type, payload = {}) =>
      window.api.childWindow.send(key, { kind: 'meta', type, ...payload });

    const chRow  = document.getElementById('channel-strip-row');
    const ambRow = document.getElementById('ambient-strip-row');
    chRow.innerHTML  = channels.map((ch, i) => _buildChannelStrip(i, ch)).join('');
    ambRow.innerHTML = ambient.map((amb, i) => _buildAmbientStrip(i, amb)).join('');

    // Same track-count setting the main grid uses to hide channels/ambient
    // tracks past this count (see mixerUI.js's _applyTrackCount) — reuses
    // its exact .track-hidden class, already styled by style.css, so no new
    // CSS is needed. A snapshot taken once at open time (see mixer.js's
    // detachMusicScene) — this window doesn't react live to the setting
    // changing later, matching its own "fixed size, no dynamic resize"
    // design (see this file's header).
    if (trackCount != null) {
      for (let i = trackCount; i < channels.length; i++) {
        document.getElementById(`box-${i}`)?.classList.add('track-hidden');
      }
      for (let i = trackCount; i < ambient.length; i++) {
        document.getElementById(`ambBox-${i}`)?.classList.add('track-hidden');
      }
    }

    // ── Channels ──
    // Hoisted out of the per-channel closure below so the onPush handler
    // (declared further down, outside this loop) can also read/update it —
    // needed once mute/solo/link state can change from OUTSIDE this
    // window's own click (MIDI dispatch — see mixerUI.js's
    // _detachedChannelToggleMute/Mixer.toggleSolo/toggleLink).
    const chanState = channels.map(ch => ({ mute: ch.mute, solo: ch.solo, link: ch.link }));
    channels.forEach((ch, i) => {
      if (ch.imageSrc) document.getElementById(`chImg-${i}`).src = _fileUrl(ch.imageSrc);
      document.getElementById(`box-${i}`)?.classList.toggle('has-image', !!ch.imageSrc);
      _setColor(document.getElementById(`mute-${i}`), ch.mute, '#ff0000', '#7f0000');
      _setColor(document.getElementById(`solo-${i}`), ch.solo, '#ffff00', '#7f7f00');
      _setColor(document.getElementById(`link-${i}`), ch.link, '#1496ff', '#0820cc');
      document.getElementById(`box-${i}`)?.classList.toggle('is-playing', !!ch.playing);

      document.getElementById(`volumeSlider-${i}`)?.addEventListener('input', (e) => {
        sendVolume('ch', i, e.target.value / 100);
      });
      document.getElementById(`mute-${i}`)?.addEventListener('click', () => {
        chanState[i].mute = !chanState[i].mute;
        _setColor(document.getElementById(`mute-${i}`), chanState[i].mute, '#ff0000', '#7f0000');
        sendCall('ch', i, 'toggleMute');
      });
      document.getElementById(`solo-${i}`)?.addEventListener('click', () => {
        chanState[i].solo = !chanState[i].solo;
        _setColor(document.getElementById(`solo-${i}`), chanState[i].solo, '#ffff00', '#7f7f00');
        sendCall('ch', i, 'toggleSolo');
      });
      document.getElementById(`link-${i}`)?.addEventListener('click', () => {
        chanState[i].link = !chanState[i].link;
        _setColor(document.getElementById(`link-${i}`), chanState[i].link, '#1496ff', '#0820cc');
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

      const box = document.getElementById(`box-${i}`);
      box?.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag-over'); });
      box?.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag-over'); });
      box?.addEventListener('drop', async (e) => {
        e.preventDefault();
        box.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;

        const firstPath = files[0].path;
        const firstExt  = (firstPath ?? files[0].name).split('.').pop().toLowerCase();
        if (IMAGE_EXT.has(firstExt)) {
          sendMeta('dropImage', { target: 'ch', index: i, path: firstPath });
          const imgEl = document.getElementById(`chImg-${i}`);
          if (imgEl) imgEl.src = _fileUrl(firstPath);
          box.classList.add('has-image');
          return;
        }

        if (e.ctrlKey) {
          const folders = files
            .filter(f => !AUDIO_EXT.has(f.name.split('.').pop().toLowerCase()))
            .map(f => ({ path: f.path, name: f.name }));
          if (folders.length) { sendMeta('dropFolders', { target: 'ch', index: i, folders }); return; }
        }

        const newItems = await filesToPlaylistItems(files);
        if (!newItems.length) return;
        sendMeta('dropPlaylist', { target: 'ch', index: i, items: newItems });
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

      const ambBox = document.getElementById(`ambBox-${i}`);
      ambBox?.addEventListener('dragover', e => { e.preventDefault(); ambBox.classList.add('drag-over'); });
      ambBox?.addEventListener('dragleave', (e) => { if (!ambBox.contains(e.relatedTarget)) ambBox.classList.remove('drag-over'); });
      ambBox?.addEventListener('drop', async (e) => {
        e.preventDefault();
        ambBox.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;

        const firstPath = files[0].path;
        const firstExt  = (firstPath ?? files[0].name).split('.').pop().toLowerCase();
        if (IMAGE_EXT.has(firstExt)) {
          sendMeta('dropImage', { target: 'amb', index: i, path: firstPath });
          const imgEl = document.getElementById(`ambImg-${i}`);
          if (imgEl) imgEl.src = _fileUrl(firstPath);
          ambBox.classList.add('has-image');
          return;
        }

        if (e.ctrlKey) {
          const folders = files
            .filter(f => !AUDIO_EXT.has(f.name.split('.').pop().toLowerCase()))
            .map(f => ({ path: f.path, name: f.name }));
          if (folders.length) { sendMeta('dropFolders', { target: 'amb', index: i, folders }); return; }
        }

        const newItems = await filesToPlaylistItems(files);
        if (!newItems.length) return;
        sendMeta('dropPlaylist', { target: 'amb', index: i, items: newItems });
      });
    });

    const entities = _detachedMidiEntities(sceneId, channels.length, ambient.length);
    let mappings = initialMappings ?? {};

    // Live updates pushed from the main window: playback started/stopped by
    // a direct click (see mixerUI.js's onMusicSceneDetached), or this
    // channel/track's image/name changed via its config/playlist dialog,
    // or a MIDI-triggered mute/solo/link/binding-mode change.
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
      } else if (payload.kind === 'muteState') {
        chanState[payload.index].mute = payload.mute;
        _setColor(document.getElementById(`mute-${payload.index}`), payload.mute, '#ff0000', '#7f0000');
      } else if (payload.kind === 'soloState') {
        chanState[payload.index].solo = payload.solo;
        _setColor(document.getElementById(`solo-${payload.index}`), payload.solo, '#ffff00', '#7f7f00');
      } else if (payload.kind === 'linkState') {
        chanState[payload.index].link = payload.link;
        _setColor(document.getElementById(`link-${payload.index}`), payload.link, '#1496ff', '#0820cc');
      } else if (payload.kind === 'mappingMode') {
        mappings = payload.mappings ?? {};
        if (payload.on) _renderMappingControls(entities, mappings, sendMeta);
        else _clearMappingControls();
      } else if (payload.kind === 'mappingCaptured') {
        mappings[payload.key] = payload.data;
        const wrap = document.querySelector(`.midi-map-wrap[data-entity="${payload.key}"]`);
        const chain = wrap?.querySelector('.midi-chain-btn');
        if (chain) {
          chain.className = 'midi-chain-btn midi-chain-mapped';
          chain.title = t('midi.mappingLabel', { mapping: _fmtMapping(payload.data) });
        }
        const trash = wrap?.querySelector('.midi-trash-btn');
        if (trash) trash.disabled = false;
      } else if (payload.kind === 'listeningStop') {
        if (!payload.mapped) delete mappings[payload.key];
        const wrap = document.querySelector(`.midi-map-wrap[data-entity="${payload.key}"]`);
        const chain = wrap?.querySelector('.midi-chain-btn');
        if (chain) chain.className = 'midi-chain-btn' + (payload.mapped ? ' midi-chain-mapped' : '');
        const trash = wrap?.querySelector('.midi-trash-btn');
        if (trash) trash.disabled = !payload.mapped;
      }
    });

    // Binding mode may already be on when this window opens (see Task 3's
    // detachMusicScene data-payload change) — render controls immediately
    // from the state that arrived via `data`, rather than waiting for a
    // later 'mappingMode' push that would only ever arrive from a
    // *subsequent* toggle. `onPush` above still handles that
    // subsequent-toggle case fine on its own, since by then this window is
    // fully loaded and listening.
    if (initialMappingMode) _renderMappingControls(entities, mappings, sendMeta);
  } catch (err) {
    console.error('[musicScene-entry] init failed:', err);
    document.body.textContent = `Error: ${err.message ?? err}`;
  }
});
