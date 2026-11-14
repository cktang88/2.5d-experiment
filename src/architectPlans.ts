// Pure shape geometry for the architect planner: turns a drag (two cells on a base level) and the
// tool settings into axis-aligned boxes to fill, clear, cut and flood. Depends only on a tiny world
// interface, so it is unit-tested against placeholder voxel worlds (tests/architectPlans.test.mjs).
export type Box = [number, number, number, number, number, number]; // x0 y0 z0 x1 y1 z1, inclusive
export type Cell = [number, number, number];
export type ToolId = 'wall' | 'line' | 'box' | 'room' | 'tower' | 'stairs' | 'dig' | 'moat' | 'erase' | 'place';
export const BUILD_TOOLS = new Set<ToolId>(['wall', 'line', 'box', 'room', 'tower', 'stairs']);
// `cut` is excavation above the dig level that only takes natural ground and trees (hills in the way), never buildings
export interface Plan { fill: Box[]; clear: Box[]; cut: Box[]; flood: Box[]; dims: string; error: string; volume: number; note: string; base: number }
export interface PlanOptions {
  tool: ToolId; height: number; thickness: number; depth: number; eraseHeight: number;
  battlements: boolean; foundation: boolean; roof: boolean; door: boolean; pillars: boolean; hollow: boolean; flood: boolean;
  /** max unsupported reach of the material (BLOCKS[block].span) */
  span: number;
  /** camera ground position: rooms put their door on the side facing it */
  camera: { x: number; z: number };
}
export interface PlanWorld { W: number; H: number; D: number; solid(x: number, y: number, z: number): boolean; isGenerated(x: number, z: number): boolean }

export const MAX_SPAN = 512;          // per horizontal axis
export const MAX_CELLS = 1_000_000;   // per operation
const FOUNDATION_DEPTH = 48;
const FOUNDATION_COLUMNS = 80_000;
export const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
export const boxVolume = (b: Box) => (b[3] - b[0] + 1) * (b[4] - b[1] + 1) * (b[5] - b[2] + 1);

