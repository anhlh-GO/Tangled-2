// The 10 onboarding levels. scripts/tune.ts picks each level's seed and `mix` so a
// careless bot wins at the level's target rate and careful play always can.
//
// Building a level: the reference grid of holes, ropes between random pairs of holes
// (mostly long, so they cross in a big tangle), a random stacking order (layers).
// Then the order the ropes naturally come off in (a bot that only untangles) is cut
// into threes: each three gets a colour, and those colours are the trays, in order.
// `mix` swaps ropes between nearby threes — the more, the more balls wait in the
// spare slots.

import { botRun, fromSpec, move, rngOf, solve, touch, type LevelSpec, type RopeSpec } from './sim.ts';
import { layout, type ShapeName } from './shapes.ts';
import { TUNED } from './tuned.ts';

export type Diff = 'easy' | 'normal' | 'hard' | 'super';
export const LEVEL_COUNT = 10;
/** Spare slots under the trays (the reference has four). */
export const SPARE = 4;
export interface Tune { seed: number; mix: number }

export const YARN = [
  { name: 'Pink', color: '#F33180' },
  { name: 'Blue', color: '#1478F4' },
  { name: 'Yellow', color: '#FFD51C' },
  { name: 'Green', color: '#34C759' },
  { name: 'Purple', color: '#9B5CF6' },
  { name: 'Orange', color: '#FF8A1F' },
  { name: 'Red', color: '#E8343B' },
  { name: 'Teal', color: '#12C2C2' },
];

/**
 * The toy knitted in each level (models in items3d.ts, same order). `palette` maps a
 * level's colour k to a yarn: a permutation, so tuning is unchanged, and the colours
 * the player sorts are the ones the toy is made of.
 */
export const TOY_INFO = [
  { name: 'Bunny Car', palette: [2, 1, 0, 5, 3, 6, 7, 4] },
  { name: 'Teddy Bear', palette: [6, 7, 2, 4, 0, 3, 1, 5] },
  { name: 'Rocket', palette: [3, 2, 7, 1, 6, 0, 4, 5] },
  { name: 'Cottage', palette: [7, 4, 2, 5, 1, 0, 3, 6] },
  { name: 'Cupcake', palette: [3, 5, 2, 1, 7, 4, 6, 0] },
  { name: 'Sailboat', palette: [4, 2, 3, 5, 7, 1, 0, 6] },
  { name: 'Robot', palette: [1, 5, 3, 7, 6, 0, 4, 2] },
  { name: 'Air Balloon', palette: [5, 3, 0, 2, 7, 6, 4, 1] },
  { name: 'Rubber Duck', palette: [7, 2, 5, 6, 3, 1, 4, 0] },
  { name: 'Toy Train', palette: [3, 0, 5, 4, 1, 6, 2, 7] },
];
export const toyOf = (i: number): number => i % TOY_INFO.length;

/** The level as the player sees it: colours mapped through the toy's palette. */
export function levelFor(i: number): LevelSpec {
  const spec = generate(i);
  const pal = TOY_INFO[toyOf(i)].palette;
  for (const s of spec.ropes) s.c = pal[s.c];
  spec.queue = spec.queue.map((c) => pal[c]);
  return spec;
}

/**
 * Onboarding: one level at a time, each adding a little. L5 and L10 are the two
 * peaks ("Hard Level!"), L6 a breather that brings in the mystery rope.
 */
interface Design { grid: ShapeName; ropes: number; colors: number; diff: Diff; hidden: number }
const DESIGN: Design[] = [
  { grid: 'grid:4x6', ropes: 6, colors: 2, diff: 'easy', hidden: 0 },     // 1  learn: drag a pin, rope comes off, a tray fills
  { grid: 'grid:4x6', ropes: 9, colors: 3, diff: 'easy', hidden: 0 },     // 2  a third colour: the next tray slides in
  { grid: 'grid:4x6', ropes: 9, colors: 3, diff: 'easy', hidden: 0 },     // 3  Undo
  { grid: 'grid:4x6', ropes: 9, colors: 3, diff: 'normal', hidden: 0 },   // 4  spare slots start to matter
  { grid: 'grid:4x7', ropes: 12, colors: 4, diff: 'hard', hidden: 0 },    // 5  first peak · Scissors
  { grid: 'grid:4x6', ropes: 9, colors: 3, diff: 'easy', hidden: 0.25 },  // 6  breather · Mystery Rope
  { grid: 'grid:4x7', ropes: 12, colors: 4, diff: 'normal', hidden: 0 },  // 7  +Slot
  { grid: 'grid:4x7', ropes: 12, colors: 4, diff: 'normal', hidden: 0.2 },// 8
  { grid: 'grid:5x6', ropes: 12, colors: 4, diff: 'normal', hidden: 0 },  // 9  a wider board
  { grid: 'grid:5x7', ropes: 15, colors: 5, diff: 'hard', hidden: 0.2 },  // 10 second peak
];
export const diffOf = (i: number): Diff => DESIGN[i]?.diff ?? 'normal';
export const shapeOf = (i: number): ShapeName => DESIGN[i]?.grid ?? 'grid:4x6';
/** Win rates of the careless bot each level aims at — gentle, it is onboarding. */
export const BAND: Record<Diff, [number, number]> = { easy: [0.85, 1], normal: [0.62, 0.88], hard: [0.4, 0.62], super: [0.25, 0.45] };
export const AIM: Record<Diff, number> = { easy: 0.95, normal: 0.75, hard: 0.5, super: 0.35 };
/** The level (1-based) each blocker first shows up. */
export const BLOCKER_AT = { hidden: 6 } as const;
export type Blocker = keyof typeof BLOCKER_AT;

