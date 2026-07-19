// test/ai.test.js — the shot chooser, with no physics engine in sight.
//
// This file deliberately imports ai.js STATICALLY and never calls bootAmmo().
// If it runs at all, the AI is genuinely decoupled: no Ammo, no world, no
// RoomSim, no rules object. That was not true before readTable() — the AI read
// Ammo transforms off sim.balls, reached into sim.placeBounds, and called
// sim.game.getState() — and it is the property most likely to quietly regress,
// because reintroducing one `sim.` reach would still pass every other test.
//
// Keep it Ammo-free. If this file ever needs the harness, the decoupling is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBotShot, computeBotPlacement } from '../src/server/ai.js';
import { tableW, tableH, R } from '../src/shared/constants.js';

// Build a table snapshot by hand — exactly the shape RoomSim.readTable() emits.
function table({ cue, balls = {}, legalTargets, isBreak = false, phase = 0 }) {
  const list = [{ id: 0, number: null, x: cue.x, z: cue.z }];
  let id = 1;
  for (const [num, pos] of Object.entries(balls)) {
    list.push({ id: id++, number: Number(num), x: pos.x, z: pos.z });
  }
  return {
    balls: list,
    placeBounds: {
      minX: -(tableW / 2 - 2 * R), maxX: tableW / 2 - 2 * R,
      minZ: -(tableH / 2 - 2 * R), maxZ: tableH / 2 - 2 * R,
    },
    phase,
    isBreak,
    legalTargets: legalTargets ?? Object.keys(balls).map(Number),
  };
}

const isShot = (s) => s && ['yaw', 'pitch', 'strikeX', 'strikeY', 'power']
  .every(k => typeof s[k] === 'number' && Number.isFinite(s[k]));

test('ai: produces a well-formed shot from a plain snapshot', () => {
  const shot = computeBotShot(table({
    cue: { x: -0.6, z: 0 }, balls: { 1: { x: 0.3, z: 0.1 } },
  }), 1.0);
  assert.ok(isShot(shot), `malformed shot: ${JSON.stringify(shot)}`);
  assert.ok(shot.power > 0 && shot.power <= 1, `power out of range: ${shot.power}`);
  assert.ok(shot.pitch >= 0, `negative pitch: ${shot.pitch}`);
  assert.ok(Math.abs(shot.strikeX) <= 1 && Math.abs(shot.strikeY) <= 1, 'english out of range');
});

test('ai: aims roughly at the only legal ball', () => {
  const cue = { x: -0.6, z: 0 }, target = { x: 0.3, z: 0 };
  const shot = computeBotShot(table({ cue, balls: { 1: target, 5: { x: -0.2, z: 0.4 } }, legalTargets: [1] }), 1.0);
  const direct = Math.atan2(target.z - cue.z, target.x - cue.x);
  // Not exact: the bot aims at a ghost ball offset toward its chosen pocket.
  const diff = Math.abs(Math.atan2(Math.sin(shot.yaw - direct), Math.cos(shot.yaw - direct)));
  assert.ok(diff < 0.6, `aimed ${diff} rad off the only legal ball`);
});

test('ai: breaks at its maximum power', () => {
  // MAX_POWER is 0.825 in ai.js — the client's PULLBACK_MAX, not 1.0.
  const MAX_POWER = 0.825;
  const rack = { 1: { x: 0.3, z: 0 }, 2: { x: 0.35, z: 0.03 }, 3: { x: 0.35, z: -0.03 } };
  const cue = { x: -0.6, z: 0 };

  const breakShot = computeBotShot(table({ cue, balls: rack, isBreak: true }), 1.0);
  assert.ok(isShot(breakShot));
  assert.ok(Math.abs(breakShot.power - MAX_POWER) < 1e-9,
    `break should use the full cap ${MAX_POWER}, got ${breakShot.power}`);

  // And it is genuinely harder than a routine pot from the same position.
  const potShot = computeBotShot(table({ cue, balls: { 1: rack[1] }, legalTargets: [1] }), 1.0);
  assert.ok(breakShot.power > potShot.power,
    `break (${breakShot.power}) should be harder than a pot (${potShot.power})`);
});

test('ai: still returns a shot when nothing is potable', () => {
  // Legal ball tucked behind another, no open line: must fall through to a
  // safety or a kick rather than returning null.
  const shot = computeBotShot(table({
    cue: { x: -0.9, z: 0 },
    balls: { 1: { x: 0.5, z: 0 }, 2: { x: 0.4, z: 0 }, 3: { x: 0.3, z: 0 } },
    legalTargets: [1],
  }), 1.0);
  assert.ok(isShot(shot), 'the AI must always produce something to play');
});

test('ai: an empty table does not crash the chooser', () => {
  const shot = computeBotShot(table({ cue: { x: 0, z: 0 }, balls: {}, legalTargets: [] }), 1.0);
  assert.ok(isShot(shot), 'expected a well-formed fallback shot');
});

test('ai: difficulty is respected at both extremes', () => {
  const t = table({ cue: { x: -0.6, z: 0 }, balls: { 1: { x: 0.3, z: 0 } } });
  for (const d of [0, 0.5, 1]) {
    assert.ok(isShot(computeBotShot(t, d)), `difficulty ${d} produced a malformed shot`);
  }
});

test('ai: placement lands inside the bounds and clear of every ball', () => {
  const t = table({
    cue: { x: -0.6, z: 0 },
    balls: { 1: { x: 0.3, z: 0 }, 2: { x: -0.2, z: 0.25 }, 9: { x: 0.6, z: -0.3 } },
    legalTargets: [1],
  });
  const pos = computeBotPlacement(t);
  assert.ok(pos, 'expected a placement');
  const pb = t.placeBounds;
  assert.ok(pos.x >= pb.minX && pos.x <= pb.maxX, `x=${pos.x} outside bounds`);
  assert.ok(pos.z >= pb.minZ && pos.z <= pb.maxZ, `z=${pos.z} outside bounds`);
  for (const b of t.balls.slice(1)) {
    assert.ok(Math.hypot(b.x - pos.x, b.z - pos.z) >= 2 * R,
      `placed overlapping ball ${b.number}`);
  }
});

test('ai: placement respects a restricted (behind-the-line) box', () => {
  const t = table({
    cue: { x: -0.6, z: 0 },
    balls: { 1: { x: 0.3, z: 0 }, 2: { x: 0.5, z: 0.2 } },
    legalTargets: [1],
  });
  t.placeBounds.maxX = -tableW / 4;            // kitchen only, as on the break
  const pos = computeBotPlacement(t);
  assert.ok(pos, 'expected a placement');
  assert.ok(pos.x <= t.placeBounds.maxX + 1e-9, `placed at x=${pos.x}, past the head string`);
});
