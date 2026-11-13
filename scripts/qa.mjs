#!/usr/bin/env node
/**
 * Fast QA: run tests/*.test.mjs in plain Node (no browser, no WebGL). The real world generator,
 * block table, defense, wave and architect-geometry modules all import fine in Node; tests stand in
 * placeholder voxel worlds where they need a World. See .claude/skills/fast-3d-testing/SKILL.md.
 *
 *   npm run qa                     every test file
 *   npm run qa -- architect waves  areas (AREAS below) or test-file name patterns
 *   npm run qa:changed             only the tests covering files changed vs origin/main (SRC_MAP)
 *   npm run qa -- -t "pillar"      only tests whose name matches
 *
 * Hard limits: QA_FILE_TIMEOUT per file (default 30 s, the process is killed), QA_MAX for the run
 * (default 120 s). Up to QA_JOBS (default 3) files run at once.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');

/** area -> test files (tests/<name>.test.mjs) */
const AREAS = {
  architect: ['architectPlans'], build: ['architectPlans', 'defenses'], building: ['architectPlans', 'defenses'],
  defenses: ['defenses', 'architectPlans'], turrets: ['defenses', 'architectPlans'],
  worldgen: ['mineralGeneration'], minerals: ['mineralGeneration'], ores: ['mineralGeneration'],
  waves: ['waveDirector'], enemies: ['waveDirector', 'castleNavigation'], navigation: ['castleNavigation'],
  player: ['jetpack', 'healthRegen'], jetpack: ['jetpack'], health: ['healthRegen'], laser: ['laserUpgrade'],
};
/** changed file -> test names (first match wins; '*' = everything). Add a line with each new test file. */
const SRC_MAP = [
  [/^tests\/worldgen-loader\.mjs$|^scripts\/qa\.mjs$|^src\/blocks\.ts$|^package\.json$/, ['*']],
  [/^tests\/(.+)\.test\.mjs$/, (m) => [m[1]]],
  [/^src\/architect(Plans)?\.ts$|^src\/construction\.ts$/, ['architectPlans']],
  [/^src\/(defenses|defensePlacement)\.ts$/, ['defenses', 'architectPlans']],
  [/^src\/(worldgen|oreNoise|genWorker)\.ts$/, ['mineralGeneration']],
  [/^src\/waveDirector\.ts$/, ['waveDirector']],
  [/^src\/(castleNavigation|flowfield)\.ts$/, ['castleNavigation']],
  [/^src\/jetpack\.ts$/, ['jetpack']],
  [/^src\/healthRegen\.ts$/, ['healthRegen']],
  [/^src\/laserUpgrade\.ts$/, ['laserUpgrade']],
];

const argv = process.argv.slice(2), patterns = [];
let filter = '', changed = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-t') filter = argv[++i] ?? '';
  else if (argv[i] === '--changed') changed = true;
  else patterns.push(argv[i]);
}
const t0 = performance.now();
const all = readdirSync(TESTS).filter((f) => f.endsWith('.test.mjs')).map((f) => f.replace(/\.test\.mjs$/, ''));

if (changed) {
  const sh = (a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };
  const base = sh(['merge-base', 'HEAD', 'origin/main'])[0] ?? 'origin/main';
  const list = [...new Set([...sh(['diff', '--name-only', base]), ...sh(['ls-files', '--others', '--exclude-standard', 'src', 'tests', 'scripts'])])];
  const names = new Set();
  for (const f of list) for (const [re, a] of SRC_MAP) {
    const m = re.exec(f);
    if (m) { for (const x of typeof a === 'function' ? a(m) : a) names.add(x); break; }
  }
  console.log(`qa --changed: ${list.length} changed file(s) -> ${names.size ? [...names].join(', ') : 'no tests cover them'}`);
  if (!names.size) process.exit(0);
  if (!names.has('*')) patterns.push(...names);
}
const want = new Set(patterns.flatMap((p) => AREAS[p] ?? [p]));
const files = all.filter((n) => !patterns.length || want.has(n) || patterns.some((p) => !AREAS[p] && n.includes(p)));
if (!files.length) {
  console.log(`qa: nothing matches ${patterns.join(' ')}\n  areas: ${Object.keys(AREAS).join(', ')}\n  files: ${all.join(', ')}`);
  process.exit(1);
}

const JOBS = Number(process.env.QA_JOBS ?? 3), FILE_TIMEOUT = Number(process.env.QA_FILE_TIMEOUT ?? 30000), MAX = Number(process.env.QA_MAX ?? 120000);
const children = new Set(), queue = [...files];
let pass = 0, fail = 0;
setTimeout(() => {
  console.log(`qa: total cap of ${MAX / 1000} s reached, killing ${children.size} file(s)`);
  for (const c of children) c.kill('SIGKILL');
  queue.length = 0; fail++;
}, MAX).unref();

async function worker() {
  for (let name; (name = queue.shift()); ) {
    const s = performance.now();
    const args = ['--experimental-loader', join(TESTS, 'worldgen-loader.mjs'), '--no-warnings', '--test', '--test-reporter=tap'];
    if (filter) args.push('--test-name-pattern', filter);
    args.push(join(TESTS, `${name}.test.mjs`));
    const { code, text } = await new Promise((res) => {
      const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      p.stdout.on('data', (d) => (text += d)); p.stderr.on('data', (d) => (text += d));
      const kill = setTimeout(() => { text += `\nnot ok - file timed out after ${FILE_TIMEOUT / 1000} s (killed)`; p.kill('SIGKILL'); }, FILE_TIMEOUT);
      children.add(p);
      p.on('close', (code) => { children.delete(p); clearTimeout(kill); res({ code, text }); });
    });
    const p = Number(/^# pass (\d+)/m.exec(text)?.[1] ?? 0), f = Number(/^# fail (\d+)/m.exec(text)?.[1] ?? (code ? 1 : 0)) || (code ? 1 : 0);
    pass += p; fail += f;
    console.log(`${f ? 'FAIL' : 'ok  '} ${name}  ${p} passed${f ? `, ${f} failed` : ''}  ${Math.round(performance.now() - s)} ms`);
    if (f) {
      // the failing subtests with their messages, not the whole TAP stream
      const lines = text.split('\n'), out = [];
      lines.forEach((l, i) => {
        if (/^\s*not ok/.test(l) && !/^not ok \d+ - \/|tests\//.test(l)) out.push(l.trim(), ...lines.slice(i + 1, i + 14).filter((x) => /error:|expected:|actual:|ERR_|Error/.test(x)).map((x) => '    ' + x.trim()));
      });
      console.log((out.length ? out : lines.slice(-25)).map((l) => '  ' + l).join('\n'));
    }
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));
console.log(`\nqa: ${pass} passed, ${fail} failed in ${files.length} file(s), ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exit(fail ? 1 : 0);
