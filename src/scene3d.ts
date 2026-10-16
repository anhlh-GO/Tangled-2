// The 3D view (three.js): a light board with holes in the level's shape, ring pins
// in them and glossy ropes (dark outline, as in the reference) between the pins.
// Every pair of ropes lies as the rules say (sim.ts `rel`): where they cross, the
// top one arches over the other exactly as high as that one lies there; a hooked
// rope bends to the other rope, goes under it and loops back over it. The game
// drives it with plain calls; this file owns no rules.

import { NONE, OVER, UNDER, WRAP, WRAPPED } from './sim';

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RAW, buildToy, type Toy } from './items3d';

const PIN_R = 0.35;     // pin radius
const PIN_H = 0.2;      // pin height
const R = 0.115;        // rope radius
const H0 = PIN_H + 0.06;   // ropes lie at the height of the pin tops
const LIFT = 0.32;      // a carried pin floats this high (its rope keeps its layer)
const STACK = R * 1.95; // a rope lying on another sits this much higher

interface PinMesh { group: THREE.Group; body: THREE.MeshPhysicalMaterial; top: THREE.MeshStandardMaterial; rim: THREE.MeshBasicMaterial }
interface RopeView { group: THREE.Group; tube: THREE.Mesh | null; line: THREE.Mesh | null; hit: THREE.Mesh | null; caps: THREE.Mesh[]; mat: THREE.MeshPhysicalMaterial; pins: [PinMesh, PinMesh]; color: THREE.Color; mid: THREE.Vector3; segs: number; anim: number; shake: number; flash: number; glow: number; dim: boolean; gone: boolean; ball: THREE.Group | null; bump: [number, number]; mystery?: THREE.Sprite }
/** Where a rope passes over a lower one: at distance sc along it, as high as `peak`, flat for ±half, easing down over `ramp`. */
interface Bump { sc: number; peak: number; half: number; ramp: number }
const DIM = 0.55;   // the rope held by the padlock is drawn this much darker
const HIT_MAT = new THREE.MeshBasicMaterial({ visible: false });

interface Ctrl { x: number; z: number; y: number }
/**
 * A rope's way across the board: a polyline through its pins (and round any hooks)
 * with a height profile — the control heights, lifted over lower ropes by bumps,
 * the ends sinking into the pins. Inside a hook the loop keeps its own heights.
 */
class RopePath {
  readonly cum: number[] = [0];
  readonly len: number;
  bumps: Bump[] = [];
  hookBumps: Bump[] = [];
  /** Where a rope lies on this one: pressed down a little (peak = depth), and darker there (contact shade). */
  dips: Bump[] = [];
  zones: [number, number][] = [];
  constructor(readonly pts: Ctrl[]) {
    for (let k = 1; k < pts.length; k++) this.cum.push(this.cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    this.len = this.cum[pts.length - 1] || 1e-6;
  }
  private seg(s: number): [number, number] {
    let k = 0;
    while (k < this.pts.length - 2 && this.cum[k + 1] < s) k++;
    const L = this.cum[k + 1] - this.cum[k];
    return [k, L > 1e-9 ? Math.min(1, Math.max(0, (s - this.cum[k]) / L)) : 0];
  }
  xz(s: number): [number, number] {
    const [k, u] = this.seg(s), a = this.pts[k], b = this.pts[k + 1];
    return [a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u];
  }
  heightAt(s: number): number {
    const [k, u] = this.seg(s), a = this.pts[k], b = this.pts[k + 1];
    let y = a.y + (b.y - a.y) * u;
    const de = Math.min(s, this.len - s);
    if (de < 0.32) y -= (1 - de / 0.32) ** 2 * 0.16;
    const inZone = this.zones.some(([z0, z1]) => s > z0 && s < z1);
    for (const c of inZone ? [] : [...this.bumps, ...this.hookBumps]) {
      const d = Math.abs(s - c.sc) - c.half;
      const w = d <= 0 ? 1 : d >= c.ramp ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / c.ramp);
      if (w > 0) y = Math.max(y, y + (c.peak - y) * w);
    }
    if (!inZone) for (const c of this.dips) {
      const d = Math.abs(s - c.sc) - c.half;
      if (d < c.ramp) y -= c.peak * (d <= 0 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * d) / c.ramp));
    }
    return y;
  }
  /** 1 = fully lit; less where another rope lies on this one (ambient occlusion by hand). */
  shadeAt(s: number): number {
    let k = 1;
    for (const c of this.dips) { const d = (s - c.sc) / (c.half + 0.22); k -= 0.42 * Math.exp(-d * d * 2.2); }
    return Math.max(0.45, k);
  }
  /** Arc length of the point on the path nearest p. */
  nearest(px: number, pz: number): number {
    let best = 0, bd = Infinity;
    for (let k = 0; k < this.pts.length - 1; k++) {
      const a = this.pts[k], b = this.pts[k + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
      const u = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / L2));
      const d = Math.hypot(a.x + dx * u - px, a.z + dz * u - pz);
      if (d < bd) { bd = d; best = this.cum[k] + u * Math.sqrt(L2); }
    }
    return best;
  }
  /** The centre line in 3D, smoothed (sampled every `step`). */
  curve(step: number): THREE.CatmullRomCurve3 {
    const n = Math.max(2, Math.ceil(this.len / step));
    const ps: THREE.Vector3[] = [];
    for (let q = 0; q <= n; q++) { const s = (q / n) * this.len, [x, z] = this.xz(s); ps.push(new THREE.Vector3(x, this.heightAt(s), z)); }
    // round off the corners (hooks, bumps), keeping the ends on the pins
    for (let pass = 0; pass < 3; pass++) {
      const src = ps.map((p) => p.clone());
      for (let q = 2; q < ps.length - 2; q++) ps[q].copy(src[q - 1]).add(src[q]).add(src[q + 1]).multiplyScalar(1 / 3);
    }
    return new THREE.CatmullRomCurve3(ps, false, 'centripetal');
  }
}
/** Where two polylines cross: arc lengths along each and the sine of the angle. */
function crossings(p: RopePath, q: RopePath): { s: number; t: number; sin: number }[] {
  const out: { s: number; t: number; sin: number }[] = [];
  for (let a = 0; a < p.pts.length - 1; a++) for (let b = 0; b < q.pts.length - 1; b++) {
    const A = p.pts[a], B = p.pts[a + 1], C = q.pts[b], D = q.pts[b + 1];
    const rx = B.x - A.x, rz = B.z - A.z, sx = D.x - C.x, sz = D.z - C.z;
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-9) continue;
    const u = ((C.x - A.x) * sz - (C.z - A.z) * sx) / den, v = ((C.x - A.x) * rz - (C.z - A.z) * rx) / den;
    if (u <= 0 || u >= 1 || v <= 0 || v >= 1) continue;
    const lr = Math.hypot(rx, rz), ls = Math.hypot(sx, sz);
    out.push({ s: p.cum[a] + u * lr, t: q.cum[b] + v * ls, sin: Math.abs(den) / (lr * ls) });
  }
  return out;
}

/** A pin as in the reference: a fat glossy button in the rope's colour, a darker dished top, a dark rim. */
function pinMesh(color: THREE.Color): PinMesh {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(PIN_R, 0)];
  for (let k = 0; k <= 8; k++) { const a = (k / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(PIN_R - 0.07 + Math.cos(a) * 0.07, PIN_H - 0.07 + Math.sin(a) * 0.07)); }
  pts.push(new THREE.Vector2(0, PIN_H));
  const body = new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), body);
  m.castShadow = true;
  const rim = new THREE.MeshBasicMaterial({ color: 0x16161e, side: THREE.BackSide });
  const out = new THREE.Mesh(m.geometry, rim);
  out.scale.set(1.07, 1.02, 1.07);
  const top = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.62), roughness: 0.45 });
  const dish = new THREE.Mesh(new THREE.CircleGeometry(PIN_R * 0.58, 32), top);
  dish.rotation.x = -Math.PI / 2;
  dish.position.y = PIN_H + 0.002;
  g.add(m, out, dish);
  return { group: g, body, top, rim };
}

function mysteryTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill();
  g.lineWidth = 5; g.strokeStyle = '#6d6880'; g.stroke();
  g.fillStyle = '#6d6880';
  g.font = 'bold 44px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('?', 32, 35);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const GOLD = () => new THREE.MeshStandardMaterial({ color: 0xffc23a, roughness: 0.28, metalness: 0.55 });
