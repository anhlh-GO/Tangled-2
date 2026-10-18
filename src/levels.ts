// The 10 onboarding levels. Each is made offline by scripts/gen-levels.ts with the very
// rules the game plays (board.ts on rope.ts physics): ropes laid out untangled, then
// scrambled by carrying handles across each other (lifted, as the player does), and kept
// only if loading the result and playing those moves back in reverse clears the board.
// That reverse play is the hint line; the order the groups come off in gives the trays
// (threes of a colour, `mix` swaps some). Written to levelData.ts.

import type { LevelSpec } from './sim.ts';
import type { BoardData } from './board.ts';
import { LEVEL_DATA } from './levelData.ts';
import { rngOf } from './sim.ts';

export type Diff = 'easy' | 'normal' | 'hard' | 'super';
export const LEVEL_COUNT = 100;
/** Spare slots under the trays (the reference has four). */
export const SPARE = 4;

export const YARN = [
  { name: 'Pink', color: '#F59AD8' },
  { name: 'Blue', color: '#4AA0F2' },
  { name: 'Yellow', color: '#F8D23C' },
  { name: 'Green', color: '#5DCB3C' },
  { name: 'Purple', color: '#8C5FDD' },
  { name: 'Orange', color: '#F69A33' },
  { name: 'Red', color: '#E24B3C' },
  { name: 'Teal', color: '#3EC7C1' },
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
  { name: 'Snowman', palette: [0, 5, 7, 3, 6, 2, 4, 1] },
  { name: 'Cactus Pot', palette: [2, 1, 6, 3, 5, 0, 7, 4] },
  { name: 'Mushroom House', palette: [5, 1, 7, 4, 0, 6, 3, 2] },
  { name: 'Whale', palette: [0, 1, 6, 3, 4, 2, 7, 5] },
  { name: 'Penguin', palette: [7, 5, 4, 3, 2, 0, 6, 1] },
  { name: 'Owl', palette: [7, 4, 1, 3, 2, 6, 5, 0] },
  { name: 'Castle Tower', palette: [7, 6, 4, 1, 2, 3, 0, 5] },
  { name: 'Teapot', palette: [3, 6, 4, 5, 2, 1, 0, 7] },
  { name: 'Ice Cream', palette: [4, 2, 5, 1, 0, 7, 3, 6] },
  { name: 'Hamburger', palette: [0, 6, 5, 2, 7, 3, 1, 4] },
  { name: 'Double Decker', palette: [6, 2, 0, 4, 1, 3, 7, 5] },
  { name: 'Airplane', palette: [7, 3, 4, 0, 6, 5, 1, 2] },
  { name: 'Helicopter', palette: [5, 7, 6, 3, 1, 0, 2, 4] },
  { name: 'Tractor', palette: [3, 2, 6, 0, 4, 7, 1, 5] },
  { name: 'Ladybug', palette: [4, 1, 2, 5, 0, 7, 3, 6] },
  { name: 'Octopus', palette: [4, 2, 5, 3, 6, 7, 1, 0] },
  { name: 'Snail', palette: [1, 3, 2, 6, 7, 0, 4, 5] },
  { name: 'Turtle', palette: [6, 7, 3, 5, 0, 4, 2, 1] },
  { name: 'Frog', palette: [3, 0, 1, 4, 6, 7, 5, 2] },
  { name: 'Kitty', palette: [0, 2, 7, 4, 5, 3, 6, 1] },
  { name: 'Piggy', palette: [3, 5, 6, 4, 2, 0, 7, 1] },
  { name: 'Lighthouse', palette: [3, 7, 5, 6, 2, 4, 1, 0] },
  { name: 'Windmill', palette: [3, 1, 6, 7, 2, 0, 5, 4] },
  { name: 'Camping Tent', palette: [1, 0, 7, 2, 5, 6, 4, 3] },
  { name: 'Gift Box', palette: [2, 4, 0, 5, 7, 1, 6, 3] },
  { name: 'Strawberry', palette: [4, 3, 1, 2, 6, 0, 7, 5] },
  { name: 'Pineapple', palette: [0, 1, 6, 7, 2, 4, 5, 3] },
  { name: 'Flower Pot', palette: [2, 4, 3, 7, 6, 1, 0, 5] },
  { name: 'Dino', palette: [7, 2, 6, 0, 4, 3, 1, 5] },
  { name: 'Unicorn', palette: [7, 4, 2, 3, 0, 5, 6, 1] },
  { name: 'Panda', palette: [0, 4, 7, 3, 5, 1, 2, 6] },
  { name: 'Fox', palette: [1, 2, 6, 0, 7, 5, 3, 4] },
  { name: 'Elephant', palette: [4, 0, 3, 5, 2, 6, 1, 7] },
  { name: 'Giraffe', palette: [2, 5, 7, 3, 0, 4, 6, 1] },
  { name: 'Bumblebee', palette: [4, 0, 6, 7, 3, 2, 5, 1] },
  { name: 'Fire Truck', palette: [3, 2, 4, 6, 5, 7, 0, 1] },
  { name: 'Submarine', palette: [2, 5, 7, 1, 6, 0, 4, 3] },
  { name: 'Treasure Chest', palette: [2, 6, 5, 7, 0, 1, 3, 4] },
  { name: 'Carousel', palette: [4, 2, 5, 0, 1, 3, 6, 7] },
  { name: 'Dragon', palette: [0, 7, 2, 4, 6, 5, 3, 1] },
];
export const toyOf = (i: number): number => i % TOY_INFO.length;

