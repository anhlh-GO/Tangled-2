// Level 1 by hand (asked for): six ropes in three pairs, each pair two ropes crossed in an X
// (one lying over the other), two colours a pair. The answer: lift the top rope's pin aside —
// the pair comes apart and both ropes come off. Laid out with the physics, then played through
// to check, and written as a level line (JSON, as gen-levels.ts writes) to the files given.
//   node scripts/level1.ts out1.txt [out2.txt …]
import { writeFileSync } from 'node:fs';
import { Board, ESlot, type BoardData, type HandleData, type RopeData, type SlotData } from '../src/board.ts';
import { CFG } from '../src/config.ts';
import { R, END_Y } from '../src/rope.ts';
import { pitchX } from '../src/shapes.ts';

type P = [number, number];
const cols = 4, rows = 6, px = pitchX(cols, rows);
const S = (r: number, c: number) => r * cols + c;
const xy = (r: number, c: number): P => [(c - (cols - 1) / 2) * px, (r - (rows - 1) / 2) * CFG.STEP];
const slots: SlotData[] = [];
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) slots.push({ row: r, col: c, type: ESlot.Normal });
const handles: HandleData[] = [], ropes: RopeData[] = [];
const solution: [number, number][] = [];

/** A straight rope a → b of beads; `over`: lifted where it crosses the other one (its middle). */
function pose(a: P, b: P, len: number, over: boolean): number[] {
  const n = Math.max(4, Math.ceil(len / 0.15) + 1), out: number[] = [];
  for (let q = 0; q < n; q++) {
    const t = q / (n - 1), lift = over ? 2.1 * R * Math.exp(-((t - 0.5) ** 2) / 0.02) : 0;
    out.push(+(a[0] + (b[0] - a[0]) * t).toFixed(3), +(q === 0 || q === n - 1 ? END_Y : R + lift).toFixed(3), +(a[1] + (b[1] - a[1]) * t).toFixed(3));
  }
  return out;
}
// three pairs, top to bottom, on the left, right, left two columns
const pairs: [number, number][] = [[0, 0], [2, 2], [4, 0]];
pairs.forEach(([r, c], p) => {
  const h = handles.length, left = c === 0;
  // rope A (on top) runs from the outer top corner across; rope B (underneath) the other diagonal.
  // A's top pin then moves one slot further in — the same short diagonal, no longer crossing B.
  const a0: P = left ? [r, c] : [r, c + 1], a1: P = left ? [r + 1, c + 1] : [r + 1, c];
  const b0: P = left ? [r, c + 1] : [r, c], b1: P = left ? [r + 1, c] : [r + 1, c + 1];
  handles.push({ slot: S(...a0) }, { slot: S(...a1) }, { slot: S(...b0) }, { slot: S(...b1) });
  const A0 = xy(...a0), A1 = xy(...a1), B0 = xy(...b0), B1 = xy(...b1);
  const len = +(Math.hypot(A1[0] - A0[0], A1[1] - A0[1]) + 0.25).toFixed(3);
  const top = p % 2, under = 1 - top;   // colours swap pair to pair
  ropes.push({ a: h, b: h + 1, color: top, length: len, pose: pose(A0, A1, len + CFG.extraRopeLengthForGenerate, true) });
  ropes.push({ a: h + 2, b: h + 3, color: under, length: len, pose: pose(B0, B1, len + CFG.extraRopeLengthForGenerate, false) });
  // the answer: the top rope's upper pin one slot out, away from its pair
  solution.push([h, S(r, left ? c + 2 : c - 1)]);
});
const board: BoardData = { rows, cols, pitchX: px, slots, handles, ropes };

// settle the physics so the ropes lie as they will in the game
const b = new Board(board);
b.canUntie = false;
b.run(150);
if (b.groups.some((g) => !b.overlaps(g))) throw new Error('a pair is not crossed');
board.ropes.forEach((r, i) => { r.pose = Array.from(b.world.ropes[b.ropes[i].w].x).map((v) => +v.toFixed(3)); });

// play it through: every pair comes apart with its one move
function carry(v: Board, h: number, s: number): boolean {
  const p0 = v.handlePos(h), t = v.slots[s];
  const f0: P = [p0[0], p0[2] + CFG.distanceFromFinger], f1: P = [t.x, t.z + CFG.distanceFromFinger];
  v.setFinger(f0); v.press(h); v.run(2);
  for (let q = 1; q <= 12; q++) { v.setFinger([f0[0] + ((f1[0] - f0[0]) * q) / 12, f0[1] + ((f1[1] - f0[1]) * q) / 12]); v.run(1); }
  v.run(6); v.up();
  for (let q = 0; q < 300 && (v.handles[h].state as string) !== 'stable' && (v.handles[h].state as string) !== 'disappear'; q++) v.run(1);
  v.run(40);
  return true;
}
const v = new Board(board);
v.run(60);
if (v.lastEvents.some((e) => e.k === 'disappear')) throw new Error('something comes off on its own');
for (const [h, s] of solution) { carry(v, h, s); console.log('move', h, '→', s, 'state', v.handles[h].state, 'slot', v.handles[h].slot, 'groups left', v.groups.length, v.groups.map((g) => v.overlaps(g))); }
v.run(120);
if (!v.isCleared()) throw new Error('the answer does not clear it');

const line = 'JSON ' + JSON.stringify({ i: 0, lv: { board, hidden: [], queue: [0, 1], solution } }) + '\n';
for (const f of process.argv.slice(2)) writeFileSync(f, line);
console.log('level 1: 3 crossed pairs, checked — written to', process.argv.slice(2).join(', '));
