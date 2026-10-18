// The core gameplay of Tangled Rope (spec §1–§11), on top of the rope physics (rope.ts).
// No three.js and no UI: the game (game.ts) feeds the finger in and draws what is here;
// scripts/gen-levels.ts plays the same rules to make and check the levels.
//
//   slots    — the grid: a slot may be missing (a hole) or forbidden, sit on a slide rail,
//              carry an umbrella, have a pillar at a corner, or be under a trapdoor.
//   handles  — the pins the player carries; a handle holds 1–2 rope ends and may cover
//              1–4 slots (multi-slot models). Fixed / converted / dynamic-fixed / toggling /
//              time-to-fixed handles, handles on a rail, handles geared together (§11).
//   groups   — handles and ropes joined together (one colour): what comes off the board.
//
// Three state machines (spec §6), stepped at a fixed 60 Hz in this order (spec §15):
// input → handle FSM → rope physics → contacts → stretch → group FSM → slot FSM.
//
// This game keeps its colour trays instead of the clock (the player's choice): nothing here
// keeps time against the player. `elapsed` (play time since the first pick) drives the
// umbrellas, the toggling handles and the time-to-fixed handles.

import { CFG } from './config.ts';
import { END_Y, RopeWorld, type Snapshot } from './rope.ts';

type P = [number, number];

// ------------------------------------------------------------ level data (spec §2)

/** Slot kinds in level data: 0 None (a hole in the grid), 1 Normal, 2 Forbidden. */
export const ESlot = { None: 0, Normal: 1, Forbidden: 2 } as const;
export type ESlot = 0 | 1 | 2;
/** pillar: 1–4 = a post at the top-left / top-right / bottom-left / bottom-right corner. umbrella: open / close seconds. */
export interface SlotData { row: number; col: number; type: ESlot; rail?: number; pillar?: number; umbrella?: { open: number; close: number; init: boolean } }
/**
 * model: EHandleModel 1–10 (the cells it covers, MODEL). converted: moves left; dynamicFixed: fixed only
 * while the level has been entered fewer than N times; toggle: fixed ↔ free every TOGGLE s; gear: moves with
 * the other handles of its gear; toFixedTime: becomes fixed after N s of play; rail: slides along rail k.
 */
export interface HandleData { slot: number; fixed?: boolean; converted?: number; dynamicFixed?: number; toggle?: boolean; gear?: number; toFixedTime?: number; rail?: number; model?: number }
/** a / b: handles at the two ends (ca / cb: which of their cells); length: Length (the rope is this + extraRopeLengthForGenerate); pose: beads x, y, z. */
export interface RopeData { a: number; b: number; color: number; length: number; pose?: number[]; ca?: number; cb?: number }
/** A trapdoor: w × h slots from (row, col) closed by a door; once nothing lies on it, it opens on its own little level. */
export interface TrapData { row: number; col: number; w: number; h: number; handles: HandleData[]; ropes: RopeData[] }
export interface BoardData { rows: number; cols: number; pitchX: number; slots: SlotData[]; handles: HandleData[]; ropes: RopeData[]; longMapRow?: number; traps?: TrapData[] }

/** EHandleModel → the cells, as [row, col] from the handle's own slot (spec §11, MultiSlot). */
export const MODEL: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[0, 0], [0, 1]], 3: [[0, 0], [1, 0]],
  4: [[0, 0], [0, 1], [0, 2]], 5: [[0, 0], [1, 0], [2, 0]],
  6: [[0, 0], [1, 0], [1, 1]], 7: [[0, 0], [0, 1], [1, 0]], 8: [[0, 0], [0, 1], [1, 1]], 9: [[0, 1], [1, 0], [1, 1]],
  10: [[0, 0], [0, 1], [1, 0], [1, 1]],
};
/** ToggleFixed: seconds fixed, then seconds free, and so on (spec: cycle not readable — guessed). */
export const TOGGLE = 4;
/** An open umbrella covers the slots this far round it (spec: openBoxColliderSize — guessed: 3 × 3). */
export const UMBRELLA_REACH = 1;
/** A carried handle keeps this far from a pillar (pillarHandleMisDistance). */
const PILLAR_KEEP = 0.57;

// ------------------------------------------------------------ runtime

export type SlotState = 'normal' | 'active' | 'occupied';
export class Slot {
  state: SlotState = 'normal';
  handle = -1;   // the handle standing here (kept while it is carried, so it can always come back)
  row: number; col: number; x: number; z: number;
  type: 'normal' | 'forbidden' | 'preview';
  exists: boolean;   // false: a hole in the grid
  rail: number | null = null;
  pillar = 0;
  pillarIndex = -1;  // in world.pillars
  umbrella: { open: number; close: number; init: boolean; gone: boolean; isOpen: boolean } | null = null;
  covered = false;   // under an open umbrella
  trap = -1;         // under trapdoor t (closed: nothing goes here)
  constructor(row: number, col: number, x: number, z: number, type: 'normal' | 'forbidden' | 'preview', exists = true) {
    this.row = row; this.col = col; this.x = x; this.z = z; this.type = type; this.exists = exists;
  }
}

export type HandleState = 'stable' | 'operate' | 'operate2stable' | 'disappear';
export class HandleS {
  state: HandleState = 'stable';
  ropes: number[] = [];
  group = -1;
  hold = false;
  /** Fixed: can't be picked (unless converted moves are left). */
  fixed: boolean;
  converted: number | null;
  toggle: boolean;
  gear: number;
  toFixedTime: number | null;
  rail: number | null;
  model: number;
  /** The cells it covers ([row, col] from its slot). */
  cells: [number, number][];
  slot: number;            // LastSlot (its first cell)
  toSlot = -1;
  snap = false;
  reachMax = false;
  colliderOffUntil = 0;
  stopStressUntil = 0;
  offset: P = [0, 0];
  circles: { c: P; r: number }[] = [];
  center: P = [0, 0];
  /** Carried along by geared handle `leader` (-1: none), this far from it. */
  leader = -1;
  follow: P = [0, 0];
  /** Shown scale (picked: grows to operateScale). */
  scale = 1;
  gone = false;
  /** Waiting under a closed trapdoor. */
  dormant = false;
  constructor(d: HandleData, enterCount: number) {
    this.slot = d.slot;
    this.fixed = !!d.fixed && (d.dynamicFixed ? enterCount < d.dynamicFixed : true);
    this.converted = this.fixed && d.converted ? d.converted : null;
    this.toggle = !!d.toggle;
    this.gear = d.gear ?? 0;
    this.toFixedTime = d.toFixedTime ?? null;
    this.rail = d.rail ?? null;
    this.model = d.model ?? 1;
    this.cells = MODEL[this.model] ?? MODEL[1];
  }
}

export type GroupState = 'init' | 'stable' | 'operate' | 'disappear' | 'gone';
export class Group {
  state: GroupState = 'init';
  lastBusyTime = 0;
  lastBusyFrame = 0;
  cut = false;
  /** Disappearing: time in, where the handles gather. */
  t = 0;
  center: [number, number, number] = [0, 0, 0];
  from: [number, number, number][] = [];
  id: number; ropes: number[]; handles: number[]; color: number;
  constructor(id: number, ropes: number[], handles: number[], color: number) { this.id = id; this.ropes = ropes; this.handles = handles; this.color = color; }
}

