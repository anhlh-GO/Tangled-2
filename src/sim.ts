// The rules of Tangle Knit, shared by the game, the bots and the tuner.
//
// Untangle with real rope (as in Tangled Rope): holes stand on the board (a grid,
// a ring, a heart…); every rope runs between two pins sitting in two of the holes.
// Ropes never pass through each other. Every pair of ropes has a relation, kept
// for as long as they both lie on the board:
//   none · one over the other (they cross once) · one wrapped round the other (a hook)
// A move lifts one pin and carries it, above everything, to an empty hole:
//   - towards a rope it lies OVER (or doesn't touch), it is free: afterwards it lies
//     over that rope if their lines cross, and the two are apart if not;
//   - towards a rope it lies UNDER (or is hooked with), it is caught: it stays under
//     that rope if their lines cross, and if not it bends round it — a hook.
// So a rope pinned under another only comes free once the one on top moves away.
// A rope with no relation left comes off by itself and rolls into a ball.
//
// Trays (as in the reference): two colour trays are open at a time, three places
// each, plus a row of spare slots that take any colour. A ball goes into the open
// tray of its colour; with none, into a spare slot. A full tray (three) is knitted
// into the toy and the next tray of the level's queue takes its place, pulling in
// the balls of its colour waiting in the spare slots. A ball with nowhere to go
// loses the level. Won when the board is clear.
//
// Blockers (see levels.ts for when each one starts):
//   hidden — grey until it is tangled with at most one other rope (view only; the rules know its colour)
//   lock   — a padlocked hole: its pin can't move and its rope can't come off until the key rope is off

export interface RopeSpec { a: number; b: number; c: number; layer: number; hidden?: boolean; key?: boolean }
/** holes: board positions (units: about one pin gap), y down. */
/** queue: the colour of each tray, in the order they open (one per triple); spare: spare slots. */
export interface LevelSpec { holes: [number, number][]; shape?: string; ropes: RopeSpec[]; queue: number[]; spare: number; lock?: number }

export interface State {
  holes: [number, number][];   // hole positions on the board
  ropes: RopeSpec[];    // colours and blockers (ends live in `end`)
  end: number[];        // 2 per rope: the holes its two pins sit in
  gone: boolean[];
  trays: { c: number; n: number }[];   // the two open trays (c = -1: none left to open)
  queue: number[];      // tray colours in opening order
  next: number;         // the next tray of the queue to open
  spare: number[];      // balls waiting in the spare slots, in slot order
  cap: number;          // spare slots
  knitted: number;
  lost: boolean;
  lock: number;         // the padlocked hole, -1 = none
  unlocked: boolean;    // the key rope has come off
  moves: number;
  /** rel[i*n+j]: how rope i lies against rope j — NONE, OVER, UNDER, WRAP (i hooked round j), WRAPPED (j hooked round i). */
  rel: Int8Array;
}

export const NONE = 0, OVER = 1, UNDER = 2, WRAP = 3, WRAPPED = 4;
const MIRROR = [NONE, UNDER, OVER, WRAPPED, WRAP];

export type Ev =
  | { k: 'move'; rope: number; end: number; from: number; to: number }
  | { k: 'pull'; strand: number; c: number }
  | { k: 'knit'; c: number; tray: number }
  | { k: 'ball'; c: number; tray: number; slot: number }      // a ball lands: tray 0/1 (slot 0..2), or -1 = spare slot
  | { k: 'tray'; tray: number; c: number }                   // a new tray opens (c = -1: none left)
  | { k: 'fromSpare'; tray: number; from: number; slot: number }   // a waiting ball hops from spare slot `from` into the tray
  | { k: 'unlock'; peg: number }
  | { k: 'full' };

type P = [number, number];
const orient = (a: P, b: P, c: P): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/** Do segments a–b and c–d cross (properly)? */
export function touch(a: P, b: P, c: P, d: P): boolean {
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** The level as laid out: where two ropes cross, the one with the higher layer lies on top. */
export function fromSpec(spec: LevelSpec): State {
  const n = spec.ropes.length;
  const rel = new Int8Array(n * n);
  const H = spec.holes;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = spec.ropes[i], b = spec.ropes[j];
    if (i !== j && touch(H[a.a], H[a.b], H[b.a], H[b.b])) rel[i * n + j] = a.layer > b.layer ? OVER : UNDER;
  }
  return {
    holes: spec.holes, ropes: spec.ropes, end: spec.ropes.flatMap((r) => [r.a, r.b]),
    gone: new Array(n).fill(false), knitted: 0, lost: false,
    trays: [0, 1].map((k) => ({ c: spec.queue[k] ?? -1, n: 0 })), queue: spec.queue, next: Math.min(2, spec.queue.length), spare: [], cap: spec.spare,
    lock: spec.lock ?? -1, unlocked: !spec.ropes.some((t) => t.key), moves: 0, rel,
  };
}

