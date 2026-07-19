// test/shotRecording.test.js — the replay recording contract.
//
// Guards the delta encoder before it moves into its own module (Phase 4). The
// subtle part is the BASELINE LIFETIME: sentPos/sentRot reset only on a
// non-delta capture, and a ball's position and rotation are tracked
// INDEPENDENTLY. Getting that wrong yields replays that are correct on the
// first shot and progressively wrong afterwards — balls appearing to teleport
// mid-replay. These assertions are about structure, not exact floats, so they
// survive a physics re-baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, potLine } from './helpers/simHarness.js';

async function shoot(dPocket = 0.45, dCue = 0.45, power = 0.45) {
  const g = potLine(dPocket, dCue);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: g.target } });
  const anim = sim.applyShoot(sim.currentPlayer(), {
    yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power,
  });
  return { sim, anim };
}

test('recording: frame 0 is a full absolute capture of every ball', async () => {
  const { sim, anim } = await shoot();
  const f0 = anim.packet.frames[0];
  // 10 balls in a 9-ball rack (cue + 1..9); frame 0 must carry all of them,
  // both position and rotation, so the client can expand deltas from it.
  assert.equal(f0.pos.length, 10);
  assert.equal(f0.rot.length, 10);
  const ids = f0.pos.map(p => p.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('recording: later frames omit balls that have not moved', async () => {
  const { anim } = await shoot();
  const f1 = anim.packet.frames[1];
  // One 16 ms step after the strike, only the cue ball has moved.
  assert.equal(f1.pos.length, 1, 'only the struck ball should appear');
  assert.equal(f1.pos[0].id, 0, 'and it should be the cue ball');
});

test('recording: dtMs is the keyframe interval and frames span the shot', async () => {
  const { anim } = await shoot();
  assert.equal(anim.packet.dtMs, 16);
  assert.ok(anim.packet.frames.length > 30, 'a real shot should span many frames');
  assert.ok(anim.durationMs > 0);
});

test('recording: position and rotation are tracked independently', async () => {
  const { anim } = await shoot();
  // A rolling ball resends both; the encoder must be capable of emitting a
  // frame where the two lists differ in length, otherwise they are coupled.
  const differ = anim.packet.frames
    .slice(1)
    .some(f => f.pos.length !== f.rot.length);
  assert.ok(differ, 'expected at least one frame where pos and rot lists differ');
});

test('recording: a pocketed ball is removed on the final frame, not mid-shot', async () => {
  const { anim } = await shoot();
  const last = anim.packet.frames.length - 1;
  assert.equal(anim.packet.removals.length, 1, 'the 1 should be pocketed');
  assert.equal(anim.packet.removals[0].id, 1);
  assert.equal(anim.packet.removals[0].frame, last,
    'removal must land on the last frame so the ball is seen dropping in');
});

test('recording: the last frame reports everything at rest', async () => {
  const { anim } = await shoot();
  const frames = anim.packet.frames;
  // Nothing changed between the penultimate and final capture beyond the
  // epsilon, so the final delta frame is empty (or nearly so).
  assert.ok(frames[frames.length - 1].pos.length <= 1,
    'the shot should have settled by the final frame');
});

test('recording: a shot that pockets nothing produces no removals', async () => {
  const g = potLine(0.45, 0.45);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: g.target } });
  // Aim 90° away from the object ball: a rail-only shot.
  const anim = sim.applyShoot(sim.currentPlayer(), {
    yaw: g.yaw + Math.PI / 2, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.3,
  });
  assert.deepEqual(anim.packet.removals, []);
});

test('recording: consecutive shots each start from a fresh full baseline', async () => {
  // The baseline reset is what stops shot N+1's deltas being expanded against
  // shot N's stale values on a client that joined late.
  const { sim } = await shoot();
  const second = sim.applyShoot(sim.currentPlayer(), {
    yaw: 2.0, pitch: 0.2, strikeX: 0, strikeY: 0, power: 0.3,
  });
  assert.ok(second, 'the shooter continued, so a second shot is legal');
  const f0 = second.packet.frames[0];
  assert.equal(f0.pos.length, 9, 'frame 0 must be full: 9 balls remain after the pot');
  assert.equal(f0.rot.length, 9);
});
