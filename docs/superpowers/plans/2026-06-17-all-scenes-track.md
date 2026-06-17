# All-Scenes Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "На всех сценах" checkbox to music and ambient tracks so a track's audio and settings persist across all scene switches without interruption.

**Architecture:** Global track indices are stored at the soundscape level (`ss.globalMusicChannels`, `ss.globalAmbientChannels`). The working copy (`ss.channels[i]` / `ss.ambient[i]`) is the single authoritative data source — no duplication. `switchScene` skips orphaning and data loading for global indices; `addScene` seeds their data into the new scene; `clearChannel` removes the global flag automatically.

**Tech Stack:** Vanilla JS ES modules, Electron (renderer process), `electron-store` via `Storage` IPC, Web Audio API.

---

## File Map

| File | Change |
|------|--------|
| `translations/ru.json` | Add `channelConfig.allScenes`, `channelConfig.allScenesConfirm`, `playlist.allScenes`, `playlist.allScenesConfirm` |
| `renderer/style.css` | Add `.channel-strip.channel-global` and `.amb-strip.channel-global` |
| `renderer/src/mixer.js` | `setAllScenesMusic`, `setAllScenesAmbient`, modify `switchScene`, `addScene`, `clearChannel`, `clearAmbientChannel` |
| `renderer/src/ambientMixer.js` | `configure(soundscapeData, skipIndices = [])` — skip global ambient channels |
| `renderer/src/channelConfigDialog.js` | Add allScenes checkbox row above autoPlay; bind handler |
| `renderer/src/playlistDialog.js` | Add `allScenes` + `onAllScenesToggle` params; add checkbox in ambient toolbar |
| `renderer/src/mixerUI.js` | `render()` adds `channel-global` class; `_openAmbientPlaylist` passes allScenes callbacks |

---

## Task 1: Translations + CSS

**Files:**
- Modify: `translations/ru.json`
- Modify: `renderer/style.css`

- [ ] **Step 1.1 — Add translation keys to `channelConfig` section**

In `translations/ru.json`, find `"autoPlay": "Воспроизводить при смене сцен"` inside `channelConfig` (line 154) and replace that line with:

```json
    "autoPlay": "Воспроизводить при смене сцен",
    "allScenes": "На всех сценах",
    "allScenesConfirm": "На этой дорожке на других сценах есть файлы, они будут перезаписаны. Продолжить?"
```

- [ ] **Step 1.2 — Add translation keys to `playlist` section**

In `translations/ru.json`, find `"autoPlay": "Воспроизводить при смене сцен",` inside `playlist` (line 195) and replace that line with:

```json
    "autoPlay": "Воспроизводить при смене сцен",
    "allScenes": "На всех сценах",
    "allScenesConfirm": "На этой дорожке на других сценах есть файлы, они будут перезаписаны. Продолжить?",
```

- [ ] **Step 1.3 — Add CSS for global channel highlight**

In `renderer/style.css`, after line `.channel-strip.drag-over { border-color: var(--accent); }` (line 212), insert:

```css
.channel-strip.channel-global { background: #2a2c3a; }
.amb-strip.channel-global     { background: #2a2c3a; }
```

- [ ] **Step 1.4 — Commit**

```bash
git add translations/ru.json renderer/style.css
git commit -m "feat: add allScenes translations and CSS"
```

---

## Task 2: Mixer core — new methods + modified scene operations

**Files:**
- Modify: `renderer/src/mixer.js`
- Modify: `renderer/src/ambientMixer.js`

### 2A — `AmbientMixer.configure` accepts `skipIndices`

- [ ] **Step 2A.1 — Modify `configure` signature and body**

In `renderer/src/ambientMixer.js`, replace the entire `configure` method (starting at `async configure(soundscapeData)`) with:

```js
async configure(soundscapeData, skipIndices = []) {
  const ambient = soundscapeData.ambient ?? [];
  for (let i = 0; i < this.channelCount; i++) {
    if (skipIndices.includes(i)) continue;
    this.channels[i].stop();
    this.channels[i].setData(ambient[i] ?? makeEmptyAmbient(i));
    const folderLinks = ambient[i]?.soundData?.folderLinks;
    if (Array.isArray(folderLinks) && folderLinks.length) {
      for (const fp of folderLinks) {
        try {
          const files = await window.api.fs.readFolder(fp);
          this.channels[i].sourceArray.push(...files.map(f => pathToUrl(f)).filter(Boolean));
        } catch (_) {}
      }
      if (this.channels[i].currentlyPlaying >= this.channels[i].sourceArray.length)
        this.channels[i].currentlyPlaying = 0;
    }
  }
  this._masterVol = soundscapeData.ambientMaster?.volume ?? 1;
  this.masterGain.gain.value = this._masterVol;
}
```

