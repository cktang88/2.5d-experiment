// Character sprite sheets as smooth inked vector drawings (Canvas2D paths, flat colours, cel-shade
// crescents, a heavy outer contour). Same layout the entities expect: 4 walk frames across x 3 views
// down (front, back, side facing right). Every cell is drawn in a 32 x 32 unit space (the old pixel
// grid, so the feet still stand on y = 30 and hitbox-to-sprite proportions are unchanged) and rendered
// at CELL px, then baked into a mipmapped texture.
import * as THREE from 'three';
import { Pen, INK, canvas, get2d, inkContour, bake, capsule, ellipse, rrect, blob, poly, curve, shade, mix } from './draw';

export interface Palette {
  skin: string; skinDark: string; eye: string; hair: string;
  shirt: string; shirtLight: string; shirtDark: string; belt: string;
  pants: string; pantsDark: string; boots: string;
  cape?: string; capeDark?: string; accent?: string;
  hat?: string; hatBand?: string;
}

/** pixels per sprite cell (32 drawing units) */
export const CELL = 256;
const U = CELL / 32;
const GROUND = 30;
/** extra outer contour, in drawing units */
const OUTER = 0.42;

type Kind = 'player' | 'zombie' | 'brute';
type V2 = [number, number];

/** two-bone joint (knee/elbow) between a and b for a limb of total length L, bending toward dir */
function joint(a: V2, b: V2, L: number, dir: V2): V2 {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1e-6;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  if (d >= L) return [mx, my];
  const h = Math.sqrt((L / 2) ** 2 - (d / 2) ** 2);
  let px = -dy / d, py = dx / d;
  if (px * dir[0] + py * dir[1] < 0) { px = -px; py = -py; }
  return [mx + px * h, my + py * h];
}

/** rotate drawing about a pivot for the rest of a save()/restore() block */
function pivot(c: CanvasRenderingContext2D, x: number, y: number, a: number): void { c.translate(x, y); c.rotate(a); c.translate(-x, -y); }

// ---------------- body proportions per kind ----------------
interface Body {
  hipY: number; shY: number; torsoW: number; waistW: number;
  headY: number; headRX: number; headRY: number;
  legW: number; armW: number; legL: number; armL: number; hipHalf: number; handR: number;
}
const BODY: Record<Kind, Body> = {
  player: { hipY: 23.2, shY: 15.4, torsoW: 8.6, waistW: 7.6, headY: 9.7, headRX: 5.7, headRY: 5.1, legW: 2.4, armW: 1.9, legL: 6.9, armL: 6.4, hipHalf: 2.0, handR: 1.05 },
  zombie: { hipY: 23.2, shY: 15.8, torsoW: 8.4, waistW: 7.2, headY: 10.2, headRX: 5.3, headRY: 4.9, legW: 2.3, armW: 1.85, legL: 6.9, armL: 6.8, hipHalf: 2.0, handR: 1.25 },
  brute: { hipY: 22.6, shY: 13.6, torsoW: 13.6, waistW: 10.4, headY: 10.0, headRX: 4.3, headRY: 4.0, legW: 3.5, armW: 3.4, legL: 7.6, armL: 10.2, hipHalf: 2.9, handR: 2.1 },
};

// ---------------- heads ----------------
function headPath(cx: number, cy: number, rx: number, ry: number, kind: Kind): Path2D {
  // a soft rounded "bean": wider jaw for the brute, a slightly squarer skull for zombies
  if (kind === 'brute') return blob([[cx - rx, cy - ry * 0.2], [cx - rx * 0.6, cy - ry], [cx + rx * 0.6, cy - ry], [cx + rx, cy - ry * 0.2], [cx + rx * 1.1, cy + ry * 0.7], [cx, cy + ry * 1.1], [cx - rx * 1.1, cy + ry * 0.7]]);
  if (kind === 'zombie') return blob([[cx - rx, cy - ry * 0.1], [cx - rx * 0.75, cy - ry * 0.95], [cx + rx * 0.2, cy - ry * 1.05], [cx + rx * 0.95, cy - ry * 0.6], [cx + rx, cy + ry * 0.4], [cx + rx * 0.45, cy + ry], [cx - rx * 0.5, cy + ry * 0.98], [cx - rx * 0.98, cy + ry * 0.5]]);
  return ellipse(cx, cy, rx, ry);
}

function playerHat(pen: Pen, cx: number, top: number, view: number, pal: Palette): void {
  const hat = pal.hat!, band = pal.hatBand!;
  const fwd = view === 2 ? 0.9 : 0;
  // back half of the brim first (front/back views see the brim from slightly above)
  const brim = ellipse(cx + fwd, top + 4.6, view === 2 ? 7.4 : 8.1, view === 2 ? 1.5 : 2.0, view === 2 ? 0.05 : 0);
  pen.shape(brim, hat, { shade: shade(hat, 0.35), sd: 1.0 });
  // crown: a soft dome with a pinched top
  const crown = blob([[cx - 4.6 + fwd * 0.4, top + 4.4], [cx - 4.2, top + 1.6], [cx - 1.6, top + 0.2], [cx + 0.2, top + 0.9], [cx + 2.0, top + 0.1], [cx + 4.4, top + 1.6], [cx + 4.8 + fwd * 0.4, top + 4.4]], 0.9);
  pen.shape(crown, hat, { sd: 1.3 });
  // band
  const b = new Path2D();
  b.moveTo(cx - 4.7 + fwd * 0.4, top + 3.0); b.quadraticCurveTo(cx, top + 3.8, cx + 4.9 + fwd * 0.4, top + 3.0);
  b.lineTo(cx + 4.9 + fwd * 0.4, top + 4.5); b.quadraticCurveTo(cx, top + 5.3, cx - 4.7 + fwd * 0.4, top + 4.5); b.closePath();
  pen.shape(b, band, { sd: 0.6, ld: 0.3 });
  if (view === 2) { // a small feather tucked in the band, swept back
    const f = blob([[cx - 3.2, top + 3.6], [cx - 5.6, top + 1.4], [cx - 6.4, top + 0.4], [cx - 4.6, top + 1.2], [cx - 2.6, top + 2.8]], 0.9);
    pen.shape(f, '#f2ead6', { shade: '#c4b8a0', sd: 0.5, lw: 0.42 });
  }
}

