// src/game.js — Generic two-player match controller, as an instanced factory.
//
// `createGame(rulesetId, balls)` returns a self-contained controller bound to
// its own `match` state, so the server can run many games at once (one per
// room). It owns what every cue-sports game shares: two players, whose turn it
// is, ball-in-hand, per-shot event recording, and shot resolution. All
// game-specific decisions live in a pluggable ruleset (see src/rules/). This
// module has NO DOM/rendering — the client renders HUD from `hudView()`.
//
// Ruleset interface (see src/rules/eightball.js):
//   meta:{id,name}  rack(ctx)  init(match)  snapshot(match)
//   resolve(shot,match)->decision   hud(match)->{chips,status}
// A `decision`: { gameOver, winner, foul, reason, continues, ballInHand, message }.
import { getRuleset, defaultRulesetId, listRulesets } from './rules/index.js';

export { listRulesets, defaultRulesetId, getRuleset };

// `balls` is the room's live ball array (from balls.logic.js); rules read it via
// match.balls so each instance is isolated.
export function createGame(rulesetId, balls = []) {
  let ruleset = getRuleset(rulesetId || defaultRulesetId);

  const match = {
    players: [{ name: 'Player 1' }, { name: 'Player 2' }],
    current: 0,
    phase: 'break',
    ballInHand: false,
    winner: null,
    message: '',
    shot: null,
    data: {},
    balls,
  };
  if (ruleset.init) ruleset.init(match);

  // --- Per-shot event recording (fed by the sim's contact scanner) ---------
  function beginShot(isBreakShot) {
    match.shot = {
      isBreak: isBreakShot,
      firstHit: null,
      railAfterContact: false,
      railedBalls: new Set(),
      pocketed: [],
      cueScratch: false,
      ballsOffTable: [],
      pre: ruleset.snapshot ? ruleset.snapshot(match) : null,
    };
  }
  function recordFirstHit(number) {
    const s = match.shot; if (!s) return;
    if (s.firstHit == null) s.firstHit = number;
  }
  function recordRail(number) {
    const s = match.shot; if (!s) return;
    if (s.firstHit != null) s.railAfterContact = true;
    if (number != null) s.railedBalls.add(number);
  }
  function recordPocket(number) {
    const s = match.shot; if (!s) return;
    s.pocketed.push(number);
  }
  function recordCueScratch() {
    const s = match.shot; if (!s) return;
    s.cueScratch = true;
  }
  function recordOffTable(number) {
    const s = match.shot; if (!s) return;
    s.ballsOffTable.push(number);
  }

  // --- Shot resolution -----------------------------------------------------
  function endShot() {
    const s = match.shot;
    if (!s) return { over: false };

    const d = ruleset.resolve(s, match) || {};
    match.shot = null;

    if (d.gameOver) {
      match.phase = 'over';
      match.winner = d.winner;
      match.ballInHand = false;
      match.message = d.message || `${match.players[d.winner].name} wins.`;
      return { over: true, winner: d.winner };
    }

    const turnPasses = !!d.foul || !d.continues;
    if (turnPasses) match.current = 1 - match.current;
    match.ballInHand = d.ballInHand ?? !!d.foul;
    match.message = d.message || '';

    return { over: false, foul: !!d.foul, turnPasses, reason: d.reason };
  }

  function reset() {
    match.current = 0;
    match.phase = 'break';
    match.ballInHand = false;
    match.winner = null;
    match.message = '';
    match.data = {};
    match.shot = null;
    if (ruleset.init) ruleset.init(match);
  }

  function setRuleset(id) {
    ruleset = getRuleset(id);
    reset();
  }

  return {
    match,
    beginShot, recordFirstHit, recordRail, recordPocket, recordCueScratch, recordOffTable,
    endShot, reset, setRuleset,
    rackLayout: (ctx) => ruleset.rack(ctx),
    hudView: () => (ruleset.hud ? ruleset.hud(match) : { chips: [], status: '' }),
    getRulesetId: () => ruleset.meta.id,
    isBreak: () => match.phase === 'break',
    isOver: () => match.phase === 'over',
    needsBallInHand: () => match.ballInHand,
    getState: () => match,
  };
}
