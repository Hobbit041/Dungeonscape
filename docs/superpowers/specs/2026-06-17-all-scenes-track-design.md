---
name: all-scenes-track
description: Галка "На всех сценах" для дорожек музыки и фоновых звуков
metadata:
  type: project
---

# "На всех сценах" — дизайн

## Суть функции

На дорожках музыки (channels 0–7) и фоновых звуков (ambient 0–7) добавляется чекбокс **"На всех сценах"**. Дорожка с включённым флагом становится единой для всех сцен профиля: её аудио не прерывается при переключении сцен, а все изменения настроек немедленно актуальны без какой-либо дополнительной синхронизации.

---

## Модель данных

На уровне soundscape добавляются два новых поля:

```json
{
  "globalMusicChannels":   [0, 2],
  "globalAmbientChannels": [1]
}
```

- Отсутствующие поля трактуются как `[]` — полная обратная совместимость со старыми данными.
- Данные глобальной дорожки живут **только** в `ss.channels[i]` / `ss.ambient[i]` (рабочая копия).
- Снапшоты сцен (`ss.scenes[k].channels[i]`) для глобальных индексов не читаются и не пишутся при переключении сцен.

---

## UI

### Музыкальные каналы — `channelConfigDialog.js`

Новая строка `fx-row` с чекбоксом `chCfgAllScenes-{i}` добавляется **над** строкой `chCfgAutoPlay-{i}`.

При включении `allScenes`:
- Чекбокс `autoPlay` получает атрибут `disabled`.
- К элементу `box-{i}` добавляется CSS-класс `channel-global`.

При выключении:
- `autoPlay` снова активен.
- Класс `channel-global` убирается.

### Фоновые звуки — `playlistDialog.js` (режим `ambient`)

Новая строка с чекбоксом `plAllScenes-{panelId}` добавляется **над** строкой `plAutoPlay-{panelId}`.

Логика disabled/enabled и CSS-класса `ambBox-{i}` аналогична музыкальным каналам.

### CSS

```css
.channel-box.channel-global {
  background-color: rgba(255, 255, 255, 0.06);
}
```

Класс применяется только к фону карточки (`.channel-box`), не к фейдеру.

`render()` в `mixerUI.js` читает `ss.globalMusicChannels` и `ss.globalAmbientChannels` и применяет/снимает класс при каждом рендере.

---

## Переключение сцен (`mixer.js:switchScene`)

### Орфанинг аудио

```js
for (const ch of this.channels) {
  if (ss.globalMusicChannels?.includes(ch.channelNr)) continue;
  _fadeOrphan(ch.audioElement, ch.node, FADE_STOP_MS);
  ch.audioElement = undefined;
  ch.node         = undefined;
  ch.playing      = false;
  ch.paused       = false;
}
```

Глобальные дорожки пропускаются — аудио продолжает играть без прерывания.

### Сохранение снапшота текущей сцены

Глобальные индексы не перезаписываются в `ss.scenes[curIdx].channels`:

```js
const snapshot = structuredClone(ss.channels);
for (const i of ss.globalMusicChannels ?? []) {
  snapshot[i] = structuredClone(ss.scenes[curIdx].channels[i] ?? makeEmptyChannel(i));
}
ss.scenes[curIdx].channels = snapshot;
```

Глобальные слоты в снапшоте остаются нетронутыми (сохраняется предыдущий снапшот), чтобы при последующем выключении флага у каждой сцены были последние данные рабочей копии, скопированные туда в момент выключения.

*(Аналогично для ambient.)*

### Загрузка новой сцены

```js
const newChannels = structuredClone(ss.scenes[newSceneIdx].channels);
for (const i of ss.globalMusicChannels ?? []) {
  newChannels[i] = ss.channels[i]; // рабочая копия — авторитетный источник
}
ss.channels = newChannels;
```

### `setData()` и `configure()`

`ch.setData()` и `ambientMixer.configure()` вызываются только для не-глобальных индексов.

---

## Добавление новой сцены (`mixer.js:addScene`)

Глобальные дорожки сразу присутствуют в новой сцене:

```js
const newChannels = makeEmptyChannelArray(MIXER_SIZE);
for (const i of ss.globalMusicChannels ?? []) {
  newChannels[i] = structuredClone(ss.channels[i]);
}
const newAmbient = makeEmptyAmbientArray(AMBIENT_SIZE);
for (const i of ss.globalAmbientChannels ?? []) {
  newAmbient[i] = structuredClone(ss.ambient[i]);
}
ss.scenes.push({ name: ..., channels: newChannels, ambient: newAmbient });
```

---

## Включение флага "На всех сценах"

1. Проверяем `ss.scenes[k].channels[i]` для всех `k !== currentScene` на наличие файлов (непустой `soundData.playlist` или `soundData.source`). Аналогично для ambient.
2. Если хотя бы в одной другой сцене есть данные → `showConfirm("На этой дорожке на других сценах есть файлы, они будут перезаписаны. Продолжить?")`. При отказе — галка не ставится.
3. Добавляем `i` в `ss.globalMusicChannels` (или `ss.globalAmbientChannels`).
4. Сохраняем soundscape.
5. Обновляем UI: `disabled` для autoPlay, класс `channel-global`.

---

## Выключение флага "На всех сценах"

1. Копируем рабочую копию дорожки во все снапшоты сцен:
   ```js
   for (const scene of ss.scenes) {
     scene.channels[i] = structuredClone(ss.channels[i]);
   }
   ```
2. Убираем `i` из `ss.globalMusicChannels`.
3. Сохраняем soundscape.
4. Обновляем UI: включаем autoPlay, убираем `channel-global`.

После выключения все сцены стартуют с одинаковыми данными (копия глобальной дорожки) и далее живут независимо.

---

## Граничные случаи

### `clearChannel(i)` / `clearAmbientChannel(i)`

Если дорожка глобальная — сначала снимаем флаг (убираем из `globalMusicChannels`, обновляем UI), затем сбрасываем данные как обычно. Clear автоматически прекращает "глобальность".

### `removeScene(idx)`

Без изменений. Глобальные дорожки живут в рабочей копии, не в сценах.

### Изменения настроек через `channelConfigDialog` / `playlistDialog`

Все существующие `_saveSetting`, `_saveRepeat`, `_saveTiming`, `_savePlaybackRate` пишут в `ss.channels[i]` (рабочую копию) — именно это и есть единственный экземпляр для глобальной дорожки. Никаких дополнительных шагов синхронизации не требуется.

---

## Затронутые файлы

| Файл | Изменения |
|------|-----------|
| `renderer/src/mixer.js` | `switchScene`, `addScene`, `clearChannel`, `clearAmbientChannel` |
| `renderer/src/channelConfigDialog.js` | Чекбокс allScenes, disable autoPlay |
| `renderer/src/playlistDialog.js` | Чекбокс allScenes (режим ambient), disable autoPlay |
| `renderer/src/mixerUI.js` | `render()` — применять `channel-global`; обработчик allScenes из диалогов |
| `renderer/style.css` | CSS-класс `.channel-global` |
| `translations/ru.json` | Строки `allScenes`, `allScenesConfirm` |
