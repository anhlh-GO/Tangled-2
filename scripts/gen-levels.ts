// Make the levels with the very rules the game plays (src/board.ts on src/rope.ts):
//   1. lay the groups out untangled: each rope in an arc between two nearby slots (a pair group:
//      three handles, the middle one holding both ropes), clear of each other, of every handle and
//      pillar; the §11 elements set first — holes, pillars, a rail (one rope's handle on it), an
//      umbrella (its reach kept empty), multi-slot handles, a gear, fixed / dynamic-fixed handles;
//   2. scramble: carry handles (picked, lifted, dropped — reach, stretch, rails, gears and every
//      other rule checked as for the player) across other groups' ropes, loose groups first;
//   3. keep it only if every group overlaps another, nothing comes loose on its own, and loading
//      the result fresh and playing the moves back in reverse clears the board. That reverse play
//      is the hint line; then, without touching it: converted handles (as many moves as it makes
//      of them), a time-to-fixed handle (moved only early on), a toggling one, forbidden slots
//      (never used by it);
//   4. trays: threes along the order the groups come off (a pair stays in one three), `mix` swaps some.
// A long map is two such boards stacked; a trapdoor level keeps a 4 × 3 patch free and puts a
// little 3-rope level under it.
//   node scripts/gen-levels.ts 3-5 --out=f   (run several ranges at once), then
//   node scripts/gen-levels.ts --merge=f1,f2,...   writes src/levelData.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { Board, DEBUG, ESlot, MODEL, type BoardData, type HandleData, type RopeData, type SlotData, type TrapData } from '../src/board.ts';
import { CFG } from '../src/config.ts';
import { DESIGN, LEVEL_COUNT, shuffle, type Design } from '../src/levels.ts';
import { pitchX } from '../src/shapes.ts';
import { rngOf } from '../src/sim.ts';
import { LEVEL_DATA, type LevelData } from '../src/levelData.ts';

type P = [number, number];
const argv = process.argv.slice(2);
const arg = argv.find((a) => /^\d+-\d+$/.test(a)) ?? `1-${LEVEL_COUNT}`;
const [from, to] = arg.split('-').map(Number);
const outFile = argv.find((a) => a.startsWith('--out='))?.slice(6);
const merge = argv.find((a) => a.startsWith('--merge='))?.slice(8).split(',');
const WHY: Record<string, number> = {};
const fail = (r: string): null => { WHY[r] = (WHY[r] ?? 0) + 1; return null; };
if (argv.includes('--stress')) DEBUG.stress = true;

function segDist(a: P, b: P, c: P, d: P): number {
  const pt = (p: P, q: P, r: P) => { const dx = r[0] - q[0], dy = r[1] - q[1], L = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / L)); return Math.hypot(q[0] + dx * t - p[0], q[1] + dy * t - p[1]); };
  const o = (p: P, q: P, r: P) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}

/** Carry handle h into slot s as the player would (finger a little below it, straight across). True if it landed there. */
function carry(b: Board, h: number, s: number): boolean {
  // under an open umbrella (the handle, or where it goes): wait for it to close, as a player would
  for (let q = 0; q < 900 && (b.pickBlock(h) === 'umbrella' || b.slots[s].covered); q++) b.run(1);
  const p = b.handlePos(h), t = b.slots[s];
  const f0: P = [p[0], p[2] + CFG.distanceFromFinger], f1: P = [t.x, t.z + CFG.distanceFromFinger];
  b.setFinger(f0);
  b.press(h);
  b.run(2);
  const st = () => b.handles[h].state as string;
  if (st() !== 'operate') { b.up(); b.run(20); return false; }
  const n = Math.max(6, Math.ceil(Math.hypot(f1[0] - f0[0], f1[1] - f0[1]) / 0.2));
  for (let q = 1; q <= n; q++) { b.setFinger([f0[0] + ((f1[0] - f0[0]) * q) / n, f0[1] + ((f1[1] - f0[1]) * q) / n]); b.run(1); if (st() !== 'operate') break; }
  b.run(6);
  b.up();
  for (let q = 0; q < 300 && st() !== 'stable' && st() !== 'disappear'; q++) b.run(1);
  b.run(30);
  return b.handles[h].slot === s;
}

