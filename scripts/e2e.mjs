#!/usr/bin/env node
/**
 * Run the probe journeys in tests/e2e/*.js against the dev server, one browser at a time.
 *
 *   npm run e2e                     every journey
 *   npm run e2e -- traps architect  journeys whose file name contains a pattern
 *
 * Each journey is a fresh ?fast=1 page (see scripts/probe.mjs), capped at E2E_MAX seconds (default 120).
 * Runs take /tmp/blockfall-probe.lock so parallel sessions don't stack browsers and run out of RAM.
 * Needs: npx vite --port 5173 --strictPort &
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tests/e2e');
const patterns = process.argv.slice(2);
const files = readdirSync(DIR).filter((f) => f.endsWith('.js') && (!patterns.length || patterns.some((p) => f.includes(p)))).sort();
if (!files.length) { console.log(`e2e: nothing matches ${patterns.join(' ')} (have ${readdirSync(DIR).join(', ')})`); process.exit(1); }
const MAX = Number(process.env.E2E_MAX ?? 120);
const t0 = performance.now();
let failed = 0;
for (const f of files) {
  const s = performance.now();
  const { code, out } = await new Promise((res) => {
    const p = spawn('flock', ['-w', '300', '/tmp/blockfall-probe.lock', process.execPath, join(ROOT, 'scripts/probe.mjs'), '--eval-file', join(DIR, f), '--max', String(MAX)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => res({ code, out }));
  });
  const checks = out.split('\n').filter((l) => /^(ok|FAIL) /.test(l));
  const bad = checks.filter((l) => l.startsWith('FAIL'));
  if (code) failed++;
  console.log(`${code ? 'FAIL' : 'ok  '} ${f}  ${checks.length - bad.length}/${checks.length} checks  ${((performance.now() - s) / 1000).toFixed(1)} s`);
  if (code) console.log((bad.length ? bad : out.trim().split('\n').slice(-12)).map((l) => '  ' + l).join('\n'));
}
console.log(`\ne2e: ${files.length - failed}/${files.length} journeys passed, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
