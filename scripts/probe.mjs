#!/usr/bin/env node
/**
 * Ask the running game a question without a full render: load the dev server with ?fast=1
 * (small world radius, no post-processing, shadows or audio, straight into a new game), stop the
 * animation loop, advance the simulation with game.step(), then evaluate JS and print JSON.
 * A screenshot is optional and small. See .claude/skills/fast-3d-testing/SKILL.md.
 *
 *   npm run probe -- --eval "game.player.pos.toArray()"
 *   npm run probe -- --steps 40 --eval-file tests/e2e/architect.js
 *   npm run probe -- --steps 40 --eval "game.architect.enter()" --after 30 --shot /tmp/x.png
 *
 *   --url /?fast=1     page and flags (fast is added unless the url sets it; see src/flags.ts)
 *   --port 5173        dev server port (start one: npx vite --port 5173 --strictPort &)
 *   --steps 40         game.step(0.05) calls before the eval (lets the world stream in)
 *   --eval "expr"      expression or async function body (`return` allowed); the result is printed as JSON
 *   --eval-file f.js   same, read from a file; the body gets helpers: step(n, dt), render(),
 *                      check(name, ok, detail), mouse(type, x, y, button), drag(x0, y0, x1, y1) -> tooltip text
 *                      A file may start with `// @url /?fast=1&test=1`, `// @steps 60` and `// @lock 1` lines.
 *   --lock             capture the mouse first (needed for player actions: shooting, mining, placing)
 *   --after 0          game.step calls after the eval (before a shot)
 *   --shot out.png     render one frame and save it (--w 480 --h 270 by default)
 *   --nohud            hide the HUD and architect panels in the shot (they cover a small viewport)
 *   --max 180          hard wall-clock cap in seconds (kills the browser, exit 124)
 * Exit code 1 when the eval returns an object with failed checks ({ failed: n > 0 }) or throws.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const argv = process.argv.slice(2), args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
const port = args.port ?? process.env.PORT ?? '5173';
// a journey file can carry its own setup: `// @url /?fast=1&test=1` and `// @steps 60` header lines
const fileText = args['eval-file'] ? readFileSync(args['eval-file'], 'utf8') : '';
const header = (k) => new RegExp(`^//\\s*@${k}\\s+(\\S+)`, 'm').exec(fileText)?.[1];
let url = args.url ?? header('url') ?? '/?fast=1';
if (!/[?&]fast=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'fast=1';
const MAX = Math.min(600, Number(args.max ?? 180));
const W = Number(args.w ?? 480), H = Number(args.h ?? 270);
const t0 = Date.now();
const log = (...a) => console.error(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

let browser;
setTimeout(() => {
  log(`TIMEOUT after ${MAX}s: make it smaller (fewer --steps, ?r=1, no --shot)`);
  try { browser?.process?.()?.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(124);
}, MAX * 1000).unref();

browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('crash', () => { log('PAGE CRASHED (usually RAM): retry with ?r=1, fewer steps, no shot'); process.exit(2); });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

log('loading', url);
await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.gameReady === true, null, { timeout: 120000 });
log('game started');
// `// @lock 1` (or --lock): click the canvas so the game captures the mouse; the game only runs the
// player's actions (shooting, mining, placing) while pointer lock is held
if (args.lock || header('lock') === '1') {
  await page.mouse.click(W / 2, H / 2);
  await page.waitForFunction(() => document.pointerLockElement === game.canvas, null, { timeout: 15000 }).catch(() => log('WARNING: no pointer lock'));
  log('pointer locked');
}
// the simulation is advanced explicitly, so results don't depend on how slow this machine is
await page.evaluate(() => game.renderer.setAnimationLoop(null));
const steps = Number(args.steps ?? header('steps') ?? 40);
if (steps) { await page.evaluate((n) => { for (let i = 0; i < n; i++) game.step(0.05); }, steps); log(`stepped ${steps}`); }

const body = args['eval-file'] ? fileText : args.eval ? (/\breturn\b|;/.test(args.eval) ? args.eval : `return (${args.eval});`) : '';
let result, failed = false;
if (body) {
  try {
    result = await page.evaluate(async (src) => {
      const step = (n = 1, dt = 0.05) => { for (let i = 0; i < n; i++) game.step(dt); };
      const render = () => { game.camera.updateMatrixWorld(); game.renderer.render(game.scene, game.camera); };
      const results = [];
      const check = (name, ok, detail) => { results.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); return !!ok; };
      // synthetic mouse input on the canvas (real handlers, no pointer lock needed)
      const mouse = (type, x, y, button = 0) => game.canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }));
      const drag = (x0, y0, x1, y1) => {
        mouse('mousemove', x0, y0); step(1); mouse('mousedown', x0, y0); step(1);
        mouse('mousemove', (x0 + x1) / 2, (y0 + y1) / 2); step(1); mouse('mousemove', x1, y1); step(2);
        const tip = document.getElementById('arch-tip')?.innerText ?? '';
        mouse('mouseup', x1, y1); step(1);
        return tip;
      };
      const fn = new (Object.getPrototypeOf(async function () {}).constructor)('step', 'render', 'check', 'drag', 'mouse', src);
      const value = await fn(step, render, check, drag, mouse);
      return results.length ? { checks: results, failed: results.filter((r) => !r.ok).length, value } : value;
    }, body);
  } catch (e) { result = { error: e.message }; failed = true; }
  if (result && typeof result === 'object' && result.failed) failed = true;
}
const after = Number(args.after ?? 0);
if (after) await page.evaluate((n) => { for (let i = 0; i < n; i++) game.step(0.05); }, after);
if (args.shot) {
  if (args.nohud) await page.addStyleTag({ content: '#hud, #arch, #arch-tip, #toasts, #banner { display: none !important; }' });
  await page.evaluate(() => { game.camera.updateMatrixWorld(); game.frame(); });
  await page.screenshot({ path: args.shot, timeout: 60000 });
  log('saved', args.shot);
}
if (result !== undefined) {
  if (result?.checks) for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail ?? '')}`}`);
  console.log(JSON.stringify(result?.checks ? { failed: result.failed, value: result.value } : result));
}
if (errors.length) { console.log('page errors:', errors.slice(0, 5)); failed = true; }
log('done');
await browser.close();
process.exit(failed ? 1 : 0);
