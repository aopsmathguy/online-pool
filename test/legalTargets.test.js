// test/legalTargets.test.js — equivalence net for moving legalTargets out of
// the AI and into the ruleset interface (Phase 3).
//
// `legalTargetNumbers` in src/server/ai.js is private, so REFERENCE below is a
// frozen line-for-line copy of it as it stood before the move. Every case is
// asserted against both the reference and the ruleset method, so the extraction
// is provably identical rather than hopefully identical. Once the ruleset
// method is in place and green, the copy in ai.js is deleted and REFERENCE
// stays here as the record of what the behaviour was.
//
// NOTE ON STRICTNESS: both implementations are deliberately stricter than the
// resolvers on the break — 8-ball's resolver allows any first contact and
// 9-ball's skips the lowest-ball check, while these return "anything but the 8"
// and "the lowest" respectively. That is correct for this consumer: it feeds a
// shot-CHOOSER, which wants targets that are safe under every branch, not a
// legality judge. Keeping it makes the move a pure refactor with no change to
// how the bot plays. Do not "fix" it without re-baselining bot behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/shared/game.js';
import { groupOf } from '../src/shared/rules/eightball.js';

// --- Frozen copy of src/server/ai.js :: legalTargetNumbers (pre-Phase 3) ----
function REFERENCE(match, rulesetId) {
  const m = match;
  const onTable = m.balls.filter(b => b.number != null).map(b => b.number);
  if (rulesetId === '9ball') {
    return onTable.length ? [Math.min(...onTable)] : [];
  }
  // 8-ball
  if (m.phase === 'play') {
    const grp = m.players[m.current].group;
    const mine = onTable.filter(n => groupOf(n) === grp);
    return mine.length ? mine : onTable.filter(n => n === 8);   // group cleared → on the 8
  }
  // break / open table: anything but the 8 is always safe to contact first
  const open = onTable.filter(n => n !== 8);
  return open.length ? open : onTable;
}

const table = (...numbers) => numbers.map(n => ({ number: n }));
const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
const STRIPES = [9, 10, 11, 12, 13, 14, 15];
const sorted = (a) => [...a].sort((x, y) => x - y);

const CASES = [
  {
    name: '8ball: break — everything but the 8',
    ruleset: '8ball', balls: table(...SOLIDS, 8, ...STRIPES),
    setup: m => { m.phase = 'break'; },
    expect: sorted([...SOLIDS, ...STRIPES]),
  },
  {
    name: '8ball: open table — everything but the 8',
    ruleset: '8ball', balls: table(...SOLIDS, 8, ...STRIPES),
    setup: m => { m.phase = 'open'; },
    expect: sorted([...SOLIDS, ...STRIPES]),
  },
  {
    name: '8ball: play, solids — own group only',
    ruleset: '8ball', balls: table(...SOLIDS, 8, ...STRIPES),
    setup: m => { m.phase = 'play'; m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    expect: sorted(SOLIDS),
  },
  {
    name: '8ball: play, stripes as player 1',
    ruleset: '8ball', balls: table(...SOLIDS, 8, ...STRIPES),
    setup: m => { m.phase = 'play'; m.current = 1; m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    expect: sorted(STRIPES),
  },
  {
    name: '8ball: play, group cleared — on the 8',
    ruleset: '8ball', balls: table(8, ...STRIPES),
    setup: m => { m.phase = 'play'; m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    expect: [8],
  },
  {
    name: '8ball: play, partially cleared group',
    ruleset: '8ball', balls: table(3, 5, 8, ...STRIPES),
    setup: m => { m.phase = 'play'; m.players[0].group = 'solid'; m.players[1].group = 'stripe'; },
    expect: [3, 5],
  },
  {
    name: '8ball: only the 8 left on an open table falls back to the 8',
    ruleset: '8ball', balls: table(8),
    setup: m => { m.phase = 'open'; },
    expect: [8],
  },
  {
    name: '9ball: full rack — the 1',
    ruleset: '9ball', balls: table(1, 2, 3, 4, 5, 6, 7, 8, 9),
    setup: null,
    expect: [1],
  },
  {
    name: '9ball: low balls gone — the lowest remaining',
    ruleset: '9ball', balls: table(4, 6, 9),
    setup: null,
    expect: [4],
  },
  {
    name: '9ball: only the 9 left',
    ruleset: '9ball', balls: table(9),
    setup: null,
    expect: [9],
  },
  {
    name: '9ball: break — still the lowest (stricter than the resolver, on purpose)',
    ruleset: '9ball', balls: table(1, 2, 3, 9),
    setup: m => { m.phase = 'break'; },
    expect: [1],
  },
  {
    name: '9ball: empty table',
    ruleset: '9ball', balls: table(),
    setup: null,
    expect: [],
  },
];

for (const c of CASES) {
  test(`legalTargets — ${c.name}`, () => {
    const game = createGame(c.ruleset, c.balls);
    const match = game.getState();
    match.phase = 'play';
    if (c.setup) c.setup(match);

    assert.deepEqual(sorted(REFERENCE(match, c.ruleset)), c.expect,
      'the frozen reference no longer matches the expected table');

    // Present from Phase 3 onward. Until then this half is skipped, so the
    // file is useful as a spec before the implementation exists.
    if (typeof game.legalTargets === 'function') {
      assert.deepEqual(sorted(game.legalTargets()), c.expect,
        'ruleset.legalTargets diverges from the frozen reference');
    }
  });
}

test('legalTargets: every ruleset implements it (Phase 3 onward)', () => {
  for (const id of ['8ball', '9ball']) {
    const game = createGame(id, table(1, 8, 9));
    if (typeof game.legalTargets !== 'function') return;   // pre-Phase 3
    assert.ok(Array.isArray(game.legalTargets()), `${id} must return an array`);
  }
});
