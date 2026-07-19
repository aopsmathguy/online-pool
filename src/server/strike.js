// src/server/strike.js — cue tip to cue ball: what does a strike actually do?
//
// Pure scalar math. No Ammo, no world, no bodies — inputs are the shot
// parameters plus the obstacle geometry needed for the elevation floor, and
// outputs are the impulse and angular velocity to apply. That makes the single
// most consequential calculation in the game testable with plain numbers (see
// test/strike.test.js, which pins it to 1e-9).
//
// Every shot in the game flows through here. A transposed component in the
// right/stickUp frame, or squirt applied to the spin line instead of the launch
// line, produces shots that look plausible and are subtly wrong — the kind of
// bug nobody notices for weeks. Change it only with the goldens in front of you.
import { R, m } from '../shared/constants.js';
import { legalPitch } from '../shared/clearance.js';
import { cross, lenSq, normalize } from '../shared/vec3.js';

// --- Tunables ---------------------------------------------------------------
export const SHOT_IMPULSE_PER_M = 8.0;   // launch speed (m/s) per metre of pullback
const SPIN_GAIN = 1.0;
const MISCUE_LIMIT = 0.5;
const BALL_INERTIA = 0.4 * m * R * R;

// Squirt (cue-ball deflection): side english makes the ball leave a few degrees
// off the aim line, AWAY from the english side. Physically this is a small
// cue-endmass effect — NOT the full contact-normal deflection a free tip would
// give (that overshoots to ~30°) — so we model it directly as a small angular
// deflection of the launch direction proportional to horizontal english.
// SQUIRT_MAX_TAN = tan(max squirt angle) at full english (|strikeX| = 1).
const SQUIRT_MAX_TAN = 0.085;   // ≈ 4.9° at full english

// Resolve a shot into the physics to apply to the cue ball.
//
//   params  { yaw, pitch, strikeX, strikeY, power }   as the player aimed it
//   ctx     { cue: {x, z}, obstacles: [{x, z}], railPts }
//
// Returns { pitch, impulse, angVel }. `pitch` is the FINAL elevation after the
// clearance floor, which may be higher than requested — callers must report
// that value back to the client, or the replayed cue stick won't match the shot.
export function resolveStrike(params, { cue, obstacles, railPts }) {
  // Authoritative cue-elevation floor: raise the pitch to clear any ball/rail
  // behind the cue ball, regardless of what the client sent.
  const pitch = legalPitch(params.pitch, {
    cx: cue.x, cz: cue.z, yaw: params.yaw, strikeY: params.strikeY, obstacles, railPts,
  });

  // Cue direction (back→tip, includes pitch) and the pitched stick frame:
  // `right` is horizontal ⟂ to aim, `stickUp` completes the frame.
  const cy = Math.cos(params.yaw), syaw = Math.sin(params.yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const dir = { x: cy * cp, y: -sp, z: syaw * cp };
  let right = cross(dir, { x: 0, y: 1, z: 0 });
  if (lenSq(right) < 1e-8) right = { x: 0, y: 0, z: 1 };
  right = normalize(right);
  const stickUp = normalize(cross(right, dir));

  // Squirt: deflect the LAUNCH direction a few degrees away from the english
  // side (opposite to `right·strikeX`), leaving the spin computation on the
  // true cue line so english itself is unchanged. Follow/draw (strikeY) does
  // not squirt. Renormalize so speed is unaffected.
  const squirt = -params.strikeX * SQUIRT_MAX_TAN;
  const shotDir = normalize({
    x: dir.x + right.x * squirt, y: dir.y + right.y * squirt, z: dir.z + right.z * squirt,
  });

  const Jmag = params.power * SHOT_IMPULSE_PER_M * m;
  const impulse = { x: shotDir.x * Jmag, y: shotDir.y * Jmag, z: shotDir.z * Jmag };

  // Spin from the off-centre strike: ω = (contact × dir)·(Jmag·SPIN_GAIN / I),
  // using the true cue line `dir` (not the squirted direction).
  const sxOff = params.strikeX * R * MISCUE_LIMIT, syOff = params.strikeY * R * MISCUE_LIMIT;
  const backDist = Math.sqrt(Math.max(0, R * R - sxOff * sxOff - syOff * syOff));
  const contact = {
    x: right.x * sxOff + stickUp.x * syOff - dir.x * backDist,
    y: right.y * sxOff + stickUp.y * syOff - dir.y * backDist,
    z: right.z * sxOff + stickUp.z * syOff - dir.z * backDist,
  };
  const spin = cross(contact, dir);
  const k = Jmag * SPIN_GAIN / BALL_INERTIA;

  return {
    pitch,
    impulse,
    angVel: { x: spin.x * k, y: spin.y * k, z: spin.z * k },
  };
}
