// server/index.js — centralized authoritative pool server.
//
// Serves the static client and hosts every game. Each room owns its own
// RoomSim (physics world + balls + rules). Clients only send input and render
// what the server streams. Run: `npm start` (node server/index.js).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { WebSocketServer } from 'ws';
import { SocketServer } from '../lib/socketUtility.js';
import {
  packetSchemas, LOBBY_WAITING, LOBBY_READY, gameIdFromByte, gameByteFromId, GAME_8BALL,
} from '../src/shared/net/packets.js';
import { SHOT_STRIKE_MS } from '../src/shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8731;

// ---- Load Ammo (CommonJS asm.js build) and init physics once ----------------
const require = createRequire(import.meta.url);
globalThis.Ammo = require('../lib/ammo.server.cjs');
const { initPhysics } = await import('../src/server/physics.js');
await initPhysics();
const { RoomSim, PH_PLACING, PH_AIMING } = await import('../src/server/sim.js');
const { createBotClient } = await import('../src/server/botClient.js');
const { createLoopbackPair } = await import('../src/server/loopbackSocket.js');

// ---- Static file server -----------------------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Contain within ROOT (no traversal).
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- Rooms + matchmaking ----------------------------------------------------
// room: { code, rulesetId, seats:[seat,...], sim, bot?, shotLog, shotIndex }
// seat: { token, name, conn: conn|null, timer }   — a SEAT outlives its socket
// conn: { socket, name, room, index }
//
// Seats, not sockets, are the players: a seat whose `conn` is null is a player
// who dropped and has RECONNECT_GRACE_MS to come back with their token (see
// handleDisconnect / the `resume` handler). It still counts as occupied, so
// nobody can take it in the meantime.
//
// A vs-computer room is an ORDINARY two-seat room: the bot holds seat 1 through
// a loopback socket and plays as a client (see botClient.js). `room.bot` is only
// a handle for the difficulty slider -- the game loop knows nothing about it.
//
// A room also carries `watchers`: connections with no seat, which receive every
// broadcast and send nothing that reaches the game. Only the demo table (see
// ensureDemoRoom) has any, but the plumbing is on every room because it is the
// broadcast path, not a special case.
const rooms = new Map();
const RECONNECT_GRACE_MS = 45_000;
// Shot retention. The log is the rack's memory, and it serves three things: a
// client reloading mid-replay (which reports that shot as unwatched and must be
// replayed it from the start), a returning client's catch-up backlog, and the
// shot-review list, which a reconnecting client rebuilds ENTIRELY from here —
// its own copy is dropped when it re-enters the rack.
//
// So the whole rack is kept while it is being played, not a recent window. That
// is not free: recordings run ~166 KB of JSON each (a break can hit 775 KB), so
// a full 21-shot rack is ~3.4 MB per room. The cap bounds the pathological case
// rather than the normal one — a rack that reaches it has bigger problems.
const MAX_SHOT_LOG = 60;
// Padding on the replay gate (see replayLocked). Absorbs the gap between the
// server predicting how long a client takes to watch a shot and how long it
// actually takes: packet flight time, the client's rAF cadence, and its own
// deferral queue draining. It is a fudge, not a derivation — the gate is
// wall-clock, and there is no ack. See the note on replayLocked.
const REPLAY_SLACK_MS = 250;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join(''); }
  while (rooms.has(c));
  return c;
}
function makeSeat(conn) {
  return { token: crypto.randomUUID(), name: conn.name || 'Player', conn, timer: null };
}
function names(room) { return room.seats.map(s => ({ name: s.name || 'Player' })); }
// Broadcast reaches only seats that currently hold a socket; a dropped player
// catches up from the shot log when they resume. Watchers are seatless and have
// nothing to catch up into, so they simply get whatever is sent while they look.
function broadcast(room, event, data) {
  for (const s of room.seats) if (s.conn) s.conn.socket.emit(event, data);
  emitToWatchers(room, event, data);
}
function emitToWatchers(room, event, data) {
  for (const c of room.watchers) c.socket.emit(event, data);
}
function opponentOf(conn) { const r = conn.room; return r && r.seats[1 - conn.index]; }
function emitTo(seat, event, data) { if (seat && seat.conn) seat.conn.socket.emit(event, data); }

