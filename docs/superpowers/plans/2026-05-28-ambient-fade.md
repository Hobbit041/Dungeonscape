# Ambient Track Fade-In/Fade-Out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WebAudio gain-based fade-in/fade-out to ambient tracks on play, stop, and scene switch; centralise FADE_MS/FADE_STOP_MS into one shared file.

**Architecture:** New `audioFade.js` exports constants and a `fadeGainNode()` utility. `AmbientChannel` gains `fadeOutAndStop()` and a fade-in in `_startTrack()`. `mixer.js`'s `switchScene()` calls `fadeOutAndStop()` instead of `_fadeOrphan()` for ambient channels. Callers (`mixerUI`, `webBridge`, `midi`) drop local constant definitions and import from `audioFade.js`.

**Tech Stack:** Vanilla JS ES modules, Web Audio API (`linearRampToValueAtTime`)

---

## File Map

| File | Change |
|---|---|
| `renderer/src/audioFade.js` | **Create** — `FADE_MS`, `FADE_STOP_MS`, `fadeGainNode()` |
| `renderer/src/ambientMixer.js` | Add `fadeOutAndStop(ms)`, fade-in in `_startTrack()`, import constants |
| `renderer/src/mixer.js` | Replace ambient `_fadeOrphan` loop with `ch.fadeOutAndStop()` in `switchScene()` |
| `renderer/src/mixerUI.js` | Import constants from `audioFade.js`, remove local defs |
| `renderer/src/webBridge.js` | Import constants from `audioFade.js`, remove local defs |
| `renderer/src/midi.js` | Import `FADE_STOP_MS` from `audioFade.js`, remove local def |

---

## Task 1: Create `renderer/src/audioFade.js`

**Files:**
- Create: `renderer/src/audioFade.js`

- [ ] **Step 1: Create the file**

```js
export const FADE_MS      = 3000;  // crossfade between tracks (prev/next)
export const FADE_STOP_MS = 300;   // play/stop, scene switch

/**
 * Smoothly ramp a WebAudio GainNode to targetValue over durationMs milliseconds.
 * Cancels any in-flight ramp first so calls can be safely overlapped.
 */
export function fadeGainNode(gainNode, targetValue, durationMs, audioCtx) {
  const now = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(targetValue, now + Math.max(durationMs, 1) / 1000);
}
```

- [ ] **Step 2: Commit**

```bash
git add renderer/src/audioFade.js
git commit -m "feat: add audioFade.js — shared fade constants and fadeGainNode utility"
```

---

## Task 2: Update `ambientMixer.js` — fade-in, fadeOutAndStop, stop cleanup

**Files:**
- Modify: `renderer/src/ambientMixer.js`

### Step 1: Add import at the top

- [ ] In `ambientMixer.js`, after the existing two import lines (lines 16–17), add:

```js
import { FADE_STOP_MS, fadeGainNode } from './audioFade.js';
```

Result — top of file should look like:

```js
import { makeEmptyAmbient } from './templates.js';
import { pathToUrl } from './pathUtils.js';
import { FADE_STOP_MS, fadeGainNode } from './audioFade.js';
```

### Step 2: Add `fadeGainNode` call in `_startTrack()` for fade-in, and add `fadeIn` parameter

- [ ] Replace the existing `_startTrack(idx)` method (lines 82–115) with:

```js
_startTrack(idx, fadeIn = false) {
  // Clean up previous track
  if (this._audio) {
    this._audio.onended = null;
    this._audio.pause();
    this._audio.src = '';
    this._audio = null;
  }
  if (this._source) {
    try { this._source.disconnect(); } catch (_) {}
    this._source = null;
  }

  const url = this.sourceArray[idx];
  if (!url) { this.playing = false; return; }

  const ctx   = this.ambientMixer.audioCtx;
  const audio = new Audio(url);
  audio.crossOrigin = 'anonymous';
  this._audio  = audio;

  const src = ctx.createMediaElementSource(audio);
  src.connect(this.gainNode);
  this._source          = src;
  this.currentlyPlaying = idx;
  this.playing          = true;

  // Fade-in from silence on explicit play(); playlist cycling resumes at full volume
  this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
  if (fadeIn) {
    this.gainNode.gain.setValueAtTime(0, ctx.currentTime);
    fadeGainNode(this.gainNode, this.settings.volume, FADE_STOP_MS, ctx);
  } else {
    this.gainNode.gain.setValueAtTime(this.settings.volume, ctx.currentTime);
  }

  audio.play().catch(() => { this.playing = false; });

  audio.onended = () => {
    const next = (this.currentlyPlaying + 1) % Math.max(1, this.sourceArray.length);
    this._startTrack(next, false); // no fade-in on auto-cycle
  };
}
```

