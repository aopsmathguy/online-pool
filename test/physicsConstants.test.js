// test/physicsConstants.test.js — every physics constant does what it advertises.
//
// This is the wide calibration net for the whole simulation: for each constant
// in src/shared/constants.js that has a physical meaning, we compute the outcome
// ANALYTICALLY from the constant and then RUN the simulation and check the two
// agree. It complements the narrower guards:
//   * friction.test.js  — the felt slide→roll / spin-decay rates in isolation.
//   * throw.test.js      — the qualitative shape of ball–ball throw.
//   * strike.test.js     — the cue-tip → cue-ball scalar math.
// Here we pin the NUMBERS the physics engine produces against the constants.
//
// The sim's friction model (see server/physics.js): Bullet does only the
// frictionless NORMAL collision (with restitution), and one analytic pass applies
// ALL tangential friction. So:
//   - restitutions (e_*) are Bullet's, combined MULTIPLICATIVELY across the two
//     bodies in a contact (ball rest = e_ball on every ball);
//   - decelerations/throw are the analytic pass, at the advertised rates.
//
// Ranges vs. exact: a ball on a static plane (drop, felt) restitutes to the
// combined product almost exactly; a two-body (ball–ball) collision resolved in
// one substep loses ~1% in the sequential-impulse solver; the rail rebound is
// mildly speed-dependent because the ball meets the angled cushion nose. Each
// assertion's tolerance is chosen from that reality and commented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, bootAmmo } from './helpers/simHarness.js';

const C = await import('../src/shared/constants.js');
const {
  R, g, m, FIXED_DT,
  e_ball, e_rail, e_table,
  mu_felt_linear, mu_felt_kinetic, spin_decel_rad_s2, C_rr, C_spin,
  mu_ball_asym, mu_ball_amp, mu_ball_decay, mu_rail_kinetic,
} = C;
// physics.js captures the Ammo runtime at initPhysics() time and only then
// populates its AmmoLib export, so boot BEFORE reading it — a static destructure
// at import time would bind the pre-init `undefined`.
await bootAmmo();
const physics = await import('../src/server/physics.js');
const { stepAndApplyFriction, AmmoLib } = physics;

