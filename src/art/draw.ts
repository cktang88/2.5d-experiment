// Shared vector-art toolkit: canvases, an inked-cartoon "pen" (flat fills, cel-shade crescents,
// round-capped limbs, a thick outer contour) and the texture baker that turns a drawn canvas into a
// mipmapped DataTexture with clean alpha edges (no dark fringes, no alpha-tested features eroding
// away in the distance).
import * as THREE from 'three';

export type Ctx = CanvasRenderingContext2D;

/** warm near-black ink shared by every character, item and icon outline */
export const INK = '#2a1d29';

export function canvas(w: number, h: number): HTMLCanvasElement { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

export function get2d(c: HTMLCanvasElement): Ctx {
  // (no willReadFrequently: that forces slow software rendering, and each drawing is read back only once)
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas context unavailable');
  return ctx;
}

// ---------------- colour helpers ----------------
function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return h.length === 4
    ? [((n >> 8) & 15) * 17, ((n >> 4) & 15) * 17, (n & 15) * 17]
    : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** mix two #rrggbb colours (t = 0 -> a) */
export function mix(a: string, b: string, t: number): string {
  const A = hexRgb(a), B = hexRgb(b);
  const c = (i: number): string => Math.round(A[i] + (B[i] - A[i]) * t).toString(16).padStart(2, '0');
  return '#' + c(0) + c(1) + c(2);
}
/** darker, slightly cooler/purpler tone for cel shadows (shadows tint toward violet, not grey) */
export const shade = (c: string, k = 0.28): string => mix(c, '#2c1f45', k);
/** lighter, warmer tone for rim highlights */
export const light = (c: string, k = 0.3): string => mix(c, '#fff6dc', k);

// ---------------- path helpers ----------------
/** tapered capsule from (x0,y0) radius r0 to (x1,y1) radius r1 */
export function capsule(x0: number, y0: number, x1: number, y1: number, r0: number, r1 = r0): Path2D {
  const p = new Path2D(), a = Math.atan2(y1 - y0, x1 - x0), h = Math.PI / 2;
  p.arc(x1, y1, r1, a - h, a + h);
  p.arc(x0, y0, r0, a + h, a + h * 3);
  p.closePath();
  return p;
}
export function ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0): Path2D {
  const p = new Path2D(); p.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, Math.PI * 2); return p;
}
export function rrect(x: number, y: number, w: number, h: number, r: number): Path2D {
  const p = new Path2D(); p.roundRect(x, y, w, h, r); return p;
}
/** closed smooth blob through points (Catmull-Rom converted to cubic beziers) */
export function blob(pts: number[][], tension = 1): Path2D {
  const p = new Path2D(), n = pts.length;
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const k = tension / 6;
    p.bezierCurveTo(p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k, p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k, p2[0], p2[1]);
  }
  p.closePath();
  return p;
}
/** closed polygon (sharp corners: torn hems, teeth, shards) */
export function poly(pts: number[][]): Path2D {
  const p = new Path2D(); p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath(); return p;
}
/** open smooth curve through points (for strokes) */
export function curve(pts: number[][]): Path2D {
  const p = new Path2D(); p.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 2) { p.lineTo(pts[1][0], pts[1][1]); return p; }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    p.quadraticCurveTo(pts[i][0], pts[i][1], i === pts.length - 2 ? pts[i + 1][0] : mx, i === pts.length - 2 ? pts[i + 1][1] : my);
  }
  return p;
}
const shifted = (p: Path2D, dx: number, dy: number): Path2D => { const q = new Path2D(); q.addPath(p, new DOMMatrix().translate(dx, dy)); return q; };

export interface ShapeOpts {
  /** cel-shadow colour (crescent on the side away from the top-left light); null for none */
  shade?: string | null;
  /** highlight colour (thin crescent toward the light) */
  light?: string | null;
  /** shadow crescent depth (drawing units) */
  sd?: number;
  /** highlight crescent depth */
  ld?: number;
  /** ink line width (0 = no outline) */
  lw?: number;
  ink?: string;
}

/**
 * The inked-cartoon pen. Works in "drawing units" (the caller sets up a scale on the context), so the
 * same drawing code renders a 32-unit character cell at any pixel resolution.
 */
