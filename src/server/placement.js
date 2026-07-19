// src/server/placement.js — where may the cue ball be put down?
//
// Pure geometry for ball-in-hand: no world, no bodies, no Ammo. RoomSim keeps
// the part that mutates state (moving the actual body, zeroing velocities);
// this module answers "given a requested spot and the balls on the table, what
// is the nearest legal spot?".
import { tableW, tableH, R } from '../shared/constants.js';

// Keep the cue ball a full ball clear of the cushions.
const PLACE_HALF_W = tableW / 2 - 2 * R;
const PLACE_HALF_H = tableH / 2 - 2 * R;
export const HEAD_STRING_X = -tableW / 4;

// The legal box. `behindLine` is the opening break, restricted to the kitchen;
// a foul elsewhere in the game gives the whole table.
export function computeBounds(behindLine = false) {
  return {
    minX: -PLACE_HALF_W, maxX: behindLine ? HEAD_STRING_X : PLACE_HALF_W,
    minZ: -PLACE_HALF_H, maxZ: PLACE_HALF_H,
  };
}

function clampToBounds(pos, bounds) {
  return {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, pos.x)),
    z: Math.max(bounds.minZ, Math.min(bounds.maxZ, pos.z)),
  };
}

// Nearest legal placement to `pos`: inside the box and not overlapping any
// object ball. `others` is [{x, z}, ...] — object balls only, never the cue.
//
// Overlap is resolved by pushing straight out along the centre line to just
// past touching, then re-clamping. Two passes is not a general solver (a spot
// wedged between several balls can still end up touching), but placement is
// interactive: the player sees where the ball lands and nudges it. The clamp
// runs last so the result is always inside the table.
export function resolvePlacement(pos, bounds, others) {
  let p = clampToBounds(pos, bounds);
  const minD = 2 * R + 0.001;
  for (const o of others) {
    let dx = p.x - o.x, dz = p.z - o.z;
    let d = Math.hypot(dx, dz);
    if (d >= minD) continue;
    if (d < 1e-6) { dx = 1; dz = 0; d = 1; }   // exactly coincident: pick an axis
    p = { x: o.x + (dx / d) * minD, z: o.z + (dz / d) * minD };
  }
  return clampToBounds(p, bounds);
}