export function clone(s: State): State {
  return { ...s, end: s.end.slice(), gone: s.gone.slice(), spare: s.spare.slice(), trays: s.trays.map((t) => ({ ...t })), rel: s.rel.slice() };
}

export const relOf = (s: State, i: number, j: number): number => s.rel[i * s.ropes.length + j];
export const crosses = (s: State, i: number, j: number): boolean => relOf(s, i, j) !== NONE;
/** Is rope i caught by rope j (under it, or hooked with it)? Then moving i can't get it clear of j. */
export const caught = (s: State, i: number, j: number): boolean => relOf(s, i, j) >= UNDER;
/**
 * What rope i would be to every other rope if its end `e` (0/1) were at point p
 * (the moving pin rides above everything): one code per rope, as in `rel`.
 */
export function relateRow(s: State, i: number, e: number, p: P): Int8Array {
  const n = s.ropes.length, row = new Int8Array(n);
  const q = s.holes[s.end[2 * i + (e ^ 1)]];
  for (let j = 0; j < n; j++) {
    if (j === i || s.gone[j]) continue;
    const x = touch(p, q, s.holes[s.end[2 * j]], s.holes[s.end[2 * j + 1]]);
    row[j] = caught(s, i, j) ? (x ? UNDER : WRAP) : x ? OVER : NONE;
  }
  return row;
}
function setRow(s: State, i: number, row: Int8Array): void {
  const n = s.ropes.length;
  for (let j = 0; j < n; j++) { if (j === i) continue; s.rel[i * n + j] = row[j]; s.rel[j * n + i] = MIRROR[row[j]]; }
}
/** The ropes still on the board that rope i is tangled with. */
export const tangled = (s: State, i: number): number[] => {
  const out: number[] = [];
  for (let j = 0; j < s.ropes.length; j++) if (j !== i && !s.gone[j] && crosses(s, i, j)) out.push(j);
  return out;
};
export const free = (s: State, i: number): boolean => !s.gone[i] && tangled(s, i).length === 0;
/** Rope i has a pin in the padlocked hole and the key is not in yet. */
export const lockedOn = (s: State, i: number): boolean => !s.unlocked && s.lock >= 0 && (s.end[2 * i] === s.lock || s.end[2 * i + 1] === s.lock);
/** Spare slots still free. */
export const room = (s: State): number => s.cap - s.spare.length;
export const MAX_SPARE = 6;
/** Which rope / end sits in hole h (-1 = empty). */
export function pinAt(s: State, h: number): number {
  for (let k = 0; k < s.end.length; k++) if (s.end[k] === h && !s.gone[k >> 1]) return k;
  return -1;
}
export function emptyHoles(s: State): number[] {
  const used = new Array(s.holes.length).fill(false);
  s.end.forEach((h, k) => { if (!s.gone[k >> 1]) used[h] = true; });
  return used.map((u, h) => (u ? -1 : h)).filter((h) => h >= 0);
}
/** Can the pin `k` (rope k>>1, end k&1) be dragged into hole h? */
export function canMove(s: State, k: number, h: number): boolean {
  if (s.lost || s.gone[k >> 1] || s.end[k] === h) return false;
  if (!s.unlocked && s.end[k] === s.lock) return false;
  return pinAt(s, h) < 0;
}

export const remaining = (s: State): number => s.gone.filter((g) => !g).length;
export const won = (s: State): boolean => remaining(s) === 0 && s.spare.length === 0;

