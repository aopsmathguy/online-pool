// test/conservation.test.js — a ball-ball collision must conserve momentum and
// must not invent energy.
//
// Why this file exists: the angle a collision produces is calibration and can
// legitimately drift, but momentum and energy are INVARIANTS — no tuning change
// should ever move them. They also fail in different ways, and the difference is
// diagnostic. A speculative (zero-overlap) contact, which Bullet resolves with
// NO restitution, conserves momentum exactly while destroying half the energy;
// a momentum test alone sails straight past it. Both bounds are checked here.
//
// Everything runs with GRAVITY OFF and the balls floating well clear of the
// cloth, rails and pockets. That is deliberate: cloth and rails are external
// forces, so on a normal shot momentum is not conserved and energy decays, and
// neither quantity proves anything. Floating, the only forces left are the
// ball-ball contact and the analytic throw pass, both internal — so momentum
// must hold to float precision and energy may only fall by what restitution and
// throw can account for.
//
// Bullet's btScalar is single precision (eps ~ 1.2e-7), so the momentum
// tolerance is a float32 floor, not a physics allowance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, bootAmmo } from './helpers/simHarness.js';

const { R, FIXED_DT, m, e_ball } = await import('../src/shared/constants.js');
// physics.js binds its Ammo handle inside initPhysics(), so `AmmoLib` is still
// undefined at import time. Hold the MODULE (whose properties are live) and read
// .AmmoLib only after bootAmmo() has resolved — destructuring it here would
// snapshot undefined, which is the trap simHarness.js documents.
const phys = await import('../src/server/physics.js');
const { stepAndApplyFriction } = phys;

const DEG = 180 / Math.PI;
const I = 0.4 * m * R * R;

// Bullet COMBINES the two bodies' restitution multiplicatively, so a ball-ball
// contact runs at e_ball^2 = 0.95, not e_ball. Getting this wrong makes the
// energy bound too tight by a factor of two.
const E_COMB = e_ball * e_ball;

// Height above the cloth. Must clear the felt, the rails and the pocket cups so
// that no external contact can appear and pollute the totals.
const FLY = R + 0.30;

// Tolerances. Momentum: float32. Energy: measured worst case across this exact
// sweep is 1.07x the analytic bound (the throw allowance below is approximate,
// so a small overshoot is expected); 1.5 leaves headroom without letting the
// speculative-contact failure through, which overshoots by 232x.
const P_TOL = 1e-6;
const E_BOUND_FACTOR = 1.5;

const V = (b) => { const v = b.body.getLinearVelocity(); return { x: v.x(), y: v.y(), z: v.z() }; };
const W = (b) => { const w = b.body.getAngularVelocity(); return { x: w.x(), y: w.y(), z: w.z() }; };
const Pos = (b) => { const o = b.body.getWorldTransform().getOrigin(); return { x: o.x(), y: o.y(), z: o.z() }; };

function totalP(balls) {
  let x = 0, y = 0, z = 0;
  for (const b of balls) { const v = V(b); x += m * v.x; y += m * v.y; z += m * v.z; }
  return { x, y, z, mag: Math.hypot(x, y, z) };
}
function totalKE(balls) {
  let e = 0;
  for (const b of balls) {
    const v = V(b), w = W(b);
    e += 0.5 * m * (v.x ** 2 + v.y ** 2 + v.z ** 2) + 0.5 * I * (w.x ** 2 + w.y ** 2 + w.z ** 2);
  }
  return e;
}

// A floating pair, everything else parked far away at the same height.
async function floatingPair() {
  const { setBallPosition } = await import('../src/server/balls.logic.js');
  const sim = await makeSim('9ball', {});
  sim.world.setGravity(new phys.AmmoLib.btVector3(0, 0, 0));
  return { sim, setBallPosition };
}