/** Does the straight way a → c cross a rope of a group other than handle h's (seen from above)? (only: of these groups) */
function crossesOthers(b: Board, h: number, a: P, c: P, only?: Set<number>): boolean {
  const g = b.handles[h].group;
  return b.ropes.some((m) => {
    if (m.gone || m.dormant || m.group === g || (only && !only.has(m.group))) return false;
    const r = b.world.ropes[m.w];
    for (let q = 0; q + 1 < r.n; q += 2) {
      const e = Math.min(r.n - 1, q + 2);
      if (segDist(a, c, [r.x[q * 3], r.x[q * 3 + 2]], [r.x[e * 3], r.x[e * 3 + 2]]) < 0.15) return true;
    }
    return false;
  });
}

interface Built { level: BoardData; solution: [number, number][]; order: number[][]; hidden: number[]; power: number[] }
interface Opts { px?: number; reserve?: (row: number, col: number) => boolean }

/** One board: lay out, scramble, check by reverse play; the §11 handle extras on top. */
function build(d: Design, rng: () => number, o: Opts = {}): Built | null {
  const { rows, cols } = d, px = o.px ?? pitchX(cols, rows);
  const slots: SlotData[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) slots.push({ row: r, col: c, type: ESlot.Normal });
  const S = (r: number, c: number) => (r >= 0 && c >= 0 && r < rows && c < cols ? r * cols + c : -1);
  const xy = (s: number): P => [(slots[s].col - (cols - 1) / 2) * px, (slots[s].row - (rows - 1) / 2) * CFG.STEP];
  const dist = (a: number, b: number) => Math.hypot(xy(a)[0] - xy(b)[0], xy(a)[1] - xy(b)[1]);
  /** Slots nothing may be put in (holes, the trapdoor patch, an umbrella's reach, rail slots but the rail handle's). */
  const blocked = new Set<number>();
  slots.forEach((s, i) => { if (o.reserve?.(s.row, s.col)) blocked.add(i); });
  const rim = shuffle(slots.map((_, s) => s).filter((s) => !blocked.has(s) && (slots[s].row === 0 || slots[s].row === rows - 1 || slots[s].col === 0 || slots[s].col === cols - 1)), rng);
  for (const s of rim.slice(0, d.holes)) { slots[s].type = ESlot.None; blocked.add(s); }
  // an umbrella in the middle somewhere, its reach kept clear
  for (let u = 0; u < d.umbrellas; u++) {
    const s = shuffle(slots.map((_, q) => q).filter((q) => slots[q].row > 0 && slots[q].row < rows - 1 && slots[q].col > 0 && slots[q].col < cols - 1 && !blocked.has(q)), rng)[0];
    if (s === undefined) return fail('umbrella');
    slots[s].umbrella = { open: 3 + Math.floor(rng() * 3), close: 3 + Math.floor(rng() * 3), init: rng() < 0.5 };
    blocked.add(s);   // its reach stays playable: handles there wait for it to close
  }
  // a rail: a straight run of 3–4 slots in a row
  const rail: number[] = [];
  if (d.rail) {
    for (let tries = 0; tries < 30 && !rail.length; tries++) {
      const len = 3 + Math.floor(rng() * 2), r = Math.floor(rng() * rows), c0 = Math.floor(rng() * (cols - len + 1));
      const run = Array.from({ length: len }, (_, k) => S(r, c0 + k));
      if (run.every((q) => q >= 0 && !blocked.has(q))) rail.push(...run);
    }
    if (!rail.length) return fail('rail');
    for (const q of rail) { slots[q].rail = 1; blocked.add(q); }
  }
  // pillars at slot corners, away from the rim
  const pillars: P[] = [];
  for (let k = 0; k < d.pillars; k++) {
    const s = shuffle(slots.map((_, q) => q).filter((q) => slots[q].row < rows - 1 && slots[q].col < cols - 1 && slots[q].type !== ESlot.None && !slots[q].pillar), rng)[0];
    if (s === undefined) return fail('pillar');
    slots[s].pillar = 4;
    pillars.push([xy(s)[0] + px / 2, xy(s)[1] + CFG.STEP / 2]);
  }
  // 1. untangled groups: each rope an arc (longer than the gap, the slack bulges sideways as rope.ts lays it)
  const handles: HandleData[] = [], ropes: RopeData[] = [];
  const arcs: P[][] = [];
  const arcOf = (A: P, B: P, L: number): P[] => {
    const dx = B[0] - A[0], dz = B[1] - A[1], dd = Math.hypot(dx, dz) || 1;
    const bulge = Math.sqrt(Math.max(0, L * L - dd * dd)) * 0.45, out: P[] = [];
    for (let q = 0; q <= 16; q++) { const t = q / 16, sn = Math.sin(Math.PI * t) * bulge; out.push([A[0] + dx * t - (dz / dd) * sn, A[1] + dz * t + (dx / dd) * sn]); }
    return out;
  };
  const polyDist = (p: P[], q: P[]) => { let m = Infinity; for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) m = Math.min(m, segDist(p[i], p[i + 1], q[j], q[j + 1])); return m; };
  const occupied = new Set<number>();   // slots a handle (or a cell of one) sits in
  /** The arc from point A to point B (or B → A: it bulges the other way) if it is clear of everything so far. */
  const lay = (A: P, B: P, L: number, mine: number[], own: P[] | null = null): { pts: P[]; flip: boolean } | null => {
    for (const flip of rng() < 0.5 ? [false, true] : [true, false]) {
      const pts = flip ? arcOf(B, A, L) : arcOf(A, B, L);
      if (pts.some((p) => Math.abs(p[0]) > ((cols - 1) / 2) * px + 0.45 || Math.abs(p[1]) > ((rows - 1) / 2) * CFG.STEP + 0.45)) continue;
      const far = (q: P[]) => (own ? q.filter((p) => Math.hypot(p[0] - A[0], p[1] - A[1]) > 0.7) : q);
      if (arcs.some((a) => (a === own ? polyDist(far(a), far(pts)) : polyDist(a, pts)) < 0.5)) continue;
      if ([...occupied].some((u) => !mine.includes(u) && polyDist([xy(u), xy(u)], pts) < 0.55)) continue;
      if (pillars.some((p) => polyDist([p, p], pts) < 0.45)) continue;
      return { pts, flip };
    }
    return null;
  };
  const free = (s: number) => s >= 0 && !blocked.has(s) && !occupied.has(s) && slots[s].type !== ESlot.None;
  const near = (a: number) => shuffle(slots.map((_, s) => s), rng).filter((b) => b !== a && free(b) && dist(a, b) > CFG.STEP * 1.3 && dist(a, b) < CFG.STEP * 3.0);
  const len = (A: P, B: P) => +(Math.hypot(A[0] - B[0], A[1] - B[1]) + (0.3 + rng() * 0.45) * CFG.STEP).toFixed(3);
  const groups = shuffle([...Array(d.ropes - d.pairs * 2).fill(1), ...Array(d.pairs).fill(2)], rng);
  // the rail rope goes first (a single one)
  if (d.rail) { const k = groups.indexOf(1); if (k < 0) return fail('rail'); groups.splice(k, 1); groups.unshift(1); }
  let multiLeft = d.multi;
  for (let gi = 0; gi < groups.length; gi++) {
    const size = groups[gi], onRail = !!d.rail && gi === 0;
    let ok = false;
    const starts = onRail ? shuffle(rail.slice(), rng) : shuffle(slots.map((_, s) => s).filter(free), rng);
    for (const a of starts) {
      // a multi-slot handle: its first cell here, the rope tied to one of its cells
      let model = 1, cells: number[] = [a], ca = 0;
      if (size === 1 && multiLeft > 0 && !onRail) {
        const m = [2, 3, 2, 3, 4, 5, 6, 7, 8, 9, 10][Math.floor(rng() * (d.diff === 'easy' ? 4 : 11))];
        const cs = MODEL[m].map(([dr, dc]) => S(slots[a].row + dr, slots[a].col + dc));
        if (cs.every((q) => q === a || free(q))) { model = m; cells = cs; ca = Math.floor(rng() * cs.length); }
      }
      const A = xy(cells[ca]);
      for (const b of near(cells[ca])) {
        if (cells.includes(b)) continue;
        const L1 = len(A, xy(b)), o1 = lay(A, xy(b), L1, cells);
        if (!o1) continue;
        if (size === 1) {
          handles.push({ slot: a, ...(model > 1 ? { model } : {}), ...(onRail ? { rail: 1 } : {}) }, { slot: b });
          const ha = handles.length - 2;
          ropes.push(o1.flip ? { a: ha + 1, b: ha, color: 0, length: L1, ...(ca ? { cb: ca } : {}) } : { a: ha, b: ha + 1, color: 0, length: L1, ...(ca ? { ca } : {}) });
          for (const q of cells) occupied.add(q);
          occupied.add(b); arcs.push(o1.pts);
          if (model > 1) multiLeft--;
          ok = true;
          break;
        }
        // a pair: a – b – c, b holding both ropes
        occupied.add(a); occupied.add(b); arcs.push(o1.pts);
        let o2: { pts: P[]; flip: boolean } | null = null, L2 = 0, c = -1;
        for (const cc of near(b)) { L2 = len(xy(b), xy(cc)); o2 = lay(xy(b), xy(cc), L2, [b], o1.pts); if (o2) { c = cc; break; } }
        if (!o2) { occupied.delete(a); occupied.delete(b); arcs.pop(); continue; }
        handles.push({ slot: a }, { slot: b }, { slot: c });
        const ha = handles.length - 3;
        ropes.push(o1.flip ? { a: ha + 1, b: ha, color: 0, length: L1 } : { a: ha, b: ha + 1, color: 0, length: L1 });
        ropes.push(o2.flip ? { a: ha + 2, b: ha + 1, color: 0, length: L2 } : { a: ha + 1, b: ha + 2, color: 0, length: L2 });
        occupied.add(c); arcs.push(o2.pts);
        ok = true;
        break;
      }
      if (ok) break;
    }
    if (!ok) return fail('layout');
  }
  // handles that hold one rope of a single-rope group, plain ones (no rail, one cell)
  const plain = () => shuffle(handles.map((_, k) => k).filter((k) => ropes.filter((r) => r.a === k || r.b === k).length === 1 && !handles[k].rail && !handles[k].model && !handles[k].fixed && !handles[k].gear), rng);
  const ropeOf = (k: number) => ropes.findIndex((r) => r.a === k || r.b === k);
  // a gear: two plain handles of different ropes move together
  if (d.gears) {
    const pl = plain(), a = pl[0], b = pl.find((k) => ropeOf(k) !== ropeOf(a));
    if (a === undefined || b === undefined) return fail('gear');
    handles[a].gear = 1; handles[b].gear = 1;
  }
  // fixed handles (some only while the level is new to the player: dynamic fixed)
  const fixedRope = new Set<number>();
  let nf = 0;
  for (const k of plain()) {
    if (nf >= d.fixed + d.dynFixed) break;
    if (fixedRope.has(ropeOf(k))) continue;
    handles[k].fixed = true;
    if (nf < d.dynFixed) handles[k].dynamicFixed = 3;
    fixedRope.add(ropeOf(k)); nf++;
  }
  const data: BoardData = { rows, cols, pitchX: px, slots, handles, ropes };
  const b = new Board(data);
  b.canUntie = false;
  b.run(90);
  if (b.groups.some((g) => b.overlaps(g))) return fail('start overlaps');
  // 2. scramble
  const moves: { h: number; from: number; to: number }[] = [];
  const targetOk = (s: number) => !blocked.has(s) || rail.includes(s);
  for (let tries = 0; tries < d.scramble * 40; tries++) {
    const lone = new Set(b.groups.filter((g) => !b.overlaps(g)).map((g) => g.id));
    if (moves.length >= d.scramble && !lone.size) break;
    if (moves.length >= d.scramble * 6) break;
    let bring = lone.size > 0 && (moves.length >= d.scramble || rng() < 0.8);
    const cands: [number, number][] = [];
    for (let pass = 0; pass < 2 && !cands.length; pass++, bring = false) b.handles.forEach((h, k) => {
      if (h.fixed || h.gone || h.dormant || h.leader >= 0 || (moves.length && moves[moves.length - 1].h === k)) return;
      const hp = b.handlePos(k), at: P = [hp[0], hp[2]];
      const others = h.ropes.map((r) => { const rr = data.ropes[r], o2 = rr.a === k ? rr.b : rr.a; const q = b.handlePos(o2); return { c: [q[0], q[2]] as P, r: b.ropes[r].length }; });
      b.slots.forEach((s, si) => {
        if (si === h.slot || !targetOk(si) || !b.fits(k, si, true)) return;
        if (!others.every((oo) => Math.hypot(s.x - oo.c[0], s.z - oo.c[1]) < oo.r * 0.85)) return;
        if (bring && !lone.has(h.group) ? !crossesOthers(b, k, at, [s.x, s.z], lone) : !crossesOthers(b, k, at, [s.x, s.z])) return;
        cands.push([k, si]);
      });
    });
    if (!cands.length) return fail('no move');
    const [k, s] = cands[Math.floor(rng() * cands.length)];
    const was = b.handles[k].slot;
    if (carry(b, k, s)) moves.push({ h: k, from: was, to: s });
  }
  if (b.groups.some((g) => !b.overlaps(g))) return fail('not all tangled');
  b.run(180);
  if (b.groups.some((g) => !b.overlaps(g))) return fail('came loose');
  // the level as laid out now
  const level: BoardData = {
    rows, cols, pitchX: px, slots: slots.map((s) => ({ ...s })),
    handles: b.handles.map((h, k) => ({ ...handles[k], slot: h.slot })),
    ropes: ropes.map((r, q) => ({ ...r, pose: Array.from(b.world.ropes[b.ropes[q].w].x).map((v) => +v.toFixed(3)) })),
  };
  // 3. load it fresh and play it back in reverse
  const v = new Board(level);
  const order: number[][] = [];
  const take = () => { for (const e of v.lastEvents) if (e.k === 'disappear') order.push(e.ropes); v.lastEvents = []; };
  v.run(60); take();
  if (order.length) return fail('loose at start');
  const power = v.ropes.map((_, i) => i).sort((p, q) => v.touchCount(q) - v.touchCount(p)).slice(0, 3);
  const solution: [number, number][] = [], count = new Map<number, number>(), lastAt = new Map<number, number>();
  for (let m = moves.length - 1; m >= 0; m--) {
    const mv = moves[m];
    if (v.handles[mv.h].gone) continue;
    if (v.slots[mv.from].handle >= 0 && v.slots[mv.from].handle !== mv.h) return fail('reverse: slot taken');
    if (!carry(v, mv.h, mv.from) && !carry(v, mv.h, mv.from) && !carry(v, mv.h, mv.from)) return fail('reverse: carry failed');
    take();
    solution.push([mv.h, mv.from]);
    count.set(mv.h, (count.get(mv.h) ?? 0) + 1);
    lastAt.set(mv.h, solution.length - 1);
    v.run(30); take();
  }
  v.run(90); take();
  if (order.flat().length !== ropes.length) return fail(`reverse: ${ropes.length - order.flat().length} left`);
  // extras that leave the solution as it is
  const movable = shuffle([...count.entries()].filter(([k]) => !level.handles[k].fixed && !level.handles[k].gear && !level.handles[k].rail), rng);
  const conv = movable.filter(([, n]) => n <= 3).slice(0, d.converted);
  if (conv.length < d.converted) return fail('converted');
  for (const [k, n] of conv) Object.assign(level.handles[k], { fixed: true, converted: n });
  const rest = movable.filter(([k]) => !conv.some(([c]) => c === k));
  // time-to-fixed: a handle the solution is done with early (generous: 25 s + 10 s per move before)
  for (let t = 0; t < d.toFixed; t++) {
    const c = rest.find(([k]) => (lastAt.get(k) ?? 99) <= 2 && !level.handles[k].toFixedTime);
    if (!c) return fail('toFixed');
    level.handles[c[0]].toFixedTime = 25 + 10 * (lastAt.get(c[0]) ?? 0);
  }
  // toggling: a handle moved once or twice (it can always be waited for)
  for (let t = 0; t < d.toggles; t++) {
    const c = rest.find(([k, n]) => n <= 2 && !level.handles[k].toFixedTime && !level.handles[k].toggle);
    if (!c) return fail('toggle');
    Object.assign(level.handles[c[0]], { toggle: true, fixed: true });
  }
  // forbidden slots: empty at the start and never used by the solution
  const targets = new Set(solution.map((m) => m[1]));
  const freeSlots = shuffle(level.slots.map((_, s) => s).filter((s) => level.slots[s].type === ESlot.Normal && !level.slots[s].rail && !blocked.has(s) && !level.handles.some((h) => h.slot === s) && !targets.has(s)), rng);
  if (freeSlots.length < d.forbidden) return fail('forbidden');
  for (const s of freeSlots.slice(0, d.forbidden)) level.slots[s].type = ESlot.Forbidden;
  const hidden = level.ropes.map((_, r) => r).filter(() => rng() < d.hidden);
  return { level, solution, order, hidden, power };
}