### 2B — New `setAllScenesMusic` and `setAllScenesAmbient` methods in `mixer.js`

- [ ] **Step 2B.1 — Add methods after the `toggleLink` method (around line 405)**

In `renderer/src/mixer.js`, after the closing `}` of `toggleLink`, insert:

```js
async setAllScenesMusic(channelNr, enable) {
  const soundscapes = await Storage.getSoundscapes();
  const ss = soundscapes[this.currentSoundscape];
  if (!ss) return;
  if (!ss.globalMusicChannels) ss.globalMusicChannels = [];

  if (enable) {
    if (!ss.globalMusicChannels.includes(channelNr))
      ss.globalMusicChannels.push(channelNr);
  } else {
    for (const scene of ss.scenes ?? []) {
      if (!scene.channels) scene.channels = makeEmptyChannelArray(MIXER_SIZE);
      scene.channels[channelNr] = structuredClone(ss.channels[channelNr]);
    }
    ss.globalMusicChannels = ss.globalMusicChannels.filter(i => i !== channelNr);
  }

  soundscapes[this.currentSoundscape] = ss;
  await Storage.setSoundscapes(soundscapes);
  this.renderUI();
}

async setAllScenesAmbient(channelNr, enable) {
  const soundscapes = await Storage.getSoundscapes();
  const ss = soundscapes[this.currentSoundscape];
  if (!ss) return;
  if (!ss.globalAmbientChannels) ss.globalAmbientChannels = [];

  if (enable) {
    if (!ss.globalAmbientChannels.includes(channelNr))
      ss.globalAmbientChannels.push(channelNr);
  } else {
    for (const scene of ss.scenes ?? []) {
      if (!scene.ambient) scene.ambient = makeEmptyAmbientArray(AMBIENT_SIZE);
      scene.ambient[channelNr] = structuredClone(ss.ambient?.[channelNr] ?? makeEmptyAmbient(channelNr));
    }
    ss.globalAmbientChannels = ss.globalAmbientChannels.filter(i => i !== channelNr);
  }

  soundscapes[this.currentSoundscape] = ss;
  await Storage.setSoundscapes(soundscapes);
  this.renderUI();
}
```

### 2C — Modify `switchScene`

- [ ] **Step 2C.1 — Replace entire `switchScene` method**

In `renderer/src/mixer.js`, replace the entire `async switchScene(newSceneIdx)` method with:

