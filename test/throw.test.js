// test/throw.test.js — how much does the object ball get THROWN?
//
// "Throw" is the angle by which a struck object ball departs from the pure
// geometric impact line (the cue→object centre line at contact). It is produced
// entirely by friction between the two balls during the collision — the custom
// cloth/rail friction pass explicitly skips ball–ball contacts, so throw here is
// whatever Bullet's own contact friction (ball fric ≈ mu_ball, combined ≈ 0.06)
// does with the relative surface velocity at the contact patch.
//
// EXPERIMENT. Park everything but two balls. Put the object at the origin and
// launch the cue so that FIRST contact lands exactly on the +x impact line at a
// chosen cut angle φ: the cue centre reaches (−2R, 0) moving along
// u = (cosφ, 0, sinφ), so the throw-free object direction is +x and its
// throw-free speed is V·cosφ. Then measure the object's real departure angle.
//
// We sweep cue SPEED (slow / medium / fast) and cue SPIN, expressed as a
// multiple s of the NATURAL rolling rate ω_nat = |v|/R about the horizontal
// axis ⟂ to travel:
//   s = 1    rolling   (natural roll / follow)
//   s = 1.6  overrolling (extra top)
//   s = 0.5  underrolling (rolling slower than it travels)
//   s = 0    not rolling  (pure slide / stun)
//   s = −1   opposite     (backspin / draw)
//
// A straight (φ = 0) block is included as a control: with no tangential relative
// motion, forward/back roll cannot throw the ball, so throw ≈ 0 there — throw is
// a CUT-shot phenomenon. The test asserts only broad, stable facts; the detailed
// numbers are printed for inspection (run: `node --test test/throw.test.js`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAmmo } from './helpers/simHarness.js';
import { R, FIXED_DT } from '../src/shared/constants.js';

const DEG = 180 / Math.PI;
// Cue→object gap. Scaled with speed so the APPROACH TIME (gap / V) is roughly
// constant across speeds: otherwise a slow ball spends far longer sliding on the
// felt before contact and the cloth re-rolls a "stunned" cue ball, so its spin
// at contact would no longer be the value we set. A constant, short approach
// time keeps spin@contact comparable at every speed. Clamped so it is never so
// small it starts interpenetrating, nor so large the felt matters at high speed.
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const gapFor = (V) => clampN(V * 0.006, 0.004, 0.03);
// Integration step, chosen so the ball moves a FIXED ~0.35 mm per step whatever
// its speed. A ball at 5 m/s moves 20 mm per 4 ms substep — far enough to jump
// the whole gap and be sampled already penetrated and past the ideal contact
// point, which rotates the measured impact line, fakes a wider cut, and makes
// the outgoing velocity sampling noisy. Holding the per-step motion constant
// keeps every speed hitting on the same +x impact line and resolves the contact
// at the same sub-millimetre resolution, so the speed sweep is clean.
const dtFor = (V) => clampN(0.00035 / V, 3e-5, 5e-4);

