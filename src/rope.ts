// Rope physics (Tangled Rope spec §1, "particle rope, Obi/XPBD style"): every rope is a
// chain of beads of fixed length between two handles (pins); a handle may hold several
// rope ends. Ropes lie on the board under gravity and never pass through each other
// (capsule against capsule), so hooks, twists and ropes threaded through loops happen by
// themselves. A carried handle floats high, so the rope it trails rides over whatever it is
// taken across. Ropes lying across another handle rest on its top.
//
// Each step also records, for the rules (board.ts), where every rope touches a rope of
// another group (layer 1: real contact, with the bead index, for the stretch) and which
// groups overlap seen from above (layer 2: beads closer than `particleDistance` in x/z).
//
// Shared by the game and scripts/gen-levels.ts. No three.js: x right, y up, z down the board.

import { CFG } from './config.ts';

export const R = 0.13;           // rope radius
export const SEG = 0.15;         // bead spacing at rest
export const PIN_R = 0.4;        // handle radius
export const PIN_TOP = 0.22;     // top of a handle: ropes lying across one rest on it
export const END_Y = 0.22;       // a rope leaves its handle at this height
const G = 14;                    // gravity
const SUB = 6;                   // substeps per step (a pin moves at most ~0.08 in one: less than a rope's width)
const ITER = 2;                  // constraint passes per substep
const COMPLIANCE = 1e-6;         // a little give in every link (XPBD)
const DAMP = 0.992;              // velocity kept per substep
const FRICTION = 0.25;           // sideways speed lost per substep while lying on the board
const ROPE_FRICTION = 0.04;      // speed lost per substep by a bead pressed against another rope
const BEND = 0.55;               // stiffness against sharp bends (a bead and the one after next keep apart)
const BEND_MIN = 1.78;           // …at least this many links apart (a bend of at most ~54° per bead)
const BEND_SOFT = 0.07;          // and a gentle pull straight at any bend: slack lies in one smooth curve, not in waves
export const PILLAR_R = 0.2;            // a pillar: a post the ropes go round
const TOUCH = 2 * R + 0.03;      // layer 1: closer than this is a contact
const CELL = 0.5;                // collision grid

export type V3 = [number, number, number];

/** a / b: handles at the ends; oa / ob: where on the handle (a multi-slot handle holds ropes on its cells). */
export interface RopeInit { a: number; b: number; rest: number; group: number; pts?: number[]; oa?: [number, number]; ob?: [number, number] }

export class Handle {
  pos: V3;
  /** Where it was at the start of this step (the substeps move it smoothly from there). */
  prev: V3;
  gone = false;
  /** The cells it covers, as offsets from its position (one cell: [0, 0]). */
  cells: [number, number][] = [[0, 0]];
  constructor(x: number, z: number) { this.pos = [x, END_Y, z]; this.prev = [x, END_Y, z]; }
}

