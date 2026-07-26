// src/physics.js
//
// Instance-aware physics. A single Ammo runtime (loaded once via initPhysics)
// hosts MANY independent worlds — the online server runs one world per room.
// The world to operate on is passed explicitly to createRigidBody / setBodyFilter
// / stepAndApplyFriction, so nothing here is a per-game singleton. tmpTransform / tmpVec3
// are shared scratch, which is safe because the server steps one world fully
// before touching another (single-threaded, no re-entrancy).
import {
  g, m, R, FIXED_DT, C_rr, C_spin,
  mu_felt_kinetic, mu_rail_kinetic, mu_cup_kinetic,
  mu_ball_asym, mu_ball_amp, mu_ball_decay,
} from '../shared/constants.js';

// Collision filter groups (bit flags). The two felt surfaces have their own
// groups so a ball can be switched between them one ball at a time — the felt
// bodies themselves are shared by all sixteen, so the choice can only live on
// the ball's mask.
export const CG_FELT     = 1 << 1;  // 2  — flat felt plane (used on the felt)
export const CG_BALL     = 1 << 2;  // 4
export const CG_RAIL     = 1 << 3;  // 8
export const CG_POCKET   = 1 << 4;  // 16
export const CG_SUNK     = 1 << 5;  // 32 — a ball resting in a pocket cup
export const CG_FELTMESH = 1 << 6;  // 64 — triangulated felt (real pocket holes), used off the felt

// Surface identity, carried on every body's Bullet USER INDEX (assigned in
// table.world.js / balls.logic.js). The friction pass below has to ask "is the
// other side of this contact a surface a ball rests on?", and it must answer
// that for BOTH felt bodies — the flat plane and the triangulated mesh are one
// surface wearing two collision shapes, and they share SURF_FELT so a ball gets
// identical cloth friction either side of the swap (see updateFeltMasks).
// Pointer identity, which the rules' contact scanner uses for the rails, cannot
// express that. Cups ARE rubbed (grippier than cloth, so a ball rattling in the
// cup settles): a pocketed ball is spliced out of `balls` into `sunk` the moment
// it drops, so the sunk list has to be passed to this pass too (see sim.js).
export const SURF_BALL = 1;
export const SURF_RAIL = 2;
export const SURF_FELT = 3;
export const SURF_CUP  = 4;

// On the felt a ball rolls on the flat PLANE (cheap, snag-free).
export const MASK_BALL_NORMAL      = CG_FELT | CG_RAIL | CG_POCKET | CG_BALL;
// Once its centre leaves the felt outline it swaps to the triangulated MESH,
// whose boundary edge gives the tilted contact normal that tips it in. Exactly
// one of these two bits is set on a live ball, never both and never neither.
export const MASK_BALL_OFF_FELT    = CG_FELTMESH | CG_RAIL | CG_POCKET | CG_BALL;
// A pocketed ball collides with the cup and OTHER pocketed balls (so it drops to
// the bottom and piles up), but not the felt (falls in), the rails, or the
// in-play balls — a ball in the pocket must not disturb balls still on the table.
export const MASK_SUNK             = CG_POCKET | CG_SUNK;

let AmmoLib, tmpTransform, tmpVec3;

// Load the Ammo runtime once. In the browser `Ammo` is the global from the
// <script> tag; in Node the server sets globalThis.Ammo before calling this.
export async function initPhysics() {
  AmmoLib = await Ammo();
  tmpTransform = new AmmoLib.btTransform();
  tmpVec3 = new AmmoLib.btVector3(0, 0, 0);
  return { AmmoLib, tmpTransform, tmpVec3 };
}

// Create a fresh, independent dynamics world (one per room). Same solver
// configuration as the original single-world setup.
export function createWorld() {
  const config = new AmmoLib.btDefaultCollisionConfiguration();
  const dispatcher = new AmmoLib.btCollisionDispatcher(config);
  const broadphase = new AmmoLib.btDbvtBroadphase();
  const solver = new AmmoLib.btSequentialImpulseConstraintSolver();
  const world = new AmmoLib.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, config);
  world.setGravity(new AmmoLib.btVector3(0, -g, 0));
  const si = world.getSolverInfo();
  if (si.set_m_numIterations) si.set_m_numIterations(24);
  if (si.set_m_splitImpulse) si.set_m_splitImpulse(true);
  if (si.set_m_splitImpulsePenetrationThreshold) si.set_m_splitImpulsePenetrationThreshold(-0.02);
  si.set_m_restitutionVelocityThreshold(0);
  world.getDispatchInfo().set_m_allowedCcdPenetration(0);
  return world;
}

