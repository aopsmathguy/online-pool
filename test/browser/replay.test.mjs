// test/browser/replay.test.mjs — the replay/resume path, in a real browser.
//
// Every scenario here is a bug that actually shipped and was reported, plus the
// invariant that ties them together: while a replay is on screen the client is
// showing the PAST, so a packet describing the PRESENT must never be applied.
// The client raises `state-during-replay:<packet>` into window.__errors if that
// is ever violated (see liveOnly in main.js), and every test below asserts it
// stayed silent — so a regression fails here rather than being noticed by a
// player weeks later.
//
// Run with: npm run test:browser
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launch, haveChrome, sleep, CHROME } from './driver.mjs';

const skip = !haveChrome() && `Chrome not found at ${CHROME} (set CHROME=/path/to/chrome)`;

// State the tests read out of the page. One expression, so every assertion sees
// a consistent snapshot rather than a torn read across several evaluates.
const SNAP = `(() => { try { return JSON.stringify({
  inGame:   window.__net.me().inGame,
  turn:     (window.__net.state()||{}).current,
  interact: (window.__net.state()||{}).interact,
  message:  (window.__net.state()||{}).message,
  pocketed: (window.__net.state()||{}).pocketed || [],
  numbers:  window.__ballIds().map(b=>b.number).filter(n=>n!=null).sort((a,b)=>a-b),
  playing:  window.__replay().playing,
  pending:  window.__replay().pending,
  reviewShots: window.__reviewHistory().length,
  watched:  (JSON.parse(sessionStorage.getItem('poolSession')||'{}').shotIndex) ?? 0,
  errors:   window.__errors,
}); } catch (e) { return null; } })()`;

// Snapshot, waiting out a page that is mid-reload.
async function snap(b) {
  const raw = await b.waitFor(SNAP, { what: 'the page to expose its state' });
  return JSON.parse(raw);
}

// THE invariant: no present-tense state was ever APPLIED while a replay was on
// screen. `state-deferred:` entries are the client correctly refusing an early
// packet and holding it — expected on the racy edge, and not a failure. A
// `state-during-replay:` entry would mean one got through, which is the bug
// class these tests exist for.
function assertInvariant(s, when) {
  const applied = (s.errors || []).filter(e => String(e).startsWith('state-during-replay'));
  assert.deepEqual(applied, [], `state APPLIED during a replay (${when}): ${applied.join(', ')}`);
}

// Anything unexpected in window.__errors (deferrals are expected and benign).
const realErrors = (errs) => (errs || []).filter(e => !String(e).startsWith('state-deferred:'));

