// src/client/shotPlayer.js — the ONE way a shot is played back.
//
// Every consumer plays shots through this module: the live shot replay, the
// past-shot review player, and the reconnect catch-up. They used to each carry
// their own copy of the frame maths and cue posing, which is how they drifted
// apart (a stick that only drew back in the review, pocketed balls that only
// updated on some paths, ghost meshes on others). Anything that should be true
// of "watching a shot" belongs here, once.
//
// A player is a pure function of a playhead: `applyAt(t)` puts the world at
// time t. That makes it seekable, which is what the review's scrub/step needs,
// and it means live playback and scrubbing cannot diverge.
//
// Timeline:  [ 0 ....... lead ....... | ....... ballDur ....... duration ]
//              stick draws back+strikes   recorded ball motion
//
// Deliberately NOT here: deleting ball meshes. Playback only ever *positions*
// balls — a pocketed ball drops into the cup and rests there. Which balls exist
// is decided by the authoritative `balls` packet (see syncRack in
// balls.view.js), so playback can never leave a ghost behind.
import { applyBallsFrame, applyBallsFrameLerp } from './balls.view.js';
import {
  setVisible as setCueVisible, setYaw, setPitch, setStrikeOffset, setPullback,
} from './cue.js';
import { SHOT_STRIKE_MS } from '../shared/constants.js';

// The recording starts at the moment of contact, so the draw-back is synthetic:
// a short lead-in prepended to the timeline. HOLD is the fraction of it spent
// parked at full draw before the stick accelerates into the ball.
export const STRIKE_MS = SHOT_STRIKE_MS;
const STRIKE_HOLD = 0.35;

// Frames arrive delta-encoded, positions and rotations independently: after full
// frame 0, a frame carries a ball's `pos` entry only if it moved since the last
// frame that sent one, and its `rot` entry only if it rotated. Expand to full
// per-ball frames by carrying last-known values forward. Idempotent — a shot
// replayed live and then reviewed is only expanded once.
export function expandFrames(anim) {
  if (!anim || !anim.frames || anim.frames[0].balls) return anim;
  const pos = new Map(), rot = new Map();
  for (const f of anim.frames) {
    for (const p of f.pos) pos.set(p.id, p);
    for (const r of f.rot) rot.set(r.id, r);
    f.balls = [];
    for (const [id, p] of pos) {
      const r = rot.get(id);
      if (!r) continue;
      f.balls.push({ id, x: p.x, y: p.y, z: p.z, qx: r.qx, qy: r.qy, qz: r.qz, qw: r.qw });
    }
  }
  return anim;
}

// The exact set of balls in play when this shot began — frame 0 is a full
// absolute capture. Callers use it to reconcile the rack before playing.
export function openingBalls(anim) {
  expandFrames(anim);
  return anim.frames[0].balls;
}

// Create a player for one shot.
//   animateStick — show the draw-back + strike lead-in before the ball motion.
//                  Off for a live shot you just watched someone line up: you
//                  already saw the real draw-back stream in over the wire.
//   strikeMs     — length of that lead-in.
export function makeShotPlayer(anim, { animateStick = true, strikeMs = STRIKE_MS } = {}) {
  expandFrames(anim);
  const frames = anim.frames;
  const ballDur = Math.max(0, (frames.length - 1) * anim.dtMs);
  const lead = (animateStick && anim.shot) ? strikeMs : 0;

  return {
    anim,
    lead,
    ballDur,
    duration: lead + ballDur,

    // True while the synthetic draw-back is on screen — the render loop needs
    // to know so it keeps the stick visible and renders it at the cue ball.
    drawingBackAt(t) { return lead > 0 && t < lead; },

    // Put the world at playhead `t` (ms from the start of the draw-back).
    applyAt(t) {
      if (lead > 0 && t < lead) {
        applyBallsFrame(frames[0].balls);      // balls parked until contact
        poseStick(anim.shot, t / lead);
        return;
      }
      // Past the strike the stick is gone for the rest of the shot — same as
      // watching an opponent live.
      if (lead > 0) setCueVisible(false);

      const last = frames.length - 1;
      let tf = (t - lead) / anim.dtMs;
      if (!(tf < last)) { applyBallsFrame(frames[last].balls); return; }   // also catches NaN
      if (tf < 0) tf = 0;
      const i = Math.floor(tf);
      applyBallsFrameLerp(frames[i].balls, frames[i + 1].balls, tf - i);
    },
  };
}

// Pose the cue stick along the recorded shot line. `p` is 0..1 across the
// lead-in: hold at full draw-back, then thrust the tip into the ball with an
// ease-in so it accelerates through contact. Setting the aim state also drives
// the spin dial and power meter on the HUD, so they mirror the shot being
// replayed for free.
function poseStick(shot, p) {
  if (!shot) return;
  setYaw(shot.yaw); setPitch(shot.pitch); setStrikeOffset(shot.strikeX, shot.strikeY);
  let pull = shot.pullback;
  if (p > STRIKE_HOLD) {
    const q = (p - STRIKE_HOLD) / (1 - STRIKE_HOLD);   // 0..1 through the thrust
    pull = shot.pullback * (1 - q * q);
  }
  setPullback(pull);
  setCueVisible(true);
}
