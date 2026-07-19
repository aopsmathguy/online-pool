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
    await b.evaluate(`
      window.__armed = null;
      window.__net.socket.on('shotAnim', (a) => {
        if (!a.history && a.removals && a.removals.length) {
          window.__armed = { index: a.index, id: a.removals[0].id };
        }
      });
    `);

    let caught = null;
    for (let round = 0; round < 8 && !caught; round++) {
      // Foul on purpose so the bot takes the table and runs shots.
      await b.evaluate(`window.__armed = null;
        window.__net.socket.emit('shoot', {yaw:3.14,pitch:0.06,strikeX:0,strikeY:0,power:0.12})`);
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