export class Rope {
  n: number;
  x: Float64Array;   // bead positions (3 per bead)
  p: Float64Array;   // last positions (velocity = x - p)
  rest: number;      // physical length
  /** The handles at its two ends (-1 = a loose end, as after a cut). */
  h: [number, number];
  /** Where on each handle it is tied (offset from the handle's position). */
  off: [[number, number], [number, number]];
  group: number;
  gone = false;
  /** Contacts with ropes of other groups in the last step: bead index (fractional) and point. */
  contacts: { at: number; x: number; y: number; z: number }[] = [];
  constructor(init: RopeInit, handles: Handle[]) {
    this.rest = init.rest;
    this.h = [init.a, init.b];
    this.off = [init.oa ?? [0, 0], init.ob ?? [0, 0]];
    this.group = init.group;
    const a0 = handles[Math.max(0, init.a)].pos, b0 = handles[Math.max(0, init.b)].pos;
    const A: V3 = [a0[0] + this.off[0][0], a0[1], a0[2] + this.off[0][1]], B: V3 = [b0[0] + this.off[1][0], b0[1], b0[2] + this.off[1][1]];
    this.n = init.pts ? init.pts.length / 3 : Math.max(4, Math.ceil(init.rest / SEG) + 1);
    this.x = new Float64Array(this.n * 3);
    if (init.pts) this.x.set(init.pts);
    else {
      // longer than the gap: lay it in an arc, the slack bulging sideways
      const dx = B[0] - A[0], dz = B[2] - A[2], d = Math.hypot(dx, dz) || 1;
      const bulge = Math.sqrt(Math.max(0, init.rest * init.rest - d * d)) * 0.45;
      for (let q = 0; q < this.n; q++) {
        const t = q / (this.n - 1), s = Math.sin(Math.PI * t) * bulge;
        this.x[q * 3] = A[0] + dx * t - (dz / d) * s;
        this.x[q * 3 + 1] = q === 0 || q === this.n - 1 ? END_Y : R;
        this.x[q * 3 + 2] = A[2] + dz * t + (dx / d) * s;
      }
    }
    this.p = this.x.slice();
  }
  /** Length along the beads. */
  length(): number {
    let L = 0;
    for (let q = 0; q + 1 < this.n; q++) L += Math.hypot(this.x[q * 3 + 3] - this.x[q * 3], this.x[q * 3 + 4] - this.x[q * 3 + 1], this.x[q * 3 + 5] - this.x[q * 3 + 2]);
    return L;
  }
  bead(q: number): V3 { return [this.x[q * 3], this.x[q * 3 + 1], this.x[q * 3 + 2]]; }
}

/** Closest points of segments p1–p2 and q1–q2: [s, t] along each (0..1). */
function closest(x: Float64Array, a: number, b: number, y: Float64Array, c: number, d: number, out: number[]): void {
  const d1x = x[b] - x[a], d1y = x[b + 1] - x[a + 1], d1z = x[b + 2] - x[a + 2];
  const d2x = y[d] - y[c], d2y = y[d + 1] - y[c + 1], d2z = y[d + 2] - y[c + 2];
  const rx = x[a] - y[c], ry = x[a + 1] - y[c + 1], rz = x[a + 2] - y[c + 2];
  const A = d1x * d1x + d1y * d1y + d1z * d1z, E = d2x * d2x + d2y * d2y + d2z * d2z, F = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (A <= 1e-12 && E <= 1e-12) { out[0] = 0; out[1] = 0; return; }
  if (A <= 1e-12) { t = Math.min(1, Math.max(0, F / E)); }
  else {
    const C = d1x * rx + d1y * ry + d1z * rz;
    if (E <= 1e-12) s = Math.min(1, Math.max(0, -C / A));
    else {
      const B = d1x * d2x + d1y * d2y + d1z * d2z, den = A * E - B * B;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (B * F - C * E) / den)) : 0;
      t = (B * s + F) / E;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -C / A)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (B - C) / A)); }
    }
  }
  out[0] = s; out[1] = t;
}
/** Distance between segments a–b and c–d seen from above (x/z only). */
function distXZ(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  if (o(ax, az, bx, bz, cx, cz) * o(ax, az, bx, bz, dx, dz) < 0 && o(cx, cz, dx, dz, ax, az) * o(cx, cz, dx, dz, bx, bz) < 0) return 0;
  const pt = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => {
    const ex = rx - qx, ez = rz - qz, L = ex * ex + ez * ez || 1e-12;
    const t = Math.max(0, Math.min(1, ((px - qx) * ex + (pz - qz) * ez) / L));
    return Math.hypot(qx + ex * t - px, qz + ez * t - pz);
  };
  return Math.min(pt(ax, az, cx, cz, dx, dz), pt(bx, bz, cx, cz, dx, dz), pt(cx, cz, ax, az, bx, bz), pt(dx, dz, ax, az, bx, bz));
}

export interface Snapshot { handles: { pos: V3; gone: boolean }[]; ropes: { x: number[]; rest: number; h: [number, number]; group: number; gone: boolean }[] }
export interface Pillar { x: number; z: number; gone: boolean }