export class Pen {
  ctx: Ctx;
  lw: number; // default ink width
  constructor(ctx: Ctx, lw = 0.55) { this.ctx = ctx; this.lw = lw; }

  /** flat fill + cel shadow crescent + rim light + ink outline */
  shape(p: Path2D, fill: string, o: ShapeOpts = {}): void {
    const c = this.ctx;
    c.fillStyle = fill; c.fill(p);
    const sh = o.shade === undefined ? shade(fill) : o.shade;
    const li = o.light === undefined ? light(fill, 0.22) : o.light;
    if (sh || li) {
      c.save(); c.clip(p);
      // a crescent is the shape minus a copy of itself shifted toward the light: even-odd fill of
      // the pair, clipped to the shape, leaves exactly the far rim
      if (sh) {
        const d = o.sd ?? 1.1, q = new Path2D(); q.addPath(p); q.addPath(p, new DOMMatrix().translate(-d * 0.8, -d));
        c.fillStyle = sh; c.fill(q, 'evenodd');
      }
      if (li) {
        const d = o.ld ?? 0.55, q = new Path2D(); q.addPath(p); q.addPath(p, new DOMMatrix().translate(d * 0.8, d));
        c.fillStyle = li; c.fill(q, 'evenodd');
      }
      c.restore();
    }
    const lw = o.lw ?? this.lw;
    if (lw > 0) { c.lineWidth = lw; c.strokeStyle = o.ink ?? INK; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(p); }
  }

  /** a bent limb as a round-capped polyline: ink underlay, shade, then a lit core offset to the light */
  limb(pts: number[][], w: number, col: string, o: { lw?: number; shade?: string | null; ink?: string } = {}): void {
    const c = this.ctx, p = curve(pts), lw = o.lw ?? this.lw;
    c.lineJoin = 'round'; c.lineCap = 'round';
    if (lw > 0) { c.strokeStyle = o.ink ?? INK; c.lineWidth = w + lw * 2; c.stroke(p); }
    const sh = o.shade === undefined ? shade(col) : o.shade;
    c.strokeStyle = sh ?? col; c.lineWidth = w; c.stroke(p);
    if (sh) { c.strokeStyle = col; c.lineWidth = w * 0.62; c.stroke(shifted(p, -w * 0.14, -w * 0.1)); }
  }

  /** a plain stroke (seams, creases, stitches, cracks) */
  line(p: Path2D, w: number, col = INK, dash?: number[]): void {
    const c = this.ctx;
    c.lineJoin = 'round'; c.lineCap = 'round'; c.lineWidth = w; c.strokeStyle = col;
    if (dash) c.setLineDash(dash);
    c.stroke(p);
    if (dash) c.setLineDash([]);
  }
  fill(p: Path2D, col: string | CanvasGradient): void { this.ctx.fillStyle = col; this.ctx.fill(p); }
  dot(x: number, y: number, r: number, col: string): void { this.fill(ellipse(x, y, r, r), col); }
}

/**
 * Thicken the outer silhouette of a drawing (on a transparent background) by `r` px of ink, composited
 * underneath it. A heavier outer contour than the inner lines is what makes cartoon figures pop against
 * busy backgrounds, and the extra width keeps the alpha-tested silhouette solid in the smaller mips.
 * Exact Euclidean distance to the opaque area, but only out to r + 1 px: a row pass finds the horizontal
 * distance to the nearest opaque texel, then a column pass takes min(dx² + dy²) over the few rows in
 * reach. Both passes walk memory in order, so a whole sheet takes a few ms.
 */
