// test/pitchAgreement.test.js — the bot and the server must agree on elevation.
//
// This is the invariant that let the AI's hardcoded `+ 0.01` of slop be
// deleted. The bot raises its own pitch to the clearance floor so it can stream
// a truthful aim to the human and compensate power for the elevation. If the
// server's floor then comes out even marginally HIGHER, resolveStrike silently
// raises the pitch again — after the human has already watched the cue stick
// line up — and the stick visibly snaps at the moment of the strike.
//
// The two agree only because they now call the same legalPitch() on the same
// obstacle list and the same rail sampling. Anything that re-diverges those
// inputs (a different obstacle source, a re-derived rail polyline, a stray
// epsilon) breaks this test rather than shipping a visible glitch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootAmmo, makeSim } from './helpers/simHarness.js';
import { resolveStrike } from '../src/server/strike.js';
import { densify } from '../src/shared/clearance.js';
import { railPoints } from '../src/server/table.world.js';

const { RoomSim, PH_AIMING, PH_PLACING, PH_OVER } = await bootAmmo();
const { computeBotShot, computeBotPlacement } = await import('../src/server/ai.js');

const RAIL_CLEAR = densify(railPoints);

// What pitch would the server actually play this shot at?
function serverPitch(sim, shot) {
  const cueBody = sim.balls[0].body;
  const o = cueBody.getWorldTransform().getOrigin();
  return resolveStrike(shot, {
    cue: { x: o.x(), z: o.z() },
    obstacles: sim.objectBallsXZ(),
    railPts: RAIL_CLEAR,
  }).pitch;
}

test('the server never raises a pitch the bot already legalized', () => {
  // Walk real games so the check runs against genuine mid-game layouts,
  // including the awkward ones (cue frozen on a cushion, cue behind the pack)
  // where the clearance floor actually binds.
  let checked = 0, bound = 0;

  for (const rulesetId of ['8ball', '9ball']) {
    const sim = new RoomSim(rulesetId);
    sim.newGame();

    for (let i = 0; i < 60 && sim.phase() !== PH_OVER; i++) {
      if (sim.phase() === PH_PLACING) {
        const pos = computeBotPlacement(sim);
        if (pos) sim.applyPlaceMove(sim.currentPlayer(), pos.x, pos.z);
        sim.applyPlaceConfirm(sim.currentPlayer());
        continue;
      }
      if (sim.phase() !== PH_AIMING) break;

      const shot = computeBotShot(sim, 1.0);
      const played = serverPitch(sim, shot);
      assert.ok(played <= shot.pitch + 1e-12,
        `server raised the bot's pitch from ${shot.pitch} to ${played} — the stick will snap`);
      if (played > 0.0601) bound++;   // above the bot's 0.06 default → the floor bit
      checked++;

      sim.applyShoot(sim.currentPlayer(), shot);
    }
  }

  assert.ok(checked > 10, `only checked ${checked} shots`);
  // If the floor never binds, the test is vacuous and would pass even after a
  // regression. Fail loudly instead of quietly proving nothing.
  assert.ok(bound > 0, `the clearance floor never bound across ${checked} shots — test is vacuous`);
});

test('a cue ball frozen on the cushion forces elevation, and both sides agree', async () => {
  // Cue hard against the right cushion, shooting back up the table: the stick
  // extends out over the rail, so the floor must lift it.
  const sim = await makeSim('9ball', { cue: { x: 1.05, z: 0 }, balls: { 1: { x: 0.2, z: 0 } } });
  const shot = computeBotShot(sim, 1.0);

  assert.ok(shot.pitch > 0.06, `expected the floor to raise the pitch, got ${shot.pitch}`);
  assert.ok(Math.abs(serverPitch(sim, shot) - shot.pitch) <= 1e-12,
    'the server and the bot disagree about the elevation floor');
});