const V = (x, y, z) => new AmmoLib.btVector3(x, y, z);
const hspeed = (b) => { const v = b.getLinearVelocity(); return Math.hypot(v.x(), v.z()); };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A lone cue ball resting in the middle, everything else parked far away and the
// rack allowed to settle so felt contacts exist before anything is measured.
// (Same shape as friction.test.js's loneCue.)
async function loneCue() {
  const sim = await makeSim('8ball', { cue: { x: 0, z: 0 } });
  const zero = V(0, 0, 0);
  for (const b of sim.balls) {
    b.body.setLinearVelocity(zero);
    b.body.setAngularVelocity(zero);
    b.body.activate();
  }
  for (let i = 0; i < 60; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  return { sim, cue: sim.balls[0].body };
}

// A table stripped to just the cue ball and the 1, for two-body collision tests.
// The real felt/rails are kept (RoomSim builds them); only the extra balls go.
async function twoBall() {
  const { RoomSim } = await bootAmmo();
  const sim = new RoomSim('9ball');
  sim.newGame();
  sim.game.getState().phase = 'play';
  const keep = (b) => b.style === 'cue' || b.number === 1;
  for (const b of sim.balls) if (!keep(b)) sim.world.removeRigidBody(b.body);
  sim.balls = sim.balls.filter(keep);
  sim.rebuildBallPtrMap();
  return {
    sim,
    cue: sim.balls.find(b => b.style === 'cue'),
    obj: sim.balls.find(b => b.number === 1),
  };
}

// Lift a body to a given height with a clean transform (motion state too, or the
// next step snaps it back to the stored pose).
function lift(body, x, y, z) {
  const t = body.getWorldTransform();
  t.setOrigin(V(x, y, z));
  body.setWorldTransform(t);
  body.getMotionState().setWorldTransform(t);
}

// ===========================================================================
// GRAVITY  (g)
// ===========================================================================
test('g: a ball in free flight accelerates downward at exactly g', async () => {
  const { sim, cue } = await loneCue();
  lift(cue, 0, R + 0.5, 0);                 // high enough to stay airborne for the window
  cue.setLinearVelocity(V(0, 0, 0));
  cue.activate();

  const N = 15;                             // 0.06 s of fall from 0.5 m — no landing
  const vy0 = cue.getLinearVelocity().y();
  for (let i = 0; i < N; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const vy1 = cue.getLinearVelocity().y();
  const accel = (vy0 - vy1) / (N * FIXED_DT);

  // Semi-implicit Euler integrates a constant force exactly in the velocity, so
  // the measured acceleration should equal g to solver precision, not just near.
  assert.ok(Math.abs(accel - g) < 1e-3, `free-fall accel ${accel} != g ${g}`);
  assert.ok(cue.getWorldTransform().getOrigin().y() > R + 0.1, 'ball landed inside the window');
});

// ===========================================================================
// MIDAIR CONSERVATION  (no phantom linear or angular friction off the cloth)
// ===========================================================================
test('midair: horizontal velocity is conserved (no linear deceleration in the air)', async () => {
  const { sim, cue } = await loneCue();
  lift(cue, 0, R + 0.35, 0);
  cue.setLinearVelocity(V(1.5, 0, -0.9));   // travelling AND falling
  cue.setAngularVelocity(V(0, 0, 0));
  cue.activate();

  const v0 = cue.getLinearVelocity();
  const vx0 = v0.x(), vz0 = v0.z();
  for (let i = 0; i < 20; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  assert.ok(cue.getWorldTransform().getOrigin().y() > R + 0.05, 'ball landed early');

  const v1 = cue.getLinearVelocity();
  // The horizontal components feel no force (frictionless in the air), so they are
  // bit-for-bit conserved up to float32 storage slop — orders of magnitude tighter
  // than any real friction would be over 0.08 s.
  assert.ok(Math.abs(v1.x() - vx0) < 1e-4 * Math.abs(vx0), `airborne vx drifted ${vx0} -> ${v1.x()}`);
  assert.ok(Math.abs(v1.z() - vz0) < 1e-4 * Math.abs(vz0), `airborne vz drifted ${vz0} -> ${v1.z()}`);
});

test('midair: the full spin vector is conserved (no angular deceleration on any axis)', async () => {
  const { sim, cue } = await loneCue();
  lift(cue, 0, R + 0.35, 0);
  cue.setLinearVelocity(V(0, 0, 0));
  cue.setAngularVelocity(V(7, 13, -5));     // tumbling about all three axes
  cue.activate();

  const w0 = cue.getAngularVelocity();
  const wx0 = w0.x(), wy0 = w0.y(), wz0 = w0.z();
  for (let i = 0; i < 20; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  assert.ok(cue.getWorldTransform().getOrigin().y() > R + 0.05, 'ball landed early');

  const w1 = cue.getAngularVelocity();
  // No contact ⇒ no torque. A sphere's inertia tensor is isotropic, so there is no
  // torque-free precession either: every component is held to float slop. A real
  // spin decay would be spin_decel_rad_s2 * 0.08 s ≈ 0.8 rad/s — 4 orders larger.
  assert.ok(Math.abs(w1.x() - wx0) < 1e-3, `airborne wx drifted ${wx0} -> ${w1.x()}`);
  assert.ok(Math.abs(w1.y() - wy0) < 1e-3, `airborne wy drifted ${wy0} -> ${w1.y()}`);
  assert.ok(Math.abs(w1.z() - wz0) < 1e-3, `airborne wz drifted ${wz0} -> ${w1.z()}`);
});

// ===========================================================================
// CLOTH: linear rolling resistance  (mu_felt_linear, C_rr)
// ===========================================================================
test('C_rr / C_spin are the exact conversions of the advertised felt rates', () => {
  // On flat felt the normal load is N = m*g exactly, which is what makes the
  // force-coefficient form (physics.js) reduce back to the advertised rates:
  //   linear:  a = C_rr*N/m = C_rr*g  must equal mu_felt_linear*g
  assert.equal(C_rr * (m * g) / m, mu_felt_linear * g);
  //   spin:    dw/dt = C_spin*N*R/I  must equal spin_decel_rad_s2, I = (2/5)mR^2
  const I = (2 / 5) * m * R * R;
  assert.ok(Math.abs(C_spin * (m * g) * R / I - spin_decel_rad_s2) < 1e-9);
});

test('mu_felt_linear: a rolling ball sheds speed at (5/7)·mu_felt_linear·g', async () => {
  const { sim, cue } = await loneCue();
  // Launch it ALREADY rolling (w_z = -v/R), so there is no slip and the kinetic
  // slide branch never fires — the deceleration on show is rolling resistance alone.
  const v0 = 1.2;
  cue.setLinearVelocity(V(v0, 0, 0));
  cue.setAngularVelocity(V(0, 0, -v0 / R));
  cue.activate();

  for (let i = 0; i < 5; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);   // settle contact
  const s0 = hspeed(cue);
  const N = 100;
  for (let i = 0; i < N; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const measured = (s0 - hspeed(cue)) / (N * FIXED_DT);

  // A tangential force on a body in rolling contact is resisted by its rolling
  // inertia (1 + 2/5)m, so an applied a shows up as (5/7)a — hence the observed
  // rate is (5/7)·mu_felt_linear·g, not mu_felt_linear·g. (physics.js applyFelt
  // rolling branch; ai.js aims with the undiluted rate and thus slightly over-
  // estimates how fast the cue ball stops.)
  const expected = (5 / 7) * mu_felt_linear * g;
  assert.ok(Math.abs(measured - expected) < 0.03 * expected,
    `rolling decel ${measured.toFixed(5)} != ${expected.toFixed(5)} m/s^2`);
});

test('rolling relation: a ball on the felt holds w·R = v (angular locked to linear)', async () => {
  const { sim, cue } = await loneCue();
  // Launch as pure SLIDE (no spin): the felt must spin it up until it rolls, and
  // from then on keep w_z = -v/R as both decay.
  cue.setLinearVelocity(V(1.4, 0, 0));
  cue.setAngularVelocity(V(0, 0, 0));
  cue.activate();

  // Enough steps to finish the slide→roll conversion (a 1.4 m/s stun rolls within
  // ~0.2 s) and then some rolling travel.
  for (let i = 0; i < 120; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const v = cue.getLinearVelocity();
  const w = cue.getAngularVelocity();
  const vx = v.x();
  // Rolling without slipping about the correct axis: w_z = -vx/R.
  assert.ok(vx > 0.1, 'ball should still be moving (measurement would be trivial at rest)');
  assert.ok(Math.abs(w.z() + vx / R) < 0.03 * (vx / R),
    `not rolling cleanly: w_z ${w.z().toFixed(3)} vs -v/R ${(-vx / R).toFixed(3)}`);
});

// ===========================================================================
// CLOTH: sliding (kinetic) friction  (mu_felt_kinetic)
// ===========================================================================
test('mu_felt_kinetic: a sliding (stun) ball decelerates its centre at mu_felt_kinetic·g', async () => {
  const { sim, cue } = await loneCue();
  // Pure forward velocity, zero spin: the contact point slips forward at v, so the
  // kinetic branch applies friction mu·N = mu·m·g backward on the centre → the
  // centre-of-mass deceleration is exactly mu_felt_kinetic·g WHILE it slides.
  cue.setLinearVelocity(V(1.6, 0, 0));
  cue.setAngularVelocity(V(0, 0, 0));
  cue.activate();

  // Skip a generous warmup: forcing a fresh velocity makes Bullet drop and
  // re-cache the felt contact for a step or two (one zero-friction step, then a
  // double), which would bias a window that straddles it. By ~8 steps the contact
  // is stable and the per-step decel is a flat mu_felt_kinetic·g.
  for (let i = 0; i < 8; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const s0 = hspeed(cue);
  const N = 12;                                       // still well inside the SLIDING phase (rolls only after ~50 steps)
  for (let i = 0; i < N; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const measured = (s0 - hspeed(cue)) / (N * FIXED_DT);

  const expected = mu_felt_kinetic * g;
  assert.ok(Math.abs(measured - expected) < 0.02 * expected,
    `sliding decel ${measured.toFixed(4)} != mu_felt_kinetic·g ${expected.toFixed(4)} m/s^2`);
});

test('slide→roll: a stun ball converts to rolling, then its decel drops to the rolling rate', async () => {
  const { sim, cue } = await loneCue();
  cue.setLinearVelocity(V(1.6, 0, 0));
  cue.setAngularVelocity(V(0, 0, 0));
  cue.activate();

  // Sliding-phase rate, measured early.
  for (let i = 0; i < 4; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const a = hspeed(cue);
  for (let i = 0; i < 6; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const slideRate = (a - hspeed(cue)) / (6 * FIXED_DT);

  // Run past the slide→roll transition and measure the rolling-phase rate.
  for (let i = 0; i < 120; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const b = hspeed(cue);
  for (let i = 0; i < 40; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const rollRate = (b - hspeed(cue)) / (40 * FIXED_DT);

  // Kinetic sliding friction (mu_felt_kinetic·g ≈ 1.96) is ~28× the rolling-
  // resistance rate ((5/7)·mu_felt_linear·g ≈ 0.07): the ball must clearly stop
  // sliding hard and settle into gentle roll.
  assert.ok(slideRate > 10 * rollRate,
    `expected a sharp slide→roll drop, got slide ${slideRate.toFixed(3)} vs roll ${rollRate.toFixed(3)}`);
  assert.ok(Math.abs(rollRate - (5 / 7) * mu_felt_linear * g) < 0.05 * (5 / 7) * mu_felt_linear * g,
    `post-transition rate ${rollRate.toFixed(4)} is not the rolling rate`);
});

// ===========================================================================
// CLOTH: spin decay about the surface normal  (spin_decel_rad_s2, C_spin)
// ===========================================================================
test('spin_decel_rad_s2: spin about the vertical decays at spin_decel_rad_s2', async () => {
  const { sim, cue } = await loneCue();
  cue.setLinearVelocity(V(0, 0, 0));
  cue.setAngularVelocity(V(0, 30, 0));      // pure "english" about the normal
  cue.activate();

  for (let i = 0; i < 5; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const w0 = cue.getAngularVelocity().y();
  const N = 100;
  for (let i = 0; i < N; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const measured = (w0 - cue.getAngularVelocity().y()) / (N * FIXED_DT);

  assert.ok(Math.abs(measured - spin_decel_rad_s2) < 0.02 * spin_decel_rad_s2,
    `spin decel ${measured.toFixed(4)} != ${spin_decel_rad_s2} rad/s^2`);
});

// ===========================================================================
// GEOMETRY  (R, m)
// ===========================================================================
test('R: a ball rests one radius above the felt plane (felt at y=0)', async () => {
  const { cue } = await loneCue();
  const y = cue.getWorldTransform().getOrigin().y();
  // A sphere of radius R touching the y=0 plane has its centre at y=R. Allow a
  // little solver settling slop.
  assert.ok(Math.abs(y - R) < 1e-3, `resting ball centre at y=${y}, expected R=${R}`);
});

// ===========================================================================
// RESTITUTION: ball ↔ ball  (e_ball; equal masses ⇒ m is exercised too)
// ===========================================================================
test('e_ball: a head-on collision separates at e_ball²·(approach speed)', async () => {
  const { sim, cue, obj } = await twoBall();
  const { setBallPosition } = await bootAmmo();
  setBallPosition(sim.world, obj, 0, 0);
  setBallPosition(sim.world, cue, -0.15, 0);       // dead ahead, centres on the x-axis
  cue.body.setActivationState(4);                  // DISABLE_DEACTIVATION
  obj.body.setActivationState(4);
  cue.body.setLinearVelocity(V(1.5, 0, 0));        // stun (no spin) ⇒ zero tangential slip at contact
  cue.body.setAngularVelocity(V(0, 0, 0));
  obj.body.setLinearVelocity(V(0, 0, 0));
  obj.body.setAngularVelocity(V(0, 0, 0));

  // Watch for the step that transfers momentum to the object, capturing the cue's
  // speed on the PREVIOUS step as the true approach speed (it slid a little on the
  // felt on the way in). Then read the separated velocities one step later.
  let approach = 1.5, cueAfter = null, objAfter = null;
  for (let i = 0; i < 120; i++) {
    const before = cue.body.getLinearVelocity().x();
    stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
    const ovx = obj.body.getLinearVelocity().x();
    if (ovx > 1e-6) {                              // collision resolved this step
      approach = before;
      cueAfter = cue.body.getLinearVelocity().x();
      objAfter = ovx;
      break;
    }
  }
  assert.ok(objAfter != null, 'balls never collided');

  const restitution = (objAfter - cueAfter) / approach;   // separation / approach
  const eExpected = e_ball * e_ball;                        // Bullet combines restitution multiplicatively
  // Bullet's sequential-impulse solver loses ~1% resolving a two-body restitution
  // in one substep, so allow 4%. (A static plane, tested below, is near-exact.)
  assert.ok(Math.abs(restitution - eExpected) < 0.04 * eExpected,
    `ball-ball restitution ${restitution.toFixed(4)} != e_ball² ${eExpected.toFixed(4)}`);

  // Equal masses (both m): a head-on transfer splits as (1∓e)/2·approach. This
  // is where the ball MASS constant is exercised — an unequal mass would skew it.
  assert.ok(Math.abs(cueAfter - (1 - restitution) / 2 * approach) < 0.02 * approach,
    'cue-ball remainder inconsistent with equal masses');
  assert.ok(Math.abs(objAfter - (1 + restitution) / 2 * approach) < 0.02 * approach,
    'object-ball speed inconsistent with equal masses');
  // Momentum conserved (no mass lost in the collision).
  assert.ok(Math.abs((cueAfter + objAfter) - approach) < 0.02 * approach,
    `momentum not conserved: ${(cueAfter + objAfter).toFixed(3)} vs ${approach.toFixed(3)}`);
});

// ===========================================================================
// RESTITUTION: ball ↔ felt  (e_table)
// ===========================================================================
test('e_table: a ball dropped onto the cloth rebounds at e_ball·e_table (= 0.6)', async () => {
  const { sim, cue } = await loneCue();
  lift(cue, 0, R + 0.4, 0);
  cue.setLinearVelocity(V(0, 0, 0));
  cue.setAngularVelocity(V(0, 0, 0));       // no spin ⇒ the felt friction pass can't touch the vertical
  cue.activate();

  let vdown = 0, vup = 0, prev = 0;
  for (let i = 0; i < 400 && vdown === 0; i++) {
    stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
    const vy = cue.getLinearVelocity().y();
    if (prev < -0.1 && vy > 0.05) { vdown = -prev; vup = vy; }   // the bounce step
    prev = vy;
  }
  assert.ok(vdown > 0, 'ball never bounced');

  const restitution = vup / vdown;
  const eExpected = e_ball * e_table;       // combined = 0.6 by construction of e_table
  // A ball on a STATIC plane restitutes almost exactly (no second dynamic body to
  // iterate against), so this is tight.
  assert.ok(Math.abs(restitution - eExpected) < 0.02 * eExpected,
    `ball-table restitution ${restitution.toFixed(4)} != ${eExpected.toFixed(4)}`);
});

// ===========================================================================
// RESTITUTION: ball ↔ rail  (e_rail)
// ===========================================================================
test('e_rail: a ball into the cushion head-on rebounds in the documented ~0.85 band', async () => {
  const { sim, cue, obj } = await twoBall();
  const { setBallPosition } = await bootAmmo();
  setBallPosition(sim.world, obj, -0.5, 0.3);       // park the 1 out of the way

  // The rebound is mildly SPEED-DEPENDENT: the ball meets the angled cushion nose,
  // not a flat wall, and the sequential-impulse restitution softens as the impact
  // hardens (~0.90 at 0.5 m/s → ~0.82 at 3 m/s). So this is a BAND check around the
  // constant's documented "ball·rail combine = 0.85", not an exact match — averaged
  // over a spread of normal play speeds.
  function railE(v0) {
    setBallPosition(sim.world, cue, 0.85, 0);        // near the right cushion, aimed straight at it
    cue.body.setActivationState(4);
    cue.body.setLinearVelocity(V(v0, 0, 0));         // perpendicular ⇒ zero tangential slip, pure normal rebound
    cue.body.setAngularVelocity(V(0, 0, 0));
    let pre = v0, neg = 0;
    for (let i = 0; i < 300; i++) {
      stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
      const vx = cue.body.getLinearVelocity().x();
      if (vx > 0) pre = vx;                          // last inbound speed before the cushion
      if (vx < 0 && ++neg === 3) return -vx / pre;   // settled outbound speed
    }
    return NaN;
  }

  const speeds = [0.6, 1.0, 1.5, 2.0, 3.0];
  const es = speeds.map(railE);
  for (const e of es) assert.ok(Number.isFinite(e), 'a rail rebound was never detected');
  // Every speed lands in a plausible cushion band, and the average sits near 0.85.
  for (let i = 0; i < es.length; i++) {
    assert.ok(es[i] > 0.78 && es[i] < 0.94,
      `rail restitution ${es[i].toFixed(3)} at ${speeds[i]} m/s is outside the cushion band`);
  }
  const avg = es.reduce((s, e) => s + e, 0) / es.length;
  assert.ok(Math.abs(avg - 0.85) < 0.05, `mean rail restitution ${avg.toFixed(3)} is not near the documented 0.85`);
});

// ===========================================================================
// BALL–BALL THROW FRICTION CURVE  (mu_ball_asym, mu_ball_amp, mu_ball_decay)
// ===========================================================================
test('mu_ball_*: the throw-friction coefficient has the advertised endpoints', () => {
  // This is the exact function physics.js uses, ballBallMu(s) = asym + amp·e^(−decay·s).
  const mu = (s) => mu_ball_asym + mu_ball_amp * Math.exp(-mu_ball_decay * s);
  // s → 0 (a dead-soft contact) tends to asym + amp; the comment advertises ≈ 0.118.
  assert.ok(Math.abs(mu(0) - (mu_ball_asym + mu_ball_amp)) < 1e-12);
  assert.ok(Math.abs(mu(0) - 0.118) < 0.002, `mu(0) = ${mu(0).toFixed(4)}, expected ≈ 0.118`);
  // s → ∞ (a firm contact) tends to the high-speed asymptote.
  assert.ok(mu(50) - mu_ball_asym < 1e-9 && mu(50) >= mu_ball_asym);
  assert.ok(Math.abs(mu_ball_asym - 0.00995) < 1e-4, 'high-speed asymptote drifted');
  // Strictly falling in between (this is the whole point — soft shots throw more).
  assert.ok(mu(0) > mu(0.5) && mu(0.5) > mu(1.5) && mu(1.5) > mu(3));
});

test('mu_ball_*: a cut collision realises the throw-friction curve (falls with contact slip)', async () => {
  const { sim, cue, obj } = await twoBall();
  const { setBallPosition } = await bootAmmo();
  const muFormula = (s) => mu_ball_asym + mu_ball_amp * Math.exp(-mu_ball_decay * s);

  // Fire the cue at a fixed cut so first contact lands on the +x impact line: the
  // object leaves along +x (its normal impulse) with a tangential kick (the throw
  // impulse) in ±z. With the object starting at rest, its post-collision velocity
  // IS the impulse/m, so the effective friction coefficient the sim applied is
  //   mu_eff = |tangential Δv| / |normal Δv|,
  // which we compare to muFormula(slip) evaluated at the measured contact slip.
  async function cut(V0) {
    const phi = 25 * Math.PI / 180;
    const cx = Math.cos(phi), sz = Math.sin(phi), gap = 0.01;
    setBallPosition(sim.world, obj, 0, 0);
    setBallPosition(sim.world, cue, -2 * R - cx * gap, -sz * gap);
    cue.body.setActivationState(4); obj.body.setActivationState(4);
    // STUN cue (no spin): the only tangential slip at contact is the in-plane
    // component of travel (V·sinφ in ±z), so the whole throw impulse lands in the
    // table plane and the object's post-velocity reconstructs the coefficient
    // cleanly. (A rolling cue would throw the object partly DOWNWARD, and the felt
    // absorbs that, hiding most of the tangential impulse.) The gap is tiny, so
    // the felt barely bleeds the stun speed before contact.
    const vx = V0 * cx, vz = V0 * sz;
    cue.body.setLinearVelocity(V(vx, 0, vz));
    cue.body.setAngularVelocity(V(0, 0, 0));
    obj.body.setLinearVelocity(V(0, 0, 0));
    obj.body.setAngularVelocity(V(0, 0, 0));

    const pos = (b) => b.body.getWorldTransform().getOrigin();
    const dist = () => { const c = pos(cue), o = pos(obj); return Math.hypot(c.x() - o.x(), c.z() - o.z()); };
    const dt = 3e-4;                                  // sub-mm steps: clean contact resolution at any speed
    let slip = null, out = null;
    for (let i = 0; i < 20000 && !out; i++) {
      if (slip === null && dist() <= 2 * R * 1.0005) {
        // Contact-point slip of the cue against the (stationary) object; normal ≈ +x.
        const lv = cue.body.getLinearVelocity(), wv = cue.body.getAngularVelocity();
        // surface vel = v + w × (R·n̂), n̂ = +x
        const su = { x: lv.x() + (wv.y() * 0 - wv.z() * 0),
                     y: lv.y() + (wv.z() * R - wv.x() * 0),
                     z: lv.z() + (wv.x() * 0 - wv.y() * R) };
        slip = Math.hypot(su.y, su.z);               // tangential part (normal is x)
      }
      stepAndApplyFriction(sim.world, sim.balls, dt);
      const ov = obj.body.getLinearVelocity();
      if (slip !== null && Math.hypot(ov.x(), ov.z()) > 0.02 && dist() > 2 * R * 1.05) {
        out = { vx: ov.x(), vy: ov.y(), vz: ov.z() };
      }
    }
    // normal impulse ∝ vx (impact line), tangential impulse ∝ the ⟂ components.
    const muEff = Math.hypot(out.vy, out.vz) / Math.abs(out.vx);
    return { slip, muEff, muCurve: muFormula(slip) };
  }

  // Two FIRM shots (high contact slip): here the throw impulse is friction-limited,
  // NOT gearing-capped, so the applied coefficient should track the curve. (Soft
  // shots hit the (m/7)·slip gearing cap and read LOWER than the curve — tested in
  // throw.test.js as "throw falls with speed".)
  const mid = await cut(2.0);
  const firm = await cut(3.5);

  // Effective coefficient matches the analytic curve within measurement noise...
  assert.ok(Math.abs(mid.muEff - mid.muCurve) < 0.2 * mid.muCurve,
    `mid cut mu_eff ${mid.muEff.toFixed(4)} != curve ${mid.muCurve.toFixed(4)} at slip ${mid.slip.toFixed(3)}`);
  assert.ok(Math.abs(firm.muEff - firm.muCurve) < 0.25 * firm.muCurve,
    `firm cut mu_eff ${firm.muEff.toFixed(4)} != curve ${firm.muCurve.toFixed(4)} at slip ${firm.slip.toFixed(3)}`);
  // ...and, the signature of the mu_ball_decay term, it FALLS as the slip rises.
  assert.ok(firm.slip > mid.slip && firm.muEff < mid.muEff,
    `throw friction should fall with contact slip: ${mid.muEff.toFixed(4)}@${mid.slip.toFixed(2)} vs ${firm.muEff.toFixed(4)}@${firm.slip.toFixed(2)}`);
});

// ===========================================================================
// RAIL TANGENTIAL FRICTION  (mu_rail_kinetic)
// ===========================================================================
test('mu_rail_kinetic: an angled cushion hit rubs tangentially, more so at steeper incidence', async () => {
  const { sim, cue, obj } = await twoBall();
  const { setBallPosition } = await bootAmmo();
  setBallPosition(sim.world, obj, -0.5, 0.3);

  // A ball into the cushion carrying tangential velocity (vz) leaves with LESS of
  // it — the rail's tangential friction (mu_rail_kinetic) drags the contact. We
  // reconstruct the effective coefficient as tangential-impulse / normal-impulse.
  // The absolute value is softened by the gearing cap and by the nose geometry, so
  // we assert the friction is (a) present, (b) bounded by the coefficient's reach,
  // and (c) grows with the incidence angle — the qualitative fingerprint of a
  // Coulomb tangential drag. (The precise cushion-friction magnitude for real cut
  // rebounds is exercised end-to-end by the potting/bank tests.)
  function hit(vx, vz) {
    setBallPosition(sim.world, cue, 0.55, 0);
    cue.body.setActivationState(4);
    cue.body.setLinearVelocity(V(vx, 0, vz));
    cue.body.setAngularVelocity(V(0, 0, 0));
    let pre = null, neg = 0, post = null;
    for (let i = 0; i < 400; i++) {
      const b = cue.body.getLinearVelocity();
      const bx = b.x(), bz = b.z();
      stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
      const a = cue.body.getLinearVelocity();
      if (bx > 0) pre = { x: bx, z: bz };
      if (a.x() < 0 && ++neg === 3) { post = { x: a.x(), z: a.z() }; break; }
    }
    const Jn = m * (pre.x - post.x);        // normal (x) impulse, post.x < 0
    const Jt = m * (pre.z - post.z);        // tangential (z) impulse removed
    return { muEff: Jt / Jn, dz: pre.z - post.z };
  }

  const shallow = hit(1.5, 0.3);
  const steep = hit(1.5, 1.0);

  // Friction actually acts (some tangential velocity is scrubbed off), and it
  // opposes the motion (positive drag, ball keeps travelling the same way in z).
  assert.ok(shallow.dz > 0 && steep.dz > 0, 'cushion did not scrub tangential speed');
  // The effective coefficient never exceeds the constant's reach by much (gearing
  // cap keeps it at or below mu_rail_kinetic in this regime).
  assert.ok(shallow.muEff > 0 && shallow.muEff <= mu_rail_kinetic * 1.15,
    `shallow-hit mu_eff ${shallow.muEff.toFixed(4)} out of range for mu_rail_kinetic ${mu_rail_kinetic}`);
  assert.ok(steep.muEff > 0 && steep.muEff <= mu_rail_kinetic * 1.15,
    `steep-hit mu_eff ${steep.muEff.toFixed(4)} out of range for mu_rail_kinetic ${mu_rail_kinetic}`);
  // Steeper incidence (more tangential slip) engages more of the coefficient.
  assert.ok(steep.muEff > shallow.muEff + 0.01,
    `expected more tangential drag at steeper incidence: ${shallow.muEff.toFixed(4)} vs ${steep.muEff.toFixed(4)}`);
});
