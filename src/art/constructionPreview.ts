import type { Construction, PreviewCell } from '../construction';

// Menu thumbnails are generated only when a shape or material changes, never per frame.
const cache = new Map<string, string>();
const WIDTH = 160, HEIGHT = 96;

type Point = [number, number];
const project = (x: number, y: number, z: number): Point => [(x + z) * .866, (x - z) * .5 - y];
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A transparent, isometric image of the preset's actual occupied cells. */
export function thumbnailForBlueprint(construction: Construction, index: number, material: string | undefined): string {
  const option = construction.options[index];
  if (!option) return '';
  const key = `${index}:${option.width ?? ''}:${option.dimensions?.join(',') ?? ''}:${material ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const cells = construction.getPreviewCells(index);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx || !cells.length) return '';
  const wood = (material ?? '').toLowerCase().includes('wood') || (material ?? '').toLowerCase().includes('plank');
  const colors = wood ? ['#d6aa70', '#a57040', '#bd8952'] : ['#c2b8a2', '#7e807b', '#a29d90'];
  const occupied = new Set(cells.map(([x, y, z]) => cellKey(x, y, z)));
  const faces: { depth: number; points: Point[]; color: string }[] = [];
  const add = (depth: number, points: Point[], color: string) => faces.push({ depth, points, color });
  for (const [x, y, z] of cells) {
    const p = (dx: number, dy: number, dz: number) => project(x + dx, y + dy, z + dz);
    const depth = x - z + y;
    if (!occupied.has(cellKey(x, y + 1, z))) add(depth + .51, [p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1)], colors[0]);
    if (!occupied.has(cellKey(x + 1, y, z))) add(depth + .5, [p(1, 0, 0), p(1, 0, 1), p(1, 1, 1), p(1, 1, 0)], colors[1]);
    if (!occupied.has(cellKey(x, y, z - 1))) add(depth + .5, [p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0)], colors[2]);
  }
  faces.sort((a, b) => a.depth - b.depth);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const face of faces) for (const [x, y] of face.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const scale = Math.min((WIDTH - 24) / (maxX - minX), (HEIGHT - 18) / (maxY - minY));
  const ox = WIDTH / 2 - (minX + maxX) * scale / 2;
  const oy = HEIGHT / 2 - (minY + maxY) * scale / 2;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(.45, Math.min(1.1, scale * .075));
  ctx.strokeStyle = 'rgba(47, 48, 45, .6)';
  for (const face of faces) {
    ctx.beginPath();
    face.points.forEach(([x, y], i) => i ? ctx.lineTo(ox + x * scale, oy + y * scale) : ctx.moveTo(ox + x * scale, oy + y * scale));
    ctx.closePath(); ctx.fillStyle = face.color; ctx.fill(); ctx.stroke();
  }
  // The workbench adds a dark worktop and a tool to its single block in-world.
  if (index === 6) {
    const top: PreviewCell = cells[0];
    const [x, y, z] = top;
    const poly = [[x, y + 1.02, z], [x + 1, y + 1.02, z], [x + 1, y + 1.02, z + 1], [x, y + 1.02, z + 1]];
    ctx.beginPath();
    poly.forEach(([px, py, pz], i) => { const [sx, sy] = project(px, py, pz); i ? ctx.lineTo(ox + sx * scale, oy + sy * scale) : ctx.moveTo(ox + sx * scale, oy + sy * scale); });
    ctx.closePath(); ctx.fillStyle = '#79512e'; ctx.fill(); ctx.stroke();
    const [ax, ay] = project(x + .2, y + 1.04, z + .5), [bx, by] = project(x + .8, y + 1.04, z + .5);
    ctx.beginPath(); ctx.moveTo(ox + ax * scale, oy + ay * scale); ctx.lineTo(ox + bx * scale, oy + by * scale);
    ctx.lineWidth = Math.max(1.5, scale * .1); ctx.strokeStyle = '#d4d7cf'; ctx.stroke();
  }
  const result = canvas.toDataURL();
  // Bound retained data as players experiment with custom sizes.
  if (cache.size >= 120) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