// Publish the room's interaction state. `placing` is meaningless unless the sim
// is actually in PH_PLACING, so the two always travel together — every caller
// that changes phase goes through here rather than remembering the pair.
function broadcastPhase(room) {
  broadcast(room, 'gameState', room.sim.gameStatePacket());
  if (room.sim.phase() === PH_PLACING) broadcast(room, 'placing', room.sim.placingPacket());
}

// Is the room still inside the window where clients are watching the last shot?
//
// This is the ONLY thing stopping the next shot being accepted early. applyShoot
// resolves the whole shot synchronously, so the instant `shotAnim` leaves the
// server the sim is already back in PH_AIMING with `current` flipped — every
// guard inside applyShoot is satisfied for the opponent immediately. Honest
// clients don't race it because their own gameState is deferred behind their
// replay (the shot carries its own outcome), but the server must not rely on
// that. Centralized so no future caller can forget it; performShot checks it
// itself for the same reason.
function replayLocked(room) {
  return !!room.replayUntil && Date.now() < room.replayUntil;
}

// The room's current state, in the shape a shot's `post` carries. Used both
// when a shot resolves and when a backlog's final shot has to hand the client
// the present (see resumeSeat).
function presentPost(sim) {
  return {
    state: sim.gameStatePacket(),
    balls: sim.ballsFrame(),
    placing: sim.placingPacket(),
  };
}

// A shot as the review list sees it: enough to label the entry in the dropdown,
// without the recording that makes it heavy.
function shotMeta(s) {
  return {
    index: s.index,
    shooter: s.packet.shooter,
    pocketedBefore: s.packet.pocketedBefore,
    removals: s.packet.removals,
  };
}

// Bound the log. startMatch clears it, so this only bites on a rack that runs
// past MAX_SHOT_LOG shots; the oldest go first, and a client that resumes then
// simply sees a shorter review list.
function trimShotLog(room) {
  if (room.shotLog.length > MAX_SHOT_LOG) {
    room.shotLog.splice(0, room.shotLog.length - MAX_SHOT_LOG);
  }
}

// Bot difficulty is 0-100 on the wire, 0..1 in the sim. Both the initial
// (playBot) and live (botSkill) paths run values through THIS one clamp, so the
// difficulty the server uses is always exactly the slider value the client sent.
const toSkill = (v) => Math.max(0, Math.min(100, v | 0)) / 100;

// `announce` shows the caller the "waiting for an opponent" lobby; a vs-computer
// room skips it because the opponent arrives in the same tick. `vsBot` only
// tells the client to offer the difficulty slider — the server's game loop
// treats a bot seat exactly like a human one.
function createRoom(conn, rulesetId, isPublic = false, { announce = true, vsBot = false } = {}) {
  // isPublic rooms are the quick-play pool; private (code-shared) rooms are not
  // eligible for quick-play matching.
  const seat = makeSeat(conn);
  const room = {
    code: makeCode(), rulesetId, seats: [seat], sim: null, public: isPublic,
    shotLog: [], shotIndex: 0, watchers: new Set(),
  };
  rooms.set(room.code, room);
  conn.room = room; conn.index = 0;
  conn.socket.emit('roomJoined', { code: room.code, playerIndex: 0, game: gameByteFromId(rulesetId), host: announce, token: seat.token, bot: vsBot });
  if (announce) conn.socket.emit('lobby', { state: LOBBY_WAITING, players: names(room) });
  return room;
}

function joinRoomObj(conn, room) {
  const seat = makeSeat(conn);
  conn.room = room; conn.index = room.seats.length;
  room.seats.push(seat);
  conn.socket.emit('roomJoined', { code: room.code, playerIndex: conn.index, game: gameByteFromId(room.rulesetId), host: false, token: seat.token, bot: !!room.bot });
  broadcast(room, 'lobby', { state: LOBBY_READY, players: names(room) });
  startMatch(room);
}

