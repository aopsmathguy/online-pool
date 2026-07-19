// src/sim.js — one authoritative pool simulation per room (server-side).
//
// This is the orchestration from the old client main.js, ported to run headless
// on the server against an instanced world + balls + game. Only rendering and
// input are gone.
//
// RoomSim owns the Ammo world and the ball array for one room, validates player
// actions against the current phase, and runs a shot to rest. It delegates the
// things that are not about owning a world: strike math (strike.js), replay
// encoding (shotRecorder.js), placement geometry (placement.js), wire format
// (simView.js) and world construction (table.world.js).
import {
  tableW, tableH, FIXED_DT, R, g, RACK_QUAT,
} from '../shared/constants.js';
import {
  setBodyFilter, stepAndDamp, tmpVec3, AmmoLib,
  CG_BALL, CG_SUNK,
  MASK_BALL_NORMAL, MASK_BALL_NEAR_POCKET, MASK_SUNK,
} from './physics.js';
import { buildTableWorld, railPoints } from './table.world.js';
import { computeBounds, resolvePlacement, HEAD_STRING_X } from './placement.js';
import { startInfo, ballsFrame, gameStatePacket, placingPacket } from './simView.js';
import { resolveStrike } from './strike.js';
import { resetRack, setBallPosition, spotBall } from './balls.logic.js';
import { createGame } from '../shared/game.js';
import { densify } from '../shared/clearance.js';
import {
  POCKET_Y_THRESHOLD, isInsideAnyPocket, isNearPocket,
} from '../shared/pockets.js';
import { PH_AIMING, PH_SHOOTING, PH_PLACING, PH_OVER } from '../shared/net/packets.js';

// --- Tunables ---------------------------------------------------------------
const LIN_REST = 0.01;   // m/s
const ANG_REST = 0.20;   // rad/s

// Shot replay recording: physics runs to rest synchronously on shoot, sampled
// into keyframes every REPLAY_FRAME_DT for the client to animate through.
// Kept an exact multiple of FIXED_DT (4 × 4 ms = 16 ms, ~62 fps) so keyframes
// land on step boundaries — uniform spacing, no temporal jitter in the replay.
const REPLAY_FRAME_DT = FIXED_DT * 4;
const MAX_SHOT_SECONDS = 60;     // hard cap so a pathological shot can't hang

// Delta keyframes: a ball's position (and, independently, its rotation) is
// included in a frame only if it changed beyond these thresholds since the
// last frame that transmitted it — resting balls cost zero bytes per frame,
// and a ball spinning in place resends only its quaternion. Thresholds are
// far below anything visible (0.1 mm; ~0.11° of rotation) and compare against
// the last TRANSMITTED value, so slow drift still accumulates into a resend
// rather than being swallowed frame after frame.
const POS_EPS = 1e-4;    // m
const QUAT_EPS = 1e-3;   // per quaternion component

// Pocket capture geometry (Y threshold + radii + hit tests) lives in pockets.js.
const OOB_X = tableW / 2 + 0.15;
const OOB_Z = tableH / 2 + 0.15;

const SPOT_X = tableW * 0.25;
const SPOT_HALF = tableW / 2 - 2 * R;

// Interaction state codes come from net/packets.js (shared with the client).
export { PH_AIMING, PH_SHOOTING, PH_PLACING, PH_OVER };

const railClearPts = densify(railPoints);   // sampled rail for cue-clearance

export class RoomSim {
  constructor(rulesetId) {
    const { world, railPtr } = buildTableWorld();
    this.world = world;
    this.railPtr = railPtr;     // scanContacts identifies rail hits by this ptr
    this.balls = [];
    this.game = createGame(rulesetId, this.balls);

    this.interact = PH_AIMING;
    this.acc = 0;
    this.pocketedList = [];
    this.sunk = [];               // balls resting in pockets (kept for display, not in play)
    this.ballByPtr = new Map();
    this.cuePtr = 0;
    this.placePos = { x: HEAD_STRING_X, z: 0 };
    this.placeBounds = computeBounds(false);
    this.placeBehindLine = false;
    this.lastAim = { yaw: 0, pitch: 0.25, strikeX: 0, strikeY: 0, pullback: 0 };
  }

