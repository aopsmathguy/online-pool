// src/balls.logic.js — ball physics bodies + rack, with NO Three/rendering.
// Everything is parameterized by (world, balls) so the server can run many
// tables at once. A "ball" here is { body, number, style, color, overPocket }.
// The client mirrors these as meshes in balls.view.js keyed by the same id/index.
import { R, m, mu_ball, e_ball, RACK_QUAT } from '../shared/constants.js';
import {
  AmmoLib, tmpTransform, tmpVec3, createRigidBody, setBodyFilter,
  CG_BALL, MASK_BALL_NORMAL,
} from './physics.js';
import { BALL_COLORS, ballStyle } from '../shared/balldefs.js';

// Build physics bodies for a rack described by `layout` (array of ball specs
// { x, z, number, style?, color?, jitter? }). The first entry is the cue ball
// (balls[0]). Returns the freshly-populated balls array (also mutated in place).
export function resetRack(world, balls, layout) {
  for (const b of balls) world.removeRigidBody(b.body);
  balls.length = 0;

  const sphere = new AmmoLib.btSphereShape(R);
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
      fric: mu_ball, rest: e_ball, rollF: 0, spinF: 0, linD: 0, angD: 0,
      group: CG_BALL, mask: MASK_BALL_NORMAL,
    });
    body.setUserIndex(1);
    body.setCcdSweptSphereRadius(R * 0.9);
    body.setCcdMotionThreshold(R * 0.1);
    body.setSleepingThresholds(0.0002, 0.0002);
    body.setContactProcessingThreshold(0.);

    balls.push({ body, style, color, number, overPocket: false });
  }
  return balls;
}

export function getBallByNumber(balls, n) {
  return balls.find(b => b.number === n) || null;
}

// Teleport a ball to (x, z) on the felt, clearing motion and restoring the
// normal collision filter (in case it was passing over a pocket). Works for the
// cue ball and object balls — used for ball-in-hand and spotting. Rotation is
// squared back to RACK_QUAT so a spotted ball's number faces up again.
export function setBallPosition(world, b, x, z, y = R) {
  tmpTransform.setIdentity();
  tmpTransform.setOrigin(new AmmoLib.btVector3(x, y, z));
  tmpTransform.setRotation(new AmmoLib.btQuaternion(RACK_QUAT.x, RACK_QUAT.y, RACK_QUAT.z, RACK_QUAT.w));
  b.body.setWorldTransform(tmpTransform);
  b.body.getMotionState().setWorldTransform(tmpTransform);
  tmpVec3.setValue(0, 0, 0);
  b.body.setLinearVelocity(tmpVec3);
  b.body.setAngularVelocity(tmpVec3);
  b.body.activate();
  if (b.overPocket) {
    setBodyFilter(world, b.body, CG_BALL, MASK_BALL_NORMAL);
    b.overPocket = false;
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
  world.removeRigidBody(b.body);
  balls.splice(idx, 1);
  return b;
}