function startMatch(room, changeGame) {
  if (room.seats.length < 2) return;
  if (!room.sim) room.sim = new RoomSim(room.rulesetId);
  room.replayUntil = 0;                 // a new rack cancels any pending replay gate
  room.shotLog = []; room.shotIndex = 0;   // new rack, new shot numbering
  room.sim.setPlayerNames(
    room.seats[0].name || 'Player 1',
    room.seats[1].name || 'Player 2',
  );
  const info = room.sim.newGame(changeGame);
  room.rulesetId = info.game;   // ruleset string id (e.g. '8ball')
  broadcast(room, 'startGame', {
    game: gameByteFromId(info.game), firstPlayer: info.firstPlayer, layout: info.layout,
  });
  broadcastPhase(room);
}

// Execute a shot (human or bot): the sim runs the whole thing to rest
// synchronously and returns the keyframe recording; broadcast it, then the
// already-resolved post-shot state. Clients queue those packets until their
// replay finishes; replayUntil stops the server accepting the next shot (or
// the bot deciding) while everyone is still watching.
function performShot(room, playerIdx, params) {
  if (replayLocked(room)) return false;   // belt and braces; callers check too
  // Captured BEFORE the shot resolves, for every shot: the HUD state and the
  // rack as they stood when this shot was taken. A resuming client rebuilds
  // from these — without the layout, balls pocketed during a replayed shot have
  // no mesh and appear already-gone instead of sinking.
  const pre = room.sim.gameStatePacket();
  const preLayout = room.sim.startInfo();
  const anim = room.sim.applyShoot(playerIdx, params);
  if (!anim) return false;
  // Clients play a draw-back lead-in before the recorded motion, so the window
  // everyone is still watching is that much longer than the recording itself.
  room.replayUntil = Date.now() + SHOT_STRIKE_MS + anim.durationMs + REPLAY_SLACK_MS;
  anim.packet.index = room.shotIndex++;
  // Attribution, taken from the pre-shot state: the review list needs it, and a
  // shot restored on resume has no live state to infer it from.
  anim.packet.shooter = (pre.chips[pre.current] && pre.chips[pre.current].text) || `Player ${pre.current + 1}`;
  anim.packet.pocketedBefore = pre.pocketed.slice();
  anim.packet.history = false;   // a live shot is always played, never just filed
  // The shot carries its own outcome. `balls` is the authoritative set AFTER the
  // shot resolved, which includes startPlacement having already teleported the
  // cue ball to its ball-in-hand spot — NOT the resting frame, which is the last
  // frame of the recording and is what the client shows until the replay ends.
  // The client applies all of this when playback finishes, so nothing about the
  // outcome can arrive early and nothing has to be queued.
  anim.packet.post = presentPost(room.sim);   // placing.active is false unless ball-in-hand
  room.shotLog.push({ index: anim.packet.index, packet: anim.packet, pre, preLayout });
  trimShotLog(room);
  broadcast(room, 'shotAnim', anim.packet);
  if (room.demo) maybeRerack(room);   // the demo table never stops on a win
  return true;
}

// Tear the room down for good: nobody is coming back. Used by an explicit
// "leave", by a lobby-stage drop, and by dropSeat when the grace runs out.
function destroyRoom(room, exceptConn) {
  rooms.delete(room.code);
  // Watchers are told nothing: they hold no seat, so there is no game of theirs
  // to end. They simply keep showing the last frame until they ask for another
  // table (see watchDemo) or leave the menu.
  for (const c of room.watchers) c.watching = null;
  room.watchers.clear();
  for (const seat of room.seats) {
    if (seat.timer) { clearTimeout(seat.timer); seat.timer = null; }
    const c = seat.conn;
    seat.conn = null;
    if (!c) continue;
    c.room = null;
    if (c !== exceptConn) c.socket.emit('opponentLeft', {});
  }
  room.shotLog = [];
}

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  conn.room = null;
  destroyRoom(room, conn);
}

// The grace ran out — the absent player is gone for good.
function dropSeat(room) {
  if (rooms.get(room.code) !== room) return;   // already torn down
  destroyRoom(room);
}