  // --- Public API used by the server -----------------------------------------
  setPlayerNames(a, b) {
    this.game.getState().players[0].name = a;
    this.game.getState().players[1].name = b;
  }

  newGame(changeGame) {
    if (changeGame) this.game.setRuleset(changeGame);
    else this.game.reset();
    const layout = this.game.rackLayout({ tableW, tableH });
    for (const b of this.sunk) this.world.removeRigidBody(b.body);   // clear last game's pocketed balls
    this.sunk = [];
    resetRack(this.world, this.balls, layout);
    this.balls.forEach((b, i) => { b.id = i; b.scratched = false; b.pendingSpot = false; });
    this.settleRack();
    this.pocketedList = [];
    this.acc = 0;
    this.rebuildBallPtrMap();
    if (this.game.isBreak()) this.startPlacement({ behindLine: true });
    else this.interact = PH_AIMING;
    return this.startInfo();
  }

  // Rack specs carry ~1 mm of jitter, so freshly-set balls overlap slightly and
  // would visibly shuffle apart during the first frames of the break replay.
  // Settle that out at rack time instead: step the physics until everything is
  // at rest (min 0.1 s — velocities start at zero, so ballsAtRest would pass
  // vacuously on step one), then square every ball back onto the shared
  // number-up RACK_QUAT (rotation is free for a sphere) and zero its motion,
  // so the bodies exactly match the rack meshes the client builds and the
  // startGame layout reports truly-resting positions.
  settleRack() {
    const SETTLE_MIN = 0.1, SETTLE_MAX = 2.0;
    for (let t = 0; t < SETTLE_MAX; t += FIXED_DT) {
      stepAndDamp(this.world, this.balls, FIXED_DT);
      if (t >= SETTLE_MIN && this.ballsAtRest()) break;
    }
    const q = new AmmoLib.btQuaternion(RACK_QUAT.x, RACK_QUAT.y, RACK_QUAT.z, RACK_QUAT.w);
    for (const b of this.balls) {
      const tr = b.body.getWorldTransform();
      tr.setRotation(q);
      b.body.setWorldTransform(tr);
      b.body.getMotionState().setWorldTransform(tr);
      tmpVec3.setValue(0, 0, 0);
      b.body.setLinearVelocity(tmpVec3);
      b.body.setAngularVelocity(tmpVec3);
    }
    AmmoLib.destroy(q);
  }

  currentPlayer() { return this.game.getState().current; }
  phase() { return this.interact; }

  // A plain-data view of the table for anything that needs to REASON about the
  // position without touching the simulation — currently the shot chooser
  // (ai.js). Ammo transforms, the rules object and the placement box all get
  // flattened here, so the consumer stays a pure function of plain numbers and
  // can be tested with literal coordinates and no physics world at all.
  //
  // `balls[0]` is the cue, matching this.balls.
  readTable() {
    return {
      balls: this.balls.map(b => {
        const o = b.body.getWorldTransform().getOrigin();
        return { id: b.id, number: b.number, x: o.x(), z: o.z() };
      }),
      placeBounds: { ...this.placeBounds },
      phase: this.interact,
      isBreak: this.game.isBreak(),
      legalTargets: this.game.legalTargets(),
    };
  }

  // Active player sets their aim; used only for relaying to the opponent.
  applyAim(playerIdx, aim) {
    if (playerIdx !== this.currentPlayer() || this.interact !== PH_AIMING) return false;
    this.lastAim = aim;
    return true;
  }

  // Record an aim the server itself produced (the bot's). Keeps lastAim current
  // for both kinds of player, so a client resuming mid-turn can be handed the
  // pose the cue stick is actually in.
  noteAim(aim) { this.lastAim = aim; }
  currentAim() { return this.lastAim; }

