// @steps 0
// Drawbridge / workbench control transactions in src/construction.ts against a placeholder voxel world
// (was tests/construction_test.py, ported nearly verbatim). Placement itself now happens in the architect
// (tests/e2e/build.js); this covers raising, lowering, support rejection, save/restore and line of sight.
// It runs in the page because construction.ts uses a TypeScript parameter property, which Node's type
// stripping rejects. npm run e2e -- construction
const { Construction } = await import('/src/construction.ts');
const V3 = game.player.pos.constructor, Scene = game.scene.constructor;

function fixture() {
  const cells = new Map(), key = (x, y, z) => [x, y, z].join(',');
  const state = { unsupported: false, blocked: false, writes: 0, supportChecks: 0 };
  const world = {
    inBounds: () => true, chunkAt: () => ({}),
    get: (x, y, z) => cells.get(key(x, y, z)) || 0,
    solid: (x, y, z) => !!cells.get(key(x, y, z)),
    set: (x, y, z, t) => { state.writes++; return t ? cells.set(key(x, y, z), t) : cells.delete(key(x, y, z)); },
    findFloating: (cs) => (state.unsupported ? [[[...cs[0]]]] : []),
    raycast: () => (state.blocked ? { hit: true, x: 100, y: 100, z: 100 } : { hit: false }),
  };
  const toasts = [];
  const mock = {
    world, scene: new Scene(),
    player: { pos: new V3(0.5, 0, -2), aimDir: new V3(0, 0, 1) },
    inv: { planks: 100 }, entities: { blocksCell: () => false },
    checkSupport: () => { state.supportChecks++; }, audio: { deny() {}, place() {} }, ui: { toast: (m) => toasts.push(m) },
  };
  // a 2 × 3 deck as the architect writes it: span-first per side, the first cell of each side is the hinge
  const deck = [];
  for (let x = 0; x < 2; x++) for (let z = 0; z < 3; z++) deck.push([x, 0, z]);
  for (const c of deck) world.set(...c, 9);
  state.writes = 0;
  const c = new Construction(mock);
  return { cells, state, world, mock, deck, toasts, c };
}

{ // raise and lower; the raised state survives snapshot / restore
  const { cells, state, world, mock, deck, c } = fixture();
  c.registerBridge(deck, 9);
  check('bridge offers raise', c.interactionHint() === 'E · Raise drawbridge', c.interactionHint());
  const r = c.interact();
  check('raising', r === 'bridge' && cells.size === 6 && world.get(0, 2, 0) === 9 && !world.get(0, 0, 2) && state.supportChecks > 0, { r, size: cells.size });
  const other = new Construction(mock);
  other.restore(JSON.parse(JSON.stringify(c.snapshot())));
  state.blocked = true;
  const through = other.interact();
  check('no interaction through a wall', through === null, through);
  state.blocked = false;
  const lowered = other.interact();
  check('restored bridge lowers', lowered === 'bridge' && !world.get(0, 2, 0) && world.get(0, 0, 2) === 9, lowered);
  other.onBlockRemoved(0, 0, 0); world.set(0, 0, 0, 0); world.set(0, 0, 0, 9);
  const revived = other.interact();
  check('destroyed bridge control is not revived', revived === null && other.snapshot().bridges.length === 0, revived);
}

{ // an unsupported result is refused before any write (support is checked on an overlay, not the world)
  const { cells, state, deck, toasts, c } = fixture();
  c.registerBridge(deck, 9);
  state.unsupported = true;
  const r = c.interact();
  check('unsupported raise makes no writes', r === 'bridge' && state.writes === 0 && cells.size === 6 && !c.snapshot().bridges[0].raised, { r, writes: state.writes });
  check('unsupported raise says why', /support/i.test(toasts.at(-1) ?? ''), toasts.at(-1));
}

{ // something in the way of the upright hinge column
  const { state, world, deck, c } = fixture();
  c.registerBridge(deck, 9);
  world.set(0, 1, 0, 3); state.writes = 0;
  const r = c.interact();
  check('obstructed bridge does not move', r === 'bridge' && state.writes === 0 && world.get(0, 0, 2) === 9, { r, writes: state.writes });
}

{ // workbench reach, removal and restore
  const { world, mock, c } = fixture();
  world.set(3, 0, -2, 4);
  mock.player.pos.set(1.5, 0, -2.5);
  c.registerBench([3, 0, -2], 4);
  check('workbench within reach', c.nearWorkbench());
  mock.player.pos.set(20, 0, 20);
  check('workbench out of reach', !c.nearWorkbench());
  mock.player.pos.set(1.5, 0, -2.5);
  const saved = JSON.parse(JSON.stringify(c.snapshot()));
  c.onBlockRemoved(3, 0, -2);
  check('removed workbench is forgotten', !c.nearWorkbench());
  const restored = new Construction(mock);
  restored.restore(saved);
  check('restored workbench works', restored.nearWorkbench());
}