export interface RopeMeta { color: number; length: number; group: number; gone: boolean; /** world rope index (-1: not on the board yet) */ w: number; overAtReach: boolean; dormant: boolean }
export interface TrapRun { d: TrapData; state: 'closed' | 'opening' | 'open'; t: number; slots: number[]; handles: number[]; ropes: number[] }

export type HammerTarget = { what: 'handle' | 'slot' | 'rail' | 'pillar' | 'umbrella'; i: number };
export type BoardEvent =
  | { k: 'pick'; h: number }
  | { k: 'pickFail'; h: number; why: string }
  | { k: 'enterSlot'; slot: number }
  | { k: 'place'; h: number; slot: number }
  | { k: 'snap'; h: number; why: 'noSlot' | 'stretched' | 'stress' }
  | { k: 'stress'; rope: number }
  | { k: 'disappear'; group: number; ropes: number[]; center: P }
  | { k: 'gone'; group: number }
  | { k: 'cleared' }
  | { k: 'cut'; rope: number; at: P }
  | { k: 'handleGone'; h: number }
  | { k: 'hammer'; at: P; what: HammerTarget['what']; i: number }
  | { k: 'nowFixed'; h: number }
  | { k: 'toggle'; h: number; fixed: boolean }
  | { k: 'umbrella'; slot: number; open: boolean }
  | { k: 'window'; min: number }
  | { k: 'trapOpening'; trap: number }
  | { k: 'trapOpen'; trap: number };