export function createRigidBody(world, { mass, shape, pos, quat, fric, rest, rollF=0, spinF=0, linD=0, angD=0, group, mask }) {
  const t = new AmmoLib.btTransform();
  t.setIdentity();
  t.setOrigin(new AmmoLib.btVector3(pos.x, pos.y, pos.z));
  t.setRotation(new AmmoLib.btQuaternion(quat.x, quat.y, quat.z, quat.w));
  const motion = new AmmoLib.btDefaultMotionState(t);

  const localI = new AmmoLib.btVector3(0, 0, 0);
  if (mass > 0) shape.calculateLocalInertia(mass, localI);

  const rbInfo = new AmmoLib.btRigidBodyConstructionInfo(mass, motion, shape, localI);
  const body = new AmmoLib.btRigidBody(rbInfo);
  body.setFriction(fric);
  body.setRestitution(rest);
  if (body.setRollingFriction)  body.setRollingFriction(0);
  if (body.setSpinningFriction) body.setSpinningFriction(0);
  body.setDamping(0, 0);
  if (group !== undefined && mask !== undefined) {
    world.addRigidBody(body, group, mask);
  } else {
    world.addRigidBody(body);
  }
  return body;
}

// Re-insert a body with a different collision filter group/mask. Ammo doesn't
// expose a direct setter for broadphase filter bits in every build, so the
// portable approach is remove + re-add.
export function setBodyFilter(world, body, group, mask) {
  world.removeRigidBody(body);
  world.addRigidBody(body, group, mask);
}

// Ptr -> ball lookup for the friction pass. Module scratch, cleared and refilled
// each step rather than allocated: this runs 250x/second per world. It cannot be
// shared with RoomSim's ballByPtr — that one is rebuilt only when the ball SET
// changes, and is stale during settleRack.
const frictionBallByPtr = new Map();

// --- Analytic friction ------------------------------------------------------
// Every tangential friction in the sim is resolved HERE, not by Bullet: all
// bodies are built frictionless, so Bullet does only the normal collision
// response (restitution). There is ONE rule and no contact modes: at every
// touching contact point, every step, charge a Coulomb tangential impulse
// against the normal impulse the solver reports for that point. Resting,
// rolling and bouncing are the same code — a bounce is just a step where the
// reported impulse is large.
//
// What differs between surfaces is COEFFICIENTS ONLY (the table below): a
// cushion is a surface whose rolling and spin coefficients are zero, not a
// surface with special handling. The one genuine split is ball–ball, where
// there is a second dynamic body to push back on, so the impulse is equal and
// opposite and the gearing cap is the two-body one.
//
// A solid sphere has I = (2/5) m R², so a tangential impulse J at the contact
// changes the contact-point velocity by (7/2)(J/m) (linear J/m + the angular
// (5/2)(J/m)); "gearing" (killing the slip) therefore needs J = (2/7) m·|slip|.
const BALL_I = (2 / 5) * m * R * R;

const SLIP_EPS = 0.001;   // m/s: contact slip below this counts as pure rolling
const VT_EPS   = 1e-9;

// --- The surface table ------------------------------------------------------
// EVERYTHING the friction pass needs to know about a surface lives here, keyed
// by the SURF_* id that surface's bodies carry on their Bullet user index.
// Adding a surface a ball can collide with is ONE ENTRY here plus a CG_* group
// and a setUserIndex() at construction — no branch below changes, and nothing
// else in this file mentions felt, rail or cup by name.
//
//   mu      kinetic coefficient for the slide->roll conversion.
//   c_rr    rolling resistance, once the contact is rolling rather than sliding.
//   c_spin  decay of spin about the contact normal.
//
// All three are per-surface, so a new surface can be slippier or grabbier
// without touching the cloth's calibration. Restitution is NOT here: it is
// Bullet's, set on the body at construction, and this pass never needs it.
const SURFACES = {
  [SURF_FELT]: { mu: mu_felt_kinetic, c_rr: C_rr, c_spin: C_spin },
  [SURF_CUP]:  { mu: mu_cup_kinetic,  c_rr: C_rr, c_spin: C_spin },
  // A cushion is a bounce, not a resting place: a ball never rolls along one or
  // sits spinning on one, so rolling resistance and spin decay are zero. That is
  // a COEFFICIENT being zero, not a different code path.
  [SURF_RAIL]: { mu: mu_rail_kinetic, c_rr: 0, c_spin: 0 },
};