function drawHead(pen: Pen, kind: Kind, view: number, frame: number, pal: Palette, B: Body, cx: number, cy: number): void {
  const c = pen.ctx, rx = B.headRX, ry = B.headRY;
  const hp = headPath(cx, cy, rx, ry, kind);
  pen.shape(hp, pal.skin, { shade: pal.skinDark, sd: 1.3 });
  if (view === 0) {
    if (kind === 'player') {
      // big friendly eyes with catchlights, brows, blush and a small smile
      for (const s of [-1, 1]) {
        const ex = cx + s * 2.15, ey = cy + 0.9;
        pen.fill(ellipse(ex, ey, 0.95, 1.3), pal.eye);
        pen.dot(ex - 0.32, ey - 0.45, 0.38, '#ffffff');
        pen.dot(ex + 0.3, ey + 0.5, 0.16, '#ffffff');
        pen.line(curve([[ex - 1.0 * s * -1, ey - 2.2], [ex, ey - 2.55], [ex + 1.0 * s, ey - 2.1]]), 0.42, mix(pal.hair, INK, 0.3));
        c.globalAlpha = 0.45; pen.fill(ellipse(cx + s * 3.6, cy + 2.5, 1.1, 0.6), '#ff7a7a'); c.globalAlpha = 1;
      }
      pen.line(curve([[cx - 0.9, cy + 3.1], [cx, cy + 3.7], [cx + 0.9, cy + 3.1]]), 0.42, INK);
    } else if (kind === 'zombie') {
      // mismatched eyes: one wide and staring, one droopy and half lidded, glowing pupils
      const L: V2 = [cx - 2.1, cy + 0.4], R: V2 = [cx + 2.2, cy + 0.9];
      c.globalAlpha = 0.35; pen.fill(ellipse(L[0], L[1] + 0.5, 1.9, 1.9), pal.skinDark); pen.fill(ellipse(R[0], R[1] + 0.4, 1.5, 1.5), pal.skinDark); c.globalAlpha = 1;
      pen.shape(ellipse(L[0], L[1], 1.45, 1.55), '#f2efc6', { shade: '#c9c49a', sd: 0.6, lw: 0.4 });
      pen.dot(L[0] + 0.25, L[1] + 0.2, 0.62, pal.eye); pen.dot(L[0] + 0.05, L[1], 0.22, '#fff8e0');
      pen.shape(ellipse(R[0], R[1], 1.1, 1.05), '#f2efc6', { shade: null, light: null, lw: 0.4 });
      pen.dot(R[0] - 0.15, R[1] + 0.3, 0.5, pal.eye);
      const lid = new Path2D(); lid.moveTo(R[0] - 1.35, R[1] + 0.05); lid.quadraticCurveTo(R[0], R[1] - 1.7, R[0] + 1.35, R[1] - 0.25); lid.closePath();
      pen.shape(lid, pal.skinDark, { shade: null, light: null, lw: 0.4 });
      // gaping jagged mouth
      const m = poly([[cx - 2.0, cy + 2.9], [cx + 1.8, cy + 2.6], [cx + 1.3, cy + 4.1], [cx - 0.2, cy + 4.6], [cx - 1.6, cy + 4.1]]);
      pen.shape(m, '#4a1a22', { shade: null, light: null, lw: 0.45 });
      pen.fill(poly([[cx - 1.4, cy + 2.95], [cx - 0.9, cy + 3.75], [cx - 0.5, cy + 2.85]]), '#efe6c8');
      pen.fill(poly([[cx + 0.4, cy + 2.8], [cx + 0.85, cy + 3.6], [cx + 1.3, cy + 2.7]]), '#efe6c8');
      // stitched scar across the brow
      pen.line(curve([[cx + 0.6, cy - 2.8], [cx + 2.6, cy - 2.2], [cx + 4.2, cy - 2.9]]), 0.3, INK);
      for (let i = 0; i < 3; i++) pen.line(curve([[cx + 1.1 + i * 1.1, cy - 3.3], [cx + 1.3 + i * 1.1, cy - 1.9]]), 0.25, INK);
    } else {
      // brute: beady glowing eyes under a heavy brow, underbite with tusks
      pen.shape(blob([[cx - 3.9, cy - 0.6], [cx, cy - 1.9], [cx + 3.9, cy - 0.6], [cx + 3.2, cy + 0.5], [cx - 3.2, cy + 0.5]]), pal.skinDark, { shade: null, sd: 0.4, lw: 0.4 });
      for (const s of [-1, 1]) { pen.dot(cx + s * 1.7, cy + 0.95, 0.7, '#2a1a12'); pen.dot(cx + s * 1.7, cy + 0.95, 0.42, pal.eye); }
      const jaw = blob([[cx - 3.0, cy + 2.4], [cx + 3.0, cy + 2.4], [cx + 2.4, cy + 3.9], [cx - 2.4, cy + 3.9]]);
      pen.shape(jaw, '#4a1a22', { shade: null, light: null, lw: 0.4 });
      for (const s of [-1, 1]) pen.shape(poly([[cx + s * 2.3, cy + 3.7], [cx + s * 2.0, cy + 1.5], [cx + s * 1.3, cy + 3.7]]), '#f0e6c4', { shade: null, light: null, lw: 0.3 });
    }
  } else if (view === 2) {
    if (kind === 'player') {
      const ex = cx + 2.9, ey = cy + 0.8;
      pen.fill(ellipse(ex, ey, 0.75, 1.25), pal.eye);
      pen.dot(ex - 0.2, ey - 0.45, 0.33, '#ffffff');
      pen.line(curve([[ex - 0.9, ey - 2.3], [ex + 0.3, ey - 2.6], [ex + 1.1, ey - 2.2]]), 0.42, mix(pal.hair, INK, 0.3));
      c.globalAlpha = 0.45; pen.fill(ellipse(cx + 2.4, cy + 2.6, 1.0, 0.55), '#ff7a7a'); c.globalAlpha = 1;
      pen.fill(ellipse(cx + rx - 0.25, cy + 1.75, 0.55, 0.5), pal.skin); // nose: a small bump on the profile
      pen.line(curve([[cx + rx - 0.05, cy + 1.2], [cx + rx + 0.45, cy + 1.8], [cx + rx - 0.1, cy + 2.25]]), 0.4, INK);
      pen.line(curve([[cx + 3.0, cy + 3.3], [cx + 3.8, cy + 3.5]]), 0.38, INK);
      // ear
      pen.shape(ellipse(cx - 1.0, cy + 1.2, 0.75, 1.0), pal.skin, { shade: pal.skinDark, sd: 0.4, lw: 0.38 });
    } else if (kind === 'zombie') {
      const ex = cx + 2.5, ey = cy + 0.4;
      pen.shape(ellipse(ex, ey, 1.25, 1.35), '#f2efc6', { shade: null, light: null, lw: 0.4 });
      pen.dot(ex + 0.45, ey + 0.2, 0.55, pal.eye);
      const m = poly([[cx + 2.0, cy + 2.9], [cx + rx + 0.2, cy + 2.4], [cx + rx - 0.1, cy + 4.0], [cx + 2.6, cy + 4.3]]);
      pen.shape(m, '#4a1a22', { shade: null, light: null, lw: 0.4 });
      pen.fill(poly([[cx + 3.4, cy + 2.7], [cx + 3.8, cy + 3.5], [cx + 4.2, cy + 2.6]]), '#efe6c8');
      pen.shape(poly([[cx - 1.6, cy + 0.2], [cx - 0.6, cy - 0.2], [cx - 0.5, cy + 1.0], [cx - 0.9, cy + 1.3], [cx - 0.6, cy + 1.9], [cx - 1.5, cy + 2.0]]), pal.skinDark, { shade: null, light: null, lw: 0.36 });
      pen.line(curve([[cx - 3.0, cy - 2.6], [cx - 2.0, cy - 1.4], [cx - 2.8, cy - 0.2]]), 0.3, INK);
    } else {
      pen.shape(blob([[cx + 0.6, cy - 0.9], [cx + rx + 0.6, cy - 0.5], [cx + rx + 0.3, cy + 0.4], [cx + 0.8, cy + 0.2]]), pal.skinDark, { shade: null, lw: 0.4 });
      pen.dot(cx + 2.6, cy + 1.0, 0.65, '#2a1a12'); pen.dot(cx + 2.6, cy + 1.0, 0.4, pal.eye);
      pen.shape(blob([[cx + 1.4, cy + 2.4], [cx + rx + 0.9, cy + 2.2], [cx + rx + 0.6, cy + 3.9], [cx + 1.6, cy + 3.8]]), '#4a1a22', { shade: null, light: null, lw: 0.4 });
      pen.shape(poly([[cx + rx + 0.1, cy + 3.7], [cx + rx + 0.4, cy + 1.4], [cx + rx - 0.6, cy + 3.7]]), '#f0e6c4', { shade: null, light: null, lw: 0.3 });
    }
  }
  // hair / hat
  if (kind === 'player') {
    const hair = pal.hair;
    if (view === 0) {
      // fringe and side locks peeking from under the hat
      pen.shape(blob([[cx - rx - 0.2, cy - 0.8], [cx - rx + 0.3, cy - 3.6], [cx + rx - 0.3, cy - 3.6], [cx + rx + 0.2, cy - 0.8], [cx + 3.2, cy - 2.2], [cx + 1.0, cy - 1.4], [cx - 1.4, cy - 2.4], [cx - 3.4, cy - 1.6]]), hair, { sd: 0.7 });
      pen.shape(blob([[cx - rx - 0.4, cy - 2.0], [cx - rx + 1.3, cy - 1.6], [cx - rx + 0.8, cy + 2.0], [cx - rx - 0.3, cy + 1.2]]), hair, { sd: 0.5 });
      pen.shape(blob([[cx + rx + 0.4, cy - 2.0], [cx + rx - 1.3, cy - 1.6], [cx + rx - 0.8, cy + 2.0], [cx + rx + 0.3, cy + 1.2]]), hair, { sd: 0.5 });
    } else if (view === 1) {
      pen.shape(blob([[cx - rx - 0.4, cy - 3.0], [cx + rx + 0.4, cy - 3.0], [cx + rx + 0.3, cy + 1.8], [cx + 2.2, cy + 3.4], [cx + 0.4, cy + 2.6], [cx - 1.6, cy + 3.5], [cx - rx - 0.3, cy + 1.8]]), hair, { sd: 1.0 });
    } else {
      pen.shape(blob([[cx - rx - 0.3, cy - 3.0], [cx + 2.6, cy - 3.6], [cx + 3.2, cy - 2.0], [cx + 0.6, cy - 2.2], [cx - 0.6, cy + 0.4], [cx - 2.4, cy + 3.0], [cx - rx - 0.4, cy + 1.6]]), hair, { sd: 0.8 });
    }
    playerHat(pen, cx, cy - ry - 2.6, view, pal);
  } else if (kind === 'zombie') {
    // a few lank tufts on a balding scalp
    const hair = pal.hair, top = cy - ry;
    const tuft = (x: number, y: number, a: number, l: number): void => { // a lank strand flopping over
      const tip: V2 = [x + Math.sin(a) * l, y - Math.cos(a) * l * 0.55];
      const s = curve([[x, y + 0.5], [x + Math.sin(a) * l * 0.4, y - l * 0.55], tip]);
      pen.line(s, 1.05, INK); pen.line(s, 0.5, hair);
    };
    if (view === 1) {
      const cap = poly([[cx - rx + 0.1, cy + 0.6], [cx - rx + 0.2, cy - 2.4], [cx - 2.4, top + 0.3], [cx + 2.2, top + 0.2], [cx + rx - 0.1, cy - 2.2], [cx + rx, cy + 0.8], [cx + 3.4, cy - 0.2], [cx + 2.6, cy + 1.6], [cx + 1.2, cy + 0.2], [cx - 0.2, cy + 1.8], [cx - 1.4, cy + 0.0], [cx - 2.8, cy + 1.4], [cx - 3.6, cy - 0.2]]);
      pen.shape(cap, hair, { sd: 0.6, lw: 0.4 });
      tuft(cx - 1.6, top + 0.6, -1.0, 2.2);
      pen.line(curve([[cx - 1.5, cy + 2.6], [cx, cy + 3.0], [cx + 1.6, cy + 2.4]]), 0.3, INK);
    } else if (view === 2) {
      pen.shape(blob([[cx - rx + 0.1, cy - 0.4], [cx - 2.8, top + 0.4], [cx + 0.6, top + 0.1], [cx - 0.4, cy - 1.6]]), hair, { sd: 0.5 });
      tuft(cx + 1.4, top + 0.5, 0.5, 2.2);
    } else {
      pen.shape(blob([[cx - rx + 0.3, cy - 1.6], [cx - 3.0, top + 0.5], [cx - 0.6, top + 0.1], [cx - 1.4, top + 1.6], [cx - 3.4, cy - 1.2]]), hair, { sd: 0.5, lw: 0.4 });
      tuft(cx + 0.4, top + 0.4, 1.1 + (frame % 2) * 0.15, 2.6); tuft(cx + 2.2, top + 0.9, 1.4, 2.0);
    }
  } else if (view !== 0) {
    pen.line(curve([[cx - 2.0, cy - ry + 1.2], [cx - 0.6, cy - ry + 2.4], [cx + 0.6, cy - ry + 1.5]]), 0.3, INK); // scar
  }
}

