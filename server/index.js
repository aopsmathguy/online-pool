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
  packetSchemas, LOBBY_WAITING, LOBBY_READY, gameIdFromByte, gameByteFromId,
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
// catches up from the shot log when they resume.
function broadcast(room, event, data) {
  for (const s of room.seats) if (s.conn) s.conn.socket.emit(event, data);
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
    shotLog: [], shotIndex: 0,
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
  anim.packet.post = {
    state: room.sim.gameStatePacket(),
    balls: room.sim.ballsFrame(),
    placing: room.sim.placingPacket(),   // .active is false unless it's ball-in-hand
  };
  room.shotLog.push({ index: anim.packet.index, packet: anim.packet, pre, preLayout });
  trimShotLog(room);
  broadcast(room, 'shotAnim', anim.packet);
  return true;
}

// Tear the room down for good: nobody is coming back. Used by an explicit
// "leave", by a lobby-stage drop, and by dropSeat when the grace runs out.
function destroyRoom(room, exceptConn) {
  rooms.delete(room.code);
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

  // Build the rack from the table as it stood at the START of the backlog, not
  // as it stands now: the balls sunk during those missed shots must exist as
  // meshes so the replay can show them being pocketed. The trailing `balls` +
  // `gameState` below reconcile to the present once the backlog finishes.
  const info = (missed.length && missed[0].preLayout) || sim.startInfo();
  conn.socket.emit('startGame', { game: gameByteFromId(info.game), firstPlayer: info.firstPlayer, layout: info.layout });

  // The HUD state as it stood when the backlog begins. Each shot then carries
  // its own `post`, so the top bar tracks the catch-up shot by shot on its own —
  // no interleaving of state packets with recordings, and no ordering contract
  // between this loop and the client's replay queue.
  conn.socket.emit('gameState', (missed.length && missed[0].pre) || sim.gameStatePacket());
  // Rebuild the review list first, then hand over the backlog to actually play.
  for (const s of alreadyWatched) conn.socket.emit('shotAnim', { ...s.packet, history: true });
  for (const s of missed) conn.socket.emit('shotAnim', s.packet);

  // Reconcile to the present. The last shot's `post` usually covers this, but
  // state can move after it (a placement drag, a newGame), so send it anyway —
  // it is idempotent. To this socket alone; the opponent is already up to date.
  conn.socket.emit('balls', sim.ballsFrame());
  conn.socket.emit('gameState', sim.gameStatePacket());
  if (sim.phase() === PH_PLACING) conn.socket.emit('placing', sim.placingPacket());

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
  const conn = { socket, name: '', room: null, index: -1 };

  socket.on('createRoom', ({ name, game }) => {
    if (conn.room) return;
    conn.name = name || 'Player';
    createRoom(conn, gameIdFromByte(game));
  });

  socket.on('joinRoom', ({ name, code }) => {
    if (conn.room) return;
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
    if (room.sim.applyAim(conn.index, aim)) emitTo(opponentOf(conn), 'aimState', aim);
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

  // Reclaim a held seat after a drop/reload, and get replayed what was missed.
  socket.on('resume', ({ token, lastShot }) => {
    if (conn.room) return;
    for (const room of rooms.values()) {
      const i = room.seats.findIndex(s => s.token === token);
      if (i < 0) continue;
      if (!room.sim) break;                         // never started; nothing to resume into
      if (room.seats[i].conn) break;                // seat already live elsewhere
      conn.name = room.seats[i].name;
      resumeSeat(conn, room, i, lastShot);
      return;
    }
    socket.emit('errorMsg', { message: 'Session expired.' });
  });

  socket.on('leaveRoom', () => leaveRoom(conn));
  socket.on('disconnect', () => handleDisconnect(conn));
  return conn;
}

socketServer.on('connection', handleConnection);

// Seat the computer opponent in `room`. It gets a loopback socket, goes through
// handleConnection like any client, and joins by code — so from the server's
// point of view the room simply fills up and startMatch fires as normal.
function spawnBot(room, skill) {
  const { a: botEnd, b: serverEnd } = createLoopbackPair();
  const botConn = handleConnection(serverEnd);
  const bot = createBotClient({
    socket: botEnd,
    getSim: () => (botConn.room ? botConn.room.sim : null),
    skill: toSkill(skill),
  });
  room.bot = bot;   // handle for the difficulty slider; the game loop ignores it
  botEnd.emit('joinRoom', { name: 'Computer', code: room.code });
  return bot;
}

httpServer.listen(PORT, () => {
  console.log(`Pool server on http://localhost:${PORT}`);
});
