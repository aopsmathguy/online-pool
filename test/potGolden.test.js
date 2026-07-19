// test/potGolden.test.js — end-to-end physics: does the ball actually go in?
//
// The catch-all net under the shot loop. Deliberately TOLERANT: it asserts
// outcomes (potted / not potted / scratched), never exact positions, so a
// legitimate physics change doesn't produce a wall of false failures. What it
// will catch is a shot pipeline that has stopped working — a broken impulse, a
// pocket check that never fires, a rest condition that never settles.
//
// Phase 5 (moving pocket detection out of the keyframe branch) is expected to
// shift MARGINAL cases here. The cases below are chosen to be comfortably
// inside their margins so that shouldn't happen; if one flips, look at it
// rather than reflexively re-baselining.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, potLine, ballPos } from './helpers/simHarness.js';

const potted = (sim, n) => ballPos(sim, n) === null;
const scratched = (sim) => /Scratch/.test(sim.game.getState().message);

async function straightPot(dPocket, dCue, power, extra = {}) {
  const g = potLine(dPocket, dCue);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: g.target } });
  const before = sim.balls.length;
  sim.applyShoot(sim.currentPlayer(), {
    yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power, ...extra,
  });
  return { sim, potted: before - sim.balls.length };
}

// Distances chosen well inside the potting margin at these powers.
for (const [dPocket, dCue, power] of [[0.45, 0.45, 0.45], [0.8, 0.5, 0.5], [1.2, 0.6, 0.6]]) {
  test(`pot: straight-in from ${dPocket}m with the cue ${dCue}m back`, async () => {
    const { sim, potted: n } = await straightPot(dPocket, dCue, power);
    assert.equal(n, 1, 'exactly one ball should have gone down');
    assert.ok(potted(sim, 1), 'the 1 should be the ball that went down');
    assert.ok(!scratched(sim), 'the cue ball should stay on the table');
  });
}

test('pot: the shot resolves and hands the table back to the shooter', async () => {
  const { sim } = await straightPot(0.45, 0.45, 0.45);
  assert.equal(sim.phase(), 0, 'PH_AIMING — the shooter continues after a pot');
  assert.equal(sim.currentPlayer(), 0);
});

test('pot: missing the pocket leaves the ball on the table and passes the turn', async () => {
  const g = potLine(0.8, 0.5);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: g.target } });
  // Aim well off the pot line: contact the 1, drive it into a rail, no pot.
  const anim = sim.applyShoot(sim.currentPlayer(), {
    yaw: g.yaw + 0.28, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.5,
  });
  assert.ok(anim, 'the shot should have been accepted');
  assert.ok(!potted(sim, 1), 'the 1 should still be on the table');
  assert.equal(sim.currentPlayer(), 1, 'a legal miss passes the turn');
});

test('pot: every shot terminates well inside the time cap', async () => {
  // A hard shot into the pack: the slowest realistic case. If the rest
  // condition ever stops being reachable this is what catches it.
  const sim = await makeSim('9ball', { cue: { x: -0.7, z: 0 }, balls: { 1: { x: 0.3, z: 0 } } });
  const anim = sim.applyShoot(sim.currentPlayer(), {
    yaw: 0, pitch: 0.06, strikeX: 0, strikeY: 0, power: 1.0,
  });
  // MAX_SHOT_SECONDS is 60 at 16 ms per frame → 3750 frames at the cap.
  assert.ok(anim.packet.frames.length < 1500,
    `shot took ${anim.packet.frames.length} frames — suspiciously close to the cap`);
});

test('pot: balls come to rest inside the table bounds', async () => {
  const { sim } = await straightPot(0.8, 0.5, 0.5);
  for (const b of sim.balls) {
    const o = b.body.getWorldTransform().getOrigin();
    assert.ok(Math.abs(o.x()) < 1.3, `ball ${b.number} ended up at x=${o.x()}`);
    assert.ok(Math.abs(o.z()) < 0.75, `ball ${b.number} ended up at z=${o.z()}`);
    assert.ok(o.y() > -0.05, `ball ${b.number} fell through the felt (y=${o.y()})`);
  }
});