// A socket died. Unlike leaveRoom this HOLDS the seat: the room, its sim and
// its shot log stay alive for RECONNECT_GRACE_MS so the player can come back
// with their token and be replayed everything they missed.
function handleDisconnect(conn) {
  const room = conn.room;
  if (!room) return;
  // Nothing worth preserving before the match starts — behave as today.
  if (!room.sim) { leaveRoom(conn); return; }

  const seat = room.seats[conn.index];
  conn.room = null;
  if (!seat || seat.conn !== conn) return;     // already superseded by a resume
  seat.conn = null;
  if (seat.timer) clearTimeout(seat.timer);
  seat.timer = setTimeout(() => dropSeat(room), RECONNECT_GRACE_MS);
  emitTo(opponentOf({ room, index: conn.index }), 'opponentState',
    { connected: false, secondsLeft: Math.round(RECONNECT_GRACE_MS / 1000) });
}

// Rebuild a returning client from scratch, then replay the shots it missed.
// Every packet here already exists — this is startMatch's opening sequence plus
// the backlog from the shot log.
function resumeSeat(conn, room, seatIndex, lastShot) {
  const seat = room.seats[seatIndex];
  if (seat.timer) { clearTimeout(seat.timer); seat.timer = null; }
  seat.conn = conn;
  conn.room = room; conn.index = seatIndex; conn.name = seat.name;

  const sim = room.sim;
  conn.socket.emit('roomJoined', {
    code: room.code, playerIndex: seatIndex, game: gameByteFromId(room.rulesetId),
    host: false, token: seat.token, bot: !!room.bot,
  });
  // A client claiming to have watched MORE shots than this rack has ever had is
  // on a stale rack: it dropped during an earlier game and a newGame reset
  // shotIndex to 0 underneath it. Clamping down to shotIndex (the old
  // behaviour) yields an empty backlog and silently skips every shot of the new
  // rack. Start it from the beginning instead.
  const watched = lastShot | 0;
  const from = watched > room.shotIndex ? 0 : Math.max(0, watched);
  // Whatever we still have from `from` onward. If the window has already
  // dropped some, the client just sees fewer shots — never a broken one: each
  // replayed shot reconciles the rack from its own frame 0.
  const missed = room.shotLog.filter(s => s.index >= from);
  // Everything BEFORE that, which this client already watched. Re-entering the
  // rack clears its review list (setReviewLayout), so without these the list
  // would come back holding only the shots it missed. Sent as history: filed,
  // not played.
  const alreadyWatched = room.shotLog.filter(s => s.index < from);

  // Build the rack from the table as it stood at the start of the EARLIEST
  // retained shot, not as it stands now. Two reasons:
  //
  //  - balls sunk during the missed shots must exist as meshes so the replay
  //    can show them being pocketed;
  //  - this layout also fixes the client's id -> number map for the whole rack
  //    (setReviewLayout). Using the current ball set would drop every ball
  //    already pocketed, and the review list could no longer name what a past
  //    shot sank — "Shot 2 · Computer · sank 9" would come back as
  //    "Shot 2 · Computer".
  //
  // The trailing `balls` + `gameState` below reconcile to the present.
  const info = (room.shotLog.length && room.shotLog[0].preLayout) || sim.startInfo();
  conn.socket.emit('startGame', { game: gameByteFromId(info.game), firstPlayer: info.firstPlayer, layout: info.layout });

  // The HUD state as it stood when the backlog begins. Each shot then carries
  // its own `post`, so the top bar tracks the catch-up shot by shot on its own —
  // no interleaving of state packets with recordings, and no ordering contract
  // between this loop and the client's replay queue.
  conn.socket.emit('gameState', (missed.length && missed[0].pre) || sim.gameStatePacket());
  // Rebuild the review list from METADATA — labels only, no recordings. The
  // client fetches a recording (requestShot) if the player opens that shot.
  if (alreadyWatched.length) {
    conn.socket.emit('shotHistory', { shots: alreadyWatched.map(shotMeta) });
  }
  // The backlog, in full: these have to be played, so the client needs them.
  // Bounded by the reconnect grace — a few shots, not a rack.
  //
  // The LAST one carries the present as its `post`, and no reconcile packets
  // follow. That is not an optimisation, it is the invariant: a client applies
  // `post` when playback ENDS, but a bare balls/gameState the moment it lands.
  // Sending the current state alongside a backlog would delete the very ball
  // the client is about to watch being pocketed, and list it as already potted,
  // while the replay is still running. State only reaches a replaying client
  // through the shot it belongs to.
  //
  // Overriding the tail's own post (rather than appending) also picks up
  // anything that moved after the last shot — a placement drag, say.
  missed.forEach((s, i) => {
    const isLast = i === missed.length - 1;
    conn.socket.emit('shotAnim', isLast ? { ...s.packet, post: presentPost(sim) } : s.packet);
  });

  // No backlog: nothing is going to play, so the present can be sent directly.
  if (!missed.length) {
    conn.socket.emit('balls', sim.ballsFrame());
    conn.socket.emit('gameState', sim.gameStatePacket());
    if (sim.phase() === PH_PLACING) conn.socket.emit('placing', sim.placingPacket());
  }

  // If we're resuming into the OPPONENT's aiming turn, hand over the pose their
  // cue stick is currently in. Without this the spectated stick sits at its
  // default until they happen to move again — which, for a bot mid-countdown,
  // may not be until after it has already shot.
  if (sim.phase() === PH_AIMING && sim.currentPlayer() !== seatIndex) {
    conn.socket.emit('aimState', sim.currentAim());
  }

  emitTo(opponentOf(conn), 'opponentState', { connected: true, secondsLeft: 0 });
  trimShotLog(room);   // everyone back → shrink to the recent window
}

