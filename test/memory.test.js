// test/memory.test.js — the Ammo heap must not grow with use.
//
// Every Bullet object lives in the WASM heap, which the JS garbage collector
// cannot see: a body, a shape or a world that is merely forgotten is leaked for
// the life of the process. That made three separate leaks, all of them invisible
// to `process.memoryUsage().heapUsed` and none of them caught by any test that
// only checks behaviour — a room cost ~4 MB it never gave back, a rack ~20 KB,
// and a single `placeMove` packet 64 bytes.
//
// So this measures the heap directly. There is no API for its size, but the
// allocator is enough: ask for a block far larger than any hole the sim could
// leave behind and it can only be served from the top, so the pointer that comes
// back IS the high-water mark. Free it again and repeat, and the difference
// between two probes is exactly what the work in between failed to release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAmmo } from './helpers/simHarness.js';

const { RoomSim, PH_PLACING } = await bootAmmo();
const { AmmoLib } = await import('../src/server/physics.js');

const PROBE = 8 << 20;                       // bigger than any hole the sim leaves
const free = AmmoLib._free || AmmoLib._webidl_free;
const heapTop = () => { const p = AmmoLib._malloc(PROBE); free(p); return p; };
const KB = (n) => `${(n / 1024).toFixed(1)} KB`;

// Generous next to the leaks this guards (4 MB, 20 KB and 64 B per unit of
// work), tight enough that any of them reappearing fails immediately. Bullet
// grows a few internal pools on first use, which is what the warm-up absorbs.
const SLACK = 64 * 1024;

// Racks are random (see the determinism rule in the harness), but nothing here
// asserts on physics — what a ball does cannot change how many were allocated.
const freshRoom = () => { const s = new RoomSim('8ball'); s.newGame(); return s; };

test('a disposed room hands its whole world back', () => {
  freshRoom().dispose();                     // warm-up: first-use pools, probe block
  const before = heapTop();
  const N = 6;
  for (let i = 0; i < N; i++) freshRoom().dispose();
  const grew = heapTop() - before;
  assert.ok(grew < SLACK,
    `${N} room lifecycles grew the Ammo heap by ${KB(grew)} (${KB(grew / N)} per room) — ` +
    'a world is being dropped instead of destroyed; see destroyWorld in physics.js');
});

test('reracking does not grow the heap', () => {
  const sim = freshRoom();
  sim.newGame();                             // warm-up
  const before = heapTop();
  const N = 20;
  for (let i = 0; i < N; i++) sim.newGame();
  const grew = heapTop() - before;
  sim.dispose();
  assert.ok(grew < SLACK,
    `${N} reracks grew the Ammo heap by ${KB(grew)} (${KB(grew / N)} per rack) — ` +
    'the previous rack\'s bodies are being removed from the world but not destroyed');
});

test('ball-in-hand placement does not grow the heap', () => {
  const sim = freshRoom();
  sim.startPlacement({ behindLine: false });
  assert.equal(sim.phase(), PH_PLACING);
  const me = sim.currentPlayer();
  sim.applyPlaceMove(me, -0.5, 0);           // warm-up
  const before = heapTop();
  const N = 5000;                            // ~4 minutes of dragging at 20 Hz
  for (let i = 0; i < N; i++) sim.applyPlaceMove(me, -0.5 + (i % 100) * 0.001, 0.01 * (i % 7));
  const grew = heapTop() - before;
  sim.dispose();
  assert.ok(grew < SLACK,
    `${N} placeMove packets grew the Ammo heap by ${KB(grew)} (${(grew / N).toFixed(1)} bytes each) — ` +
    'setBallPosition is allocating a vector or quaternion per call instead of reusing scratch');
});

test('a shot does not grow the heap', () => {
  const sim = freshRoom();
  const shoot = () => sim.applyShoot(sim.currentPlayer(),
    { yaw: 0.7, pitch: 0.05, strikeX: 0, strikeY: 0, power: 0.9 });
  if (sim.phase() === PH_PLACING) sim.applyPlaceConfirm(sim.currentPlayer());
  shoot();                                   // warm-up: the break grows Bullet's pools
  const before = heapTop();
  const N = 6;
  for (let i = 0; i < N; i++) {
    if (sim.phase() === PH_PLACING) sim.applyPlaceConfirm(sim.currentPlayer());
    if (!shoot()) break;                     // game over — the heap check still stands
  }
  const grew = heapTop() - before;
  sim.dispose();
  assert.ok(grew < SLACK,
    `${N} shots grew the Ammo heap by ${KB(grew)} — pocketed balls are probably being ` +
    'removed from the world but not destroyed (see clearSunk)');
});

test('dispose is idempotent', () => {
  const sim = freshRoom();
  sim.dispose();
  assert.doesNotThrow(() => sim.dispose(),
    'a room can be torn down by both a disconnect and a timeout; the second must be a no-op');
});
