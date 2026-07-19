// src/server/simView.js — read-only projections of a RoomSim onto the wire.
//
// Every packet the server sends about table/game state is built here, so the
// wire format lives in one greppable place next to src/shared/net/packets.js
// rather than scattered through the simulation. These are pure reads: they
// never mutate the sim.
import { PH_PLACING } from '../shared/net/packets.js';

// Opening layout for a new rack: which balls exist, their numbers and where
// they start. The client builds its rack meshes from this.
export function startInfo(sim) {
  return {
    game: sim.game.getRulesetId(),
    firstPlayer: sim.currentPlayer(),
    layout: sim.balls.map(b => {
      const o = b.body.getWorldTransform().getOrigin();
      return { id: b.id, number: b.number == null ? 255 : b.number, x: o.x(), z: o.z() };
    }),
  };
}

// Full absolute snapshot — never delta-encoded, so it also wipes out any
// accumulated sub-eps residue. This is the authoritative BALL SET as well as
// the positions: the client rebuilds its rack to match exactly, so `number` is
// included (255 = cue) and anything absent here is deleted client-side.
export function ballsFrame(sim) {
  return {
    items: sim.balls.concat(sim.sunk).map(b => {
      const t = b.body.getWorldTransform();
      const o = t.getOrigin(), q = t.getRotation();
      return {
        id: b.id, number: b.number == null ? 255 : b.number,
        x: o.x(), y: o.y(), z: o.z(), qx: q.x(), qy: q.y(), qz: q.z(), qw: q.w(),
      };
    }),
  };
}

// Whose turn, what they may do, and everything the HUD renders.
export function gameStatePacket(sim) {
  const match = sim.game.getState();
  const hud = sim.game.hudView();
  return {
    interact: sim.phase(),
    current: match.current,
    ballInHand: !!match.ballInHand,
    winner: match.winner == null ? -1 : match.winner,
    message: match.message || '',
    status: hud.status || '',
    chips: hud.chips.map(c => ({ text: c.text, active: !!c.active })),
    pocketed: sim.pocketedList.slice(),
  };
}

// Ball-in-hand state. Only meaningful while the sim is in PH_PLACING — see
// broadcastPhase in server/index.js, which is why this always travels with a
// gameState packet.
export function placingPacket(sim) {
  return {
    active: sim.phase() === PH_PLACING,
    player: sim.currentPlayer(),
    behindLine: sim.placeBehindLine,
    x: sim.placePos.x, z: sim.placePos.z,
  };
}