// ---- Connection handling ----------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });
const socketServer = new SocketServer(wss, { packetSchemas });

// Named (not an inline lambda) because the computer opponent is attached by
// calling it directly on one end of a loopback pair — see spawnBot. Everything
// below therefore applies to the bot exactly as it does to a person.
function handleConnection(socket) {
  const conn = { socket, name: '', room: null, index: -1, watching: null };

  socket.on('createRoom', ({ name, game }) => {
    if (conn.room) return;
    unwatch(conn);              // leaving the menu: stop spectating the demo table
    conn.name = name || 'Player';
    createRoom(conn, gameIdFromByte(game));
  });

  socket.on('joinRoom', ({ name, code }) => {
    if (conn.room) return;
    unwatch(conn);
    conn.name = name || 'Player';
    const room = rooms.get((code || '').toUpperCase());
    if (!room) { socket.emit('errorMsg', { message: 'Room not found.' }); return; }
    // A held (disconnected) seat still counts as taken — only its token holder
    // may reclaim it.
    if (room.seats.length >= 2) { socket.emit('errorMsg', { message: 'Room is full.' }); return; }
    joinRoomObj(conn, room);
  });

  socket.on('quickPlay', ({ name, game }) => {
    if (conn.room) return;
    unwatch(conn);
    conn.name = name || 'Player';
    const wantId = gameIdFromByte(game);
    // Match only another quick-play seeker waiting for the SAME game; otherwise
    // open a new public room. Private (code-shared) rooms are never joined here,
    // and an 8-ball seeker never lands in a 9-ball room (or vice versa).
    let waiting = null;
    for (const room of rooms.values()) {
      if (room.public && room.seats.length === 1 && !room.sim && room.rulesetId === wantId) {
        waiting = room; break;
      }
    }
    if (waiting) joinRoomObj(conn, waiting);
    else createRoom(conn, wantId, true);
  });

  socket.on('playBot', ({ name, game, skill }) => {
    if (conn.room) return;
    unwatch(conn);
    conn.name = name || 'Player';
    // A private room the bot immediately fills. `announce: false` skips the
    // "waiting for an opponent" lobby packet — the opponent is already here, and
    // the client would otherwise flash the lobby screen on its way to the table.
    // Difficulty is seeded from the client's slider so there is no server-side
    // default to drift out of sync with the UI.
    const room = createRoom(conn, gameIdFromByte(game), false, { announce: false, vsBot: true });
    spawnBot(room, skill);
  });

  // Difficulty slider (bot rooms only). Applies from the bot's NEXT decision;
  // a shot it is already lining up is left alone.
  socket.on('botSkill', ({ value }) => {
    const room = conn.room;
    if (!room || !room.bot) return;
    room.bot.setSkill(toSkill(value));
  });

  // Spectate the demo table (the menu's background). Idempotent: asking twice
  // just re-sends the snapshot.
  socket.on('watchDemo', () => {
    if (conn.room) return;              // a seated player is already watching a game
    unwatch(conn);
    const room = ensureDemoRoom();
    conn.watching = room;
    room.watchers.add(conn);
    if (demoIdleTimer) { clearTimeout(demoIdleTimer); demoIdleTimer = null; }
    sendSnapshot(conn, room);
  });

  socket.on('stopWatch', () => unwatch(conn));

  socket.on('newGame', ({ game }) => {
    const room = conn.room;
    if (!room || !room.sim) return;
    startMatch(room, game === 255 ? undefined : gameIdFromByte(game));
  });

  socket.on('aim', (aim) => {
    const room = conn.room;
    if (!room || !room.sim) return;
    // emitTo, not opp.socket: opponentOf returns a SEAT, which holds `.conn`
    // (and may hold none, if that player is mid-reconnect).
    if (!room.sim.applyAim(conn.index, aim)) return;
    emitTo(opponentOf(conn), 'aimState', aim);
    // Watchers are spectating BOTH players, so every aim is one of theirs.
    emitToWatchers(room, 'aimState', aim);
  });

  socket.on('shoot', (params) => {
    const room = conn.room;
    if (!room || !room.sim) return;
    if (replayLocked(room)) return;   // everyone is still watching the last shot
    performShot(room, conn.index, params);
  });

  socket.on('placeMove', ({ x, z }) => {
    const room = conn.room;
    if (!room || !room.sim) return;
    if (room.sim.applyPlaceMove(conn.index, x, z)) {
      broadcast(room, 'placing', room.sim.placingPacket());
    }
  });

  socket.on('placeConfirm', () => {
    const room = conn.room;
    if (!room || !room.sim) return;
    if (room.sim.applyPlaceConfirm(conn.index)) broadcastPhase(room);   // interact → aiming
  });

  // The player opened a past shot in the review list that they watched before
  // dropping, so only its metadata is on the client. Hand over the recording.
  socket.on('requestShot', ({ index }) => {
    const room = conn.room;
    if (!room) return;
    const s = room.shotLog.find(x => x.index === index);
    if (!s) return;   // trimmed out of the window; the client keeps its label
    conn.socket.emit('shotAnim', { ...s.packet, history: true });
  });

  // Reclaim a held seat after a drop/reload, and get replayed what was missed.
  socket.on('resume', ({ token, lastShot }) => {
    if (conn.room) return;
    unwatch(conn);
    for (const room of rooms.values()) {
      const i = room.seats.findIndex(s => s.token === token);
      if (i < 0) continue;
      if (!room.sim) break;                         // never started; nothing to resume into
      // The seat may STILL show the previous socket. A reload can land its
      // `resume` before the old socket's close has been processed, and this
      // used to answer "Session expired." — on which the client wipes its
      // session, so a fast reload lost the game outright.
      //
      // The token is proof of ownership: it lives in sessionStorage, which is
      // per-tab, so two tabs can never present the same one. Take the seat over
      // and drop the stale socket. Clearing its `room` first means its late
      // disconnect is ignored (handleDisconnect bails when seat.conn !== conn),
      // so it cannot evict the connection that just replaced it.
      const stale = room.seats[i].conn;
      if (stale) {
        stale.room = null;
        try { stale.socket.disconnect?.(); } catch { /* already gone */ }
      }
      conn.name = room.seats[i].name;
      resumeSeat(conn, room, i, lastShot);
      return;
    }
    socket.emit('errorMsg', { message: 'Session expired.' });
  });

  socket.on('leaveRoom', () => leaveRoom(conn));
  socket.on('disconnect', () => { unwatch(conn); handleDisconnect(conn); });
  return conn;
}