// Cross product a × b, returned as a 3-tuple via the caller's out array.
function cross(ax, ay, az, bx, by, bz, out) {
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}
const _cp = [0, 0, 0];
const _ut = [0, 0, 0];   // tangential slip, kept separate from _cp so the two never alias

// --- Shared contact primitives ----------------------------------------------
// The three friction paths below (felt/cup, rail, ball–ball) differ in WHEN they
// fire and in what supplies Jn, but they all do the same three things once they
// do fire: find the tangential slip at the contact, cap a Coulomb impulse at the
// value that exactly kills that slip, and apply it at r = ±R·n̂. Those three
// steps live here so the coefficient and the cap are stated once each.



// Strip the normal component, leaving the tangential part in `out`. Returns |t|.
function tangential(ax, ay, az, nx, ny, nz, out) {
  const an = ax * nx + ay * ny + az * nz;
  out[0] = ax - an * nx; out[1] = ay - an * ny; out[2] = az - an * nz;
  return Math.hypot(out[0], out[1], out[2]);
}

// Slip of a ball's contact point against a surface whose normal is n̂ (pointing
// SURFACE -> BALL): u = v + ω × r with r = −R·n̂. Tangential part into `out`.
function contactSlip(vx, vy, vz, wx, wy, wz, nx, ny, nz, out) {
  cross(wx, wy, wz, -R * nx, -R * ny, -R * nz, _cp);
  return tangential(vx + _cp[0], vy + _cp[1], vz + _cp[2], nx, ny, nz, out);
}

// Coulomb tangential impulse magnitude μ·Jn, capped at the GEARING impulse that
// brings the contact to pure rolling — friction can kill the slip but must never
// reverse it. A tangential impulse J at the contact changes the contact-point
// velocity by (7/2)(J/m) for one ball against an immovable surface, so the cap is
// (2/7)m·uT; two equal balls each take half of it, hence m/7 (see applyThrow).
const CAP_SURFACE = (2 / 7) * m;
const CAP_BALL    = m / 7;
function gearedJ(mu, Jn, uT, cap) { return Math.min(mu * Jn, cap * uT); }

// Add a tangential impulse (jx,jy,jz) at contact offset r=(rx,ry,rz) from the
// centre: linear J/m, angular (r × J)/I. Read-modify-write via setVelocity so
// the change is exactly Δv/Δω (no dependence on Bullet's impulse bookkeeping).
function applyImpulse(body, jx, jy, jz, rx, ry, rz) {
  const v = body.getLinearVelocity();
  tmpVec3.setValue(v.x() + jx / m, v.y() + jy / m, v.z() + jz / m);
  body.setLinearVelocity(tmpVec3);
  const w = body.getAngularVelocity();
  cross(rx, ry, rz, jx, jy, jz, _cp);
  tmpVec3.setValue(w.x() + _cp[0] / BALL_I, w.y() + _cp[1] / BALL_I, w.z() + _cp[2] / BALL_I);
  body.setAngularVelocity(tmpVec3);
}

// Ball–ball dynamic friction, falling with the relative tangential surface speed
// at contact — the empirical clean-ball fit (see constants.js):
//   mu(s) = mu_ball_asym + mu_ball_amp · exp(−mu_ball_decay · s)
// Low speed → high μ (toward the gearing cap, so soft shots throw more); high
// speed → mu_ball_asym (little throw).
function ballBallMu(vRelT) {
  const s = vRelT > 0 ? vRelT : 0;
  return mu_ball_asym + mu_ball_amp * Math.exp(-mu_ball_decay * s);
}

export function stepAndApplyFriction(world, balls, dt=FIXED_DT, sunk=null) {
  world.stepSimulation(dt, 8, dt);
  applyFriction(world, balls, sunk);
}

