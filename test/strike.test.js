// test/strike.test.js — pins the cue-strike math.
//
// THE most important test in the repo. Every shot in the game flows through
// applyShoot's impulse/spin block, and a transposed cross-product component or
// squirt applied to the spin line instead of the launch line produces shots
// that look plausible and are subtly wrong. These goldens were captured from
// the pre-refactor implementation; any change to them is a behaviour change and
// must be deliberate.
//
// Goldens are float32 values read back out of Ammo, widened to double, so they
// compare exactly. The tolerance is for arithmetic reassociation only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, captureLaunch } from './helpers/simHarness.js';

const EPS = 1e-9;

// A clear straight-in layout: cue on the head side, 1 ball ahead, everything
// else parked in the far corner (see makeSim).
const LAYOUT = { cue: { x: -0.6, z: 0 }, balls: { 1: { x: 0.3, z: 0 } } };

const GOLDENS = [
  {
    name: 'centre ball, no english',
    params: { yaw: 0, pitch: 0.05, strikeX: 0, strikeY: 0, power: 0.5 },
    pitch: 0.05,
    lin: { x: 3.9950013160705566, y: -0.19991669058799744, z: 0 },
    ang: { x: 0, y: 0, z: 0 },
  },
  {
    name: 'right english squirts the launch line -z',
    params: { yaw: 0, pitch: 0.05, strikeX: 0.8, strikeY: 0, power: 0.5 },
    pitch: 0.05,
    lin: { x: 3.9857966899871826, y: -0.1994560807943344, z: -0.27137333154678345 },
    ang: { x: 6.996209144592285, y: 139.80755615234375, z: 0 },
  },
  {
    name: 'left english squirts the launch line +z',
    params: { yaw: 0, pitch: 0.05, strikeX: -0.8, strikeY: 0, power: 0.5 },
    pitch: 0.05,
    lin: { x: 3.9857966899871826, y: -0.1994560807943344, z: 0.27137333154678345 },
    ang: { x: -6.996209144592285, y: -139.80755615234375, z: 0 },
  },
  {
    // Note the pitch floor fires here: a low strike point needs more elevation
    // to clear the rail behind the cue ball, so 0.05 is raised to ~0.0717.
    name: 'draw (bottom english) raises pitch and spins +z',
    params: { yaw: 0, pitch: 0.05, strikeX: 0, strikeY: -0.7, power: 0.6 },
    pitch: 0.0717071344908699,
    lin: { x: 4.787664890289307, y: -0.34389936923980713, z: 0 },
    ang: { x: 0, y: 0, z: 146.98162841796875 },
  },
  {
    name: 'follow (top english) spins -z, no squirt',
    params: { yaw: 0, pitch: 0.05, strikeX: 0, strikeY: 0.7, power: 0.6 },
    pitch: 0.05,
    lin: { x: 4.794001579284668, y: -0.23990002274513245, z: 0 },
    ang: { x: 0, y: 0, z: -146.98162841796875 },
  },
  {
    name: 'yawed with combined english',
    params: { yaw: 1.1, pitch: 0.05, strikeX: 0.4, strikeY: -0.5, power: 0.75 },
    pitch: 0.05173478937499336,
    lin: { x: 2.8980672359466553, y: -0.310091108083725, z: 5.244525909423828 },
    ang: { x: -114.4937515258789, y: 104.8464126586914, z: 64.36546325683594 },
  },
  {
    name: 'negative yaw at full power',
    params: { yaw: -2.3, pitch: 0.12, strikeX: -0.6, strikeY: 0.3, power: 1.0 },
    pitch: 0.12,
    lin: { x: -4.9811553955078125, y: -0.9564546346664429, z: -6.1865410804748535 },
    ang: { x: -61.541465759277344, y: -208.46376037597656, z: 88.69459533691406 },
  },
];

