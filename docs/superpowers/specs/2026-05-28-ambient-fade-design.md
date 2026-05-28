# Ambient Track Fade-In/Fade-Out — Design Spec

**Date:** 2026-05-28  
**Status:** Approved

## Problem

Ambient tracks (`AmbientChannel`) start and stop instantly — no fading. Scene switches use `_fadeOrphan()` which manipulates raw `HTMLAudioElement.volume` via setInterval after detaching refs. Fade constants (`FADE_MS`, `FADE_STOP_MS`) are duplicated across `mixerUI.js`, `webBridge.js`, and `midi.js`.

## Goal

- Move shared fade constants to a single source of truth
- Add smooth WebAudio gain-based fade-in/fade-out to ambient tracks on play, stop, and scene switch
- Eliminate `_fadeOrphan()` usage for ambient channels in `mixer.js`
- Keep `channel.js` fade logic untouched (HTMLAudioElement.volume approach stays)

## New File: `renderer/src/audioFade.js`

```js
export const FADE_MS = 3000;       // crossfade between tracks
export const FADE_STOP_MS = 300;   // play/stop/scene switch

export function fadeGainNode(gainNode, targetValue, durationMs, audioCtx) {
  const now = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(targetValue, now + durationMs / 1000);
}
```

Uses native WebAudio `linearRampToValueAtTime` — no setInterval loops.

## Changes: `ambientMixer.js`

### `_startTrack(idx)` — fade-in

Before `audio.play()`, ramp gainNode from 0 to `settings.volume`:

```js
const ctx = this.ambientMixer.audioCtx;
this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
this.gainNode.gain.setValueAtTime(0, ctx.currentTime);
fadeGainNode(this.gainNode, this.settings.volume, FADE_STOP_MS, ctx);
```

### New method: `fadeOutAndStop(ms = FADE_STOP_MS)`

Orphan pattern via gainNode:

1. Schedule `fadeGainNode(gainNode, 0, ms, ctx)`
2. Immediately detach `this._audio` / `this._source` refs (null them out) — so `stop()` called by `configure()` is a no-op
3. `setTimeout(ms + 50)` — stop orphaned audio, disconnect source, restore `gainNode.gain` to `settings.volume`

### `stop()` — cancel any scheduled gain ramp

Before pausing audio, cancel scheduled gain values and snap to `settings.volume` so the next `play()` always starts from the correct base:

```js
this.gainNode.gain.cancelScheduledValues(ctx.currentTime);
this.gainNode.gain.setValueAtTime(this.settings.volume, ctx.currentTime);
```

## Changes: `mixer.js`

`switchScene()` replaces `_fadeOrphan()` calls for ambient channels with:

```js
this.ambientMixer.channels.forEach(ch => ch.fadeOutAndStop(FADE_STOP_MS));
```

`_fadeOrphan()` is kept for regular channel audio elements (they still use HTMLAudioElement.volume).

Import `FADE_STOP_MS` from `./audioFade.js`.

## Changes: Constants deduplication

`mixerUI.js`, `webBridge.js`, `midi.js` — remove local `FADE_MS` / `FADE_STOP_MS` definitions; import from `./audioFade.js`.

`channel.js` — same: import constants, keep all fade methods as-is.

## What Stays the Same

- `channel.js` fade logic (`_fadeAudioElement`, `_crossfadeTo`, `fadeOutAndStop`, `fade`) — untouched
- `Effects/gain.js` `ramp()` — untouched
- `_fadeOrphan()` in `mixer.js` — kept for channel audio elements only
- Ambient playlist cycling (`audio.onended`) — untouched

## File Summary

| File | Change |
|---|---|
| `renderer/src/audioFade.js` | **New** — constants + `fadeGainNode()` |
| `renderer/src/ambientMixer.js` | fade-in in `_startTrack`, new `fadeOutAndStop`, cancel ramp in `stop` |
| `renderer/src/mixer.js` | use `ch.fadeOutAndStop()` for ambient in `switchScene()` |
| `renderer/src/mixerUI.js` | import constants from `audioFade.js` |
| `renderer/src/webBridge.js` | import constants from `audioFade.js` |
| `renderer/src/midi.js` | import constants from `audioFade.js` |
| `renderer/src/channel.js` | import constants from `audioFade.js` (logic unchanged) |
