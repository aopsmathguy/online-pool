// src/physics.js
//
// Instance-aware physics. A single Ammo runtime (loaded once via initPhysics)
// hosts MANY independent worlds — the online server runs one world per room.
// The world to operate on is passed explicitly to createRigidBody / setBodyFilter
// / stepAndDamp, so nothing here is a per-game singleton. tmpTransform / tmpVec3
// are shared scratch, which is safe because the server steps one world fully
// before touching another (single-threaded, no re-entrancy).
import { g, e_rail, mu_wall, FIXED_DT, mu_felt_linear, spin_decel_rad_s2 } from '../shared/constants.js';

// Collision filter groups (bit flags). The felt has its own group so we can
// selectively disable ball↔felt contact on a per-ball basis when the ball is
// over a pocket mouth, letting it fall cleanly into the cup.
export const CG_FELT   = 1 << 1;  // 2
export const CG_BALL   = 1 << 2;  // 4
export const CG_RAIL   = 1 << 3;  // 8
export const CG_POCKET = 1 << 4;  // 16

export const MASK_BALL_NORMAL      = CG_FELT | CG_RAIL | CG_POCKET | CG_BALL;
export const MASK_BALL_OVER_POCKET = CG_RAIL | CG_POCKET | CG_BALL; // no felt

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

export function stepAndDamp(world, balls, dt=FIXED_DT) {
  world.stepSimulation(dt, 8, dt);

  const a = mu_felt_linear * g;
  for (const b of balls) {
    const v = b.body.getLinearVelocity();
    const vx = v.x(), vy = v.y(), vz = v.z();
    const sp = Math.hypot(vx, vz);
    if (sp > 1e-6) {
      const newSp = Math.max(0, sp - a * dt);
      const sc = newSp / sp;
      tmpVec3.setValue(vx * sc, vy * sc, vz * sc);
      b.body.setLinearVelocity(tmpVec3);
    }

    const w = b.body.getAngularVelocity();
    let wx = w.x(), wy = w.y(), wz = w.z();
    const wyAbs = Math.abs(wy);
    if (wyAbs > 1e-6) {
      const w_thresh = 2.0;
      const taper = Math.min(1, wyAbs / w_thresh);
      const d = spin_decel_rad_s2 * taper * dt;
      wy = (wyAbs <= d) ? 0 : wy - Math.sign(wy) * d;
    }
    tmpVec3.setValue(wx, wy, wz);
    b.body.setAngularVelocity(tmpVec3);
  }
}

export { AmmoLib, tmpTransform, tmpVec3 };