export class RopeWorld {
  handles: Handle[];
  ropes: Rope[];
  /** Posts at slot corners: ropes go round them. */
  pillars: Pillar[] = [];
  /** Layer 1 and layer 2 between groups after the last step: group pairs (RopeWorld.key) in contact / overlapping from above. */
  touchPairs = new Set<number>();
  overlapPairs = new Set<number>();
  /** Nothing has moved for a while: steps are skipped until something wakes it. */
  asleep = false;
  /** Counts the steps actually simulated (the view redraws only when it changes). */
  steps = 0;
  private still = 0;
  private tmp = [0, 0];
  private segRope = new Int32Array(0);
  private segBead = new Int32Array(0);
  private cellOf = new Int32Array(0);
  private order = new Int32Array(0);
  private start = new Int32Array(0);
  private fill = new Int32Array(0);
  private x0 = 0; private z0 = 0; private nx = 1; private nz = 1;
  constructor(handles: [number, number][], ropes: RopeInit[], bounds: { x0: number; x1: number; z0: number; z1: number }) {
    this.handles = handles.map(([x, z]) => new Handle(x, z));
    this.ropes = ropes.map((r) => new Rope(r, this.handles));
    this.setBounds(bounds);
  }
  setBounds(b: { x0: number; x1: number; z0: number; z1: number }): void {
    this.x0 = b.x0 - 4; this.z0 = b.z0 - 4;
    this.nx = Math.ceil((b.x1 - b.x0 + 8) / CELL) + 1;
    this.nz = Math.ceil((b.z1 - b.z0 + 8) / CELL) + 1;
    this.start = new Int32Array(this.nx * this.nz + 1);
  }
  /** A handle and ropes added while playing (a trapdoor opening). Returns the new indices. */
  addHandle(x: number, z: number, cells: [number, number][] = [[0, 0]]): number { const h = new Handle(x, z); h.cells = cells; this.handles.push(h); this.wake(); return this.handles.length - 1; }
  addRope(init: RopeInit): number { this.ropes.push(new Rope(init, this.handles)); this.wake(); return this.ropes.length - 1; }
  /** A pair of groups as one number (for touchPairs / overlapPairs). */
  static key(a: number, b: number): number { return a < b ? a * 4096 + b : b * 4096 + a; }

  wake(): void { this.asleep = false; this.still = 0; }
  /** Put handle k at a point (the board moves handles; the substeps carry the rope ends along smoothly). */
  place(k: number, x: number, y: number, z: number): void {
    const p = this.handles[k].pos;
    if (Math.abs(p[0] - x) + Math.abs(p[1] - y) + Math.abs(p[2] - z) > 1e-7) this.wake();
    p[0] = x; p[1] = y; p[2] = z;
  }

