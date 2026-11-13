// Audio logic: settings sliders, mute, laser hum lifecycle, block-break hook, music pause/resume (was tests/audio_validation.py).
// The fast page starts muted; this journey unmutes to measure the mix through an analyser (nothing is audible headless).
// @steps 10
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = game, a = g.audio;

// settings sliders (now reached from the pause menu; there is no title screen on the fast page)
g.togglePause(true);
document.getElementById('pause-settings').click();
check('settings panel opens from pause', !document.getElementById('settings').classList.contains('hidden'));
for (const [id, v] of [['audio-music', '43'], ['audio-effects', '65']]) { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }
check('sliders save volumes', localStorage.getItem('blockfall-audio-music') === '0.43' && localStorage.getItem('blockfall-audio-effects') === '0.65', [localStorage.getItem('blockfall-audio-music'), localStorage.getItem('blockfall-audio-effects')]);
check('slider labels update', document.getElementById('audio-music-value').textContent === '43%' && document.getElementById('audio-effects-value').textContent === '65%');
check('volumes applied', Math.abs(a.musicVolume - .43) < 1e-9 && Math.abs(a.effectsVolume - .65) < 1e-9);
document.querySelector('#settings .panel-close').click();
g.togglePause(false); g.paused = false;

check('fast page starts muted', a.muted && a.master?.gain.value === 0);
a.toggleMute();
check('unmute applies effects volume', !a.muted && Math.abs(a.master.gain.value - .45 * .65) < 1e-6, a.master?.gain.value);
check('unmute applies music volume', Math.abs(a.music.volume - .25 * .43) < 1e-6, a.music?.volume);

const analyser = a.ctx.createAnalyser(); a.master.connect(analyser); analyser.fftSize = 2048;
const level = () => { const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d); return Math.max(...d.map(Math.abs)); };
if (a.ctx.state === 'suspended') await a.ctx.resume().catch(() => {});
const running = a.ctx.state === 'running';
a.setLaser(true); await sleep(100); const laserLevel = level();
check('laser hum starts', !!a.laser);
a.stopLaser(); await sleep(120); check('laser hum stops', !a.laser);
a.break_(); await sleep(80); const breakLevel = level();
const loaded = !!a.breakBuffer; a.breakBuffer = null; delete a.last.break; a.break_(); await sleep(60); const fallbackLevel = level();
check('block-break sample decoded', loaded);
if (running) check('laser, sample and synthesized break are audible in the mix', laserLevel > 0 && breakLevel > 0 && fallbackLevel > 0, { laserLevel, breakLevel, fallbackLevel });
a.toggleMute(); check('mute silences effects and music', a.master.gain.value === 0 && a.music.volume === 0); a.toggleMute();

// music follows pause
const musicElement = a.music;
g.togglePause(true); g.step(.016);
check('pause stops music and laser', a.music.paused && !a.laser);
g.togglePause(false); g.paused = false; a.setPlaying(true);
check('resume reuses the music element', a.music === musicElement);

// laser hum follows the cutter's real target state
const blocks = await import('/src/blocks.ts');
const x = Math.floor(g.player.pos.x), y = Math.floor(g.player.pos.y) + 3, z = Math.floor(g.player.pos.z);
g.world.set(x, y, z, blocks.B.STONE);
g.select(g.hotbar.findIndex((s) => s.tool === 'cutter')); g.input.lmb = true;
g.laserTarget = { hit: true, x, y, z, point: g.camera.position.clone(), nx: 0, ny: 1, nz: 0 };
g.updateActions(.001); check('cutting starts the hum', !!a.laser);
g.laserTarget.point.x += 100; g.updateActions(.001); check('out of range stops the hum', !a.laser);
g.laserTarget.point.x -= 100; g.world.set(x, y, z, blocks.B.BEDROCK); g.updateActions(.001); check('bedrock stops the hum', !a.laser);
g.world.set(x, y, z, blocks.B.STONE); g.updateActions(.001); g.select(0); check('switching tool stops the hum', !a.laser);
g.select(g.hotbar.findIndex((s) => s.tool === 'cutter')); g.updateActions(.001); g.input.lmb = false; g.updateActions(.001); check('releasing the button stops the hum', !a.laser);
g.input.lmb = true; g.updateActions(.001); g.togglePause(true); check('pausing stops the hum', !a.laser);
g.paused = false; g.updateActions(.001); g.ui.craftOpen = true; g.step(.016); check('opening a panel stops the hum', !a.laser); g.ui.craftOpen = false; g.input.lmb = false;
let breaks = 0; const original = a.break_.bind(a); a.break_ = (v) => { breaks++; original(v); };
g.world.damageBlock(x, y, z, 100000, 'laser');
check('breaking a block plays the break sound once', breaks === 1 && g.world.get(x, y, z) === blocks.B.AIR, breaks);
a.break_ = original;
const remote = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes('/audio/') && !u.startsWith(location.origin + '/audio/'));
check('audio files are served locally', remote.length === 0, remote);
return { ctx: a.ctx.state, laserLevel, breakLevel, fallbackLevel };