// `sunk` (optional) are balls resting in a cup: not in play, but still simulated
// so they settle into the pile. They collide only with the cup and each other
// (MASK_SUNK), so feeding them here gives the cup (SURF_CUP) its friction without
// touching any in-play contact.
function applyFriction(world, balls, sunk=null) {
  if (!balls.length && !(sunk && sunk.length)) return;
  frictionBallByPtr.clear();
  for (const b of balls) frictionBallByPtr.set(b.body.ptr, b);
  if (sunk) for (const b of sunk) frictionBallByPtr.set(b.body.ptr, b);

  const disp = world.getDispatcher();
  const nMani = disp.getNumManifolds();
  for (let i = 0; i < nMani; i++) {
    const mani = disp.getManifoldByIndexInternal(i);
    const nc = mani.getNumContacts();
    if (nc === 0) continue;

    const bodyA = mani.getBody0(), bodyB = mani.getBody1();
    const ballA = frictionBallByPtr.get(bodyA.ptr);
    const ballB = frictionBallByPtr.get(bodyB.ptr);

    // Every contact is handled the same way: walk the manifold's TOUCHING points
    // and charge friction at each, against that point's own normal and the
    // solver's own normal impulse for that point, every step. The only thing
    // that varies is the coefficients and whether there is a second body to
    // push back on.
    //
    // The distance gate is what makes iterating all points SAFE. Bullet caches
    // up to 4 points per manifold, but only touching ones have distance <= 0;
    // the stale separated points keep reporting their last applied impulse (a
    // 9.8*m*g spike a step after the ball has lifted off), and including them
    // multiplies the load by the cache depth. Gating drops them, so the
    // surviving per-point impulses sum to the true support — verified to
    // average exactly m*g for resting AND bouncing balls (friction.test.js).
    //
    // Ball–ball: both sides are dynamic, so the impulse is equal and opposite
    // and the gearing cap is the two-body one. Its mu falls with slip speed.
    if (ballA && ballB) {
      for (let j = 0; j < nc; j++) {
        const cp = mani.getContactPoint(j);
        if (cp.getDistance() > 0) continue;
        const Jn = cp.getAppliedImpulse();
        if (Jn <= 0) continue;
        // normalWorldOnB runs B -> A; negate for n̂ running A -> B.
        const nrm = cp.get_m_normalWorldOnB();
        applyThrow(ballA, ballB, -nrm.x(), -nrm.y(), -nrm.z(), Jn);
      }
      continue;
    }

    const ball = ballA || ballB;
    if (!ball) continue;                         // e.g. a sunk ball: not ours
    const ballIsA = !!ballA;
    // One table lookup decides everything: an id with no entry is a body a ball
    // passes through as far as friction is concerned.
    const surface = SURFACES[(ballIsA ? bodyB : bodyA).getUserIndex()];
    if (!surface) continue;

    // m_normalWorldOnB points from body B into body A; flip it when the ball is
    // B so n̂ always runs SURFACE -> BALL (straight up, on flat felt).
    const s = ballIsA ? 1 : -1;

    for (let j = 0; j < nc; j++) {
      const cp = mani.getContactPoint(j);
      if (cp.getDistance() > 0) continue;
      const Jn = cp.getAppliedImpulse();
      if (Jn <= 0) continue;
      const nrm = cp.get_m_normalWorldOnB();
      applySurface(ball, s * nrm.x(), s * nrm.y(), s * nrm.z(), Jn, surface);
    }
  }
}