// ---------------- the humanoid drawing ----------------
function drawHumanoid(pen: Pen, view: number, frame: number, pal: Palette, kind: Kind): void {
  const c = pen.ctx, B = BODY[kind];
  const zom = kind !== 'player';
  const bob = (frame === 1 || frame === 3) ? (kind === 'brute' ? 0.9 : 0.7) : 0;
  const hipY = B.hipY + bob, shY = B.shY + bob, cx = 16;
  const ph = [0, 1, 0, -1][frame];
  const shirt = pal.shirt, pants = pal.pants;

  // a frayed tear in the cloth showing skin underneath (irregular, so it reads as torn, not as a patch)
  const rip = (x: number, y: number, r: number, k: number): void => {
    const pts: number[][] = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + k, rr = r * (i % 2 ? 0.55 : 1) * (0.8 + 0.4 * Math.abs(Math.sin(k * 3.1 + i * 1.7)));
      pts.push([x + Math.cos(a) * rr * 1.25, y + Math.sin(a) * rr]);
    }
    pen.shape(poly(pts), pal.skin, { shade: pal.skinDark, sd: r * 0.5, light: null, lw: 0.3 });
  };
  // feet / boots
  const boot = (ax: number, ay: number, side: boolean, lift: number): void => {
    const s = kind === 'brute' ? 1.35 : 1;
    if (side) {
      const p = blob([[ax - 1.3 * s, ay - 0.9 * s], [ax + 0.6 * s, ay - 1.0 * s], [ax + 2.3 * s, ay + 0.2 * s], [ax + 2.2 * s, GROUND - lift], [ax - 1.4 * s, GROUND - lift]], 0.7);
      pen.shape(p, pal.boots, { sd: 0.6 });
    } else {
      pen.shape(blob([[ax - 1.45 * s, ay - 0.8 * s], [ax + 1.45 * s, ay - 0.8 * s], [ax + 1.7 * s, GROUND - lift - 0.2], [ax, GROUND - lift + 0.1], [ax - 1.7 * s, GROUND - lift - 0.2]], 0.8), pal.boots, { sd: 0.6 });
    }
  };
  const legFront = (sx: number, lift: number, kneeOut: number): void => {
    const hip: V2 = [cx + sx * B.hipHalf, hipY - 0.6], ank: V2 = [cx + sx * (B.hipHalf + 0.25), GROUND - 1.0 - lift];
    const knee = joint(hip, ank, B.legL - 0.4, [sx * kneeOut, -0.2]);
    pen.limb([hip, knee, ank], B.legW, pants, { shade: pal.pantsDark });
    if (zom && sx < 0) rip(knee[0] + (ank[0] - knee[0]) * 0.3, knee[1] + (ank[1] - knee[1]) * 0.3, kind === 'brute' ? 0.9 : 0.62, 1.3); // torn trouser leg
    boot(ank[0], ank[1], false, lift);
  };
  const legSide = (fx: number, lift: number, far: boolean): void => {
    const hip: V2 = [cx + (kind === 'brute' ? 0.4 : 0.2), hipY - 0.6], ank: V2 = [fx, GROUND - 1.0 - lift];
    const knee = joint(hip, ank, B.legL, [1, 0]);
    const col = far ? pal.pantsDark : pants;
    pen.limb([hip, knee, ank], B.legW, col, { shade: far ? shade(pal.pantsDark, 0.2) : pal.pantsDark });
    if (zom && !far) rip(knee[0] + (ank[0] - knee[0]) * 0.3, knee[1] + (ank[1] - knee[1]) * 0.3, kind === 'brute' ? 0.9 : 0.62, 2.1);
    boot(ank[0], ank[1], true, lift);
  };

  // torso: rounded trapezoid, shirt with a light yoke; zombies get a ragged hem and holes
  const torso = (): void => {
    const tw = B.torsoW / 2, ww = B.waistW / 2;
    const side = view === 2;
    const tl = side ? -tw * 0.62 : -tw, tr = side ? tw * 0.62 : tw;
    const bl = side ? -ww * 0.66 : -ww, br = side ? ww * 0.66 : ww;
    const hemY = hipY + (zom ? 0.9 : 0.4);
    // pants seat / hips
    pen.shape(rrect(cx + bl - 0.1, hipY - 1.9, br - bl + 0.2, 2.8, 1.1), pants, { shade: pal.pantsDark, sd: 0.8 });
    let p: Path2D;
    if (kind === 'brute' && side) {
      // side-on the brute is a hulking hump: a rounded back rising over the shoulders, a deep chest
      p = blob([[cx - 3.4, hipY - 0.2], [cx - 4.8, shY + 4.0], [cx - 3.6, shY - 0.2], [cx - 0.4, shY - 1.6], [cx + 3.4, shY + 0.2], [cx + 4.8, shY + 4.2], [cx + 4.0, hipY - 0.8], [cx + 1.2, hipY + 1.0], [cx - 1.6, hipY + 0.6]], 0.9);
    } else if (zom) {
      const pts: number[][] = [[cx + tl, shY + 0.9], [cx + tl * 0.55, shY - 0.2], [cx + tr * 0.55, shY - 0.2], [cx + tr, shY + 0.9], [cx + br + 0.3, hemY - 1.0]];
      // ragged hem, zig-zagging back across
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = cx + br + 0.3 + (bl - br - 0.6) * t;
        pts.push([x, hemY + (i % 2 ? 0.9 : -0.2) + Math.sin(i * 2.7 + frame * 0) * 0.3]);
      }
      pts.push([cx + bl - 0.3, hemY - 1.0]);
      p = poly(pts);
      // soften the shoulders by drawing a blob underneath
      pen.shape(blob([[cx + tl, shY + 1.0], [cx + tl * 0.6, shY - 0.2], [cx + tr * 0.6, shY - 0.2], [cx + tr, shY + 1.0], [cx + br, hipY - 1.0], [cx + bl, hipY - 1.0]]), shirt, { shade: pal.shirtDark, lw: 0 });
    } else {
      p = blob([[cx + tl, shY + 1.0], [cx + tl * 0.6, shY - 0.15], [cx + tr * 0.6, shY - 0.15], [cx + tr, shY + 1.0], [cx + br + 0.2, hemY - 0.6], [cx + br - 0.4, hemY], [cx + bl + 0.4, hemY], [cx + bl - 0.2, hemY - 0.6]], 0.85);
    }
    pen.shape(p, shirt, { shade: pal.shirtDark, light: pal.shirtLight, sd: 1.6, ld: 0.7 });
    c.save(); c.clip(p);
    if (!side && kind === 'player' && view === 0) {
      // satchel strap across the chest and a collar notch
      pen.limb([[cx + tl + 0.6, shY + 0.2], [cx + br - 0.4, hipY - 2.0]], 1.0, pal.belt, { lw: 0.35 });
      pen.line(curve([[cx - 1.4, shY + 0.1], [cx, shY + 1.8], [cx + 1.4, shY + 0.1]]), 0.4, pal.shirtDark);
    }
    if (zom) {
      // holes in the shirt showing skin, and tear lines
      const holes: number[][] = view === 1 ? [[cx - 1.8, shY + 3.6, 0.8], [cx + 2.2, shY + 5.6, 0.55]] : view === 2 ? [[cx + 0.4, shY + 4.4, 0.7]] : [[cx - 2.0, shY + 4.6, 0.75], [cx + 2.4, shY + 2.4, 0.5]];
      holes.forEach(([hx, hy, r], i) => rip(hx, hy, r * (kind === 'brute' ? 1.3 : 1), 0.7 + i));
      if (kind === 'brute' && view !== 1) {
        // open vest: a strip of chest down the middle, stitches across it
        const chest = blob([[cx - 1.8 + (side ? 2.4 : 0), shY + 0.4], [cx + 1.8 + (side ? 2.4 : 0), shY + 0.4], [cx + 1.2 + (side ? 2.4 : 0), hipY - 1.6], [cx - 1.2 + (side ? 2.4 : 0), hipY - 1.6]]);
        if (!side) { pen.shape(chest, pal.skin, { shade: pal.skinDark, sd: 0.7 }); for (let i = 0; i < 3; i++) pen.line(curve([[cx - 1.0, shY + 2.2 + i * 1.6], [cx + 1.0, shY + 2.6 + i * 1.6]]), 0.3); }
      }
    }
    c.restore();
    // belt + buckle
    const belt = rrect(cx + bl - 0.3, hipY - 2.2, br - bl + 0.6, 1.25, 0.5);
    pen.shape(belt, pal.belt, { sd: 0.5, ld: 0.3, lw: 0.4 });
    if (view !== 1) {
      const bx = side ? cx + br - 0.9 : cx;
      pen.shape(rrect(bx - 0.75, hipY - 2.35, 1.5, 1.55, 0.35), kind === 'player' ? (pal.accent ?? '#e0b040') : '#9a9a8a', { sd: 0.35, ld: 0.25, lw: 0.35 });
    }
  };

  // ---------- capes (player) ----------
  const capeCol = pal.cape, capeDk = pal.capeDark ?? (capeCol ? shade(capeCol) : '');
  const flutter = [0, 1.0, 0.4, 1.2][frame];
  const capeBack = (): void => { // front view: edges of the cape behind the shoulders
    if (!capeCol) return;
    const p = blob([[cx - 4.6, shY], [cx + 4.6, shY], [cx + 6.1, hipY + 2.0], [cx + 3.0, hipY + 2.8], [cx - 3.0, hipY + 2.8], [cx - 6.1, hipY + 2.0]], 0.9);
    pen.shape(p, capeDk, { shade: shade(capeDk, 0.25), light: null });
  };
  const capeFull = (): void => { // back view: covers the back
    if (!capeCol) return;
    const hem = hipY + 2.6, w = flutter * 0.4;
    const p = new Path2D();
    p.moveTo(cx - 4.4, shY - 0.2);
    p.quadraticCurveTo(cx, shY - 1.0, cx + 4.4, shY - 0.2);
    p.quadraticCurveTo(cx + 6.4 + w, hipY - 2.0, cx + 6.6 + w, hem);
    p.quadraticCurveTo(cx + 4.8, hem + 1.0, cx + 3.3, hem - 0.1);
    p.quadraticCurveTo(cx + 1.6, hem + 1.0, cx, hem + 0.1);
    p.quadraticCurveTo(cx - 1.6, hem + 1.0, cx - 3.3, hem - 0.1);
    p.quadraticCurveTo(cx - 4.8, hem + 1.0, cx - 6.6 - w, hem);
    p.quadraticCurveTo(cx - 6.4 - w, hipY - 2.0, cx - 4.4, shY - 0.2);
    pen.shape(p, capeCol, { shade: capeDk, sd: 1.8, ld: 0.6 });
    // soft folds
    for (const fx of [-3.3, 0, 3.3]) pen.line(curve([[cx + fx * 0.5, shY + 2.4], [cx + fx * 0.8, hipY - 1.0], [cx + fx, hem - 0.4]]), 0.38, mix(capeDk, INK, 0.35));
    // collar
    pen.shape(blob([[cx - 4.0, shY - 0.4], [cx, shY - 1.2], [cx + 4.0, shY - 0.4], [cx + 2.8, shY + 1.4], [cx - 2.8, shY + 1.4]]), capeDk, { sd: 0.6, light: capeCol });
  };
  const capeSide = (): void => { // side view: billows out behind
    if (!capeCol) return;
    const hem = hipY + 2.3;
    const p = blob([[cx - 0.6, shY - 0.4], [cx + 1.2, shY + 0.2], [cx - 0.6, hipY - 1.0], [cx - 1.6, hem], [cx - 4.2 - flutter, hem + 0.4], [cx - 5.2 - flutter * 1.3, hipY - 1.2], [cx - 3.6 - flutter * 0.5, shY + 2.2]], 0.9);
    pen.shape(p, capeCol, { shade: capeDk, sd: 1.5 });
    pen.line(curve([[cx - 1.6, shY + 2.0], [cx - 3.0 - flutter * 0.4, hipY - 1.0], [cx - 3.2 - flutter * 0.8, hem]]), 0.36, mix(capeDk, INK, 0.35));
  };
  const capeFrontDrape = (): void => { // front view: cape over the shoulders + clasp
    if (!capeCol) return;
    for (const s of [-1, 1]) {
      const p = blob([[cx + s * 2.2, shY - 0.4], [cx + s * 4.8, shY - 0.1], [cx + s * 5.4, shY + 1.4], [cx + s * 4.6, shY + 3.6], [cx + s * 3.6, shY + 1.6], [cx + s * 2.0, shY + 0.8]], 0.8);
      pen.shape(p, capeCol, { shade: capeDk, sd: 0.8 });
    }
    pen.shape(ellipse(cx, shY + 0.6, 1.05, 0.95), pal.accent!, { sd: 0.5, ld: 0.3, lw: 0.4 });
  };

  // ---------- arms ----------
  const handCol = pal.skin;
  const hand = (x: number, y: number, r: number, fingers: number, dirx = 0, diry = 1): void => {
    if (fingers) { // zombie/brute: drooping fingers
      for (let i = 0; i < fingers; i++) {
        const a = (i - (fingers - 1) / 2) * 0.55, fx = x + (dirx * Math.cos(a) - diry * Math.sin(a)) * r * 1.5, fy = y + (diry * Math.cos(a) + dirx * Math.sin(a)) * r * 1.5;
        pen.shape(capsule(x, y, fx, fy, r * 0.42, r * 0.3), handCol, { shade: pal.skinDark, sd: 0.3, light: null, lw: 0.34 });
      }
    }
    pen.shape(ellipse(x, y, r, r * 0.95), handCol, { shade: pal.skinDark, sd: r * 0.5, ld: 0.3, lw: 0.42 });
  };
  const sleeveCol = kind === 'player' ? pal.shirtDark : shirt;
  const arm = (pts: V2[], far: boolean, sleeveFrac: number, fingers: number, hd: V2 = [0, 1]): void => {
    const sk = far ? pal.skinDark : pal.skin, sl = far ? shade(sleeveCol, 0.18) : sleeveCol;
    // forearm skin, then the sleeve over the upper arm (ragged cuff for the undead)
    pen.limb(pts, B.armW * (kind === 'brute' ? 0.95 : 0.9), sk, { shade: far ? shade(sk, 0.2) : pal.skinDark });
    const [a, b, e] = pts;
    const cut: V2 = sleeveFrac <= 1 ? [a[0] + (b[0] - a[0]) * sleeveFrac, a[1] + (b[1] - a[1]) * sleeveFrac] : [b[0] + (e[0] - b[0]) * (sleeveFrac - 1), b[1] + (e[1] - b[1]) * (sleeveFrac - 1)];
    pen.limb(sleeveFrac <= 1 ? [a, cut] : [a, b, cut], B.armW * 1.12, sl, { shade: far ? shade(sl, 0.2) : shade(sl) });
    if (zom && sleeveFrac > 0.4) {
      const r = B.armW * 0.62;
      pen.shape(poly([[cut[0] - r, cut[1] - r * 0.5], [cut[0] + r, cut[1] - r * 0.5], [cut[0] + r * 0.6, cut[1] + r * 0.9], [cut[0] + r * 0.1, cut[1] + r * 0.3], [cut[0] - r * 0.4, cut[1] + r * 1.0]]), sl, { shade: null, light: null, lw: 0.3 });
    }
    hand(e[0], e[1], B.handR * (far ? 0.95 : 1), fingers, hd[0], hd[1]);
  };
  const fingers = kind === 'player' ? 0 : 3;
  const sleeve = kind === 'player' ? 1.6 : kind === 'brute' ? 0.45 : 0.9;

  // ---------- assemble per view ----------
  if (view === 2) {
    const lean = kind === 'player' ? (bob ? 0.06 : 0.02) : kind === 'zombie' ? 0.22 + (frame % 2 ? 0.04 : 0) : 0.2 + (frame % 2 ? 0.03 : 0);
    const stride = kind === 'zombie' ? 2.4 : kind === 'brute' ? 2.6 : 3.1;
    const shoulder: V2 = [cx + 0.3, shY + 1.1];
    const armSwing = (s: number): V2[] => {
      const L = B.armL, a = s;
      const el: V2 = [shoulder[0] + Math.sin(a) * L * 0.5, shoulder[1] + Math.cos(a) * L * 0.5];
      const a2 = a + (kind === 'brute' ? 0.2 : 0.4);
      return [shoulder, el, [el[0] + Math.sin(a2) * L * 0.5, el[1] + Math.cos(a2) * L * 0.5]];
    };
    const reach = (dy: number, dx: number): V2[] => { // zombie arms held out in front
      const L = B.armL;
      // (raised against the body's forward lean so they end up roughly level, hands drooping)
      return [shoulder, [shoulder[0] + L * 0.5 + dx * 0.5, shoulder[1] - 0.5 + dy * 0.5], [shoulder[0] + L + dx, shoulder[1] - 0.8 + dy]];
    };
    const armBob = [0, 0.5, 0, -0.5][frame];
    // far arm (behind everything)
    c.save(); pivot(c, cx, hipY, lean);
    if (kind === 'zombie') arm(reach(-0.9 - armBob, -0.6), true, sleeve, fingers, [0.7, 0.7]);
    else if (kind === 'brute') arm(armSwing(0.35 + ph * 0.35 - lean), true, sleeve, fingers, [0.3, 1]);
    else arm(armSwing(ph * 0.55), true, sleeve, fingers);
    c.restore();
    // legs: far, then cape, then near
    legSide(cx - 0.7 - ph * stride, frame === 2 ? (kind === 'player' ? 1.6 : 0.9) : 0, true);
    c.save(); pivot(c, cx, hipY, lean); capeSide(); c.restore();
    legSide(cx + 0.7 + ph * stride, 0, false);
    // torso, head, near arm
    c.save(); pivot(c, cx, hipY, lean);
    torso();
    // (the brute's head juts forward and low from between its shoulders, under the hump of its back)
    const headX = cx + (kind === 'player' ? 0.6 : kind === 'zombie' ? 1.4 : 3.6), headY = B.headY + bob + (kind === 'brute' ? 3.4 : kind === 'zombie' ? 0.6 : 0);
    if (kind === 'player') {
      pen.shape(rrect(headX - 1.6, headY + B.headRY - 1.6, 2.6, 2.4, 0.8), pal.skinDark, { shade: null, light: null, lw: 0.4 }); // neck
    }
    c.save(); pivot(c, headX, headY + B.headRY, kind === 'zombie' ? 0.18 - lean : kind === 'brute' ? -lean * 0.6 : 0);
    drawHead(pen, kind, 2, frame, pal, B, headX, headY);
    c.restore();
    if (kind === 'zombie') arm(reach(-armBob, 0.4), false, sleeve, fingers, [0.7, 0.7]);
    else if (kind === 'brute') arm(armSwing(0.35 - ph * 0.35 - lean), false, sleeve, fingers, [0.3, 1]);
    else arm(armSwing(-ph * 0.55), false, sleeve, fingers);
    c.restore();
    return;
  }

  // front / back
  const sway = kind === 'player' ? 0 : [0, 0.05, 0, -0.05][frame] * (kind === 'brute' ? 0.6 : 1);
  const liftL = frame === 1 ? 1.1 : 0, liftR = frame === 3 ? 1.1 : 0;
  const tw = B.torsoW / 2;
  const sx = tw + (kind === 'brute' ? -0.2 : 0.1);
  const hangArm = (s: number, swing: number, far: boolean): void => {
    const sh: V2 = [cx + s * sx, shY + (kind === 'brute' ? 1.6 : 1.0)];
    const hd: V2 = [cx + s * (sx + (kind === 'brute' ? 1.3 : 0.75)), sh[1] + B.armL - 0.6 + swing];
    const el = joint(sh, hd, B.armL, [s, 0]);
    arm([sh, el, hd], far, sleeve, kind === 'brute' ? 3 : 0, [s * 0.2, 1]);
  };
  if (view === 0) {
    c.save(); pivot(c, cx, GROUND, sway);
    capeBack();
    legFront(-1, liftL, 0.3); legFront(1, liftR, 0.3);
    torso();
    capeFrontDrape();
    const headY = B.headY + bob + (kind === 'brute' ? 1.2 : 0);
    if (kind === 'brute') {
      hangArm(-1, -ph * 0.6, false); hangArm(1, ph * 0.6, false);
      drawHead(pen, kind, 0, frame, pal, B, cx, headY);
    } else {
      pen.shape(rrect(cx - 1.3, headY + B.headRY - 1.4, 2.6, 2.4, 0.8), pal.skinDark, { shade: null, light: null, lw: 0.4 }); // neck
      c.save(); pivot(c, cx, headY + B.headRY, kind === 'zombie' ? [-0.12, -0.06, 0.1, 0.04][frame] : 0);
      drawHead(pen, kind, 0, frame, pal, B, cx, headY);
      c.restore();
      if (kind === 'zombie') {
        // arms held out toward the viewer: short foreshortened upper arms, big hands in front of the belly
        const ab = [0, 0.4, 0, -0.4][frame];
        for (const s of [-1, 1]) {
          const sh: V2 = [cx + s * sx, shY + 1.0], hd: V2 = [cx + s * (sx - 0.9), shY + 5.2 + ab * s];
          arm([sh, [cx + s * (sx + 0.4), shY + 3.0 + ab * s * 0.5], hd], false, sleeve, 3, [s * 0.1, 1]);
        }
      } else { hangArm(-1, -ph * 0.7, false); hangArm(1, ph * 0.7, false); }
    }
    c.restore();
  } else {
    c.save(); pivot(c, cx, GROUND, sway);
    if (kind === 'zombie') { // arms reach away from us: stubs tucked behind the shoulders
      for (const s of [-1, 1]) arm([[cx + s * sx, shY + 1.0], [cx + s * (sx + 0.3), shY + 2.6], [cx + s * (sx - 0.4), shY + 3.6]], true, 1.6, 0);
    }
    legFront(-1, liftL, 0.3); legFront(1, liftR, 0.3);
    torso();
    if (kind === 'player' || kind === 'brute') { hangArm(-1, ph * 0.7, false); hangArm(1, -ph * 0.7, false); }
    const headY = B.headY + bob + (kind === 'brute' ? 1.2 : 0);
    if (kind !== 'brute') pen.shape(rrect(cx - 1.3, headY + B.headRY - 1.4, 2.6, 2.4, 0.8), pal.skinDark, { shade: null, light: null, lw: 0.4 });
    drawHead(pen, kind, 1, frame, pal, B, cx, headY);
    capeFull();
    c.restore();
  }
}

