// The acceptance checklist of the Tangled Rope spec (§15), run on board.ts in node.
//   node scripts/accept.ts
import { Board, ESlot, type BoardData } from '../src/board.ts';
import { CFG } from '../src/config.ts';

type P = [number, number];
let fails = 0;
const ok = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++; };

const rows = 6, cols = 5;
const grid = () => { const s = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) s.push({ row: r, col: c, type: ESlot.Normal as 0 | 1 | 2 }); return s; };
const S = (r: number, c: number) => r * cols + c;
/** Two groups, apart: a short rope at the top, one at the bottom. */
function apart(over: Partial<BoardData> = {}): Board {
  const d: BoardData = { rows, cols, pitchX: 1.6, slots: grid(), handles: [{ slot: S(1, 0) }, { slot: S(1, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }],
    ropes: [{ a: 0, b: 1, color: 0, length: 3.6 }, { a: 2, b: 3, color: 1, length: 3.6 }], ...over };
  const b = new Board(d);
  b.canUntie = false;
  b.run(60);
  return b;
}
/** Carry handle h towards board point t (finger kept 0.7 below), dropping it there. Returns the events. */
function carry(b: Board, h: number, t: P, release = true) {
  const p = b.handlePos(h), f0: P = [p[0], p[2] + CFG.distanceFromFinger], f1: P = [t[0], t[1] + CFG.distanceFromFinger];
  const ev = [];
  b.setFinger(f0); b.press(h); ev.push(...b.run(2));
  for (let q = 1; q <= 30; q++) { b.setFinger([f0[0] + ((f1[0] - f0[0]) * q) / 30, f0[1] + ((f1[1] - f0[1]) * q) / 30]); ev.push(...b.run(1)); }
  ev.push(...b.run(6));
  if (release) { b.up(); for (let q = 0; q < 200 && b.handles[h].state !== 'stable'; q++) ev.push(...b.run(1)); ev.push(...b.run(30)); }
  return ev;
}
const at = (b: Board, s: number): P => [b.slots[s].x, b.slots[s].z];

// --- basic handling
{
  const b = apart();
  b.setFinger([b.handlePos(0)[0], b.handlePos(0)[2] + 0.7]); b.press(0); b.run(2);
  b.press(2); b.run(2);
  ok('only one handle at a time', b.handles[0].state === 'operate' && b.handles[2].state === 'stable');
  b.up(); b.run(60);
}
{
  const b = apart({ handles: [{ slot: S(1, 0), fixed: true }, { slot: S(1, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }] });
  const ev = carry(b, 0, at(b, S(0, 0)));
  ok('a fixed handle cannot be picked', b.handles[0].slot === S(1, 0) && ev.some((e) => e.k === 'pickFail'));
}
{
  const b = apart({ handles: [{ slot: S(1, 0), fixed: true, converted: 2 }, { slot: S(1, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }] });
  carry(b, 0, at(b, S(0, 0))); carry(b, 0, at(b, S(0, 1)));
  const moved = b.handles[0].slot === S(0, 1);
  const ev = carry(b, 0, at(b, S(1, 1)));
  ok('a converted handle moves exactly N times, then locks', moved && b.handles[0].slot === S(0, 1) && b.handles[0].converted === null && ev.some((e) => e.k === 'pickFail'));
}
{
  const b = apart();
  carry(b, 0, [at(b, S(0, 1))[0] + 0.5, at(b, S(0, 1))[1]]);
  ok('dropped < 1.0 from an empty slot: goes in', b.handles[0].slot === S(0, 1));
  const b2 = apart();
  carry(b2, 0, [(at(b2, S(2, 0))[0] + at(b2, S(2, 1))[0]) / 2, (at(b2, S(2, 0))[1] + at(b2, S(3, 0))[1]) / 2]);
  ok('dropped in a gap: back to its slot', b2.handles[0].slot === S(1, 0));
  const b3 = apart();
  const m0 = b3.moves;
  carry(b3, 0, at(b3, S(1, 0)));
  ok('pick and drop in place still counts a move', b3.moves === m0 + 1 && b3.started);
  const b4 = apart({ slots: grid().map((s, i) => (i === S(0, 1) ? { ...s, type: ESlot.Forbidden } : s)) });
  carry(b4, 0, at(b4, S(0, 1)));
  ok('dropped on a forbidden slot: back to its slot', b4.handles[0].slot === S(1, 0));
  const b5 = apart();
  carry(b5, 0, at(b5, S(1, 2)));
  ok('dropped on an occupied slot: back to its slot', b5.handles[0].slot === S(1, 0));
}
// --- rope reach
{
  const b = apart();
  carry(b, 0, [-6, -6], false);
  const p = b.handlePos(0), o = b.handlePos(1), d = Math.hypot(p[0] - o[0], p[2] - o[2]);
  ok('a handle cannot be taken further than Length from the other end', d <= b.ropes[0].length + 0.02, `${d.toFixed(2)} ≤ ${b.ropes[0].length}`);
  b.up(); b.run(100);
}
{
  // a middle handle holding two ropes is kept in the meeting of two circles
  const d: BoardData = { rows, cols, pitchX: 1.6, slots: grid(), handles: [{ slot: S(1, 0) }, { slot: S(1, 2) }, { slot: S(1, 4) }],
    ropes: [{ a: 0, b: 1, color: 0, length: 3.4 }, { a: 1, b: 2, color: 0, length: 3.4 }] };
  const b = new Board(d); b.canUntie = false; b.run(60);
  carry(b, 1, [0, 5], false);
  const p = b.handlePos(1), A = b.handlePos(0), C = b.handlePos(2);
  ok('a two-rope handle stays inside both circles', Math.hypot(p[0] - A[0], p[2] - A[2]) <= 3.42 && Math.hypot(p[0] - C[0], p[2] - C[2]) <= 3.42);
  b.up(); b.run(60);
}
// --- disappearing
{
  const b = apart();
  b.canUntie = true;
  b.setFinger([b.handlePos(2)[0], b.handlePos(2)[2] + 0.7]); b.press(2);
  const held = b.run(40);
  ok('holding any handle keeps every group from coming off', !held.some((e) => e.k === 'disappear'));
  b.up();
  const ev = b.run(60);
  const t = ev.findIndex((e) => e.k === 'disappear');
  ok('clear groups come off once nothing is held (after 0.3 s)', t >= 0 && b.groups.every((g) => g.state !== 'stable'));
}
{
  // the bottom rope carried over the top one: they overlap, nothing comes off; carried back: both come off
  const b = apart();
  carry(b, 2, at(b, S(0, 1)));
  b.canUntie = true;
  const ev = b.run(60);
  ok('groups that overlap never come off', !ev.some((e) => e.k === 'disappear') && b.overlaps(b.groups[0]));
  const ev2 = carry(b, 2, at(b, S(4, 0)));
  ev2.push(...b.run(60));
  ok('several groups can come off one after another', ev2.filter((e) => e.k === 'disappear').length === 2 && ev2.some((e) => e.k === 'cleared'));
}
// --- boosters
{
  const d: BoardData = { rows, cols, pitchX: 1.6, slots: grid(), handles: [{ slot: S(1, 0) }, { slot: S(1, 2) }, { slot: S(1, 4) }],
    ropes: [{ a: 0, b: 1, color: 0, length: 3.4 }, { a: 1, b: 2, color: 0, length: 3.4 }] };
  const b = new Board(d); b.canUntie = false; b.run(60);
  const n0 = b.live().length;
  ok('scissors refuses a cut right by a handle', !b.cut(0, 1, 0));
  b.cut(0, 10, 0.1); b.run(30);
  ok('scissors: the group falls in two; a handle left with no rope goes', n0 === 1 && b.live().length === 1 && b.handles[0].gone && !b.handles[1].gone);
}
{
  const b = apart({ handles: [{ slot: S(1, 0), fixed: true }, { slot: S(1, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }], slots: grid().map((s, i) => (i === S(2, 4) ? { ...s, type: ESlot.Forbidden } : s)) });
  ok('hammer: nothing to hit on a plain slot', b.hammerTarget(at(b, S(3, 3))) === null);
  const t1 = b.hammerTarget(at(b, S(1, 0)));
  if (t1) b.hammer(t1);
  const t2 = b.hammerTarget(at(b, S(2, 4)));
  if (t2) b.hammer(t2);
  ok('hammer frees a fixed handle and opens a forbidden slot', !b.handles[0].fixed && b.slots[S(2, 4)].type === 'normal');
}
{
  const b = apart();
  const n0 = b.slots.length;
  const made = b.previewExpansion();
  ok('expansion adds one ring round the board', made.length === 2 * (rows + cols) && b.slots.length === n0 + made.length);
  b.cancelExpansion();
  ok('cancelling the preview puts the board back', b.slots.length === n0);
}
// --- §11 elements
{
  // dynamic fixed: nailed only while the level has been entered fewer than N times
  const d = (n: number) => new Board({ rows, cols, pitchX: 1.6, slots: grid(), handles: [{ slot: S(1, 0), fixed: true, dynamicFixed: 3 }, { slot: S(1, 2) }], ropes: [{ a: 0, b: 1, color: 0, length: 3.6 }] }, n);
  ok('dynamic fixed: nailed on the first tries, free from the Nth', d(1).handles[0].fixed && d(2).handles[0].fixed && !d(3).handles[0].fixed);
}
{
  // a rail along row 2: its handle slides only along it; others can't stand on it
  const sl = grid().map((s) => (s.row === 2 ? { ...s, rail: 1 } : s));
  const b = apart({ slots: sl, handles: [{ slot: S(2, 0), rail: 1 }, { slot: S(0, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }] });
  carry(b, 0, at(b, S(0, 1)));
  ok('rail: a rail handle stays on its rail', b.slots[b.handles[0].slot].row === 2 && b.handles[0].slot !== S(2, 0), `slot ${b.handles[0].slot}`);
  carry(b, 2, at(b, S(2, 1)));
  ok('rail: an ordinary handle can\u2019t stand on a rail', b.handles[2].slot === S(4, 0), `slot ${b.handles[2].slot}`);
  const q = b.handlePos(0), t = b.hammerTarget([q[0], q[2]]);
  if (t) b.hammer(t);
  ok('rail: the hammer breaks the whole rail', b.handles[0].rail === null && b.slots.every((o) => o.rail === null));
}
{
  // a pillar between two slots: the rope can't pass through it
  const sl = grid().map((s, i) => (i === S(2, 1) ? { ...s, pillar: 4 } : s));
  const b = apart({ slots: sl });
  const pl = b.world.pillars[0];
  carry(b, 0, at(b, S(3, 0)));
  const r = b.world.ropes[0];
  let inside = false;
  for (let q = 0; q < r.n; q++) if (Math.hypot(r.x[q * 3] - pl.x, r.x[q * 3 + 2] - pl.z) < 0.25) inside = true;
  ok('pillar: no rope bead passes through a pillar', !inside);
}
{
  // an umbrella over (2, 2): while open its 3 × 3 is off limits
  const sl = grid().map((s, i) => (i === S(2, 2) ? { ...s, umbrella: { open: 2, close: 2, init: true } } : s));
  const b = apart({ slots: sl, handles: [{ slot: S(1, 0) }, { slot: S(1, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }] });
  ok('umbrella: an open umbrella covers the slots round it', b.slots[S(1, 2)].covered && b.slots[S(3, 3)].covered && !b.slots[S(4, 0)].covered);
  const ev = carry(b, 1, at(b, S(0, 2)));
  ok('umbrella: a handle under it can\u2019t be picked', b.handles[1].slot === S(1, 2) && ev.some((e) => e.k === 'pickFail'));
  carry(b, 0, at(b, S(0, 0)));   // start the clock of play
  b.run(Math.ceil(2.5 / CFG.fixedDeltaTime));
  ok('umbrella: it closes after its open time', !b.slots[S(2, 2)].umbrella!.isOpen && !b.slots[S(1, 2)].covered);
}
{
  // two geared handles move by the same rows / columns
  const b = apart({ handles: [{ slot: S(1, 0), gear: 1 }, { slot: S(1, 2) }, { slot: S(4, 0), gear: 1 }, { slot: S(4, 2) }] });
  carry(b, 0, at(b, S(0, 1)));
  ok('gear: the gear moves together', b.handles[0].slot === S(0, 1) && b.handles[2].slot === S(3, 1), `${b.handles[0].slot} ${b.handles[2].slot}`);
}
{
  // time to fixed: nailed down after N s of play
  const b = apart({ handles: [{ slot: S(1, 0), toFixedTime: 2 }, { slot: S(1, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }] });
  carry(b, 2, at(b, S(5, 0)));
  b.run(Math.ceil(2.2 / CFG.fixedDeltaTime));
  ok('time to fixed: nailed down after its time', b.handles[0].fixed);
  // toggling: fixed, free, fixed…
  const b2 = apart({ handles: [{ slot: S(1, 0), toggle: true, fixed: true }, { slot: S(1, 2) }, { slot: S(4, 0) }, { slot: S(4, 2) }] });
  carry(b2, 2, at(b2, S(5, 0)));
  const f0 = b2.handles[0].fixed;
  b2.run(Math.ceil(4.2 / CFG.fixedDeltaTime));
  ok('toggle: it changes between fixed and free', f0 !== b2.handles[0].fixed);
}
{
  // a two-slot handle needs both slots free
  const b = apart({ handles: [{ slot: S(1, 0), model: 2 }, { slot: S(1, 3) }, { slot: S(2, 2) }, { slot: S(4, 2) }], ropes: [{ a: 0, b: 1, color: 0, length: 3.6, ca: 1 }, { a: 2, b: 3, color: 1, length: 3.6 }] });
  ok('multi-slot: it covers both its slots', b.slots[S(1, 0)].handle === 0 && b.slots[S(1, 1)].handle === 0);
  carry(b, 0, at(b, S(2, 1)));
  ok('multi-slot: it can\u2019t go where one of its cells is taken', b.handles[0].slot === S(1, 0), `slot ${b.handles[0].slot}`);
  carry(b, 0, at(b, S(0, 0)));
  ok('multi-slot: it moves into two free slots', b.handles[0].slot === S(0, 0) && b.slots[S(0, 1)].handle === 0 && b.slots[S(1, 1)].handle !== 0);
}
{
  // long map: only the window can be played; it slides once its top row is empty
  const b = new Board({ rows, cols, pitchX: 1.6, slots: grid(), longMapRow: 4, handles: [{ slot: S(0, 0) }, { slot: S(0, 2) }, { slot: S(5, 0) }, { slot: S(5, 2) }], ropes: [{ a: 0, b: 1, color: 0, length: 3.6 }, { a: 2, b: 3, color: 1, length: 3.6 }] });
  b.canUntie = false; b.run(30);
  const ev = carry(b, 2, at(b, S(4, 0)));
  ok('long map: a handle outside the window can\u2019t be picked', b.handles[2].slot === S(5, 0) && ev.some((e) => e.k === 'pickFail'));
  carry(b, 0, at(b, S(1, 0))); carry(b, 1, at(b, S(1, 2)));
  b.run(40);
  ok('long map: the window slides down when its top row is empty', b.winMin >= 1);
}
{
  // a trapdoor over rows 3–4, cols 3–4: it opens on its little level once nothing lies on it
  const trap = { row: 3, col: 3, w: 2, h: 2, handles: [{ slot: 0 }, { slot: 3 }], ropes: [{ a: 0, b: 1, color: 2, length: 2.6 }] };
  const b = new Board({ rows, cols, pitchX: 1.6, slots: grid(), traps: [trap], handles: [{ slot: S(0, 0) }, { slot: S(0, 2) }], ropes: [{ a: 0, b: 1, color: 0, length: 3.6 }] });
  b.canUntie = false;
  const ev = b.run(60);
  ok('trapdoor: it opens once clear, its ropes join the board', ev.some((e) => e.k === 'trapOpen') && !b.ropes[1].dormant && b.groups.length === 2);
}
{
  // stretch (§7): a rope over its snap rate while a handle is carried forces it back; a placement
  // that leaves a rope longer than 1.35× along its beads is refused
  const b = apart();
  const p = b.handlePos(0);
  b.setFinger([p[0], p[2] + 0.7]); b.press(0); b.run(80);   // past the 1 s grace
  b.ropes[0].length = 0.5;                                  // its path is now far over the snap rate
  const ev = b.run(3); b.up(); ev.push(...b.run(60));
  ok('stretch: an over-stretched rope makes the carried handle let go and fly back', ev.some((e) => e.k === 'stress') && ev.some((e) => e.k === 'snap' && (e as { why: string }).why === 'stress') && b.handles[0].slot === S(1, 0));
  const b2 = apart();
  const p2 = b2.handlePos(0);
  b2.setFinger([p2[0], p2[2] + 0.7]); b2.press(0); b2.run(3);
  const t = at(b2, S(0, 0));
  for (let q = 1; q <= 20; q++) { b2.setFinger([p2[0] + (t[0] - p2[0]) * q / 20, p2[2] + 0.7 + (t[1] - p2[2]) * q / 20]); b2.run(1); }
  b2.world.ropes[0].rest = 1.0;                             // the rope is now far longer along its beads than it may be
  b2.up();
  const ev2: { k: string; why?: string }[] = [];
  for (let q = 0; q < 200 && b2.handles[0].state !== 'stable'; q++) ev2.push(...b2.run(1));
  ok('stretch: a placement that over-stretches a rope bounces back', b2.handles[0].slot === S(1, 0) && ev2.some((e) => e.k === 'snap' && e.why === 'stretched'));
}
{
  // a two-rope handle only lets go for its own ropes
  const d: BoardData = { rows, cols, pitchX: 1.6, slots: grid(), handles: [{ slot: S(1, 0) }, { slot: S(1, 2) }, { slot: S(1, 4) }, { slot: S(4, 0) }, { slot: S(4, 2) }],
    ropes: [{ a: 0, b: 1, color: 0, length: 3.4 }, { a: 1, b: 2, color: 0, length: 3.4 }, { a: 3, b: 4, color: 1, length: 3.6 }] };
  const b = new Board(d); b.canUntie = false; b.run(60);
  const p = b.handlePos(1);
  b.setFinger([p[0], p[2] + 0.7]); b.press(1); b.run(80);
  b.ropes[2].length = 0.5;                                  // another group's rope over its rate
  const ev = b.run(5);
  ok('stretch: a two-rope handle ignores other ropes\u2019 stress', !ev.some((e) => e.k === 'stress') && b.handles[1].state === 'operate');
  b.up(); b.run(60);
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