// One touching point against a static surface. Jn is the solver's normal impulse
// at that point; every friction below — slide→roll, rolling resistance, spin
// decay — scales with it, and takes its coefficients from `surface`.
function applySurface(ball, nx, ny, nz, Jn, surface) {
  if (Jn <= 0) return;
  const body = ball.body;
  const v = body.getLinearVelocity();
  let vx = v.x(), vy = v.y(), vz = v.z();
  const w = body.getAngularVelocity();
  let wx = w.x(), wy = w.y(), wz = w.z();

  const uT = contactSlip(vx, vy, vz, wx, wy, wz, nx, ny, nz, _ut);
  const utx = _ut[0], uty = _ut[1], utz = _ut[2];

  if (uT > SLIP_EPS) {
    // SLIDING: kinetic friction opposing the slip, capped at the gearing impulse
    // so it can bring the ball to rolling but never reverse the slip. This is
    // the slide→roll conversion that gives follow/draw/stun their behaviour.
    // Applied to the LOCAL scalars rather than via applyImpulse: the two blocks
    // below keep mutating the same v/ω, and only the tail writes them back, so
    // one contact point costs one read and one write however many terms fire.
    const J = gearedJ(surface.mu, Jn, uT, CAP_SURFACE);
    const jx = -J * utx / uT, jy = -J * uty / uT, jz = -J * utz / uT;
    vx += jx / m; vy += jy / m; vz += jz / m;
    cross(-R * nx, -R * ny, -R * nz, jx, jy, jz, _cp);   // angular impulse r × J
    wx += _cp[0] / BALL_I; wy += _cp[1] / BALL_I; wz += _cp[2] / BALL_I;
  } else {
    // ROLLING: rolling resistance as a rigid rolling body of inertia (7/5)m, so
    // the OBSERVED linear deceleration is (5/7)·c_rr·g (matching the old Bullet-
    // coupled rate the calibration tests pin). Then re-project the spin to exact
    // rolling for the new velocity, preserving spin about the normal.
    const vn = vx * nx + vy * ny + vz * nz;
    let vtx = vx - vn * nx, vty = vy - vn * ny, vtz = vz - vn * nz;
    const vtMag = Math.hypot(vtx, vty, vtz);
    if (vtMag > VT_EPS) {
      const dvMag = Math.min((5 / 7) * surface.c_rr * Jn / m, vtMag);
      const k = dvMag / vtMag;
      vx -= vtx * k; vy -= vty * k; vz -= vtz * k;
    }
    const vn2 = vx * nx + vy * ny + vz * nz;
    const tvx = vx - vn2 * nx, tvy = vy - vn2 * ny, tvz = vz - vn2 * nz;
    const wn = wx * nx + wy * ny + wz * nz;               // spin about the normal, kept
    cross(nx, ny, nz, tvx, tvy, tvz, _cp);               // ω_roll = (n̂ × v_t)/R
    wx = _cp[0] / R + wn * nx;
    wy = _cp[1] / R + wn * ny;
    wz = _cp[2] / R + wn * nz;
  }

  // Spin about the surface normal (English) decays, in both regimes.
  const wn = wx * nx + wy * ny + wz * nz;
  const wnAbs = Math.abs(wn);
  if (wnAbs > 1e-9) {
    const dw = Math.min((5 * surface.c_spin * Jn) / (2 * m * R), wnAbs);
    const k = Math.sign(wn) * dw;
    wx -= k * nx; wy -= k * ny; wz -= k * nz;
  }

  tmpVec3.setValue(vx, vy, vz); body.setLinearVelocity(tmpVec3);
  tmpVec3.setValue(wx, wy, wz); body.setAngularVelocity(tmpVec3);
}

// Two balls in contact. Bullet has already applied the frictionless normal
// collision this step, so the relative normal speed has reversed (|after| =
// e·|before|) and the tangential surface velocity is untouched. Recover the
// collision's normal impulse analytically and apply the tangential (throw)
// impulse once, on the step the pair first separates. Returns the current
// separating normal speed for the caller's once-only bookkeeping.
//


// One touching point's worth of ball–ball throw: the tangential impulse at the
// contact, equal and opposite on the two balls. Re-reads both velocities so a
// second point (if one ever existed) would see the first point's result.
function applyThrow(a, b, nx, ny, nz, Jn) {
  // Extract every Ammo vector to scalars IMMEDIATELY: getters can hand back a
  // shared internal temp, so holding two live references across another getter
  // is unsafe.
  const lva = a.body.getLinearVelocity();
  const vax = lva.x(), vay = lva.y(), vaz = lva.z();
  const lvb = b.body.getLinearVelocity();
  const vbx = lvb.x(), vby = lvb.y(), vbz = lvb.z();

  // Relative surface velocity at the contact (includes both balls' spin):
  //   surfA = vA + ωA × (R n̂),  surfB = vB + ωB × (−R n̂)
  const wva = a.body.getAngularVelocity();
  cross(wva.x(), wva.y(), wva.z(), R * nx, R * ny, R * nz, _cp);
  const sax = vax + _cp[0], say = vay + _cp[1], saz = vaz + _cp[2];
  const wvb = b.body.getAngularVelocity();
  cross(wvb.x(), wvb.y(), wvb.z(), -R * nx, -R * ny, -R * nz, _cp);
  const sbx = vbx + _cp[0], sby = vby + _cp[1], sbz = vbz + _cp[2];
  const uT = tangential(sax - sbx, say - sby, saz - sbz, nx, ny, nz, _ut);
  if (uT < VT_EPS) return;

  const J = gearedJ(ballBallMu(uT), Jn, uT, CAP_BALL);
  const jx = -J * _ut[0] / uT, jy = -J * _ut[1] / uT, jz = -J * _ut[2] / uT;   // impulse on A (−u_t)

  applyImpulse(a.body, jx, jy, jz, R * nx, R * ny, R * nz);          // A: r = +R n̂
  applyImpulse(b.body, -jx, -jy, -jz, -R * nx, -R * ny, -R * nz);    // B: opposite, r = −R n̂
}


export { AmmoLib, tmpTransform, tmpVec3 };