// ---------------- bugs (side views; the entities only use row 2 for them) ----------------
/** a jointed insect leg: the femur rises from the body to a high knee, the shin splays down to a
 *  pointed foot (low, wide stance like a beetle or spider rather than stilts) */
function bugLeg(pen: Pen, x: number, y: number, fx: number, kneeUp: number, lift: number, col: string, w: number): void {
  const foot: V2 = [fx, GROUND - 0.25 - lift];
  const knee: V2 = [x + (fx - x) * 0.55, y - kneeUp - lift * 0.4];
  pen.limb([[x, y], knee], w, col, { lw: 0.42 });
  pen.limb([knee, [fx - (fx - knee[0]) * 0.08, foot[1] - 0.5], foot], w * 0.78, col, { lw: 0.42 });
  pen.dot(knee[0], knee[1], w * 0.55, mix(col, '#ffffff', 0.18)); // glossy knee joint
}

function drawCrawler(pen: Pen, frame: number): void {
  const shell = '#5e3460', shellLt = '#a8649a', belly = '#3a2742', leg = '#4a3456';
  const bob = frame % 2 ? -0.3 : 0;
  // tripod gait: legs 0 and 2 of one side step together with leg 1 of the other
  const st = [-1, 0, 1, 0][frame];
  const attach = [13.6, 16.2, 18.8], reach = [-7.6, -2.4, 6.8];
  const by = 22.6 + bob;
  for (let i = 0; i < 3; i++) { // far legs: darker, shorter reach
    const s = i % 2 ? -st : st;
    bugLeg(pen, attach[i] - 0.6, by + 2.0, attach[i] + reach[i] * 0.8 + 1.6 + s * 1.2, 1.5, frame === 1 && i === 1 ? 0.7 : 0, mix(leg, '#000000', 0.3), 0.95);
  }
  // abdomen: three overlapping shell plates over a soft belly
  pen.shape(ellipse(11.4, by + 0.3, 7.0, 3.3, -0.06), belly, { shade: null, light: null, lw: 0.5 });
  for (let i = 0; i < 3; i++) {
    const px = 7.8 + i * 3.1, pr = 4.4 - i * 0.6, top = by - 4.0 + i * 0.5;
    const plate = blob([[px - pr, by + 1.6], [px - pr * 0.8, top + 1.2], [px + pr * 0.1, top], [px + pr * 0.95, top + 1.4], [px + pr * 1.05, by + 1.2]], 0.9);
    pen.shape(plate, shell, { shade: shade(shell, 0.32), light: shellLt, sd: 1.2, ld: 0.6, lw: 0.45 });
  }
  pen.line(curve([[5.6, by - 1.8], [8.2, by - 3.9], [11.6, by - 4.0]]), 0.6, mix(shellLt, '#ffffff', 0.45)); // gloss
  // thorax, mandibles, head
  pen.shape(ellipse(18.2, by + 0.2, 3.1, 2.9), shell, { shade: shade(shell, 0.3), light: shellLt, sd: 1.0 });
  const hx = 22.4, hy = by + 0.4, pinch = frame % 2 ? 0.5 : 0;
  pen.shape(blob([[hx + 1.4, hy + 0.6], [hx + 4.8, hy + 1.2 - pinch], [hx + 5.0, hy + 2.4 - pinch * 0.6], [hx + 3.6, hy + 3.4], [hx + 1.2, hy + 2.6]], 0.7), '#e2c8a0', { shade: '#a8885e', sd: 0.5, lw: 0.42 });
  pen.line(curve([[hx + 3.4, hy + 1.7], [hx + 4.4, hy + 2.6]]), 0.3, INK);
  pen.shape(ellipse(hx, hy, 3.3, 3.0), mix(shell, '#000000', 0.1), { shade: shade(shell, 0.42), light: shellLt, sd: 1.0 });
  // eye cluster: big glowing reds with catchlights (the read-at-a-glance feature)
  pen.shape(ellipse(hx + 1.3, hy - 0.8, 1.15, 1.05), '#ff3a30', { shade: '#b01818', light: '#ff9a80', sd: 0.5, lw: 0.35 });
  pen.shape(ellipse(hx + 2.6, hy + 0.3, 0.7, 0.65), '#ff3a30', { shade: '#b01818', light: null, sd: 0.3, lw: 0.3 });
  pen.dot(hx + 1.0, hy - 1.1, 0.32, '#ffe8e0');
  // antennae
  pen.line(curve([[hx + 0.2, hy - 2.6], [hx + 1.6, hy - 5.8], [hx + 4.8, hy - 6.6 - pinch]]), 0.5, INK);
  pen.line(curve([[hx - 0.8, hy - 2.7], [hx - 0.4, hy - 6.2], [hx + 1.8, hy - 7.6 + pinch]]), 0.5, INK);
  for (let i = 0; i < 3; i++) { // near legs
    const s = i % 2 ? st : -st;
    bugLeg(pen, attach[i], by + 2.6, attach[i] + reach[i] + s * 1.4, 1.5, frame === 3 && i === 1 ? 0.8 : 0, leg, 1.15);
  }
}

