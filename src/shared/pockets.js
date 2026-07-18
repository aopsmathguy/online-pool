// src/pockets.js — single source of pocket geometry for THIS table. Pure math
// (no Three/Ammo), shared by the server sim (ball capture + pocket-mouth
// collision masking) and the AI aimer (mouth-endpoint geometry for planning).
//
// Everything derives from pocket_positions() (centres) plus the mouth-width
// constants, so pocket size/placement lives in exactly one place.
import { tableW, tableH, corner_mouth, mid_mouth } from './constants.js';
import { pocket_positions } from './table.js';

// Pocket centre positions [[x, z], ...].
export const pocketPositions = pocket_positions(tableW, tableH);

// --- Ball-capture geometry (server sim) -------------------------------------
// A ball is pocketed once it drops below POCKET_Y_THRESHOLD with its centre
// within CAPTURE_R of a pocket. The DROP itself is physical: near a pocket the
// ball rolls on the triangulated felt (which has the real hole) and tips in —
// see isNearPocket + createFeltMesh.
export const POCKET_Y_THRESHOLD = -0.05;
const CAPTURE_R = 0.10;
const CAPTURE_R_SQ = CAPTURE_R * CAPTURE_R;

export function isInsideAnyPocket(x, z) {
  for (const [px, pz] of pocketPositions) {
    const dx = x - px, dz = z - pz;
    if (dx * dx + dz * dz <= CAPTURE_R_SQ) return true;
  }
  return false;
}

// True when a ball is close enough to a pocket to swap from the flat felt plane
// to the triangulated felt mesh (which has the real hole). NEAR_R must comfortably
// exceed the mouth cutout's reach (~0.13 m at the corners) so the ball is already
// on the mesh by the time it reaches the opening.
const NEAR_R = 0.2;
const NEAR_R_SQ = NEAR_R * NEAR_R;
export function isNearPocket(x, z) {
  for (const [px, pz] of pocketPositions) {
    const dx = x - px, dz = z - pz;
    if (dx * dx + dz * dz <= NEAR_R_SQ) return true;
  }
  return false;
}

// --- Mouth-endpoint geometry (AI aimer) -------------------------------------
// Each pocket described by the two rail-polyline points that define its opening
// (mouth) — `e1`, `e2` — plus the mouth midpoint `x,z` (used by the scratch/kick
// keep-out checks, NOT as the aim point), the inward normal (nx, nz), and an
// approach-angle gate `minDot`. Corner mouths span [±w/2 ∓ cm/√2, ±h/2] to
// [±w/2, ±h/2 ∓ cm/√2]; side mouths span [∓mm/2, ±h/2] to [±mm/2, ±h/2]. The
// gate: side pockets refuse shallow (along-rail) approaches that would just clip
// the mouth; corners accept nearly anything. Order matches pocketPositions.
export const POCKET_MOUTHS = (() => {
  const cw = corner_mouth / Math.SQRT2;   // corner mouth endpoint inset per axis
  const corner = (sx, sz) => ({
    x: sx * (tableW / 2 - cw / 2), z: sz * (tableH / 2 - cw / 2),
    e1: { x: sx * (tableW / 2),      z: sz * (tableH / 2 - cw) },
    e2: { x: sx * (tableW / 2 - cw), z: sz * (tableH / 2) },
    nx: sx / Math.SQRT2, nz: sz / Math.SQRT2, minDot: 0.05,
  });
  const side = (sz) => ({
    x: 0, z: sz * (tableH / 2),
    e1: { x: -mid_mouth / 2, z: sz * (tableH / 2) },
    e2: { x:  mid_mouth / 2, z: sz * (tableH / 2) },
    nx: 0, nz: sz, minDot: 0.35,
  });
  return [corner(-1, -1), side(-1), corner(1, -1), corner(1, 1), side(1), corner(-1, 1)];
})();