  applyShoot(playerIdx, p) {
    if (playerIdx !== this.currentPlayer() || this.interact !== PH_AIMING) return false;
    if (!this.ballsAtRest()) return false;
    const cue = this.balls[0]?.body;
    if (!cue) return false;

    this.game.beginShot(this.game.isBreak());
    this.rebuildBallPtrMap();
    this.interact = PH_SHOOTING;
    this.acc = 0;
    cue.activate();

    const co = cue.getWorldTransform().getOrigin();
    const { pitch, impulse, angVel } = resolveStrike(p, {
      cue: { x: co.x(), z: co.z() },
      obstacles: this.objectBallsXZ(),
      railPts: railClearPts,
    });

    tmpVec3.setValue(impulse.x, impulse.y, impulse.z);
    cue.applyCentralImpulse(tmpVec3);
    tmpVec3.setValue(angVel.x, angVel.y, angVel.z);
    cue.setAngularVelocity(tmpVec3);

    // Simulate the whole shot to rest RIGHT NOW and hand back the recording.
    // Carry the cue params (with the FINAL, floor-raised pitch, and pullback =
    // power) so the client can replay the stick's draw-back + strike.
    return this.runShotAndRecord({
      yaw: p.yaw, pitch, strikeX: p.strikeX, strikeY: p.strikeY, pullback: p.power,
    });
  }

  // Run the physics from strike to rest synchronously, capturing a keyframe
  // every REPLAY_FRAME_DT of sim time (positions + orientations of every
  // ball) and noting the frame at which each pocketed ball disappears. The
  // shot is then resolved (rules, respots, phase transitions) before
  // returning, so by the time the packet leaves the server the room is
  // already in its post-shot state. Returns { packet, durationMs }.
  runShotAndRecord(shot) {
    const frames = [this.captureFrame()];         // frame 0 is full (delta baseline)
    const removals = [];
    let simT = 0, frameAcc = 0, settled = false;
    while (simT < MAX_SHOT_SECONDS) {
      stepAndDamp(this.world, this.balls, FIXED_DT);
      this.scanContacts();
      simT += FIXED_DT; frameAcc += FIXED_DT;
      if (frameAcc >= REPLAY_FRAME_DT - 1e-9) {
        frameAcc -= REPLAY_FRAME_DT;
        this.updatePocketMasks();
        this.checkPocketed();                     // sinks pocketed balls (not removed yet)
        frames.push(this.captureFrame(true));     // delta: moving balls only
        if (this.ballsAtRest()) { settled = true; break; }
      }
    }
    // The cap is a safety net that should never fire. If it does, the recording
    // is already ~3750 frames (megabytes through schemapack) and the room is
    // locked for a minute — so say so, with the shot that caused it, and force
    // everything to rest rather than shipping a recording that never ends.
    if (!settled) {
      console.warn('[sim] shot hit MAX_SHOT_SECONDS without settling — forcing rest.',
        JSON.stringify({ shot, frames: frames.length, balls: this.balls.length }));
      this.forceRest();
    }
    this.respotPending();      // everything has stopped → put off-table balls back
    frames.push(this.captureFrame(true));   // final resting frame incl. respots + settled cups
    // The shot is over: NOW remove the pocketed balls (they've been shown dropping
    // in). The removal lands on this final frame, so their meshes clear as the
    // replay ends rather than vanishing mid-shot.
    for (const r of this.clearSunk(frames.length - 1)) removals.push(r);
    this.game.endShot();
    if (this.game.isOver()) this.interact = PH_OVER;
    else if (this.game.needsBallInHand()) this.startPlacement({ behindLine: false });
    else this.interact = PH_AIMING;
    return {
      packet: { dtMs: REPLAY_FRAME_DT * 1000, shot, frames, removals },
      // N frames span N-1 intervals. Must match how the client measures the
      // same recording (see makeShotPlayer in client/shotPlayer.js), or the
      // two sides disagree about how long the shot lasts and the replay gate
      // is computed from a different number than the one being waited on.
      durationMs: Math.max(0, frames.length - 1) * REPLAY_FRAME_DT * 1000,
    };
  }