function drawSpitter(pen: Pen, frame: number): void {
  const c = pen.ctx;
  const body = '#5a3a6c', bodyLt = '#9670ae', leg = '#463054';
  const pulse = [0, 0.05, 0.08, 0.03][frame], bob = frame % 2 ? -0.3 : 0;
  const st = [-1, 0, 1, 0][frame];
  const attach = [17.0, 19.8, 22.6], reach = [-6.6, -1.8, 6.0];
  const by = 22.4 + bob;
  for (let i = 0; i < 3; i++) bugLeg(pen, attach[i] - 0.6, by + 1.6, attach[i] + reach[i] * 0.75 - 0.6 + 1.4 + (i % 2 ? st : -st) * 1.2, 1.6, 0, mix(leg, '#000000', 0.3), 1.05);
  // the acid sac: a big translucent glowing bulb (radial gradient, bubbles, veins)
  const sx = 11.4, sy = 16.4 + bob, rx = 7.8 * (1 + pulse), ry = 7.0 * (1 + pulse);
  const sac = blob([[sx - rx, sy + 0.4], [sx - rx * 0.7, sy - ry * 0.75], [sx, sy - ry], [sx + rx * 0.75, sy - ry * 0.65], [sx + rx, sy + 0.6], [sx + rx * 0.6, sy + ry * 0.8], [sx - rx * 0.5, sy + ry * 0.85]], 1);
  const g = c.createRadialGradient(sx - 2.6, sy - 3.0, 0.5, sx, sy, rx * 1.05);
  g.addColorStop(0, '#f2ffd0'); g.addColorStop(0.3, '#a8f06a'); g.addColorStop(0.75, '#4cbf38'); g.addColorStop(1, '#2a7a2c');
  pen.fill(sac, g);
  c.save(); c.clip(sac);
  pen.line(curve([[sx - 4.6, sy + 4.6], [sx - 1.6, sy + 1.0], [sx + 1.0, sy - 3.4]]), 0.4, '#2f8a2e');
  pen.line(curve([[sx + 2.6, sy + 5.4], [sx + 2.0, sy + 1.6], [sx + 4.6, sy - 1.6]]), 0.35, '#2f8a2e');
  for (const [bx, bby, r] of [[sx - 3.2, sy + 2.6, 1.0], [sx + 2.6, sy - 1.0, 0.7], [sx + 0.8, sy + 3.8, 0.55], [sx - 0.6, sy - 0.4, 0.4]]) {
    pen.fill(ellipse(bx, bby - pulse * 6, r, r), 'rgba(230,255,190,0.55)');
    pen.line(ellipse(bx, bby - pulse * 6, r, r), 0.18, 'rgba(40,120,40,0.6)');
  }
  c.restore();
  pen.line(sac, 0.55, INK);
  pen.fill(ellipse(sx - 3.4, sy - 3.6, 2.0, 1.2, -0.5), 'rgba(255,255,255,0.75)');
  pen.dot(sx - 0.8, sy - 5.0, 0.5, 'rgba(255,255,255,0.7)');
  // thorax: armoured purple segments with spikes
  for (let i = 0; i < 3; i++) {
    const px = 17.4 + i * 2.8, py = by - 0.6 - i * 0.5;
    pen.shape(poly([[px - 0.8, py - 2.8], [px + 0.3, py - 5.4 - (i === 1 ? 0.6 : 0)], [px + 1.3, py - 2.7]]), shade(body, 0.2), { shade: null, light: null, lw: 0.4 });
    pen.shape(ellipse(px, py, 3.0, 3.3), body, { shade: shade(body, 0.3), light: bodyLt, sd: 1.1, lw: 0.48 });
  }
  // head with a spitting nozzle and yellow eyes
  const hx = 26.0, hy = by - 2.6;
  pen.shape(rrect(hx + 1.6, hy + 0.3, 3.4, 2.4, 1.0), '#e8a03a', { sd: 0.5, lw: 0.42 });
  pen.fill(ellipse(hx + 5.0, hy + 1.5, 0.6, 0.85), '#7aff4a');
  pen.shape(ellipse(hx, hy, 3.4, 3.1), body, { shade: shade(body, 0.35), light: bodyLt, sd: 1.0 });
  pen.shape(ellipse(hx + 1.2, hy - 0.9, 1.1, 1.0), '#ffe040', { shade: '#c8a020', light: null, sd: 0.4, lw: 0.35 });
  pen.dot(hx + 1.5, hy - 0.8, 0.45, '#3a2010'); pen.dot(hx + 0.95, hy - 1.2, 0.22, '#fffbe0');
  pen.shape(ellipse(hx - 0.9, hy - 1.7, 0.6, 0.55), '#ffe040', { shade: null, light: null, lw: 0.3 });
  for (let i = 0; i < 3; i++) bugLeg(pen, attach[i], by + 2.2, attach[i] + reach[i] + (i % 2 ? -st : st) * 1.4, 1.6, 0, leg, 1.2);
}