### Step 3: Update `play()` to pass `fadeIn = true`

- [ ] Replace the existing `play()` method (lines 62–65) with:

```js
play() {
  if (!this.sourceArray.length) return;
  this._startTrack(this.currentlyPlaying, true);
}
```

### Step 4: Update `stop()` to cancel any scheduled gain ramp before stopping

- [ ] Replace the existing `stop()` method (lines 67–80) with:

```js
stop() {
  if (!this.playing && !this._audio) return;
  this.playing = false;
  const ctx = this.ambientMixer.audioCtx;
  this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
  this.gainNode.gain.setValueAtTime(this.settings.volume, ctx.currentTime);
  if (this._audio) {
    this._audio.onended = null;
    this._audio.pause();
    this._audio.src = '';
    this._audio = null;
  }
  if (this._source) {
    try { this._source.disconnect(); } catch (_) {}
    this._source = null;
  }
}
```

### Step 5: Add `fadeOutAndStop()` method to `AmbientChannel`

- [ ] After the `stop()` method, add:

```js
/**
 * Fade gain to silence over `ms` ms, then stop the orphaned audio.
 * Immediately nulls _audio/_source so configure()'s stop() is a no-op.
 * Restores gainNode to settings.volume after cleanup (unless a new track
 * has started by then — _startTrack handles gain in that case).
 */
fadeOutAndStop(ms = FADE_STOP_MS) {
  if (!this._audio) return;
  const ctx    = this.ambientMixer.audioCtx;
  const audio  = this._audio;
  const source = this._source;

  fadeGainNode(this.gainNode, 0, ms, ctx);

  this._audio  = null;
  this._source = null;
  this.playing = false;

  setTimeout(() => {
    audio.onended = null;
    audio.pause();
    audio.src = '';
    try { source.disconnect(); } catch (_) {}
    if (!this._audio) {
      // No new track started — restore gain for next play()
      this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
      this.gainNode.gain.setValueAtTime(this.settings.volume, ctx.currentTime);
    }
  }, ms + 50);
}
```

- [ ] **Step 6: Commit**

```bash
git add renderer/src/ambientMixer.js
git commit -m "feat: ambient channels fade-in on play and fade-out on stop"
```

---

## Task 3: Update `mixer.js` — use `fadeOutAndStop()` for ambient in `switchScene()`

**Files:**
- Modify: `renderer/src/mixer.js:17` (remove local `FADE_MS`)
- Modify: `renderer/src/mixer.js:273-278` (ambient orphan loop in `switchScene()`)

### Step 1: Replace local `FADE_MS` constant with import

- [ ] Remove line 17:
```js
const FADE_MS = 300;
```

Add an import line at the top of the import block (after line 15, before the blank line at 16):

```js
import { FADE_STOP_MS } from './audioFade.js';
```

Result — import block should look like:

```js
import { Channel      } from './channel.js';
import { Soundboard   } from './soundboard.js';
import { AmbientMixer, AMBIENT_SIZE } from './ambientMixer.js';
import { Storage      } from './storage.js';
import { FADE_STOP_MS } from './audioFade.js';
import {
  MIXER_SIZE, SOUNDBOARD_SIZE,
  makeEmptyChannel, makeEmptyChannelArray,
  makeEmptyAmbient, makeEmptyAmbientArray,
  makeEmptySoundboardButton, makeEmptySoundboardArray
} from './templates.js';
```