export function makePlan(w: PlanWorld, o: PlanOptions, a: Cell, b: Cell, base: number): Plan {
  const plan: Plan = { fill: [], clear: [], cut: [], flood: [], dims: '', error: '', volume: 0, note: '', base };
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]);
  const W = x1 - x0 + 1, D = z1 - z0 + 1, H = o.height, T = o.thickness;
  const top = base + H - 1;
  const fill = (bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number) => {
    if (bx1 < bx0 || by1 < by0 || bz1 < bz0) return;
    plan.fill.push([bx0, by0, bz0, bx1, by1, bz1]);
  };
  const merlonRing = (cells: Iterable<[number, number]>, y: number) => {
    for (const [x, z] of cells) if (((x + z) & 1) === 0) fill(x, y, z, x, y, z);
  };
  if (W > MAX_SPAN || D > MAX_SPAN) { plan.error = `Keep each side within ${MAX_SPAN} blocks.`; return plan; }
  switch (o.tool) {
    case 'wall': {
      if (W === 1 || D === 1 || W <= T * 2 || D <= T * 2) {
        // a straight wall (or a footprint too small to hollow): thickness grows across the run
        let bx0 = x0, bx1 = x1, bz0 = z0, bz1 = z1;
        if (D === 1 && W > 1) { bz0 = z0 - Math.floor((T - 1) / 2); bz1 = bz0 + T - 1; }
        else if (W === 1 && D > 1) { bx0 = x0 - Math.floor((T - 1) / 2); bx1 = bx0 + T - 1; }
        fill(bx0, base, bz0, bx1, top, bz1);
        if (o.battlements) {
          // one row of merlons along the edge facing away from the camera (the enemy side when you look out
          // over it); the other rows stay a clear walkway
          const ring: [number, number][] = [];
          if (bz1 - bz0 >= bx1 - bx0) { const x = o.camera.x > (bx0 + bx1 + 1) / 2 ? bx0 : bx1; for (let z = bz0; z <= bz1; z++) ring.push([x, z]); }
          else { const z = o.camera.z > (bz0 + bz1 + 1) / 2 ? bz0 : bz1; for (let x = bx0; x <= bx1; x++) ring.push([x, z]); }
          merlonRing(ring, top + 1);
        }
        plan.dims = `${bx1 - bx0 + 1} × ${bz1 - bz0 + 1} × ${H}`;
      } else {
        fill(x0, base, z0, x1, top, z0 + T - 1);
        fill(x0, base, z1 - T + 1, x1, top, z1);
        fill(x0, base, z0 + T, x0 + T - 1, top, z1 - T);
        fill(x1 - T + 1, base, z0 + T, x1, top, z1 - T);
        if (o.battlements) merlonRing(perimeter(x0, z0, x1, z1), top + 1);
        plan.dims = `${W} × ${D} × ${H} · walls ${T} thick`;
      }
      break;
    }
    case 'line': {
      const ax = a[0] + 0.5, az = a[2] + 0.5, bx = b[0] + 0.5, bz = b[2] + 0.5;
      const len = Math.hypot(bx - ax, bz - az), R = T / 2 + 0.25;
      // battlements go on the outer edge facing away from the camera: cells whose signed offset across
      // the wall is on the opposite side to the camera's
      const nx = len > 0 ? -(bz - az) / len : 0, nz = len > 0 ? (bx - ax) / len : 1;
      const camSide = Math.sign((o.camera.x - ax) * nx + (o.camera.z - az) * nz) || 1;
      const pad = Math.ceil(R);
      const cols: [number, number][] = [], edge: [number, number][] = [];
      for (let z = z0 - pad; z <= z1 + pad; z++) for (let x = x0 - pad; x <= x1 + pad; x++) {
        const px = x + 0.5, pz = z + 0.5;
        let t = len > 0 ? ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / (len * len) : 0;
        t = Math.max(0, Math.min(1, t));
        const dd = Math.hypot(px - (ax + (bx - ax) * t), pz - (az + (bz - az) * t));
        if (dd <= R) {
          cols.push([x, z]);
          const across = (px - ax) * nx + (pz - az) * nz; // signed distance across the wall
          if (T === 1 || -across * camSide >= R - 1.25) edge.push([x, z]);
        }
      }
      if (cols.length > 200_000) { plan.error = 'That line is too long.'; return plan; }
      columns(cols, base, top, plan.fill);
      if (o.battlements) merlonRing(edge, top + 1);
      plan.dims = `${Math.round(len) + 1} long × ${H} high · ${T} thick`;
      break;
    }
    case 'box':
      fill(x0, base, z0, x1, top, z1);
      plan.dims = `${W} × ${D} × ${H}`;
      break;
    case 'room': {
      const RH = Math.max(3, H);
      if (W < 3 || D < 3) { plan.error = 'Rooms need at least 3 × 3.'; plan.dims = `${W} × ${D}`; return plan; }
      const wt = Math.min(T, Math.floor((Math.min(W, D) - 1) / 2));
      fill(x0, base, z0, x1, base, z1); // floor
      const wy0 = base + 1, wy1 = base + RH - 1;
      // the door goes in the side facing the camera
      const cx = (x0 + x1 + 1) / 2, cz = (z0 + z1 + 1) / 2, cam = o.camera;
      const vx = cam.x - cx, vz = cam.z - cz;
      const side = Math.abs(vx) / W > Math.abs(vz) / D ? (vx > 0 ? 'E' : 'W') : (vz > 0 ? 'S' : 'N');
      const doorH = Math.min(3, RH - 2 >= 1 ? RH - 2 : 1), door = o.door && RH >= 3;
      const along = (s: string) => s === 'N' || s === 'S';
      let doorway: Box | null = null; // the door opening, so pillars stay out of the way in front of it
      const sideBox = (s: string): Box => s === 'N' ? [x0, wy0, z0, x1, wy1, z0 + wt - 1] : s === 'S' ? [x0, wy0, z1 - wt + 1, x1, wy1, z1]
        : s === 'W' ? [x0, wy0, z0 + wt, x0 + wt - 1, wy1, z1 - wt] : [x1 - wt + 1, wy0, z0 + wt, x1, wy1, z1 - wt];
      for (const s of ['N', 'S', 'W', 'E']) {
        const bx = sideBox(s);
        if (!(door && s === side)) { fill(...bx); continue; }
        // split this side around a 2-wide doorway (1-wide when the side is short) and add a lintel
        const run0 = along(s) ? bx[0] : bx[2], run1 = along(s) ? bx[3] : bx[5];
        const mid = Math.floor((run0 + run1) / 2), dw = run1 - run0 + 1 >= 6 ? 2 : 1;
        const d0 = mid - (dw - 1), d1 = mid;
        const part = (r0: number, r1: number, y0: number, y1: number) => along(s) ? fill(r0, y0, bx[2], r1, y1, bx[5]) : fill(bx[0], y0, r0, bx[3], y1, r1);
        part(run0, d0 - 1, wy0, wy1); part(d1 + 1, run1, wy0, wy1); part(d0, d1, wy0 + doorH, wy1);
        doorway = along(s) ? [d0, wy0, bx[2], d1, wy0, bx[5]] : [bx[0], wy0, d0, bx[3], wy0, d1];
      }
      if (o.roof) {
        fill(x0, base + RH, z0, x1, base + RH, z1);
        if (o.battlements) merlonRing(perimeter(x0, z0, x1, z1), base + RH + 1);
        // roofs only reach `span` blocks from a support: stand pillars on a lattice that keeps every
        // roof cell within reach (a perfect Lee-sphere tiling: 1 pillar per 2r² + 2r + 1 cells)
        const span = o.span, ix0 = x0 + wt, ix1 = x1 - wt, iz0 = z0 + wt, iz1 = z1 - wt;
        const needs = Math.min(ix1 - ix0 + 1, iz1 - iz0 + 1) > span * 2;
        if (o.pillars && needs) {
          const dw = doorway as Box | null;
          // keep the approach clear: 1 beside the opening, 3 deep into the room
          const ax = along(side) ? 1 : 3, az = along(side) ? 3 : 1;
          const corridor = (x: number, z: number) => !!dw && x >= dw[0] - ax && x <= dw[3] + ax && z >= dw[2] - az && z <= dw[5] + az;
          for (const [x, z] of roofPillars(ix0, iz0, ix1, iz1, span, corridor)) fill(x, wy0, z, x, wy1, z);
        } else if (needs) plan.note = `Roof spans over ${span * 2} need pillars or they sag and fall.`;
      } else if (o.battlements) merlonRing(perimeter(x0, z0, x1, z1), base + RH);
      plan.dims = `${W} × ${D} × ${RH}${o.roof ? ' + roof' : ''}`;
      break;
    }
    case 'tower': {
      const r = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2])));
      if (r > 96) { plan.error = 'Tower radius is limited to 96.'; return plan; }
      const ring: [number, number][] = [], edge: [number, number][] = [];
      for (let z = a[2] - r; z <= a[2] + r; z++) for (let x = a[0] - r; x <= a[0] + r; x++) {
        const dd = Math.hypot(x - a[0], z - a[2]);
        if (dd > r + 0.5) continue;
        if (o.hollow && dd <= r + 0.5 - T) continue;
        ring.push([x, z]); if (dd > r - 0.5) edge.push([x, z]);
      }
      columns(ring, base, top, plan.fill);
      if (o.hollow && r - T <= o.span * 2) {
        // a floor at the top of a hollow tower so it can be manned
        const inner: [number, number][] = [];
        for (let z = a[2] - r; z <= a[2] + r; z++) for (let x = a[0] - r; x <= a[0] + r; x++) if (Math.hypot(x - a[0], z - a[2]) <= r + 0.5 - T) inner.push([x, z]);
        columns(inner, top, top, plan.fill);
      }
      if (o.battlements) merlonRing(edge, top + 1);
      plan.dims = `radius ${r} (${r * 2 + 1} across) × ${H}`;
      break;
    }
    case 'stairs': {
      const alongX = Math.abs(b[0] - a[0]) >= Math.abs(b[2] - a[2]);
      const len = (alongX ? W : D), sign = (alongX ? b[0] - a[0] : b[2] - a[2]) >= 0 ? 1 : -1;
      const start = alongX ? a[0] : a[2];
      const rise = Math.min(H, len);
      for (let i = 0; i < len; i++) {
        const yTop = base + Math.min(i, H - 1), at = start + i * sign;
        if (alongX) fill(at, base, z0, at, yTop, z1); else fill(x0, base, at, x1, yTop, at);
      }
      plan.dims = `${len} run × ${alongX ? D : W} wide · rises ${rise}`;
      break;
    }
    case 'dig': case 'moat': {
      const yb = Math.max(1, base - o.depth + 1), yt = base, hill = Math.min(w.H - 1, base + 40);
      const rects: Box[] = [];
      if (o.tool === 'dig' || W <= T * 2 || D <= T * 2) rects.push([x0, yb, z0, x1, yt, z1]);
      else {
        rects.push([x0, yb, z0, x1, yt, z0 + T - 1], [x0, yb, z1 - T + 1, x1, yt, z1]);
        rects.push([x0, yb, z0 + T, x0 + T - 1, yt, z1 - T], [x1 - T + 1, yb, z0 + T, x1, yt, z1 - T]);
      }
      plan.clear.push(...rects);
      for (const r of rects) plan.cut.push([r[0], base + 1, r[2], r[3], hill, r[5]]);
      if (o.flood && base - 1 >= yb) {
        for (const r of rects) plan.flood.push([r[0], yb, r[2], r[3], base - 1, r[5]]);
      }
      plan.dims = o.tool === 'dig' ? `${W} × ${D} · ${o.depth} deep` : `${W} × ${D} · ${T} wide · ${o.depth} deep`;
      break;
    }
    case 'erase':
      plan.clear.push([x0, base, z0, x1, Math.min(w.H - 1, base + o.eraseHeight - 1), z1]);
      plan.dims = `${W} × ${D} · ${o.eraseHeight} up`;
      break;
  }
  if (o.foundation && BUILD_TOOLS.has(o.tool)) addFoundation(w, plan, base);
  plan.volume = [...plan.fill, ...plan.clear, ...plan.cut].reduce((n, b) => n + boxVolume(b), 0);
  for (const b of [...plan.fill, ...plan.clear]) {
    if (b[1] < 1 && plan.clear.includes(b) === false) { plan.error = 'Cannot build below the bedrock.'; break; }
    if (b[4] >= w.H) { plan.error = 'Too tall: that would poke out of the world.'; break; }
    if (b[0] < 0 || b[2] < 0 || b[3] >= w.W || b[5] >= w.D) { plan.error = 'Outside the world.'; break; }
  }
  if (!plan.error && plan.volume > MAX_CELLS * (plan.clear.length ? 4 : 1)) plan.error = `Too big for one operation (over ${fmt(plan.clear.length ? MAX_CELLS * 4 : MAX_CELLS)} blocks): split it up.`;
  if (!plan.error && !loaded(w, plan)) plan.error = 'Part of that area is still loading.';
  return plan;
}
export function perimeter(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = x0; x <= x1; x++) { out.push([x, z0]); if (z1 !== z0) out.push([x, z1]); }
  for (let z = z0 + 1; z < z1; z++) { out.push([x0, z]); if (x1 !== x0) out.push([x1, z]); }
  return out;
}
/** columns (x, z) from y0 to y1, merged into x-runs */
export function columns(cols: [number, number][], y0: number, y1: number, out: Box[]): void {
  cols.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  for (let i = 0; i < cols.length;) {
    const [sx, z] = cols[i]; let ex = sx; i++;
    while (i < cols.length && cols[i][1] === z && cols[i][0] === ex + 1) { ex++; i++; }
    out.push([sx, y0, z, ex, y1, z]);
  }
}
/** extend every column standing on the base down to solid ground, so walls follow uneven terrain */
export function addFoundation(w: PlanWorld, plan: Plan, base: number): void {
  const seen = new Set<number>(), extra: Box[] = [];
  let columns = 0;
  for (const b of plan.fill) {
    if (b[1] !== base) continue;
    columns += (b[3] - b[0] + 1) * (b[5] - b[2] + 1);
    if (columns > FOUNDATION_COLUMNS) { plan.note = 'Footprint too large for automatic foundations.'; return; }
    for (let z = b[2]; z <= b[5]; z++) {
      let runStart = -1, runDepth = 0;
      const flush = (endX: number) => { if (runStart >= 0 && runDepth > 0) extra.push([runStart, base - runDepth, z, endX, base - 1, z]); };
      for (let x = b[0]; x <= b[3]; x++) {
        const key = x * 8192 + z;
        let depth = 0;
        if (!seen.has(key)) {
          seen.add(key);
          while (depth < FOUNDATION_DEPTH && base - depth - 1 >= 1 && !w.solid(x, base - depth - 1, z)) depth++;
          if (depth === FOUNDATION_DEPTH) depth = 0; // a cliff edge or a hole: don't build a 48-block stilt
        }
        if (depth !== runDepth || runStart < 0) { flush(x - 1); runStart = x; runDepth = depth; }
      }
      flush(b[3]);
    }
  }
  plan.fill.push(...extra);
}
export function loaded(w: PlanWorld, plan: Plan): boolean {
  for (const b of [...plan.fill, ...plan.clear]) {
    for (let cz = b[2] >> 5; cz <= b[5] >> 5; cz++) for (let cx = b[0] >> 5; cx <= b[3] >> 5; cx++) {
      if (!w.isGenerated(cx * 32, cz * 32)) return false;
    }
  }
  return true;
}