/** Threes along the untangling order, a fresh colour each (a pair stays in one three). */
function trays(order: number[][], ropes: RopeData[], d: Design, rng: () => number): number[] | null {
  const ord = order.slice();
  for (let s = 0; s < ord.length; s++) {
    if (rng() >= d.mix) continue;
    const t = Math.min(ord.length - 1, s + 2 + Math.floor(rng() * 3));
    if (ord[t].length === ord[s].length) [ord[s], ord[t]] = [ord[t], ord[s]];
  }
  const threes: number[][] = [];
  let cur: number[] = [];
  while (ord.length) {
    const k = ord.findIndex((g) => g.length <= 3 - cur.length);
    if (k < 0 || k > 3) return fail('trays');
    cur.push(...ord.splice(k, 1)[0]);
    if (cur.length === 3) { threes.push(cur); cur = []; }
  }
  if (cur.length) return fail('trays');
  const cols3 = shuffle([...Array(d.colors).keys()], rng), queue: number[] = [];
  threes.forEach((t, n) => {
    let c = n < d.colors ? cols3[n] : Math.floor(rng() * d.colors);
    if (n >= d.colors && c === queue[n - 1]) c = (c + 1) % d.colors;
    queue.push(c);
    for (const r of t) ropes[r].color = c;
  });
  return queue;
}