function drawBat(pen: Pen, frame: number): void {
  const body = '#3c2646', belly = '#6c4a72', wing = '#5a3a6e', wingDk = '#3a2448';
  const up = [-0.5, -5.2, -2.0, 3.2][frame];
  const cy = 17 + [0, 0.6, 0.2, -0.6][frame];
  for (const s of [-1, 1]) {
    // wing membrane: root at the shoulder, three finger bones, scalloped trailing edge
    const rx = 16 + s * 2.2, ry = cy - 1.0;
    const tipX = 16 + s * (13.4 - Math.abs(up) * 0.25), tipY = cy - 3.2 + up;
    const f1: V2 = [16 + s * 8.6, cy - 3.6 + up * 0.75], f2: V2 = [16 + s * 10.4, cy + 1.6 + up * 0.55], f3: V2 = [16 + s * 6.4, cy + 3.4 + up * 0.35];
    const p = new Path2D();
    p.moveTo(rx, ry - 0.8);
    p.quadraticCurveTo(f1[0], f1[1] - 1.4, tipX, tipY);
    p.quadraticCurveTo(16 + s * 12.0, cy + 0.4 + up * 0.6, f2[0], f2[1]);
    p.quadraticCurveTo(16 + s * 8.6, cy + 1.6 + up * 0.4, f3[0], f3[1]);
    p.quadraticCurveTo(16 + s * 4.2, cy + 2.2, rx, cy + 2.6);
    p.closePath();
    pen.shape(p, wing, { shade: wingDk, sd: 1.2, light: mix(wing, '#c090d0', 0.25), ld: 0.5 });
    for (const f of [[tipX, tipY], f2, f3]) pen.line(curve([[rx, ry], [(rx + f[0]) / 2, (ry + f[1]) / 2 - 0.6], [f[0], f[1]]]), 0.42, mix(wingDk, INK, 0.5));
  }
  // ears
  for (const s of [-1, 1]) pen.shape(poly([[16 + s * 0.8, cy - 3.0], [16 + s * 2.6, cy - 7.0], [16 + s * 3.2, cy - 2.4]]), body, { shade: shade(body, 0.3), light: '#8a5a8a', sd: 0.6 });
  // furry body + lighter belly
  pen.shape(blob([[16, cy - 4.0], [19.4, cy - 1.6], [19.2, cy + 2.6], [16, cy + 4.6], [12.8, cy + 2.6], [12.6, cy - 1.6]], 1), body, { sd: 1.2, light: '#7a5080' });
  pen.fill(ellipse(16, cy + 1.6, 1.9, 2.2), belly);
  // face: glowing eyes, tiny fangs
  for (const s of [-1, 1]) { pen.dot(16 + s * 1.3, cy - 1.4, 0.75, '#ff4a4a'); pen.dot(16 + s * 1.15, cy - 1.6, 0.25, '#ffe0d0'); }
  pen.shape(poly([[15.2, cy + 0.2], [15.6, cy + 1.3], [16.0, cy + 0.2], [16.4, cy + 1.3], [16.8, cy + 0.2]]), '#f0e8d8', { shade: null, light: null, lw: 0.3 });
  // feet
  for (const s of [-1, 1]) pen.line(curve([[16 + s * 0.9, cy + 4.2], [16 + s * 1.2, cy + 5.3]]), 0.5, INK);
}