/**
 * Pillars for a roof over the interior [ix0..ix1] x [iz0..iz1], whose rim rests on walls. Roof cells
 * may be at most `span` horizontal links from a support. Pillars start on a perfect Lee-sphere lattice
 * (one per 2r² + 2r + 1 cells, every cell within r of one); lattice points in `blocked` cells (the
 * doorway approach) are dropped, and any cell left out of reach gets a pillar of its own.
 */
export function roofPillars(ix0: number, iz0: number, ix1: number, iz1: number, span: number, blocked: (x: number, z: number) => boolean): [number, number][] {
  const W = ix1 - ix0 + 1, D = iz1 - iz0 + 1, m = 2 * span * span + 2 * span + 1;
  const out: [number, number][] = [];
  for (let z = iz0; z <= iz1; z++) for (let x = ix0; x <= ix1; x++) {
    if ((((x + (2 * span + 1) * z) % m) + m) % m === 0 && !blocked(x, z)) out.push([x, z]);
  }
  const dist = new Int32Array(W * D), queue = new Int32Array(W * D);
  for (let guard = 0; guard < 400; guard++) {
    // BFS from the supports: pillars are 0 links away, interior cells along the walls 1
    dist.fill(-1);
    let tail = 0;
    for (const [x, z] of out) { const i = (x - ix0) + (z - iz0) * W; if (dist[i] < 0) { dist[i] = 0; queue[tail++] = i; } }
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      if (x && z && x < W - 1 && z < D - 1) continue;
      const i = x + z * W; if (dist[i] < 0) { dist[i] = 1; queue[tail++] = i; }
    }
    let head = 0, worst = -1, worstD = span;
    while (head < tail) {
      const i = queue[head++], x = i % W, z = (i / W) | 0, d = dist[i];
      if (d > worstD) { worstD = d; worst = i; }
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
        const j = nx + nz * W; if (dist[j] >= 0) continue;
        dist[j] = d + 1; queue[tail++] = j;
      }
    }
    if (worst < 0) break;
    // stand a pillar on the farthest cell (or the nearest unblocked cell to it)
    const wx = worst % W, wz = (worst / W) | 0;
    let best: [number, number] | null = null;
    for (let r = 0; r <= span && !best; r++) for (let dz = -r; dz <= r && !best; dz++) for (let dx = -r; dx <= r; dx++) {
      const x = ix0 + wx + dx, z = iz0 + wz + dz;
      if (x < ix0 || x > ix1 || z < iz0 || z > iz1 || blocked(x, z)) continue;
      best = [x, z]; break;
    }
    if (!best) break;
    out.push(best);
  }
  return out;
}