export function inkContour(img: ImageData, r: number, ink = INK): void {
  const { width: w, height: h, data } = img, R = Math.ceil(r + 1), FAR = R + 1;
  const hd = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let d = FAR;
    for (let x = 0; x < w; x++) { d = data[(o + x) * 4 + 3] >= 128 ? 0 : Math.min(FAR, d + 1); hd[o + x] = d; }
    d = FAR;
    for (let x = w - 1; x >= 0; x--) { d = hd[o + x] === 0 ? 0 : Math.min(FAR, d + 1); if (d < hd[o + x]) hd[o + x] = d; }
  }
  const n0 = parseInt(ink.slice(1), 16), ir = (n0 >> 16) & 255, ig = (n0 >> 8) & 255, ib = n0 & 255;
  const best = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    best.fill(1e9);
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      const o = yy * w, dy2 = dy * dy;
      for (let x = 0; x < w; x++) { const dx = hd[o + x]; if (dx < FAR) { const d2 = dx * dx + dy2; if (d2 < best[x]) best[x] = d2; } }
    }
    for (let x = 0; x < w; x++) {
      if (best[x] >= 1e9) continue;
      const ai = Math.min(1, r + 0.5 - Math.sqrt(best[x]));
      if (ai <= 0) continue;
      const k = (y * w + x) * 4, ad = data[k + 3] / 255;
      if (ad >= 1) continue;
      const ao = ad + ai * (1 - ad), wi = ai * (1 - ad);
      data[k] = (data[k] * ad + ir * wi) / ao; data[k + 1] = (data[k + 1] * ad + ig * wi) / ao; data[k + 2] = (data[k + 2] * ad + ib * wi) / ao;
      data[k + 3] = ao * 255;
    }
  }
}

// ---------------- texture baking ----------------
interface Level { data: Uint8Array<ArrayBuffer>; width: number; height: number; }

/** fill fully transparent texels with the average colour of opaque neighbours (a few rings outward), so
 *  linear filtering across the silhouette blends toward the edge colour instead of toward black. Works on
 *  a frontier list, so the cost is proportional to the outline length, not the image area. */
const N8X = [-1, 0, 1, -1, 1, -1, 0, 1], N8Y = [-1, -1, -1, 0, 0, 1, 1, 1];
function bleed(d: Uint8Array, w: number, h: number, passes: number): void {
  const n = w * h, state = new Uint8Array(n); // 0 unknown, 1 known, 2 queued in the frontier
  let front = new Int32Array(n), fl = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 0) state[i] = 1;
  const enqueueAround = (i: number, list: Int32Array, len: number): number => {
    const x = i % w, y = (i / w) | 0;
    for (let k = 0; k < 8; k++) {
      const xx = x + N8X[k], yy = y + N8Y[k];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (state[j] === 0) { state[j] = 2; list[len++] = j; }
    }
    return len;
  };
  for (let i = 0; i < n; i++) if (state[i] === 1) {
    const x = i % w, y = (i / w) | 0;
    // only opaque texels on the edge seed the frontier
    if ((x > 0 && state[i - 1] === 0) || (x < w - 1 && state[i + 1] === 0) || (y > 0 && state[i - w] === 0) || (y < h - 1 && state[i + w] === 0)
      || (x > 0 && y > 0 && state[i - w - 1] === 0) || (x < w - 1 && y < h - 1 && state[i + w + 1] === 0) || (x > 0 && y < h - 1 && state[i + w - 1] === 0) || (x < w - 1 && y > 0 && state[i - w + 1] === 0)) fl = enqueueAround(i, front, fl);
  }
  let next = new Int32Array(n);
  for (let p = 0; p < passes && fl > 0; p++) {
    for (let f = 0; f < fl; f++) {
      const i = front[f], x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, c = 0;
      for (let k = 0; k < 8; k++) {
        const xx = x + N8X[k], yy = y + N8Y[k];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (state[j] !== 1) continue;
        r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; c++;
      }
      if (c) { d[i * 4] = r / c; d[i * 4 + 1] = g / c; d[i * 4 + 2] = b / c; }
    }
    let nl = 0;
    for (let f = 0; f < fl; f++) state[front[f]] = 1; // the whole ring becomes known at once
    if (p + 1 < passes) for (let f = 0; f < fl; f++) nl = enqueueAround(front[f], next, nl);
    const t = front; front = next; next = t; fl = nl;
  }
}

/** 2x box downsample; colour averaged with alpha weights (premultiplied) so transparent texels never
 *  darken the edge, then alpha rescaled so the share of texels passing alphaTest (0.5) stays the same as
 *  in the full-size image ("alpha-tested coverage preservation": thin blades and limbs don't melt away) */
