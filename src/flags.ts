// URL flags for cheap testing on GPU-less machines (see .claude/skills/fast-3d-testing/SKILL.md).
//   ?fast=1       preset: r=2, post=0, shadows=0, quality=low, mute=1, start=1
//   ?r=N          cap the streamed/meshed radius at N 32-block columns (default 5, up to 10 zoomed out)
//   ?post=0       render directly: no AO, bloom, light shafts, tilt-shift or grading passes
//   ?shadows=0    no shadow maps
//   ?quality=low  lowest render scale
//   ?mute=1       no music or effects
//   ?start=1      skip the title screen and start a new game as soon as the engine is ready
// Explicit flags win over the preset, e.g. ?fast=1&r=4.
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const fast = q.get('fast') === '1';
const flag = (k: string, preset: string) => q.get(k) ?? (fast ? preset : null);
const num = (v: string | null) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const FLAGS = {
  fast,
  radius: num(flag('r', '2')),
  post: flag('post', '0') !== '0',
  shadows: flag('shadows', '0') !== '0',
  lowQuality: flag('quality', 'low') === 'low',
  mute: flag('mute', '1') === '1',
  autostart: flag('start', '1') === '1',
};
