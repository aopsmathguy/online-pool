// test/friction.test.js — cloth friction is applied FROM CONTACTS, at the rates
// the constants advertise.
//
// This is the calibration guard for the analytic friction pass (applyFriction)
// in server/physics.js. ALL tangential friction is resolved there now — Bullet
// bodies are frictionless and only do the normal collision — so a ball on the
// felt must decelerate at exactly the advertised rates: mu_felt_linear*g
// linearly, spin_decel_rad_s2 about the surface normal. Those rates are
// load-bearing outside the physics too — ai.js aims with A_FELT =
// mu_felt_linear*g — so drift here silently misaims the bot.
//
// Rates are measured over a window that excludes the first steps after a
// velocity is forced in, because Bullet needs a step or two to re-establish the
// contact and the ball is briefly frictionless while it does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, bootAmmo } from './helpers/simHarness.js';

const { R, g, m, FIXED_DT, mu_felt_linear, spin_decel_rad_s2, C_rr, C_spin } =
  await import('../src/shared/constants.js');
const { stepAndApplyFriction } = await import('../src/server/physics.js');

// A lone cue ball in the middle of the table, everything else parked far away.
async function loneCue() {
  const sim = await makeSim('8ball', { cue: { x: 0, z: 0 } });
  const { AmmoLib } = await import('../src/server/physics.js');
  const zero = new AmmoLib.btVector3(0, 0, 0);
  for (const b of sim.balls) {
    b.body.setLinearVelocity(zero);
    b.body.setAngularVelocity(zero);
    b.body.activate();
  }
  // Let the rack settle onto the cloth so contacts exist before anything is measured.
  for (let i = 0; i < 60; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  return { sim, cue: sim.balls[0].body, Ammo: AmmoLib };
}

const speed = (b) => { const v = b.getLinearVelocity(); return Math.hypot(v.x(), v.z()); };
const spinY = (b) => b.getAngularVelocity().y();

// Rolling without slipping is w_z = -v_x/R: the contact point at r = (0,-R,0)
// has velocity v + w x r = (v_x + R*w_z, 0, 0), which vanishes only for that
// sign. Get it backwards and the ball SLIDES — the analytic pass's kinetic
// friction then dominates and swamps what this file is measuring.
const rollSpin = (v0) => -v0 / R;

// What a rolling ball's deceleration actually measures. A tangential force on a
// ball in rolling contact does not simply divide by m: to stay rolling it must
// shed spin as it sheds speed, so it resists with its rolling inertia (1 + 2/5)m
// and an applied `a` is observed as (5/7)a. The rolling branch of applyFriction
// decelerates the ball AS a rigid rolling body for exactly this reason, so the
// OBSERVED rate is (5/7)*mu_felt_linear*g. NB this is why ai.js aiming with
// A_FELT = mu_felt_linear*g overestimates how fast the cue ball sheds speed.
const ROLLING_DILUTION = 5 / 7;

test('C_rr / C_spin are the exact conversions of the advertised rates', () => {
  // On flat felt N = m*g, so a = C_rr*N/m must be mu_felt_linear*g ...
  assert.equal(C_rr * (m * g) / m, mu_felt_linear * g);
  // ... and dw/dt = C_spin*N*R/I with I = (2/5)mR^2 must be spin_decel_rad_s2.
  const I = (2 / 5) * m * R * R;
  assert.ok(Math.abs(C_spin * (m * g) * R / I - spin_decel_rad_s2) < 1e-9);
});

test('a ball rolling on the felt decelerates at mu_felt_linear * g', async () => {
  const { sim, cue, Ammo } = await loneCue();
  // True rolling, so there is no slip and the kinetic branch does nothing; the
  // deceleration on show is the rolling-resistance branch alone.
  const v0 = 1.2;
  cue.setLinearVelocity(new Ammo.btVector3(v0, 0, 0));
  cue.setAngularVelocity(new Ammo.btVector3(0, 0, rollSpin(v0)));
  cue.activate();

  for (let i = 0; i < 5; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const start = speed(cue);
  const STEPS = 100;
  for (let i = 0; i < STEPS; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const measured = (start - speed(cue)) / (STEPS * FIXED_DT);

  const expected = ROLLING_DILUTION * mu_felt_linear * g;
  assert.ok(Math.abs(measured - expected) < 0.02 * expected,
    `linear decel ${measured.toFixed(5)} != ${expected.toFixed(5)} m/s^2`);
});

test('spin about the surface normal decays at spin_decel_rad_s2', async () => {
  const { sim, cue, Ammo } = await loneCue();
  const w0 = 30;
  cue.setLinearVelocity(new Ammo.btVector3(0, 0, 0));
  cue.setAngularVelocity(new Ammo.btVector3(0, w0, 0));
  cue.activate();

  for (let i = 0; i < 5; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const start = spinY(cue);
  const STEPS = 100;
  for (let i = 0; i < STEPS; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  const measured = (start - spinY(cue)) / (STEPS * FIXED_DT);

  assert.ok(Math.abs(measured - spin_decel_rad_s2) < 0.02 * spin_decel_rad_s2,
    `spin decel ${measured.toFixed(4)} != ${spin_decel_rad_s2} rad/s^2`);
});

test('the rate does not depend on speed (the manifold point cache is not double counted)', async () => {
  const { sim, cue, Ammo } = await loneCue();
  const rateAt = (v0) => {
    cue.setLinearVelocity(new Ammo.btVector3(v0, 0, 0));
    cue.setAngularVelocity(new Ammo.btVector3(0, 0, rollSpin(v0)));
    cue.activate();
    for (let i = 0; i < 5; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
    const s0 = speed(cue);
    for (let i = 0; i < 60; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
    return (s0 - speed(cue)) / (60 * FIXED_DT);
  };
  // Bullet caches up to 4 contact points for one sphere-on-plane contact, and
  // the cache fills as the ball moves. Charging friction per point instead of
  // per manifold showed up as ~3x the deceleration at 1.5 m/s and 1x at rest.
  const slow = rateAt(0.35), fast = rateAt(3.0);
  assert.ok(Math.abs(fast - slow) < 0.05 * slow,
    `decel is speed-dependent: ${slow.toFixed(5)} at 0.35 m/s vs ${fast.toFixed(5)} at 3.0 m/s`);
});

// The normal impulse Jn that applyFriction reads off each contact point is what
// EVERY cloth friction scales by — slide->roll, rolling resistance, spin decay.
// The whole calibration rests on one claim: over time that gated sum is the
// ball's weight and nothing more. It is checked here against the only thing
// that can settle it, conservation of vertical momentum:
//
//     sum(Jn_y) - m*g*T = m*(vy_end - vy_start)
//
// Start and end at rest and the right-hand side vanishes, so sum(Jn_y) must be
// exactly m*g*T however the ball spent the interval. A BOUNCING ball is the
// sharp case: Jn is zero through every flight and several times m*g during each
// brief compression, so a gate that admitted one stale cache point, or dropped
// one real one, would not average out — it would show up as a biased ratio here
// while the resting control still looked perfect.
test('a lightly bouncing ball averages exactly m*g of normal impulse', async () => {
  const { sim, cue, Ammo } = await loneCue();

  // Sum this step's gated normal impulse on the cue ball, projected onto +y —
  // the same gate applyFriction applies (touching points only, positive only).
  const verticalImpulse = () => {
    const disp = sim.world.getDispatcher();
    let sum = 0, pts = 0;
    for (let i = 0; i < disp.getNumManifolds(); i++) {
      const mani = disp.getManifoldByIndexInternal(i);
      const nc = mani.getNumContacts();
      if (nc === 0) continue;
      const a = mani.getBody0(), b = mani.getBody1();
      const isA = a.ptr === cue.ptr;
      if (!isA && b.ptr !== cue.ptr) continue;
      const s = isA ? 1 : -1;                   // normalWorldOnB runs B -> A
      for (let j = 0; j < nc; j++) {
        const cp = mani.getContactPoint(j);
        if (cp.getDistance() > 0) continue;     // separated cache point
        const Jn = cp.getAppliedImpulse();
        if (Jn <= 0) continue;
        sum += Jn * s * cp.get_m_normalWorldOnB().y();
        pts++;
      }
    }
    return { sum, pts };
  };

  const measure = (dropHeight, steps) => {
    const t = cue.getWorldTransform();
    t.setOrigin(new Ammo.btVector3(0, R + dropHeight, 0));
    cue.setWorldTransform(t);
    cue.getMotionState().setWorldTransform(t);
    cue.setLinearVelocity(new Ammo.btVector3(0, 0, 0));
    cue.setAngularVelocity(new Ammo.btVector3(0, 0, 0));

    let J = 0, touchdowns = 0, airSteps = 0, wasTouching = false;
    const vy0 = cue.getLinearVelocity().y();
    for (let i = 0; i < steps; i++) {
      cue.activate();                 // never let it sleep: a sleeping body gets no impulse
      stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
      const { sum, pts } = verticalImpulse();
      J += sum;
      if (pts > 0) { if (!wasTouching) touchdowns++; wasTouching = true; }
      else { airSteps++; wasTouching = false; }
    }
    const T = steps * FIXED_DT;
    const expected = m * g * T + m * (cue.getLinearVelocity().y() - vy0);
    return { ratio: J / expected, touchdowns, airSteps };
  };

  // Resting control first: if this one fails the gate is broken outright, not
  // just mis-averaged over flight.
  const rest = measure(0, 750);
  assert.ok(Math.abs(rest.ratio - 1) < 1e-4,
    `resting ball: mean normal impulse is ${rest.ratio.toFixed(6)}x m*g`);

  // Then genuinely bouncing ones. Each must actually leave the cloth, or the
  // test would pass vacuously by measuring a ball that just sat there. The
  // airborne budget is per-case because flight time scales as sqrt(h): a 0.5 mm
  // drop is ~10 ms of fall, only about 3 steps each way at FIXED_DT.
  for (const [drop, steps, minTouchdowns, minAir] of
       [[0.0005, 750, 2, 4], [0.002, 750, 3, 8], [0.010, 1000, 4, 20]]) {
    const r = measure(drop, steps);
    assert.ok(r.airSteps >= minAir && r.touchdowns >= minTouchdowns,
      `${drop * 1000}mm drop never really bounced (${r.touchdowns} touchdowns, ${r.airSteps} airborne steps)`);
    assert.ok(Math.abs(r.ratio - 1) < 1e-4,
      `${drop * 1000}mm bounce: mean normal impulse is ${r.ratio.toFixed(6)}x m*g over ${r.touchdowns} touchdowns`);
  }
});

test('a ball in the air keeps its speed and its spin', async () => {
  const { sim, cue, Ammo } = await loneCue();
  // Well clear of the cloth, so no contact and therefore no friction. Gravity
  // still acts, so only the HORIZONTAL speed is expected to be conserved.
  const t = cue.getWorldTransform();
  t.setOrigin(new Ammo.btVector3(0, R + 0.25, 0));
  cue.setWorldTransform(t);
  cue.getMotionState().setWorldTransform(t);
  cue.setLinearVelocity(new Ammo.btVector3(1.5, 0, 0));
  cue.setAngularVelocity(new Ammo.btVector3(0, 25, 0));
  cue.activate();

  const sp0 = speed(cue), wy0 = spinY(cue);
  for (let i = 0; i < 25; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  // Still airborne (0.1 s of fall from 0.25 m).
  assert.ok(cue.getWorldTransform().getOrigin().y() > R + 0.05, 'test ball landed early');

  // Tolerance is float32 slop, not a friction allowance: Bullet stores velocity
  // as btScalar=float, so a 25 rad/s spin round-trips with ~1e-5 of drift over
  // 25 steps. Any real friction here would show up four orders of magnitude
  // larger (spin_decel_rad_s2 * 0.1 s = 1 rad/s).
  assert.ok(Math.abs(speed(cue) - sp0) < 1e-4 * sp0, `airborne ball lost speed: ${sp0} -> ${speed(cue)}`);
  assert.ok(Math.abs(spinY(cue) - wy0) < 1e-4 * wy0, `airborne ball lost spin: ${wy0} -> ${spinY(cue)}`);
});

test('friction brings a ball to a dead stop, without jittering around zero', async () => {
  const { sim, cue, Ammo } = await loneCue();
  cue.setLinearVelocity(new Ammo.btVector3(0.05, 0, 0));
  cue.setAngularVelocity(new Ammo.btVector3(0, 0.4, 0));
  cue.activate();

  // The clamp on dv/dw must land both on exactly zero rather than overshoot and
  // reverse; without it a ball never rests and every shot runs to the time cap.
  for (let i = 0; i < 500; i++) stepAndApplyFriction(sim.world, sim.balls, FIXED_DT);
  assert.ok(speed(cue) < 1e-3, `ball never stopped: ${speed(cue)} m/s`);
  assert.ok(Math.abs(spinY(cue)) < 1e-3, `ball never stopped spinning: ${spinY(cue)} rad/s`);
  assert.ok(sim.ballsAtRest(), 'sim does not consider the table at rest');
});