```js
async switchScene(newSceneIdx) {
  const soundscapes = await Storage.getSoundscapes();
  const ss = soundscapes[this.currentSoundscape];
  if (!ss.scenes || newSceneIdx < 0 || newSceneIdx >= ss.scenes.length) return;
  const curIdx = ss.currentScene ?? 0;
  if (newSceneIdx === curIdx) return;

  const globalMusic   = ss.globalMusicChannels   ?? [];
  const globalAmbient = ss.globalAmbientChannels ?? [];

  // Orphan non-global music channels
  for (const ch of this.channels) {
    if (globalMusic.includes(ch.channelNr)) continue;
    _fadeOrphan(ch.audioElement, ch.node, FADE_STOP_MS);
    ch.audioElement = undefined;
    ch.node         = undefined;
    ch.playing      = false;
    ch.paused       = false;
  }
  this.playing = this.channels.some(ch => globalMusic.includes(ch.channelNr) && ch.playing);

  // Orphan non-global ambient channels via gainNode fade
  for (let i = 0; i < this.ambientMixer.channels.length; i++) {
    if (globalAmbient.includes(i)) continue;
    this.ambientMixer.channels[i].fadeOutAndStop(FADE_STOP_MS);
  }

  // Save scene snapshot — for global slots preserve the old snapshot (not live data)
  const channelSnapshot = structuredClone(ss.channels);
  for (const i of globalMusic) {
    channelSnapshot[i] = structuredClone(ss.scenes[curIdx].channels?.[i] ?? makeEmptyChannel(i));
  }
  ss.scenes[curIdx].channels = channelSnapshot;

  const ambientSnapshot = structuredClone(ss.ambient ?? []);
  for (const i of globalAmbient) {
    ambientSnapshot[i] = structuredClone(ss.scenes[curIdx].ambient?.[i] ?? makeEmptyAmbient(i));
  }
  ss.scenes[curIdx].ambient = ambientSnapshot;

  // Preserve live global data before overwriting working copy
  const savedMusic   = Object.fromEntries(globalMusic.map(i => [i, ss.channels[i]]));
  const savedAmbient = Object.fromEntries(globalAmbient.map(i => [i, (ss.ambient ?? [])[i]]));

  // Load new scene into working copy
  ss.channels = structuredClone(ss.scenes[newSceneIdx].channels);
  ss.ambient  = structuredClone(ss.scenes[newSceneIdx].ambient ?? []);
  for (const i of globalMusic)   ss.channels[i] = savedMusic[i];
  for (const i of globalAmbient) ss.ambient[i]  = savedAmbient[i];

  ss.currentScene = newSceneIdx;
  soundscapes[this.currentSoundscape] = ss;
  await Storage.setSoundscapes(soundscapes);

  // Reload non-global music channels
  for (let i = 0; i < this.mixerSize; i++) {
    if (globalMusic.includes(i)) continue;
    await this.channels[i].setData(ss.channels[i]);
  }
  await this.ambientMixer.configure(ss, globalAmbient);

  // Start non-global autoPlay channels (crossfade with fading orphans)
  const autoPlayChannels = this.channels.filter(
    ch => !globalMusic.includes(ch.channelNr) && ch.settings?.autoPlay && ch.sourceArray?.length
  );
  if (autoPlayChannels.length) {
    this.playing = true;
    this.configureSolo();
    for (const ch of autoPlayChannels) ch.play();
  }
  if (this.channels.some(ch => ch.playing)) this.playing = true;

  // Non-global ambient autoPlay channels
  for (let i = 0; i < this.ambientMixer.channelCount; i++) {
    if (globalAmbient.includes(i)) continue;
    const ambEntry = ss.ambient?.[i];
    if (ambEntry?.soundData?.autoPlay && this.ambientMixer.channels[i].sourceArray.length) {
      const ch = this.ambientMixer.channels[i];
      ch.play();
      const playEl = document.getElementById(`ambPlay-${i}`);
      if (playEl) playEl.innerHTML = '<i class="fas fa-stop"></i>';
    }
  }

  this.renderUI();
}
```

### 2D — Modify `addScene`

- [ ] **Step 2D.1 — Replace entire `addScene` method**

In `renderer/src/mixer.js`, replace the entire `async addScene()` method with:

```js
async addScene() {
  const soundscapes = await Storage.getSoundscapes();
  const ss = soundscapes[this.currentSoundscape];
  if (!ss.scenes) ss.scenes = [];
  if (ss.scenes.length >= 16) return;

  const globalMusic   = ss.globalMusicChannels   ?? [];
  const globalAmbient = ss.globalAmbientChannels ?? [];

  const newChannels = makeEmptyChannelArray(MIXER_SIZE);
  for (const i of globalMusic) {
    newChannels[i] = structuredClone(ss.channels[i]);
  }

  const newAmbient = makeEmptyAmbientArray(AMBIENT_SIZE);
  for (const i of globalAmbient) {
    newAmbient[i] = structuredClone(ss.ambient?.[i] ?? makeEmptyAmbient(i));
  }

  ss.scenes.push({
    name:     `Scene ${ss.scenes.length + 1}`,
    channels: newChannels,
    ambient:  newAmbient
  });
  soundscapes[this.currentSoundscape] = ss;
  await Storage.setSoundscapes(soundscapes);
  this.renderUI();
}
```

### 2E — Modify `clearChannel` and `clearAmbientChannel`

- [ ] **Step 2E.1 — Replace `clearChannel`**

In `renderer/src/mixer.js`, replace the entire `async clearChannel(channelNr)` method with:

```js
async clearChannel(channelNr) {
  this.channels[channelNr].stop(true);
  const soundscapes = await Storage.getSoundscapes();
  const ss = soundscapes[this.currentSoundscape];
  if (!ss) return;

  if (ss.globalMusicChannels?.includes(channelNr)) {
    ss.globalMusicChannels = ss.globalMusicChannels.filter(i => i !== channelNr);
    for (const scene of ss.scenes ?? []) {
      if (scene.channels) scene.channels[channelNr] = makeEmptyChannel(channelNr);
    }
  }

  ss.channels[channelNr] = makeEmptyChannel(channelNr);
  soundscapes[this.currentSoundscape] = ss;
  await Storage.setSoundscapes(soundscapes);
  await this.channels[channelNr].setData(ss.channels[channelNr]);
  this.renderUI();
}
```