/** power: the ropes a Power Scissors may snip (the most tangled). */
export interface Level { spec: LevelSpec; board: BoardData; solution: [number, number][]; power?: number[] }
/** The level as the player sees it: colours mapped through the toy's palette. */
export function levelFor(i: number): Level {
  const d = LEVEL_DATA[i] ?? LEVEL_DATA[LEVEL_DATA.length - 1];
  const pal = TOY_INFO[toyOf(i)].palette;
  const board: BoardData = JSON.parse(JSON.stringify(d.board));
  for (const r of board.ropes) r.color = pal[r.color];
  for (const t of board.traps ?? []) for (const r of t.ropes) r.color = pal[r.color];
  return {
    spec: { ropes: [...board.ropes, ...(board.traps ?? []).flatMap((t) => t.ropes)].map((r, k) => ({ c: r.color, hidden: d.hidden.includes(k) })), queue: d.queue.map((c) => pal[c]), spare: SPARE },
    board,
    solution: d.solution.map((m) => [m[0], m[1]] as [number, number]),
    power: d.power,
  };
}

/**
 * Onboarding: one level at a time, each adding a little. L5 and L10 are the two
 * peaks ("Hard Level!"), L6 a breather that brings in the mystery rope.
 */
/**
 * cols × rows of the grid; ropes (a multiple of 3, for the trays); pairs: groups of two ropes
 * sharing a handle; fixed / converted handles, forbidden slots and holes in the grid; and the
 * other elements of spec §11 (counts); scramble: how many handle moves tangle it; mix: how far the
 * tray colours stray from the untangling order. longMap: the level is two boards stacked, played
 * through a window of the first one's height; trap: a trapdoor with a little level under it.
 */
export interface Design {
  cols: number; rows: number; ropes: number; colors: number; diff: Diff; hidden: number; scramble: number; mix: number;
  pairs: number; fixed: number; converted: number; forbidden: number; holes: number;
  pillars: number; rail: number; umbrellas: number; toFixed: number; gears: number; multi: number; toggles: number; dynFixed: number;
  longMap: boolean; trap: boolean;
}
/** Where each element is first met (1-based level) — the level shows its card and points at it. */
export const ELEMENT_AT = { pair: 3, forbidden: 4, fixed: 6, hidden: 6, converted: 7, holes: 7, pillar: 12, rail: 16, umbrella: 21, toFixed: 26, gear: 31, multi: 36, toggle: 41, longMap: 46, trap: 51, dynFixed: 56 } as const;
export type Element = keyof typeof ELEMENT_AT;

/**
 * The difficulty curve: a saw-tooth. In every ten levels: 1–4 climb, 5 is hard, 6 a breather,
 * 7–9 climb again, 10 is super hard; each ten a notch harder than the last (more ropes, deeper
 * scrambles, more elements mixed in). Elements come in one at a time (ELEMENT_AT), alone on their
 * first level, then mix with the others.
 */
