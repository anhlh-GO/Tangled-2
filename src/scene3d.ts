// The 3D view (three.js) of the board as board.ts has it: slots (the active one ringed,
// forbidden ones crossed out, previews faint), handles (fixed ones nailed down, converted
// ones ringed in the colour of their moves left) and glossy ropes (dark outline, as in the
// reference) drawn from the rope physics every frame; a rope stretched past the warning
// rate turns orange, then red. This file owns no rules: the game steps the board.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RAW, buildToy, type Toy } from './items3d';
import { END_Y, PILLAR_R, PIN_R, R } from './rope';
import type { Board } from './board';
import { CFG } from './config';

const PIN_H = 0.2;      // pin height

interface PinMesh { group: THREE.Group; body: THREE.MeshPhysicalMaterial; top: THREE.MeshStandardMaterial; rim: THREE.MeshBasicMaterial }
/** A rope of the physics (cut ropes leave two halves: each a view of its own, coloured as the rope it came from). */
interface RopeView { group: THREE.Group; tube: THREE.Mesh; line: THREE.Mesh; buf: TubeBuf; lbuf: TubeBuf; mat: THREE.MeshPhysicalMaterial; color: THREE.Color; mid: THREE.Vector3; segs: number; n: number; anim: number; flash: number; glow: number; gone: boolean; ball: THREE.Group | null; mystery?: THREE.Sprite; owner: number; shown: string }
interface HandleView { pin: PinMesh; nail: THREE.Group; ring: THREE.Mesh; ringMat: THREE.MeshStandardMaterial; bump: number; color: THREE.Color; cog: THREE.Group | null; timer: THREE.Mesh | null; timerAt: number }
interface SlotView { dish: THREE.Mesh; mat: THREE.MeshStandardMaterial; lip: THREE.Mesh; ring: THREE.Mesh; cross: THREE.Group; kind: string }
const DIM = 0.55;   // the rope held by the padlock is drawn this much darker
const WARN = new THREE.Color(CFG.warningColor), SNAP = new THREE.Color(CFG.snapColor);

/**
 * A rope's tube, rebuilt in place every frame from its beads: a smooth curve through
 * them, three twisted plies bulging round it (grooves shaded by vertex colour).
 */
