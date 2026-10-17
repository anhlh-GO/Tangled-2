// The trays of Tangle Knit, shared by the game and scripts/gen-levels.ts.
//
// How the ropes lie, move and come off is board.ts (the Tangled Rope rules on rope.ts
// physics). What happens to a rope once its group comes off is here: it rolls into a ball.
// Two colour trays are open at a time, three places each, plus a row of spare slots that
// take any colour. A ball goes into the open tray of its colour; with none, into a spare
// slot. A full tray (three) is knitted into the toy and the next tray of the level's queue
// takes its place, pulling in the balls of its colour waiting in the spare slots. Every
// spare slot taken loses the level. Won when the board is clear and no ball is waiting.
//
// Blockers: hidden — a rope drawn grey until it touches at most one other group (view only).

export interface RopeSpec { c: number; hidden?: boolean }
/** queue: the colour of each tray, in the order they open (one per triple); spare: spare slots. */
export interface LevelSpec { ropes: RopeSpec[]; queue: number[]; spare: number }

export interface State {
  ropes: RopeSpec[];
  gone: boolean[];
  trays: { c: number; n: number }[];   // the two open trays (c = -1: none left to open)
  queue: number[];      // tray colours in opening order
  next: number;         // the next tray of the queue to open
  spare: number[];      // balls waiting in the spare slots, in slot order
  cap: number;          // spare slots
  knitted: number;
  lost: boolean;
}

export type Ev =
  | { k: 'pull'; strand: number; c: number }
  | { k: 'knit'; c: number; tray: number }
  | { k: 'ball'; c: number; tray: number; slot: number }      // a ball lands: tray 0/1 (slot 0..2), or -1 = spare slot
  | { k: 'tray'; tray: number; c: number }                   // a new tray opens (c = -1: none left)
  | { k: 'fromSpare'; tray: number; from: number; slot: number }   // a waiting ball hops from spare slot `from` into the tray
  | { k: 'full' };

export function fromSpec(spec: LevelSpec): State {
  return {
    ropes: spec.ropes, gone: spec.ropes.map(() => false), knitted: 0, lost: false,
    trays: [0, 1].map((k) => ({ c: spec.queue[k] ?? -1, n: 0 })), queue: spec.queue, next: Math.min(2, spec.queue.length), spare: [], cap: spec.spare,
  };
}
export function clone(s: State): State {
  return { ...s, gone: s.gone.slice(), spare: s.spare.slice(), trays: s.trays.map((t) => ({ ...t })) };
}

/** Spare slots still free. */
export const room = (s: State): number => s.cap - s.spare.length;
export const MAX_SPARE = 6;
export const remaining = (s: State): number => s.gone.filter((g) => !g).length;
export const won = (s: State): boolean => remaining(s) === 0 && s.spare.length === 0;

/** The ropes of a group that came off the board (or a cut rope): balls into the trays, together. */
export function release(s: State, ropes: number[]): Ev[] {
  const evs: Ev[] = [];
  const off = ropes.filter((i) => !s.gone[i]);
  if (!off.length || s.lost) return evs;
  for (const j of off) {
    s.gone[j] = true;
    evs.push({ k: 'pull', strand: j, c: s.ropes[j].c });
    put(s, s.ropes[j].c, evs);
  }
  checkFull(s, evs);
  return evs;
}
/** Scissors: the cut rope's ball goes in too. */
export const cut = (s: State, i: number): Ev[] => release(s, [i]);

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
/** After all the balls of one move are in (a new tray may have taken some back): every spare slot taken loses. */
function checkFull(s: State, evs: Ev[]): void {
  if (s.spare.length >= s.cap && s.spare.length > 0) {
    s.lost = true;
    evs.push({ k: 'full' });
  }
}

/** Revive (+1 Slot on the Basket Full popup): one more spare slot, and the level goes on. */
export function addSlot(s: State): void {
  s.cap = Math.min(MAX_SPARE, Math.max(s.cap + 1, s.spare.length));
  s.lost = false;
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