socketServer.on('connection', handleConnection);

// Seat a computer player. It gets a loopback socket, goes through
// handleConnection like any client, and then `enter` performs the ordinary
// action that puts it in a room — so from the server's point of view the room
// simply fills up and startMatch fires as normal. Returns the bot handle
// alongside its connection, which is what tells the caller which room it landed
// in when the bot is the one that opened it.
function seatBot(skill, enter) {
  const { a: botEnd, b: serverEnd } = createLoopbackPair();
  const botConn = handleConnection(serverEnd);
  const bot = createBotClient({
    socket: botEnd,
    getSim: () => (botConn.room ? botConn.room.sim : null),
    isLocked: () => !!botConn.room && replayLocked(botConn.room),
    skill: toSkill(skill),
  });
  enter(botEnd);
  return { bot, conn: botConn };
}

// The computer opponent in a vs-computer room: it joins by code, filling the
// seat the human left open.
function spawnBot(room, skill) {
  const { bot } = seatBot(skill, (s) => s.emit('joinRoom', { name: 'Computer', code: room.code }));
  room.bot = bot;   // handle for the difficulty slider; the game loop ignores it
  return bot;
}

// ---- The demo table (the menu background) -----------------------------------
// Two computer players at full difficulty, playing 8-ball forever in an ordinary
// room. Menu clients WATCH it (see the watchDemo handler): they hold no seat, so
// nothing they can send reaches the game, and one room serves every menu on the
// server rather than one sim per open tab.
//
// It is torn down once nobody is looking. That matters: idle it costs only
// timers, but a bot pair plays a shot every couple of seconds and each shot runs
// a full physics simulation to rest — real work to do for an empty gallery.
const DEMO_SKILL = 100;          // full difficulty (0-100 on the wire, as the slider sends)
const DEMO_IDLE_MS = 20_000;     // keep the table warm this long after the last watcher
const DEMO_RERACK_MS = 5000;     // sit on the finished rack this long before starting over
let demoRoom = null;
let demoIdleTimer = null;

