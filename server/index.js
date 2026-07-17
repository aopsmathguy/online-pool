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
} from '../src/net/packets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8731;

// ---- Load Ammo (CommonJS asm.js build) and init physics once ----------------
const require = createRequire(import.meta.url);
globalThis.Ammo = require('../lib/ammo.server.cjs');
const { initPhysics } = await import('../src/physics.js');
await initPhysics();
const { RoomSim, PH_PLACING, PH_AIMING } = await import('../src/sim.js');
const { computeBotShot, computeBotPlacement } = await import('../src/ai.js');

// ---- Static file server -----------------------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
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
// room: { code, rulesetId, conns:[conn,...], sim, bot? }
// conn: { socket, name, room, index }
// A bot room has one human conn (player 0) and `bot: { plan }` standing in for
// player 1; the bot is driven from the tick loop (see tickBot below).
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join(''); }
  while (rooms.has(c));
  return c;
}
function names(room) { return room.conns.map(c => ({ name: c.name || 'Player' })); }
function broadcast(room, event, data) { for (const c of room.conns) c.socket.emit(event, data); }
function opponentOf(conn) { const r = conn.room; return r && r.conns[1 - conn.index]; }

function createRoom(conn, rulesetId, isPublic = false) {
  // isPublic rooms are the quick-play pool; private (code-shared) rooms are not
  // eligible for quick-play matching.
  const room = { code: makeCode(), rulesetId, conns: [conn], sim: null, public: isPublic };
  rooms.set(room.code, room);
  conn.room = room; conn.index = 0;
  conn.socket.emit('roomJoined', { code: room.code, playerIndex: 0, game: gameByteFromId(rulesetId), host: true });
  conn.socket.emit('lobby', { state: LOBBY_WAITING, players: names(room) });
  return room;
}

function joinRoomObj(conn, room) {
  conn.room = room; conn.index = room.conns.length;
  room.conns.push(conn);
  conn.socket.emit('roomJoined', { code: room.code, playerIndex: conn.index, game: gameByteFromId(room.rulesetId), host: false });
  broadcast(room, 'lobby', { state: LOBBY_READY, players: names(room) });
  startMatch(room);
}

function startMatch(room, changeGame) {
  if (room.conns.length < 2 && !room.bot) return;
  if (!room.sim) room.sim = new RoomSim(room.rulesetId);
  room.replayUntil = 0;                 // a new rack cancels any pending replay gate
  if (room.bot) room.bot.plan = null;   // drop any stale bot decision
  room.sim.setPlayerNames(
    room.conns[0].name || 'Player 1',
    room.bot ? 'Computer' : (room.conns[1].name || 'Player 2'),
  );
  const info = room.sim.newGame(changeGame);
  room.rulesetId = info.game;   // ruleset string id (e.g. '8ball')
  broadcast(room, 'startGame', {
    game: gameByteFromId(info.game), firstPlayer: info.firstPlayer, layout: info.layout,
  });
  broadcast(room, 'gameState', room.sim.gameStatePacket());
  if (room.sim.phase() === PH_PLACING) broadcast(room, 'placing', room.sim.placingPacket());
}

// Execute a shot (human or bot): the sim runs the whole thing to rest
// synchronously and returns the keyframe recording; broadcast it, then the
// already-resolved post-shot state. Clients queue those packets until their
// replay finishes; replayUntil stops the server accepting the next shot (or
// the bot deciding) while everyone is still watching.
function performShot(room, playerIdx, params) {
  const anim = room.sim.applyShoot(playerIdx, params);
  if (!anim) return false;
  room.replayUntil = Date.now() + anim.durationMs + 250;
  broadcast(room, 'shotAnim', anim.packet);
  broadcast(room, 'balls', room.sim.ballsFrame());              // final resting frame
  broadcast(room, 'gameState', room.sim.gameStatePacket());
  if (room.sim.phase() === PH_PLACING) broadcast(room, 'placing', room.sim.placingPacket());
  return true;
}

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  const opp = opponentOf(conn);
  rooms.delete(room.code);
  conn.room = null;
  if (opp) { opp.socket.emit('opponentLeft', {}); opp.room = null; }
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
    if (room.conns.length >= 2 || room.bot) { socket.emit('errorMsg', { message: 'Room is full.' }); return; }
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
      if (room.public && room.conns.length === 1 && !room.sim && room.rulesetId === wantId) {
        waiting = room; break;
      }
    }
    if (waiting) joinRoomObj(conn, waiting);
    else createRoom(conn, wantId, true);
  });

  socket.on('playBot', ({ name, game }) => {
    if (conn.room) return;
    conn.name = name || 'Player';
    // Private single-player room: the human is player 0, the bot fills seat 1.
    const room = {
      code: makeCode(), rulesetId: gameIdFromByte(game), conns: [conn],
      sim: null, public: false, bot: { plan: null, skill: 0.5 },
    };
    rooms.set(room.code, room);
    conn.room = room; conn.index = 0;
    conn.socket.emit('roomJoined', { code: room.code, playerIndex: 0, game: gameByteFromId(room.rulesetId), host: false });
    startMatch(room);
  });

  // Difficulty slider (bot rooms only). Applies from the bot's NEXT decision;
  // a shot it is already lining up is left alone.
  socket.on('botSkill', ({ value }) => {
    const room = conn.room;
    if (!room || !room.bot) return;
    room.bot.skill = Math.max(0, Math.min(100, value)) / 100;
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
    if (room.replayUntil && Date.now() < room.replayUntil) return; // still replaying
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
    if (room.sim.applyPlaceConfirm(conn.index)) {
      broadcast(room, 'gameState', room.sim.gameStatePacket()); // interact → aiming
    }
  });

  socket.on('leaveRoom', () => leaveRoom(conn));
  socket.on('disconnect', () => leaveRoom(conn));
});

// ---- Computer opponent (bot rooms) -------------------------------------------
// Called every tick while a bot room exists. When it's the bot's turn it decides
// ONCE (placement or shot via src/ai.js), streams its aim to the human so the
// cue stick visibly lines up and draws back, then acts after a short delay.
const BOT_SHOT_DELAY = 1.6;    // seconds from "aim shown" to the strike
const BOT_PLACE_DELAY = 0.9;   // seconds before ball-in-hand placement confirms
const BOT_DRAW_TIME = 0.7;     // final seconds of the delay spent drawing back

function botAimPacket(shot, pullback) {
  return { yaw: shot.yaw, pitch: shot.pitch, strikeX: shot.strikeX, strikeY: shot.strikeY, pullback };
}

function tickBot(room, dt) {
  const sim = room.sim, bot = room.bot;
  if (room.replayUntil && Date.now() < room.replayUntil) return;  // humans still watching
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
      broadcast(room, 'aimState', botAimPacket(shot, 0));
    }
  }

  bot.plan.t -= dt;
  if (bot.plan.t > 0) {
    // Stream the cue drawing back over the last BOT_DRAW_TIME seconds (~20 Hz).
    const p = bot.plan;
    if (p.shot && p.t < BOT_DRAW_TIME && p.lastAimSent - p.t >= 0.05) {
      p.lastAimSent = p.t;
      const pull = p.shot.power * (1 - p.t / BOT_DRAW_TIME);
      broadcast(room, 'aimState', botAimPacket(p.shot, pull));
    }
    return;
  }

  const plan = bot.plan;
  bot.plan = null;
  if (plan.phase === PH_PLACING) {
    if (sim.applyPlaceConfirm(1)) broadcast(room, 'gameState', sim.gameStatePacket());
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