// Fire the cue ball at the object ball at `cutDeg`, `speed`, with `spin`, offset
// into the tick by `ph`/4 of a step so the sub-tick phase is swept too (the
// collision's sub-tick timing changes the contact geometry, so a sweep that
// ignores it tests one phase over and over).
function collide({ sim, setBallPosition }, { cutDeg, speed, spin, ph }) {
  const all = sim.balls, cue = all[0], obj = all[1], pair = [cue, obj];
  let i = 0;
  for (const b of all) {
    setBallPosition(sim.world, b, -0.9 + 0.08 * (i % 5), 0.40 - 0.08 * ((i / 5) | 0), FLY);
    i++;
  }
  const th = cutDeg / DEG;
  setBallPosition(sim.world, obj, 0, 0, FLY);
  setBallPosition(sim.world, cue,
    -2 * R * Math.cos(th) - (0.10 + (ph / 4) * speed * FIXED_DT), -2 * R * Math.sin(th), FLY);

  const set = (b, fn, x, y, z) => {
    const v = new phys.AmmoLib.btVector3(x, y, z);
    b.body[fn](v);
  };
  set(cue, 'setLinearVelocity', speed, 0, 0);
  if (spin === 'roll') set(cue, 'setAngularVelocity', 0, 0, -speed / R);
  else if (spin === 'stun') set(cue, 'setAngularVelocity', 0, 0, 0);
  else if (spin === 'draw') set(cue, 'setAngularVelocity', 0, 0, speed / R);
  else set(cue, 'setAngularVelocity', 0, speed / R, 0);   // pure side english
  for (const b of pair) b.body.activate();

  const ke0 = totalKE(pair), p0 = totalP(pair);

  // Capture the approach on the last step before contact: the restitution bound
  // needs the closing speed along the line of centres, and the throw allowance
  // needs the tangential slip there.
  let vn = 0, uT = 0, touched = false;
  for (let s = 0; s < Math.round(0.25 / FIXED_DT); s++) {
    const pc = Pos(cue), po = Pos(obj);
    const dx = po.x - pc.x, dy = po.y - pc.y, dz = po.z - pc.z;
    const d = Math.hypot(dx, dy, dz);
    if (!touched && d > 2 * R) {
      const nx = dx / d, ny = dy / d, nz = dz / d;
      const vc = V(cue), vo = V(obj);
      const rx = vc.x - vo.x, ry = vc.y - vo.y, rz = vc.z - vo.z;
      const approach = rx * nx + ry * ny + rz * nz;
      if (approach > 0) {
        vn = approach;
        const wc = W(cue), wo = W(obj);
        // surface velocities at the contact: w x (+/- R n)
        const cx = wc.y * (R * nz) - wc.z * (R * ny);
        const cy = wc.z * (R * nx) - wc.x * (R * nz);
        const cz = wc.x * (R * ny) - wc.y * (R * nx);
        const ox = wo.y * (-R * nz) - wo.z * (-R * ny);
        const oy = wo.z * (-R * nx) - wo.x * (-R * nz);
        const oz = wo.x * (-R * ny) - wo.y * (-R * nx);
        let tx = rx + cx - ox, ty = ry + cy - oy, tz = rz + cz - oz;
        const tn = tx * nx + ty * ny + tz * nz;
        tx -= tn * nx; ty -= tn * ny; tz -= tn * nz;
        uT = Math.hypot(tx, ty, tz);
      }
    }
    if (d < 2 * R) touched = true;
    stepAndApplyFriction(sim.world, pair, FIXED_DT);
  }

  const ke1 = totalKE(pair), p1 = totalP(pair);
  const vo = V(obj);
  return {
    hit: Math.hypot(vo.x, vo.y, vo.z) > 0.01,
    dPrel: Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) / (p0.mag || 1),
    ke0, ke1,
    // Equal masses -> reduced mass m/2, so the normal direction loses
    // (1-e^2) of (1/2)(m/2)v_n^2. Throw can additionally dissipate the
    // tangential slip, capped by the gearing impulse (m/7)u_T.
    bound: (m / 4) * vn * vn * (1 - E_COMB * E_COMB) + 0.5 * (m / 7) * uT * uT,
  };
}

