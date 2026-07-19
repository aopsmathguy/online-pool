// test/rules.test.js — shot resolution for both rulesets.
//
// Pure: no Ammo, no physics, no world. A "shot" is just the event bundle the
// sim's contact scanner would have recorded, so these run instantly and cover
// the branch matrix that a physics-driven test never reliably reaches (an
// illegal break, a ball driven off the table, the 8 pocketed on a foul).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/shared/game.js';

// A table is just objects with `number` — that's all the rules read.
const table = (...numbers) => numbers.map(n => ({ number: n }));
const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
const STRIPES = [9, 10, 11, 12, 13, 14, 15];

// Build a game, force match state, feed one shot's events, resolve.
//   setup   mutates the match before the shot (phase, groups, current)
//   events  { isBreak, firstHit, rails, pocketed, cueScratch, offTable }
function play(rulesetId, balls, setup, events = {}) {
  const game = createGame(rulesetId, balls);
  const match = game.getState();
  match.phase = 'play';
  if (setup) setup(match);

  game.beginShot(!!events.isBreak);
  if (events.firstHit != null) game.recordFirstHit(events.firstHit);
  for (const n of events.rails || []) game.recordRail(n);
  for (const n of events.pocketed || []) {
    game.recordPocket(n);
    // Mirror what the sim does: a pocketed ball leaves the live array, which is
    // what countGroupRemaining / lowestOnTable read.
    const i = balls.findIndex(b => b.number === n);
    if (i >= 0) balls.splice(i, 1);
  }
  if (events.cueScratch) game.recordCueScratch();
  for (const n of events.offTable || []) game.recordOffTable(n);

  const result = game.endShot();
  return { result, match, game };
}

// A legal-looking shot skeleton: contacted `hit`, something reached a rail.
const legal = (hit, extra = {}) => ({ firstHit: hit, rails: [hit], ...extra });

// ---- 8-ball ---------------------------------------------------------------

test('8ball: scratch is a foul and passes the turn with ball in hand', () => {
  const { result, match } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(1, { cueScratch: true }));
  assert.equal(result.foul, true);
  assert.equal(result.turnPasses, true);
  assert.equal(match.current, 1);
  assert.equal(match.ballInHand, true);
  assert.match(result.reason, /Scratch/);
});

test('8ball: hitting nothing is a foul', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    { firstHit: null, rails: [] });
  assert.equal(result.foul, true);
  assert.match(result.reason, /No ball contacted/);
});

test('8ball: contact with no rail and nothing pocketed is a foul', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    { firstHit: 1, rails: [] });
  assert.equal(result.foul, true);
  assert.match(result.reason, /No ball reached a rail/);
});

test('8ball: hitting the wrong group first is a foul', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(9));
  assert.equal(result.foul, true);
  assert.match(result.reason, /Must hit a solid first/);
});

test('8ball: driving a ball off the table is a foul', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(1, { offTable: [3] }));
  assert.equal(result.foul, true);
  assert.match(result.reason, /off the table/);
});

test('8ball: pocketing your own ball keeps you at the table', () => {
  const { result, match } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(1, { pocketed: [1] }));
  assert.equal(result.foul, false);
  assert.equal(result.turnPasses, false);
  assert.equal(match.current, 0);
});

test('8ball: a legal miss passes the turn without ball in hand', () => {
  const { result, match } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(1));
  assert.equal(result.foul, false);
  assert.equal(result.turnPasses, true);
  assert.equal(match.current, 1);
  assert.equal(match.ballInHand, false);
});

test('8ball: an open table assigns groups on the first legal pocket', () => {
  const { match } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.phase = 'open'; },
    legal(9, { pocketed: [9] }));
  assert.equal(match.phase, 'play');
  assert.equal(match.players[0].group, 'stripe');
  assert.equal(match.players[1].group, 'solid');
});

test('8ball: pocketing one of each on an open table leaves it open', () => {
  const { match } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.phase = 'open'; },
    legal(1, { pocketed: [1, 9] }));
  assert.equal(match.phase, 'open');
  assert.equal(match.players[0].group, null);
});

test('8ball: hitting the 8 first on an open table is a foul', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.phase = 'open'; },
    legal(8));
  assert.equal(result.foul, true);
  assert.match(result.reason, /8-ball on an open table/);
});

test('8ball: sinking the 8 early loses the game', () => {
  const { result, match } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(1, { pocketed: [8] }));
  assert.equal(result.over, true);
  assert.equal(result.winner, 1, 'opponent wins');
  assert.equal(match.phase, 'over');
});