export interface Plan { diff: Diff; colors: number; ropes: number; hidden: number }
export const planOf = (i: number): Plan => { const d = DESIGN[i] ?? DESIGN[DESIGN.length - 1]; return { diff: d.diff, colors: d.colors, ropes: d.ropes, hidden: d.hidden }; };

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}

/** The order the ropes come off in when you only untangle (colours don't matter). */
function naturalOrder(spec: LevelSpec, rng: () => number): number[] | null {
  const plain: LevelSpec = { ...spec, ropes: spec.ropes.map((r) => ({ ...r, c: 0 })), queue: spec.queue.map(() => 0), spare: 99 };
  const s0 = fromSpec(plain);
  const run = botRun(s0, rng, 0.3, 0);
  if (!run.win) return null;
  const s = fromSpec(plain), order: number[] = [];
  for (const [k, h] of run.path) for (const e of move(s, k, h)) if (e.k === 'pull') order.push(e.strand);
  return order.length === spec.ropes.length ? order : null;
}

export function generate(i: number, tune: Tune = TUNED[i] ?? { seed: 1, mix: 0.2 }): LevelSpec {
  const p = planOf(i);
  const rng = rngOf(tune.seed * 7919 + i * 104729 + 31);
  const holes = layout(shapeOf(i), 0);
  const N = holes.length;
  const dist = (x: number, y: number) => Math.hypot(holes[x][0] - holes[y][0], holes[x][1] - holes[y][1]);
  let diam = 0;
  for (let x = 0; x < N; x++) for (let y = x + 1; y < N; y++) diam = Math.max(diam, dist(x, y));
  /** A new rope a–b must not run straight over a pin of the ropes laid so far, nor theirs over its pins. */
  const nearLine = (q: number, a: number, b: number) => {
    const [px, py] = holes[q], [ax, ay] = holes[a], [bx, by] = holes[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = ((px - ax) * dx + (py - ay) * dy) / L2;
    return t > 0.02 && t < 0.98 && Math.abs(dx * (py - ay) - dy * (px - ax)) / Math.sqrt(L2) < 0.2;
  };
  const clear = (a: number, b: number, ropes: RopeSpec[]) => ropes.every((r) => !nearLine(r.a, a, b) && !nearLine(r.b, a, b) && !nearLine(a, r.a, r.b) && !nearLine(b, r.a, r.b));
  for (let attempt = 0; attempt < 400; attempt++) {
    // pins: pair up random holes, preferring long ropes across the board
    const left = shuffle([...Array(N).keys()], rng).slice(0, p.ropes * 2);
    const ropes: RopeSpec[] = [];
    const layers = shuffle([...Array(p.ropes).keys()], rng);
    let ok = true;
    for (let r = 0; r < p.ropes && ok; r++) {
      const a = left.shift()!;
      let best = -1, bestV = -Infinity;
      for (let q = 0; q < left.length; q++) {
        const f = dist(a, left[q]) / diam;
        const v = -Math.abs(f - (0.5 + rng() * 0.5)) + rng() * 0.3;
        if (f > 0.22 && v > bestV && clear(a, left[q], ropes)) { bestV = v; best = q; }
      }
      if (best < 0) { ok = false; break; }
      const b = left.splice(best, 1)[0];
      ropes.push({ a, b, c: 0, layer: layers[r] });
    }
    if (!ok) continue;
    // every rope starts tangled with something
    if (ropes.some((x, k) => !ropes.some((y, m) => m !== k && touch(holes[x.a], holes[x.b], holes[y.a], holes[y.b])))) continue;
    const triples = p.ropes / 3;
    const spec: LevelSpec = { holes, shape: shapeOf(i), ropes, queue: new Array(triples).fill(0), spare: SPARE };
    // colours: threes along the natural order, a fresh colour each (no two alike in a row)
    const order = naturalOrder(spec, rng);
    if (!order) continue;
    for (let s = 0; s < order.length; s++) {
      if (rng() >= tune.mix) continue;
      const t = Math.min(order.length - 1, s + 3 + Math.floor(rng() * 4));
      [order[s], order[t]] = [order[t], order[s]];
    }
    const cols = shuffle([...Array(p.colors).keys()], rng);
    const queue: number[] = [];
    for (let t = 0; t < triples; t++) {
      let c = t < p.colors ? cols[t] : Math.floor(rng() * p.colors);
      if (t >= p.colors && c === queue[t - 1]) c = (c + 1) % p.colors;
      queue.push(c);
    }
    order.forEach((r, k) => { ropes[r].c = queue[Math.floor(k / 3)]; });
    spec.queue = queue;
    for (const r of ropes) if (rng() < p.hidden) r.hidden = true;
    if (!solve(fromSpec(spec), 8)) continue;
    return spec;
  }
  throw new Error(`level ${i + 1}: could not build`);
}
