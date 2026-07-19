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
const { computeBotShot, computeBotPlacement } = await import('../src/server/ai.js');

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
// A bot room has one human seat (player 0) and `bot: { plan }` standing in for
// player 1; the bot is driven from the tick loop (see tickBot below).
const rooms = new Map();
const RECONNECT_GRACE_MS = 45_000;
// Shot retention. A shot has to outlive the moment it was played, because a
// client can still be watching it: someone who reloads mid-replay reports that
// shot as unwatched and must be replayed it from the beginning. So a window of
// recent shots is kept even while everybody is connected, and the full backlog
// while a seat is away.
const MAX_SHOT_LOG = 40;               // cap while a seat is away
const KEEP_RECENT = 8;                 // kept even when everyone is connected
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
const anySeatAway = (room) => room.seats.some(s => !s.conn);

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
// replay (see afterReplay in client/main.js), but the server must not rely on
// that. Centralized so no future caller can forget it; performShot checks it
// itself for the same reason.
function replayLocked(room) {
  return !!room.replayUntil && Date.now() < room.replayUntil;
}

// Drop shots nobody can still need. While a seat is away the whole backlog is
// kept (up to a cap); once everyone is back only a recent window is, which is
// what still covers a client reloading part-way through a replay.
function trimShotLog(room) {
  const keep = anySeatAway(room) ? MAX_SHOT_LOG : KEEP_RECENT;
  if (room.shotLog.length > keep) room.shotLog.splice(0, room.shotLog.length - keep);
}

// Bot difficulty is 0-100 on the wire, 0..1 in the sim. Both the initial
// (playBot) and live (botSkill) paths run values through THIS one clamp, so the
// difficulty the server uses is always exactly the slider value the client sent.
const toSkill = (v) => Math.max(0, Math.min(100, v | 0)) / 100;