  // Capture a replay keyframe as independent sparse pos/rot lists. With
  // `delta`, a ball's position is skipped if it's within POS_EPS of the last
  // one transmitted for it, and its rotation independently within QUAT_EPS
  // (baselines in this.sentPos/sentRot); the client carries previous values
  // forward. Without `delta` the baselines are reset and everything is
  // captured — frame 0 of a recording, so clients always have an absolute
  // frame to expand deltas from.
  captureFrame(delta = false) {
    if (!delta) { this.sentPos = new Map(); this.sentRot = new Map(); }
    const pos = [], rot = [];
    for (const b of this.balls) this.captureBall(b, pos, rot);
    for (const b of this.sunk) this.captureBall(b, pos, rot);   // balls resting in pockets
    return { pos, rot };
  }

  captureBall(b, pos, rot) {
    const t = b.body.getWorldTransform();
    const o = t.getOrigin(), q = t.getRotation();
    const p = { id: b.id, x: o.x(), y: o.y(), z: o.z() };
    const lp = this.sentPos.get(b.id);
    if (!lp || Math.abs(p.x - lp.x) >= POS_EPS || Math.abs(p.y - lp.y) >= POS_EPS
            || Math.abs(p.z - lp.z) >= POS_EPS) {
      this.sentPos.set(b.id, p);
      pos.push(p);
    }
    const r = { id: b.id, qx: q.x(), qy: q.y(), qz: q.z(), qw: q.w() };
    const lr = this.sentRot.get(b.id);
    if (!lr || Math.abs(r.qx - lr.qx) >= QUAT_EPS || Math.abs(r.qy - lr.qy) >= QUAT_EPS
            || Math.abs(r.qz - lr.qz) >= QUAT_EPS || Math.abs(r.qw - lr.qw) >= QUAT_EPS) {
      this.sentRot.set(b.id, r);
      rot.push(r);
    }
  }

  applyPlaceMove(playerIdx, x, z) {
    if (playerIdx !== this.currentPlayer() || this.interact !== PH_PLACING) return false;
    this.placePos.x = x; this.placePos.z = z;
    this.clampAndResolvePlace();
    const cue = this.balls[0];
    if (cue) setBallPosition(this.world, cue, this.placePos.x, this.placePos.z);
    return true;
  }

  applyPlaceConfirm(playerIdx) {
    if (playerIdx !== this.currentPlayer() || this.interact !== PH_PLACING) return false;
    this.interact = PH_AIMING;
    return true;
  }

  // --- Snapshots for the wire -------------------------------------------------
  // Built in simView.js so the whole wire format sits in one place. Kept as
  // methods because they are how the server asks the sim about itself.
  startInfo() { return startInfo(this); }
  ballsFrame() { return ballsFrame(this); }
  gameStatePacket() { return gameStatePacket(this); }
  placingPacket() { return placingPacket(this); }

  // --- Internals (ported from main.js) ---------------------------------------
  rebuildBallPtrMap() {
    this.ballByPtr.clear();
    for (const b of this.balls) this.ballByPtr.set(b.body.ptr, b);
    this.cuePtr = this.balls[0] ? this.balls[0].body.ptr : 0;
  }

  scanContacts() {
    const disp = this.world.getDispatcher();
    const railPtr = this.railPtr;
    const n = disp.getNumManifolds();
    for (let i = 0; i < n; i++) {
      const mani = disp.getManifoldByIndexInternal(i);
      if (mani.getNumContacts() === 0) continue;
      const p0 = mani.getBody0().ptr, p1 = mani.getBody1().ptr;
      const ball0 = this.ballByPtr.get(p0), ball1 = this.ballByPtr.get(p1);
      if (ball0 && ball1) {
        const cue0 = p0 === this.cuePtr, cue1 = p1 === this.cuePtr;
        if (cue0 !== cue1) {
          const obj = cue0 ? ball1 : ball0;
          if (obj.number != null) this.game.recordFirstHit(obj.number);
        }
      } else if (ball0 && p1 === railPtr) {
        this.game.recordRail(ball0.number);
      } else if (ball1 && p0 === railPtr) {
        this.game.recordRail(ball1.number);
      }
    }
  }

