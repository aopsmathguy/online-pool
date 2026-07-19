// src/client/timeline.js — what the client is looking at, and when.
//
// The client has two clocks: what the server says is true NOW, and what is on
// screen — which during a replay is a shot from seconds ago. Nearly every bug
// this codebase has produced was present-tense state applied while the past was
// showing: the HUD spoiling an outcome, a ball deleted moments before the replay
// showed it being pocketed.
//
// Those bugs were possible because nothing represented the difference. State
// arrived and was applied, and correctness depended on it never arriving at the
// wrong moment — a property no amount of server-side timing can guarantee, since
// only the client knows when its replay ends.
//
// So state is no longer applied. It is INDEXED, and the view is derived:
//
//     entries   [ shot₀, shot₁, … ]      append-only log of the rack
//     live      { state, balls, placing } the newest server truth
//     playhead  null = live, else { slot, t }
//
//     what you see  =  f(entries, live, playhead)
//
// A shot's outcome cannot be seen before the shot, because the outcome lives at
// index i and you are at index i-1. Live state cannot land early, because it is
// stored rather than applied and is only rendered once the playhead is live.
//
// The same variable also unifies three things that used to be separate systems
// with their own state and their own bugs:
//
//     live         playhead parked at the end
//     catching up  playhead behind, walking forward at 1x
//     reviewing    playhead moved back by the player
//
// Reviewing is therefore not a mode. Nothing needs to ask "are we reviewing?" —
// only "is the playhead live?", and a shot arriving mid-review is appended to
// the log without disturbing what is on screen (it used to fight it).
import { makeShotPlayer, openingBalls } from './shotPlayer.js';
import { PH_PLACING } from '../shared/net/packets.js';