/** Debug switches (level making prints). */
export const DEBUG = { stress: false };
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class Board {
  world!: RopeWorld;
  slots: Slot[] = [];
  handles: HandleS[] = [];
  groups: Group[] = [];
  ropes: RopeMeta[] = [];
  /** The ropes as data (level ropes, then each trapdoor's), with their handles. */
  rd: RopeData[] = [];
  /** For every rope of the physics, the level rope it is (cut halves: the rope they came from). */
  owner: number[] = [];
  traps: TrapRun[] = [];
  /** Statics of the spec (§3.1). */
  active = -1;            // ActiveHandle
  anyHold = false;        // AnyHandleHold
  waitForResult = false;  // WaitForResult
  canUntie = true;        // CanUntie (off while a popup / tutorial is up)
  stopTransition = false; // StopStateTransition
  activeSlot = -1;
  tool: 'normal' | 'scissors' | 'hammer' = 'normal';
  time = 0;
  frame = 0;
  moves = 0;              // TotalMoves
  started = false;        // GameStart has happened
  /** Play time since the first pick (drives umbrellas, toggling and time-to-fixed handles). */
  elapsed = 0;
  /** LongMap: the rows that can be seen and played (spec §11): winMin .. winMin + winRows - 1. */
  winMin = 0;
  winRows: number;
  /** For each rope, 0..1 how far into the warning colour it is (-1 = plain). */
  warn: number[] = [];
  private over = new Set<number>();  // OverLengthRopes
  private acc = 0;
  private finger: P | null = null;
  private events: BoardEvent[] = [];
  private cuts: { rope: number; bead: number; t: number }[] = [];
  private shrink: { w: number; t: number; from: number }[] = [];
  private enteredOnce = false;
  private seed = 1;
  private winCheckAt = -1;
  private at = new Map<string, number>();
  readonly pitchX: number;
  readonly rows: number;
  readonly cols: number;
  readonly data: BoardData;

  /** enterCount: how many times the player has started this level (DynamicFixed). */
  constructor(data: BoardData, enterCount = 1) {
    this.data = data;
    this.rows = data.rows; this.cols = data.cols; this.pitchX = data.pitchX;
    this.winRows = data.longMapRow && data.longMapRow > 0 ? data.longMapRow : data.rows;
    // slots (§3.3): holes are left out but keep their grid place
    for (const s of data.slots) {
      const [x, z] = this.slotXY(s.row, s.col);
      const o = new Slot(s.row, s.col, x, z, s.type === ESlot.Normal ? 'normal' : 'forbidden', s.type !== ESlot.None);
      o.rail = s.rail ?? null;
      o.pillar = s.pillar ?? 0;
      if (s.umbrella) o.umbrella = { ...s.umbrella, gone: false, isOpen: s.umbrella.init };
      this.slots.push(o);
      this.at.set(`${s.row},${s.col}`, this.slots.length - 1);
    }
    this.handles = data.handles.map((h) => new HandleS(h, enterCount));
    this.rd = data.ropes.map((r) => ({ ...r }));
    // trapdoors: their handles and ropes exist from the start, dormant, so every index is fixed for good
    (data.traps ?? []).forEach((t, ti) => {
      const slots: number[] = [];
      for (let r = 0; r < t.h; r++) for (let c = 0; c < t.w; c++) { const s = this.slotAt(t.row + r, t.col + c); if (s >= 0) { slots.push(s); this.slots[s].trap = ti; } }
      const h0 = this.handles.length, r0 = this.rd.length;
      for (const hd of t.handles) {
        const lr = Math.floor(hd.slot / t.w), lc = hd.slot % t.w;
        const h = new HandleS({ ...hd, slot: this.slotAt(t.row + lr, t.col + lc) }, enterCount);
        h.dormant = true;
        this.handles.push(h);
      }
      for (const rp of t.ropes) this.rd.push({ ...rp, a: rp.a + h0, b: rp.b + h0 });
      this.traps.push({ d: t, state: 'closed', t: 0, slots, handles: t.handles.map((_, i) => h0 + i), ropes: t.ropes.map((_, i) => r0 + i) });
    });
    this.ropes = this.rd.map((r, i) => ({ color: r.color, length: r.length, group: -1, gone: false, w: i < data.ropes.length ? i : -1, overAtReach: false, dormant: i >= data.ropes.length }));
    this.rd.forEach((r, i) => { this.handles[r.a].ropes.push(i); if (r.b !== r.a) this.handles[r.b].ropes.push(i); });
    this.handles.forEach((h, k) => { if (!h.dormant) this.occupy(k, h.slot); });
    // groups (§3.4): flood fill over handles and ropes
    this.regroup();
    const xs = this.slots.map((s) => s.x), zs = this.slots.map((s) => s.z);
    this.world = new RopeWorld(
      this.handles.map((h) => [this.slots[h.slot].x, this.slots[h.slot].z]),
      data.ropes.map((r, i) => ({ a: r.a, b: r.b, rest: r.length + CFG.extraRopeLengthForGenerate, group: this.ropes[i].group, pts: r.pose, oa: this.cellOff(r.a, r.ca), ob: this.cellOff(r.b, r.cb) })),
      { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) },
    );
    this.handles.forEach((h, k) => { const w = this.world.handles[k]; w.cells = h.cells.map(([dr, dc]) => [dc * this.pitchX, dr * CFG.STEP]); w.gone = h.dormant; });
    // pillars stand at slot corners
    this.slots.forEach((s, i) => {
      if (!s.pillar) return;
      const sx = s.pillar === 2 || s.pillar === 4 ? 1 : -1, sz = s.pillar >= 3 ? 1 : -1;
      this.world.pillars.push({ x: s.x + (sx * this.pitchX) / 2, z: s.z + (sz * CFG.STEP) / 2, gone: false });
      s.pillarIndex = this.world.pillars.length - 1;
      void i;
    });
    this.warn = this.ropes.map(() => -1);
    this.owner = data.ropes.map((_, i) => i);
    for (const g of this.groups) g.state = 'stable';   // Init → Stable (§3.8)
    this.coverUmbrellas();
  }

  slotXY(row: number, col: number): P {
    return [(col - (this.cols - 1) / 2) * this.pitchX, (row - (this.rows - 1) / 2) * CFG.STEP];
  }
  slotAt(row: number, col: number): number { return this.at.get(`${row},${col}`) ?? -1; }
  /** Is slot s a real slot (not a hole in the grid)? */
  exists(s: number): boolean { return this.slots[s].exists; }
  handlePos(k: number): [number, number, number] { return this.world.handles[k].pos; }
  /** Where on handle k a rope tied to its cell c sits, from the handle's position. */
  cellOff(k: number, c = 0): [number, number] { const [dr, dc] = this.handles[k].cells[c] ?? [0, 0]; return [dc * this.pitchX, dr * CFG.STEP]; }
  /** The slots handle k would cover standing in slot s (null if one is off the grid). */
  cellsAt(k: number, s: number): number[] | null {
    const o = this.slots[s], out: number[] = [];
    for (const [dr, dc] of this.handles[k].cells) { const q = this.slotAt(o.row + dr, o.col + dc); if (q < 0) return null; out.push(q); }
    return out;
  }
  private occupy(k: number, s: number): void { for (const q of this.cellsAt(k, s) ?? [s]) { this.slots[q].handle = k; this.slots[q].state = 'occupied'; } }
  private vacate(k: number, s: number): void { for (const q of this.cellsAt(k, s) ?? [s]) if (this.slots[q].handle === k) { this.slots[q].handle = -1; this.slots[q].state = 'normal'; } }
  /** LongMap: is this row on screen? */
  rowShown(row: number): boolean { return row >= this.winMin && row < this.winMin + this.winRows; }
  /** The handles geared with k (k too), or just k. */
  gearOf(k: number): number[] { const g = this.handles[k].gear; return g ? this.handles.map((_, i) => i).filter((i) => this.handles[i].gear === g && !this.handles[i].gone && !this.handles[i].dormant) : [k]; }

  /**
   * Rebuild the groups from the handle–rope graph (load, a cut, a trapdoor opening). A group
   * whose ropes are unchanged carries on as it was (state, timers); group ids are list indices.
   */
  private regroup(): void {
    const seen = new Set<number>(), found: { ropes: number[]; handles: number[] }[] = [];
    this.ropes.forEach((r, i) => {
      if (r.gone || r.dormant || seen.has(i)) return;
      const ropes: number[] = [], handles = new Set<number>(), todo = [i];
      seen.add(i);
      while (todo.length) {
        const q = todo.pop()!;
        ropes.push(q);
        const d = this.rd[q];
        for (const h of [d.a, d.b]) {
          if (handles.has(h)) continue;
          handles.add(h);
          for (const o of this.handles[h].ropes) if (!seen.has(o) && !this.ropes[o].gone && !this.ropes[o].dormant) { seen.add(o); todo.push(o); }
        }
      }
      found.push({ ropes, handles: [...handles] });
    });
    const next: Group[] = this.groups.filter((g) => g.state === 'gone' || g.state === 'disappear');
    for (const f of found) {
      const same = this.groups.find((o) => o.state !== 'gone' && o.state !== 'disappear' && o.ropes.length === f.ropes.length && o.ropes.every((r) => f.ropes.includes(r)));
      if (same) { same.handles = f.handles; next.push(same); continue; }
      const g = new Group(0, f.ropes, f.handles, this.ropes[f.ropes[0]].color);
      if (this.world) g.state = 'stable';
      next.push(g);
    }
    next.forEach((g, i) => { g.id = i; });
    this.groups = next;
    for (const g of this.groups) {
      for (const r of g.ropes) { this.ropes[r].group = g.id; const w = this.ropes[r].w; if (this.world && w >= 0) this.world.ropes[w].group = g.id; }
      if (g.state !== 'gone') for (const h of g.handles) this.handles[h].group = g.id;
    }
  }

  // ------------------------------------------------------------ input (§4)

  /** The finger went down on handle k (OnMouseDown). */
  press(k: number): void { if (k >= 0 && !this.handles[k].gone && !this.handles[k].dormant) this.handles[k].hold = true; }
  /** The finger, on the board plane (board units). */
  setFinger(p: P | null): void { this.finger = p; }
  /** The finger came up (OnMouseUp) — or the touch was lost. */
  up(): void { for (const h of this.handles) h.hold = false; this.finger = null; }

  /** Why handle k can't be picked right now (spec §4.1, with the §11 reasons), or null. */
  pickBlock(k: number): string | null {
    const h = this.handles[k];
    if (!h || h.gone || h.dormant || h.state !== 'stable') return 'busy';
    if (this.waitForResult) return 'result';
    if (this.active >= 0 && this.active !== k) return 'another';
    if (h.fixed && h.converted === null) return h.toggle ? 'toggled' : 'fixed';
    if (this.tool !== 'normal') return 'tool';
    if (this.groups[h.group]?.cut) return 'cut';
    if (this.time < h.colliderOffUntil) return 'justPlaced';
    const cells = this.cellsAt(k, h.slot) ?? [h.slot];
    if (cells.some((q) => this.slots[q].covered)) return 'umbrella';
    if (cells.some((q) => !this.rowShown(this.slots[q].row))) return 'window';
    // a geared handle takes its whole gear: all of them must be free to go
    for (const m of this.gearOf(k)) if (m !== k) { const o = this.handles[m]; if (o.state !== 'stable' || (o.fixed && o.converted === null)) return 'gear'; }
    return null;
  }

  update(dt: number): BoardEvent[] {
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= CFG.fixedDeltaTime) { this.acc -= CFG.fixedDeltaTime; this.fixedUpdate(); }
    const ev = this.events;
    this.events = [];
    return ev;
  }
  /** Run the rules without a frame clock (level making): n fixed steps. */
  run(n: number): BoardEvent[] { for (let i = 0; i < n; i++) this.fixedUpdate(); const ev = this.events; this.events = []; this.lastEvents.push(...ev); return ev; }
  /** Everything `run` returned since the caller last cleared it (level making). */
  lastEvents: BoardEvent[] = [];

  fixedUpdate(): void {
    const dt = CFG.fixedDeltaTime;
    this.time += dt;
    this.frame++;
    if (this.started && !this.waitForResult) this.elapsed += dt;
    // 0. timed things (§11): umbrellas, toggling and time-to-fixed handles, trapdoors, the long-map window
    this.timed();
    // 1. handles
    this.handles.forEach((h, k) => this.handleLogic(k, h, dt));
    // 2. ropes (and the bits of cut ropes shrinking away), 3. contacts come with the step
    this.cutLogic(dt);
    for (const g of this.groups) if (g.state === 'disappear') this.disappearLogic(g, dt);
    this.world.step(dt);
    // 4. stretch
    this.stretch();
    // 5. groups
    for (const g of this.groups) this.groupLogic(g);
    // 6. slots
    this.slotLogic();
    // scale of carried handles (view)
    for (const h of this.handles) {
      if (h.state === 'disappear') continue;
      const want = h.state === 'operate' && h.leader < 0 ? CFG.operateScale : 1;
      h.scale += Math.sign(want - h.scale) * Math.min(Math.abs(want - h.scale), ((CFG.operateScale - 1) / CFG.operateScaleTime) * dt);
    }
  }

  // ------------------------------------------------------------ timed elements (§11)

  private timed(): void {
    // umbrellas open and close in turn (only once play has started)
    this.slots.forEach((s, i) => {
      const u = s.umbrella;
      if (!u || u.gone) return;
      let open = u.init;
      if (this.started) { const t = this.elapsed % (u.open + u.close); open = u.init ? t < u.open : t >= u.close; }
      if (open !== u.isOpen) { u.isOpen = open; this.events.push({ k: 'umbrella', slot: i, open }); this.coverUmbrellas(); }
    });
    this.handles.forEach((h, k) => {
      if (h.gone || h.dormant || h.state !== 'stable') return;
      // time-to-fixed: nailed down after N s of play
      if (h.toFixedTime !== null && this.elapsed >= h.toFixedTime) { h.toFixedTime = null; h.fixed = true; h.converted = null; this.events.push({ k: 'nowFixed', h: k }); }
      // toggling: fixed, free, fixed… (it waits until it is put down)
      if (h.toggle && this.started) {
        const fixed = Math.floor(this.elapsed / TOGGLE) % 2 === 0;
        if (fixed !== h.fixed) { h.fixed = fixed; this.events.push({ k: 'toggle', h: k, fixed }); }
      }
    });
    // trapdoors open once nothing lies on them
    this.traps.forEach((t, ti) => {
      if (t.state === 'closed' && this.trapClear(t)) { t.state = 'opening'; t.t = 0; this.events.push({ k: 'trapOpening', trap: ti }); }
      else if (t.state === 'opening') { t.t += CFG.fixedDeltaTime; if (t.t >= 0.5) this.openTrap(ti); }
    });
    // the long map slides down when its top row is empty
    if (this.winCheckAt >= 0 && this.time >= this.winCheckAt) {
      this.winCheckAt = -1;
      let moved = false;
      while (this.winMin + this.winRows < this.rows && !this.handles.some((h) => !h.gone && !h.dormant && (this.cellsAt(this.handles.indexOf(h), h.slot) ?? [h.slot]).some((q) => this.slots[q].row === this.winMin))) { this.winMin++; moved = true; }
      if (moved) this.events.push({ k: 'window', min: this.winMin });
    }
  }
  private coverUmbrellas(): void {
    for (const s of this.slots) s.covered = false;
    for (const s of this.slots) {
      if (!s.umbrella || s.umbrella.gone || !s.umbrella.isOpen) continue;
      for (let dr = -UMBRELLA_REACH; dr <= UMBRELLA_REACH; dr++) for (let dc = -UMBRELLA_REACH; dc <= UMBRELLA_REACH; dc++) { const q = this.slotAt(s.row + dr, s.col + dc); if (q >= 0) this.slots[q].covered = true; }
    }
  }
  private trapClear(t: TrapRun): boolean {
    if (t.slots.some((s) => this.slots[s].handle >= 0)) return false;
    const xs = t.slots.map((s) => this.slots[s].x), zs = t.slots.map((s) => this.slots[s].z), m = 0.45;
    const x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m, z0 = Math.min(...zs) - m, z1 = Math.max(...zs) + m;
    return !this.world.ropes.some((r) => !r.gone && Array.from({ length: r.n }, (_, q) => q).some((q) => r.x[q * 3] > x0 && r.x[q * 3] < x1 && r.x[q * 3 + 2] > z0 && r.x[q * 3 + 2] < z1));
  }
  private openTrap(ti: number): void {
    const t = this.traps[ti];
    t.state = 'open';
    // the little level comes up through the door: its handles in their slots, its ropes as laid out
    const c = t.slots.map((s) => [this.slots[s].x, this.slots[s].z]);
    const cx = c.reduce((a, p) => a + p[0], 0) / c.length, cz = c.reduce((a, p) => a + p[1], 0) / c.length;
    for (const k of t.handles) {
      const h = this.handles[k];
      h.dormant = false;
      const w = this.world.handles[k], s = this.slots[h.slot];
      w.gone = false; w.pos = [s.x, END_Y, s.z]; w.prev = [s.x, END_Y, s.z];
      this.occupy(k, h.slot);
    }
    for (const r of t.ropes) {
      const d = this.rd[r], m = this.ropes[r];
      const pts = d.pose?.map((v, q) => v + (q % 3 === 0 ? cx : q % 3 === 2 ? cz : 0));
      m.w = this.world.addRope({ a: d.a, b: d.b, rest: d.length + CFG.extraRopeLengthForGenerate, group: 0, pts, oa: this.cellOff(d.a, d.ca), ob: this.cellOff(d.b, d.cb) });
      this.owner[m.w] = r;
      m.dormant = false;
    }
    for (const s of t.slots) this.slots[s].trap = -1;
    this.regroup();
    this.events.push({ k: 'trapOpen', trap: ti });
  }

  // ------------------------------------------------------------ handle FSM (§4, §6.1)

  private handleLogic(k: number, h: HandleS, dt: number): void {
    if (h.gone || h.dormant || h.state === 'disappear' || h.leader >= 0) return;
    if (h.state === 'stable') {
      if (h.hold && this.pickBlock(k) === null) this.pick(k, h);
      else if (h.hold && this.active !== k) {
        const why = this.pickBlock(k);
        if (why && why !== 'another') this.events.push({ k: 'pickFail', h: k, why });
        h.hold = false;
      }
      return;
    }
    if (h.state === 'operate') {
      if (!h.hold || this.waitForResult) return this.release(k, h);
      const t = this.target(k, h);
      if (!t) return this.release(k, h);
      this.approach(k, [t[0], CFG.liftZ + END_Y, t[1]], CFG.maxMoveSpeedZ, dt);
      this.carryGear(k);
      return;
    }
    if (h.state === 'operate2stable') {
      const s = this.slots[h.toSlot];
      const done = this.approach(k, [s.x, END_Y, s.z], h.snap ? CFG.maxSnapMoveSpeedZ : CFG.maxMoveSpeedZ, dt);
      this.carryGear(k);
      if (!done) return;
      if (h.snap) return this.complete(k, h, h.slot, 'snap');
      // the last check (§4.3): none of its ropes (nor its gear's) stretched past snapRate along its beads
      const ok = this.gearOf(k).every((m) => this.handles[m].ropes.every((r) => this.ropes[r].gone || this.restLengthRate(r) <= CFG.snapRate));
      if (ok) return this.complete(k, h, h.toSlot, 'place');
      h.toSlot = h.slot;
      h.snap = true;
      this.snapWhy = 'stretched';
    }
  }
  private snapWhy: 'noSlot' | 'stretched' | 'stress' = 'noSlot';
  /** Geared handles ride along with the carried one, at the same height. */
  private carryGear(k: number): void {
    const p = this.handlePos(k);
    for (const m of this.gearOf(k)) {
      if (m === k) continue;
      const o = this.handles[m];
      this.world.place(m, p[0] + o.follow[0], p[1], p[2] + o.follow[1]);
    }
  }

  private pick(k: number, h: HandleS): void {
    h.state = 'operate';
    this.anyHold = true;
    this.active = k;
    h.reachMax = false;
    for (const r of h.ropes) this.ropes[r].overAtReach = false;
    this.world.pushAway(k, CFG.pushAwayDistance);
    // its gear comes along
    const p = this.handlePos(k);
    for (const m of this.gearOf(k)) {
      if (m === k) continue;
      const o = this.handles[m], q = this.handlePos(m);
      o.leader = k; o.state = 'operate'; o.follow = [q[0] - p[0], q[2] - p[2]];
      this.world.pushAway(m, CFG.pushAwayDistance);
    }
    // the handle floats distanceFromFinger above the finger (towards the top of the screen)
    const f = this.finger ?? [p[0], p[2] + CFG.distanceFromFinger];
    h.offset = [p[0] - f[0], p[2] - f[1]];
    if (Math.hypot(h.offset[0], h.offset[1] + CFG.distanceFromFinger) > 0.9) h.offset = [0, -CFG.distanceFromFinger];
    if (!this.buildCircles(k, h)) { this.events.push({ k: 'pickFail', h: k, why: 'noRoom' }); return this.release(k, h); }
    if (this.over.size) h.stopStressUntil = this.time + CFG.recoverStopStressInterval;
    this.moves++;
    this.started = true;
    this.enteredOnce = false;
    this.events.push({ k: 'pick', h: k });
  }

  private release(k: number, h: HandleS): void {
    h.hold = false;
    this.anyHold = false;
    h.state = 'operate2stable';
    for (const m of this.gearOf(k)) if (m !== k) this.handles[m].state = 'operate2stable';
    const slot = this.waitForResult ? -1 : this.activeSlot;
    if (slot >= 0 && slot !== h.slot) { h.toSlot = slot; h.snap = false; }
    else { h.toSlot = h.slot; h.snap = true; if (this.snapWhy !== 'stress') this.snapWhy = 'noSlot'; }
    this.activeSlot = -1;
  }

  private complete(k: number, h: HandleS, slot: number, how: 'place' | 'snap'): void {
    const gear = this.gearOf(k);
    const o0 = this.slots[h.slot], o1 = this.slots[slot], dr = o1.row - o0.row, dc = o1.col - o0.col;
    // the whole gear moves by the same rows / columns
    const moves = gear.map((m) => { const o = this.handles[m], s = this.slots[o.slot]; return { m, from: o.slot, to: m === k ? slot : this.slotAt(s.row + dr, s.col + dc) }; });
    for (const mv of moves) if (mv.to !== mv.from) this.vacate(mv.m, mv.from);
    for (const mv of moves) {
      const o = this.handles[mv.m];
      o.state = 'stable';
      o.colliderOffUntil = this.time + CFG.operateColliderScaleUpInterval;
      o.leader = -1;
      o.toSlot = -1;
      if (mv.to !== mv.from) {
        if (o.converted !== null) { o.converted--; if (o.converted <= 0) o.converted = null; }
        o.slot = mv.to;
      }
      this.occupy(mv.m, o.slot);
      const s = this.slots[o.slot];
      this.world.place(mv.m, s.x, END_Y, s.z);
    }
    if (this.active === k) this.active = -1;
    if (how === 'place') this.events.push({ k: 'place', h: k, slot });
    else this.events.push({ k: 'snap', h: k, why: this.snapWhy });
    this.snapWhy = 'noSlot';
    if (this.winRows < this.rows) this.winCheckAt = this.time + 0.3;
  }

  /** Move handle k towards a point: at most maxMoveSpeedXY across, zSpeed up/down. True when there. */
  private approach(k: number, t: [number, number, number], zSpeed: number, dt: number): boolean {
    const p = this.handlePos(k);
    const dx = t[0] - p[0], dz = t[2] - p[2], dy = t[1] - p[1];
    const dxy = Math.hypot(dx, dz);
    const sxy = Math.min(dxy, CFG.maxMoveSpeedXY * dt), sy = Math.sign(dy) * Math.min(Math.abs(dy), zSpeed * dt);
    const nx = dxy > 1e-9 ? p[0] + (dx / dxy) * sxy : p[0], nz = dxy > 1e-9 ? p[2] + (dz / dxy) * sxy : p[2];
    this.world.place(k, nx, p[1] + sy, nz);
    return Math.hypot(t[0] - nx, t[1] - (p[1] + sy), t[2] - nz) < CFG.needMoveMinDistance;
  }

  // ------------------------------------------------------------ reach: the rope circles (§5)

  /** Every rope of the handle (and of its gear): a circle the handle's position must stay in. */
  private buildCircles(k: number, h: HandleS): boolean {
    const cs: { c: P; r: number }[] = [];
    for (const m of this.gearOf(k)) {
      const o = this.handles[m], shift: P = m === k ? [0, 0] : o.follow;
      for (const ri of o.ropes) {
        if (this.ropes[ri].gone || this.ropes[ri].dormant) continue;
        const d = this.rd[ri], mine = d.a === m ? 'a' : 'b', other = mine === 'a' ? d.b : d.a;
        if (other === m || this.gearOf(k).includes(other)) continue;
        const q = this.handlePos(other), oo = this.cellOff(other, mine === 'a' ? d.cb : d.ca), own = this.cellOff(m, mine === 'a' ? d.ca : d.cb);
        // |pos_k + shift + own − (q + oo)| ≤ Length
        cs.push({ c: [q[0] + oo[0] - own[0] - shift[0], q[2] + oo[1] - own[1] - shift[1]], r: this.ropes[ri].length });
      }
    }
    // a circle holding another one whole adds nothing
    h.circles = cs.filter((A, i) => !cs.some((B, j) => j !== i && dist(A.c, B.c) + B.r <= A.r + 1e-9 && (dist(A.c, B.c) + B.r < A.r - 1e-9 || j < i)));
    if (!h.circles.length) { const p = this.handlePos(k); h.center = [p[0], p[2]]; return true; }
    if (h.circles.length === 1) { h.center = h.circles[0].c; return true; }
    const pts = this.crossPoints(h.circles).filter((p) => this.inAll(h.circles, p, 1e-6));
    if (!pts.length) return false;
    h.center = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    return true;
  }
  private crossPoints(cs: { c: P; r: number }[]): P[] {
    const out: P[] = [];
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const A = cs[i], B = cs[j], d = dist(A.c, B.c);
      if (d < 1e-9 || d > A.r + B.r || d < Math.abs(A.r - B.r)) continue;
      const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d), hh = Math.sqrt(Math.max(0, A.r * A.r - a * a));
      const ux = (B.c[0] - A.c[0]) / d, uz = (B.c[1] - A.c[1]) / d, mx = A.c[0] + ux * a, mz = A.c[1] + uz * a;
      out.push([mx - uz * hh, mz + ux * hh], [mx + uz * hh, mz - ux * hh]);
    }
    return out;
  }
  private inAll(cs: { c: P; r: number }[], p: P, eps = 1e-6): boolean { return cs.every((c) => dist(c.c, p) <= c.r + eps); }

  /** Where the carried handle goes for the finger now (GetPointForCircles; on a rail: along it), or null if nowhere. */
  private target(k: number, h: HandleS): P | null {
    if (!this.finger) { const p = this.handlePos(k); return [p[0], p[2]]; }
    let want: P = [this.finger[0] + h.offset[0], this.finger[1] + h.offset[1]];
    if (h.rail !== null) want = this.onRail(h.rail, want);       // rail first…
    let p = this.clampCircles(h, want);
    if (!p) return null;
    if (h.rail !== null) p = this.onRail(h.rail, p);              // …circles, then the rail again
    // a pillar keeps the handle at arm's length
    for (const pl of this.world.pillars) {
      if (pl.gone) continue;
      const d = Math.hypot(p[0] - pl.x, p[1] - pl.z);
      if (d < PILLAR_KEEP) { const ux: number = d > 1e-6 ? (p[0] - pl.x) / d : 1, uz: number = d > 1e-6 ? (p[1] - pl.z) / d : 0; p = [pl.x + ux * PILLAR_KEEP, pl.z + uz * PILLAR_KEEP]; }
    }
    return p;
  }
  private clampCircles(h: HandleS, want: P): P | null {
    const cs = h.circles;
    if (this.inAll(cs, want)) { this.setReach(h, false); return want; }
    const cands: P[] = [];
    for (const c of cs) {
      const d = dist(c.c, want);
      if (d > c.r) cands.push([c.c[0] + ((want[0] - c.c[0]) / d) * c.r, c.c[1] + ((want[1] - c.c[1]) / d) * c.r]);
      // where the line from the middle of the reach to the finger leaves this circle
      const ax = want[0] - h.center[0], az = want[1] - h.center[1], fx = h.center[0] - c.c[0], fz = h.center[1] - c.c[1];
      const A = ax * ax + az * az, B = 2 * (fx * ax + fz * az), C = fx * fx + fz * fz - c.r * c.r, D = B * B - 4 * A * C;
      if (A > 1e-12 && D >= 0) for (const t of [(-B + Math.sqrt(D)) / (2 * A), (-B - Math.sqrt(D)) / (2 * A)]) if (t >= 0 && t <= 1) cands.push([h.center[0] + ax * t, h.center[1] + az * t]);
    }
    cands.push(...this.crossPoints(cs));
    let best: P | null = null, bd = Infinity;
    for (const p of cands) {
      if (!this.inAll(cs, p, 1e-5)) continue;
      const d = dist(p, want);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) this.setReach(h, true);
    return best;
  }
  /** The point on rail k nearest p (rails run between neighbouring slots of the same rail). */
  onRail(k: number, p: P): P {
    const rs = this.slots.filter((s) => s.rail === k);
    let best: P = p, bd = Infinity;
    const step = Math.max(this.pitchX, CFG.STEP) * 1.05;
    for (let i = 0; i < rs.length; i++) {
      const a = rs[i];
      if (dist([a.x, a.z], p) < bd) { bd = dist([a.x, a.z], p); best = [a.x, a.z]; }
      for (let j = i + 1; j < rs.length; j++) {
        const b = rs[j];
        if (dist([a.x, a.z], [b.x, b.z]) > step) continue;
        const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((p[0] - a.x) * dx + (p[1] - a.z) * dz) / L2)), q: P = [a.x + dx * t, a.z + dz * t];
        if (dist(q, p) < bd) { bd = dist(q, p); best = q; }
      }
    }
    return best;
  }
  private setReach(h: HandleS, on: boolean): void {
    if (on && !h.reachMax) for (const r of h.ropes) this.ropes[r].overAtReach = this.lengthRate(r) >= this.snapLimit(r, false);
    h.reachMax = on;
  }

  // ------------------------------------------------------------ stretch (§7)

  /** pathLength / Length: from one end, through the contacts with other groups' ropes in bead order, to the other end. */
  lengthRate(i: number): number {
    const m = this.ropes[i];
    if (m.gone || m.dormant || m.w < 0) return 0;
    const r = this.world.ropes[m.w];
    if (r.gone) return 0;
    const pts = r.contacts.slice().sort((a, b) => a.at - b.at);
    let a = r.bead(0), L = 0;
    for (const c of pts) { L += Math.hypot(c.x - a[0], c.y - a[1], c.z - a[2]); a = [c.x, c.y, c.z]; }
    const b = r.bead(r.n - 1);
    L += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    return L / m.length;
  }
  /** Length along the beads / physical length. */
  restLengthRate(i: number): number { const w = this.ropes[i].w; if (w < 0) return 0; const r = this.world.ropes[w]; return r.length() / r.nominal; }
  private snapLimit(i: number, reach: boolean): number {
    const loose = CFG.snapRate + CFG.extraRopeLengthForOperate / this.ropes[i].length;
    return reach && !this.ropes[i].overAtReach ? CFG.snapRate : loose;
  }
  private stretch(): void {
    const held = this.active >= 0 ? this.handles[this.active] : null;
    this.ropes.forEach((m, i) => {
      if (m.gone || m.dormant) { this.warn[i] = -1; this.over.delete(i); return; }
      const rate = this.lengthRate(i);
      // the warning colour (spec: only while the rope is out of its resting layer — read here as: while
      // a handle is carried or its group is on the move; a rope lying wound tight at rest stays plain)
      const stirred = this.anyHold || this.groups[m.group]?.state !== 'stable';
      this.warn[i] = rate < CFG.warningRate || !stirred ? -1 : Math.min(1, (rate - CFG.warningRate) / (CFG.snapRate - CFG.warningRate));
      const reach = !!held && held.ropes.includes(i) && held.reachMax;
      if (rate >= this.snapLimit(i, reach) && held && this.anyHold) {
        this.over.add(i);
        this.onStress(i);
      } else if (rate < this.snapLimit(i, reach)) this.over.delete(i);
    });
  }
  /** OperateState.OnRopeStressEvent: the carried handle lets go and flies back. */
  private onStress(i: number): void {
    const k = this.active, h = this.handles[k];
    if (!h || h.state !== 'operate') return;
    if (this.time < h.stopStressUntil) return;
    const mine = this.gearOf(k).flatMap((m) => this.handles[m].ropes);
    if (h.ropes.filter((r) => !this.ropes[r].gone).length >= 2 && !mine.includes(i)) return;
    if (DEBUG.stress) { const r = this.world.ropes[this.ropes[i].w]; console.log(`    stress rope ${i} rate ${this.lengthRate(i).toFixed(2)} bead/rest ${(r.length() / r.rest).toFixed(2)} contacts ${r.contacts.length} own ${h.ropes.includes(i)} held ${k}`); }
    this.events.push({ k: 'stress', rope: i });
    h.hold = false;
    this.activeSlot = -1;
    this.snapWhy = 'stress';
  }

  // ------------------------------------------------------------ group FSM (§6.3, §8)

  /** Does group g touch (layer 1) or overlap (layer 2) any other group still on the board? */
  overlaps(g: Group): boolean {
    for (const o of this.groups) {
      if (o === g || o.state === 'gone' || o.state === 'disappear') continue;
      const key = RopeWorld.key(g.id, o.id);
      if (this.world.touchPairs.has(key) || this.world.overlapPairs.has(key)) return true;
    }
    return false;
  }
  private groupLogic(g: Group): void {
    if (g.state === 'gone' || g.state === 'disappear') return;
    const moving = g.handles.some((k) => this.handles[k].state !== 'stable');
    if (g.state === 'stable' && moving) g.state = 'operate';
    else if (g.state === 'operate' && !moving) g.state = 'stable';
    if (g.state !== 'stable' || this.anyHold || this.overlaps(g)) { g.lastBusyTime = this.time; g.lastBusyFrame = this.frame; }
    if (g.state === 'stable' && !g.cut && !this.stopTransition && this.canUntie
      && this.time - g.lastBusyTime > CFG.notOverlapIntervalBeforeDisappear && this.frame > g.lastBusyFrame) this.startDisappear(g);
  }
  private startDisappear(g: Group): void {
    g.state = 'disappear';
    g.t = 0;
    for (const k of g.handles) { const h = this.handles[k]; h.state = 'disappear'; this.vacate(k, h.slot); }
    g.from = g.handles.map((k) => [...this.handlePos(k)] as [number, number, number]);
    const cx = g.from.reduce((a, p) => a + p[0], 0) / g.from.length, cz = g.from.reduce((a, p) => a + p[2], 0) / g.from.length;
    g.center = [cx, END_Y + CFG.disappearZ, cz];
    this.events.push({ k: 'disappear', group: g.id, ropes: g.ropes.slice(), center: [cx, cz] });
  }
  /** Handles pop (1.1×), gather up at the middle; the ropes shrink with them (§8.4). */
  private disappearLogic(g: Group, dt: number): void {
    g.t += dt;
    const up = CFG.disappearScaleUp, down = CFG.disappearScaleDown, mv = CFG.disappearMoveInterval;
    g.handles.forEach((k, i) => {
      const h = this.handles[k];
      h.scale = g.t < up ? 1 + (CFG.disappearScale - 1) * (g.t / up) : g.t < up + down ? CFG.disappearScale - (CFG.disappearScale - 1) * ((g.t - up) / down) : 1;
      const m = Math.max(0, Math.min(1, (g.t - up - down) / mv)), e = m * m * (3 - 2 * m);
      const a = g.from[i];
      this.world.place(k, a[0] + (g.center[0] - a[0]) * e, a[1] + (g.center[1] - a[1]) * e, a[2] + (g.center[2] - a[2]) * e);
    });
    for (const r of g.ropes) {
      const w = this.world.ropes[this.ropes[r].w], d = this.rd[r];
      const A = this.handlePos(d.a), B = this.handlePos(d.b);
      w.adapt = false;
      w.rest = Math.max(0.05, Math.min(w.rest, Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])));
    }
    if (g.t >= up + down + mv) {
      g.state = 'gone';
      for (const r of g.ropes) { this.ropes[r].gone = true; this.world.ropes[this.ropes[r].w].gone = true; }
      for (const k of g.handles) { this.handles[k].gone = true; this.world.handles[k].gone = true; }
      this.world.wake();
      this.events.push({ k: 'gone', group: g.id });
      if (this.winRows < this.rows) this.winCheckAt = this.time + 0.3;
      if (this.isCleared()) this.events.push({ k: 'cleared' });
    }
  }
  /** Nothing left: every group gone and every trapdoor opened and cleared. */
  isCleared(): boolean { return this.groups.every((o) => o.state === 'gone') && this.traps.every((t) => t.state === 'open'); }
  /** The groups on the board group g touches or overlaps now. */
  touching(g: Group): Group[] {
    return this.live().filter((o) => o !== g && (this.world.touchPairs.has(RopeWorld.key(g.id, o.id)) || this.world.overlapPairs.has(RopeWorld.key(g.id, o.id))));
  }
  /** How many other groups rope i's group touches (0 if it is gone). */
  touchCount(i: number): number { const r = this.ropes[i]; return r.gone || r.dormant ? 0 : this.touching(this.groups[r.group]).length; }
  /** Groups still on the board. */
  live(): Group[] { return this.groups.filter((g) => g.state !== 'gone' && g.state !== 'disappear'); }

  // ------------------------------------------------------------ slot FSM (§4.2 step 5, §6.2)

  /** Could handle k (and its gear) stand with its first cell in slot s? */
  fits(k: number, s: number, ignoreCover = false): boolean {
    const h = this.handles[k], o0 = this.slots[h.slot], o1 = this.slots[s];
    for (const m of this.gearOf(k)) {
      const om = this.handles[m], sm = this.slots[om.slot];
      const to = m === k ? s : this.slotAt(sm.row + o1.row - o0.row, sm.col + o1.col - o0.col);
      if (to < 0) return false;
      const cells = this.cellsAt(m, to);
      if (!cells) return false;
      for (const q of cells) {
        const c = this.slots[q];
        if (!c.exists || c.type !== 'normal' || (c.covered && !ignoreCover) || c.trap >= 0 || !this.rowShown(c.row)) return false;
        if (c.handle >= 0 && !this.gearOf(k).includes(c.handle)) return false;
        // rails: a rail handle stands only on its own rail; nothing else stands on a rail
        if (c.rail !== (q === to ? om.rail : null)) return false;
      }
    }
    return true;
  }
  private slotLogic(): void {
    let best = -1;
    const k = this.active, h = k >= 0 ? this.handles[k] : null;
    if (h && h.state === 'operate') {
      const p = this.handlePos(k);
      let bd: number = CFG.slotActiveDistance;
      this.slots.forEach((s, i) => {
        const d = Math.hypot(s.x - p[0], s.z - p[2]);
        if (d >= bd) return;
        if (i !== h.slot && !this.fits(k, i)) return;
        bd = d; best = i;
      });
    }
    if (best !== this.activeSlot) {
      if (best >= 0 && best !== h?.slot && this.enteredOnce) this.events.push({ k: 'enterSlot', slot: best });
      if (best >= 0) this.enteredOnce = true;
      this.activeSlot = best;
    }
    this.slots.forEach((s, i) => { s.state = s.handle >= 0 && (s.handle !== k || i !== best) ? 'occupied' : i === best ? 'active' : 'normal'; });
  }

  // ------------------------------------------------------------ boosters (§10)

  /** Scissors (§10.1): cut rope i at bead q (not right by a handle). After `delay` s the rope parts. False if refused. */
  cut(i: number, q: number, delay: number): boolean {
    const m = this.ropes[i];
    if (!m || m.gone || m.dormant || this.cuts.length) return false;
    const r = this.world.ropes[m.w];
    if (q < 2 || q > r.n - 3) return false;
    this.groups[m.group].cut = true;
    this.cuts.push({ rope: i, bead: q, t: delay });
    const b = r.bead(q);
    this.events.push({ k: 'cut', rope: i, at: [b[0], b[2]] });
    return true;
  }
  /** The bead of rope i nearest a board point. */
  nearestBead(i: number, p: P): number {
    const r = this.world.ropes[this.ropes[i].w];
    let best = 0, bd = Infinity;
    for (let q = 0; q < r.n; q++) { const d = Math.hypot(r.x[q * 3] - p[0], r.x[q * 3 + 2] - p[1]); if (d < bd) { bd = d; best = q; } }
    return best;
  }
  private cutLogic(dt: number): void {
    for (const c of this.cuts) c.t -= dt;
    const due = this.cuts.filter((c) => c.t <= 0);
    this.cuts = this.cuts.filter((c) => c.t > 0);
    for (const c of due) {
      const m = this.ropes[c.rope], g = this.groups[m.group];
      const halves = this.world.cut(m.w, c.bead);
      for (const w of halves) { this.owner[w] = c.rope; this.world.ropes[w].adapt = false; this.shrink.push({ w, t: 0, from: this.world.ropes[w].rest }); }
      m.gone = true;
      g.cut = false;
      for (const h of this.handles) h.ropes = h.ropes.filter((r) => r !== c.rope);
      // the group may fall in two; a handle left with no rope goes
      this.regroup();
      this.handles.forEach((h, k) => {
        if (h.gone || h.dormant || h.ropes.some((r) => !this.ropes[r].gone)) return;
        h.gone = true; this.world.handles[k].gone = true;
        this.vacate(k, h.slot);
        this.events.push({ k: 'handleGone', h: k });
      });
      if (this.isCleared()) this.events.push({ k: 'cleared' });
    }
    // the halves of a cut rope reel in to their handles and vanish
    this.shrink = this.shrink.filter((s) => {
      s.t += dt;
      const r = this.world.ropes[s.w];
      r.rest = Math.max(0.04, s.from * (1 - s.t / 0.35));
      if (s.t >= 0.35) { r.gone = true; return false; }
      return true;
    });
  }

  /**
   * Hammer (§10.2): what can be hit at a board point — a fixed handle, a handle or slot on a rail, a
   * forbidden slot, a pillar, an umbrella (null = nothing; no item spent).
   */
  hammerTarget(p: P): HammerTarget | null {
    let best: HammerTarget | null = null, bd = 0.75;
    const take = (d: number, t: HammerTarget) => { if (d < bd) { bd = d; best = t; } };
    this.handles.forEach((h, k) => {
      if (h.gone || h.dormant || h.state !== 'stable' || !(h.fixed || h.rail !== null)) return;
      const q = this.handlePos(k);
      take(Math.hypot(q[0] - p[0], q[2] - p[1]), { what: h.rail !== null ? 'rail' : 'handle', i: k });
    });
    this.slots.forEach((s, i) => {
      if (!s.exists || !this.rowShown(s.row)) return;
      const d = Math.hypot(s.x - p[0], s.z - p[1]);
      if (s.umbrella && !s.umbrella.gone) take(d * 0.9, { what: 'umbrella', i });
      else if (s.type === 'forbidden') take(d, { what: 'slot', i });
      else if (s.rail !== null && s.handle < 0) take(d, { what: 'rail', i: -1 - i });
    });
    this.world.pillars.forEach((pl, i) => { if (!pl.gone) take(Math.hypot(pl.x - p[0], pl.z - p[1]) * 0.8, { what: 'pillar', i }); });
    return best;
  }
  hammer(t: HammerTarget): void {
    let at: P = [0, 0];
    if (t.what === 'handle') {
      const h = this.handles[t.i];
      h.fixed = false; h.converted = null; h.toggle = false; h.toFixedTime = null;
      const q = this.handlePos(t.i); at = [q[0], q[2]];
    } else if (t.what === 'rail') {
      // the whole rail goes: its handles become ordinary ones
      const k = t.i >= 0 ? this.handles[t.i].rail : this.slots[-1 - t.i].rail;
      for (const s of this.slots) if (s.rail === k) s.rail = null;
      for (const h of this.handles) if (h.rail === k) h.rail = null;
      if (t.i >= 0) { const q = this.handlePos(t.i); at = [q[0], q[2]]; } else { const s = this.slots[-1 - t.i]; at = [s.x, s.z]; }
    } else if (t.what === 'slot') {
      const s = this.slots[t.i];
      s.type = 'normal'; at = [s.x, s.z];
    } else if (t.what === 'umbrella') {
      const s = this.slots[t.i];
      s.umbrella!.gone = true; s.umbrella!.isOpen = false; this.coverUmbrellas();
      at = [s.x, s.z];
    } else {
      const pl = this.world.pillars[t.i];
      pl.gone = true; at = [pl.x, pl.z];
    }
    this.world.impulse(at[0], at[1], CFG.hammerRange, CFG.hammerMinImpact, CFG.hammerMaxImpact, () => this.rnd());
    this.events.push({ k: 'hammer', at, what: t.what, i: t.i });
  }
  private rnd(): number { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  /** Expansion (§10.3): a ring of preview slots round the board (cancel removes them). Long maps grow left / right only. */
  previewExpansion(): number[] {
    const add: [number, number][] = [], seen = new Set(this.slots.map((s) => `${s.row},${s.col}`));
    const dirs = this.winRows < this.rows ? [[0, -1], [0, 1]] : [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (const s of this.slots) for (const [dr, dc] of dirs) {
      const key = `${s.row + dr},${s.col + dc}`;
      if (!seen.has(key)) { seen.add(key); add.push([s.row + dr, s.col + dc]); }
    }
    const made: number[] = [];
    for (const [r, c] of add) { const [x, z] = this.slotXY(r, c); this.slots.push(new Slot(r, c, x, z, 'preview')); made.push(this.slots.length - 1); this.at.set(`${r},${c}`, this.slots.length - 1); }
    return made;
  }
  confirmExpansion(): void { for (const s of this.slots) if (s.type === 'preview') s.type = 'normal'; }
  cancelExpansion(): void {
    this.slots = this.slots.filter((s) => s.type !== 'preview');
    this.at.clear();
    this.slots.forEach((s, i) => this.at.set(`${s.row},${s.col}`, i));
  }

  /** The physics (for tools). */
  snapshot(): Snapshot { return this.world.snapshot(); }
}
