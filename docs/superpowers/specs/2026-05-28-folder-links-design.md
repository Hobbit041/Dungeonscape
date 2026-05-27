# Folder Links — Design Spec
**Date:** 2026-05-28

## Overview

Add the ability to add folder *links* to the playback queue, as an alternative to adding individual files. A folder link stores a path to a folder; every time the playlist is opened or the app restarts, the folder is scanned and its current audio files are loaded into the queue automatically.

## Data Model

`soundData` gains one new field:

```js
{
  playlist:    [{ path, label }],         // manually-added files only
  folderLinks: ['/path/to/folder', ...],  // folder link paths (strings)
  shuffle: bool,
  // ...existing fields unchanged
}
```

In-memory playlist items that originate from folder links carry an extra marker:

```js
{ path: '/folder/file.mp3', label: '📎 file.mp3', folderLink: '/path/to/folder' }
```

`folderLink` items are **never written to `soundData.playlist`** — they are regenerated from `folderLinks` on every load. Only the `folderLinks` array is persisted.

## Loading

`_loadPlaylist()` becomes `async`. After loading regular items it calls `_loadFolderLinks()`, which calls `window.api.fs.readFolder()` for each path and builds the marker items. The results are appended to the in-memory `playlist` array (after regular items) and then sorted alphabetically together with all items (unless shuffle is on).

## Saving

`_save()` filters `this.playlist` to exclude `folderLink` items before writing to storage. It also writes `this.folderLinks` to `soundData.folderLinks`.

## Adding a Folder Link

Two entry points:

1. **Button** — a folder icon button in the toolbar (next to the Shuffle checkbox), tooltip `t('playlist.folderLinkBtn')`. Calls `window.api.fs.openDialog({ folder: true })`, then `_addFolderLink(folderPath)`.
2. **Ctrl+drag** — when a folder is dropped onto the playlist area with `Ctrl` held, it is treated as a link instead of being expanded to files.

`_addFolderLink(folderPath)`:
1. Check if `folderPath` is already in `this.folderLinks`. If yes, show `t('playlist.folderLinkDuplicate')` alert and return.
2. Push `folderPath` to `this.folderLinks`.
3. Call `window.api.fs.readFolder(folderPath)`, build marker items, push to `this.playlist`.
4. Re-sort (if not shuffled). Save. Re-render.

## Removing a Folder Link

Right-click anywhere on a row that has `folderLink` set → context menu with one item: `t('playlist.folderLinkRemove')`.

`_removeFolderLink(folderPath)`:
1. Remove `folderPath` from `this.folderLinks`.
2. Remove all `this.playlist` items where `item.folderLink === folderPath`.
3. Save. Re-render.

## UI Details

### Toolbar additions (all modes except soundboard — same placement as Shuffle)
- **Folder button** `📁` — `t('playlist.folderLinkBtn')` tooltip
- **Help button** `?` (round, small) — toggles an inline info popup below the toolbar

### Info popup text
`t('playlist.folderLinkHelp')`:
> «Вы можете добавлять не отдельные файлы и папки, а ссылки на папки. В таком случае при добавлении ссылки, переоткрытии списка воспроизведения или при перезапуске приложения, в очередь воспроизведения будут добавлены все файлы, которые на данный момент находятся в этой папке»

### Row rendering
Rows where `item.folderLink` is set render a `<span class="pl-folder-link-icon" title="...">📎</span>` before the label text. The title is `t('playlist.folderLinkTooltip')`.

### Toolbar state
Up/Down buttons are disabled if **all** selected items are folder-link items (their order is meaningless; they are re-sorted on next load anyway).

### Delete button behavior
Works as today — removes items from the in-memory list for this session. On next open the files return if still present in the folder (because `folderLinks` is unchanged).

## Translations (ru.json — playlist section)

| Key | Value |
|-----|-------|
| `folderLinkBtn` | «Добавить ссылку на папку» |
| `folderLinkHelp` | (full text above) |
| `folderLinkTooltip` | «Этот файл автоматически загружен из папки» |
| `folderLinkRemove` | «Удалить ссылку на эту папку» |
| `folderLinkDuplicate` | «Ссылка на эту папку уже добавлена» |

## Files Changed

| File | Change |
|------|--------|
| `renderer/src/playlistDialog.js` | All new logic |
| `translations/ru.json` | 5 new keys in `playlist` section |

No changes to `main.js`, `preload.js`, `channel.js`, or `storage.js`.

## Out of Scope

- File locking / OS-level reservation (dropped in favour of the existing missing-files mechanism)
- Recursive folder scanning (only top-level audio files, matching current `readFolder` behaviour)
- Folder links in soundboard mode (soundboard items have no Shuffle, keeping the UI consistent)
