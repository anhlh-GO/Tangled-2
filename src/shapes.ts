// Board layouts: the grid of the reference — `grid:CxR`, holes 0.76 of the pitch
// across (115 px holes, 152 px apart). Positions: x right, y down.

export type ShapeName = `grid:${number}x${number}`;

export const GRID_PITCH = 1.15;

/** The holes of a `grid:CxR` board. */
export function layout(shape: ShapeName, _n = 0): [number, number][] {
  const g = /^grid:(\d+)x(\d+)$/.exec(shape);
  const cols = g ? +g[1] : 4, rows = g ? +g[2] : 6;
  const out: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([(c - (cols - 1) / 2) * GRID_PITCH, (r - (rows - 1) / 2) * GRID_PITCH]);
  return out;
}
