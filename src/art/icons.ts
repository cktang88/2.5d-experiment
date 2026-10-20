// UI icons (hotbar, crafting, resources) as inked vector drawings in the same style as the characters.
// Drawn in a 16-unit space at ICON px (about 2x their on-screen CSS size) and returned as data URLs.
import { Pen, INK, canvas, get2d, inkContour, ellipse, rrect, blob, poly, curve, capsule, mix, shade } from './draw';

const ICON = 72;
const K = ICON / 16;

type IconFn = (p: Pen) => void;
const steel = '#8e98a6', gun = '#5a6170', wood = '#a8683a';

const ICONS: Record<string, IconFn> = {
  pistol: (p) => {
    p.shape(blob([[4.6, 8.6], [7.2, 8.4], [6.8, 13.6], [4.0, 13.4]], 0.6), wood, { sd: 0.7 });
    p.line(curve([[5.0, 10.2], [6.2, 10.4]]), 0.3, shade(wood, 0.5)); p.line(curve([[4.8, 11.6], [6.0, 11.8]]), 0.3, shade(wood, 0.5));
    p.shape(rrect(7.0, 8.6, 2.6, 2.4, 1.0), 'rgba(0,0,0,0)', { shade: null, light: null }); // trigger guard
    p.shape(rrect(2.6, 5.6, 11.2, 3.4, 1.0), gun, { light: steel, sd: 1.0 });
    p.shape(rrect(12.4, 6.0, 1.8, 2.0, 0.5), '#2a2c34', { shade: null, light: null, lw: 0.35 });
    p.line(curve([[4.0, 6.6], [11.6, 6.6]]), 0.35, mix(steel, '#ffffff', 0.5));
  },
  shotgun: (p) => {
    p.shape(blob([[0.8, 9.2], [5.0, 8.4], [6.4, 10.2], [1.4, 12.6]], 0.7), wood, { sd: 0.8 });
    p.shape(rrect(4.6, 6.2, 10.8, 1.9, 0.8), gun, { light: steel, sd: 0.7 });
    p.shape(rrect(5.2, 8.0, 7.4, 1.4, 0.6), shade(gun, 0.2), { sd: 0.5 });
    p.shape(rrect(8.2, 7.8, 3.6, 2.0, 0.8), mix(wood, '#ffffff', 0.08), { sd: 0.6 }); // pump
    p.line(curve([[6.2, 6.8], [14.4, 6.8]]), 0.3, mix(steel, '#ffffff', 0.5));
  },
  smg: (p) => {
    p.shape(rrect(6.2, 8.6, 2.0, 5.4, 0.6), '#2e323c', { sd: 0.5 }); // magazine
    p.shape(blob([[3.6, 8.4], [5.6, 8.6], [5.0, 12.4], [3.2, 12.2]], 0.6), '#3e434e', { sd: 0.5 });
    p.shape(rrect(1.0, 6.4, 2.8, 1.4, 0.5), '#3e434e', { sd: 0.4 }); // stock
    p.shape(rrect(2.8, 5.0, 10.0, 4.0, 1.2), gun, { light: steel, sd: 1.0 });
    p.shape(rrect(12.4, 6.0, 2.8, 1.6, 0.6), '#2a2c34', { shade: null, sd: 0.4 });
    p.line(curve([[4.2, 6.0], [11.6, 6.0]]), 0.35, mix(steel, '#ffffff', 0.5));
  },
  rocket: (p) => {
    p.shape(rrect(5.0, 9.4, 2.0, 3.6, 0.6), '#3a3a3a', { sd: 0.4 }); // grip
    p.shape(rrect(1.2, 5.2, 12.0, 4.6, 2.0), '#5e8a4a', { light: '#8ab86a', sd: 1.2 });
    p.shape(rrect(11.6, 4.4, 2.4, 6.2, 1.0), '#3e5a32', { sd: 0.6 });
    p.shape(blob([[0.4, 5.6], [-0.6, 7.5], [0.4, 9.4], [2.2, 9.0], [2.2, 6.0]], 0.8), '#e05a3a', { light: '#ff9a6a', sd: 0.6 });
    p.line(curve([[3.0, 6.2], [10.8, 6.2]]), 0.35, '#b8e09a');
  },
  grenade: (p) => {
    p.line(ellipse(11.0, 3.4, 1.6, 1.6), 0.55, '#9aa0a8'); p.line(ellipse(11.0, 3.4, 1.6, 1.6), 0.25, '#d8dce0');
    p.shape(rrect(5.8, 2.6, 4.4, 2.6, 0.8), '#8a8f98', { light: '#c8ccd2', sd: 0.6 });
    p.shape(blob([[9.6, 3.0], [12.8, 4.6], [12.4, 8.0], [10.6, 5.0]], 0.8), '#8a8f98', { sd: 0.4 }); // lever
    p.shape(ellipse(8.0, 10.0, 4.8, 5.2), '#5e8a3e', { light: '#9ac46a', sd: 1.4 });
    p.line(curve([[3.6, 9.8], [8.0, 10.8], [12.4, 9.8]]), 0.35, '#36542a');
    p.line(curve([[8.0, 5.2], [7.0, 10.0], [8.0, 15.0]]), 0.35, '#36542a');
    p.fill(ellipse(6.2, 7.6, 1.2, 0.8, -0.6), 'rgba(255,255,230,0.6)');
  },
  planks: (p) => {
    for (let i = 0; i < 3; i++) {
      const y = 3.0 + i * 3.6, c = mix('#c9955a', '#a8703e', i * 0.3);
      p.shape(rrect(1.6 + (i % 2) * 0.8, y, 12.6, 3.4, 0.8), c, { light: mix(c, '#fff0c8', 0.3), sd: 0.8 });
      p.line(curve([[3.0 + (i % 2), y + 1.4], [7.0, y + 1.1], [12.6, y + 1.6]]), 0.25, shade(c, 0.4));
      p.dot(3.0 + (i % 2) * 0.8, y + 1.7, 0.35, '#5a4030'); p.dot(13.2 + (i % 2) * 0.4, y + 1.7, 0.35, '#5a4030');
    }
  },
  bricks: (p) => {
    const b = '#b46a52', bl = '#d68a6c';
    p.shape(rrect(1.2, 9.4, 6.6, 4.2, 0.8), b, { light: bl, sd: 0.8 });
    p.shape(rrect(8.2, 9.4, 6.6, 4.2, 0.8), b, { light: bl, sd: 0.8 });
    p.shape(rrect(4.6, 4.8, 6.8, 4.2, 0.8), b, { light: bl, sd: 0.8 });
    for (const [x, y] of [[3, 11], [11, 12], [7, 6.4]]) p.dot(x, y, 0.4, shade(b, 0.4));
  },
  tnt: (p) => {
    p.line(curve([[8.0, 4.0], [8.6, 2.2], [10.0, 1.6]]), 0.5, '#6a6a6a');
    p.shape(ellipse(10.6, 1.4, 1.3, 1.3), '#ffd23a', { shade: '#ff8a20', light: '#fff8c0', sd: 0.5, lw: 0.3 });
    for (let i = 0; i < 3; i++) p.shape(rrect(2.6 + i * 3.7, 4.0, 3.7, 10.4, 1.2), '#d8443a', { light: '#ff7a5a', sd: 0.9 });
    p.shape(rrect(2.0, 7.4, 12.0, 3.4, 0.4), '#f0e6d0', { sd: 0.6 });
    p.line(curve([[4.4, 8.4], [5.8, 8.4]]), 0.4, INK); p.line(curve([[5.1, 8.4], [5.1, 9.8]]), 0.4, INK);
    p.line(poly([[7.0, 9.8], [7.0, 8.4], [9.0, 9.8], [9.0, 8.4], [9.0, 9.8], [7.0, 8.4]]), 0.4, INK); // (closed back over itself: an open N)
    p.line(curve([[10.2, 8.4], [11.6, 8.4]]), 0.4, INK); p.line(curve([[10.9, 8.4], [10.9, 9.8]]), 0.4, INK);
  },
  turret: (p) => {
    p.shape(poly([[3.0, 14.4], [4.4, 10.2], [11.6, 10.2], [13.0, 14.4]]), '#5a6470', { light: '#8a96a2', sd: 0.8 });
    p.shape(rrect(9.6, 6.4, 5.6, 2.0, 0.6), '#3a4048', { sd: 0.5 });
    p.shape(rrect(4.2, 4.6, 7.6, 5.8, 2.2), '#7a8a96', { light: '#b0c0ca', sd: 1.0 });
    p.shape(ellipse(7.0, 7.4, 1.3, 1.3), '#ff5a3a', { shade: '#a02a20', light: '#ffc0a0', sd: 0.5, lw: 0.35 });
  },
  lantern: (p) => {
    const c = p.ctx;
    p.line(curve([[5.6, 3.6], [8.0, 0.6], [10.4, 3.6]]), 0.6, '#5a4030');
    const glass = rrect(4.4, 4.0, 7.2, 9.0, 2.0);
    const g = c.createRadialGradient(8, 8.6, 0.4, 8, 8.6, 5.0);
    g.addColorStop(0, '#fffbe0'); g.addColorStop(0.45, '#ffd87a'); g.addColorStop(1, '#e8902a');
    p.fill(glass, g); p.line(glass, 0.5, INK);
    p.line(curve([[8.0, 4.2], [8.0, 12.8]]), 0.4, '#5a4030');
    p.shape(rrect(3.4, 2.8, 9.2, 1.8, 0.8), '#6a4a34', { sd: 0.5 });
    p.shape(rrect(3.4, 12.6, 9.2, 2.0, 0.8), '#6a4a34', { sd: 0.5 });
  },
  wood: (p) => {
    p.shape(rrect(1.4, 4.8, 12.0, 7.0, 3.0), '#8a5a32', { light: '#b88a55', sd: 1.2 });
    p.line(curve([[3.0, 7.2], [7.0, 6.8], [10.4, 7.4]]), 0.3, '#5a3a20'); p.line(curve([[3.4, 9.8], [8.2, 10.0]]), 0.3, '#5a3a20');
    p.shape(ellipse(12.6, 8.3, 2.4, 3.5), '#e0b886', { shade: '#b88a55', sd: 0.6 });
    p.line(ellipse(12.6, 8.3, 1.2, 1.9), 0.3, '#a07040'); p.dot(12.6, 8.3, 0.35, '#a07040');
  },
  stone: (p) => {
    p.shape(blob([[2.4, 11.6], [3.2, 6.8], [7.0, 4.2], [11.6, 5.0], [13.8, 9.4], [12.2, 12.8], [6.0, 13.4]], 1), '#a3a19a', { light: '#d0cec6', sd: 1.6, ld: 0.7 });
    p.line(curve([[7.0, 4.6], [7.8, 8.2], [12.6, 8.8]]), 0.35, '#77756f');
    p.line(curve([[7.8, 8.2], [5.2, 11.4]]), 0.3, '#77756f');
  },
  metal: (p) => {
    p.shape(poly([[1.6, 12.2], [4.0, 6.0], [14.4, 6.0], [12.2, 12.2]]), '#8aa0b0', { light: '#d4e4ee', sd: 1.0 });
    p.shape(poly([[4.0, 6.0], [5.4, 3.8], [15.0, 3.8], [14.4, 6.0]]), '#c0d4e0', { shade: null, light: '#eef8ff', ld: 0.4 });
    p.line(curve([[5.0, 8.0], [9.0, 8.0]]), 0.45, '#f4fbff');
  },
  goo: (p) => {
    const d = blob([[8.0, 1.8], [11.2, 7.2], [12.6, 10.6], [8.0, 14.4], [3.4, 10.6], [4.8, 7.2]], 1);
    const g = p.ctx.createRadialGradient(6.4, 8.0, 0.4, 8, 10, 6.4);
    g.addColorStop(0, '#e6ffc0'); g.addColorStop(0.4, '#7ae84a'); g.addColorStop(1, '#2f9a2a');
    p.fill(d, g); p.line(d, 0.5, INK);
    p.fill(ellipse(6.0, 8.6, 1.0, 1.6, 0.3), 'rgba(255,255,255,0.8)');
  },
  medkit: (p) => {
    p.line(curve([[5.6, 4.4], [5.6, 2.2], [10.4, 2.2], [10.4, 4.4]]), 0.9, INK); p.line(curve([[5.6, 4.4], [5.6, 2.2], [10.4, 2.2], [10.4, 4.4]]), 0.45, '#9aa0a8');
    p.shape(rrect(1.6, 4.0, 12.8, 9.8, 1.8), '#f2efe8', { shade: '#c8c2b8', sd: 1.0 });
    p.shape(poly([[6.8, 5.6], [9.2, 5.6], [9.2, 7.8], [11.4, 7.8], [11.4, 10.2], [9.2, 10.2], [9.2, 12.4], [6.8, 12.4], [6.8, 10.2], [4.6, 10.2], [4.6, 7.8], [6.8, 7.8]]), '#e03a3a', { light: '#ff7a6a', sd: 0.6, lw: 0.4 });
  },
  ammo: (p) => {
    for (let i = 0; i < 3; i++) {
      const x = 2.6 + i * 4.0;
      p.shape(capsule(x + 1.5, 6.0, x + 1.5, 3.2, 1.45, 0.5), '#c87a46', { light: '#f0a878', sd: 0.5, lw: 0.4 });
      p.shape(rrect(x, 5.6, 3.0, 8.4, 0.5), '#d8b048', { light: '#fff0a0', sd: 0.7 });
      p.line(curve([[x + 0.2, 12.4], [x + 2.8, 12.4]]), 0.3, '#8a6a20');
    }
  },
  shells: (p) => {
    for (let i = 0; i < 3; i++) {
      const x = 2.4 + i * 4.0;
      p.shape(rrect(x, 3.0, 3.2, 8.4, 1.0), '#d04030', { light: '#ff7a60', sd: 0.7 });
      p.shape(rrect(x - 0.2, 10.6, 3.6, 3.4, 0.5), '#d8b048', { light: '#fff0a0', sd: 0.5 });
    }
  },
  pick: (p) => {
    p.shape(capsule(3.4, 14.0, 10.4, 4.4, 0.9, 0.9), '#9a6236', { light: '#c88a54', sd: 0.5 });
    p.shape(blob([[1.4, 6.4], [5.0, 2.6], [9.6, 1.4], [14.4, 3.2], [15.0, 6.6], [12.6, 4.6], [9.4, 3.8], [4.4, 5.4]], 0.8), '#9aa4ac', { light: '#e0e8ee', sd: 0.8 });
  },
};

const iconCache: Record<string, string> = {};
export function icon(name: string): string {
  if (iconCache[name]) return iconCache[name];
  const c = canvas(ICON, ICON), ctx = get2d(c);
  ctx.setTransform(K * 0.9, 0, 0, K * 0.9, ICON * 0.05, ICON * 0.05); // a little margin for the outer contour
  (ICONS[name] || ICONS.stone)(new Pen(ctx, 0.5));
  const img = ctx.getImageData(0, 0, ICON, ICON);
  inkContour(img, 0.45 * K);
  ctx.putImageData(img, 0, 0);
  return (iconCache[name] = c.toDataURL());
}