  /** Push every bead of the ropes not on handle k out to `dist` from it (seen from above), keeping its height. */
  pushAway(k: number, dist: number): void {
    const c = this.handles[k].pos;
    for (const r of this.ropes) {
      if (r.gone || r.h[0] === k || r.h[1] === k) continue;
      for (let q = 0; q < r.n; q++) {
        if ((q === 0 && r.h[0] >= 0) || (q === r.n - 1 && r.h[1] >= 0)) continue;
        const i = q * 3, dx = r.x[i] - c[0], dz = r.x[i + 2] - c[2], d = Math.hypot(dx, dz);
        if (d >= dist) continue;
        const ux = d > 1e-6 ? dx / d : 1, uz = d > 1e-6 ? dz / d : 0;
        r.x[i] = c[0] + ux * dist; r.x[i + 2] = c[2] + uz * dist;
        r.p[i] = r.x[i]; r.p[i + 2] = r.x[i + 2];
      }
    }
    this.wake();
  }
  /** A hammer blow at (x, z): beads within `range` jump up at vMin..vMax (units/s). */
  impulse(x: number, z: number, range: number, vMin: number, vMax: number, rnd: () => number): void {
    const h = CFG.fixedDeltaTime / SUB;
    for (const r of this.ropes) {
      if (r.gone) continue;
      for (let q = 1; q < r.n - 1; q++) {
        const i = q * 3;
        if (Math.hypot(r.x[i] - x, r.x[i + 2] - z) < range) r.p[i + 1] = r.x[i + 1] - (vMin + (vMax - vMin) * rnd()) * h;
      }
    }
    this.wake();
  }
  /** Cut rope i at bead q: it becomes two ropes, each hanging from one handle by a loose end. Returns their indices. */
  cut(i: number, q: number): [number, number] {
    const r = this.ropes[i];
    r.gone = true;
    const half = (from: number, to: number, h: number, atStart: boolean): number => {
      const pts = Array.from(r.x.subarray(from * 3, (to + 1) * 3));
      const o = new Rope({ a: Math.max(0, h), b: Math.max(0, h), rest: (r.rest * (to - from)) / (r.n - 1), group: r.group, pts }, this.handles);
      o.h = atStart ? [h, -1] : [-1, h];
      this.ropes.push(o);
      return this.ropes.length - 1;
    };
    const a = half(0, q, r.h[0], true), b = half(q, r.n - 1, r.h[1], false);
    this.wake();
    return [a, b];
  }

  snapshot(): Snapshot {
    return {
      handles: this.handles.map((h) => ({ pos: [...h.pos] as V3, gone: h.gone })),
      ropes: this.ropes.map((r) => ({ x: Array.from(r.x), rest: r.rest, h: [...r.h] as [number, number], group: r.group, gone: r.gone })),
    };
  }
  load(s: Snapshot): void {
    this.handles = s.handles.map((o) => { const h = new Handle(o.pos[0], o.pos[2]); h.pos = [...o.pos]; h.prev = [...o.pos]; h.gone = o.gone; return h; });
    this.ropes = s.ropes.map((o) => {
      const r = new Rope({ a: Math.max(0, o.h[0]), b: Math.max(0, o.h[1]), rest: o.rest, group: o.group, pts: o.x }, this.handles);
      r.h = [...o.h]; r.gone = o.gone;
      return r;
    });
    this.wake();
  }

  step(dt: number): void {
    if (this.asleep) { for (const h of this.handles) h.prev = [...h.pos]; return; }
    this.steps++;
    const h = Math.min(dt, 1 / 30) / SUB;
    for (let s = 0; s < SUB; s++) this.substep(h, (s + 1) / SUB, s === SUB - 1);
    for (const hd of this.handles) hd.prev = [...hd.pos];
    // fall asleep once every bead has (all but) stopped
    let v = 0;
    for (const r of this.ropes) if (!r.gone) for (let q = 0; q < r.n * 3; q++) v = Math.max(v, Math.abs(r.x[q] - r.p[q]));
    this.still = v < 2e-5 ? this.still + 1 : 0;
    if (this.still > 20) this.asleep = true;
  }

  private end(r: Rope, e: number, f: number): V3 | null {
    const k = r.h[e];
    if (k < 0) return null;
    const hd = this.handles[k], a = hd.prev, b = hd.pos, o = r.off[e];
    return [a[0] + (b[0] - a[0]) * f + o[0], a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f + o[1]];
  }
  private pinEnds(r: Rope, f: number): void {
    for (const e of [0, 1]) {
      const pn = this.end(r, e, f);
      if (!pn) continue;
      const i = e ? (r.n - 1) * 3 : 0;
      r.x[i] = pn[0]; r.x[i + 1] = pn[1]; r.x[i + 2] = pn[2];
      r.p[i] = pn[0]; r.p[i + 1] = pn[1]; r.p[i + 2] = pn[2];
    }
  }

