// test/fullGame.test.js — bot vs bot, rack to win.
//
// The broadest net in the suite: one pass exercises the rack, ball-in-hand
// placement, the AI, the strike math, the physics loop, pocket detection and
// respotting, rules resolution, and every phase transition — repeatedly, in
// combination, on layouts no hand-written fixture would produce.
//
// Deliberately RANDOMIZED (both rulesets shuffle their rack, and the AI has its
// own randomness), so this is a fuzz test rather than a golden. It asserts only
// that the game terminates in a legitimate win. A failure here means the loop
// can deadlock, reject a legal shot, or reach a state the rules can't resolve —
// each of which is a serious bug and none of which the fixed-layout tests can
// see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAmmo } from './helpers/simHarness.js';

const { RoomSim, PH_AIMING, PH_PLACING, PH_OVER } = await bootAmmo();
const { computeBotShot, computeBotPlacement } = await import('../src/server/ai.js');

// A real game is well under 100 shots; the cap is only here so a deadlock fails
// the test instead of hanging it.
const SHOT_CAP = 400;

function playToCompletion(rulesetId) {
  const sim = new RoomSim(rulesetId);
  sim.newGame();
  let shots = 0;

  while (sim.phase() !== PH_OVER && shots < SHOT_CAP) {
    const phase = sim.phase();
    const player = sim.currentPlayer();

    if (phase === PH_PLACING) {
      const pos = computeBotPlacement(sim);
      if (pos) sim.applyPlaceMove(player, pos.x, pos.z);
      assert.ok(sim.applyPlaceConfirm(player), 'placement confirm was rejected');
      continue;
    }

    assert.equal(phase, PH_AIMING, `unexpected phase ${phase} mid-game`);
    const shot = computeBotShot(sim, 1.0);
    assert.ok(shot, 'the AI failed to produce a shot');
    assert.ok(sim.applyShoot(player, shot), 'the sim rejected the AI\'s own shot');
    shots++;
  }

  return { sim, shots, match: sim.game.getState() };
}

for (const rulesetId of ['8ball', '9ball']) {
  // Two passes each: different racks, different lines, still must terminate.
  for (let trial = 0; trial < 2; trial++) {
    test(`full game: ${rulesetId} reaches a legitimate win (trial ${trial})`, () => {
      const { sim, shots, match } = playToCompletion(rulesetId);

      assert.equal(sim.phase(), PH_OVER, `game did not finish in ${shots} shots`);
      assert.ok(shots > 0 && shots < SHOT_CAP, `implausible shot count: ${shots}`);
      assert.ok(match.winner === 0 || match.winner === 1, `no winner recorded: ${match.winner}`);
      assert.match(match.message, /wins/, `unexpected end message: "${match.message}"`);
      assert.equal(sim.game.isOver(), true);

      // The winning ball must actually be gone, and the cue ball must not be.
      const cue = sim.balls.find(b => b.style === 'cue');
      assert.ok(cue, 'the cue ball vanished');
      const key = rulesetId === '9ball' ? 9 : 8;
      assert.ok(!sim.balls.some(b => b.number === key),
        `the ${key} should be off the table at the end of a ${rulesetId} game`);
    });
  }
}

test('full game: a finished game can be re-racked and played again', () => {
  const { sim } = playToCompletion('9ball');
  assert.equal(sim.phase(), PH_OVER);

  sim.newGame();
  assert.equal(sim.phase(), PH_PLACING, 'a new rack re-enters break placement');
  assert.equal(sim.game.isOver(), false);
  assert.equal(sim.balls.length, 10, 'every ball is back on the table');
  assert.equal(sim.currentPlayer(), 0);
});