// Dependencies, so this module holds no DOM, scene or socket knowledge:
//   syncRack(balls)      reconcile the rendered ball set (adds ids -> numbers)
//   showState(state)     adopt a gameState (HUD, turn side effects)
//   showPlacing(p)       adopt a ball-in-hand position
//   hideCue()            put the stick away
//   onChange()           the log or the playhead moved (redraw UI)
//   fetchShot(index)     ask the server for a recording we don't hold
export function createTimeline({
  syncRack, showState, showPlacing, hideCue, onChange, fetchShot,
} = {}) {
  const entries = [];        // { index, shooter, pocketedBefore, removals, anim, post, watched }
  const live = { state: null, balls: null, placing: null };

  let playhead = null;       // null = live; else { slot, t, playing, player, cueStart }
  let following = true;      // auto-advance through unwatched shots (off while reviewing)
  let pendingSlot = -1;      // waiting on a fetched recording to open
  let lastNow = 0;

  const changed = () => { if (onChange) onChange(); };
  const at = (slot) => entries[slot];

  // ---- the log -------------------------------------------------------------

  function reset() {
    entries.length = 0;
    playhead = null;
    following = true;
    pendingSlot = -1;
    changed();
  }

  // A recording to be WATCHED: live, or one missed while away.
  function appendShot(anim) {
    // The shot's `post` is kept ON THE ENTRY and adopted in finish(), never
    // here. Adopting it on arrival would render it immediately — which is
    // precisely the "outcome shown before the shot" bug this module exists to
    // make impossible. The newest server truth is the state after the last
    // WATCHED shot, not after the last shot to arrive.
    entries.push(entryFrom(anim, { watched: false }));
    advance();
    changed();
  }

  // Label-only, restored after a reconnect. Already seen by definition, so it
  // never queues for playback — it just has to be openable from the list.
  function appendMeta(m) {
    entries.push({
      index: m.index,
      shooter: m.shooter || 'Player',
      pocketedBefore: (m.pocketedBefore || []).slice(),
      removals: m.removals || [],
      anim: null, post: null, watched: true,
    });
    changed();
  }

  // A recording we asked for arrived. Fill its slot, and open it if that is
  // what the player was waiting on.
  function provide(anim) {
    const slot = entries.findIndex(e => e.index === anim.index);
    if (slot < 0) return;
    entries[slot].anim = anim;
    if (pendingSlot === slot) { pendingSlot = -1; seek(slot); }
    changed();
  }

  function entryFrom(anim, { watched }) {
    return {
      index: anim.index,
      shooter: anim.shooter || 'Player',
      pocketedBefore: (anim.pocketedBefore || []).slice(),
      removals: anim.removals || [],
      anim, post: anim.post || null, watched,
    };
  }

  // ---- the newest server truth ---------------------------------------------
  // Stored, never applied directly. It reaches the screen only when the
  // playhead is live — which is the whole point.

  function adoptLive({ state, balls, placing }) {
    if (state) {
      live.state = state;
      // A placement is only meaningful while the game IS placing. Keeping a
      // stale one alive matters here in a way it did not when packets were
      // applied on arrival: renderLive() runs on every adopt, so a leftover
      // `placing` would re-assert PH_PLACING after every gameState and the
      // game could never leave ball-in-hand.
      if (state.interact !== PH_PLACING) live.placing = null;
    }
    if (balls) live.balls = balls;
    if (placing) live.placing = placing;
    if (isLive()) renderLive();
  }
  const setLiveState = (state) => adoptLive({ state });
  const setLiveBalls = (balls) => adoptLive({ balls });
  const setLivePlacing = (placing) => adoptLive({ placing });

  function renderLive() {
    if (live.balls) syncRack(live.balls.items);
    if (live.state) showState(live.state);
    if (live.placing && live.placing.active) showPlacing(live.placing);
  }

  // ---- the playhead --------------------------------------------------------

  const isLive = () => playhead === null;

  // Walk forward onto the next shot we have not watched. Called when a shot
  // arrives and when one finishes — this is both "play the live shot" and
  // "drain the catch-up backlog", which are the same thing.
  function advance() {
    if (!following || !isLive()) return;
    const slot = entries.findIndex(e => !e.watched && e.anim);
    if (slot < 0) { renderLive(); return; }   // nothing to watch: show the present
    open(slot, { playing: true });
  }

  // Put the playhead on a shot. Rebuilds the rack to that shot's opening frame:
  // frame 0 lists exactly the balls in play when it began, so a ball pocketed
  // later exists to be seen going in.
  function open(slot, { playing }) {
    const e = at(slot);
    if (!e || !e.anim) return;
    const frame0 = openingBalls(e.anim);
    syncRack(frame0);                       // the caller's syncRack adds numbers
    const cue0 = frame0.find(b => b.id === 0);
    const player = makeShotPlayer(e.anim, { animateStick: true });
    playhead = {
      slot, t: 0, playing, player,
      duration: player.duration,
      cueStart: cue0 ? { x: cue0.x, y: cue0.y, z: cue0.z } : null,
    };
    lastNow = performance.now();
    player.applyAt(0);
    changed();
  }

  // Open a past shot deliberately — this is what "reviewing" is. Stops
  // following, so live shots pile up in the log instead of yanking the view.
  function seek(slot) {
    const e = at(slot);
    if (!e) return;
    following = false;
    if (!e.anim) {                    // restored: label only, fetch the recording
      pendingSlot = slot;
      changed();
      if (fetchShot) fetchShot(e.index);
      return;
    }
    open(slot, { playing: false });
  }

  // Back to the present: whatever the server last told us, applied now.
  function toLive() {
    playhead = null;
    following = true;
    pendingSlot = -1;
    hideCue();                        // the live loop re-shows it on an aiming turn
    renderLive();
    advance();                        // anything that arrived while reviewing
    changed();
  }

  function tick(now) {
    if (isLive() || !playhead.playing) { lastNow = now; return; }
    const dt = Math.min(100, now - lastNow);   // clamp so a tab-out doesn't skip
    lastNow = now;
    playhead.t += dt;
    if (playhead.t >= playhead.duration) {
      playhead.t = playhead.duration;
      playhead.player.applyAt(playhead.t);
      finish();
      return;
    }
    playhead.player.applyAt(playhead.t);
    changed();
  }

  // The shot on screen reached its end.
  function finish() {
    const e = at(playhead.slot);
    if (e) e.watched = true;
    if (following) {
      hideCue();
      playhead = null;
      if (e && e.post) adoptLive(e.post);   // its outcome, exactly now and not before
      advance();                            // straight into the next missed shot
    } else {
      playhead.playing = false;             // reviewing: park at the end
    }
    changed();
  }

  // ---- transport (review only) ---------------------------------------------

  function step(ms) {
    if (isLive()) return;
    playhead.playing = false;
    playhead.t = Math.max(0, Math.min(playhead.duration, playhead.t + ms));
    playhead.player.applyAt(playhead.t);
    changed();
  }
  function seekTime(t) {
    if (isLive()) return;
    playhead.playing = false;
    playhead.t = Math.max(0, Math.min(playhead.duration, t));
    playhead.player.applyAt(playhead.t);
    changed();
  }
  function togglePlay() {
    if (isLive()) return;
    if (playhead.t >= playhead.duration) playhead.t = 0;   // parked at the end: restart
    playhead.playing = !playhead.playing;
    lastNow = performance.now();
    changed();
  }
  function restart() {
    if (isLive()) return;
    playhead.t = 0;
    playhead.playing = true;
    lastNow = performance.now();
    playhead.player.applyAt(0);
    changed();
  }

  // ---- queries -------------------------------------------------------------

  return {
    reset, appendShot, appendMeta, provide,
    setLiveState, setLiveBalls, setLivePlacing,
    isLive, seek, seekTime, step, togglePlay, restart, toLive, tick,

    entries: () => entries,
    /** The shot on screen: { slot, t, duration, playing, entry } — null if live. */
    current: () => (isLive() ? null : {
      slot: playhead.slot, t: playhead.t, duration: playhead.duration,
      playing: playhead.playing, entry: at(playhead.slot),
    }),
    /** Waiting on a recording we asked the server for. */
    loadingSlot: () => pendingSlot,
    /** True while the synthetic draw-back is on screen. */
    drawingBack: () => !isLive() && playhead.player.drawingBackAt(playhead.t),
    /** Cue-ball rest position at the START of the shot on screen (camera anchor). */
    cueAnchor: () => (isLive() ? null : playhead.cueStart),
    /** Balls already pocketed when the shot on screen began. */
    pocketedBaseline: () => (isLive() ? (live.state?.pocketed || []) : at(playhead.slot).pocketedBefore),
    /** Whether the playhead is auto-following live play (false while reviewing). */
    isFollowing: () => following,
    /** debug */
    state: () => ({
      live: isLive(), following, shots: entries.length,
      unwatched: entries.filter(e => !e.watched && e.anim).length,
      slot: playhead ? playhead.slot : -1,
    }),
  };
}