/** Play a finished level fresh by its solution: does it clear? (trapdoors and long maps included) */
function verify(level: BoardData, solution: [number, number][]): number[][] | null {
  const v = new Board(level);
  const order: number[][] = [];
  const take = () => { for (const e of v.lastEvents) if (e.k === 'disappear') order.push(e.ropes); v.lastEvents = []; };
  v.run(60); take();
  for (const [k, s] of solution) {
    // wait for a trapdoor to open / the window to come round
    for (let q = 0; q < 180 && (v.handles[k].dormant || v.pickBlock(k) === 'window'); q++) v.run(1);
    if (v.handles[k].gone) continue;
    if (!carry(v, k, s) && !carry(v, k, s) && !carry(v, k, s)) return fail('verify: carry failed');
    v.run(30); take();
  }
  v.run(150); take();
  return v.isCleared() ? order : fail('verify: not cleared');
}

function make(i: number, attempt: number): LevelData | null {
  const d = DESIGN[i];
  const rng = rngOf(i * 7919 + attempt * 104729 + 17);
  if (d.longMap) {
    // two boards stacked: the top one (rows of the window) first, the one below comes into view as it clears
    const half = Math.max(3, Math.round(d.ropes / 6) * 3);
    const top: Design = { ...d, ropes: half, longMap: false, trap: false, pairs: 0 }, bot: Design = { ...d, ropes: d.ropes - half, longMap: false, trap: false, pairs: 0 };
    const px = pitchX(d.cols, d.rows);
    const A = build(top, rng, { px }), B = A && build(bot, rng, { px });
    if (!A || !B) return null;
    const rows = d.rows * 2, shiftA = ((d.rows - 1) / 2 - (rows - 1) / 2) * CFG.STEP, shiftB = (d.rows + (d.rows - 1) / 2 - (rows - 1) / 2) * CFG.STEP;
    const moveZ = (pose: number[] | undefined, dz: number) => pose?.map((x, q) => (q % 3 === 2 ? +(x + dz).toFixed(3) : x));
    const nA = A.level.handles.length, rA = A.level.ropes.length, sA = A.level.slots.length;
    const level: BoardData = {
      rows, cols: d.cols, pitchX: px, longMapRow: d.rows,
      slots: [...A.level.slots, ...B.level.slots.map((s) => ({ ...s, row: s.row + d.rows }))],
      handles: [...A.level.handles, ...B.level.handles.map((h) => ({ ...h, slot: h.slot + sA, ...(h.gear ? { gear: 2 } : {}) }))],
      ropes: [...A.level.ropes.map((r) => ({ ...r, pose: moveZ(r.pose, shiftA) })), ...B.level.ropes.map((r) => ({ ...r, a: r.a + nA, b: r.b + nA, pose: moveZ(r.pose, shiftB) }))],
    };
    const solution: [number, number][] = [...A.solution, ...B.solution.map(([k, s]) => [k + nA, s + sA] as [number, number])];
    const order = verify(level, solution);
    if (!order) return null;
    const queue = trays(order, level.ropes, d, rng);
    if (!queue) return null;
    return { board: level, hidden: [...A.hidden, ...B.hidden.map((r) => r + rA)], queue, solution, power: A.power };
  }
  if (d.trap) {
    // a 4 × 3 patch kept free for the trapdoor; a little 3-rope level made for it
    const tw = 4, th = 3, tr = 1 + Math.floor(rng() * (d.rows - th - 1)), tc = Math.floor(rng() * (d.cols - tw + 1));
    const px = pitchX(d.cols, d.rows);
    const main = build({ ...d, ropes: d.ropes - 3, colors: Math.max(2, d.colors - 1), trap: false, rail: 0, umbrellas: 0 }, rng, { px, reserve: (r, c) => r >= tr && r < tr + th && c >= tc && c < tc + tw });
    if (!main) return null;
    const none: Partial<Design> = { pairs: 0, fixed: 0, converted: 0, forbidden: 0, holes: 0, pillars: 0, rail: 0, umbrellas: 0, toFixed: 0, gears: 0, multi: 0, toggles: 0, dynFixed: 0, hidden: 0 };
    const sub = build({ ...d, ...none, cols: tw, rows: th, ropes: 3, scramble: 3, trap: false }, rng, { px });
    if (!sub) return null;
    const trap: TrapData = { row: tr, col: tc, w: tw, h: th, handles: sub.level.handles, ropes: sub.level.ropes };
    const level: BoardData = { ...main.level, traps: [trap] };
    const n0 = main.level.handles.length;
    const solution: [number, number][] = [...main.solution, ...sub.solution.map(([k, s]) => [k + n0, (tr + Math.floor(s / tw)) * d.cols + tc + (s % tw)] as [number, number])];
    const order = verify(level, solution);
    if (!order) return null;
    const queue = trays(order, [...level.ropes, ...trap.ropes], d, rng);
    if (!queue) return null;
    return { board: level, hidden: main.hidden, queue, solution, power: main.power };
  }
  const B = build(d, rng);
  if (!B) return null;
  const queue = trays(B.order, B.level.ropes, d, rng);
  if (!queue) return null;
  return { board: B.level, hidden: B.hidden, queue, solution: B.solution, power: B.power };
}