function ensureDemoRoom() {
  if (demoRoom && rooms.has(demoRoom.code)) return demoRoom;
  // The first bot opens the room, the second fills it — the same two calls a
  // pair of humans makes.
  const opener = seatBot(DEMO_SKILL, (s) => s.emit('createRoom', { name: 'Computer', game: GAME_8BALL }));
  demoRoom = opener.conn.room;
  demoRoom.demo = true;
  seatBot(DEMO_SKILL, (s) => s.emit('joinRoom', { name: 'Computer 2', code: demoRoom.code }));
  return demoRoom;
}

// Detach a spectator, and start the countdown to tearing the table down if that
// was the last one. Safe to call on a connection that was never watching.
function unwatch(conn) {
  const room = conn.watching;
  if (!room) return;
  conn.watching = null;
  room.watchers.delete(conn);
  if (!room.demo || room.watchers.size) return;
  clearTimeout(demoIdleTimer);
  demoIdleTimer = setTimeout(() => {
    demoIdleTimer = null;
    if (rooms.get(room.code) !== room || room.watchers.size) return;
    destroyRoom(room);
    if (demoRoom === room) demoRoom = null;
  }, DEMO_IDLE_MS);
}

// Hand a joining watcher the table as it stands. `startInfo` reports the balls
// still in play at their CURRENT positions, so a spectator arriving mid-rack
// builds exactly what is on the felt rather than a fresh rack; `balls` then adds
// the ones already resting in the cups.
//
// Unlike resumeSeat there is no backlog and no shot log to replay: a watcher has
// missed nothing it is owed. It joins the present, mid-rack, and the next shot
// it sees is the next one taken.
function sendSnapshot(conn, room) {
  const sim = room.sim;
  if (!sim) return;   // both bots seated but the match has not started yet
  const info = sim.startInfo();
  conn.socket.emit('startGame', {
    game: gameByteFromId(info.game), firstPlayer: info.firstPlayer, layout: info.layout,
  });
  conn.socket.emit('balls', sim.ballsFrame());
  conn.socket.emit('gameState', sim.gameStatePacket());
  if (sim.phase() === PH_PLACING) conn.socket.emit('placing', sim.placingPacket());
  // Mid-turn: hand over the pose the shooter's cue is actually in, or the stick
  // sits at its default until the bot next moves it.
  if (sim.phase() === PH_AIMING) conn.socket.emit('aimState', sim.currentAim());
}

// The demo table has nobody to press "New Game", so a finished rack starts
// itself over. Scheduled off the replay gate so the winning shot has played out
// on every watcher's screen before the balls reappear.
function maybeRerack(room) {
  if (room.sim.gameStatePacket().winner < 0) return;
  const delay = Math.max(0, room.replayUntil - Date.now()) + DEMO_RERACK_MS;
  setTimeout(() => { if (rooms.get(room.code) === room) startMatch(room); }, delay);
}

httpServer.listen(PORT, () => {
  console.log(`Pool server on http://localhost:${PORT}`);
});