  private substep(h: number, f: number, last: boolean): void {
    const g = G * h * h;
    for (const r of this.ropes) {
      if (r.gone) continue;
      const x = r.x, p = r.p;
      for (let q = 0; q < r.n; q++) {
        const i = q * 3;
        const vx = (x[i] - p[i]) * DAMP, vy = (x[i + 1] - p[i + 1]) * DAMP, vz = (x[i + 2] - p[i + 2]) * DAMP;
        p[i] = x[i]; p[i + 1] = x[i + 1]; p[i + 2] = x[i + 2];
        x[i] += vx; x[i + 1] += vy - g; x[i + 2] += vz;
      }
      this.pinEnds(r, f);
    }
    if (last) { this.touchPairs.clear(); this.overlapPairs.clear(); for (const r of this.ropes) r.contacts.length = 0; }
    // links (twice: they are cheap) then one pass of collisions and the board
    for (let it = 0; it < ITER; it++) this.links(h, f);
    this.collide(last);
    this.ground();
    // the board holds what lies on it: sideways speed is lost there
    for (const r of this.ropes) {
      if (r.gone) continue;
      const x = r.x, p = r.p;
      for (let q = 0; q < r.n; q++) {
        const i = q * 3;
        if (x[i + 1] > R + 0.01) continue;
        p[i] = x[i] - (x[i] - p[i]) * (1 - FRICTION);
        p[i + 2] = x[i + 2] - (x[i + 2] - p[i + 2]) * (1 - FRICTION);
      }
    }
  }

