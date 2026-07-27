# Global Volume Sliders + Soundboard Scene Playback Continuity — Design Spec

**Date:** 2026-07-16
**Status:** Approved

## Addendum: fade-in for looped soundboard buttons

Follow-up request: a soundboard button set to repeat **"Зациклено"** (`repeat: 'single'`) should fade in on its initial press, not just fade out on stop — at half the fade-out duration (`FADE_STOP_MS / 2` = 150ms vs. the existing 300ms fade-out). Confirmed with the user: the fade-in applies **only to the very first press** (starting from silence), not to every loop restart — loop boundaries stay a hard cut, as today.

`Soundboard.playSound()` (`renderer/src/soundboard.js`) is the single call site where a button starts playing from a stopped state; `ch.play()` already accepts an optional `fadeInMs` (existing mechanism, ramps `audioElement.volume` via `_fadeAudioElement`, same technique `fadeOutAndStop()` uses). Changed to pass `FADE_STOP_MS / 2` when the button's `repeat.repeat === 'single'`, `0` otherwise:

```js
const rpt = ch.settings?.repeat?.repeat ?? ch.settings?.repeat ?? 'none';
ch.play(undefined, rpt === 'single' ? FADE_STOP_MS / 2 : 0);
```

Loop restarts happen inside `Channel._onTimeUpdate()`, a separate code path untouched by this change, so they structurally keep their existing hard-cut behavior. Verified live via CDP: `audioElement.volume` ramps 0→1 over ~150ms on initial press; fade-out on stop unaffected (~300ms, unchanged).

## Addendum: soundboard button border stuck yellow after stop

Bug: a soundboard button configured with repeat `single`/`all` ("Зациклено"/"Все файлы") kept its yellow border highlight forever, even after the sound was stopped. Root cause: `Channel.stop()` (`renderer/src/channel.js`, `channelNr >= 100` branch) unconditionally re-applied `borderColor = isLoop ? 'yellow' : ''` — i.e. any loop-configured button was *always* yellow-bordered regardless of play state. This duplicated (and fought with) `MixerUI._updateSbBorder()`, which independently colors the same border yellow purely from `channel.playing` — the two mechanisms disagreed on what yellow should mean, and `stop()`'s unconditional re-assertion is what kept it stuck.

Fix: `stop()` now just clears the border (`borderColor = ''`, `boxShadow = ''`) instead of re-deriving a color from the repeat mode — `_updateSbBorder()` (driven off `playing`) remains the single source of truth for the border while a button is actually playing. `setSbData()`'s loop-configured-on-load yellow indicator and `play()`'s green-while-looping indicator are untouched (out of scope for this bug — the former is superseded in practice by `_updateSbBorder` the moment the button is first played, the latter is already overridden by `_updateSbBorder` when triggered by mouse click, a pre-existing quirk not part of this report). Verified live via CDP: border returns to `''` after stopping a `repeat: 'single'` button.

## Problem

Two unrelated requests:

1. Volume slider positions (mixer channels, master, ambient channels, ambient master, soundboard master gain) are currently stored per-scene and per-profile. Moving a slider in one scene/profile has no effect on the same slider elsewhere — set channel 1 to 50%, switch scene, it may show something else. The user wants slider *position* to be identical everywhere: a single global value per control, shared across every scene and every profile.
2. Switching between **Soundboard Scenes** (ЗП, `sbScenes` — not the regular music `Scenes`, which already leave the soundboard alone) currently calls `Soundboard.configure()`, which immediately fades out and stops every soundboard button and every layered one-shot. The user wants whatever is currently playing on a soundboard button to keep playing until it naturally ends. If that sound is looped (`repeat: single` or `repeat: all`), the currently-playing take should be the last one — no further loop/next-track — after which the button adopts the new scene's assigned sound.

## 1. Global volume sliders

### Storage

New top-level electron-store key, sibling to `soundscapes`/`lastSoundscape`/`volume` (not nested inside a profile or scene):

```js
// storage.js
async getGlobalVolumes() {
  return await this.get('globalVolumes', null);
},
async setGlobalVolumes(v) {
  await this.set('globalVolumes', v);
}
```

Shape:
```js
{
  channels: number[8],   // mixer channels 0-7
  master: number,        // mixer master
  ambient: number[8],    // ambient channels 0-7
  ambientMaster: number, // ambient master
  soundboard: number     // soundboard master gain
}
```

### Migration (first run after update)

In `Mixer.init()`, before the first `setSoundscape()` call: if `Storage.getGlobalVolumes()` returns `null` (key never written), seed it from the soundscape about to load (last active profile, or its default) instead of hard-coded defaults — so existing tuned mixes aren't reset to 100%/75% on upgrade. Persist the seeded object immediately.

### Applying on load (read path)

Four existing single-choke-point functions are changed to source volume from `mixer.globalVolumes` instead of the scene/profile snapshot passed in. No caller in `mixer.js` needs to change for these four — the override lives inside the shared load functions themselves:

- **`Channel.setData()`** (`channel.js`) — after the existing `this.setVolume(this.settings.volume)` call, when `typeof this.channelNr === 'number' && this.channelNr < 100` (i.e. a real mixer channel, not master, not a soundboard button), re-apply `this.setVolume(this.mixer.globalVolumes.channels[this.channelNr])`. Soundboard buttons use `setSbData()`, a separate method — untouched, their volumes stay per-button/per-scene as today.
- **`Mixer.setSoundscape()`** (`mixer.js`) — `this.master.setVolume(settings.master.settings.volume)` becomes `this.master.setVolume(this.globalVolumes.master)`.
- **`AmbientMixer.configure()`** (`ambientMixer.js`) — after each channel's `setData()`, re-apply `this.channels[i].setVolume(this.mainMixer.globalVolumes.ambient[i])`; master gain sourced from `this.mainMixer.globalVolumes.ambientMaster` instead of `soundscapeData.ambientMaster?.volume`.
- **`Soundboard.configure()`** (`soundboard.js`) — gain sourced from `this.mixer.globalVolumes?.soundboard ?? settings.soundboardGain ?? 0.75` instead of `settings.soundboardGain` alone.

Because these are the only places that ever load channel/ambient/soundboard data (called from `setSoundscape`, `switchScene`, `removeScene`, `switchSoundboardScene`, `removeSoundboardScene`, etc.), every existing call site benefits automatically with no per-call-site changes.

### Applying on write (user moves a slider)

New `Mixer` methods, each updating the in-memory `globalVolumes` object and persisting it:

```js
setGlobalChannelVolume(i, v)
setGlobalMasterVolume(v)
setGlobalAmbientVolume(i, v)
setGlobalAmbientMasterVolume(v)
setGlobalSoundboardVolume(v)
```

Call sites switched from today's per-scene/per-profile persistence to these:

- `mixerUI.js` — master volume slider/number, ambient master volume slider, channel volume slider/number, ambient channel volume fader. The existing `_saveChannelVolume`, `_saveMasterVolume`, `_saveAmbientVolume`, `_saveAmbientMasterVolume` helpers are removed (dead code) in favor of calling the new `Mixer` methods directly.
- `Mixer.setLinkVolumes()` (`mixer.js`) — currently reads/writes `Storage.getSoundscapes()/setSoundscapes()` to persist every linked channel's new volume into the profile snapshot. Rewritten to write into `this.globalVolumes.channels[i]` for every affected channel and persist once via `Storage.setGlobalVolumes()` — no longer touches `soundscapes` at all.
- `Soundboard.setVolume()` (`soundboard.js`) — persists via `this.mixer.setGlobalSoundboardVolume(volume)` instead of writing `soundscapes[...].soundboardGain`.
- `midi.js` `_deferSave()` — currently copies live volume values into the profile's `soundscapes` entry and does one deferred `Storage.setSoundscapes()` write 300ms after the last MIDI volume event. Rewritten to copy the same live values into `mixer.globalVolumes` and call `Storage.setGlobalVolumes()` instead — same debounce behavior, no `soundscapes` round-trip needed anymore for this path.

### Out of scope (unchanged)

Mute, Solo, Pan, Link, and the assigned sound/playlist on each channel remain per-scene/per-profile exactly as today. Only the volume/gain *level* becomes global. The per-scene/per-profile JSON keeps its (now unused) `settings.volume` / `soundboardGain` fields for `.soundscapeData` export/Foundry-format compatibility — they're simply no longer read for in-app playback.

## 2. Soundboard scene switch lets an in-flight sound finish

Scope: switching **Soundboard Scenes** (`Mixer.switchSoundboardScene()`, and `Mixer.removeSoundboardScene()` when it removes the currently-active ЗП and switches to another). Regular music `Scenes` (`switchScene()`) already don't touch the soundboard at all — no change needed there. The explicit "stop all sounds" button/MIDI/web-remote command is unaffected — it's a deliberate stop, not a scene switch.

### `Soundboard.configure()` gets an opt-in mode

```js
// soundboard.js
configure(settings, { keepPlaying = false } = {}) {
  if (!keepPlaying) this.stopAll();
  const gain = this.mixer.globalVolumes?.soundboard ?? settings.soundboardGain ?? 0.75;
  this._applyMasterGain(gain);
  for (let i = 0; i < this.soundboardSize; i++) {
    const ch = settings.soundboard[i];
    if (!ch) continue;
    const btnCh = this.channels[i];
    if (keepPlaying && btnCh.playing) {
      btnCh._pendingSbData = ch;
      btnCh._sceneSwitchPending = true;
    } else {
      btnCh.setSbData(ch);
    }
  }
}
```