const CUTS = [0, 10, 25, 40, 55, 70, 82];
const SPEEDS = [0.5, 1, 2, 4, 6, 8];
const SPINS = ['roll', 'stun', 'draw', 'side'];

test('ball-ball collisions conserve momentum and never create energy', async () => {
  await bootAmmo();
  const ctx = await floatingPair();

  let shots = 0, hits = 0;
  let worstP = 0, worstPCase = '';
  let worstGain = 0, worstGainCase = '';
  let worstE = 0, worstECase = '';

  for (const cutDeg of CUTS) {
    for (const speed of SPEEDS) {
      for (const spin of SPINS) {
        for (let ph = 0; ph < 4; ph++) {
          const r = collide(ctx, { cutDeg, speed, spin, ph });
          shots++;
          const label = `${cutDeg}deg ${speed}m/s ${spin} phase${ph}`;

          // Momentum holds whether or not the balls actually touched.
          if (r.dPrel > worstP) { worstP = r.dPrel; worstPCase = label; }

          if (!r.hit) continue;      // a miss says nothing about the collision
          hits++;

          const gain = (r.ke1 - r.ke0) / r.ke0;
          if (gain > worstGain) { worstGain = gain; worstGainCase = label; }

          if (r.bound > 1e-9) {
            const ratio = (r.ke0 - r.ke1) / r.bound;
            if (ratio > worstE) { worstE = ratio; worstECase = label; }
          }
        }
      }
    }
  }

  // A sweep in which nothing collided would pass every bound above trivially.
  // The shipped build loses a handful of thin cuts at speed, so this is a floor,
  // not an equality.
  assert.ok(hits >= shots * 0.9,
    `only ${hits}/${shots} shots produced a collision — the sweep is not exercising contacts`);

  assert.ok(worstP <= P_TOL,
    `momentum not conserved: |dP|/|P0| = ${worstP.toExponential(3)} at ${worstPCase} (limit ${P_TOL})`);

  // Energy may only ever go DOWN. A collision that adds energy is a solver bug.
  assert.ok(worstGain <= 1e-9,
    `energy created: +${(worstGain * 100).toFixed(4)}% at ${worstGainCase}`);

  // ...and it may only go down by as much as restitution + throw allow. This is
  // what catches a contact resolved WITHOUT restitution (e silently 0), which
  // conserves momentum perfectly and so trips none of the checks above.
  assert.ok(worstE <= E_BOUND_FACTOR,
    `energy loss ${worstE.toFixed(2)}x the restitution+throw bound at ${worstECase} ` +
    `(limit ${E_BOUND_FACTOR}x) — a contact is being resolved without restitution`);
});

test('a head-on collision loses exactly the restitution energy', async () => {
  await bootAmmo();
  const ctx = await floatingPair();
  // Straight, no spin: all the energy is in the normal direction, so the loss
  // must be (1 - e^2) of it, with no throw term to muddy the comparison.
  const r = collide(ctx, { cutDeg: 0, speed: 2, spin: 'stun', ph: 0 });
  assert.ok(r.hit, 'the head-on shot should have connected');
  const lost = (r.ke0 - r.ke1) / r.ke0;
  // Equal masses, one at rest: v1' = v(1-e)/2 and v2' = v(1+e)/2, so the pair
  // RETAINS (1+e^2)/2 of the kinetic energy. The loss is therefore (1-e^2)/2 —
  // half the (1-e^2) that shows up in the absolute bound above, because only the
  // centre-of-mass part of the energy is available to be lost.
  const expected = (1 - E_COMB * E_COMB) / 2;      // 0.04875
  assert.ok(Math.abs(lost - expected) < 0.01,
    `head-on energy loss was ${(lost * 100).toFixed(2)}%, expected ${(expected * 100).toFixed(2)}%`);
});