### Step 2: Update `switchScene()` — replace ambient `_fadeOrphan` loop

- [ ] In `switchScene()`, find the ambient orphan block (currently lines 272–278):

```js
// Orphan Scene 1 ambient channels
for (const ch of this.ambientMixer.channels) {
  _fadeOrphan(ch._audio, ch._source, FADE_MS);
  ch._audio  = null;
  ch._source = null;
  ch.playing = false;
}
```

Replace it with:

```js
// Orphan Scene 1 ambient channels via gainNode fade
for (const ch of this.ambientMixer.channels) {
  ch.fadeOutAndStop(FADE_STOP_MS);
}
```

### Step 3: Update regular channel orphan call to use `FADE_STOP_MS`

- [ ] In `switchScene()`, the regular channel loop still calls `_fadeOrphan(ch.audioElement, ch.node, FADE_MS)`. Update the `FADE_MS` argument to `FADE_STOP_MS`:

```js
_fadeOrphan(ch.audioElement, ch.node, FADE_STOP_MS);
```

(`_fadeOrphan` itself stays — it's still needed for HTMLAudioElement channel tracks.)

- [ ] **Step 4: Commit**

```bash
git add renderer/src/mixer.js
git commit -m "refactor: switchScene uses fadeOutAndStop for ambient channels"
```

---

## Task 4: Deduplicate constants in `mixerUI.js`, `webBridge.js`, `midi.js`

**Files:**
- Modify: `renderer/src/mixerUI.js:29-30`
- Modify: `renderer/src/webBridge.js:11-12`
- Modify: `renderer/src/midi.js:20`

### `mixerUI.js`

- [ ] Remove lines 29–30:
```js
const FADE_MS      = 3000; // crossfade between tracks (prev/next)
const FADE_STOP_MS = 300;  // play/stop, mute, solo
```

Add to the import block (alongside existing imports at top of file):
```js
import { FADE_MS, FADE_STOP_MS } from './audioFade.js';
```

### `webBridge.js`

- [ ] Remove lines 11–12:
```js
const FADE_MS      = 3000;  // crossfade between tracks (prev/next)
const FADE_STOP_MS = 300;   // play/stop, mute, solo
```

Add to the import block:
```js
import { FADE_MS, FADE_STOP_MS } from './audioFade.js';
```

### `midi.js`

- [ ] Remove line 20:
```js
const FADE_STOP_MS = 300;
```

Add to the import block:
```js
import { FADE_STOP_MS } from './audioFade.js';
```

- [ ] **Commit:**

```bash
git add renderer/src/mixerUI.js renderer/src/webBridge.js renderer/src/midi.js
git commit -m "refactor: import FADE_MS/FADE_STOP_MS from audioFade.js"
```

---

## Task 5: Manual Verification

No automated test infrastructure in this project — verify manually in the running app.

- [ ] **Launch the app:** `npm start` (or however it's run)

- [ ] **Ambient fade-in on play:**
  1. Open a soundscape with ambient tracks configured
  2. Press play on an ambient channel
  3. Expected: volume ramps smoothly from silence to full over ~300 ms (not a hard click)

- [ ] **Ambient fade-out on stop:**
  1. While an ambient track is playing, press stop
  2. Expected: volume fades out over ~300 ms, then audio stops

- [ ] **Playlist cycling — no fade between tracks:**
  1. Configure an ambient channel with 2+ tracks, let it cycle automatically
  2. Expected: no dip to silence between tracks — next track starts at full volume immediately

- [ ] **Scene switch — ambient crossfade:**
  1. Set up two scenes each with ambient tracks playing (autoPlay)
  2. Switch scene
  3. Expected: old ambient fades out over ~300 ms while new ambient fades in — natural crossfade

- [ ] **MIDI / Web Remote — no regressions:**
  1. If MIDI controller is available: test mute and play/stop — should still use correct fade durations
  2. If web remote is open: trigger stop and prev/next — should work unchanged

- [ ] **setVolume during playback — no stuck gain:**
  1. While ambient is playing, drag the volume slider
  2. Expected: volume snaps to dragged value with no glitches or stuck ramps