/** A chunky cartoon padlock, keyhole on the front. */
function padlock(): { group: THREE.Group; shackle: THREE.Mesh } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.34, 0.18, 4, 0.06), GOLD());
  const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.042, 12, 24, Math.PI), new THREE.MeshStandardMaterial({ color: 0xd9dde6, roughness: 0.25, metalness: 0.8 }));
  shackle.position.y = 0.16;
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16), new THREE.MeshStandardMaterial({ color: 0x3a2508 }));
  hole.rotation.x = Math.PI / 2;
  hole.position.set(0, 0.02, 0.092);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.02), hole.material);
  slot.position.set(0, -0.04, 0.092);
  g.add(body, shackle, hole, slot);
  g.traverse((o) => { o.castShadow = true; });
  return { group: g, shackle };
}
/** A gold key lying on its strand. */
function keyMesh(): THREE.Group {
  const g = new THREE.Group();
  const m = GOLD();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.032, 10, 20), m);
  ring.position.x = -0.17;
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.05), m);
  shaft.position.x = 0.03;
  const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.05), m);
  t1.position.set(0.12, -0.05, 0);
  const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.05), m);
  t2.position.set(0.06, -0.04, 0);
  g.add(ring, shaft, t1, t2);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

const RADIAL = 16;
/**
 * A real twisted rope: a tube whose surface bulges into three helical plies with deep
 * grooves between them (geometry, not just a texture), grooves darkened by vertex colour.
 */
function ropeGeometry(curve: THREE.Curve<THREE.Vector3>, segs: number, r: number, closed = false, len = curve.getLength(), ply = 0.2, shade = 0.42, ao?: (u: number) => number): THREE.TubeGeometry {
  const geo = new THREE.TubeGeometry(curve, segs, r, RADIAL, closed);
  const pos = geo.attributes.position as THREE.BufferAttribute, uv = geo.attributes.uv as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  const PITCH = 0.62;   // one full turn of a ply along the rope
  for (let k = 0; k < pos.count; k++) {
    const u = uv.getX(k), th = uv.getY(k) * Math.PI * 2;
    curve.getPointAt(Math.min(1, u), c);
    v.fromBufferAttribute(pos, k).sub(c);
    const ph = 3 * th - (3 * Math.PI * 2 * u * len) / PITCH;
    const w = Math.cos(ph);
    const bulge = 1 + ply * (Math.sqrt(Math.max(0, w * 0.5 + 0.5)) - 0.55);
    v.multiplyScalar(bulge).add(c);
    pos.setXYZ(k, v.x, v.y, v.z);
    const shadeV = shade + (1 - shade) * Math.pow(Math.max(0, w * 0.5 + 0.5), 0.55);
    col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = shadeV * (ao ? ao(u) : 1);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}
/** Rich, glossy rope colour (as in the reference): a touch more saturated and deeper than the flat yarn colour. */
function ropeColor(c: THREE.Color): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.12), hsl.l * 0.95);
}
/** Glossy smooth rope with faint twist lines (the reference). */
function ropeMaterial(color: THREE.Color): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({ color: ropeColor(color), vertexColors: true, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.12 });
}
const LINE_MAT = new THREE.MeshBasicMaterial({ color: 0x16161e, side: THREE.BackSide });
const LINE_RADIAL = 10;
/** The thin dark rim drawn round each peg ring, so stacked rings read as separate layers. */
function outlineMaterial(color: THREE.Color): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: ropeColor(color).multiplyScalar(0.28), side: THREE.BackSide });
}
/** A wound ball of rope: a core with strands wrapped round it every which way. */
let fiberTex: THREE.CanvasTexture | null = null;
/** Soft wool: fine fibres running along the strand, a little fuzz — so the yarn reads as cloth, not plastic. */
function fiberTexture(): THREE.CanvasTexture {
  if (fiberTex) return fiberTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 64);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 420; k++) {
    const x = rnd() * 128, y = rnd() * 64, len = 6 + rnd() * 18;
    g.strokeStyle = rnd() < 0.55 ? `rgba(0,0,0,${0.05 + rnd() * 0.1})` : `rgba(255,255,255,${0.25 + rnd() * 0.3})`;
    g.lineWidth = 0.6 + rnd() * 0.9;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + len / 2, y + (rnd() - 0.5) * 3, x + len, y + (rnd() - 0.5) * 2); g.stroke();
  }
  fiberTex = new THREE.CanvasTexture(c);
  fiberTex.wrapS = fiberTex.wrapT = THREE.RepeatWrapping;
  fiberTex.colorSpace = THREE.SRGBColorSpace;
  return fiberTex;
}
/** Matte wool with a soft velvety sheen (used for the balls of yarn). */
const BALL_LIGHT = [2.9, 3.6];
function woolMaterial(color: THREE.Color, rep = 3, raw = false): THREE.MeshPhysicalMaterial {
  const map = fiberTexture().clone();
  map.needsUpdate = true;
  map.repeat.set(rep, 1);
  // raw (the basket picture): the strand's own colour, a touch richer, with only a faint sheen so it stays deep
  let c = ropeColor(color);
  if (raw) { const h = { h: 0, s: 0, l: 0 }; color.getHSL(h); c = new THREE.Color().setHSL(h.h, Math.min(1, h.s * 1.15), h.l); }
  return new THREE.MeshPhysicalMaterial({ color: c, map, vertexColors: true, roughness: 0.85, metalness: 0, sheen: raw ? 0.6 : 1, sheenRoughness: 0.6, sheenColor: c.clone().lerp(new THREE.Color(0xffffff), raw ? 0.2 : 0.55) });
}
/** A ball of wool: a soft core wound round with many thin strands every which way, and a loose end. */
export function ropeBall(color: THREE.Color, r = 0.3, raw = false): THREE.Group {
  const g = new THREE.Group();
  const coreG = new THREE.SphereGeometry(r * 0.9, 28, 20);
  coreG.setAttribute('color', new THREE.BufferAttribute(new Float32Array(coreG.attributes.position.count * 3).fill(0.82), 3));
  g.add(new THREE.Mesh(coreG, woolMaterial(color, 6, raw)));
  const strand = woolMaterial(color, 10, raw);
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 24; k++) {
    const ring = new THREE.Mesh(ropeGeometry(new CircleCurve(r * (0.92 + rnd() * 0.06)), 48, r * 0.088, true), strand);
    ring.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
    g.add(ring);
  }
  // the loose end trailing off the ball
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3(r * 0.2, r * 0.9, r * 0.35), new THREE.Vector3(r * 0.6, r * 0.75, r * 0.65),
    new THREE.Vector3(r * 0.95, r * 0.35, r * 0.7), new THREE.Vector3(r * 1.25, -r * 0.15, r * 0.5),
  ]);
  g.add(new THREE.Mesh(ropeGeometry(tail, 24, r * 0.07), strand));
  g.traverse((o) => { o.castShadow = true; });
  return g;
}
class CircleCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private r: number, private y = 0) { super(); }
  getPoint(t: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.cos(t * Math.PI * 2) * this.r, this.y, Math.sin(t * Math.PI * 2) * this.r);
  }
}
const COIL = 0.42;   // a pulled rope winds itself up into a ball