const out: LevelData[] = LEVEL_DATA.slice();
if (merge) {
  for (const f of merge) for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^JSON (.*)$/);
    if (m) { const o = JSON.parse(m[1]); out[o.i] = o.lv; }
  }
} else for (let i = from - 1; i < to; i++) {
  // already made (an earlier run into the same file): skip it
  let done = false;
  try { done = readFileSync(outFile ?? '', 'utf8').split('\n').some((l) => l.startsWith(`JSON {"i":${i},`)); } catch { /* no file yet */ }
  if (done) continue;
  const t0 = Date.now();
  let lv: LevelData | null = null, attempt = 0;
  // --from-attempt=N: other seeds (a level that failed its first 80 tries)
  attempt = Number(argv.find((x) => x.startsWith('--from-attempt='))?.slice(15) ?? 0);
  const last = attempt + (argv.includes('--why') ? 12 : 80);
  for (; attempt < last && !lv; attempt++) lv = make(i, attempt);
  if (!lv) { console.log(`L${i + 1}: FAILED`, JSON.stringify(WHY)); continue; }
  out[i] = lv;
  const b = lv.board;
  console.log(`L${i + 1} ${b.cols}x${b.rows} ropes ${b.ropes.length + (b.traps?.[0]?.ropes.length ?? 0)} handles ${b.handles.length} solution ${lv.solution.length} attempt ${attempt} ${Date.now() - t0}ms`, argv.includes('--why') ? JSON.stringify(WHY) : '');
  if (outFile) writeFileSync(outFile, 'JSON ' + JSON.stringify({ i, lv }) + '\n', { flag: 'a' });
}
if (!outFile) {
  // a level not made yet borrows the one before it (so the game always loads)
  for (let i = 0; i < LEVEL_COUNT; i++) out[i] ??= out[i - 1] ?? out.find(Boolean)!;
  const body = out.map((l) => '  ' + JSON.stringify(l)).join(',\n');
  writeFileSync(new URL('../src/levelData.ts', import.meta.url), `// Written by scripts/gen-levels.ts\nimport type { BoardData } from './board.ts';\nexport interface LevelData { board: BoardData; hidden: number[]; queue: number[]; solution: [number, number][]; power?: number[] }\nexport const LEVEL_DATA: LevelData[] = [\n${body}\n];\n`);
  console.log('wrote src/levelData.ts');
}