// ---------------- sheet assembly ----------------
type CellFn = (pen: Pen, view: number, frame: number) => void;

/** draw a sheet; `sideOnly` creatures (bugs, bat) only ever show row 2, so it is drawn once and copied */
function sheet(draw: CellFn, sideOnly = false): THREE.DataTexture {
  const S = CELL, out = canvas(S * 4, S * 3), o = get2d(out);
  for (let v = sideOnly ? 2 : 0; v < 3; v++) for (let f = 0; f < 4; f++) {
    o.save();
    o.beginPath(); o.rect(f * S, v * S, S, S); o.clip(); // cells never draw into each other
    o.setTransform(U, 0, 0, U, f * S, v * S);
    draw(new Pen(o), v, f);
    o.restore();
  }
  if (sideOnly) for (let v = 0; v < 2; v++) o.drawImage(out, 0, S * 2, S * 4, S, 0, S * v, S * 4, S);
  const img = o.getImageData(0, 0, out.width, out.height);
  inkContour(img, OUTER * U);
  return bake(img, { flipY: true, alphaTest: true, levels: 7 });
}

const PLAYER_PAL: Palette = {
  skin: '#f6cfa6', skinDark: '#d89c7c', eye: '#2a2440', hair: '#6a3e26',
  shirt: '#efe6cc', shirtLight: '#fffaea', shirtDark: '#c8b896', belt: '#7a4a28',
  pants: '#465478', pantsDark: '#323c5c', boots: '#5a3624',
  cape: '#2f9a92', capeDark: '#1f706e', accent: '#f2c440',
  hat: '#9a6236', hatBand: '#cc4a3a',
};
const ZOMBIE_PALS: Palette[] = [
  { skin: '#9cc086', skinDark: '#6e9264', eye: '#ff4a3a', hair: '#3a3428', shirt: '#5e7494', shirtLight: '#7a90b0', shirtDark: '#465670', belt: '#3a2a20', pants: '#6a5640', pantsDark: '#4e3e2e', boots: '#33281f' },
  { skin: '#aec48e', skinDark: '#7f9464', eye: '#ffaa20', hair: '#7a3220', shirt: '#9a5240', shirtLight: '#b46a54', shirtDark: '#6e3a2e', belt: '#2a2a2a', pants: '#44583e', pantsDark: '#32422e', boots: '#262626' },
  { skin: '#88aa98', skinDark: '#5e7e70', eye: '#ff3aa0', hair: '#d0c8b0', shirt: '#74745e', shirtLight: '#8e8e78', shirtDark: '#545446', belt: '#4a3020', pants: '#56446a', pantsDark: '#403350', boots: '#2a2030' },
];
const BRUTE_PAL: Palette = { skin: '#94a670', skinDark: '#62744c', eye: '#ffdd30', hair: '#2a2420', shirt: '#5a4434', shirtLight: '#6e5644', shirtDark: '#3e3026', belt: '#7a6a5a', pants: '#3e3e4a', pantsDark: '#2c2c36', boots: '#22222a' };

