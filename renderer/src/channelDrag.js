/**
 * channelDrag.js
 * Hold-to-drag reordering for mixer channels, ambient channels, and soundboard buttons.
 *
 * Behavior:
 *   – LMB hold for 600ms on any non-interactive area of a panel → drag activates
 *   – Mouse leaving the element before 600ms cancels the hold (no accidental drags)
 *   – Element shrinks (scale 0.8) and follows cursor as a ghost clone
 *   – Original slot stays visible as an empty placeholder (layout preserved)
 *   – Same-type targets highlight yellow on hover; cross-type: no highlight, no drop
 *   – Drop on valid target  → data swapped between the two slots
 *   – Drop elsewhere        → ghost animates back to original position
 *   – Slot numbering (1–12, A1–A12, grid position) never changes — only content moves
 *   – Ambient audio transfer is seamless (Web Audio graph is rewired, no gap or restart)
 */

import { Storage } from './storage.js';
import { makeEmptyAmbient, SOUNDBOARD_SIZE, MIXER_SIZE } from './templates.js';

const HOLD_MS = 600;

export class ChannelDrag {
  constructor(mixer) {
    this.mixer  = mixer;
    this._ghost = null;
    this._state = null;   // { type, index, sourceEl, offsetX, offsetY, srcRect, currentTarget }
    this._onMove = this._onMove.bind(this);
    this._onUp   = this._onUp.bind(this);
  }

  // ─── Public ───────────────────────────────────────────────────────────────

  bindAll() {
    for (let i = 0; i < MIXER_SIZE; i++) {
      this._bind(document.getElementById(`box-${i}`),    'mixer',   i);
      this._bind(document.getElementById(`ambBox-${i}`), 'ambient', i);
    }
    for (let i = 0; i < SOUNDBOARD_SIZE; i++) {
      this._bind(document.getElementById(`sbButton-${i}`), 'soundboard', i);
    }
  }

  // ─── Binding ──────────────────────────────────────────────────────────────