- [ ] **Step 2E.2 — Replace `clearAmbientChannel`**

In `renderer/src/mixer.js`, replace the entire `async clearAmbientChannel(i)` method with:

```js
async clearAmbientChannel(i) {
  const ch = this.ambientMixer?.channels[i];
  if (ch) ch.stop();
  const soundscapes = await Storage.getSoundscapes();
  const ss = soundscapes[this.currentSoundscape];
  if (!ss) return;

  if (ss.globalAmbientChannels?.includes(i)) {
    ss.globalAmbientChannels = ss.globalAmbientChannels.filter(j => j !== i);
    for (const scene of ss.scenes ?? []) {
      if (!scene.ambient) scene.ambient = [];
      scene.ambient[i] = makeEmptyAmbient(i);
    }
  }

  if (!ss.ambient) ss.ambient = [];
  ss.ambient[i] = makeEmptyAmbient(i);
  soundscapes[this.currentSoundscape] = ss;
  await Storage.setSoundscapes(soundscapes);
  if (ch) {
    ch.sourceArray = [];
    ch.settings = { volume: 1, name: '' };
    ch.gainNode.gain.value = 1;
  }
  this.renderUI();
}
```

- [ ] **Step 2E.3 — Commit**

```bash
git add renderer/src/mixer.js renderer/src/ambientMixer.js
git commit -m "feat: allScenes core — mixer methods + scene/channel operations"
```

---

## Task 3: Music channel config dialog

**Files:**
- Modify: `renderer/src/channelConfigDialog.js`

- [ ] **Step 3.1 — Read current `open()` state loading (line ~26-41)**

Confirm the `open()` method already reads `soundscapes` via `Storage.getSoundscapes()` and has access to `ss` (the soundscape object). The `allScenes` flag is derived from `ss.globalMusicChannels`.

- [ ] **Step 3.2 — Add `allScenes` read in `open()`**

After `const autoPlay = s.autoPlay ?? false;` (line 41), add:

```js
const allScenes = (ss?.globalMusicChannels ?? []).includes(this.channelNr);
```

- [ ] **Step 3.3 — Add allScenes row above autoPlay row in the HTML template**

Find this block in the `panel.innerHTML` template:

```js
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.autoPlay')}</label>
          <input type="checkbox" id="chCfgAutoPlay-${this.channelNr}" ${autoPlay ? 'checked' : ''}>
        </div>
```

Replace it with:

```js
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.allScenes')}</label>
          <input type="checkbox" id="chCfgAllScenes-${this.channelNr}" ${allScenes ? 'checked' : ''}>
        </div>
        <div class="fx-row">
          <label class="cfg-label">${t('channelConfig.autoPlay')}</label>
          <input type="checkbox" id="chCfgAutoPlay-${this.channelNr}" ${autoPlay ? 'checked' : ''} ${allScenes ? 'disabled' : ''}>
        </div>
```

- [ ] **Step 3.4 — Bind allScenes handler in `_bindEvents()`**

In `_bindEvents()`, after the `// ── Auto-play on scene switch ──` block (after line 252), add:

```js
    // ── All scenes ──
    document.getElementById(`chCfgAllScenes-${i}`)?.addEventListener('change', async (e) => {
      const enable = e.target.checked;
      if (enable) {
        const soundscapes2 = await Storage.getSoundscapes();
        const ss2 = soundscapes2[this.mixer.currentSoundscape];
        const curIdx = ss2?.currentScene ?? 0;
        const hasOtherData = (ss2?.scenes ?? []).some((scene, sceneIdx) => {
          if (sceneIdx === curIdx) return false;
          const ch = scene.channels?.[i];
          const pl  = ch?.soundData?.playlist;
          const src = ch?.soundData?.source;
          return (Array.isArray(pl) && pl.length > 0) || (typeof src === 'string' && src.length > 0);
        });
        if (hasOtherData && !await showConfirm(t('channelConfig.allScenesConfirm'))) {
          e.target.checked = false;
          return;
        }
      }
      await this.mixer.setAllScenesMusic(i, enable);
      const autoPlayEl = document.getElementById(`chCfgAutoPlay-${i}`);
      if (autoPlayEl) autoPlayEl.disabled = enable;
    });
```

- [ ] **Step 3.5 — Commit**

```bash
git add renderer/src/channelConfigDialog.js
git commit -m "feat: allScenes checkbox in music channel config dialog"
```

---