export interface SpriteSheets {
  player: THREE.Texture; brute: THREE.Texture; bat: THREE.Texture;
  zombies: THREE.Texture[]; crawler: THREE.Texture; spitter: THREE.Texture;
}

/**
 * The character sheets. Drawing and baking one high-res sheet takes a noticeable fraction of a second,
 * so only the player's is made up front: the rest are lazy (built on first use) and are also warmed up
 * one per idle moment right after start, so in practice no spawn ever waits on a drawing.
 */
export function makeSheets(): SpriteSheets {
  const lazy = (build: () => THREE.DataTexture): (() => THREE.DataTexture) => { let t: THREE.DataTexture | null = null; return () => (t ??= build()); };
  const brute = lazy(() => sheet((p, v, f) => drawHumanoid(p, v, f, BRUTE_PAL, 'brute')));
  const bat = lazy(() => sheet((p, _v, f) => drawBat(p, f), true));
  const crawler = lazy(() => sheet((p, _v, f) => drawCrawler(p, f), true));
  const spitter = lazy(() => sheet((p, _v, f) => drawSpitter(p, f), true));
  const zombie = ZOMBIE_PALS.map(pal => lazy(() => sheet((p, v, f) => drawHumanoid(p, v, f, pal, 'zombie'))));
  const zombies: THREE.Texture[] = [];
  zombie.forEach((z, i) => Object.defineProperty(zombies, i, { get: z, enumerable: true }));
  const sheets: SpriteSheets = {
    player: sheet((p, v, f) => drawHumanoid(p, v, f, PLAYER_PAL, 'player')),
    get brute() { return brute(); }, get bat() { return bat(); },
    get crawler() { return crawler(); }, get spitter() { return spitter(); },
    zombies,
  };
  const warm = [...zombie, crawler, spitter, brute, bat];
  const idle = (fn: () => void): void => { if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 2000 }); else setTimeout(fn, 60); };
  const next = (): void => { const w = warm.shift(); if (w) { w(); idle(next); } };
  idle(next);
  return sheets;
}