  _bind(el, type, index) {
    if (!el) return;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // A previous drag is still active or settling (mid-swap await, or
      // animating back) — this._state/this._ghost are single shared fields,
      // so starting a second drag now would overwrite them and orphan the
      // first drag's ghost element permanently on screen.
      if (this._state) return;
      // Don't hijack clicks on interactive children
      if (e.target.closest('button, input, select, textarea, a')) return;

      // Channel strips contain <img> elements, which browsers make natively
      // draggable by default. Without this, the browser's own native image
      // drag can hijack the same mousedown+move gesture we're tracking here:
      // our ghost keeps following the cursor (mousemove still fires for a
      // while), but the final mouseup gets consumed by the native drag
      // session instead of reaching our document-level listener, so _onUp
      // never runs — the drag only resolves on the *next* click, which is
      // what resets the browser's native drag state.
      e.preventDefault();

      let curX = e.clientX;
      let curY = e.clientY;

      const trackMouse = (ev) => { curX = ev.clientX; curY = ev.clientY; };

      // Bug fix: cancel if mouse leaves the element before the hold timer fires.
      // mouseleave (unlike mouseout) only fires when the pointer truly leaves the
      // element's bounding box, not when it enters a child — so this is safe.
      const cancel = () => {
        clearTimeout(timer);
        document.removeEventListener('mousemove', trackMouse);
        document.removeEventListener('mouseup',   cancel);
        el.removeEventListener('mouseleave',      cancel);
      };

      document.addEventListener('mousemove', trackMouse);
      document.addEventListener('mouseup',   cancel);
      el.addEventListener('mouseleave',      cancel);

      const timer = setTimeout(() => {
        document.removeEventListener('mousemove', trackMouse);
        document.removeEventListener('mouseup',   cancel);
        el.removeEventListener('mouseleave',      cancel);
        const rect    = el.getBoundingClientRect();
        const offsetX = curX - rect.left;
        const offsetY = curY - rect.top;
        this._startDrag(el, type, index, offsetX, offsetY, curX, curY);
      }, HOLD_MS);
    });
  }

  // ─── Drag start ───────────────────────────────────────────────────────────

  _startDrag(el, type, index, offsetX, offsetY, curX, curY) {
    const rect = el.getBoundingClientRect();

    // Build ghost clone
    const ghost = el.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach(c => c.removeAttribute('id'));
    ghost.classList.add('ch-drag-ghost');
    Object.assign(ghost.style, {
      position:        'fixed',
      left:            `${rect.left}px`,
      top:             `${rect.top}px`,
      width:           `${rect.width}px`,
      height:          `${rect.height}px`,
      zIndex:          '9999',
      pointerEvents:   'none',
      opacity:         '0.85',
      transform:       'scale(1)',
      transformOrigin: 'center center',
      transition:      'transform 0.2s ease',
      boxSizing:       'border-box',
      overflow:        'hidden',
      margin:          '0',
    });
    document.body.appendChild(ghost);

    // Animate shrink
    requestAnimationFrame(() => { ghost.style.transform = 'scale(0.8)'; });

    // Hide source slot but keep its space
    el.classList.add('ch-drag-source');

    // Suppress the next click event so buttons don't fire on release
    const suppressClick = (evt) => {
      evt.stopPropagation();
      evt.preventDefault();
      el.removeEventListener('click', suppressClick, true);
    };
    el.addEventListener('click', suppressClick, true);

    this._ghost = ghost;
    this._state = { type, index, sourceEl: el, offsetX, offsetY, srcRect: rect, currentTarget: null };

    this._moveGhost(curX, curY);

    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('mouseup',   this._onUp);
  }

  // ─── Mouse tracking ───────────────────────────────────────────────────────

  _onMove(e) {
    if (!this._ghost || !this._state) return;
    this._moveGhost(e.clientX, e.clientY);

    const under  = document.elementFromPoint(e.clientX, e.clientY);
    const target = under ? this._findTarget(under, this._state.type) : null;
    const valid  = target && target !== this._state.sourceEl ? target : null;

    const prev = this._state.currentTarget;
    if (prev !== valid) {
      if (prev) prev.classList.remove('ch-drag-target');
      if (valid) valid.classList.add('ch-drag-target');
      this._state.currentTarget = valid;
    }
  }

  async _onUp() {
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('mouseup',   this._onUp);

    if (!this._state) { this._cleanup(); return; }

    const { type, index, sourceEl, currentTarget, srcRect } = this._state;

    if (currentTarget) currentTarget.classList.remove('ch-drag-target');

    let didSwap = false;
    if (currentTarget && currentTarget !== sourceEl) {
      const targetIndex = this._getIndex(currentTarget, type);
      if (targetIndex >= 0 && targetIndex !== index) {
        try {
          await this._doSwap(type, index, targetIndex);
          didSwap = true;
        } catch (err) {
          // Swap failed partway (storage I/O, audio load, …) — fall through
          // to _animateBack below instead of leaving the ghost stuck forever.
          console.error('ChannelDrag: swap failed, reverting', err);
        }
      }
    }

    if (didSwap) {
      this._cleanup();
    } else {
      this._animateBack(srcRect);
    }
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  _moveGhost(cx, cy) {
    if (!this._ghost || !this._state) return;
    const { offsetX, offsetY } = this._state;
    this._ghost.style.left = `${cx - offsetX}px`;
    this._ghost.style.top  = `${cy - offsetY}px`;
  }

  _findTarget(el, type) {
    if (type === 'mixer') {
      const strip = el.closest('.channel-strip');
      return (strip && !strip.classList.contains('master-strip')) ? strip : null;
    }
    if (type === 'ambient') {
      const strip = el.closest('.amb-strip');
      return (strip && !strip.classList.contains('amb-master-strip')) ? strip : null;
    }
    if (type === 'soundboard') {
      return el.closest('.sb-cell') ?? null;
    }
    return null;
  }

  _getIndex(el, type) {
    if (type === 'mixer')      return parseInt(el.dataset.channel ?? '-1');
    if (type === 'ambient')    return parseInt((el.id ?? '').replace('ambBox-', '') || '-1');
    if (type === 'soundboard') return parseInt((el.id ?? '').replace('sbButton-', '') || '-1');
    return -1;
  }

  _animateBack(rect) {
    if (!this._ghost) { this._cleanup(); return; }
    const ghost = this._ghost;
    ghost.style.transition = 'left 0.22s ease, top 0.22s ease, transform 0.22s ease';
    ghost.style.left      = `${rect.left}px`;
    ghost.style.top       = `${rect.top}px`;
    ghost.style.transform = 'scale(1)';
    setTimeout(() => this._cleanup(), 240);
  }

  _cleanup() {
    if (this._ghost) { this._ghost.remove(); this._ghost = null; }
    if (this._state) {
      this._state.sourceEl.classList.remove('ch-drag-source');
      this._state = null;
    }
  }

  // ─── Swap dispatch ────────────────────────────────────────────────────────

  async _doSwap(type, a, b) {
    if (type === 'mixer')           await this._swapMixer(a, b);
    else if (type === 'ambient')    await this._swapAmbient(a, b);
    else if (type === 'soundboard') await this._swapSoundboard(a, b);
    this.mixer.renderUI();
  }

  // ─── Mixer channel swap ───────────────────────────────────────────────────

  async _swapMixer(a, b) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;

    const wasA = this.mixer.channels[a].playing;
    const wasB = this.mixer.channels[b].playing;
    this.mixer.channels[a].stop(false);
    this.mixer.channels[b].stop(false);

    // Sync current scene snapshot from live data first
    const curSceneIdx = ss.currentScene ?? 0;
    if (ss.scenes?.[curSceneIdx]) {
      ss.scenes[curSceneIdx].channels = structuredClone(ss.channels);
    }

    // Swap in working copy, preserving slot indices
    const dA = structuredClone(ss.channels[a]);
    const dB = structuredClone(ss.channels[b]);
    dA.channel = b; if (dA.settings) dA.settings.channel = b;
    dB.channel = a; if (dB.settings) dB.settings.channel = a;
    ss.channels[a] = dB;
    ss.channels[b] = dA;

    // Swap in every scene snapshot
    for (const scene of (ss.scenes ?? [])) {
      if (!scene.channels) continue;
      const sA = structuredClone(scene.channels[a]);
      const sB = structuredClone(scene.channels[b]);
      if (!sA || !sB) continue;
      sA.channel = b; if (sA.settings) sA.settings.channel = b;
      sB.channel = a; if (sB.settings) sB.settings.channel = a;
      scene.channels[a] = sB;
      scene.channels[b] = sA;
    }

    soundscapes[this.mixer.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);

    // Reload audio for both slots
    await this.mixer.channels[a].setData(ss.channels[a]);
    await this.mixer.channels[b].setData(ss.channels[b]);

    // Restore playing state: A was playing → now plays from slot B, and vice-versa
    if (wasA) this.mixer.channels[b].play();
    if (wasB) this.mixer.channels[a].play();
  }

  // ─── Ambient channel swap ─────────────────────────────────────────────────

  async _swapAmbient(a, b) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss) return;

    const ambChA = this.mixer.ambientMixer?.channels[a];
    const ambChB = this.mixer.ambientMixer?.channels[b];
    const wasA = ambChA?.playing ?? false;
    const wasB = ambChB?.playing ?? false;
    // Do NOT pre-stop — audio will be transferred seamlessly below.

    // Sync current scene's ambient snapshot first
    const curSceneIdx = ss.currentScene ?? 0;
    if (ss.scenes?.[curSceneIdx]) {
      ss.scenes[curSceneIdx].ambient = structuredClone(ss.ambient ?? []);
    }

    const dA = structuredClone(ss.ambient?.[a] ?? makeEmptyAmbient(a));
    const dB = structuredClone(ss.ambient?.[b] ?? makeEmptyAmbient(b));
    dA.channel = b;
    dB.channel = a;

    if (!ss.ambient) ss.ambient = [];
    ss.ambient[a] = dB;
    ss.ambient[b] = dA;

    // Swap in every scene snapshot
    for (const scene of (ss.scenes ?? [])) {
      if (!scene.ambient) continue;
      const sA = structuredClone(scene.ambient[a] ?? makeEmptyAmbient(a));
      const sB = structuredClone(scene.ambient[b] ?? makeEmptyAmbient(b));
      sA.channel = b; sB.channel = a;
      scene.ambient[a] = sB;
      scene.ambient[b] = sA;
    }

    soundscapes[this.mixer.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);

    // Update channel metadata. AmbientChannel.setData does NOT stop audio —
    // it only updates settings, gainNode volume, and begins async URL resolution.
    ambChA?.setData(ss.ambient[a]);
    ambChB?.setData(ss.ambient[b]);

    // Rewire the Web Audio graph so the playing audio moves to the new slot
    // without any gap or restart. This also sets .playing correctly so that
    // the play-button state rendered by renderUI() is accurate.
    if (ambChA && ambChB) this._transferAmbientAudio(ambChA, ambChB, wasA, wasB);
  }

  /**
   * Seamlessly transfer the live audio element(s) between two AmbientChannels.
   *
   * AmbientChannel internals used (all exist on the class):
   *   ._audio          HTMLAudioElement currently playing (or null)
   *   ._source         MediaElementSourceNode connected to this.gainNode (or null)
   *   .gainNode        GainNode wired into the master gain chain
   *   .playing         boolean
   *   .currentlyPlaying index into sourceArray
   *   ._startTrack(n)  private method — starts the next track
   */
  _transferAmbientAudio(chA, chB, wasA, wasB) {
    // Snapshot raw internals before touching anything
    const aAudio = chA._audio,  aSource = chA._source,  aCurr = chA.currentlyPlaying;
    const bAudio = chB._audio,  bSource = chB._source,  bCurr = chB.currentlyPlaying;

    const disconnectAndClear = (ch) => {
      if (ch._audio) {
        ch._audio.onended = null;
        ch._audio.pause();
        ch._audio.src = '';
        ch._audio = null;
      }
      if (ch._source) {
        try { ch._source.disconnect(); } catch (_) {}
        ch._source = null;
      }
      ch.playing = false;
    };

    const wire = (audio, source, targetCh, currIdx) => {
      // Reconnect source node into target channel's gain node
      if (source) {
        try { source.disconnect(); } catch (_) {}
        source.connect(targetCh.gainNode);
      }
      targetCh._audio          = audio;
      targetCh._source         = source;
      targetCh.playing         = true;
      targetCh.currentlyPlaying = currIdx;
      // Replace onended so the next track plays through the new slot
      if (audio) {
        audio.onended = () => {
          const next = (targetCh.currentlyPlaying + 1) % Math.max(1, targetCh.sourceArray.length);
          targetCh._startTrack(next);
        };
      }
    };

    if (wasA && wasB) {
      // Both playing → cross-wire: A's audio goes to B, B's audio goes to A
      wire(aAudio, aSource, chB, aCurr);
      wire(bAudio, bSource, chA, bCurr);
    } else if (wasA) {
      // Only A was playing → move A's audio to B, stop any stale audio in B
      disconnectAndClear(chB);
      wire(aAudio, aSource, chB, aCurr);
      // Clear A (audio was moved, nothing to play here now)
      chA._audio  = null;
      chA._source = null;
      chA.playing = false;
    } else if (wasB) {
      // Only B was playing → move B's audio to A
      disconnectAndClear(chA);
      wire(bAudio, bSource, chA, bCurr);
      chB._audio  = null;
      chB._source = null;
      chB.playing = false;
    }
    // If neither was playing: nothing to transfer, both remain stopped
  }

  // ─── Soundboard button swap ───────────────────────────────────────────────

  async _swapSoundboard(a, b) {
    const soundscapes = await Storage.getSoundscapes();
    const ss = soundscapes[this.mixer.currentSoundscape];
    if (!ss?.soundboard) return;

    this.mixer.soundboard.channels[a]?.stop(true);
    this.mixer.soundboard.channels[b]?.stop(true);

    const dA = structuredClone(ss.soundboard[a]);
    const dB = structuredClone(ss.soundboard[b]);
    dA.channel = 100 + b;
    dB.channel = 100 + a;
    ss.soundboard[a] = dB;
    ss.soundboard[b] = dA;

    // Keep the current scene snapshot in sync with the working copy.
    // Other scenes are intentionally NOT touched — each soundboard scene
    // has independent content per slot, unlike mixer channels.
    const curSbIdx = ss.currentSbScene ?? 0;
    const curScene = ss.sbScenes?.[curSbIdx];
    if (curScene?.soundboard) {
      curScene.soundboard[a] = structuredClone(dB);
      curScene.soundboard[b] = structuredClone(dA);
    }

    soundscapes[this.mixer.currentSoundscape] = ss;
    await Storage.setSoundscapes(soundscapes);

    this.mixer.soundboard.configure(ss);
  }
}