## Task 4: Ambient playlist dialog — allScenes support

**Files:**
- Modify: `renderer/src/playlistDialog.js`

- [ ] **Step 4.1 — Add `allScenes` and `onAllScenesToggle` to constructor**

In `playlistDialog.js` line 52, replace the constructor signature and add two fields after `this._onClear = onClear ?? null;`.

Change the constructor signature from:
```js
constructor({ title, panelId, getSoundData, saveSoundData, getChannel, mode, onClear }) {
```
to:
```js
constructor({ title, panelId, getSoundData, saveSoundData, getChannel, mode, onClear, isAllScenes, onAllScenesToggle }) {
```

After `this._onClear = onClear ?? null;` (line 59), add:
```js
this.allScenes          = isAllScenes       ?? false;
this._onAllScenesToggle = onAllScenesToggle ?? null;
```

- [ ] **Step 4.2 — Add allScenes checkbox in ambient toolbar HTML**

In `open()`, find the ambient mode toolbar branch (lines 120-130):

```js
          ? `<label class="pl-shuffle">
               <input type="checkbox" id="plAutoPlay-${this.panelId}" ${this.autoPlay ? 'checked' : ''}>
               ${t('playlist.autoPlay')}
             </label>
             <label class="pl-shuffle">
               <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
               ${t('playlist.shuffle')}
             </label>
             <button class="pl-btn" id="plFolderLink-${this.panelId}" title="${t('playlist.folderLinkBtn')}">📁</button>
             <button class="pl-btn pl-folder-link-help-btn" id="plFolderLinkHelp-${this.panelId}">?</button>`
```

Replace it with:

```js
          ? `<label class="pl-shuffle">
               <input type="checkbox" id="plAllScenes-${this.panelId}" ${this.allScenes ? 'checked' : ''}>
               ${t('playlist.allScenes')}
             </label>
             <label class="pl-shuffle">
               <input type="checkbox" id="plAutoPlay-${this.panelId}" ${this.autoPlay ? 'checked' : ''} ${this.allScenes ? 'disabled' : ''}>
               ${t('playlist.autoPlay')}
             </label>
             <label class="pl-shuffle">
               <input type="checkbox" id="plShuffle-${this.panelId}" ${this.shuffle ? 'checked' : ''}>
               ${t('playlist.shuffle')}
             </label>
             <button class="pl-btn" id="plFolderLink-${this.panelId}" title="${t('playlist.folderLinkBtn')}">📁</button>
             <button class="pl-btn pl-folder-link-help-btn" id="plFolderLinkHelp-${this.panelId}">?</button>`
```

- [ ] **Step 4.3 — Bind allScenes handler in `_bindEvents()`**

In `_bindEvents()`, find the ambient branch (around line 449):

```js
    } else {
      if (this._mode === 'ambient') {
        this._q(`plAutoPlay-${id}`)?.addEventListener('change', async e => {
          this.autoPlay = e.target.checked;
          await this._save();
        });
      }
```

Replace it with:

```js
    } else {
      if (this._mode === 'ambient') {
        this._q(`plAllScenes-${id}`)?.addEventListener('change', async e => {
          const enable = e.target.checked;
          const ok = this._onAllScenesToggle ? await this._onAllScenesToggle(enable) : true;
          if (!ok) { e.target.checked = !enable; return; }
          this.allScenes = enable;
          const apEl = this._q(`plAutoPlay-${id}`);
          if (apEl) apEl.disabled = enable;
        });
        this._q(`plAutoPlay-${id}`)?.addEventListener('change', async e => {
          this.autoPlay = e.target.checked;
          await this._save();
        });
      }
```

- [ ] **Step 4.4 — Commit**

```bash
git add renderer/src/playlistDialog.js
git commit -m "feat: allScenes checkbox in ambient playlist dialog"
```

---

## Task 5: MixerUI — render() + ambient playlist wiring

**Files:**
- Modify: `renderer/src/mixerUI.js`

- [ ] **Step 5.1 — Add `showConfirm` import**

At the top of `renderer/src/mixerUI.js`, `showConfirm` is already imported:

```js
import { showConfirm, showAlert } from './dialog.js';
```

Confirm it's present (line ~17). No change needed if it already exists.

- [ ] **Step 5.2 — Add globalMusic/globalAmbient extraction in `render()`**

In `render()`, after `const ss = soundscapes[this.mixer.currentSoundscape] ?? {};` (around line 99), add:

```js
const globalMusic   = ss.globalMusicChannels   ?? [];
const globalAmbient = ss.globalAmbientChannels ?? [];
```

