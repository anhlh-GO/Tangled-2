// Board grid spacing. Rows are CFG.STEP apart (the spec's 92 px). Columns are spread wider
// so a tall grid still makes a board about as wide as it is tall and fills the width of the
// screen (asked for in this game; the spec has square spacing).

import { CFG } from './config.ts';

/** Column spacing of a cols × rows grid: near-square board, at most 1.4 rows apart. */
export const pitchX = (cols: number, rows: number): number =>
  Math.min(CFG.STEP * 1.4, Math.max(CFG.STEP, ((CFG.STEP * (rows - 1)) / Math.max(1, cols - 1)) * 0.92));
