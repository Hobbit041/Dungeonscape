/**
 * sbLayout.js — owns the visible soundboard grid layout:
 *   - CSS vars --sb-cols/--sb-rows and .sb-hidden visibility
 *   - square-fit: sizes #soundboard-grid to the largest square-cell rect
 *     that fits #soundboard-grid-outer (centered; stripes only when maximized)
 *   - window coupling: reports fixed chrome + target grid size to main,
 *     which snaps the window and constrains manual resize
 *   - persists the base cell size S ("size as at 5 divisions")
 */
import { Storage } from './storage.js';
import {
  SB_SLOTS, SB_GAP, isVisible, gridSizeFor, baseFromCell,
} from './sbGrid.js';

export class SbLayout {
  cols = 5;
  rows = 5;
  _base = null;        // base cell S in px
  _saveTimer = null;
  _wasMaximized = false;

  async init() {
    const saved = await Storage.getSbGridSize();
    this.cols = saved.cols;
    this.rows = saved.rows;
    this._base = await Storage.get('sbCellBase', null);
    this.applyGridVars();

    if (this._base == null) {
      // First run: derive S from the default window as if the grid were 5×5
      const avail = this._availRect();
      this._base = Math.min((avail.w - 4 * SB_GAP) / 5, (avail.h - 4 * SB_GAP) / 5);
      await Storage.set('sbCellBase', this._base);
    }

    this._wasMaximized = await window.api.win.isMaximized();
    await this._pushLayout(!this._wasMaximized);
    this.fitGrid();
    window.addEventListener('resize', () => this._onResize());
  }

  /** Called from the settings panel. */
  async setGridSize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    const maximized = await window.api.win.isMaximized();
    // Re-anchor S to the actual current cell before switching (spec rule).
    // Skip while maximized — the letterboxed cell would inflate the base.
    if (!maximized) {
      const cell = this._currentCell();
      if (cell > 0) this._base = baseFromCell(cell, this.cols, this.rows);
    }
    this.cols = cols;
    this.rows = rows;
    await Storage.setSbGridSize({ cols, rows });
    await Storage.set('sbCellBase', this._base);
    this.applyGridVars();
    await this._pushLayout(!maximized);
    this.fitGrid();
  }

  /**
   * Re-measure fixed chrome (window minus soundboard-grid-outer) and re-push
   * to main, without requiring cols/rows to have changed — setGridSize()
   * early-returns in that case, which is right for its own callers but wrong
   * after an orientation switch, where the *shape* of the fixed chrome
   * around the grid has changed even though cols/rows haven't.
   */
  async refreshChrome() {
    await this._pushLayout(true);
    this.fitGrid();
  }

  /** Toggle cell visibility + grid-template vars for the current cols/rows. */
  applyGridVars() {
    const grid = document.getElementById('soundboard-grid');
    if (!grid) return;
    grid.style.setProperty('--sb-cols', this.cols);
    grid.style.setProperty('--sb-rows', this.rows);
    for (let i = 0; i < SB_SLOTS; i++) {
      document.getElementById(`sbButton-${i}`)
        ?.classList.toggle('sb-hidden', !isVisible(i, this.cols, this.rows));
    }
  }

  /** Size the grid to the largest square-cell rect inside the outer box. */
  fitGrid() {
    const grid = document.getElementById('soundboard-grid');
    if (!grid) return;
    const avail = this._availRect();
    const cell = Math.min(
      (avail.w - (this.cols - 1) * SB_GAP) / this.cols,
      (avail.h - (this.rows - 1) * SB_GAP) / this.rows,
    );
    grid.style.width  = `${this.cols * cell + (this.cols - 1) * SB_GAP}px`;
    grid.style.height = `${this.rows * cell + (this.rows - 1) * SB_GAP}px`;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  _availRect() {
    const outer = document.getElementById('soundboard-grid-outer');
    return { w: outer?.clientWidth ?? 0, h: outer?.clientHeight ?? 0 };
  }

  _currentCell() {
    const grid = document.getElementById('soundboard-grid');
    const w = grid?.getBoundingClientRect().width ?? 0;
    return (w - (this.cols - 1) * SB_GAP) / this.cols;
  }

  /**
   * Send layout to main: fixed chrome (window minus grid-outer) + optionally
   * the target grid size (main then resizes the window to it).
   */
  async _pushLayout(withTarget) {
    const avail = this._availRect();
    const payload = {
      cols: this.cols,
      rows: this.rows,
      gap: SB_GAP,
      fixedW: window.innerWidth - avail.w,
      fixedH: window.innerHeight - avail.h,
    };
    if (withTarget && this._base != null) {
      const t = gridSizeFor(this._base, this.cols, this.rows);
      payload.targetGridW = t.w;
      payload.targetGridH = t.h;
    }
    try { await window.api.sbGrid.updateLayout(payload); } catch { /* main not ready */ }
  }

  async _onResize() {
    this.fitGrid();
    const maximized = await window.api.win.isMaximized();
    if (!maximized && this._wasMaximized) {
      // Restored from maximized — snap the window back to squares
      this._wasMaximized = false;
      await this._pushLayout(true);
      this.fitGrid();
      return;
    }
    this._wasMaximized = maximized;
    if (maximized) {
      // Cancel any pending base save scheduled from a pre-maximize event —
      // it could otherwise persist a letterbox-inflated cell size.
      clearTimeout(this._saveTimer);
      return;
    }
    // Manual resize: re-anchor base cell S and persist (debounced)
    const cell = this._currentCell();
    if (cell > 0) {
      this._base = baseFromCell(cell, this.cols, this.rows);
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        Storage.set('sbCellBase', this._base).catch(() => {});
      }, 400);
    }
  }
}