- [ ] **Step 5.3 — Apply `channel-global` class in channels loop**

In `render()`, inside the channels loop (`for (let i = 0; i < 8; i++) {`), after:

```js
      this._el(`box-${i}`)?.classList.toggle('is-playing', ch.playing);
```

add:

```js
      this._el(`box-${i}`)?.classList.toggle('channel-global', globalMusic.includes(i));
```

- [ ] **Step 5.4 — Apply `channel-global` class in ambient loop**

In `render()`, inside the ambient loop (`for (let i = 0; i < AMBIENT_SIZE; i++) {`), after:

```js
      this._el(`ambBox-${i}`)?.classList.toggle('is-playing', ambPlaying);
```

add:

```js
      this._el(`ambBox-${i}`)?.classList.toggle('channel-global', globalAmbient.includes(i));
```

- [ ] **Step 5.5 — Make `_openAmbientPlaylist` async and wire allScenes**

Replace the entire `_openAmbientPlaylist(i)` method with:

```js
async _openAmbientPlaylist(i) {
  const soundscapes = await Storage.getSoundscapes();
  const ss = soundscapes[this.mixer.currentSoundscape];
  const isAllScenes = (ss?.globalAmbientChannels ?? []).includes(i);

  new PlaylistDialog({
    title:         t('ambient.playlistTitle', { n: i + 1 }),
    panelId:       `amb-${i}`,
    getSoundData:  async () => {
      const ss2 = await Storage.getSoundscapes();
      return ss2[this.mixer.currentSoundscape]?.ambient?.[i]?.soundData;
    },
    saveSoundData: async (data) => {
      const ss2 = await Storage.getSoundscapes();
      if (ss2[this.mixer.currentSoundscape]) {
        if (!ss2[this.mixer.currentSoundscape].ambient)
          ss2[this.mixer.currentSoundscape].ambient = [];
        if (!ss2[this.mixer.currentSoundscape].ambient[i])
          ss2[this.mixer.currentSoundscape].ambient[i] =
            { settings: { volume: 1, name: '' }, soundData: {} };
        ss2[this.mixer.currentSoundscape].ambient[i].soundData = data;
        await Storage.setSoundscapes(ss2);
      }
    },
    getChannel: () => this.mixer.ambientMixer?.channels[i],
    mode:       'ambient',
    onClear:    async () => { await this.mixer.clearAmbientChannel(i); },
    isAllScenes,
    onAllScenesToggle: async (enable) => {
      if (enable) {
        const ss2 = await Storage.getSoundscapes();
        const ss3 = ss2[this.mixer.currentSoundscape];
        const curIdx = ss3?.currentScene ?? 0;
        const hasOtherData = (ss3?.scenes ?? []).some((scene, sceneIdx) => {
          if (sceneIdx === curIdx) return false;
          const amb = scene.ambient?.[i];
          const pl  = amb?.soundData?.playlist;
          const src = amb?.soundData?.source;
          return (Array.isArray(pl) && pl.length > 0) || (typeof src === 'string' && src.length > 0);
        });
        if (hasOtherData && !await showConfirm(t('playlist.allScenesConfirm'))) {
          return false;
        }
      }
      await this.mixer.setAllScenesAmbient(i, enable);
      return true;
    }
  }).open();
}
```

- [ ] **Step 5.6 — Commit**

```bash
git add renderer/src/mixerUI.js
git commit -m "feat: allScenes render highlight + ambient playlist wiring"
```

---

## Self-Review Checklist

After implementation, verify manually:

1. **Music channel — enable allScenes:**
   - Open channel config dialog → "На всех сценах" checkbox appears above "Воспроизводить при смене сцен"
   - Check it → autoPlay becomes disabled → channel background lightens
   - If another scene has a file on this track → confirm dialog appears

2. **Scene switch with global music channel:**
   - Channel audio continues playing without interruption
   - Other channels fade/crossfade as normal

3. **Scene switch with global ambient channel:**
   - Ambient channel audio continues uninterrupted
   - Other ambient channels stop as normal

4. **Add new scene:**
   - Global channel's data is immediately present in the new scene

5. **Uncheck allScenes:**
   - Background returns to normal
   - autoPlay becomes enabled again
   - Each scene now has its own independent copy of the track data

6. **Clear a global channel:**
   - Channel clears, global flag is removed, background normalizes

7. **Old soundscape data (no globalMusicChannels field):**
   - App loads without errors; `?? []` handles missing fields
