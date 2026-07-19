// test/helpers/simHarness.js — boot Ammo + build deterministic sims for tests.
//
// The sim runs headless in Node: Ammo is a CommonJS asm.js build loaded onto
// globalThis, exactly as server/index.js does it. Everything downstream of
// initPhysics() must be imported DYNAMICALLY and only after it resolves —
// physics.js captures the Ammo instance at init time, so a static import would
// bind before the global exists.
//
// DETERMINISM (the reason makeSim exists): both rulesets' rack() call shuffle()
// and apply `jitter: 0.001`, each driven by Math.random. A test that racks
// normally is therefore nondeterministic in BOTH ball identity and position.
// Every test here places balls explicitly instead — never rely on the rack.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let booted = null;

// Spacing of the parking grid for balls a test doesn't care about. Comfortably
// above 2R (0.0572 m) so they rest without contact.
const PARK_STEP = 0.07;

// Load Ammo + physics once per process. Ammo is a singleton; initPhysics() must
// not run twice. Returns the modules that can only be imported post-init.
export async function bootAmmo() {
  if (booted) return booted;
  const require = createRequire(import.meta.url);
  globalThis.Ammo = require(path.join(ROOT, 'lib/ammo.server.cjs'));
  const { initPhysics } = await import(path.join(ROOT, 'src/server/physics.js'));
  await initPhysics();
  const sim = await import(path.join(ROOT, 'src/server/sim.js'));
  const balls = await import(path.join(ROOT, 'src/server/balls.logic.js'));
  booted = {
    RoomSim: sim.RoomSim,
    PH_AIMING: sim.PH_AIMING, PH_SHOOTING: sim.PH_SHOOTING,
    PH_PLACING: sim.PH_PLACING, PH_OVER: sim.PH_OVER,
    setBallPosition: balls.setBallPosition,
  };
  return booted;
}

// Build a sim with an EXPLICIT table layout, bypassing the random rack.
//
//   rulesetId  '8ball' | '9ball'
//   placements { cue: {x,z}, balls: { <number>: {x,z}, ... } }
//   opts.phase match phase to force ('play' by default — skips break handling)
//
// Any ball not named in `placements.balls` is parked in a tight block in the far
// corner, out of the way of the shot line but still legally on the table. Balls
// are never removed, so the rules' countGroupRemaining / lowestOnTable see a
// full rack unless the caller says otherwise via `opts.remove`.
export async function makeSim(rulesetId, placements = {}, opts = {}) {
  const { RoomSim, PH_AIMING, setBallPosition } = await bootAmmo();
  const sim = new RoomSim(rulesetId);
  sim.newGame();

  const match = sim.game.getState();
  match.phase = opts.phase ?? 'play';
  if (opts.groups) {
    match.players[0].group = opts.groups[0];
    match.players[1].group = opts.groups[1];
  }
  if (opts.current != null) match.current = opts.current;
  sim.interact = PH_AIMING;

  // Drop unwanted balls before positioning, so the parking grid stays compact.
  for (const n of opts.remove || []) {
    const b = sim.balls.find(x => x.number === n);
    if (b) { sim.world.removeRigidBody(b.body); sim.balls.splice(sim.balls.indexOf(b), 1); }
  }
  sim.rebuildBallPtrMap();

  const named = new Set(Object.keys(placements.balls || {}).map(Number));
  let i = 0;
  for (const b of sim.balls) {
    if (b.style === 'cue' || named.has(b.number)) continue;
    // Parking grid in the far corner. PARK_STEP must exceed a ball DIAMETER
    // (2R = 0.0572) or the parked balls overlap and shove each other apart for
    // the whole shot — which shows up as phantom motion in every delta frame
    // and can drag a shot out to the time cap.
    setBallPosition(sim.world, b, -1.0 + PARK_STEP * (i % 4), 0.45 - PARK_STEP * ((i / 4) | 0));
    i++;
  }
  for (const [num, pos] of Object.entries(placements.balls || {})) {
    const b = sim.balls.find(x => x.number === Number(num));
    if (!b) throw new Error(`no ball numbered ${num} on the table`);
    setBallPosition(sim.world, b, pos.x, pos.z);
  }
  if (placements.cue) setBallPosition(sim.world, sim.balls[0], placements.cue.x, placements.cue.z);

  return sim;
}

// Fire a shot and hand back the recording WITHOUT simulating: stubs
// runShotAndRecord to snapshot the cue ball the instant after the impulse and
// spin are applied. This is the only way to observe launch state — applyShoot
// runs the whole shot to rest before it returns.
export function captureLaunch(sim, params) {
  const real = sim.runShotAndRecord;
  let launch = null;
  sim.runShotAndRecord = function (shot) {
    const v = sim.balls[0].body.getLinearVelocity();
    const w = sim.balls[0].body.getAngularVelocity();
    launch = {
      shot,
      lin: { x: v.x(), y: v.y(), z: v.z() },
      ang: { x: w.x(), y: w.y(), z: w.z() },
    };
    return { packet: { dtMs: 0, shot, frames: [], removals: [] }, durationMs: 0 };
  };
  try {
    sim.applyShoot(sim.currentPlayer(), params);
  } finally {
    sim.runShotAndRecord = real;
  }
  return launch;
}

// Where did ball `number` end up? Returns null once it has been removed from the
// world (pocketed and cleared at the end of the shot).
export function ballPos(sim, number) {
  const b = sim.balls.find(x => (number == null ? x.style === 'cue' : x.number === number));
  if (!b) return null;
  const o = b.body.getWorldTransform().getOrigin();
  return { x: o.x(), y: o.y(), z: o.z() };
}

export const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A straight-in pot at the bottom-right pocket: object ball `dPocket` metres
// from the pocket along the pocket line, cue ball a further `dCue` behind it.
// Returns the two positions plus the yaw that aims cue → object. Geometry
// carried over from the old draw_scan.mjs harness.
const POCKET = { x: 1.135, z: -0.575 };
const UX = 0.655 / 0.7962, UZ = -0.4525 / 0.7962;

export function potLine(dPocket, dCue) {
  const target = { x: POCKET.x - UX * dPocket, z: POCKET.z - UZ * dPocket };
  const cue = { x: target.x - UX * dCue, z: target.z - UZ * dCue };
  if (Math.abs(cue.z) > 0.52 || Math.abs(cue.x) > 1.08) {
    throw new Error(`potLine(${dPocket}, ${dCue}) puts the cue ball off the table`);
  }
  return { target, cue, yaw: Math.atan2(target.z - cue.z, target.x - cue.x), pocket: POCKET };
}