  // Near a pocket, swap the ball onto the triangulated felt (real hole) so it can
  // tip in; elsewhere keep it on the flat plane. Just a collision-filter switch —
  // the two felt surfaces are coplanar, so nothing pops.
  updatePocketMasks() {
    for (const b of this.balls) {
      if (b.pendingSpot) continue;
      const o = b.body.getWorldTransform().getOrigin();
      const near = isNearPocket(o.x(), o.z());
      if (near === b.nearPocket) continue;
      setBodyFilter(this.world, b.body, CG_BALL, near ? MASK_BALL_NEAR_POCKET : MASK_BALL_NORMAL);
      b.nearPocket = near;
      if (near) b.body.activate();
    }
  }

  checkPocketed() {
    for (const b of [...this.balls]) {
      if (b.pendingSpot) continue;   // already parked; re-spotted once balls rest
      const o = b.body.getWorldTransform().getOrigin();
      const x = o.x(), y = o.y(), z = o.z();
      const below = y <= POCKET_Y_THRESHOLD;
      const oob = Math.abs(x) > OOB_X || Math.abs(z) > OOB_Z;
      if (!below && !oob) continue;

      const pocketed = below && !oob && isInsideAnyPocket(x, z);

      if (b.style === 'cue') {
        if (!b.scratched) { this.game.recordCueScratch(); b.scratched = true; }
        tmpVec3.setValue(0, 0, 0);
        b.body.setLinearVelocity(tmpVec3);
        b.body.setAngularVelocity(tmpVec3);
      } else if (pocketed) {
        if (this.game.isBreak() && b.number === 8) {
          this.park(b);   // 8 on the break: spot it back once the table settles
          continue;
        }
        this.game.recordPocket(b.number);
        if (b.number != null) this.pocketedList.push(b.number);
        this.sink(b);   // keep it resting in the cup (not deleted)
      } else {
        // Driven off the table → foul. Record it now, but park the ball frozen
        // where it is and only spot it back once EVERY ball has stopped moving
        // (see respotPending), not mid-shot.
        this.game.recordOffTable(b.number);
        this.park(b);
      }
    }
  }

  // A pocketed ball keeps falling into its cup DURING the shot (so the client
  // sees it drop in) and is removed only once the shot is over (see clearSunk in
  // runShotAndRecord). Move it out of the in-play `balls` list (rules, AI and
  // contact scanning ignore it) into `sunk`, and re-filter it into the pocket
  // group: it collides with the cup (and other sunk balls) so it drops to the
  // bottom, but NOT with the felt, the rails, or the in-play balls — a ball on
  // its way into the pocket must not disturb the balls still in play or keep the
  // rest check from settling. It stays dynamic (the re-add restores gravity) and
  // keeps being streamed until removed.
  sink(b) {
    const i = this.balls.indexOf(b);
    if (i >= 0) this.balls.splice(i, 1);
    b.sunk = true;
    setBodyFilter(this.world, b.body, CG_SUNK, MASK_SUNK);
    this.sunk.push(b);
    this.rebuildBallPtrMap();   // its ptr must no longer count as a live ball
  }

  // Remove every pocketed ball from the world once the shot has settled. Pushes a
  // removal at the final frame so the client (which has watched them drop in)
  // clears their meshes as the replay ends. Returns the removals to append.
  clearSunk(frame) {
    const out = this.sunk.map(b => ({ id: b.id, frame }));
    for (const b of this.sunk) this.world.removeRigidBody(b.body);
    this.sunk = [];
    return out;
  }

