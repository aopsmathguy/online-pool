// src/balls.logic.js — ball physics bodies + rack, with NO Three/rendering.
// Everything is parameterized by (world, balls) so the server can run many
// tables at once. A "ball" here is { body, number, style, color, offFelt }.
// The client mirrors these as meshes in balls.view.js keyed by the same id/index.
import { R, m, e_ball, RACK_QUAT } from '../shared/constants.js';
import {
  AmmoLib, tmpTransform, tmpVec3, createRigidBody, setBodyFilter, destroyRigidBody,
  CG_BALL, MASK_BALL_NORMAL, SURF_BALL,
} from './physics.js';
import { BALL_COLORS, ballStyle } from '../shared/balldefs.js';

// Every ball in every room is the same sphere, and Bullet shapes are explicitly
// shareable, so this is built once and lives for the life of the process. That
// is also why it is NOT registered with any world (see trackShape): a world
// being torn down must not free a shape the other rooms are still using.
let sphereShape = null;
// The rack orientation is a constant, so its quaternion can be too. Allocating
// one per call instead is a permanent Ammo-heap allocation, and setBallPosition
// runs once per placeMove packet.
let rackQuat = null;
function ballShape() {
  if (!sphereShape) sphereShape = new AmmoLib.btSphereShape(R);
  return sphereShape;
}
function rackRotation() {
  if (!rackQuat) rackQuat = new AmmoLib.btQuaternion(RACK_QUAT.x, RACK_QUAT.y, RACK_QUAT.z, RACK_QUAT.w);
  return rackQuat;
}

// Build physics bodies for a rack described by `layout` (array of ball specs
// { x, z, number, style?, color?, jitter? }). The first entry is the cue ball
// (balls[0]). Returns the freshly-populated balls array (also mutated in place).
export function resetRack(world, balls, layout) {
  // Destroy, not just remove: the previous rack's bodies are about to become
  // unreachable, and an unreachable Ammo object is a leaked one.
  for (const b of balls) destroyRigidBody(world, b.body);
  balls.length = 0;

  const sphere = ballShape();
  // Rest exactly on the felt plane (y=0): a sphere of radius R has its centre at
  // y=R when touching. The server only steps physics during a shot, so a lifted
  // rack would visibly float between shots — place it at true resting height.
  const lift = R;

  for (const spec of layout) {
    const { x, z, number = null, jitter = 0 } = spec;
    const style = spec.style ?? ballStyle(number);
    const color = spec.color ?? (number != null ? BALL_COLORS[number] : "#ffffff");

    // RACK_QUAT (numbers facing up): the client builds rack meshes with this
    // same quaternion and no frames are streamed while the table is at rest,
    // so any other initial body rotation would make every ball visibly snap
    // on the first streamed frame of the break shot.
    const body = createRigidBody(world, {
      mass: m,
      shape: sphere,
      pos: { x: x + jitter*(Math.random()-0.5), y: lift, z: z + jitter*(Math.random()-0.5) },
      quat: RACK_QUAT,
      // Frictionless in Bullet — all tangential friction is resolved analytically
      // in physics.js (applyFriction). Bullet does only the normal collision.
      fric: 0, rest: e_ball, rollF: 0, spinF: 0, linD: 0, angD: 0,
      group: CG_BALL, mask: MASK_BALL_NORMAL,
    });
    body.setUserIndex(SURF_BALL);
    body.setCcdSweptSphereRadius(R - 0.001);
    body.setCcdMotionThreshold(R * 0.02);
    body.setSleepingThresholds(0.0002, 0.0002);
    body.setContactProcessingThreshold(0.);

    balls.push({ body, style, color, number, offFelt: false });
  }
  return balls;
}

export function getBallByNumber(balls, n) {
  return balls.find(b => b.number === n) || null;
}

// Teleport a ball to (x, z) on the felt, clearing motion and restoring the
// normal collision filter (in case it was out over a mouth). Works for the
// cue ball and object balls — used for ball-in-hand and spotting. Rotation is
// squared back to RACK_QUAT so a spotted ball's number faces up again.
export function setBallPosition(world, b, x, z, y = R) {
  tmpTransform.setIdentity();
  tmpVec3.setValue(x, y, z);
  tmpTransform.setOrigin(tmpVec3);                 // copied into the transform
  tmpTransform.setRotation(rackRotation());
  b.body.setWorldTransform(tmpTransform);
  b.body.getMotionState().setWorldTransform(tmpTransform);
  tmpVec3.setValue(0, 0, 0);
  b.body.setLinearVelocity(tmpVec3);
  b.body.setAngularVelocity(tmpVec3);
  b.body.activate();
  if (b.offFelt) {
    setBodyFilter(world, b.body, CG_BALL, MASK_BALL_NORMAL);
    b.offFelt = false;
  }
}

// Spot a ball at the foot-spot end, searching outward along the long axis for an
// opening that doesn't overlap another ball.
export function spotBall(world, balls, b, footX, halfLen) {
  const step = 2.05 * R;
  for (let i = 0; i < 40; i++) {
    const off = Math.ceil(i / 2) * step * (i % 2 === 0 ? 1 : -1);
    const x = footX + off;
    if (Math.abs(x) > halfLen) continue;
    let clear = true;
    for (const other of balls) {
      if (other === b) continue;
      const o = other.body.getWorldTransform().getOrigin();
      const dx = o.x() - x, dz = o.z() - 0;
      if (dx * dx + dz * dz < (2 * R) * (2 * R)) { clear = false; break; }
    }
    if (clear) { setBallPosition(world, b, x, 0); return; }
  }
  setBallPosition(world, b, footX, 0);
}

// Remove a ball from play (physics only). Returns the removed entry.
export function pocketBall(world, balls, b) {
  const idx = balls.indexOf(b);
  if (idx < 0) return null;
  destroyRigidBody(world, b.body);
  balls.splice(idx, 1);
  return b;
}