class TubeBuf {
  geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private c: Float32Array;   // curve samples
  constructor(readonly segs: number, readonly radial: number, readonly r: number, readonly ply: number) {
    const nv = (segs + 1) * (radial + 1);
    this.pos = new Float32Array(nv * 3);
    this.col = new Float32Array(nv * 3).fill(1);
    this.c = new Float32Array((segs + 1) * 3);
    const idx: number[] = [];
    for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = (i + 1) * (radial + 1) + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  }
  /** beads: x,y,z per bead (board units, already in view space). */
  update(x: Float64Array, n: number, ox: number, oz: number): void {
    const S = this.segs, c = this.c;
    // centripetal-ish Catmull-Rom through the beads, sampled evenly in bead index
    for (let i = 0; i <= S; i++) {
      const f = (i / S) * (n - 1), k = Math.min(n - 2, Math.floor(f)), t = f - k;
      const k0 = Math.max(0, k - 1), k3 = Math.min(n - 1, k + 2);
      for (let d = 0; d < 3; d++) {
        const p0 = x[k0 * 3 + d], p1 = x[k * 3 + d], p2 = x[(k + 1) * 3 + d], p3 = x[k3 * 3 + d];
        const t2 = t * t, t3 = t2 * t;
        c[i * 3 + d] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3) + (d === 0 ? ox : d === 2 ? oz : 0);
      }
    }
    // frames by parallel transport; plies twist along the length
    const R0 = this.r, RA = this.radial, pos = this.pos, col = this.col;
    let nx = 0, ny = 1, nz = 0, len = 0;
    for (let i = 0; i <= S; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(S, i + 1) * 3;
      let tx = c[b] - c[a], ty = c[b + 1] - c[a + 1], tz = c[b + 2] - c[a + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      // keep the normal square to the tangent
      const dn = nx * tx + ny * ty + nz * tz;
      nx -= tx * dn; ny -= ty * dn; nz -= tz * dn;
      let nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-4) { nx = -tz; ny = 0; nz = tx; nl = Math.hypot(nx, nz) || 1; if (nl < 1e-4) { nx = 1; nz = 0; nl = 1; } }
      nx /= nl; ny /= nl; nz /= nl;
      const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      if (i > 0) len += Math.hypot(c[i * 3] - c[i * 3 - 3], c[i * 3 + 1] - c[i * 3 - 2], c[i * 3 + 2] - c[i * 3 - 1]);
      for (let j = 0; j <= RA; j++) {
        const th = (j / RA) * Math.PI * 2, cs = -Math.cos(th), sn = Math.sin(th);
        const w = Math.cos(3 * th - (3 * Math.PI * 2 * len) / 0.62);
        const rr = R0 * (1 + this.ply * (Math.sqrt(Math.max(0, w * 0.5 + 0.5)) - 0.55));
        const v = (i * (RA + 1) + j) * 3;
        pos[v] = c[i * 3] + (nx * cs + bx * sn) * rr;
        pos[v + 1] = c[i * 3 + 1] + (ny * cs + by * sn) * rr;
        pos[v + 2] = c[i * 3 + 2] + (nz * cs + bz * sn) * rr;
        if (this.ply > 0) col[v] = col[v + 1] = col[v + 2] = 0.8 + 0.2 * Math.pow(Math.max(0, w * 0.5 + 0.5), 0.55);
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
  }
  /** The point at the middle of the rope (view space). */
  mid(out: THREE.Vector3): THREE.Vector3 { const k = (this.segs >> 1) * 3; return out.set(this.c[k], this.c[k + 1], this.c[k + 2]); }
  point(i: number, out: THREE.Vector3): THREE.Vector3 { return out.set(this.c[i * 3], this.c[i * 3 + 1], this.c[i * 3 + 2]); }
}

/** A pin as in the reference: a fat glossy button in the rope's colour, a darker dished top, a dark rim. */
function pinMesh(color: THREE.Color): PinMesh {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(PIN_R, 0)];
  for (let k = 0; k <= 8; k++) { const a = (k / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(PIN_R - 0.07 + Math.cos(a) * 0.07, PIN_H - 0.07 + Math.sin(a) * 0.07)); }
  pts.push(new THREE.Vector2(0, PIN_H));
  const body = new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), body);
  m.castShadow = false;
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
/** The rope's own colour, as in the reference (bright, not deepened). */
function ropeColor(c: THREE.Color): THREE.Color { return c.clone(); }
/** Soft satin rope with faint twist lines (the reference): a little sheen, no plastic gloss. */
function ropeMaterial(color: THREE.Color): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({ color: ropeColor(color), vertexColors: true, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 });
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
  private mysteryTex = mysteryTexture();
  private bounds = { x0: -2, x1: 2, z0: -2, z1: 2 };
  /** The rules being drawn. */
  private rules: Board | null = null;
  private handles: HandleView[] = [];
  private slotViews: SlotView[] = [];
  private ropeColors: string[] = [];
  private mysteryOf: boolean[] = [];
  private shakeT = 0;
  private slab: THREE.Mesh | null = null;
  /** §11 props: rail bars, pillars, umbrellas, trapdoors. */
  private rails: { i: number; j: number; mesh: THREE.Mesh }[] = [];
  private posts: THREE.Group[] = [];
  private umbrellas: { slot: number; group: THREE.Group; canopy: THREE.Group; open: number }[] = [];
  private doors: { group: THREE.Group; t: number }[] = [];
  private winShown = -1;
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

  /** Slot s on the board (view space = board units, centred). */
  holePos(s: number, y = 0): THREE.Vector3 {
    const t = this.rules?.slots[s];
    return new THREE.Vector3(t?.x ?? 0, y, t?.z ?? 0);
  }
  /** Where handle k is drawn (its base). */
  private pinPos(k: number): THREE.Vector3 {
    const p = this.rules!.world.handles[k].pos;
    return new THREE.Vector3(p[0], p[1] - END_Y, p[2]);
  }

  /**
   * Build the board for these rules: `colors[r]` the colour of rope r (grey when hidden),
   * `mystery[r]` a "?" over it until it is revealed.
   */
  build(rules: Board, colors: string[], mystery: boolean[] = []): void {
    this.rules = rules;
    this.ropeColors = colors.slice();
    this.mysteryOf = mystery.slice();
    const xs = rules.slots.map((s) => s.x), zs = rules.slots.map((s) => s.z);
    this.bounds = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    this.board.clear();
    this.ropes = [];
    this.handles = [];
    this.slotViews = [];
    Object.assign(this.zoom, { cur: 1, to: 1, px: 0, pz: 0, tx: 0, tz: 0 });
    this.layoutSlab();
    rules.handles.forEach((_, k) => this.addHandle(k));
    this.decorate();
    this.winShown = -1;
    this.syncAll(0);
  }
  /** The board slab round the slots (rebuilt when Expansion adds a ring). */
  private layoutSlab(): void {
    const r = this.rules;
    if (r && r.winRows < r.rows) {
      // a long map: only the window's rows are the board on screen
      const vis = r.slots.filter((s) => r.rowShown(s.row));
      const xs = vis.map((s) => s.x), zs = vis.map((s) => s.z);
      this.bounds = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    }
    const b = this.bounds;
    const S = Math.max(4, b.x1 - b.x0 + 1.7), D = Math.max(4, b.z1 - b.z0 + 1.7);
    // the camera looks at the middle of the board on screen (a long map: of its window)
    this.target.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
    this.zoom.w = S; this.zoom.d = D;
    const ext = Math.max(S, D) / 2 + 1.2;
    Object.assign(this.sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 40 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.radius = 2.5;
    if (this.slab) { this.board.remove(this.slab); this.slab.geometry.dispose(); }
    const topMat = new THREE.MeshStandardMaterial({ color: 0xededf3, roughness: 0.85 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xd4d4dc, roughness: 0.8 });
    const slab = new THREE.Mesh(new RoundedBoxGeometry(S, 0.34, D, 6, 0.24), [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
    slab.position.set((b.x0 + b.x1) / 2, -0.17, (b.z0 + b.z1) / 2);
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.board.add(slab);
    this.slab = slab;
    this.fit = [];
    this.frameOut = 0;
    for (const x of [b.x0 - S / 2 + (b.x1 - b.x0) / 2, b.x1 + S / 2 - (b.x1 - b.x0) / 2]) this.fit.push(new THREE.Vector3(x, 0, (b.z0 + b.z1) / 2 - D / 2), new THREE.Vector3(x, -0.34, (b.z0 + b.z1) / 2 + D / 2));
  }
  private addSlot(i: number): void {
    const s = this.rules!.slots[i];
    const mat = new THREE.MeshStandardMaterial({ color: 0xdcdce2, roughness: 0.9, transparent: true, emissive: new THREE.Color(0x7cff6a), emissiveIntensity: 0 });
    const dish = new THREE.Mesh(new THREE.CircleGeometry(PIN_R * 1.24, 40), mat);
    dish.rotation.x = -Math.PI / 2;
    dish.position.set(s.x, 0.004, s.z);
    dish.receiveShadow = true;
    const lip = new THREE.Mesh(new THREE.RingGeometry(PIN_R * 1.24, PIN_R * 1.38, 40), new THREE.MeshStandardMaterial({ color: 0xd2d2da, roughness: 0.85 }));
    lip.rotation.x = -Math.PI / 2;
    lip.position.set(s.x, 0.003, s.z);
    // the selection ring of the active slot
    const ring = new THREE.Mesh(new THREE.TorusGeometry(PIN_R * 1.45, 0.05, 10, 48), new THREE.MeshBasicMaterial({ color: 0x3fd16a }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.x, 0.03, s.z);
    ring.visible = false;
    // a forbidden slot: a red cross
    const cross = new THREE.Group();
    const xm = new THREE.MeshStandardMaterial({ color: 0xe8443b, roughness: 0.5 });
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(PIN_R * 1.5, 0.05, 0.1), xm);
      bar.rotation.y = a;
      cross.add(bar);
    }
    cross.position.set(s.x, 0.03, s.z);
    this.board.add(dish, lip, ring, cross);
    this.slotViews[i] = { dish, mat, lip, ring, cross, kind: '' };
    if (!s.exists) { dish.visible = lip.visible = cross.visible = false; }
  }
  private addHandle(k: number): void {
    const r = this.rules!, h = r.handles[k];
    const rope = h.ropes[0] ?? 0;
    const color = new THREE.Color(this.ropeColors[rope] ?? '#888888');
    const pin = pinMesh(color);
    // a fixed handle: a steel nail through its middle
    const nail = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd6, roughness: 0.25, metalness: 0.8 });
    const head = new THREE.Mesh(new THREE.CylinderGeometry(PIN_R * 0.42, PIN_R * 0.42, 0.06, 24), steel);
    head.position.y = PIN_H + 0.1;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(PIN_R * 0.12, PIN_R * 0.12, 0.12, 12), steel);
    shaft.position.y = PIN_H + 0.04;
    nail.add(head, shaft);
    // a converted handle: a ring in the colour of its moves left
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, emissive: new THREE.Color(0x000000) });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(PIN_R * 0.95, 0.07, 10, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = PIN_H * 0.6;
    pin.group.add(nail, ring);
    // a multi-slot handle: a button on every cell it covers, joined by bars
    const offs = h.cells.map(([dr, dc]) => new THREE.Vector3(dc * r.pitchX, 0, dr * 1.3143));
    for (let c = 1; c < offs.length; c++) {
      const extra = pinMesh(color);
      extra.group.position.copy(offs[c]);
      pin.group.add(extra.group);
    }
    for (let a = 0; a < offs.length; a++) for (let b = a + 1; b < offs.length; b++) {
      const d = offs[a].distanceTo(offs[b]);
      if (d > Math.max(r.pitchX, 1.3143) * 1.05) continue;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(d, PIN_H * 0.7, PIN_R * 0.9), new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, clearcoat: 0.6 }));
      bar.position.copy(offs[a]).add(offs[b]).multiplyScalar(0.5).setY(PIN_H * 0.35);
      bar.rotation.y = -Math.atan2(offs[b].z - offs[a].z, offs[b].x - offs[a].x);
      bar.castShadow = false;
      pin.group.add(bar);
    }
    // a geared handle: a little golden cog on top
    let cog: THREE.Group | null = null;
    if (h.gear) {
      cog = new THREE.Group();
      const gold = new THREE.MeshStandardMaterial({ color: h.gear === 1 ? 0xf2b23a : 0x9fd1ff, roughness: 0.3, metalness: 0.6 });
      cog.add(new THREE.Mesh(new THREE.TorusGeometry(PIN_R * 0.42, 0.06, 8, 24), gold));
      for (let t = 0; t < 8; t++) { const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), gold); const a = (t / 8) * Math.PI * 2; tooth.position.set(Math.cos(a) * PIN_R * 0.55, Math.sin(a) * PIN_R * 0.55, 0); cog.add(tooth); }
      cog.rotation.x = -Math.PI / 2;
      cog.position.y = PIN_H + 0.06;
      pin.group.add(cog);
    }
    // time to fixed: a ring that runs down
    let timer: THREE.Mesh | null = null;
    if (h.toFixedTime !== null) {
      timer = new THREE.Mesh(new THREE.RingGeometry(PIN_R * 1.05, PIN_R * 1.25, 40, 1, 0, Math.PI * 2), new THREE.MeshBasicMaterial({ color: 0xffb020, side: THREE.DoubleSide }));
      timer.rotation.x = -Math.PI / 2;
      timer.position.y = 0.03;
      pin.group.add(timer);
    }
    this.board.add(pin.group);
    this.handles[k] = { pin, nail, ring, ringMat, bump: 0, color, cog, timer, timerAt: 1 };
  }

  /** The §11 props round the slots: rails, pillars, umbrellas, trapdoors. */
  private decorate(): void {
    const r = this.rules!;
    this.rails = []; this.posts = []; this.umbrellas = []; this.doors = [];
    const steel = new THREE.MeshStandardMaterial({ color: 0x7a8396, roughness: 0.35, metalness: 0.7 });
    const reach = Math.max(r.pitchX, 1.3143) * 1.05;
    r.slots.forEach((a, i) => r.slots.forEach((b, j) => {
      if (j <= i || a.rail === null || a.rail !== b.rail) return;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > reach) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(d, 0.05, 0.2), steel);
      mesh.position.set((a.x + b.x) / 2, 0.03, (a.z + b.z) / 2);
      mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      mesh.receiveShadow = true;
      this.board.add(mesh);
      this.rails.push({ i, j, mesh });
    }));
    const wood = new THREE.MeshStandardMaterial({ color: 0xb98256, roughness: 0.6 });
    for (const p of r.world.pillars) {
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(PILLAR_R * 0.9, PILLAR_R, 0.95, 20), wood);
      post.position.y = 0.475;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(PILLAR_R * 1.05, 20, 12), new THREE.MeshStandardMaterial({ color: 0xe8443b, roughness: 0.4 }));
      cap.position.y = 0.97;
      post.castShadow = cap.castShadow = true;
      g.add(post, cap);
      g.position.set(p.x, 0, p.z);
      this.board.add(g);
      this.posts.push(g);
    }
    r.slots.forEach((s, i) => {
      if (!s.umbrella) return;
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.25, 8), new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }));
      pole.position.y = 0.62;
      const canopy = new THREE.Group();
      for (let t = 0; t < 8; t++) {
        const panel = new THREE.Mesh(new THREE.ConeGeometry(1, 0.4, 2, 1, true, (t / 8) * Math.PI * 2, Math.PI / 4), new THREE.MeshStandardMaterial({ color: t % 2 ? 0xffffff : 0xff5a6e, roughness: 0.5, side: THREE.DoubleSide }));
        canopy.add(panel);
      }
      canopy.position.y = 1.3;
      g.add(pole, canopy);
      g.position.set(s.x, 0, s.z);
      g.traverse((o) => { o.castShadow = true; });
      this.board.add(g);
      this.umbrellas.push({ slot: i, group: g, canopy, open: s.umbrella.isOpen ? 1 : 0 });
    });
    r.traps.forEach((t) => {
      const xs = t.slots.map((q) => r.slots[q].x), zs = t.slots.map((q) => r.slots[q].z);
      const w = Math.max(...xs) - Math.min(...xs) + r.pitchX * 0.9, d = Math.max(...zs) - Math.min(...zs) + 1.3143 * 0.9;
      const g = new THREE.Group();
      const door = new THREE.Mesh(new RoundedBoxGeometry(w, 0.14, d, 4, 0.08), new THREE.MeshStandardMaterial({ color: 0x9a6a3e, roughness: 0.7 }));
      door.position.y = 0.08;
      door.receiveShadow = door.castShadow = true;
      g.add(door);
      // planks and two chains across
      for (let p = 1; p < 4; p++) { const line = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, d * 0.94), new THREE.MeshStandardMaterial({ color: 0x6b4526 })); line.position.set(-w / 2 + (w * p) / 4, 0.16, 0); g.add(line); }
      const iron = new THREE.MeshStandardMaterial({ color: 0x8b8f99, metalness: 0.7, roughness: 0.35 });
      for (const z of [-d / 4, d / 4]) for (let c = 0; c < 9; c++) { const link = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.022, 6, 12), iron); link.position.set(-w / 2 + 0.1 + (c / 8) * (w - 0.2), 0.19, z); link.rotation.y = c % 2 ? Math.PI / 2 : 0; g.add(link); }
      g.position.set((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2);
      this.board.add(g);
      this.doors.push({ group: g, t: 0 });
    });
  }
  private addRope(w: number): void {
    const r = this.rules!, wr = r.world.ropes[w];
    const owner = r.owner[w] ?? w;
    const color = new THREE.Color(this.ropeColors[owner] ?? '#888888');
    const mat = ropeMaterial(color);
    const segs = Math.max(12, (wr.n - 1) * 2);
    const buf = new TubeBuf(segs, RADIAL, R, 0.07), lbuf = new TubeBuf(segs, LINE_RADIAL, R * 1.12, 0);
    const tube = new THREE.Mesh(buf.geo, mat), line = new THREE.Mesh(lbuf.geo, LINE_MAT);
    tube.castShadow = false;   // no shadows under the ropes (the reference)
    tube.receiveShadow = false;
    tube.frustumCulled = false;
    line.frustumCulled = false;
    const group = new THREE.Group();
    group.add(tube, line);
    this.board.add(group);
    const v: RopeView = { group, tube, line, buf, lbuf, mat, color, mid: new THREE.Vector3(), segs, n: wr.n, anim: 0, flash: 0, glow: 0, gone: false, ball: null, owner, shown: '' };
    if (this.mysteryOf[owner] && w === owner) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.mysteryTex, depthTest: false }));
      sp.scale.setScalar(0.42);
      sp.renderOrder = 5;
      group.add(sp);
      v.mystery = sp;
    }
    this.ropes[w] = v;
  }

  /** Everything follows the rules: slots, handles, ropes. */
  private synced = -1;
  private syncAll(dt: number): void {
    const r = this.rules;
    if (!r) return;
    // slots (Expansion may add or take some away)
    for (let i = 0; i < r.slots.length; i++) if (!this.slotViews[i]) this.addSlot(i);
    while (this.slotViews.length > r.slots.length) { const v = this.slotViews.pop()!; this.board.remove(v.dish, v.lip, v.ring, v.cross); }
    if (this.slotViews.length && (r.slots.length !== this.slotCount)) {
      this.slotCount = r.slots.length;
      const xs = r.slots.map((s) => s.x), zs = r.slots.map((s) => s.z);
      this.bounds = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
      this.layoutSlab();
    }
    // a long map: when the window slides, the board on screen follows it
    if (r.winRows < r.rows && this.winShown !== r.winMin) { this.winShown = r.winMin; this.layoutSlab(); }
    r.slots.forEach((s, i) => {
      const v = this.slotViews[i];
      const shown = r.rowShown(s.row);
      v.dish.visible = v.lip.visible = s.exists && shown;
      if (!shown) { v.ring.visible = v.cross.visible = false; v.kind = 'hidden'; return; }
      const kind = !s.exists ? 'none' : s.type + (s.state === 'active' ? '+' : '') + (s.covered ? 'c' : '');
      if (kind === v.kind) return;
      v.kind = kind;
      v.ring.visible = s.state === 'active';
      v.cross.visible = s.exists && s.type === 'forbidden';
      v.mat.color.set(s.type === 'forbidden' ? 0xc9c6cf : s.covered ? 0xb3c2dc : 0xdcdce2);
      v.mat.opacity = s.type === 'preview' ? 0.45 : 1;
      (v.lip.material as THREE.MeshStandardMaterial).transparent = s.type === 'preview';
      (v.lip.material as THREE.MeshStandardMaterial).opacity = s.type === 'preview' ? 0.45 : 1;
    });
    // handles
    r.handles.forEach((h, k) => {
      const v = this.handles[k];
      if (!v) return;
      const g = v.pin.group;
      const cells = r.cellsAt(k, h.slot) ?? [h.slot];
      g.visible = !h.gone && !h.dormant && cells.every((q) => r.rowShown(r.slots[q].row));
      if (!g.visible) return;
      if (v.cog) v.cog.rotation.z += h.state === 'stable' ? 0 : dt * 6;
      if (v.timer && h.toFixedTime !== null) {
        const f = Math.max(0, 1 - r.elapsed / h.toFixedTime);
        if (Math.abs(f - v.timerAt) > 0.01) { v.timerAt = f; v.timer.geometry.dispose(); v.timer.geometry = new THREE.RingGeometry(PIN_R * 1.05, PIN_R * 1.25, 40, 1, Math.PI / 2, Math.PI * 2 * f); (v.timer.material as THREE.MeshBasicMaterial).color.set(f < 0.25 ? 0xff4a3a : 0xffb020); }
      } else if (v.timer) v.timer.visible = false;
      g.position.copy(this.pinPos(k));
      if (v.bump > 0) v.bump = Math.max(0, v.bump - dt * 3);
      const sq = Math.sin(v.bump * Math.PI * 2) * v.bump * 0.25;
      g.scale.set(h.scale * (1 + sq), h.scale * (1 - sq), h.scale * (1 + sq));
      v.nail.visible = h.fixed && h.converted === null;
      v.ring.visible = h.converted !== null;
      if (h.converted !== null) v.ringMat.color.set(CFG.convertedColors[Math.max(0, Math.min(3, h.converted - 1))]);
    });
    // the §11 props
    for (const rl of this.rails) rl.mesh.visible = r.slots[rl.i].rail !== null && r.slots[rl.i].rail === r.slots[rl.j].rail && r.rowShown(r.slots[rl.i].row);
    r.world.pillars.forEach((p, i) => { const g = this.posts[i]; if (!g) return; const k = p.gone ? Math.max(0, g.scale.y - dt * 5) : 1; g.scale.set(1, Math.max(0.001, k), 1); g.visible = k > 0.01; });
    for (const u of this.umbrellas) {
      const st = r.slots[u.slot].umbrella!;
      u.group.visible = !st.gone && r.rowShown(r.slots[u.slot].row);
      u.open += ((st.isOpen ? 1 : 0) - u.open) * Math.min(1, dt * 6);
      u.canopy.scale.set(0.25 + 0.75 * u.open, 1 + (1 - u.open) * 1.2, 0.25 + 0.75 * u.open);
    }
    r.traps.forEach((t, i) => {
      const dv = this.doors[i];
      if (!dv) return;
      if (t.state === 'closed') { dv.group.visible = true; return; }
      dv.t = Math.min(1, dv.t + dt / 0.5);
      dv.group.position.y = -dv.t * 0.4;
      dv.group.scale.setScalar(Math.max(0.001, 1 - dv.t * 0.3));
      dv.group.visible = t.state !== 'open' || dv.t < 1;
    });
    // ropes (redrawn only when the physics moved)
    for (let w = 0; w < r.world.ropes.length; w++) if (!this.ropes[w]) this.addRope(w);
    const moved = this.synced !== r.world.steps;
    this.synced = r.world.steps;
    r.world.ropes.forEach((wr, w) => {
      const v = this.ropes[w];
      if (v.gone && v.anim >= 1) return;
      v.group.visible = !wr.gone || (v.gone && v.anim < 1 && !!v.ball);
      if (wr.gone) { v.tube.visible = v.line.visible = false; return; }
      const ends = wr.h.filter((q) => q >= 0);
      const shown = ends.length === 0 || ends.some((q) => this.handles[q]?.pin.group.visible);
      v.tube.visible = v.line.visible = shown;
      if (!shown) return;
      if (moved || dt === 0) { v.buf.update(wr.x, wr.n, 0, 0); v.lbuf.update(wr.x, wr.n, 0, 0); v.buf.mid(v.mid); }
      if (v.mystery) v.mystery.position.copy(v.mid).add(new THREE.Vector3(0, 0.32, 0));
      // stretched past the warning rate: orange → red (as the rules measure it)
      const warn = r.warn[v.owner] ?? -1, key = this.ropeColors[v.owner] + ':' + warn.toFixed(2);
      if (key !== v.shown) {
        v.shown = key;
        const c = ropeColor(new THREE.Color(this.ropeColors[v.owner]));
        if (warn >= 0) c.copy(WARN).lerp(SNAP, warn);
        v.mat.color.copy(c);
      }
    });
  }
  private slotCount = 0;

  /** The board point under a page point, on the plane at height y. */
  boardPoint(x: number, y: number, h = 0): THREE.Vector3 | null {
    const nx = ((x - this.view.x) / this.view.w) * 2 - 1;
    const ny = -(((y - this.view.y) / this.view.h) * 2 - 1);
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), new THREE.Vector3());
  }
  /** The handle under the page point (enlarged touch area), or -1. */
  pickPin(x: number, y: number): number {
    let best = -1, bd = Infinity;
    const lim = Math.max(26, this.pinPx() * 1.35);
    this.rules?.handles.forEach((h, k) => {
      if (h.gone) return;
      const q = this.toScreen(this.pinPos(k).add(new THREE.Vector3(0, PIN_H, 0)));
      const dd = Math.hypot(q.x - x, q.y - y);
      if (dd < lim && dd < bd) { bd = dd; best = k; }
    });
    return best;
  }
  /** The slot nearest the page point (within reach), or -1. */
  pickHole(x: number, y: number, reach = 1.6): number {
    let best = -1, bd = Infinity;
    const lim = Math.max(28, this.pinPx() * reach);
    this.rules?.slots.forEach((s, i) => {
      if (!s.exists) return;
      const q = this.toScreen(new THREE.Vector3(s.x, 0, s.z));
      const dd = Math.hypot(q.x - x, q.y - y);
      if (dd < lim && dd < bd) { bd = dd; best = i; }
    });
    return best;
  }
  /** A slot's place on the page (css px). */
  holeScreen(s: number, y = 0): { x: number; y: number } { return this.toScreen(this.holePos(s, y)); }
  /** A handle's place on the page (css px). */
  pinScreen(k: number): { x: number; y: number } { return this.toScreen(this.pinPos(k).add(new THREE.Vector3(0, PIN_H, 0))); }
  /** Pin radius on screen (css px). */
  pinPx(): number {
    const a = this.toScreen(new THREE.Vector3(0, PIN_H, 0)), b = this.toScreen(new THREE.Vector3(PIN_R, PIN_H, 0));
    return Math.abs(b.x - a.x);
  }
  setColor(i: number, color: string): void {
    this.ropeColors[i] = color;
    this.handles.forEach((v, k) => { if (this.rules!.handles[k].ropes[0] === i) { v.color.set(color); v.pin.body.color.set(color); v.pin.top.color.set(color).multiplyScalar(0.78); v.pin.rim.color.copy(ropeColor(new THREE.Color(color))).multiplyScalar(0.35); } });
    this.ropes.forEach((v) => { if (v && v.owner === i && v.mystery) v.mystery.visible = false; });
  }
  /** A white pulse on rope i ("this is the one you need"). */
  glow(i: number): void { const v = this.viewOf(i); if (v) v.glow = 1; }
  flash(i: number): void { const v = this.viewOf(i); if (v) v.flash = 1; }
  setHighlight(i: number, a: number): void { const v = this.viewOf(i); if (v && !v.flash && !v.glow) { v.mat.emissive.set(0x9cff7a); v.mat.emissiveIntensity = a; } }
  private viewOf(i: number): RopeView | undefined { const w = this.rules?.ropes[i]?.w; return w === undefined ? undefined : this.ropes[w]; }
  midOf(i: number): THREE.Vector3 { return this.viewOf(i)?.mid.clone() ?? new THREE.Vector3(); }
  /** Rope i has come off: a wound ball rises where it was (the 2D ball then flies to the trays). */
  setGone(i: number): void {
    const v = this.viewOf(i);
    if (!v || v.gone) return;
    v.gone = true;
    v.anim = 0;
    v.ball = ropeBall(v.color);
    v.ball.position.copy(v.mid);
    this.board.add(v.ball);
  }
  /** A handle bounces (it has just landed, or it can't move). */
  bumpPin(k: number): void { const v = this.handles[k]; if (v) v.bump = 1; }
  /** The board shakes (hammer). */
  shake(t = CFG.shakeDuration): void { this.shakeT = t; }

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
    this.syncAll(dt);
    // the board shakes under the hammer
    this.shakeT = Math.max(0, this.shakeT - dt);
    const k0 = this.shakeT / CFG.shakeDuration;
    this.board.position.set(Math.sin(this.clock * 70) * 0.06 * k0, 0, Math.cos(this.clock * 53) * 0.12 * k0);
    this.ropes.forEach((v) => {
      if (!v) return;
      if (v.gone && v.ball && v.anim < 1) {
        v.anim = Math.min(1, v.anim + dt / COIL);
        const k = v.anim, e = k * k * (3 - 2 * k);
        v.ball.visible = k < 1;
        v.ball.scale.setScalar(Math.max(0.001, 0.25 + 0.75 * e));
        v.ball.position.copy(v.mid).add(new THREE.Vector3(0, 0.2 + e * 0.5, 0));
        v.ball.rotation.set(k * 9, k * 5, 0);
        if (k >= 1) v.group.visible = false;
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
      const fo = this.frameOut, y = -0.02, cx = this.target.x, cz = this.target.z;
      const l = this.toScreen(new THREE.Vector3(cx - this.zoom.w / 2 - fo, y, cz - this.zoom.d / 2 - fo));
      const r = this.toScreen(new THREE.Vector3(cx + this.zoom.w / 2 + fo, y, cz - this.zoom.d / 2 - fo));
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

  /** The rope under the page point (css px) and the bead nearest it, preferring the one on top; null if none. */
  pick(x: number, y: number): { rope: number; bead: number } | null {
    const r = this.rules;
    if (!r) return null;
    let best: { rope: number; bead: number } | null = null, bd = Infinity;
    const lim = Math.max(26, this.pinPx() * 1.1), p = new THREE.Vector3();
    r.ropes.forEach((m, i) => {
      if (m.gone) return;
      const wr = r.world.ropes[m.w];
      for (let q = 0; q < wr.n; q++) {
        p.set(wr.x[q * 3], wr.x[q * 3 + 1], wr.x[q * 3 + 2]);
        const s = this.toScreen(p), dd = Math.hypot(s.x - x, s.y - y) - p.y * 20;
        if (dd < lim && dd < bd) { bd = dd; best = { rope: i, bead: q }; }
      }
    });
    return best;
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