function createRoom(conn, rulesetId, isPublic = false) {
  // isPublic rooms are the quick-play pool; private (code-shared) rooms are not
  // eligible for quick-play matching.
  const seat = makeSeat(conn);
  const room = {
    code: makeCode(), rulesetId, seats: [seat], sim: null, public: isPublic,
    shotLog: [], shotIndex: 0,
  };
  rooms.set(room.code, room);
  conn.room = room; conn.index = 0;
  conn.socket.emit('roomJoined', { code: room.code, playerIndex: 0, game: gameByteFromId(rulesetId), host: true, token: seat.token, bot: false });
  conn.socket.emit('lobby', { state: LOBBY_WAITING, players: names(room) });
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
  if (room.seats.length < 2 && !room.bot) return;
  if (!room.sim) room.sim = new RoomSim(room.rulesetId);
  room.replayUntil = 0;                 // a new rack cancels any pending replay gate
  room.shotLog = []; room.shotIndex = 0;   // new rack, new shot numbering
  if (room.bot) room.bot.plan = null;   // drop any stale bot decision
  room.sim.setPlayerNames(
    room.seats[0].name || 'Player 1',
    room.bot ? 'Computer' : (room.seats[1].name || 'Player 2'),
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
  // Captured BEFORE the shot resolves: a resuming client needs the HUD state as
  // it stood when the backlog begins (names, groups, whose turn), otherwise its
  // top bar sits blank for the whole catch-up. Only worth computing when
  // somebody is actually away.
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
  room.shotLog.push({ index: anim.packet.index, packet: anim.packet, pre, preLayout });
  trimShotLog(room);
  broadcast(room, 'shotAnim', anim.packet);
  // The authoritative ball set and positions AFTER the shot resolved — which
  // includes startPlacement having already teleported the cue ball to its
  // ball-in-hand spot. Not the resting frame: that is the last frame of the
  // recording, and it is what the client shows until the replay ends.
  broadcast(room, 'balls', room.sim.ballsFrame());
  broadcastPhase(room);
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

  // Build the rack from the table as it stood at the START of the backlog, not
  // as it stands now: the balls sunk during those missed shots must exist as
  // meshes so the replay can show them being pocketed. The trailing `balls` +
  // `gameState` below reconcile to the present once the backlog finishes.
  const info = (missed.length && missed[0].preLayout) || sim.startInfo();
  conn.socket.emit('startGame', { game: gameByteFromId(info.game), firstPlayer: info.firstPlayer, layout: info.layout });

  // Each shot is preceded by the HUD state as it stood when that shot was taken,
  // so the top bar and status track the backlog shot by shot instead of being
  // frozen at the batch's opening state. The client attaches a gameState that
  // arrives mid-catch-up to the NEXT queued shot rather than deferring it to the
  // end (see beginReplay), which is what keeps them in step.
  for (const s of missed) {
    conn.socket.emit('gameState', s.pre);
    conn.socket.emit('shotAnim', s.packet);
  }

  // The client defers these behind its replay queue, so they land only after
  // the last missed shot has finished playing. Emitted to this socket alone
  // rather than via broadcastPhase — the opponent is already up to date.
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

socketServer.on('connection', (socket) => {
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
    if (room.seats.length >= 2 || room.bot) { socket.emit('errorMsg', { message: 'Room is full.' }); return; }
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
    // Private single-player room: the human is player 0, the bot fills seat 1.
    // Seed the bot's difficulty from the client's slider (no server-side default
    // to drift out of sync with the UI).
    const seat = makeSeat(conn);
    const room = {
      code: makeCode(), rulesetId: gameIdFromByte(game), seats: [seat],
      sim: null, public: false, bot: { plan: null, skill: toSkill(skill) },
      shotLog: [], shotIndex: 0,
    };
    rooms.set(room.code, room);
    conn.room = room; conn.index = 0;
    conn.socket.emit('roomJoined', { code: room.code, playerIndex: 0, game: gameByteFromId(room.rulesetId), host: false, token: seat.token, bot: true });
    startMatch(room);
  });

  // Difficulty slider (bot rooms only). Applies from the bot's NEXT decision;
  // a shot it is already lining up is left alone.
  socket.on('botSkill', ({ value }) => {
    const room = conn.room;
    if (!room || !room.bot) return;
    room.bot.skill = toSkill(value);
  });

  socket.on('newGame', ({ game }) => {
    const room = conn.room;
    if (!room || !room.sim) return;
    startMatch(room, game === 255 ? undefined : gameIdFromByte(game));
  });

  socket.on('aim', (aim) => {
    const room = conn.room;
    if (!room || !room.sim) return;
    if (room.sim.applyAim(conn.index, aim)) {
      const opp = opponentOf(conn);
      if (opp) opp.socket.emit('aimState', aim);
    }
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
});

// ---- Computer opponent (bot rooms) -------------------------------------------
// Called every tick while a bot room exists. When it's the bot's turn it decides
// ONCE (placement or shot via src/ai.js), streams its aim to the human so the
// cue stick visibly lines up and draws back, then acts after a short delay.
const BOT_SHOT_DELAY = 1.6;    // seconds from "aim shown" to the strike
const BOT_PLACE_DELAY = 0.9;   // seconds before ball-in-hand placement confirms
const BOT_DRAW_TIME = 0.7;     // final seconds of the delay spent drawing back

// Record the bot's aim on the sim as well as streaming it, so a client that
// resumes mid-turn can be handed the pose the cue stick is currently in.
function sendBotAim(room, aim) {
  room.sim.noteAim(aim);
  broadcast(room, 'aimState', aim);
}

function botAimPacket(shot, pullback) {
  return { yaw: shot.yaw, pitch: shot.pitch, strikeX: shot.strikeX, strikeY: shot.strikeY, pullback };
}

function tickBot(room, dt) {
  const sim = room.sim, bot = room.bot;
  if (replayLocked(room)) return;   // humans still watching the last shot
  const phase = sim.phase();
  if (sim.currentPlayer() !== 1 || (phase !== PH_AIMING && phase !== PH_PLACING)) {
    bot.plan = null;
    return;
  }

  if (!bot.plan || bot.plan.phase !== phase) {
    if (phase === PH_PLACING) {
      bot.plan = { phase, t: BOT_PLACE_DELAY, pos: computeBotPlacement(sim) };
      if (bot.plan.pos) {
        sim.applyPlaceMove(1, bot.plan.pos.x, bot.plan.pos.z);
        broadcast(room, 'placing', sim.placingPacket());
      }
    } else {
      const shot = computeBotShot(sim, bot.skill);
      bot.plan = { phase, t: BOT_SHOT_DELAY, shot, lastAimSent: Infinity };
      sendBotAim(room, botAimPacket(shot, 0));
    }
  }

  bot.plan.t -= dt;
  if (bot.plan.t > 0) {
    // Stream the cue drawing back over the last BOT_DRAW_TIME seconds (~20 Hz).
    const p = bot.plan;
    if (p.shot && p.t < BOT_DRAW_TIME && p.lastAimSent - p.t >= 0.05) {
      p.lastAimSent = p.t;
      const pull = p.shot.power * (1 - p.t / BOT_DRAW_TIME);
      sendBotAim(room, botAimPacket(p.shot, pull));
    }
    return;
  }

  const plan = bot.plan;
  bot.plan = null;
  if (plan.phase === PH_PLACING) {
    if (sim.applyPlaceConfirm(1)) broadcastPhase(room);
  } else {
    performShot(room, 1, plan.shot);
  }
}

// ---- Tick: drive bot rooms ---------------------------------------------------
// Shot physics no longer runs here — applyShoot simulates the whole shot to
// rest synchronously (250 Hz substeps) and performShot ships the recording.
// The tick only paces the computer opponent.
const TICK_MS = 1000 / 60;
setInterval(() => {
  const dt = TICK_MS / 1000;
  for (const room of rooms.values()) {
    if (room.bot && room.sim) tickBot(room, dt);
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Pool server on http://localhost:${PORT}`);
});