for (const g of GOLDENS) {
  test(`strike: ${g.name}`, async () => {
    const sim = await makeSim('9ball', LAYOUT);
    const L = captureLaunch(sim, g.params);
    assert.ok(L, 'runShotAndRecord was never reached');
    assert.ok(Math.abs(L.shot.pitch - g.pitch) <= EPS, `pitch ${L.shot.pitch} != ${g.pitch}`);
    for (const axis of ['x', 'y', 'z']) {
      assert.ok(Math.abs(L.lin[axis] - g.lin[axis]) <= EPS, `lin.${axis} ${L.lin[axis]} != ${g.lin[axis]}`);
      assert.ok(Math.abs(L.ang[axis] - g.ang[axis]) <= EPS, `ang.${axis} ${L.ang[axis]} != ${g.ang[axis]}`);
    }
  });
}

// --- Structural invariants: these hold independently of the numbers above and
// catch sign/axis errors that a golden refresh could otherwise mask. ---------

test('strike: english mirrors exactly about the aim line', async () => {
  const base = { yaw: 0, pitch: 0.05, strikeY: 0, power: 0.5 };
  const r = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, strikeX: 0.8 });
  const l = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, strikeX: -0.8 });
  assert.ok(Math.abs(r.lin.x - l.lin.x) <= EPS, 'forward component must be identical');
  assert.ok(Math.abs(r.lin.z + l.lin.z) <= EPS, 'sideways squirt must be equal and opposite');
  assert.ok(Math.abs(r.ang.y + l.ang.y) <= EPS, 'english spin must be equal and opposite');
});

test('strike: squirt leaves speed unchanged (direction is renormalized)', async () => {
  const base = { yaw: 0, pitch: 0.05, strikeY: 0, power: 0.5 };
  const mag = (v) => Math.hypot(v.x, v.y, v.z);
  const straight = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, strikeX: 0 });
  const english = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, strikeX: 0.8 });
  assert.ok(Math.abs(mag(straight.lin) - mag(english.lin)) <= 1e-6,
    `speed changed with english: ${mag(straight.lin)} vs ${mag(english.lin)}`);
});

test('strike: launch speed is linear in power', async () => {
  const base = { yaw: 0, pitch: 0.05, strikeX: 0, strikeY: 0 };
  const mag = (v) => Math.hypot(v.x, v.y, v.z);
  const half = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, power: 0.25 });
  const full = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, power: 0.5 });
  assert.ok(Math.abs(mag(full.lin) - 2 * mag(half.lin)) <= 1e-5,
    `not linear: ${mag(half.lin)} → ${mag(full.lin)}`);
});

test('strike: follow and draw produce opposite spin about the same axis', async () => {
  const base = { yaw: 0, pitch: 0.3, strikeX: 0, power: 0.6 };   // pitch above the floor
  const follow = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, strikeY: 0.7 });
  const draw = captureLaunch(await makeSim('9ball', LAYOUT), { ...base, strikeY: -0.7 });
  assert.ok(Math.abs(follow.ang.z + draw.ang.z) <= EPS, 'follow/draw spin must mirror');
  assert.ok(Math.abs(follow.ang.z) > 1, 'expected meaningful spin');
});

test('strike: the pitch floor can only raise the requested pitch, never lower it', async () => {
  const sim = await makeSim('9ball', LAYOUT);
  const L = captureLaunch(sim, { yaw: 0, pitch: 0.9, strikeX: 0, strikeY: -0.7, power: 0.5 });
  assert.equal(L.shot.pitch, 0.9);
});

test('strike: rejects a shot from the wrong player or wrong phase', async () => {
  const sim = await makeSim('9ball', LAYOUT);
  const params = { yaw: 0, pitch: 0.2, strikeX: 0, strikeY: 0, power: 0.5 };
  assert.equal(sim.applyShoot(1 - sim.currentPlayer(), params), false, 'wrong player must be rejected');
  sim.interact = 2;   // PH_PLACING
  assert.equal(sim.applyShoot(sim.currentPlayer(), params), false, 'wrong phase must be rejected');
});
