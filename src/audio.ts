// Tiny WebAudio synth for all sound effects (no audio files).
interface NoiseOpts { freq?: number; to?: number | null; q?: number; type?: BiquadFilterType; vol?: number; attack?: number; }
interface ToneOpts { type?: OscillatorType; to?: number | null; vol?: number; attack?: number; delay?: number; lp?: number; }

export class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  noiseBuf: AudioBuffer | null = null;
  last: Record<string, number> = {};
  muted = false;
  constructor() { this.ctx = null; this.last = {}; this.muted = false; }
  init() {
    if (this.ctx) return;
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
      const ctx = this.ctx = new Ctor();
      const master = this.master = ctx.createGain(); master.gain.value = 0.45;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp); comp.connect(ctx.destination);
      const len = ctx.sampleRate * 2;
      const noiseBuf = this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  }
  toggleMute(): boolean { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.45; return this.muted; }
  gate(name: string, ms: number): boolean {
    const now = performance.now();
    if (this.last[name] && now - this.last[name] < ms) return false;
    this.last[name] = now; return true;
  }
  noise(dur: number, { freq = 1000, to = null, q = 1, type = 'lowpass', vol = 0.5, attack = 0.002 }: NoiseOpts = {}): void {
    const c = this.ctx; if (!c || !this.master || this.muted) return;
    const t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
  // lp: optional lowpass cutoff, so buzzy waveforms (saw/square) don't sound harsh or flatulent at low pitch
  tone(freq: number, dur: number, { type = 'sine', to = null, vol = 0.3, attack = 0.005, delay = 0, lp = 0 }: ToneOpts = {}): void {
    const c = this.ctx; if (!c || !this.master || this.muted) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.5; o.connect(f); f.connect(g); } else o.connect(g);
    g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  shot(kind: string, v = 1) {
    if (!this.gate('shot' + kind, 40)) return;
    if (kind === 'shotgun') { this.noise(0.35, { freq: 3000, to: 300, vol: 0.9 * v }); this.tone(90, 0.2, { to: 40, vol: 0.5 * v, type: 'triangle' }); }
    else if (kind === 'smg') { this.noise(0.09, { freq: 4000, to: 900, vol: 0.4 * v }); this.tone(160, 0.06, { to: 70, vol: 0.2 * v, type: 'triangle' }); }
    else if (kind === 'rocket') { this.noise(0.6, { freq: 800, to: 3000, vol: 0.5 * v, type: 'bandpass', q: 2, attack: 0.05 }); }
    else if (kind === 'turret') { this.noise(0.07, { freq: 5000, to: 1500, vol: 0.25 * v }); }
    else { this.noise(0.15, { freq: 3500, to: 600, vol: 0.55 * v }); this.tone(220, 0.08, { to: 90, vol: 0.2 * v, type: 'triangle' }); }
  }
  explosion(size = 1, v = 1) {
    if (!this.gate('boom', 60)) return;
    this.noise(1.4 * size, { freq: 1800, to: 60, vol: 1.0 * v, attack: 0.005 });
    this.tone(70, 0.8 * size, { to: 25, vol: 0.8 * v, type: 'sine' });
  }
  hit() { if (this.gate('hit', 30)) this.tone(600, 0.06, { to: 200, vol: 0.15, type: 'square' }); }
  thunk(v = 1) { if (this.gate('thunk', 50)) { this.noise(0.12, { freq: 900, to: 200, vol: 0.4 * v }); this.tone(120, 0.08, { to: 60, vol: 0.25 * v, type: 'triangle' }); } }
  break_(v = 1) { if (this.gate('break', 35)) this.noise(0.25, { freq: 1600, to: 200, vol: 0.45 * v, type: 'bandpass', q: 0.8 }); }
  crash(v = 1) { this.noise(1.0 + v, { freq: 900, to: 50, vol: 0.9 * v + 0.2 }); this.tone(55, 0.9, { to: 30, vol: 0.5 * v, type: 'triangle' }); }
  // wood/stone groaning under load: a narrow resonant scrape plus a soft falling body tone
  creak(v = 1) { if (this.gate('creak', 200)) { this.noise(0.5, { freq: 700 + Math.random() * 300, to: 450, q: 9, type: 'bandpass', vol: 0.12 + 0.18 * v, attack: 0.08 }); this.tone(180 + Math.random() * 40, 0.45, { to: 140, vol: 0.05 + 0.06 * v, type: 'triangle', attack: 0.08 }); } }
  thud() { if (this.gate('thud', 60)) this.tone(80, 0.15, { to: 40, vol: 0.35, type: 'triangle' }); }
  fuse() { if (this.gate('fuse', 100)) this.noise(0.5, { freq: 5000, vol: 0.18, type: 'highpass', attack: 0.05 }); }
  pickup() { if (this.gate('pickup', 40)) this.tone(700 + Math.random() * 200, 0.08, { to: 1400, vol: 0.12, type: 'square' }); }
  place() { this.tone(200, 0.07, { to: 140, vol: 0.25, type: 'triangle' }); this.noise(0.06, { freq: 1200, vol: 0.15 }); }
  craft() { this.tone(520, 0.08, { vol: 0.15, type: 'square' }); this.tone(780, 0.12, { vol: 0.15, type: 'square', delay: 0.08 }); }
  click() { this.tone(400, 0.04, { vol: 0.1, type: 'square' }); }
  deny() { this.tone(240, 0.1, { to: 200, vol: 0.13, type: 'triangle' }); this.tone(180, 0.12, { vol: 0.1, type: 'triangle', delay: 0.08 }); }
  jump() { this.tone(260, 0.1, { to: 420, vol: 0.08, type: 'triangle' }); }
  dash() { this.noise(0.18, { freq: 600, to: 2400, vol: 0.2, type: 'bandpass', q: 1.5 }); }
  // a punchy hit: filtered noise smack + a short falling tone (no low buzz)
  hurt() { if (this.gate('hurt', 150)) { this.noise(0.12, { freq: 1600, to: 500, q: 1.2, type: 'bandpass', vol: 0.4 }); this.tone(560, 0.13, { to: 280, vol: 0.16, type: 'triangle' }); } }
  splat() { if (this.gate('splat', 40)) this.noise(0.2, { freq: 700, to: 150, vol: 0.4 }); }
  // breathy undead moan: a vowel-like resonance over noise, with a soft voice underneath
  groan(v = 1) { if (this.gate('groan', 2500)) { this.noise(0.9, { freq: 420, to: 300, q: 6, type: 'bandpass', vol: 0.1 * v, attack: 0.25 }); this.tone(150 + Math.random() * 30, 0.9, { to: 115, vol: 0.06 * v, type: 'sawtooth', attack: 0.25, lp: 420 }); } }
  chitter(v = 1) { if (this.gate('chitter', 300)) for (let i = 0; i < 4; i++) this.tone(1800 + Math.random() * 800, 0.03, { vol: 0.05 * v, type: 'square', delay: i * 0.045 }); }
  spit() { this.noise(0.25, { freq: 400, to: 1500, vol: 0.25, type: 'bandpass', q: 3 }); }
  sizzle() { if (this.gate('sizzle', 150)) this.noise(0.3, { freq: 6000, vol: 0.12, type: 'highpass' }); }
  night() { this.tone(110, 2.5, { vol: 0.2, type: 'sine', attack: 0.4 }); this.tone(164, 2.5, { vol: 0.12, type: 'sine', attack: 0.6, delay: 0.3 }); this.tone(98, 3, { vol: 0.15, type: 'triangle', attack: 0.8, delay: 0.6 }); }
}