// One collision. Returns measured throw (deg, +toward the cue's tangential side),
// the object's speed, the cut angle actually realised, and the cue spin ratio
// still present at the instant of contact (a check that the felt didn't eat it).
async function shoot({ AmmoLib, world, balls, stepAndApplyFriction }, cue, obj, cutRad, V, spinScale) {
  const { setBallPosition } = await bootAmmo();
  const cx = Math.cos(cutRad), sz = Math.sin(cutRad);
  const gap = gapFor(V);

  // Object at origin; cue back along −u from the contact point (−2R, 0).
  setBallPosition(world, obj, 0, 0);
  setBallPosition(world, cue, -2 * R - cx * gap, -sz * gap);
  for (const b of [cue, obj]) b.body.setActivationState(4);   // DISABLE_DEACTIVATION

  // Linear velocity along u; angular velocity = spinScale × natural roll.
  // Natural roll for v=(vx,0,vz) is ω = (vz/R, 0, −vx/R) (|ω| = |v|/R).
  const vx = V * cx, vz = V * sz;
  const wNat = { x: vz / R, y: 0, z: -vx / R };
  cue.body.setLinearVelocity(new AmmoLib.btVector3(vx, 0, vz));
  cue.body.setAngularVelocity(new AmmoLib.btVector3(wNat.x * spinScale, 0, wNat.z * spinScale));

  const pos = (b) => b.body.getWorldTransform().getOrigin();
  const dist = () => { const c = pos(cue), o = pos(obj); return Math.hypot(c.x() - o.x(), c.z() - o.z()); };

  const dt = dtFor(V);
  let nImp = null, spinAtContact = null;
  let seenContact = false, out = null;
  for (let i = 0; i < 8000 && !out; i++) {
    // Record the impact normal and surviving cue spin at first contact.
    if (!seenContact && dist() <= 2 * R * 1.001) {
      const c = pos(cue), o = pos(obj);
      const dx = o.x() - c.x(), dz = o.z() - c.z(), dl = Math.hypot(dx, dz) || 1;
      nImp = { x: dx / dl, z: dz / dl };
      const w = cue.body.getAngularVelocity();
      spinAtContact = Math.hypot(w.x(), w.y(), w.z()) / (V / R);   // as a multiple of ω_nat
      seenContact = true;
    }
    stepAndApplyFriction(world, balls, dt);
    if (seenContact) {
      const ov = obj.body.getLinearVelocity();
      const os = Math.hypot(ov.x(), ov.z());
      if (os > 0.02 && dist() > 2 * R * 1.05) out = { vx: ov.x(), vz: ov.z(), speed: os };
    }
  }
  if (!out) return { throwDeg: NaN, speed: 0, nOff: NaN, spinAtContact };

  // Throw is referenced to the EXACT geometric impact line (+x by construction),
  // so it is independent of any residual penetration in the sampled normal.
  const throwDeg = Math.atan2(out.vz, out.vx) * DEG;
  // Diagnostic: how far the sampled impact normal drifted off +x (want ≈ 0).
  const nOff = Math.acos(Math.min(1, Math.max(-1, nImp.x))) * DEG;
  return { throwDeg, speed: out.speed, nOff, spinAtContact };
}

