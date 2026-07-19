// src/server/botClient.js — the computer opponent, as a CLIENT.
//
// It holds one end of a loopback socket and plays the game the way a human tab
// does: watch the table, wait your turn, line the cue up, shoot. Its shots go
// through the same `shoot` / `placeMove` / `placeConfirm` handlers a human's do,
// so every rule the server enforces on a person is enforced on it — it cannot
// bypass the phase checks or fire while everyone is still watching the last
// shot.
//
// This replaces a 60 Hz server tick that existed solely to pace it. The server
// now has no per-frame work at all; the bot paces itself with timers, which is
// what a client does.
//
// One honest asymmetry: it reads ball positions from its room's sim
// (`readTable()`) rather than reconstructing them from packets. It is a
// server-side bot, and readTable exists precisely to let something reason about
// the table without touching the simulation. Everything it *does* is a packet.
import { computeBotShot, computeBotPlacement } from './ai.js';
import { SHOT_STRIKE_MS } from '../shared/constants.js';
import { PH_AIMING, PH_PLACING } from '../shared/net/packets.js';

const SHOT_DELAY_MS = 1600;    // from "aim shown" to the strike
const PLACE_DELAY_MS = 900;    // before ball-in-hand placement confirms
const DRAW_TIME_MS = 700;      // final stretch of the delay spent drawing back
const AIM_HZ_MS = 50;          // ~20 Hz aim streaming, same as a human client
const WATCH_SLACK_MS = 150;    // beyond a shot's own length, before acting

// `socket`  the bot's end of the loopback pair
// `getSim`  () => the RoomSim for the room it is sitting in (or null)
// `skill`   0..1, higher is more accurate
export function createBotClient({ socket, getSim, skill = 0.5 }) {
  let myIndex = -1;
  let state = null;         // last gameState we were told about
  let busyUntil = 0;        // we are "watching" a shot until this wall-clock time
  let acting = false;       // a decision is already scheduled
  let timers = [];
  let alive = true;

  const bot = {
    skill,
    setSkill(v) { bot.skill = v; },
    stop() {
      alive = false;
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };

  const later = (fn, ms) => { const t = setTimeout(() => { if (alive) fn(); }, ms); timers.push(t); return t; };
  const now = () => Date.now();

  socket.on('roomJoined', (d) => { myIndex = d.playerIndex; });

  // A shot: "watch" it for as long as a human client would be playing it back,
  // then adopt its outcome and reconsider. This is what keeps the bot from
  // shooting into the server's replay gate and being rejected.
  socket.on('shotAnim', (anim) => {
    const ballMs = Math.max(0, (anim.frames.length - 1)) * anim.dtMs;
    busyUntil = now() + SHOT_STRIKE_MS + ballMs + WATCH_SLACK_MS;
    if (anim.post) state = anim.post.state;
    schedule();
  });

  socket.on('gameState', (s) => { state = s; schedule(); });
  socket.on('startGame', () => { busyUntil = 0; schedule(); });
  socket.on('placing', () => schedule());
  socket.on('opponentLeft', () => bot.stop());

  // Consider acting. Cheap and idempotent — every packet calls it.
  //
  // `acting` stays set for the WHOLE action, not just until act() starts: an
  // action spans timers (line up, draw back, strike) and more packets arrive
  // while it runs. Clearing it early would let a second decision start on top
  // of the first and fire two shots for one turn.
  function schedule() {
    if (!alive || acting || !state) return;
    if (state.current !== myIndex) return;
    if (state.winner >= 0) return;
    if (state.interact !== PH_AIMING && state.interact !== PH_PLACING) return;

    acting = true;
    later(act, Math.max(0, busyUntil - now()));
  }

  // Finish the current action and let the next packet start another.
  function done() { acting = false; schedule(); }

  function act() {
    if (!alive || !state || state.current !== myIndex) return done();
    const sim = getSim();
    if (!sim) return done();
    // The room may have moved on while we waited (a new rack, the turn passing
    // back); trust the sim's phase now rather than the one that woke us.
    if (sim.phase() === PH_PLACING) return placeThenConfirm(sim);
    if (sim.phase() === PH_AIMING) return aimThenShoot(sim);
    return done();
  }

  function placeThenConfirm(sim) {
    const pos = computeBotPlacement(sim.readTable());
    if (pos) socket.emit('placeMove', { x: pos.x, z: pos.z });
    later(() => { socket.emit('placeConfirm', {}); done(); }, PLACE_DELAY_MS);
  }

  function aimThenShoot(sim) {
    const shot = computeBotShot(sim.readTable(), bot.skill);
    // Show the aim immediately, then draw the cue back over the last stretch —
    // ordinary `aim` packets, exactly what a human client streams, so the
    // opponent sees the stick line up and pull back with no special casing.
    socket.emit('aim', aimPacket(shot, 0));
    const steps = Math.floor(DRAW_TIME_MS / AIM_HZ_MS);
    for (let i = 1; i <= steps; i++) {
      const remaining = DRAW_TIME_MS - i * AIM_HZ_MS;
      later(() => socket.emit('aim', aimPacket(shot, shot.power * (1 - remaining / DRAW_TIME_MS))),
        SHOT_DELAY_MS - DRAW_TIME_MS + i * AIM_HZ_MS);
    }
    later(() => {
      socket.emit('shoot', {
        yaw: shot.yaw, pitch: shot.pitch, strikeX: shot.strikeX, strikeY: shot.strikeY, power: shot.power,
      });
      done();
    }, SHOT_DELAY_MS);
  }

  const aimPacket = (shot, pullback) => ({
    yaw: shot.yaw, pitch: shot.pitch, strikeX: shot.strikeX, strikeY: shot.strikeY, pullback,
  });

  return bot;
}