  // Freeze a ball in place and flag it to be re-spotted at rest. Zeroing its
  // gravity + velocity keeps it exactly put (and out of the rest check) without
  // falling forever or blocking shot resolution.
  park(b) {
    b.pendingSpot = true;
    tmpVec3.setValue(0, 0, 0);
    b.body.setGravity(tmpVec3);        // shared scratch vector — never allocate per call
    b.body.setLinearVelocity(tmpVec3);
    b.body.setAngularVelocity(tmpVec3);
  }

  // Once the shot has settled, put every parked ball back onto the table.
  respotPending() {
    for (const b of this.balls) {
      if (!b.pendingSpot) continue;
      tmpVec3.setValue(0, -g, 0);
      b.body.setGravity(tmpVec3);      // restore normal gravity
      spotBall(this.world, this.balls, b, SPOT_X, SPOT_HALF);
      b.pendingSpot = false;
    }
  }

  // Rest = the IN-PLAY balls have stopped; this ends the replay and gates the
  // next shot. Pocketed balls (this.sunk) are deliberately excluded: they can
  // jitter indefinitely settling in a cup, and waiting on them would drag every
  // shot to the time cap and block the next shot. They still fall dynamically
  // during the replay (gravity is on), and since the live balls keep rolling for
  // far longer than the ~0.3 s cup drop takes, the fall is captured in full.
  ballsAtRest() {
    for (const b of this.balls) if (!this.ballRested(b)) return false;
    return true;
  }

  // Hard-stop every in-play ball. Only used when the shot time cap fires, to
  // guarantee the recording terminates and the table is in a state the next
  // shot can legally start from.
  forceRest() {
    tmpVec3.setValue(0, 0, 0);
    for (const b of this.balls) {
      b.body.setLinearVelocity(tmpVec3);
      b.body.setAngularVelocity(tmpVec3);
    }
  }

  ballRested(b) {
    if (b.pendingSpot) return true;   // parked off-table balls are frozen; ignore
    const v = b.body.getLinearVelocity();
    if (Math.hypot(v.x(), v.y(), v.z()) > LIN_REST) return false;
    const w = b.body.getAngularVelocity();
    if (Math.hypot(w.x(), w.y(), w.z()) > ANG_REST) return false;
    return true;
  }

  // Object-ball centres, as the plain {x, z} pairs placement.js works in.
  objectBallsXZ() {
    const out = [];
    for (const b of this.balls) {
      if (b.style === 'cue') continue;
      const o = b.body.getWorldTransform().getOrigin();
      out.push({ x: o.x(), z: o.z() });
    }
    return out;
  }

  // Snap this.placePos to the nearest legal spot for the current bounds.
  clampAndResolvePlace() {
    this.placePos = resolvePlacement(this.placePos, this.placeBounds, this.objectBallsXZ());
  }

  startPlacement({ behindLine = false } = {}) {
    this.interact = PH_PLACING;
    this.placeBehindLine = behindLine;
    this.placeBounds = computeBounds(behindLine);
    // Start the placement from wherever the cue ball was left, not a fixed
    // spot: after a non-scratch foul that's exactly where it came to rest;
    // after a scratch the body is down a pocket (or off the table), so the
    // clamp/overlap resolve below pulls it to the nearest legal felt position
    // — right beside the offending pocket. The opening break also lands here:
    // the cue is racked on the head spot, which the behindLine bounds keep.
    const cueBall = this.balls[0];
    if (cueBall) {
      const o = cueBall.body.getWorldTransform().getOrigin();
      this.placePos = { x: o.x(), z: o.z() };
    } else {
      this.placePos = { x: -tableW * 0.25, z: 0 };
    }
    this.clampAndResolvePlace();
    for (const b of this.balls) {
      tmpVec3.setValue(0, 0, 0);
      b.body.setLinearVelocity(tmpVec3);
      b.body.setAngularVelocity(tmpVec3);
    }
    const cue = this.balls[0];
    if (cue) { cue.scratched = false; setBallPosition(this.world, cue, this.placePos.x, this.placePos.z); }
  }
}