- Default behavior (`keepPlaying: false`) is unchanged — used by `setSoundscape()` (profile load), `clearSoundboardButton()`, and the drag/drop swap in `channelDrag.js`. Those remain instant-stop; switching profile or editing a single button is a bigger context change than moving between ЗП of the same profile.
- `switchSoundboardScene()` and `removeSoundboardScene()` (`mixer.js`) call `this.soundboard.configure(ss, { keepPlaying: true })`.
- Layered one-shot instances (`interrupt: false`, tracked in `Soundboard._layered`) are untouched when `keepPlaying: true` (no `stopAll()` call) — they're already single-shot, non-looping, and clean themselves up via their existing `ended` listener, so "let it finish" is automatic for them.
- Buttons in `globalSoundboardButtons` (shared across all ЗП) are unaffected either way — their assigned data doesn't change between scenes, so there is nothing to defer.

### `Channel` gets a deferred-apply flag (`channel.js`)

Two small additions, both scoped to soundboard-button channels (`channelNr >= 100`) since `_sceneSwitchPending`/`_pendingSbData` are only ever set by `Soundboard.configure()`:

- **`_onTimeUpdate()`** — right after `repeat` is normalized, force it to behave as `'none'` for the remainder of this playthrough when a switch is pending:
  ```js
  if (this._sceneSwitchPending) repeat = { ...repeat, repeat: 'none' };
  ```
  This makes both existing branches (natural end-of-track, and the `timing.stopTime` cutoff) fall through to their already-existing `'none'` handling (`this.stop()`) instead of looping (`single`) or advancing to the next playlist entry (`all`) — no duplicated logic needed in either branch.
- **`stop()`** — at the end of the function (after the existing `channelNr >= 100` UI/`onStop` handling), apply the deferred scene config if one is waiting:
  ```js
  if (this._sceneSwitchPending) {
    this._sceneSwitchPending = false;
    const pending = this._pendingSbData;
    this._pendingSbData = null;
    if (pending) this.setSbData(pending).catch(() => {});
  }
  ```
  This fires exactly once, on the first real `stop()` call after playback ends (the function's existing early-return guard for already-stopped channels means this block is never reached redundantly). `setSbData()` re-applies the new scene's sound/settings and refreshes the button's loop-indicator styling, so a subsequent press plays the new scene's assigned sound.
- If the user manually presses the same button again while it's finishing out its last loop (interrupt mode: second press fades out and stops immediately via the existing `fadeOutAndStop()` path), that also goes through `stop()` and applies the pending scene data right away — consistent, no special-casing needed.
- If the soundboard scene is switched again before the deferred sound finishes, `_pendingSbData` is simply overwritten with the newest scene's data for that slot — last switch wins once playback actually stops.

## What Stays the Same

- Regular music `Scenes` (`switchScene()`) — already scene-independent for the soundboard, untouched.
- `Soundboard.stopAll()` itself, and the explicit "stop all sounds" UI/MIDI/web-remote command — untouched, still instant fade-stop.
- Mute/Solo/Pan/Link and per-channel sound assignment — stay per-scene/per-profile.
- `FADE_STOP_MS`-based fades for orphaned music/ambient channels on regular scene switch — untouched.

## File Summary

| File | Change |
|---|---|
| `renderer/src/storage.js` | `getGlobalVolumes()` / `setGlobalVolumes()` |
| `renderer/src/mixer.js` | `globalVolumes` field + migration seed in `init()`; `setGlobalChannelVolume/setGlobalMasterVolume/setGlobalAmbientVolume/setGlobalAmbientMasterVolume/setGlobalSoundboardVolume`; `setSoundscape()` master volume sourced from `globalVolumes`; `setLinkVolumes()` persists to `globalVolumes` instead of `soundscapes`; `switchSoundboardScene()`/`removeSoundboardScene()` pass `{ keepPlaying: true }` |
| `renderer/src/channel.js` | `setData()` re-applies global channel volume; `_onTimeUpdate()` forces `repeat: 'none'` when `_sceneSwitchPending`; `stop()` applies deferred `_pendingSbData` |
| `renderer/src/ambientMixer.js` | `configure()` sources channel/master volume from `mainMixer.globalVolumes` |
| `renderer/src/soundboard.js` | `configure(settings, { keepPlaying })`; gain sourced from `mixer.globalVolumes.soundboard`; `setVolume()` persists via `mixer.setGlobalSoundboardVolume()` |
| `renderer/src/mixerUI.js` | volume slider/number/fader handlers call new `Mixer` global-volume setters; `_saveChannelVolume`/`_saveMasterVolume`/`_saveAmbientVolume`/`_saveAmbientMasterVolume` removed; `render()` and the ambient drag-drop slider-restore paint slider positions from `globalVolumes` instead of the stale per-scene/profile snapshot |
| `renderer/src/midi.js` | `_deferSave()` writes to `mixer.globalVolumes` via `Storage.setGlobalVolumes()` instead of `soundscapes` |
| `renderer/src/webBridge.js` | discovered during implementation — same stale-snapshot pattern as `mixerUI.js`: `mixer:volume`/`master:volume`/`ambient:volume`/`ambient:masterVolume` web-remote commands now call the new `Mixer` global-volume setters; `_buildState()`'s `ambient.masterVolume` now reads the live `ambientMixer.getMasterVolume()` instead of the stale snapshot |
