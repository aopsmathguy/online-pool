// src/server/shotRecorder.js — delta-encode a shot into replay keyframes.
//
// One recorder per shot. Frame 0 is a full absolute capture; every frame after
// it carries a ball's position only if it moved, and its rotation only if it
// rotated — independently. Resting balls cost zero bytes per frame, and a ball
// spinning in place resends only its quaternion.
//
// THE SUBTLE PART is the baseline lifetime. sentPos/sentRot hold the last
// TRANSMITTED value per ball, so slow drift accumulates into an eventual resend
// rather than being swallowed frame after frame; and they reset ONLY on a
// non-delta capture. Get that wrong and replays are correct on the first shot
// and progressively wrong after — balls appearing to teleport mid-replay.
//
// Deliberately Ammo-free: capture() takes plain {id,x,y,z,qx,qy,qz,qw} objects,
// so this is testable with literals and the caller owns transform reading.
import { FIXED_DT } from '../shared/constants.js';

// Keyframe interval. Kept an exact multiple of FIXED_DT (4 × 4 ms = 16 ms,
// ~62 fps) so keyframes land on step boundaries — uniform spacing, no temporal
// jitter in the replay.
export const REPLAY_FRAME_DT = FIXED_DT * 4;

// Thresholds are far below anything visible: 0.1 mm, and ~0.11° of rotation.
const POS_EPS = 1e-4;    // m
const QUAT_EPS = 1e-3;   // per quaternion component

export function createShotRecorder() {
  let sentPos = new Map();
  let sentRot = new Map();
  const frames = [];

  // Capture one keyframe from `balls` (an iterable of plain pose objects).
  // Without `delta` the baselines reset and everything is captured — that is
  // frame 0 of a recording, so clients always have an absolute frame to expand
  // deltas from.
  function capture(balls, { delta = false } = {}) {
    if (!delta) { sentPos = new Map(); sentRot = new Map(); }
    const pos = [], rot = [];

    for (const b of balls) {
      const p = { id: b.id, x: b.x, y: b.y, z: b.z };
      const lp = sentPos.get(b.id);
      if (!lp || Math.abs(p.x - lp.x) >= POS_EPS || Math.abs(p.y - lp.y) >= POS_EPS
              || Math.abs(p.z - lp.z) >= POS_EPS) {
        sentPos.set(b.id, p);
        pos.push(p);
      }
      const r = { id: b.id, qx: b.qx, qy: b.qy, qz: b.qz, qw: b.qw };
      const lr = sentRot.get(b.id);
      if (!lr || Math.abs(r.qx - lr.qx) >= QUAT_EPS || Math.abs(r.qy - lr.qy) >= QUAT_EPS
              || Math.abs(r.qz - lr.qz) >= QUAT_EPS || Math.abs(r.qw - lr.qw) >= QUAT_EPS) {
        sentRot.set(b.id, r);
        rot.push(r);
      }
    }

    frames.push({ pos, rot });
    return frames.length - 1;   // index of the frame just captured
  }

  return {
    capture,
    frames,
    get frameCount() { return frames.length; },
    // N frames span N-1 intervals. Must match how the client measures the same
    // recording (makeShotPlayer in client/shotPlayer.js), or the two sides
    // disagree about how long the shot lasts.
    get durationMs() { return Math.max(0, frames.length - 1) * REPLAY_FRAME_DT * 1000; },
  };
}