function downsample(src: Level, coverage: number): Level {
  const w = Math.max(1, src.width >> 1), h = Math.max(1, src.height >> 1), s = src.data;
  const out = new Uint8Array(w * h * 4), alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, rr = 0, gg = 0, bb = 0;
    for (let k = 0; k < 4; k++) {
      const sx = Math.min(src.width - 1, x * 2 + (k & 1)), sy = Math.min(src.height - 1, y * 2 + (k >> 1));
      const j = (sy * src.width + sx) * 4, al = s[j + 3] / 255;
      r += s[j] * al; g += s[j + 1] * al; b += s[j + 2] * al; a += al;
      rr += s[j]; gg += s[j + 1]; bb += s[j + 2];
    }
    const i = (y * w + x) * 4;
    if (a > 1e-3) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; }
    else { out[i] = rr / 4; out[i + 1] = gg / 4; out[i + 2] = bb / 4; }
    alpha[y * w + x] = a / 4;
  }
  let scale = 1;
  if (coverage > 0) {
    // the alpha level a* that exactly `coverage` of the texels reach (from a histogram), then scale so
    // a* maps to the 0.5 test threshold
    const B = 1024, hist = new Uint32Array(B);
    for (let i = 0; i < alpha.length; i++) hist[Math.min(B - 1, (alpha[i] * B) | 0)]++;
    let need = coverage * alpha.length, k = B - 1;
    for (; k > 0; k--) { need -= hist[k]; if (need <= 0) break; }
    scale = Math.min(4, Math.max(0.5, 0.5 / Math.max(1 / B, k / B)));
  }
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = Math.min(255, Math.round(alpha[i] * scale * 255));
  return { data: out, width: w, height: h };
}

export interface BakeOpts {
  /** flip rows so canvas top is v = 1 (what a CanvasTexture with flipY does) */
  flipY?: boolean;
  /** colour texture (sRGB) vs raw data (detail multipliers) */
  srgb?: boolean;
  /** number of mip levels to build (the chain stops early: a short chain caps how blurry the texture
   *  gets, which is also how atlas gutters are kept wider than the filter footprint) */
  levels?: number;
  /** preserve alpha-tested coverage across mips */
  alphaTest?: boolean;
  /** transparent-texel colour bleed rings per level */
  bleed?: number;
  anisotropy?: number;
}

/**
 * Bake a drawn canvas into a mipmapped DataTexture (manual mips: three uploads them as-is with
 * texStorage). Linear filtering + trilinear mips give smooth, alias-free vector art at every zoom.
 */
export function bake(src: HTMLCanvasElement | ImageData, o: BakeOpts = {}): THREE.DataTexture {
  const w = src.width, h = src.height;
  const img = src instanceof ImageData ? src : get2d(src).getImageData(0, 0, w, h);
  let lvl: Level = { data: new Uint8Array(img.data.buffer), width: w, height: h };
  const bl = o.bleed ?? 2;
  if (bl) bleed(lvl.data, w, h, bl);
  let coverage = 0;
  if (o.alphaTest) { let n = 0; for (let i = 3; i < lvl.data.length; i += 4) if (lvl.data[i] >= 128) n++; coverage = n / (w * h); }
  const maxLevels = o.levels ?? Math.floor(Math.log2(Math.max(w, h))) + 1;
  const levels: Level[] = [lvl];
  while (levels.length < maxLevels && (lvl.width > 1 || lvl.height > 1)) {
    lvl = downsample(lvl, coverage);
    if (bl) bleed(lvl.data, lvl.width, lvl.height, 2);
    levels.push(lvl);
  }
  // keep a canvas of the source drawing (before the in-place row flip) for debugging / previews
  let preview = src as HTMLCanvasElement;
  if (src instanceof ImageData) { preview = canvas(w, h); get2d(preview).putImageData(img, 0, 0); }
  if (o.flipY) for (const L of levels) {
    const row = L.width * 4, tmp = new Uint8Array(row);
    for (let y = 0; y < L.height >> 1; y++) {
      const a = y * row, b = (L.height - 1 - y) * row;
      tmp.set(L.data.subarray(a, a + row)); L.data.copyWithin(a, b, b + row); L.data.set(tmp, b);
    }
  }
  const tex = new THREE.DataTexture(levels[0].data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = levels as unknown as THREE.DataTexture['mipmaps'];
  tex.generateMipmaps = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.anisotropy = o.anisotropy ?? 4;
  if (o.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.canvas = preview; // the source drawing, for debugging / previews
  tex.needsUpdate = true;
  return tex;
}
