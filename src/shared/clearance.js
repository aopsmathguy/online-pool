// src/clearance.js — minimum cue elevation to clear obstacles behind the ball.
//
// The cue stick extends backward from the cue ball, tilted up by the pitch. If a
// ball or the rail cushion is behind the cue ball, a level cue would collide with
// it, so the player must "jack up" the cue. This computes the smallest pitch that
// clears every obstacle, modelling the cue as a cylinder of radius CUE_RADIUS.
// Pure math (no Three/Ammo) so the client (feel) and server (authority) share it.
import { R, wireY, rodR } from './constants.js';

export const CUE_RADIUS = 0.012;      // effective cue-stick radius
const STICK_REACH = 1.45;             // how far back the stick reaches (STICK_LEN)
const STRIKE_HEIGHT = 0.7;            // how far up strikeY moves the contact (× R)

// The rail is a COARSE polyline: consecutive cushion vertices can be far apart,
// so checking only the vertices misses a cue ball resting mid-cushion. Sample
// points along every segment (≤ maxGap apart) so the whole rail is covered.
// Call once and pass the result as `railPts` to minPitchForShot.
export function densify(pts, maxGap = 0.02) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
    const dx = x2 - x1, dz = z2 - z1;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / maxGap));
    for (let k = 0; k < n; k++) out.push([x1 + dx * k / n, z1 + dz * k / n]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

// The stick pivots at the cue-tip contact point and rises at angle `pitch` going
// backward. An obstacle (centre height h, radius ob) at horizontal distance
// `along` behind and lateral offset `lat` from the aim line needs the stick
// centreline lifted to h + sqrt((ob+cueR)^2 - lat^2); solving for the tangent of
// the pitch and taking the max over all obstacles gives the floor. Striking high
// (strikeY > 0) raises the contact/pivot, so obstacles clear at a lower angle.
//
//   cx, cz    cue-ball position
//   yaw       aim angle (shot goes toward +aim; the stick is behind, along -aim)
//   strikeY   vertical strike offset [-1..1] (top spin raises the contact point)
//   ballsXZ   [{x,z}] of the OTHER balls
//   railPts   [[x,z], ...] cushion polyline points (densify() them first)
export function minPitchForShot(cx, cz, yaw, strikeY, ballsXZ, railPts) {
  const bx = -Math.cos(yaw), bz = -Math.sin(yaw);   // unit vector pointing backward
  const pivotH = R + strikeY * R * STRIKE_HEIGHT;   // cue-tip contact height
  let maxTan = 0;

  const consider = (ox, oz, centreH, ob) => {
    const rx = ox - cx, rz = oz - cz;
    const along = rx * bx + rz * bz;                 // distance behind the cue ball
    if (along <= 1e-4 || along > STICK_REACH) return;
    const latx = rx - along * bx, latz = rz - along * bz;
    const lat = Math.hypot(latx, latz);
    const clr = ob + CUE_RADIUS;
    if (lat >= clr) return;                          // stick footprint misses it
    const vClear = Math.sqrt(clr * clr - lat * lat); // vertical gap needed
    const need = (centreH + vClear) - pivotH;        // height above the pivot
    if (need <= 0) return;
    const tan = need / along;
    if (tan > maxTan) maxTan = tan;
  };

  for (const b of ballsXZ) consider(b.x, b.z, R, R);            // object balls
  for (const p of railPts) consider(p[0], p[1], wireY, rodR);   // rail cushion

  return Math.atan(maxTan);
}

// The pitch a shot will ACTUALLY be played at: what was asked for, raised to
// the clearance floor if it was too low.
//
// Every consumer of the floor goes through here — the client's aim preview, the
// server's authoritative strike, and the bot's shot planner. They used to each
// call minPitchForShot themselves, and because the bot derived its obstacle
// list slightly differently from the server's, its computed floor could come
// out a hair below the server's; the server would then silently raise the pitch
// AFTER the bot's aim had been streamed to the human, and the cue stick would
// visibly snap. The bot compensated with a hardcoded `+ 0.01` of slop. Feeding
// all three from one function is what let that slop be deleted — so keep them
// on the same inputs.
export function legalPitch(requested, { cx, cz, yaw, strikeY, obstacles, railPts }) {
  return Math.max(requested, minPitchForShot(cx, cz, yaw, strikeY, obstacles, railPts));
}