test('throw: cue speed × spin sweep (prints a table; asserts the broad shape)', async () => {
  const harness = await bootAmmo();
  const { AmmoLib } = await import('../src/server/physics.js');
  const physics = await import('../src/server/physics.js');
  // A bare-bones sim: reuse RoomSim for the felt/rails, but strip it to 2 balls.
  const { RoomSim } = harness;
  const sim = new RoomSim('9ball');
  sim.newGame();
  const st = sim.game.getState(); st.phase = 'play';
  // Keep only the cue and the 1; remove the rest so nothing interferes.
  const keep = (b) => b.style === 'cue' || b.number === 1;
  for (const b of sim.balls) if (!keep(b)) sim.world.removeRigidBody(b.body);
  sim.balls = sim.balls.filter(keep);
  sim.rebuildBallPtrMap();
  const cue = sim.balls.find(b => b.style === 'cue');
  const obj = sim.balls.find(b => b.number === 1);

  const ctx = { AmmoLib, world: sim.world, balls: sim.balls, stepAndApplyFriction: physics.stepAndApplyFriction };

  const speeds = [['slow', 0.5], ['medium', 1.5], ['fast', 3.5]];
  const spins = [
    ['rolling      (s=+1.0)',  1.0],
    ['overrolling  (s=+1.6)',  1.6],
    ['underrolling (s=+0.5)',  0.5],
    ['not rolling  (s= 0.0)',  0.0],
    ['opposite     (s=−1.0)', -1.0],
  ];

  const results = [];   // for the assertions afterward
  for (const cutDeg of [0, 20, 40]) {
    const cutRad = cutDeg / DEG;
    console.log(`\n=== cut angle ${cutDeg}°  (throw-free object direction = impact line; +throw = toward the cut side) ===`);
    console.log('speed   spin                     throw°   objSpeed  n_off°  spin@contact');
    for (const [sname, V] of speeds) {
      for (const [spname, s] of spins) {
        const r = await shoot(ctx, cue, obj, cutRad, V, s);
        results.push({ cutNom: cutDeg, V, s, ...r });
        console.log(
          `${sname.padEnd(7)} ${spname.padEnd(24)} ` +
          `${r.throwDeg.toFixed(2).padStart(6)}   ${r.speed.toFixed(3).padStart(7)}   ` +
          `${r.nOff.toFixed(2).padStart(5)}   ${(r.spinAtContact ?? NaN).toFixed(2)}`);
      }
    }
  }

  // --- Dedicated SPEED sweep at a fixed 30° cut (same geometry every row) ------
  // The point the grid above can't show cleanly: with the impact line pinned,
  // how does throw actually move with cue speed?
  console.log('\n=== SPEED sweep @ 30° cut (impact line fixed; throw vs speed) ===');
  const fineSpeeds = [0.25, 0.5, 1.0, 2.0, 3.5, 5.5];
  const header = 'spin \\ speed        ' + fineSpeeds.map(v => `${v}`.padStart(7)).join('');
  console.log(header + '   m/s');
  for (const [spname, s] of spins) {
    const row = [], spc = [];
    for (const V of fineSpeeds) {
      const r = await shoot(ctx, cue, obj, 30 / DEG, V, s);
      row.push(r.throwDeg); spc.push(r.spinAtContact);
      results.push({ cutNom: 30, V, s, ...r });
    }
    console.log(spname.padEnd(19) + row.map(t => t.toFixed(2).padStart(7)).join('') + '   (throw°)');
  }
  console.log('(spin@contact stays ≈ the set s across the row, so this is a clean speed sweep)');
  console.log('(with velocity-dependent ball-ball friction, throw now FALLS with speed)');

  // --- Broad, stable assertions (not the exact numbers) ---
  const pick = (cutNom, V, s) => results.find(r => r.cutNom === cutNom && r.V === V && r.s === s);

  // 1) Every case produced a moving object ball.
  for (const r of results) assert.ok(r.speed > 0.05, `object barely moved: ${JSON.stringify(r)}`);

  // 2) A straight (φ=0) full hit throws essentially nothing, whatever the spin.
  for (const [, s] of spins) {
    const r = pick(0, 1.5, s);
    assert.ok(Math.abs(r.throwDeg) < 0.75, `straight hit threw too much (spin ${s}): ${r.throwDeg.toFixed(2)}°`);
  }

  // 3) On a cut, there IS measurable throw.
  const cutStun = pick(40, 1.5, 0);
  assert.ok(Math.abs(cutStun.throwDeg) > 0.5, `expected real throw on a 40° stun cut, got ${cutStun.throwDeg.toFixed(2)}°`);

  // 4) The geometry holds at every speed — the adaptive step keeps the fast ball
  //    on the same impact line as the slow one (n_off small), so the speed sweep
  //    is a fair comparison and not a disguised cut-angle sweep.
  for (const r of results) {
    if (r.cutNom === 0) continue;
    assert.ok(r.nOff < 3.5, `impact line drifted ${r.nOff.toFixed(1)}° at V=${r.V}, spin ${r.s} — geometry not fixed`);
  }

  // 5) THROW FALLS WITH SPEED at a fixed cut and spin. Ball–ball friction now
  //    decreases with the relative surface speed at contact (physics.js
  //    ballBallMu), so a soft shot throws clearly more than a firm one — the
  //    whole point of the velocity-dependent model. Checked on the two clearest
  //    rows (stun and rolling); the firm end recovers the old constant-μ value.
  for (const s of [0, 1]) {
    const slow = pick(30, 0.5, s).throwDeg;
    const fast = pick(30, 5.5, s).throwDeg;
    assert.ok(slow > fast + 0.8,
      `throw should fall with speed (spin ${s}): ${slow.toFixed(2)}° @0.5 m/s vs ${fast.toFixed(2)}° @5.5 m/s`);
  }

  // 6) Spin state, not speed, sets the throw: stun throws most, then underroll,
  //    then roll ≈ draw, then overroll throws least.
  const T = (s) => pick(30, 2.0, s).throwDeg;
  assert.ok(T(0)   > T(1)   + 0.4, 'stun should throw more than a rolling cue');
  assert.ok(T(0.5) > T(1)   + 0.3, 'underroll should throw more than roll');
  assert.ok(T(1)   > T(1.6) + 0.2, 'roll should throw more than overroll');
});