export class Scene3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(20, 1, 0.1, 400);
  private board = new THREE.Group();
  private ropes: RopeView[] = [];
  private balls = new Map<string, HTMLCanvasElement>();
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private fit: THREE.Vector3[] = [];
  private target = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private sun = new THREE.DirectionalLight(0xffffff, 2.1);

  /** Board zoom (1 = whole board fits) and pan (world units on the board plane), eased toward their targets. */
  private zoom = { cur: 1, to: 1, px: 0, pz: 0, tx: 0, tz: 0, w: 6, d: 7 };
  static readonly ZOOM_MIN = 1;
  static readonly ZOOM_MAX = 2;
  private frameOut = 0;
  /** Screen position of the board's far frame edge (unzoomed), filled each frame. */
  boardTop: { x0: number; x1: number; y: number } | null = null;
  private lockFx: { pad: THREE.Group; shackle: THREE.Mesh; key: THREE.Group | null; keyRope: number; keyHome: THREE.Vector3; at: THREE.Vector3; t: number; open: boolean; shake: number; strands: number[] } | null = null;
  private mysteryTex = mysteryTexture();
  private holeXY: THREE.Vector3[] = [];
  private layers: number[] = [];
  private paths: (RopePath | null)[] = [];
  private rel = new Int8Array(0);
  private shift = { x: 0, y: 0 };
  /** While a pin is carried: how its rope would lie against every other rope with the pin at board point p. */
  private dragRule: ((k: number, p: [number, number]) => Int8Array) | null = null;
  private bounds = { x0: -2, x1: 2, z0: -2, z1: 2 };
  private dragAt = new THREE.Vector3(1e9, 0, 0);
  private ends: number[] = [];
  private holeMeshes: THREE.Mesh[] = [];
  private emptyNow = new Set<number>();
  private selected = -1;
  private drag: { k: number; p: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3 | null; t: number; dur?: number; done: (() => void) | null } | null = null;
  // the toy being knitted
  private toyScene = new THREE.Scene();
  private toyCam = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  private toy: Toy | null = null;
  private toyIndex = -1;
  private toyView = { x: 0, y: 0, w: 1, h: 1 };
  /** Knitting progress per part: a coloured copy revealed bottom-up to `level` (0..1) by a clipping plane. */
  private knits = new Map<number, { level: number; from: number; to: number; t: number; dur: number; color: THREE.Color; plane: THREE.Plane; overlays: THREE.Mesh[]; y0: number; y1: number }>();
  private tints: THREE.Color[] = [];
  private toyPop = 0;
  /** The round display stand under the toy (white top, glowing blue band, orange studs), sized per toy. */
  private pedestal = new THREE.Group();
  private buildPedestal(R: number): void {
    const p = this.pedestal;
    p.clear();
    const m = (color: number, rough = 0.35, emissive = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, emissive: emissive ? new THREE.Color(emissive) : undefined, emissiveIntensity: emissive ? 1.1 : 0 });
    const cyl = (r0: number, r1: number, h: number, y: number, mat: THREE.Material) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, 48), mat);
      c.position.y = y;
      c.receiveShadow = true;
      c.castShadow = true;
      p.add(c);
      return c;
    };
    cyl(R, R, 0.1 * R, -0.05 * R, m(0xf4f7fb, 0.4));                    // top plate
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.8, R * 0.015, 8, 64), m(0xc9d3e1, 0.5));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.002;
    p.add(ring);
    cyl(R * 1.02, R * 1.02, 0.07 * R, -0.135 * R, m(0x7fe0ff, 0.3, 0x2ab8ff)); // glowing band
    cyl(R * 1.06, R * 1.16, 0.2 * R, -0.27 * R, m(0xdde5f0, 0.45));        // body
    cyl(R * 1.2, R * 1.24, 0.12 * R, -0.43 * R, m(0x2e78e6, 0.35));        // blue base
    for (const a of [0.65, -0.65, Math.PI - 0.65, Math.PI + 0.65]) {
      const stud = new THREE.Mesh(new THREE.BoxGeometry(R * 0.16, R * 0.1, R * 0.06), m(0xff9a3c, 0.4));
      stud.position.set(Math.sin(a) * R * 1.12, -0.27 * R, Math.cos(a) * R * 1.12);
      stud.rotation.y = a;
      p.add(stud);
    }
  }
  /** Level-clear showcase: k = how far in (0..1), spin = extra turn of the toy (radians). */
  private show = { k: 0, spin: 0 };
  private veil: { scene: THREE.Scene; cam: THREE.OrthographicCamera; mat: THREE.MeshBasicMaterial; rays: THREE.Mesh } | null = null;
  private thumbs = new Map<number, HTMLCanvasElement>();
  private clock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb08a68, 1.7));
    const sun = this.sun;
    sun.position.set(-5, 12, 3);   // light from the left: peg shadows fall to the right, as in the reference
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
    sun.shadow.radius = 3;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
    this.scene.add(this.board);
    this.toyScene.add(new THREE.HemisphereLight(0xffffff, 0x9bb7d8, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 6, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 });
    key.shadow.radius = 6;
    this.toyScene.add(key);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(2.2, 40), new THREE.ShadowMaterial({ opacity: 0.18 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.visible = true;
    this.toyScene.add(ground);
    this.toyScene.add(this.pedestal);
  }

  // ------------------------------------------------------------ the toy

  setToy(i: number): void {
    if (this.toy) this.toyScene.remove(this.toy.group);
    this.toy = buildToy(i);
    this.toyIndex = i;
    this.toyScene.add(this.toy.group);
    this.knits.clear();
    this.tints = this.toy.parts.map(() => new THREE.Color(RAW));
    const sz = new THREE.Box3().setFromObject(this.toy.group).getSize(new THREE.Vector3());
    void sz;   // (no display stand in this layout)
    this.fitToy(this.toyCam, this.toy.group);
  }
  private fitToy(cam: THREE.PerspectiveCamera, g: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(g);
    if (g === this.toy?.group) box.expandByObject(this.pedestal);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const d = sphere.radius / Math.sin((cam.fov * Math.PI) / 360) * (g === this.toy?.group ? 0.7 : 0.8);
    cam.position.set(0, sphere.center.y + d * 0.42, d * 0.92);
    cam.lookAt(0, sphere.center.y * 0.92, 0);
  }
  /** Each part's design group, size (surface area) and height — the game plans the colours from these. */
  partInfo(): { c: number; area: number; y: number }[] {
    if (!this.toy) return [];
    this.toy.group.updateMatrixWorld(true);
    return this.toy.parts.map((p) => {
      let area = 0, y = Infinity;
      for (const m of p.meshes) {
        const b = new THREE.Box3().setFromObject(m), sz = b.getSize(new THREE.Vector3());
        area += 2 * (sz.x * sz.y + sz.y * sz.z + sz.z * sz.x);
        y = Math.min(y, b.min.y);
      }
      return { c: p.c, area, y };
    });
  }
  /** Unknitted parts show a pale hint of the colour they will get. */
  setTints(colors: (string | null)[], amount = 0.22): void {
    if (!this.toy) return;
    this.tints = this.toy.parts.map((_, k) => new THREE.Color(RAW).lerp(new THREE.Color(colors[k] ?? RAW), colors[k] ? amount : 0));
    this.toy.parts.forEach((p, k) => { if (!this.knits.has(k)) for (const m of p.meshes) (m.material as THREE.MeshStandardMaterial).color.copy(this.tints[k]); });
  }

  /**
   * Knit part `k` up to `to` (0..1 of its height) in `color`: a coloured copy of the
   * part is revealed from the bottom up, as if the yarn were being stitched on.
   * A part can take several knits; `now` = straight away (undo, restarts).
   */
  knitPart(k: number, color: string, to: number, now = false, dur = 0.9): void {
    const p = this.toy?.parts[k];
    if (!p) return;
    let st = this.knits.get(k);
    if (!st) {
      this.toy!.group.updateMatrixWorld(true);
      const box = new THREE.Box3();
      for (const m of p.meshes) box.expandByObject(m);
      const y0 = box.min.y - 0.01, y1 = box.max.y + 0.01;
      const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), y0);
      const c = new THREE.Color(color);
      const overlays = p.meshes.map((m) => {
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.color.copy(c);
        mat.clippingPlanes = [plane];
        const o = new THREE.Mesh(m.geometry, mat);
        o.position.copy(m.position);
        o.rotation.copy(m.rotation);
        o.scale.copy(m.scale).multiplyScalar(1.015);
        o.castShadow = true;
        m.parent!.add(o);
        return o;
      });
      st = { level: 0, from: 0, to: 0, t: 1, dur, color: c, plane, overlays, y0, y1 };
      this.knits.set(k, st);
    }
    st.from = st.level;
    st.to = Math.min(1, Math.max(st.to, to));
    st.t = now ? 1 : 0;
    st.dur = dur;
    if (now) this.applyKnit(k);
  }
  private applyKnit(k: number): void {
    const st = this.knits.get(k), p = this.toy?.parts[k];
    if (!st || !p) return;
    st.level = st.from + (st.to - st.from) * st.t;
    st.plane.constant = st.y0 + (st.y1 - st.y0) * st.level;
    if (st.level >= 0.999) {
      // done: the part itself takes the colour, the stitching copy goes
      for (const m of p.meshes) (m.material as THREE.MeshStandardMaterial).color.copy(st.color);
      for (const o of st.overlays) o.parent?.remove(o);
      st.overlays = [];
    }
  }
  /** Where on the page the stitching of part `k` is happening right now (css px). */
  stitchPoint(k: number): { x: number; y: number } | null {
    const p = this.toy?.parts[k];
    if (!p) return null;
    this.toy!.group.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const m of p.meshes) box.expandByObject(m);
    const f = this.knits.get(k);
    const c = box.getCenter(new THREE.Vector3());
    if (f) c.y = f.y0 + (f.y1 - f.y0) * Math.max(0, f.level);
    // wiggle across the part like a needle going back and forth
    const sz = box.getSize(new THREE.Vector3());
    c.x += Math.sin(this.clock * 14) * sz.x * 0.3;
    const q = c.project(this.toyCam);
    return { x: this.toyView.x + ((q.x + 1) / 2) * this.toyView.w, y: this.toyView.y + ((1 - q.y) / 2) * this.toyView.h };
  }
  /** Back to plain yarn (undo). */
  resetToy(): void {
    for (const f of this.knits.values()) for (const o of f.overlays) o.parent?.remove(o);
    this.knits.clear();
    this.toy?.parts.forEach((p, k) => { for (const m of p.meshes) { (m.material as THREE.MeshStandardMaterial).color.copy(this.tints[k] ?? new THREE.Color(RAW)); m.scale.setScalar(1); } });
  }
  toyCenter(): { x: number; y: number } {
    return { x: this.toyView.x + this.toyView.w / 2, y: this.toyView.y + this.toyView.h * 0.5 };
  }
  setToyView(x: number, y: number, w: number, h: number): void {
    this.toyView = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    this.toyCam.aspect = this.toyView.w / this.toyView.h;
    this.toyCam.updateProjectionMatrix();
  }

  /** A 3D wound rope ball in `color`, rendered once into a square picture (the 2D basket uses it). */
  ballSprite(color: string, px = 128): HTMLCanvasElement {
    const key = color + px;
    const hit = this.balls.get(key);
    if (hit) return hit;
    const scene = new THREE.Scene();
    // lit brighter than the board, so the ball in the basket reads as the same colour as its strand
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8a890, BALL_LIGHT[0]));
    const l = new THREE.DirectionalLight(0xffffff, BALL_LIGHT[1]);
    l.position.set(-2, 4, 5);
    scene.add(l);
    const ball = ropeBall(new THREE.Color(color), 1, true);
    ball.rotation.set(0.5, 0.3, 0.2);
    scene.add(ball);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    cam.position.set(0, 0, 4.6);
    cam.lookAt(0, 0, 0);
    const c = this.renderOff(scene, cam, px);
    this.balls.set(key, c);
    return c;
  }
  private renderOff(scene: THREE.Scene, cam: THREE.Camera, px: number): HTMLCanvasElement {
    const rt = new THREE.WebGLRenderTarget(px, px, { samples: 4 });
    const r = this.renderer;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(rt);
    r.clear();
    r.render(scene, cam);
    const buf = new Uint8Array(px * px * 4);
    r.readRenderTargetPixels(rt, 0, 0, px, px, buf);
    r.setRenderTarget(null);
    rt.dispose();
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d')!;
    const img = g.createImageData(px, px);
    for (let y = 0; y < px; y++) img.data.set(buf.subarray((px - 1 - y) * px * 4, (px - y) * px * 4), y * px * 4);
    // render targets are linear: convert to screen colours (un-premultiplied alpha stays as is)
    for (let k = 0; k < img.data.length; k += 4) for (let ch = 0; ch < 3; ch++) img.data[k + ch] = Math.min(255, Math.round(255 * Math.pow(img.data[k + ch] / 255, 1 / 2.2)));
    g.putImageData(img, 0, 0);
    return c;
  }

  /** A grey picture of toy `i` (top bar: what comes next). */
  thumb(i: number, px: number): HTMLCanvasElement {
    const key = i * 1000 + px;
    const hit = this.thumbs.get(key);
    if (hit) return hit;
    const toy = buildToy(i);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 2.2));
    const l = new THREE.DirectionalLight(0xffffff, 1.6);
    l.position.set(3, 5, 4);
    scene.add(l);
    for (const p of toy.parts) for (const m of p.meshes) (m.material as THREE.MeshStandardMaterial).color.set('#9a9aa6');
    toy.group.rotation.y = -0.62;
    scene.add(toy.group);
    const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    this.fitToy(cam, toy.group);
    const rt = new THREE.WebGLRenderTarget(px, px);
    const r = this.renderer;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(rt);
    r.clear();
    r.render(scene, cam);
    const buf = new Uint8Array(px * px * 4);
    r.readRenderTargetPixels(rt, 0, 0, px, px, buf);
    r.setRenderTarget(null);
    rt.dispose();
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d')!;
    const img = g.createImageData(px, px);
    for (let y = 0; y < px; y++) img.data.set(buf.subarray((px - 1 - y) * px * 4, (px - y) * px * 4), y * px * 4);
    // render targets are linear: brighten a touch to read like the screen
    for (let k = 0; k < img.data.length; k += 4) for (let ch = 0; ch < 3; ch++) img.data[k + ch] = Math.min(255, Math.round(255 * Math.pow(img.data[k + ch] / 255, 1 / 2.2)));
    g.putImageData(img, 0, 0);
    this.thumbs.set(key, c);
    return c;
  }

  holePos(h: number, y = 0): THREE.Vector3 {
    const p = this.holeXY[h];
    return new THREE.Vector3(p.x, y, p.z);
  }
  /** Where pin k is drawn right now (the dragged one follows the finger). */
  private pinPos(k: number): THREE.Vector3 {
    if (this.drag && this.drag.k === k) return this.drag.p.clone();
    return this.holePos(this.ends[k]);
  }

  /**
   * Build the board: `holes` (board units, y down), rope r between holes ends[2r] and ends[2r+1]
   * stacked at its `layer`, `colors[r]` its colour (grey when hidden), the padlocked hole and the key rope.
   */
  build(holes: [number, number][], ends: number[], ropes: { key?: boolean; layer: number }[], colors: string[], lock = -1, mystery: boolean[] = [], gone: boolean[] = [], rel?: Int8Array): void {
    // centre the shape on the board
    const xs = holes.map((h) => h[0]), ys = holes.map((h) => h[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    this.holeXY = holes.map(([x, y]) => new THREE.Vector3(x - cx, 0, y - cy));
    this.bounds = { x0: Math.min(...xs) - cx, x1: Math.max(...xs) - cx, z0: Math.min(...ys) - cy, z1: Math.max(...ys) - cy };
    this.layers = ropes.map((r) => r.layer);
    this.paths = [];
    this.shift = { x: cx, y: cy };
    this.rel = rel ? rel.slice() : new Int8Array(ropes.length * ropes.length);
    this.ends = ends.slice();
    this.board.clear();
    this.ropes = [];
    this.lockFx = null;
    this.drag = null;
    this.selected = -1;
    Object.assign(this.zoom, { cur: 1, to: 1, px: 0, pz: 0, tx: 0, tz: 0 });
    const S = Math.max(4, this.bounds.x1 - this.bounds.x0 + 1.6), D = Math.max(4, this.bounds.z1 - this.bounds.z0 + 1.6);
    this.zoom.w = S; this.zoom.d = D;
    // a shadow box just round the board: crisp shadows where ropes lie on ropes
    const ext = Math.max(S, D) / 2 + 1.2;
    Object.assign(this.sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 40 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.radius = 2.5;
    // the cream board of the reference, a soft rounded slab
    const topMat = new THREE.MeshStandardMaterial({ color: 0xededf3, roughness: 0.85 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xd4d4dc, roughness: 0.8 });
    const slab = new THREE.Mesh(new RoundedBoxGeometry(S, 0.34, D, 6, 0.24), [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
    slab.position.y = -0.17;
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.board.add(slab);
    // holes: a beige dish with a pale lip (they light up while a pin is carried)
    this.holeMeshes = [];
    const dish = new THREE.CircleGeometry(PIN_R * 1.24, 40), lipG = new THREE.RingGeometry(PIN_R * 1.24, PIN_R * 1.38, 40);
    const lipMat = new THREE.MeshStandardMaterial({ color: 0xd2d2da, roughness: 0.85 });
    for (let h = 0; h < holes.length; h++) {
      const at = this.holePos(h);
      const m = new THREE.Mesh(dish, new THREE.MeshStandardMaterial({ color: 0xdcdce2, roughness: 0.9, emissive: new THREE.Color(0x7cff6a), emissiveIntensity: 0 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(at.x, 0.004, at.z);
      m.receiveShadow = true;
      const lip = new THREE.Mesh(lipG, lipMat);
      lip.rotation.x = -Math.PI / 2;
      lip.position.set(at.x, 0.003, at.z);
      this.board.add(m, lip);
      this.holeMeshes.push(m);
    }
    colors.forEach((col, i) => {
      const color = new THREE.Color(col);
      const mat = ropeMaterial(color);
      const group = new THREE.Group();
      const pins = [0, 1].map(() => {
        const p = pinMesh(color);
        group.add(p.group);
        return p;
      }) as [PinMesh, PinMesh];
      this.board.add(group);
      const view: RopeView = { group, tube: null, line: null, hit: null, caps: [], mat, pins, color, mid: new THREE.Vector3(), segs: 1, anim: 0, shake: 0, flash: 0, glow: 0, dim: false, gone: !!gone[i], ball: null, bump: [0, 0] };
      if (mystery[i]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.mysteryTex, depthTest: false }));
        sp.scale.setScalar(0.42);
        sp.renderOrder = 5;
        group.add(sp);
        view.mystery = sp;
      }
      if (view.gone) group.visible = false;
      this.ropes.push(view);
    });
    // lock & key: a padlock over the locked pin, a key floating over the rope that opens it
    if (lock >= 0) {
      const { group: pad, shackle } = padlock();
      const at = this.holePos(lock, PIN_H + 0.62);
      pad.position.copy(at);
      pad.scale.setScalar(1.7);
      pad.rotation.x = -0.35;
      this.board.add(pad);
      let key: THREE.Group | null = null;
      const ki = ropes.findIndex((t) => t.key);
      if (ki >= 0) {
        key = keyMesh();
        key.scale.setScalar(1.7);
        key.rotation.x = -0.6;
        this.board.add(key);
      }
      const held = ropes.map((_, k) => k).filter((k) => ends[2 * k] === lock || ends[2 * k + 1] === lock);
      for (const k of held) this.ropes[k].dim = true;
      this.lockFx = { pad, shackle, key, keyRope: ki, keyHome: new THREE.Vector3(), at, t: 0, open: false, shake: 0, strands: held };
    }
    this.rebuild();
    for (const k of this.lockFx?.strands ?? []) this.tint(k);
    // what must be on screen: the board's rim
    this.fit = [];
    this.frameOut = 0;
    for (const x of [-S / 2, S / 2]) this.fit.push(new THREE.Vector3(x, 0, -D / 2), new THREE.Vector3(x, -0.34, D / 2));
    if (lock >= 0) this.fit.push(this.holePos(lock, PIN_H + 1.1));
    this.target.set(0, 0, 0);
  }

  /**
   * Lay every rope as the rules say (`rel`): paths first (straight, or bent round hooks),
   * then heights — a few passes, each rope on top lifted over what it lies on there —
   * then the tubes (`fast` = coarse, while a pin is carried).
   */
  private rebuild(fast = false): void {
    const n = this.ropes.length;
    const rel = this.rel.slice();
    const d = this.drag;
    if (d && this.dragRule) {
      const row = this.dragRule(d.k, [d.p.x + this.shift.x, d.p.z + this.shift.y]);
      const i = d.k >> 1, M = [NONE, UNDER, OVER, WRAPPED, WRAP];
      for (let j = 0; j < n; j++) if (j !== i) { rel[i * n + j] = row[j]; rel[j * n + i] = M[row[j]]; }
    }
    const R2 = (i: number, j: number) => rel[i * n + j];
    const live = (i: number) => !(this.ropes[i].gone && this.ropes[i].anim >= 1);
    const chord = (i: number) => { const a = this.pinPos(2 * i), b = this.pinPos(2 * i + 1); return { a, b }; };
    // 1. paths: pin → (hooks, in order along the rope) → pin
    const hookAt: { i: number; j: number; x: number; z: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (!live(i)) { this.paths[i] = null; continue; }
      const { a, b } = chord(i);
      const ya = H0 + a.y, yb = H0 + b.y;
      const pts: Ctrl[] = [{ x: a.x, z: a.z, y: ya }];
      const hooks: { j: number; x: number; z: number; u: number }[] = [];
      if (!this.ropes[i].gone) for (let j = 0; j < n; j++) {
        if (j === i || !live(j) || this.ropes[j].gone || R2(i, j) !== WRAP) continue;
        // the hook sits where the rope is shortest: the point P on j minimising |a-P| + |P-b|
        const c = chord(j);
        const at = (t: number) => [c.a.x + (c.b.x - c.a.x) * t, c.a.z + (c.b.z - c.a.z) * t];
        const f = (t: number) => { const [x, z] = at(t); return Math.hypot(x - a.x, z - a.z) + Math.hypot(x - b.x, z - b.z); };
        let lo = 0.08, hi = 0.92;
        for (let q = 0; q < 40; q++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (f(m1) < f(m2)) hi = m2; else lo = m1; }
        const [x, z] = at((lo + hi) / 2);
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        hooks.push({ j, x, z, u: ((x - a.x) * (b.x - a.x) + (z - a.z) * (b.z - a.z)) / (L * L) });
      }
      hooks.sort((p, q) => p.u - q.u);
      const zones: [number, number][] = [];
      for (const hk of hooks) {
        const c = chord(hk.j);
        let tx = c.b.x - c.a.x, tz = c.b.z - c.a.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        // n: towards the side the rope comes from; t: so the rope meets the hook from -t
        let nx = -tz, nz = tx;
        const mx = (a.x + b.x) / 2 - hk.x, mz = (a.z + b.z) / 2 - hk.z;
        if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
        if ((a.x - hk.x) * tx + (a.z - hk.z) * tz > 0) { tx = -tx; tz = -tz; }
        const S = 0.15, D = 0.26, P = (u: number, v: number, y: number): Ctrl => ({ x: hk.x + nx * u + tx * v, z: hk.z + nz * u + tz * v, y });
        // in from the near side, under j, up behind it, over the top, back out on the near side
        pts.push(P(D, -S, H0), P(-0.2, -S, H0), P(-0.24, 0, H0 + STACK * 0.95), P(0, S, H0 + STACK * 2.1), P(D, S, H0 + STACK * 0.6));
        hookAt.push({ i, j: hk.j, x: hk.x, z: hk.z });
        zones.push([pts.length - 5, pts.length - 1]);
      }
      pts.push({ x: b.x, z: b.z, y: yb });
      const path = new RopePath(pts);
      path.zones = zones.map(([k0, k1]) => [path.cum[k0] - 0.05, path.cum[k1] + 0.05]);
      this.paths[i] = path;
    }
    // a rope something is hooked round is lifted a little there, so the hook can pass under it
    for (const h of hookAt) {
      const pj = this.paths[h.j];
      if (pj) pj.hookBumps.push({ sc: pj.nearest(h.x, h.z), peak: H0 + STACK, half: 0.18, ramp: 0.3 });
    }
    // 2. heights: who lies on whom where they cross (the rules; layers only where the rules have no say)
    const pairs: { top: number; bot: number; s: number; t: number; sin: number }[] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const pi = this.paths[i], pj = this.paths[j];
      if (!pi || !pj || this.ropes[i].gone || this.ropes[j].gone) continue;
      const r = R2(i, j);
      if (r === WRAP || r === WRAPPED) continue;   // the hook draws itself
      const iTop = r === OVER ? true : r === UNDER ? false : this.layers[i] > this.layers[j];
      for (const x of crossings(pi, pj)) pairs.push(iTop ? { top: i, bot: j, s: x.s, t: x.t, sin: x.sin } : { top: j, bot: i, s: x.t, t: x.s, sin: x.sin });
    }
    // the one underneath is pressed into the board a touch and shaded where the other lies on it
    for (const c of pairs) this.paths[c.bot]!.dips.push({ sc: c.t, peak: 0.035, half: (R * 0.9) / Math.max(0.1, c.sin), ramp: 0.28 });
    // the one on top drapes over it: flat only while the two touch, then down to the board; piles of 3–4 settle over a few passes
    for (let pass = 0; pass < 4; pass++) {
      const next: Bump[][] = this.paths.map(() => []);
      for (const c of pairs) {
        const top = this.paths[c.top]!, bot = this.paths[c.bot]!;
        void top;
        const peak = Math.min(H0 + STACK * 4, bot.heightAt(c.t) + STACK);
        next[c.top].push({ sc: c.s, peak, half: Math.min(1.2, (R * 1.15) / Math.max(0.08, c.sin)), ramp: 0.26 + (peak - H0) * 1.6 });
      }
      this.paths.forEach((p, k) => { if (p) p.bumps = next[k]; });
    }
    // 3. tubes
    for (let i = 0; i < n; i++) this.layRope(i, fast);
    this.placeExtras();
  }
  private layRope(i: number, fast: boolean): void {
    const v = this.ropes[i], path = this.paths[i];
    if (!path) return;
    const curve = path.curve(fast ? 0.16 : 0.08);
    const len = curve.getLength();
    const segs = Math.max(16, Math.round(len * (fast ? 14 : 28)));
    for (const m of [v.tube, v.line, v.hit]) if (m) { m.geometry.dispose(); v.group.remove(m); }
    v.tube = new THREE.Mesh(ropeGeometry(curve, segs, R, false, len, 0.07, 0.8, path.dips.length ? (u) => path.shadeAt(u * path.len) : undefined), v.mat);
    v.tube.castShadow = true;
    v.tube.receiveShadow = true;
    // the dark outline of the reference: a slightly fatter tube, back faces only
    v.line = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, R * 1.2, LINE_RADIAL, false), LINE_MAT);
    const a = path.pts[0], b = path.pts[path.pts.length - 1];
    v.hit = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(a.x, H0, a.z), new THREE.Vector3(b.x, H0, b.z)), 4, 0.3, 6, false), HIT_MAT);
    v.hit.userData.strand = i;
    v.caps = [];
    v.group.add(v.tube, v.line, v.hit);
    v.segs = segs;
    v.mid = curve.getPointAt(0.5);
    if (v.gone) { v.tube.geometry.setDrawRange(0, 0); v.line.geometry.setDrawRange(0, 0); }
  }
  /** Pins, the "?" badges and the key follow the ropes. */
  private placeExtras(): void {
    this.ropes.forEach((v, i) => {
      for (const e of [0, 1]) {
        const p = this.pinPos(2 * i + e);
        v.pins[e].group.position.copy(p);
      }
      if (v.mystery) v.mystery.position.copy(v.mid).add(new THREE.Vector3(0, 0.32, 0));
    });
    const f = this.lockFx;
    if (f?.key && f.keyRope >= 0 && !f.open) f.keyHome.copy(this.ropes[f.keyRope].mid).add(new THREE.Vector3(0, 0.45, 0));
  }

  /** New pin places from the rules; `glide` = pin k slides in from where it is drawn now. */
  setEnds(ends: number[], gone: boolean[], rel?: Int8Array): void {
    this.ends = ends.slice();
    if (rel) this.rel = rel.slice();
    gone.forEach((g, i) => { if (g && !this.ropes[i].gone) this.setGone(i, true); });
    if (!this.drag) this.rebuild();
  }

  // ------------------------------------------------------------ dragging a pin

  /** Start carrying pin k: it lifts a little; its rope keeps its layer (under the ones above it, over the ones below). */
  beginDrag(k: number): void {
    const p = this.holePos(this.ends[k]);
    this.drag = { k, p: p.clone(), to: null, t: 0, from: p.clone(), done: null };
    this.selected = -1;
    this.dragAt.set(1e9, 0, 0);
  }
  /** Carry the pin to the page point. */
  dragTo(x: number, y: number): void {
    const d = this.drag;
    if (!d || d.to) return;
    const q = this.boardPoint(x, y, LIFT);
    if (!q) return;
    const B = this.bounds;
    d.p.set(Math.max(B.x0 - 0.4, Math.min(B.x1 + 0.4, q.x)), LIFT, Math.max(B.z0 - 0.4, Math.min(B.z1 + 0.4, q.z)));
  }
  /** Let go: the pin glides into hole `h` (the rules already put it there) and the ropes settle. */
  endDrag(h: number, ends: number[], dur = 0.13, rel?: Int8Array): Promise<void> {
    const d = this.drag;
    if (!d) return Promise.resolve();
    this.ends = ends.slice();
    if (rel) this.rel = rel.slice();
    d.from = d.p.clone();
    d.to = this.holePos(h);
    d.t = 0;
    d.dur = dur;
    return new Promise((res) => { d.done = res; });
  }
  get dragging(): number { return this.drag?.k ?? -1; }
  /** How the carried rope would lie (from the rules), asked as the pin moves. */
  setDragRule(f: (k: number, p: [number, number]) => Int8Array): void { this.dragRule = f; }
  /** Tap mode: pin k bobs up, waiting for a hole (-1 = none). */
  select(k: number): void { this.selected = k; }
  /** The board point under a page point, on the plane at height y. */
  boardPoint(x: number, y: number, h = 0): THREE.Vector3 | null {
    const nx = ((x - this.view.x) / this.view.w) * 2 - 1;
    const ny = -(((y - this.view.y) / this.view.h) * 2 - 1);
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), new THREE.Vector3());
  }
  /** The pin (rope*2 + end) under the page point, or -1. */
  pickPin(x: number, y: number): number {
    let best = -1, bd = Infinity;
    const lim = Math.max(24, this.pinPx() * 1.25);
    this.ropes.forEach((v, i) => {
      if (v.gone) return;
      for (const e of [0, 1]) {
        const q = this.toScreen(this.holePos(this.ends[2 * i + e], PIN_H));
        const dd = Math.hypot(q.x - x, q.y - y);
        if (dd < lim && dd < bd) { bd = dd; best = 2 * i + e; }
      }
    });
    return best;
  }
  /** The hole nearest the page point (within reach), or -1. */
  pickHole(x: number, y: number, reach = 1.6): number {
    let best = -1, bd = Infinity;
    const lim = Math.max(28, this.pinPx() * reach);
    for (let h = 0; h < this.holeXY.length; h++) {
      const q = this.toScreen(this.holePos(h));
      const dd = Math.hypot(q.x - x, q.y - y);
      if (dd < lim && dd < bd) { bd = dd; best = h; }
    }
    return best;
  }
  /** A hole's place on the page (css px). */
  holeScreen(h: number, y = 0): { x: number; y: number } { return this.toScreen(this.holePos(h, y)); }
  /** Pin radius on screen (css px). */
  pinPx(): number {
    const a = this.toScreen(new THREE.Vector3(0, PIN_H, 0)), b = this.toScreen(new THREE.Vector3(PIN_R, PIN_H, 0));
    return Math.abs(b.x - a.x);
  }
  /** Empty holes glow while a pin is carried. */
  setEmptyHoles(empty: number[]): void { this.emptyNow = new Set(empty); }

  private tint(i: number): void {
    const v = this.ropes[i];
    const c = ropeColor(v.color).multiplyScalar(v.dim ? DIM : 1);
    v.mat.color.copy(c);
    for (const p of v.pins) { p.body.color.copy(v.color).multiplyScalar(v.dim ? DIM : 1); p.top.color.copy(v.color).multiplyScalar(0.78 * (v.dim ? DIM : 1)); p.rim.color.copy(ropeColor(v.color)).multiplyScalar(0.35); }
  }
  setColor(i: number, color: string): void {
    const v = this.ropes[i];
    if (!v) return;
    v.color.set(color);
    this.tint(i);
    if (v.mystery) v.mystery.visible = false;
  }
  /** The key has come off: fly it into the padlock and open it (or, `now`, just show it open / closed). */
  setUnlocked(open: boolean, now = false): void {
    const f = this.lockFx;
    if (!f) return;
    f.open = open;
    f.t = open && !now ? 0 : open ? 2 : 0;
    if (!open || now) this.placeLock();
    if (open && now) for (const k of f.strands) { this.ropes[k].dim = false; this.tint(k); }
    if (!open) for (const k of f.strands) { this.ropes[k].dim = true; this.tint(k); }
  }
  private placeLock(): void {
    const f = this.lockFx!;
    const done = f.open && f.t >= 2;
    f.pad.visible = !done;
    f.pad.position.copy(f.at); f.pad.scale.setScalar(1.7); f.pad.rotation.set(-0.35, 0, 0);
    f.shackle.position.y = 0.16;
    if (f.key) { f.key.visible = !f.open; f.key.position.copy(f.keyHome); f.key.scale.setScalar(1.7); }
  }
  shakeLock(): void { if (this.lockFx) this.lockFx.shake = 1; }
  /** A white pulse on rope i ("this is the one you need"). */
  glow(i: number): void { const v = this.ropes[i]; if (v) v.glow = 1; }
  lockPoint(): THREE.Vector3 | null { return this.lockFx ? this.lockFx.at.clone() : null; }
  /** Pull rope i off (animated) or put it back (undo). */
  setGone(i: number, gone: boolean): void {
    const v = this.ropes[i];
    if (!v) return;
    v.gone = gone;
    if (!gone) {
      v.anim = 0; v.group.visible = true; v.group.position.set(0, 0, 0);
      v.tube?.geometry.setDrawRange(0, Infinity);
      v.line?.geometry.setDrawRange(0, Infinity);
      for (const p of v.pins) p.group.scale.setScalar(1);
      if (v.ball) v.ball.visible = false;
    } else if (!v.ball) {
      v.ball = ropeBall(v.color);
      v.ball.visible = false;
      this.board.add(v.ball);
    }
  }
  /** A pin bounces (it has just landed, or it can't move). */
  bumpPin(k: number): void { const v = this.ropes[k >> 1]; if (v) v.bump[k & 1] = 1; }
  shake(i: number): void { const v = this.ropes[i]; if (v) v.shake = 1; }
  flash(i: number): void { const v = this.ropes[i]; if (v) v.flash = 1; }
  midOf(i: number): THREE.Vector3 { return this.ropes[i]?.mid.clone() ?? new THREE.Vector3(); }
  setHighlight(i: number, a: number): void { const v = this.ropes[i]; if (v && !v.flash && !v.glow) { v.mat.emissive.set(0x9cff7a); v.mat.emissiveIntensity = a; } }


  update(dt: number): void {
    this.clock += dt;
    if (this.toy) {
      this.toy.group.rotation.y = -0.62 + (this.show.k > 0 ? this.show.spin : Math.sin(this.clock * 0.6) * 0.22);
      this.toyPop = Math.max(0, this.toyPop - dt * 2.5);
      const s = 1 + Math.sin(this.toyPop * Math.PI) * 0.06;
      this.toy.group.scale.set(s, s * (1 + Math.sin(this.clock * 2.2) * 0.012), s);
      for (const [k, f] of this.knits) {
        if (f.t >= 1) continue;
        f.t = Math.min(1, f.t + dt / f.dur);
        this.applyKnit(k);
        if (f.t >= 1 && f.level >= 0.999) this.toyPop = 1;
      }
    }
    // the carried pin: follows the finger, or glides into its hole and the ropes settle
    const d = this.drag;
    if (d) {
      if (d.to) {
        d.t = Math.min(1, d.t + dt / (d.dur ?? 0.13));
        const e = d.t * d.t * (3 - 2 * d.t);
        d.p.lerpVectors(d.from, d.to, e);
        d.p.y = d.from.y * (1 - e);
      }
      // re-lay the carried rope and everything stacked above it (only when the pin has really moved)
      if (d.p.distanceTo(this.dragAt) > 0.04) {
        this.dragAt.copy(d.p);
        this.rebuild(true);
      } else this.placeExtras();
      if (d.to && d.t >= 1) {
        const k = d.k, done = d.done;
        this.drag = null;
        this.rebuild();
        this.bumpPin(k);
        done?.();
      }
    }
    // empty holes glow softly while a pin is up
    const lit = this.drag || this.selected >= 0;
    this.holeMeshes.forEach((m, h) => { (m.material as THREE.MeshStandardMaterial).emissiveIntensity = lit && this.emptyNow.has(h) ? 0.16 + 0.12 * Math.sin(this.clock * 7) : 0; });
    this.ropes.forEach((v, i) => {
      for (const e of [0, 1]) {
        const pin = v.pins[e].group;
        if (v.bump[e] > 0) v.bump[e] = Math.max(0, v.bump[e] - dt * 3);
        const sel = this.selected === 2 * i + e;
        const sq = Math.sin(v.bump[e] * Math.PI * 2) * v.bump[e] * 0.25;
        pin.scale.set(1 + sq, 1 - sq, 1 + sq);
        if (sel) pin.position.y = 0.12 + Math.sin(this.clock * 8) * 0.05;
        else if (!(this.drag && this.drag.k === 2 * i + e)) pin.position.y = 0;
      }
      if (v.gone) {
        // the rope reels in from both ends into a spinning ball at its middle, which lifts off; the pins pop out
        v.anim = Math.min(1, v.anim + dt / COIL);
        const k = v.anim, e = k * k * (3 - 2 * k);
        const per = RADIAL * 6, cut = Math.floor((v.segs * Math.min(1, e * 1.08)) / 2);
        if (v.tube) { v.tube.geometry.setDrawRange(cut * per, Math.max(0, (v.segs - 2 * cut) * per)); v.tube.visible = v.segs - 2 * cut > 0; }
        if (v.line) { const pl = LINE_RADIAL * 6; v.line.geometry.setDrawRange(cut * pl, Math.max(0, (v.segs - 2 * cut) * pl)); v.line.visible = v.segs - 2 * cut > 0; }
        for (const c of v.caps) c.visible = k < 0.15;
        for (const p of v.pins) p.group.scale.setScalar(Math.max(0.001, k < 0.2 ? 1 + k : 1.2 - (k - 0.2) * 1.5));
        if (v.ball) {
          v.ball.visible = k < 1;
          v.ball.scale.setScalar(Math.max(0.001, 0.25 + 0.75 * e));
          v.ball.position.copy(v.mid).add(new THREE.Vector3(0, 0.2 + e * 0.5, 0));
          v.ball.rotation.set(k * 9, k * 5, 0);
        }
        v.group.visible = k < 1;
      }
      if (v.shake > 0) {
        v.shake = Math.max(0, v.shake - dt * 2.5);
        v.group.position.x = Math.sin(v.shake * 40) * v.shake * 0.08;
      }
      if (v.flash > 0) {
        v.flash = Math.max(0, v.flash - dt * 1.5);
        v.mat.emissive.set(0xff3030);
        v.mat.emissiveIntensity = v.flash * 0.7;
      } else if (v.glow > 0) {
        v.glow = Math.max(0, v.glow - dt * 0.8);
        v.mat.emissive.set(0xffffff);
        v.mat.emissiveIntensity = (0.5 + 0.5 * Math.sin(v.glow * 18)) * v.glow * 0.6;
      } else if (v.mat.emissive.r > 0.9 && v.mat.emissive.g < 0.5) v.mat.emissiveIntensity = 0;
      else if (v.mat.emissive.b > 0.9 && v.mat.emissive.r > 0.9) v.mat.emissiveIntensity = 0;
    });

    const f = this.lockFx;
    if (f) {
      if (f.key && !f.open) {
        f.key.position.x = f.keyHome.x; f.key.position.z = f.keyHome.z;
        f.key.position.y = f.keyHome.y + Math.sin(this.clock * 3) * 0.04;
        f.key.rotation.y = Math.sin(this.clock * 1.6) * 0.5;
      }
      if (f.shake > 0) {
        f.shake = Math.max(0, f.shake - dt * 2.5);
        f.pad.rotation.z = Math.sin(f.shake * 36) * f.shake * 0.35;
      }
      if (f.open && f.t < 2) {
        // key flies in an arc into the lock (0–0.5), the shackle pops (0.5–0.8), the padlock drops away (0.8–1.3)
        f.t = Math.min(2, f.t + dt);
        const t = f.t;
        if (f.key) {
          const k = Math.min(1, t / 0.5), e = k * k * (3 - 2 * k);
          f.key.position.lerpVectors(f.keyHome, f.at.clone().add(new THREE.Vector3(0, -0.05, 0.22)), e);
          f.key.position.y += Math.sin(Math.PI * k) * 0.8;
          f.key.rotation.set(-0.35, 0, k * Math.PI * 2 + Math.max(0, t - 0.5) * 6);
          f.key.scale.setScalar(1.7 * (t < 0.8 ? 1 : Math.max(0.001, 1 - (t - 0.8) / 0.3)));
        }
        if (t > 0.5) f.shackle.position.y = 0.16 + Math.min(1, (t - 0.5) / 0.15) * 0.12;
        if (t > 0.5 && f.strands.some((k) => this.ropes[k].dim)) for (const k of f.strands) { this.ropes[k].dim = false; this.tint(k); }
        if (t > 0.8) {
          const k = Math.min(1, (t - 0.8) / 0.5);
          f.pad.position.y = f.at.y - k * k * 0.9;
          f.pad.scale.setScalar(1.7 * Math.max(0.001, 1 - k));
          f.pad.rotation.z = k * 0.8;
        }
        if (t >= 1.3) { f.t = 2; this.placeLock(); }
      }
    }
  }

  // ------------------------------------------------------------ view

  setView(x: number, y: number, w: number, h: number, cw: number, ch: number, dpr: number): void {
    this.view = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    this.renderer.setPixelRatio(dpr);
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== cw || size.y !== ch) this.renderer.setSize(cw, ch, false);
    this.camera.aspect = this.view.w / this.view.h;
    this.camera.updateProjectionMatrix();
  }

  private place(): void {
    // like the reference board: seen from above and in front, its thick front edge showing
    const tilt = (74 * Math.PI) / 180;
    const dir = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
    this.camera.zoom = 1;   // fit the whole board first; the player's zoom goes on top
    this.camera.clearViewOffset();
    const bounds = () => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of this.fit) {
        const q = p.clone().project(this.camera);
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      }
      return { x0, x1, y0, y1 };
    };
    const at = (d: number) => {
      this.camera.position.copy(this.target).addScaledVector(dir, d);
      this.camera.lookAt(this.target);
      this.camera.updateMatrixWorld();
    };
    let lo = 3, hi = 300;
    for (let k = 0; k < 22; k++) {
      const mid = (lo + hi) / 2;
      at(mid);
      const b = bounds();
      if (b.x1 - b.x0 <= 1.99 && b.y1 - b.y0 <= 1.97) hi = mid; else lo = mid;
    }
    at(hi);
    const b = bounds();
    const { w, h } = this.view;
    // centred left-right; the board's far edge sits right under the basket, as in the reference
    this.camera.setViewOffset(w, h, (((b.x0 + b.x1) / 2) * w) / 2, ((-(b.y0 + b.y1) / 2) * h) / 2, w, h);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    // where the board's far (top) frame edge lands on screen at 1× zoom — the basket sits right above it
    {
      const fo = this.frameOut, y = -0.02;
      const l = this.toScreen(new THREE.Vector3(-this.zoom.w / 2 - fo, y, -this.zoom.d / 2 - fo));
      const r = this.toScreen(new THREE.Vector3(this.zoom.w / 2 + fo, y, -this.zoom.d / 2 - fo));
      this.boardTop = { x0: l.x, x1: r.x, y: Math.min(l.y, r.y) };
    }
    // the player's zoom + pan on top of the fit
    const z = this.zoom;
    z.cur += (z.to - z.cur) * 0.25;
    if (Math.abs(z.to - z.cur) < 0.002) z.cur = z.to;
    this.clampPan();
    z.px += (z.tx - z.px) * 0.35;
    z.pz += (z.tz - z.pz) * 0.35;
    this.camera.position.x += z.px;
    this.camera.position.z += z.pz;
    this.camera.updateMatrixWorld();
    this.camera.zoom = z.cur;
    this.camera.updateProjectionMatrix();
  }

  get zoomLevel(): number { return this.zoom.to; }
  /** Zoom the board to `z` (clamped between the whole board and about twice as close). */
  setZoom(z: number): void {
    this.zoom.to = Math.min(Scene3D.ZOOM_MAX, Math.max(Scene3D.ZOOM_MIN, z));
    if (this.zoom.to <= Scene3D.ZOOM_MIN + 0.001) { this.zoom.tx = 0; this.zoom.tz = 0; }
  }
  /** Drag the zoomed board by a screen distance (css px). */
  panBy(dx: number, dy: number): void {
    const perPx = (this.zoom.w + 0.6) / Math.max(1, this.view.w) / this.zoom.cur;
    this.zoom.tx -= dx * perPx;
    this.zoom.tz -= dy * perPx * 1.15;
    this.clampPan();
  }
  private clampPan(): void {
    const z = this.zoom, k = 1 - 1 / Math.max(1, z.to);
    const mx = (z.w / 2 + 0.3) * k, mz = (z.d / 2 + 0.3) * k;
    z.tx = Math.max(-mx, Math.min(mx, z.tx));
    z.tz = Math.max(-mz, Math.min(mz, z.tz));
  }
  /** Is the page point over the board's view? */
  inView(x: number, y: number): boolean { const v = this.view; return x >= v.x && x <= v.x + v.w && y >= v.y && y <= v.y + v.h; }

  toScreen(v: THREE.Vector3): { x: number; y: number } {
    const q = v.clone().project(this.camera);
    return { x: this.view.x + ((q.x + 1) / 2) * this.view.w, y: this.view.y + ((1 - q.y) / 2) * this.view.h };
  }

  /** The top-most strand under the page point (css px), or -1. */
  pick(x: number, y: number): number {
    const nx = ((x - this.view.x) / this.view.w) * 2 - 1;
    const ny = -(((y - this.view.y) / this.view.h) * 2 - 1);
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hits = this.ray.intersectObjects(this.ropes.filter((s) => !s.gone && s.hit).map((s) => s.hit!), false);
    if (!hits.length) return -1;
    // among hits close to the ray, prefer the highest strand
    const best = hits.slice(0, 4).sort((a, b) => b.point.y - a.point.y)[0];
    return best.object.userData.strand;
  }

  /** The finished toy, big in the middle of the screen, turning: `k` 0..1 fades the board under a sky veil. */
  showcase(k: number, spin: number): void {
    this.show = { k, spin };
    if (!this.veil) {
      const c = document.createElement('canvas');
      c.width = 4; c.height = 256;
      const g = c.getContext('2d')!;
      const gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, '#7cc8ff'); gr.addColorStop(0.55, '#bfe8ff'); gr.addColorStop(1, '#e8f7ff');
      g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthTest: false });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      // sun rays behind the toy
      const rc = document.createElement('canvas');
      rc.width = rc.height = 256;
      const rg = rc.getContext('2d')!;
      const glow = rg.createRadialGradient(128, 128, 0, 128, 128, 128);
      glow.addColorStop(0, 'rgba(255,255,255,0.95)'); glow.addColorStop(0.35, 'rgba(255,250,210,0.45)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
      for (let k2 = 0; k2 < 14; k2++) {
        rg.save(); rg.translate(128, 128); rg.rotate((k2 / 14) * Math.PI * 2);
        rg.fillStyle = 'rgba(255,255,255,0.28)';
        rg.beginPath(); rg.moveTo(0, 0); rg.lineTo(-14, -128); rg.lineTo(14, -128); rg.closePath(); rg.fill();
        rg.restore();
      }
      rg.fillStyle = glow; rg.fillRect(0, 0, 256, 256);
      const rt = new THREE.CanvasTexture(rc);
      rt.colorSpace = THREE.SRGBColorSpace;
      const rays = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: rt, transparent: true, depthTest: false }));
      rays.position.z = -0.5;
      scene.add(rays);
      this.veil = { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat, rays };
    }
  }
  /** Sun rays drawn in the veil pass, centred on the toy's view (screen px → clip space). */
  private placeRays(fw: number, fh: number): void {
    const v = this.veil!, t = this.toyView, dpr = this.renderer.getPixelRatio();
    const cx = ((t.x + t.w / 2) * dpr / fw) * 2 - 1, cy = 1 - ((t.y + t.h * 0.5) * dpr / fh) * 2;
    const R = Math.max(t.w, t.h) * 0.85 * dpr * Math.max(0.01, this.show.k);
    v.rays.position.set(cx, cy, -0.5);
    v.rays.scale.set(R / fw * 2 / 2, R / fh * 2 / 2, 1);
    v.rays.rotation.z = this.clock * 0.4;
    (v.rays.material as THREE.MeshBasicMaterial).opacity = this.show.k;
  }

  render(): void {
    this.place();
    const r = this.renderer;
    const full = r.getSize(new THREE.Vector2());
    r.setScissorTest(false);
    r.setViewport(0, 0, full.x, full.y);
    r.setClearColor(0x000000, 0);
    r.clear();
    const { x, y, w, h } = this.view;
    const vy = full.y - y - h;
    r.setViewport(x, vy, w, h);
    r.setScissor(x, vy, w, h);
    r.setScissorTest(true);
    // one colour clear per frame (above); each pass only clears depth, so passes layer up
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.camera);
    if (this.show.k > 0 && this.veil) {
      // the sky veil over the board (blended, so the board fades out under it)
      r.setViewport(0, 0, full.x, full.y);
      r.setScissor(0, 0, full.x, full.y);
      this.veil.mat.opacity = this.show.k;
      this.placeRays(full.x, full.y);
      r.render(this.veil.scene, this.veil.cam);
    }
    if (this.toy) {
      const t = this.toyView;
      const ty = full.y - t.y - t.h;
      r.setViewport(t.x, ty, t.w, t.h);
      r.setScissor(t.x, ty, t.w, t.h);
      r.clearDepth();
      r.render(this.toyScene, this.toyCam);
    }
    r.setScissorTest(false);
    r.autoClear = true;
  }
}
