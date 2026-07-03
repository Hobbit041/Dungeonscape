/**
 * sbGrid.js — soundboard grid model: fixed 7×7 = 49 slots.
 * Slot index = row*7 + col; a button's row/col never changes.
 * The visible grid (cols×rows, 4–7 each) is a top-left window onto the slots.
 *
 * Geometry: base cell S is "cell size as at 5 divisions". A division of 4
 * keeps that window axis the same size as at 5, so the cell grows.
 */

export const SB_GRID_MAX = 7;
export const SB_SLOTS    = SB_GRID_MAX * SB_GRID_MAX;   // 49
export const SB_GRID_MIN = 4;
export const SB_GRID_DEF = 5;
export const SB_GAP      = 6;   // px — must match #soundboard-grid CSS gap

export function slotCol(i) { return i % SB_GRID_MAX; }
export function slotRow(i) { return Math.floor(i / SB_GRID_MAX); }

export function isVisible(i, cols, rows) {
  return slotCol(i) < cols && slotRow(i) < rows;
}

export function visibleIndices(cols, rows) {
  const out = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push(r * SB_GRID_MAX + c);
  return out;
}

// ─── Migration from the legacy 5-wide 25-slot layout ─────────────────────────

/** Old flat index (5 columns) → new slot index (same row/col). */
export function migrateIndex(i) {
  return Math.floor(i / 5) * SB_GRID_MAX + (i % 5);
}

// Legacy format was always 5 columns × 25 slots; any shorter non-empty array is old data.
export function needsMigration(sbArray) {
  return Array.isArray(sbArray) && sbArray.length > 0 && sbArray.length < SB_SLOTS;
}

/**
 * Rebuild a legacy soundboard array into 49 slots. `makeEmpty(i)` fills gaps.
 * Side-effect-free: input buttons are cloned, not mutated.
 */
export function migrateSoundboardArray(arr, makeEmpty) {
  const out = Array.from({ length: SB_SLOTS }, (_, i) => makeEmpty(i));
  (arr ?? []).forEach((btn, i) => {
    if (!btn) return;
    const ni = migrateIndex(i);
    out[ni] = { ...btn, channel: 100 + ni };
  });
  return out;
}

/** Migrate one soundscape in place. Returns true if anything changed. */
export function migrateSoundscape(ss, makeEmpty) {
  let changed = false;
  if (needsMigration(ss.soundboard)) {
    ss.soundboard = migrateSoundboardArray(ss.soundboard, makeEmpty);
    if (Array.isArray(ss.globalSoundboardButtons)) {
      ss.globalSoundboardButtons = ss.globalSoundboardButtons.map(migrateIndex);
    }
    changed = true;
  }
  for (const scene of ss.sbScenes ?? []) {
    if (needsMigration(scene.soundboard)) {
      scene.soundboard = migrateSoundboardArray(scene.soundboard, makeEmpty);
      changed = true;
    }
  }
  return changed;
}

/** Rekey `sb-{i}` MIDI mapping entries. Returns a new object. */
export function migrateMidiMappings(mappings) {
  const out = {};
  for (const [key, v] of Object.entries(mappings ?? {})) {
    const m = key.match(/^sb-(\d+)$/);
    out[m ? `sb-${migrateIndex(+m[1])}` : key] = v;
  }
  return out;
}

// ─── Cell / window geometry ───────────────────────────────────────────────────

/**
 * Actual cell size for a base cell S at the given divisions.
 * Only the 4-division axis preserves its outer size; the perpendicular axis grows.
 */
export function cellFromBase(S, cols, rows) {
  return (cols === 4 || rows === 4) ? (5 * S + SB_GAP) / 4 : S;
}

/** Grid pixel size (content box) for base cell S at the given divisions. */
export function gridSizeFor(S, cols, rows) {
  const c = cellFromBase(S, cols, rows);
  return {
    w: cols * c + (cols - 1) * SB_GAP,
    h: rows * c + (rows - 1) * SB_GAP,
  };
}

/** Inverse of cellFromBase: recover base cell S from the actual cell size. */
export function baseFromCell(cell, cols, rows) {
  return (cols === 4 || rows === 4) ? (4 * cell - SB_GAP) / 5 : cell;
}
