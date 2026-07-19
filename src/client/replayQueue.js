// src/client/replayQueue.js — the ONE way shots are SEQUENCED.
//
// Sibling to shotPlayer.js, which owns how a single shot is PLAYED. This module
// owns the order they play in and what happens between them.
//
// The server simulates a whole shot the moment it is taken and sends one
// self-contained `shotAnim`: keyframes from strike to rest, plus `post` — the
// game state, ball set and placement as they stand once the shot has resolved.
// Playback is therefore a pure function of one packet. We play the recording at
// wall-clock rate, then apply `post`. Nothing about the outcome can arrive
// early, so there is nothing to defer, queue or reorder.
//
// (It did not used to be that way. `post` used to arrive as three separate
// packets broadcast immediately after the recording, so every one of them had
// to be parked in a queue and drained when playback finished — and during a
// reconnect backlog those parked packets were spliced onto the NEXT shot as its
// pre-state, which made a `gameState` packet mean two different things
// depending on whether a backlog was draining. Bundling `post` server-side
// deleted all of it.)
//
// Shots QUEUE rather than replace each other: a client that reconnects is sent
// every shotAnim it missed back-to-back and plays them through in order at
// normal speed. Nothing here distinguishes a backlog from a live shot — it does
// not need to, now that each shot carries its own outcome.
import { makeShotPlayer, openingBalls } from './shotPlayer.js';

// Callbacks let this module stay free of DOM, scene and socket concerns:
//   syncRack(balls)        reconcile the rendered ball set to a shot's frame 0
//   applyPost(post)        adopt the state a shot resolved to
//   onShotStart(anim)      a shot began playing (for the review recorder)
//   onShotEnd(index)       a shot finished (for the resume bookmark)
//   isReviewing()          the review player owns the meshes right now
//   hideCue()              playback is over; put the stick away
export function createReplayQueue({
  syncRack, applyPost, onShotStart, onShotEnd, onIdle, isReviewing, hideCue,
}) {
  let player = null;      // the shot currently on screen
  let anim = null;        // its packet
  let start = 0;          // performance.now() when it began
  const pending = [];     // shots waiting their turn

  function startAnim(next) {
    // Reconcile to the authoritative start-of-shot set before playing: frame 0
    // lists exactly the balls in play when the shot began. Anything missing is
    // created (a ball pocketed later in a backlog must exist to be seen
    // sinking) and anything spare is dropped. Skipped while reviewing — the
    // review owns the meshes then and restores the live set on exit.
    if (!isReviewing()) syncRack(openingBalls(next));

    // Every shot plays the same way, live or caught-up: draw back, strike,
    // stick gone. Same call the review player makes.
    player = makeShotPlayer(next, { animateStick: true });
    anim = next;
    start = performance.now();
    onShotStart(next);
  }

  return {
    // A shot arrived. Plays now if nothing is on screen, else queues behind it.
    push(next) {
      if (player) { pending.push(next); return; }
      startAnim(next);
    },

    // Advance the playhead. `now` is the rAF timestamp.
    tick(now) {
      if (!player) return;
      // Clamped at 0: the rAF timestamp marks the start of the frame batch, so
      // it can PREDATE the performance.now() that startAnim took inside the
      // socket handler.
      const t = Math.max(0, now - start);
      if (t >= player.duration) { this.finish(); return; }
      player.applyAt(t);
    },

    // End the shot on screen: snap to its final frame, adopt its outcome, then
    // roll into the next queued shot if there is one.
    finish() {
      if (!player) return;
      player.applyAt(player.duration);      // snap to the final frame
      hideCue();
      const done = anim;
      player = null;
      anim = null;
      onShotEnd(done.index);                // a reload now resumes AFTER this shot
      if (done.post) applyPost(done.post);  // the shot's own outcome, never early
      if (pending.length) { startAnim(pending.shift()); return; }
      if (onIdle) onIdle();                 // back to live: anything held can land now
    },

    // Drop everything without applying it — leaving a game, or a new rack.
    cancel() {
      player = null;
      anim = null;
      pending.length = 0;
    },

    isPlaying: () => !!player || pending.length > 0,
    drawingBack: () => !!player && player.drawingBackAt(performance.now() - start),
    state: () => ({ playing: !!player, pending: pending.length }),
  };
}