test('8ball: sinking the 8 with the group cleared wins', () => {
  // Only the 8 and the opponent's stripes remain → shooter was on the 8.
  const { result, match } = play('8ball', table(8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(8, { pocketed: [8] }));
  assert.equal(result.over, true);
  assert.equal(result.winner, 0, 'shooter wins');
  assert.equal(match.phase, 'over');
});

test('8ball: sinking the 8 on the group-clearing shot but with a foul loses', () => {
  const { result } = play('8ball', table(8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(8, { pocketed: [8], cueScratch: true }));
  assert.equal(result.over, true);
  assert.equal(result.winner, 1);
});

test('8ball: knocking the 8 off the table loses', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(1, { offTable: [8] }));
  assert.equal(result.over, true);
  assert.equal(result.winner, 1);
});

test('8ball: once on the 8, hitting anything else first is a foul', () => {
  const { result } = play('8ball', table(8, ...STRIPES),
    m => { m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    legal(9));
  assert.equal(result.foul, true);
  assert.match(result.reason, /Must hit the 8-ball first/);
});

test('8ball: a break that neither pockets nor drives 4 to a rail is a foul', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.phase = 'break'; },
    { isBreak: true, firstHit: 1, rails: [1, 2, 3] });
  assert.equal(result.foul, true);
  assert.match(result.reason, /Illegal break/);
});

test('8ball: a break driving 4 balls to a rail is legal and opens the table', () => {
  const { result, match } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.phase = 'break'; },
    { isBreak: true, firstHit: 1, rails: [1, 2, 3, 4] });
  assert.equal(result.foul, false);
  assert.equal(match.phase, 'open');
  assert.equal(match.current, 1, 'no pocket on the break → turn passes');
});

test('8ball: any first contact is legal on the break', () => {
  const { result } = play('8ball', table(...SOLIDS, 8, ...STRIPES),
    m => { m.phase = 'break'; },
    { isBreak: true, firstHit: 8, rails: [1, 2, 3, 4] });
  assert.equal(result.foul, false, 'hitting the 8 first on the break is not a foul');
});

// ---- 9-ball ---------------------------------------------------------------

test('9ball: hitting anything but the lowest ball is a foul', () => {
  const { result } = play('9ball', table(1, 2, 3, 9), null, legal(2));
  assert.equal(result.foul, true);
  assert.match(result.reason, /Must hit the 1 first/);
});

test('9ball: hitting the lowest ball and reaching a rail is legal', () => {
  const { result, match } = play('9ball', table(1, 2, 3, 9), null, legal(1));
  assert.equal(result.foul, false);
  assert.equal(result.turnPasses, true, 'nothing pocketed → turn passes');
  assert.equal(match.current, 1);
});

test('9ball: pocketing any ball on a legal shot continues the turn', () => {
  const { result, match } = play('9ball', table(1, 2, 3, 9), null,
    legal(1, { pocketed: [3] }));
  assert.equal(result.foul, false);
  assert.equal(result.turnPasses, false);
  assert.equal(match.current, 0);
});

test('9ball: sinking the 9 on a legal shot wins', () => {
  const { result, match } = play('9ball', table(1, 2, 3, 9), null,
    legal(1, { pocketed: [9] }));
  assert.equal(result.over, true);
  assert.equal(result.winner, 0);
  assert.equal(match.phase, 'over');
});

test('9ball: sinking the 9 on a foul loses', () => {
  const { result } = play('9ball', table(1, 2, 3, 9), null,
    legal(1, { pocketed: [9], cueScratch: true }));
  assert.equal(result.over, true);
  assert.equal(result.winner, 1);
});

test('9ball: the lowest-ball rule does not apply on the break', () => {
  const { result } = play('9ball', table(1, 2, 3, 9),
    m => { m.phase = 'break'; },
    { isBreak: true, firstHit: 3, rails: [1, 2, 3, 9] });
  assert.equal(result.foul, false);
});

test('9ball: driving a ball off the table is a foul', () => {
  const { result } = play('9ball', table(1, 2, 3, 9), null,
    legal(1, { offTable: [2] }));
  assert.equal(result.foul, true);
  assert.match(result.reason, /off the table/);
});

// ---- shared controller behaviour ------------------------------------------

test('endShot on a game with no shot in progress is inert', () => {
  const game = createGame('8ball', table(1, 8));
  assert.deepEqual(game.endShot(), { over: false });
});

test('a foul sets ball in hand; a clean miss does not', () => {
  const foul = play('9ball', table(1, 9), null, legal(2));
  assert.equal(foul.match.ballInHand, true);
  const clean = play('9ball', table(1, 9), null, legal(1));
  assert.equal(clean.match.ballInHand, false);
});