/** A ball of colour c lands: its open tray, else a spare slot. */
function put(s: State, c: number, evs: Ev[]): void {
  let t = -1;
  s.trays.forEach((tr, k) => { if (tr.c === c && tr.n < 3 && (t < 0 || tr.n > s.trays[t].n)) t = k; });
  if (t < 0) {
    s.spare.push(c);
    evs.push({ k: 'ball', c, tray: -1, slot: s.spare.length - 1 });
    return;
  }
  evs.push({ k: 'ball', c, tray: t, slot: s.trays[t].n });
  if (++s.trays[t].n >= 3) done(s, t, evs);
}
/** Tray t is full: knit it, open the next one, and let the waiting balls of its colour hop in. */
function done(s: State, t: number, evs: Ev[]): void {
  s.knitted++;
  evs.push({ k: 'knit', c: s.trays[t].c, tray: t });
  const c = s.next < s.queue.length ? s.queue[s.next++] : -1;
  s.trays[t] = { c, n: 0 };
  evs.push({ k: 'tray', tray: t, c });
  if (c < 0) return;
  for (let k = 0; k < s.spare.length && s.trays[t].n < 3;) {
    if (s.spare[k] !== c) { k++; continue; }
    s.spare.splice(k, 1);
    evs.push({ k: 'fromSpare', tray: t, from: k, slot: s.trays[t].n });
    if (++s.trays[t].n >= 3) { done(s, t, evs); return; }
  }
}

/** After all the balls of one move are in: a ball left with nowhere to go loses. */
function checkFull(s: State, evs: Ev[]): void {
  if (s.spare.length > s.cap) {
    s.lost = true;
    evs.push({ k: 'full' });
  }
}

/** Every rope that crosses nothing (and isn't held by the lock) comes off, together. */
function settle(s: State, evs: Ev[]): void {
  for (let round = 0; round < 3; round++) {
    const off: number[] = [];
    for (let i = 0; i < s.ropes.length; i++) if (free(s, i) && !lockedOn(s, i)) off.push(i);
    if (!off.length) return;
    for (const j of off) {
      s.gone[j] = true;
      evs.push({ k: 'pull', strand: j, c: s.ropes[j].c });
      put(s, s.ropes[j].c, evs);
    }
    afterOff(s, off, evs);
    // the key coming off may let a rope on the padlocked hole go too: go round again
  }
}

export function move(s: State, k: number, h: number): Ev[] {
  const evs: Ev[] = [];
  if (!canMove(s, k, h)) return evs;
  evs.push({ k: 'move', rope: k >> 1, end: k & 1, from: s.end[k], to: h });
  setRow(s, k >> 1, relateRow(s, k >> 1, k & 1, s.holes[h]));
  s.end[k] = h;
  s.moves++;
  settle(s, evs);
  if (evs.some((e) => e.k === 'pull')) checkFull(s, evs);
  return evs;
}

/** Ropes came off: the key opens the lock. */
function afterOff(s: State, off: number[], evs: Ev[]): void {
  if (!s.unlocked && off.some((j) => s.ropes[j].key)) {
    s.unlocked = true;
    evs.push({ k: 'unlock', peg: s.lock });
  }
}

/** All the moves there are right now, as [pin, hole]. */
export function moves(s: State): [number, number][] {
  const out: [number, number][] = [];
  const empty = emptyHoles(s);
  for (let k = 0; k < s.end.length; k++) {
    if (s.gone[k >> 1] || (!s.unlocked && s.end[k] === s.lock)) continue;
    for (const h of empty) out.push([k, h]);
  }
  return out;
}
export const stuck = (s: State): boolean => !won(s) && !s.lost && moves(s).length === 0;

// ------------------------------------------------------------ boosters

/** Scissors: cut any rope (tangled or not) straight into the basket. */
export function cut(s: State, i: number): Ev[] {
  const evs: Ev[] = [];
  if (s.gone[i] || s.lost) return evs;
  s.gone[i] = true;
  evs.push({ k: 'pull', strand: i, c: s.ropes[i].c });
  put(s, s.ropes[i].c, evs);
  afterOff(s, [i], evs);
  settle(s, evs);   // cutting a rope can leave others with nothing to cross
  checkFull(s, evs);
  return evs;
}

/** +Slot / revive: one more spare slot (and the level goes on). */
export function addSlot(s: State): void {
  s.cap = Math.min(MAX_SPARE, Math.max(s.cap + 1, s.spare.length));
  s.lost = false;
}

// ------------------------------------------------------------ bots

/** Total crossings on the board. */
export function crossings(s: State): number {
  let n = 0;
  for (let i = 0; i < s.ropes.length; i++) if (!s.gone[i]) for (let j = i + 1; j < s.ropes.length; j++) if (!s.gone[j] && crosses(s, i, j)) n++;
  return n;
}