function design(i: number): Design {
  const n = i + 1, block = Math.floor(i / 10), pos = i % 10;
  const diff: Diff = pos === 9 ? 'super' : pos === 4 ? 'hard' : pos === 5 || n <= 3 ? 'easy' : 'normal';
  const rng = rngOf(n * 7331 + 11);
  // size: ropes by difficulty and block (6 … 15); the grid grows with them
  const step = Math.min(3, block < 1 ? 0 : block < 3 ? 1 : block < 6 ? 2 : 3);
  let ropes = diff === 'easy' ? 6 + 3 * Math.min(1, step) : diff === 'normal' ? 9 + 3 * Math.min(1, step) : diff === 'hard' ? 12 + 3 * Math.min(1, step >> 1) : 15;
  if (n <= 2) ropes = n === 1 ? 6 : 9;
  if (n === 5 || n === 10) ropes = n === 5 ? 12 : 15;
  const colors = Math.min(5, ropes / 3);
  let [cols, rows] = ropes <= 6 ? [4, 6] : ropes <= 9 ? [5, 7] : ropes <= 12 ? [6, 8] : [6, 9];
  const scramble = Math.round(ropes * (diff === 'easy' ? 0.7 : diff === 'normal' ? 0.95 : diff === 'hard' ? 1.2 : 1.4) + block * 0.6);
  const mix = diff === 'easy' ? 0.05 : diff === 'normal' ? 0.25 + block * 0.02 : diff === 'hard' ? 0.45 : 0.55;
  void cols; void rows;
  const d: Design = { cols, rows, ropes, colors, diff, hidden: 0, scramble, mix, pairs: 0, fixed: 0, converted: 0, forbidden: 0, holes: 0, pillars: 0, rail: 0, umbrellas: 0, toFixed: 0, gears: 0, multi: 0, toggles: 0, dynFixed: 0, longMap: false, trap: false };
  // the elements met so far; a level that introduces one has it alone (and generously)
  const met = (Object.keys(ELEMENT_AT) as Element[]).filter((e) => ELEMENT_AT[e] <= n);
  const intro = met.filter((e) => ELEMENT_AT[e] === n);
  const pick = intro.length ? intro : met.filter(() => rng() < (diff === 'easy' ? 0.2 : diff === 'normal' ? 0.3 : 0.42));
  const many = diff === 'super' || diff === 'hard' ? 2 : 1;
  for (const e of pick) {
    if (e === 'pair') d.pairs = Math.min(Math.floor(ropes / 6), many);
    else if (e === 'forbidden') d.forbidden = 1 + many;
    else if (e === 'fixed') d.fixed = many;
    else if (e === 'hidden') d.hidden = 0.2;
    else if (e === 'converted') d.converted = many;
    else if (e === 'holes') d.holes = 2;
    else if (e === 'pillar') d.pillars = many;
    else if (e === 'rail') d.rail = 1;
    else if (e === 'umbrella') d.umbrellas = 1;
    else if (e === 'toFixed') d.toFixed = 1;
    else if (e === 'gear') d.gears = 1;
    else if (e === 'multi') d.multi = many;
    else if (e === 'toggle') d.toggles = 1;
    else if (e === 'dynFixed') d.dynFixed = 1;
  }
  // long maps and trapdoors: their own levels (rare, never on a peak)
  if (n === ELEMENT_AT.longMap || (n > ELEMENT_AT.longMap && (pos === 2 || pos === 7) && n % 20 === (pos === 2 ? 3 : 18) % 20)) { d.longMap = true; d.pairs = 0; }
  if (n === ELEMENT_AT.trap || (n > ELEMENT_AT.trap && (pos === 3 || pos === 8) && block % 2 === (pos === 3 ? 1 : 0))) d.trap = true;
  if (d.longMap && d.trap) d.trap = false;
  // a trapdoor takes a 4 × 3 patch: one more row, at least five columns
  if (d.trap) { d.rows = rows + 1; d.cols = Math.max(cols, 5); }
  return d;
}
export const DESIGN: Design[] = Array.from({ length: LEVEL_COUNT }, (_, i) => design(i));
export const diffOf = (i: number): Diff => DESIGN[i]?.diff ?? 'normal';
/** The level (1-based) each blocker first shows up. */
export const BLOCKER_AT = { hidden: ELEMENT_AT.hidden, pair: ELEMENT_AT.pair, forbidden: ELEMENT_AT.forbidden, fixed: ELEMENT_AT.fixed, converted: ELEMENT_AT.converted, pillar: ELEMENT_AT.pillar, rail: ELEMENT_AT.rail, umbrella: ELEMENT_AT.umbrella, toFixed: ELEMENT_AT.toFixed, gear: ELEMENT_AT.gear, multi: ELEMENT_AT.multi, toggle: ELEMENT_AT.toggle, longMap: ELEMENT_AT.longMap, trap: ELEMENT_AT.trap, dynFixed: ELEMENT_AT.dynFixed } as const;
export type Blocker = keyof typeof BLOCKER_AT;

export interface Plan { diff: Diff; colors: number; ropes: number; hidden: number }
export const planOf = (i: number): Plan => { const d = DESIGN[i] ?? DESIGN[DESIGN.length - 1]; return { diff: d.diff, colors: d.colors, ropes: d.ropes, hidden: d.hidden }; };

export function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}
