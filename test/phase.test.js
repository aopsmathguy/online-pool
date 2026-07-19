// test/phase.test.js — the interaction phase machine.
//
// PH_AIMING → PH_SHOOTING → (PH_OVER | PH_PLACING | PH_AIMING), plus the
// break's opening placement. These transitions are currently assigned ad-hoc
// in six places in sim.js; Phase 4 routes them through a single setPhase()
// choke point and drives the post-shot branch off endShot's returned decision
// instead of re-interrogating match state. This test is what makes that swap
// safe — it pins the observable behaviour, not the mechanism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAmmo, makeSim, potLine, ballPos } from './helpers/simHarness.js';

const { PH_AIMING, PH_PLACING, PH_OVER } = await bootAmmo();

test('phase: a new game opens in placement behind the head string', async () => {
  const { RoomSim } = await bootAmmo();
  const sim = new RoomSim('9ball');
  sim.newGame();
  assert.equal(sim.phase(), PH_PLACING, 'the break starts with ball in hand');
  assert.equal(sim.placeBehindLine, true, 'and it is restricted to behind the head string');
  assert.ok(sim.placeBounds.maxX < 0, 'the placement box must not cross the head string');
});

test('phase: confirming the break placement moves to aiming', async () => {
  const { RoomSim } = await bootAmmo();
  const sim = new RoomSim('9ball');
  sim.newGame();
  assert.equal(sim.applyPlaceConfirm(sim.currentPlayer()), true);
  assert.equal(sim.phase(), PH_AIMING);
});

test('phase: placement rejects the wrong player', async () => {
  const { RoomSim } = await bootAmmo();
  const sim = new RoomSim('9ball');
  sim.newGame();
  assert.equal(sim.applyPlaceConfirm(1 - sim.currentPlayer()), false);
  assert.equal(sim.phase(), PH_PLACING, 'phase must not have moved');
});

test('phase: a scratch ends the shot in placement for the opponent', async () => {
  // Cue ball lined up straight at the bottom-right pocket with nothing in the
  // way: it drives itself in. That is both "no ball contacted" and a scratch —
  // either way the shot ends as a foul with ball in hand.
  const g = potLine(0.0, 0.6);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: { x: -0.9, z: -0.4 } } });
  const shooter = sim.currentPlayer();
  sim.applyShoot(shooter, { yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.45 });

  assert.equal(sim.phase(), PH_PLACING, 'a foul must hand over ball in hand');
  assert.equal(sim.currentPlayer(), 1 - shooter, 'and pass the turn');
  assert.equal(sim.placeBehindLine, false, 'ball-in-hand after a foul is anywhere on the table');
  assert.equal(sim.game.needsBallInHand(), true);
});

test('phase: the cue ball is placed back on legal felt after a scratch', async () => {
  const g = potLine(0.0, 0.6);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: { x: -0.9, z: -0.4 } } });
  sim.applyShoot(sim.currentPlayer(), { yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.45 });

  const cue = ballPos(sim, null);
  assert.ok(cue, 'the cue ball must still exist after a scratch');
  assert.ok(cue.y > 0, `the cue ball must be back on the felt, not down a pocket (y=${cue.y})`);
  assert.ok(Math.abs(cue.x) < 1.3 && Math.abs(cue.z) < 0.75, 'and inside the table');
});

test('phase: confirming placement after a scratch returns to aiming', async () => {
  const g = potLine(0.0, 0.6);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: { x: -0.9, z: -0.4 } } });
  sim.applyShoot(sim.currentPlayer(), { yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.45 });

  assert.equal(sim.applyPlaceConfirm(sim.currentPlayer()), true);
  assert.equal(sim.phase(), PH_AIMING);
  assert.equal(sim.game.needsBallInHand(), true, 'ball-in-hand stays set until the next shot resolves');
});

test('phase: a legal pot keeps the shooter at the table in aiming', async () => {
  const g = potLine(0.45, 0.45);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: g.target } });
  const shooter = sim.currentPlayer();
  sim.applyShoot(shooter, { yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.45 });

  assert.equal(sim.phase(), PH_AIMING);
  assert.equal(sim.currentPlayer(), shooter, 'a pot continues the turn');
});

test('phase: winning the game ends in PH_OVER', async () => {
  // Only the 9 left: potting it wins outright.
  const g = potLine(0.45, 0.45);
  const sim = await makeSim('9ball',
    { cue: g.cue, balls: { 9: g.target } },
    { remove: [1, 2, 3, 4, 5, 6, 7, 8] });
  const shooter = sim.currentPlayer();
  sim.applyShoot(shooter, { yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.45 });

  assert.equal(sim.phase(), PH_OVER);
  assert.equal(sim.game.isOver(), true);
  assert.equal(sim.game.getState().winner, shooter);
});

test('phase: no shot is accepted once the game is over', async () => {
  const g = potLine(0.45, 0.45);
  const sim = await makeSim('9ball',
    { cue: g.cue, balls: { 9: g.target } },
    { remove: [1, 2, 3, 4, 5, 6, 7, 8] });
  sim.applyShoot(sim.currentPlayer(), { yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.45 });

  assert.equal(sim.applyShoot(sim.currentPlayer(), {
    yaw: 0, pitch: 0.2, strikeX: 0, strikeY: 0, power: 0.5,
  }), false, 'PH_OVER must reject further shots');
});

test('phase: aim is only accepted from the current player while aiming', async () => {
  const sim = await makeSim('9ball', { cue: { x: -0.6, z: 0 }, balls: { 1: { x: 0.3, z: 0 } } });
  const aim = { yaw: 1, pitch: 0.2, strikeX: 0, strikeY: 0, pullback: 0.3 };
  assert.equal(sim.applyAim(sim.currentPlayer(), aim), true);
  assert.equal(sim.applyAim(1 - sim.currentPlayer(), aim), false);
  assert.deepEqual(sim.currentAim(), aim);
});

test('phase: a new game resets the phase and the ball set', async () => {
  const g = potLine(0.45, 0.45);
  const sim = await makeSim('9ball', { cue: g.cue, balls: { 1: g.target } });
  sim.applyShoot(sim.currentPlayer(), { yaw: g.yaw, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.45 });
  assert.equal(sim.balls.length, 9, 'the 1 went down');

  sim.newGame();
  assert.equal(sim.balls.length, 10, 'a fresh rack restores every ball');
  assert.equal(sim.phase(), PH_PLACING, 'and re-enters the break placement');
  assert.equal(sim.game.isOver(), false);
  assert.equal(sim.currentPlayer(), 0);
});
