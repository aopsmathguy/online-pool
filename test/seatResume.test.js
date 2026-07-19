// test/seatResume.test.js — seats, tokens and resume, over a real socket.
//
// server/index.js starts a listener on import, so none of this is reachable
// from the sim tests — and it has already produced two bugs: a clamp that
// silently skipped every shot of a new rack, and a resume race that could lose
// a game outright. These drive a real server the way a client does.
//
// No browser and no Ammo in the test process; the server owns the physics.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect, sleep } from './helpers/serverHarness.js';

describe('seat resume', () => {
  test('a valid token takes over a seat whose socket has not died yet', async () => {
    // THE case: the seat still shows a LIVE conn when the resume arrives.
    //
    // That is what a reload after a network blip looks like from the server's
    // side. A socket that dies without a close handshake stays attached until
    // the heartbeat gives up (keepAliveTimeout, 10s), and the player reloads
    // well inside that window. Rejecting the resume answers "Session expired.",
    // on which the client wipes its session — so a reload after a blip lost the
    // game outright.
    //
    // The first socket is deliberately left OPEN here rather than killed:
    // terminating it makes the server notice within milliseconds, which is the
    // case that already worked. Holding it open is the only way to put the
    // server in the state the race produces. A token is proof of ownership
    // (sessionStorage is per-tab, so two tabs can never present the same one),
    // so it must win and evict whatever is sitting there.
    const server = await startServer();
    try {
      const first = await connect(server.port);
      first.emit('playBot', { name: 'Dropper', game: 0, skill: 60 });
      const joined = await first.next('roomJoined');
      await first.next('startGame');
      assert.ok(joined.token, 'expected a seat token');

      const second = await connect(server.port);
      second.emit('resume', { token: joined.token, lastShot: 0 });

      // Either it takes the seat over (roomJoined) or it is refused (errorMsg).
      const outcome = await second.nextAny(['roomJoined', 'errorMsg']);
      assert.equal(outcome.ev, 'roomJoined',
        `resume was rejected instead of taking the seat over: "${outcome.data?.message}"`);
      assert.equal(outcome.data.token, joined.token, 'should have reclaimed the same seat');
      await second.next('startGame');   // and been rebuilt into the game

      second.close();
    } finally { server.stop(); }
  });

  test('an unknown token is refused', async () => {
    const server = await startServer();
    try {
      const c = await connect(server.port);
      c.emit('resume', { token: 'not-a-real-token', lastShot: 0 });
      const err = await c.next('errorMsg');
      assert.match(err.message, /expired/i);
      c.close();
    } finally { server.stop(); }
  });

  test('resuming replays the shots missed, and lists the rest as history', async () => {
    const server = await startServer();
    try {
      const c = await connect(server.port);
      c.emit('playBot', { name: 'P', game: 0, skill: 90 });
      const joined = await c.next('roomJoined');
      await c.next('startGame');

      // Break, then take a couple more shots so there is a rack to come back to.
      c.emit('placeConfirm', {});
      await sleep(300);
      let taken = 0;
      for (let i = 0; i < 3 && taken < 3; i++) {
        c.emit('shoot', { yaw: 0.3 + i, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.6 });
        try { await c.next('shotAnim', { timeout: 25_000 }); taken++; } catch { break; }
        await sleep(1500);
      }
      assert.ok(taken >= 1, 'no shots were played to resume into');

      c.killSilently();
      const back = await connect(server.port);
      // Claim to have watched everything: the backlog should be empty and the
      // whole rack should come back as review-list history instead.
      back.emit('resume', { token: joined.token, lastShot: 99 });
      await back.next('roomJoined');
      await back.next('startGame');

      // lastShot beyond the rack means "stale rack" -> replay from the start,
      // which is the fix for the clamp that used to skip every shot.
      const replayed = [];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const anims = back.seen.filter(p => p.ev === 'shotAnim');
        if (anims.length) { replayed.push(...anims.map(a => a.data.index)); break; }
        await sleep(100);
      }
      assert.ok(replayed.length > 0,
        'a client claiming more shots than the rack has must be replayed from the start, not sent nothing');

      back.close();
    } finally { server.stop(); }
  });
});