  /** Every link keeps its share of the rope's length (a little give: XPBD compliance). */
  private links(h: number, f: number): void {
    const a = COMPLIANCE / (h * h);
    for (const r of this.ropes) {
      if (r.gone) continue;
      const x = r.x, L = r.rest / (r.n - 1), n = r.n;
      const w0 = r.h[0] >= 0 ? 0 : 1, w1 = r.h[1] >= 0 ? 0 : 1;
      for (let q = 0; q + 1 < n; q++) {
        const i = q * 3, j = i + 3;
        const dx = x[j] - x[i], dy = x[j + 1] - x[i + 1], dz = x[j + 2] - x[i + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        const wi = q === 0 ? w0 : 1, wj = q + 1 === n - 1 ? w1 : 1;
        if (wi + wj === 0) continue;
        const lam = (d - L) / (wi + wj + a);
        const ux = dx / d, uy = dy / d, uz = dz / d;
        x[i] += ux * lam * wi; x[i + 1] += uy * lam * wi; x[i + 2] += uz * lam * wi;
        x[j] -= ux * lam * wj; x[j + 1] -= uy * lam * wj; x[j + 2] -= uz * lam * wj;
      }
      // stiffness: a bead and the one after next keep apart, so the rope bends in smooth curves, never kinks
      const Lb = L * BEND_MIN;
      for (let q = 0; q + 2 < n; q++) {
        const i = q * 3, j = i + 6;
        const dx = x[j] - x[i], dy = x[j + 1] - x[i + 1], dz = x[j + 2] - x[i + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d >= 2 * L * 0.999 || d < 1e-9) continue;
        const wi = q === 0 ? w0 : 1, wj = q + 2 === n - 1 ? w1 : 1;
        if (wi + wj === 0) continue;
        const lam = d < Lb ? ((d - Lb) / (wi + wj)) * BEND : ((d - 2 * L) / (wi + wj)) * BEND_SOFT;
        const ux = dx / d, uy = dy / d, uz = dz / d;
        x[i] += ux * lam * wi; x[i + 1] += uy * lam * wi; x[i + 2] += uz * lam * wi;
        x[j] -= ux * lam * wj; x[j + 1] -= uy * lam * wj; x[j + 2] -= uz * lam * wj;
      }
      this.pinEnds(r, f);
    }
  }

  /** Nothing below the board; a rope lying across another rope's handle rests on its top. */
  private ground(): void {
    const pins: number[] = [];
    this.handles.forEach((hd, k) => { if (!hd.gone && hd.pos[1] < PIN_TOP + 0.1) for (const c of hd.cells) pins.push(hd.pos[0] + c[0], hd.pos[2] + c[1], k); });
    const posts = this.pillars.filter((p) => !p.gone);
    for (const r of this.ropes) {
      if (r.gone) continue;
      const x = r.x;
      for (let q = 0; q < r.n; q++) {
        if ((q === 0 && r.h[0] >= 0) || (q === r.n - 1 && r.h[1] >= 0)) continue;
        const i = q * 3;
        if (x[i + 1] < R) x[i + 1] = R;
        if (x[i + 1] < PIN_TOP + R) for (let k = 0; k < pins.length; k += 3) {
          if (pins[k + 2] === r.h[0] || pins[k + 2] === r.h[1]) continue;
          const dx = x[i] - pins[k], dz = x[i + 2] - pins[k + 1];
          if (dx * dx + dz * dz < PIN_R * PIN_R * 0.7) x[i + 1] = PIN_TOP + R;
        }
        // pillars: no way through, the rope goes round
        for (const p of posts) {
          const dx = x[i] - p.x, dz = x[i + 2] - p.z, d = Math.hypot(dx, dz), m = PILLAR_R + R;
          if (d < m) { const ux = d > 1e-6 ? dx / d : 1, uz = d > 1e-6 ? dz / d : 0; x[i] = p.x + ux * m; x[i + 2] = p.z + uz * m; }
        }
      }
    }
  }

  /** Ropes never pass through each other: capsule against capsule, on a grid. On the last pass, record contacts. */
  private collide(mark: boolean): void {
    const ropes = this.ropes;
    let ns = 0;
    for (const r of ropes) if (!r.gone) ns += r.n - 1;
    if (this.segRope.length < ns) {
      this.segRope = new Int32Array(ns); this.segBead = new Int32Array(ns);
      this.cellOf = new Int32Array(ns); this.order = new Int32Array(ns);
    }
    const sr = this.segRope, sb = this.segBead, co = this.cellOf, st = this.start, nx = this.nx, nz = this.nz;
    st.fill(0);
    let k = 0;
    ropes.forEach((r, ri) => {
      if (r.gone) return;
      const x = r.x;
      for (let q = 0; q + 1 < r.n; q++) {
        const i = q * 3;
        const cx = Math.min(nx - 1, Math.max(0, Math.floor(((x[i] + x[i + 3]) / 2 - this.x0) / CELL)));
        const cz = Math.min(nz - 1, Math.max(0, Math.floor(((x[i + 2] + x[i + 5]) / 2 - this.z0) / CELL)));
        sr[k] = ri; sb[k] = q; co[k] = cz * nx + cx; st[co[k] + 1]++;
        k++;
      }
    });
    for (let c = 0; c < nx * nz; c++) st[c + 1] += st[c];
    const fill = this.fill.length >= nx * nz ? this.fill : (this.fill = new Int32Array(nx * nz));
    fill.set(st.subarray(0, nx * nz));
    for (let s = 0; s < ns; s++) this.order[fill[co[s]]++] = s;
    const out = this.tmp, D = 2 * R, PD = CFG.particleDistance;
    const M = Math.max(TOUCH, PD);
    for (let s = 0; s < ns; s++) {
      const ra = sr[s], qa = sb[s], A = ropes[ra], xa = A.x, ia = qa * 3;
      const cx = co[s] % nx, cz = (co[s] / nx) | 0;
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const zx = cx + ox, zz = cz + oz;
        if (zx < 0 || zz < 0 || zx >= nx || zz >= nz) continue;
        const c = zz * nx + zx;
        for (let m = st[c]; m < st[c + 1]; m++) {
          const t = this.order[m];
          if (t <= s) continue;
          const rb = sr[t], qb = sb[t];
          if (ra === rb && Math.abs(qa - qb) < 4) continue;
          const B = ropes[rb], xb = B.x, ib = qb * 3;
          if (Math.min(xa[ia], xa[ia + 3]) - M > Math.max(xb[ib], xb[ib + 3]) || Math.min(xb[ib], xb[ib + 3]) - M > Math.max(xa[ia], xa[ia + 3])) continue;
          if (Math.min(xa[ia + 2], xa[ia + 5]) - M > Math.max(xb[ib + 2], xb[ib + 5]) || Math.min(xb[ib + 2], xb[ib + 5]) - M > Math.max(xa[ia + 2], xa[ia + 5])) continue;
          const other = mark && A.group !== B.group;
          // layer 2: overlapping seen from above (whatever the heights)
          if (other && distXZ(xa[ia], xa[ia + 2], xa[ia + 3], xa[ia + 5], xb[ib], xb[ib + 2], xb[ib + 3], xb[ib + 5]) < PD) this.overlapPairs.add(RopeWorld.key(A.group, B.group));
          if (Math.min(xa[ia + 1], xa[ia + 4]) - M > Math.max(xb[ib + 1], xb[ib + 4]) || Math.min(xb[ib + 1], xb[ib + 4]) - M > Math.max(xa[ia + 1], xa[ia + 4])) continue;
          closest(xa, ia, ia + 3, xb, ib, ib + 3, out);
          const u = out[0], v = out[1];
          const px = xa[ia] + (xa[ia + 3] - xa[ia]) * u, py = xa[ia + 1] + (xa[ia + 4] - xa[ia + 1]) * u, pz = xa[ia + 2] + (xa[ia + 5] - xa[ia + 2]) * u;
          const qx = xb[ib] + (xb[ib + 3] - xb[ib]) * v, qy = xb[ib + 1] + (xb[ib + 4] - xb[ib + 1]) * v, qz = xb[ib + 2] + (xb[ib + 5] - xb[ib + 2]) * v;
          let dx = px - qx, dy = py - qy, dz = pz - qz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (other && d2 < TOUCH * TOUCH) {
            // layer 1: a contact, kept on both ropes for their stretch
            this.touchPairs.add(RopeWorld.key(A.group, B.group));
            A.contacts.push({ at: qa + u, x: px, y: py, z: pz });
            B.contacts.push({ at: qb + v, x: qx, y: qy, z: qz });
          }
          if (d2 >= D * D) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-6) { dx = 0; dy = 1; dz = 0; d = 1e-6; } else { dx /= d; dy /= d; dz /= d; }
          const w1 = qa === 0 && A.h[0] >= 0 ? 0 : 1, w2 = qa + 1 === A.n - 1 && A.h[1] >= 0 ? 0 : 1;
          const w3 = qb === 0 && B.h[0] >= 0 ? 0 : 1, w4 = qb + 1 === B.n - 1 && B.h[1] >= 0 ? 0 : 1;
          const a1 = (1 - u) * w1, a2 = u * w2, b1 = (1 - v) * w3, b2 = v * w4;
          const den = a1 * (1 - u) + a2 * u + b1 * (1 - v) + b2 * v;
          if (den < 1e-9) continue;
          const lam = (D - d) / den;
          xa[ia] += dx * lam * a1; xa[ia + 1] += dy * lam * a1; xa[ia + 2] += dz * lam * a1;
          xa[ia + 3] += dx * lam * a2; xa[ia + 4] += dy * lam * a2; xa[ia + 5] += dz * lam * a2;
          xb[ib] -= dx * lam * b1; xb[ib + 1] -= dy * lam * b1; xb[ib + 2] -= dz * lam * b1;
          xb[ib + 3] -= dx * lam * b2; xb[ib + 4] -= dy * lam * b2; xb[ib + 5] -= dz * lam * b2;
          // friction: ropes pressed together slide on each other reluctantly
          for (const [arr, at, w] of [[xa, ia, a1], [xa, ia + 3, a2], [xb, ib, b1], [xb, ib + 3, b2]] as [Float64Array, number, number][]) {
            if (w <= 0) continue;
            const P = arr === xa ? A.p : B.p;
            P[at] = arr[at] - (arr[at] - P[at]) * (1 - ROPE_FRICTION);
            P[at + 2] = arr[at + 2] - (arr[at + 2] - P[at + 2]) * (1 - ROPE_FRICTION);
          }
        }
      }
    }
  }
}