describe('replay + resume', { skip }, () => {
  let b;
  before(async () => { b = await launch({ query: '?bot' }); }, { timeout: 60_000 });
  after(async () => { if (b) await b.close(); });

  test('a shot is on screen before its outcome is', async () => {
    await b.waitFor(`window.__net.me().inGame`, { what: 'game to start' });
    await b.evaluate(`window.__net.socket.emit('placeConfirm', {})`);
    await b.waitFor(`(window.__net.state()||{}).interact === 0`, { what: 'aiming' });

    const before = await snap(b);
    await b.evaluate(`window.__net.socket.emit('shoot', {yaw:0.05,pitch:0.06,strikeX:0,strikeY:0,power:0.85})`);
    await b.waitFor(`window.__replay().playing`, { what: 'the replay to start' });

    // Mid-replay the HUD must still read the PRE-shot state.
    const during = await snap(b);
    assert.equal(during.message, before.message,
      'the HUD changed while the shot was still being watched — the outcome was spoiled');
    assertInvariant(during, 'during a live replay');

    await b.waitFor(`!window.__replay().playing`, { timeout: 40_000, what: 'the replay to finish' });
    const after = await snap(b);
    assert.notEqual(after.message, before.message, 'the outcome never landed');
    assertInvariant(after, 'after a live replay');
  }, { timeout: 90_000 });

  test('reloading mid-replay shows the pocketed ball being pocketed', async () => {
    // THE reported bug: reload part-way through a shot that pots, and the ball
    // was already gone and already listed as potted before the replay ran.
    //
    // Arm on any shot that pockets something, then reload only while it is
    // BOTH on screen and unwatched — otherwise there is no backlog on resume
    // and the test proves nothing.
    // A fresh rack, broken hard by us: a break pots something far more often
    // than fouling and hoping the bot obliges, and it needs no shared state
    // from earlier tests. Retry on a new rack if a break happens not to pot.
    let caught = null;
    for (let round = 0; round < 4 && !caught; round++) {
      await b.freshGame();
      await b.evaluate(`
        window.__armed = null;
        window.__net.socket.on('shotAnim', (a) => {
          if (!a.history && a.removals && a.removals.length) {
            window.__armed = { index: a.index, id: a.removals[0].id };
          }
        });
        window.__net.socket.emit('placeConfirm', {});
      `);
      await sleep(500);
      await b.evaluate(`window.__net.socket.emit('shoot', {yaw:0.02,pitch:0.06,strikeX:0,strikeY:0,power:0.825})`);
      for (let i = 0; i < 120 && !caught; i++) {
        await sleep(200);
        caught = await b.evaluate(`(() => {
          const a = window.__armed;
          if (!a || !window.__replay().playing) return null;
          const w = (JSON.parse(sessionStorage.getItem('poolSession')||'{}').shotIndex) ?? 0;
          if (w > a.index) return null;              // already watched: no backlog would follow
          const ball = window.__ballIds().find(x => x.id === a.id);
          if (!ball) return null;
          return JSON.stringify({ ...a, number: ball.number });
        })()`);
      }
    }
    assert.ok(caught, 'never caught a potting shot mid-replay to reload into');
    const { number } = JSON.parse(caught);

    await b.reload();   // returns only once the NEW document is running

    // Sample in the SAME expression that checks `playing`. Checking first and
    // snapshotting after leaves a gap the replay can finish inside — which
    // silently turns this test into one that proves nothing.
    const during = JSON.parse(await b.waitFor(
      `(() => { try { return window.__replay().playing ? ${SNAP} : null; } catch (e) { return null; } })()`,
      { timeout: 40_000, what: 'a snapshot taken while the resumed backlog is playing' }));
    assert.ok(during.numbers.includes(number),
      `ball ${number} had no mesh at the start of the replay that pockets it`);
    assert.ok(!during.pocketed.includes(number),
      `ball ${number} was listed as potted before the replay showed it going in`);
    assertInvariant(during, 'during a resumed backlog');

    await b.waitFor(`!window.__replay().playing`, { timeout: 60_000, what: 'the backlog to drain' });
    const after = await snap(b);
    const ctx = `ball=${number} after=${JSON.stringify(after)} menuMsg=`
      + `"${await b.evaluate(`document.getElementById('menuMsg').textContent`)}" `
      + `serverTail=${JSON.stringify(b.serverLog.slice(-4))}`;
    assert.ok(!after.numbers.includes(number), `ball ${number} should be off the table now ${ctx}`);
    assert.ok(after.pocketed.includes(number), `ball ${number} should be in the pocketed column now ${ctx}`);
    assertInvariant(after, 'after a resumed backlog');
  }, { timeout: 240_000 });

  test('the review list survives a reload, as labels, fetched on demand', async () => {
    await b.waitFor(`window.__reviewHistory().length > 0`,
      { timeout: 30_000, what: 'shots to accumulate in the review list' });
    await b.waitFor(`!window.__replay().playing`, { timeout: 60_000, what: 'the table to settle' });
    const before = await snap(b);

    await b.reload();
    await b.waitFor(`window.__net.me().inGame`, { timeout: 40_000, what: 'the game to resume' });
    await b.waitFor(`window.__reviewHistory().length > 0`, { timeout: 20_000, what: 'the review list' });
    await b.waitFor(`!window.__replay().playing`, { timeout: 60_000, what: 'any backlog to drain' });

    const after = await snap(b);
    assert.ok(after.reviewShots >= before.reviewShots,
      `review list shrank across a reload: ${before.reviewShots} -> ${after.reviewShots}`);

    // Restored entries are labels only until opened — that is what keeps a
    // reconnect from pushing a megabyte of recordings.
    const held = await b.evaluate(`window.__reviewHistory().filter(h => h.anim).length`);
    assert.ok(held < after.reviewShots,
      'every restored shot already held its recording; history is being pushed, not fetched');

    // Opening one pulls it and plays.
    await b.evaluate(`
      const s = document.getElementById('replaySelect');
      s.value = '0'; s.dispatchEvent(new Event('change'));
    `);
    await b.waitFor(`window.__reviewHistory()[0].anim != null`,
      { timeout: 20_000, what: 'the recording to be fetched' });
    assert.ok(await b.evaluate(`!document.getElementById('replayBar').classList.contains('hidden')`),
      'the replay bar should be up while reviewing');
    assert.ok(await b.evaluate(`document.body.classList.contains('reviewing')`),
      'body.reviewing should be set so the bottom controls lift clear');

    // And stepping walks one recorded keyframe.
    const t0 = await b.evaluate(`document.getElementById('replayTime').textContent`);
    await b.evaluate(`document.getElementById('replayStepFwd').click()`);
    const t1 = await b.evaluate(`document.getElementById('replayTime').textContent`);
    assert.notEqual(t0, t1, 'stepping did not move the playhead');
    assert.match(t1, /^0\.016/, `a step should advance exactly one 16ms frame, got ${t1}`);

    await b.evaluate(`document.getElementById('replayExit').click()`);
    assert.ok(await b.evaluate(`document.getElementById('replayBar').classList.contains('hidden')`),
      'the replay bar should be gone after exiting');
    assertInvariant(await snap(b), 'after reviewing');
  }, { timeout: 180_000 });

  test('the cue ball does not move between shots and the next strike', async () => {
    // Regression: every shot's `post` carries a `placing` packet whether or not
    // the game is placing, and an inactive one still reports coordinates --
    // placingPacket sends sim.placePos, which keeps the LAST ball-in-hand
    // position long after it means anything. Honouring that moved the cue ball
    // to a stale spot after every shot: you aimed from the wrong place, and the
    // shot's own frames put it back, reading as a teleport at the strike. It
    // made aiming impossible, and nothing else here saw it.
    //
    // Checked across ANY shot rather than only my own: the invariant is that
    // the ball at rest is where the next recording starts it, whoever is
    // shooting. Waiting for my turn would also be slow -- the bot can run the
    // table for a while.
    const cuePos = `(() => { const c = window.__cuePos(); return c ? {x:+c.x.toFixed(4), z:+c.z.toFixed(4)} : null; })()`;
    await b.freshGame();   // don't inherit a finished game from an earlier test

    for (let n = 0; n < 3; n++) {
      // Settle in AIMING specifically. Ball-in-hand legitimately moves the cue
      // ball anywhere on the table, so comparing across a placement measures a
      // real move and fails on correct behaviour — which is exactly what an
      // earlier version of this test did, reporting a 1.4m "jump" that was the
      // bot placing after a foul. Once someone is aiming, nothing may move the
      // ball until their shot starts.
      await b.waitFor(`!window.__replay().playing && (window.__net.state()||{}).interact === 0 && !!window.__cuePos()`,
        { timeout: 120_000, what: 'someone to be aiming with the table settled' });
      const settled = await b.evaluate(cuePos);

      // Nudge things along if it is my turn; otherwise the bot will shoot.
      await b.evaluate(`(() => {
        const s = window.__net.state() || {};
        if (s.current !== 0) return;
        if (s.interact === 2) { window.__net.socket.emit('placeConfirm', {}); return; }
        if (s.interact === 0) window.__net.socket.emit('shoot', {yaw:${0.7 + n},pitch:0.06,strikeX:0,strikeY:0,power:0.45});
      })()`);

      await b.waitFor(`window.__replay().playing`, { timeout: 90_000, what: 'the next shot to start' });
      const atStrike = await b.evaluate(cuePos);
      const drift = Math.hypot(atStrike.x - settled.x, atStrike.z - settled.z);
      assert.ok(drift < 0.01,
        `cue ball jumped ${drift.toFixed(4)}m between resting and the next strike `
        + `(${JSON.stringify(settled)} -> ${JSON.stringify(atStrike)}) — it is not where you aim from`);
    }
  }, { timeout: 240_000 });

  test('New Game racks a fresh table instead of restoring the old one', async () => {
    // THE reported bug: press New Game and the previous game is still on screen.
    //
    // The client DID build the new rack from startGame's layout. What undid it
    // was the gameState that follows: broadcastPhase sends state with NO ball
    // packet, and the timeline's stored `live.balls` survived reset(), so the
    // first render of the new rack synced it straight back to the old game's
    // positions. Scatter the table first — a fresh rack is tightly clustered, so
    // "did the old table come back" is visible in the ball spread alone.
    const spread = `(() => {
      const bs = window.__ballIds().filter(b => b.id !== 0);
      if (!bs.length) return null;
      const mx = bs.reduce((a,b) => a+b.x, 0)/bs.length;
      const mz = bs.reduce((a,b) => a+b.z, 0)/bs.length;
      return +Math.sqrt(bs.reduce((a,b) => a + (b.x-mx)**2 + (b.z-mz)**2, 0)/bs.length).toFixed(4);
    })()`;

    await b.freshGame();
    const racked = await b.evaluate(spread);

    await b.evaluate(`window.__net.socket.emit('placeConfirm', {})`);
    await b.waitFor(`(window.__net.state()||{}).interact === 0`, { what: 'aiming' });
    await b.evaluate(`window.__net.socket.emit('shoot', {yaw:0.05,pitch:0.06,strikeX:0,strikeY:0,power:1})`);
    // Wait for the replay to START before waiting for it to end: `!playing` is
    // trivially true in the gap before it begins, so the two waits collapse and
    // the spread gets measured on the un-broken rack.
    await b.waitFor(`window.__replay().playing`, { timeout: 90_000, what: 'the break to start' });
    await b.waitFor(`!window.__replay().playing && !!window.__cuePos()`,
      { timeout: 90_000, what: 'the break to finish' });
    const broken = await b.evaluate(spread);
    assert.ok(broken > racked * 1.5,
      `the break did not scatter the rack (${racked} -> ${broken}); the test cannot tell the racks apart`);

    // The real button, not a synthetic emit — this is the path players take.
    await b.evaluate(`document.getElementById('btnNewGame').click()`);
    await b.waitFor(`(window.__net.state()||{}).interact === 2`,
      { timeout: 40_000, what: 'the new game to open in placement' });
    // Let the gameState that follows startGame land: the regression happens on
    // that packet, not on startGame itself, so asserting too early passes even
    // when broken.
    await sleep(600);

    const after = await snap(b);
    const reracked = await b.evaluate(spread);
    assert.ok(reracked < racked * 1.5,
      `New Game left the old game's spread on screen (${reracked}, fresh rack is ~${racked})`);
    assert.deepEqual(after.pocketed, [], 'the new game inherited the old pocketed set');
    assert.equal(after.numbers.length, 15, 'the new rack is missing balls');
    assert.equal(after.reviewShots, 0, 'the previous rack\'s shots survived into the new one');
    assertInvariant(after, 'after starting a new game');
  }, { timeout: 180_000 });

  test('the page reported no errors throughout', async () => {
    const s = await snap(b);
    const errs = realErrors(s.errors);
    assert.deepEqual(errs, [], `page errors: ${errs.join(' | ')}`);
    // Console too: socketUtility swallows handler throws and logs them as
    // "Packet doesn't fit schema", so window.onerror never sees them. A
    // ReferenceError in a packet handler leaves no other trace.
    const problems = b.consoleProblems();
    assert.deepEqual(problems, [], `console problems: ${problems.join(' | ')}`);
  });
});