/** Weight of a relation for the bots: a hook is worse than a plain crossing. */
const W = [0, 1, 1.2, 1.5, 1.5];

/** What a move would do: the ropes it frees and the change in tangle — without making it. */
export function preview(s: State, k: number, h: number): { off: number[]; dx: number } {
  const i = k >> 1, n = s.ropes.length;
  const row = relateRow(s, i, k & 1, s.holes[h]);
  let dx = 0;
  for (let j = 0; j < n; j++) if (j !== i && !s.gone[j]) dx += W[row[j]] - W[relOf(s, i, j)];
  const other = s.end[k ^ 1];
  const held = (r: number) => !s.unlocked && s.lock >= 0 && (r === i ? [h, other] : [s.end[2 * r], s.end[2 * r + 1]]).includes(s.lock);
  const off: number[] = [];
  if (!row.some((v, j) => v !== NONE && !s.gone[j]) && !held(i)) off.push(i);
  for (let j = 0; j < n; j++) {
    if (j === i || s.gone[j] || row[j] !== NONE || held(j)) continue;
    let any = false;
    for (let m = 0; m < n && !any; m++) if (m !== i && m !== j && !s.gone[m] && relOf(s, j, m) !== NONE) any = true;
    if (!any) off.push(j);
  }
  return { off, dx };
}

/** How good a move looks; `care` (0..1) = how much the bot minds the trays. */
export function score(s: State, k: number, h: number, care = 1): number {
  const { off, dx } = preview(s, k, h);
  let v = -dx * 0.7;
  if (!off.length) return v;
  // where the balls would go (a scratch copy of the trays)
  const t = clone(s);
  const evs: Ev[] = [];
  for (const j of off) put(t, s.ropes[j].c, evs);
  let w = 0;
  for (const e of evs) {
    if (e.k === 'ball') w += e.tray >= 0 ? 2.5 : -0.6 - 0.5 * s.spare.length;
    else if (e.k === 'knit') w += 4;
    else if (e.k === 'fromSpare') w += 1.5;
  }
  if (t.spare.length > t.cap) w -= 30;
  else if (t.spare.length === t.cap) w -= 4;
  return v + 1 + w * care;
}

export function rngOf(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const keyOf = (s: State, k = -1, h = -1): string => s.end.map((x, q) => (s.gone[q >> 1] ? '-' : q === k ? h : x)).join(',');

/**
 * A bot: picks moves by score, softmax at temperature `temp`; positions it has
 * already seen are marked down so it doesn't walk in circles.
 */
export function botRun(s0: State, rng: () => number, temp = 1, care = 1, limit = 0): { win: boolean; path: [number, number][]; progress: number } {
  const s = clone(s0);
  const path: [number, number][] = [];
  const seenPins = new Map<string, number>();
  const cap = limit || 10 + s.ropes.length * 10;
  for (let step = 0; step < cap; step++) {
    if (won(s) || s.lost) break;
    const ms = moves(s);
    if (!ms.length) break;
    // positions seen before (by pins only: cheap, and close enough to steer clear of loops) are marked down
    const vs = ms.map(([k, h]) => score(s, k, h, care) + rng() * 0.05 - (seenPins.get(keyOf(s, k, h)) ?? 0) * 3);
    let pick = 0;
    if (temp <= 0.06) pick = vs.indexOf(Math.max(...vs));
    else {
      const mx = Math.max(...vs);
      const ws = vs.map((v) => Math.exp((v - mx) / temp));
      let r = rng() * ws.reduce((a, b) => a + b, 0);
      for (; pick < ws.length - 1; pick++) if ((r -= ws[pick]) <= 0) break;
    }
    path.push(ms[pick]);
    move(s, ms[pick][0], ms[pick][1]);
    const pk = keyOf(s);
    seenPins.set(pk, (seenPins.get(pk) ?? 0) + 1);
  }
  return { win: won(s), path, progress: 1 - remaining(s) / s.ropes.length };
}

/** A winning line from careful play, or null (used for hints and as proof). */
export function solve(s0: State, tries = 30): [number, number][] | null {
  for (let r = 0; r < tries; r++) {
    const res = botRun(s0, rngOf(r * 11 + 3), r === 0 ? 0.05 : 0.35);
    if (res.win) return res.path;
  }
  return null;
}
