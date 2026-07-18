// src/client/shotReview.js — a local "video player" for past shots.
//
// Every completed shot arrives as one delta-keyframe `anim` (see main.js
// beginReplay, which expands it so each frame carries a full `balls` list). We
// stash those anims here; a collapsible panel lets the player pick one and
// play / pause / restart / scrub it like a video, with the SAME frame
// interpolation the live replay uses (applyBallsFrameLerp). Reviewing is purely
// local: on entry we snapshot the live table and borrow the ball meshes; on
// exit we rebuild the table from that snapshot, so the authoritative game is
// never disturbed.
import {
  snapshotRack, rebuildFromSnapshot, applyBallsFrame, applyBallsFrameLerp,
} from './balls.view.js';
import {
  setVisible as setCueVisible, setYaw, setPitch, setStrikeOffset, setPullback,
} from './cue.js';

// Synthetic cue-strike lead-in prepended to each shot's timeline: the recording
// starts at the moment of contact (ball already moving), so to show the stick
// we replay a short draw-back + thrust just before it. HOLD is the fraction of
// the lead-in spent parked at full draw-back before the stick accelerates in.
const STRIKE_MS = 520;
const STRIKE_HOLD = 0.35;

const history = [];            // { anim } per completed shot, in order
let numberById = new Map();    // id -> number|null for THIS game (fixed per rack)
let reviewing = false;
let liveSnapshot = null;       // the live table, saved on entry / restored on exit
let cur = null;                // { anim, index, duration, t, playing } while a shot is loaded
let lastNow = 0;               // for per-frame dt while playing
let els = null;

// Wire the DOM once (called from buildScene). Safe to call before any shot.
export function initReview() {
  els = {
    panel:   document.getElementById('replayPanel'),
    toggle:  document.getElementById('replayToggle'),
    select:  document.getElementById('replaySelect'),
    restart: document.getElementById('replayRestart'),
    stepBack: document.getElementById('replayStepBack'),
    stepFwd: document.getElementById('replayStepFwd'),
    play:    document.getElementById('replayPlay'),
    scrub:   document.getElementById('replayScrub'),
    time:    document.getElementById('replayTime'),
    exit:    document.getElementById('replayExit'),
  };
  els.toggle.addEventListener('click', () => {
    const collapsed = els.panel.classList.toggle('collapsed');
    els.toggle.textContent = collapsed ? 'Replays ▸' : 'Replays ▾';
  });
  els.select.addEventListener('change', () => {
    const i = parseInt(els.select.value, 10);
    if (Number.isInteger(i) && i >= 0) enter(i);
  });
  els.play.addEventListener('click', togglePlay);
  els.stepBack.addEventListener('click', () => step(-4));
  els.stepFwd.addEventListener('click', () => step(4));
  els.restart.addEventListener('click', () => {
    if (!cur) return;
    cur.t = 0; cur.playing = true; applyAt(0); updateUi();
  });
  els.exit.addEventListener('click', exit);
  els.scrub.addEventListener('input', () => {
    if (!cur) return;
    cur.playing = false;
    cur.t = (parseInt(els.scrub.value, 10) / 1000) * cur.duration;
    applyAt(cur.t); updateUi();
  });
  refreshSelect();
}

export function isReviewing() { return reviewing; }

// Expand the (collapsible) panel — called when the game ends so the replay
// controls are visible without hunting for the toggle.
export function openReviewPanel() {
  if (!els) return;
  els.panel.classList.remove('collapsed');
  els.toggle.textContent = 'Replays ▾';
}

// The cue ball's resting position at the start of the loaded shot. The aim-view
// camera anchors here so it sights down the original shot line and stays put,
// rather than chasing the cue ball as it travels. Null when no shot is loaded.
export function reviewCueAnchor() { return cur ? cur.cueStart : null; }

// Called on startGame: fix the id->number map for the new rack and drop any
// history from the previous game.
export function setReviewLayout(layout) {
  numberById = new Map();
  for (const b of layout) numberById.set(b.id, b.number === 255 ? null : b.number);
  resetReview();
}

// Called from beginReplay with the already-expanded anim (frames carry .balls),
// the name of the player who took the shot, and the pocketed set BEFORE it (so
// the pocketed HUD can be rebuilt correctly as balls drop during the review).
export function recordShot(anim, shooter, pocketedBefore) {
  history.push({ anim, shooter: shooter || 'Player', pocketedBefore: (pocketedBefore || []).slice() });
  refreshSelect();
}

// The pocketed numbers as of the start of the loaded review shot (union with
// balls currently below the felt gives the live pocketed column during review).
export function reviewPocketedBaseline() { return cur ? cur.pocketedBefore : []; }

// Dropdown label: "Shot N · <shooter>" plus the numbers sunk on that shot, if
// any. Pocketed balls are exactly the anim's removals (the cue never appears —
// a scratch respots it rather than removing it); map their ids to numbers.
function shotLabel(h, i) {
  const sunk = (h.anim.removals || [])
    .map(r => numberById.get(r.id))
    .filter(n => n != null)
    .sort((a, b) => a - b);
  let s = `Shot ${i + 1} · ${h.shooter}`;
  if (sunk.length) s += ` · sank ${sunk.join(', ')}`;
  return s;
}

// Leave review (if active) and clear all recorded shots.
export function resetReview() {
  if (reviewing) exit();
  history.length = 0;
  cur = null;
  refreshSelect();
}

// Advance the loaded shot each render frame (only while reviewing).
export function reviewTick(now) {
  if (!reviewing || !cur) return;
  const dt = Math.min(100, now - lastNow);   // clamp so a tab-out doesn't skip
  lastNow = now;
  if (!cur.playing) return;
  cur.t += dt;
  if (cur.t >= cur.duration) { cur.t = cur.duration; cur.playing = false; }
  applyAt(cur.t);
  updateUi();
}

// --- internals --------------------------------------------------------------

function enter(i) {
  const h = history[i];
  if (!h) return;
  if (!reviewing) { liveSnapshot = snapshotRack(); reviewing = true; }
  // Rebuild the rack to this shot's opening frame, matching numbers to ids.
  const frame0 = h.anim.frames[0].balls;
  rebuildFromSnapshot(frame0.map(b => ({
    id: b.id, number: numberById.has(b.id) ? numberById.get(b.id) : null,
    x: b.x, y: b.y, z: b.z, qx: b.qx, qy: b.qy, qz: b.qz, qw: b.qw,
  })));
  const ballDur = (h.anim.frames.length - 1) * h.anim.dtMs;   // ms of ball motion
  const strikeDur = h.anim.shot ? STRIKE_MS : 0;              // draw-back lead-in
  const cue0 = frame0.find(b => b.id === 0);                  // cue's resting start
  cur = {
    anim: h.anim, index: i, strikeDur, ballDur,
    duration: strikeDur + ballDur, t: 0, playing: false,
    cueStart: cue0 ? { x: cue0.x, y: cue0.y, z: cue0.z } : null,
    pocketedBefore: h.pocketedBefore || [],
  };
  lastNow = performance.now();
  els.select.value = String(i);
  applyAt(0); updateUi();
}

function exit() {
  if (!reviewing) return;
  reviewing = false;
  cur = null;
  setCueVisible(false);   // the live loop re-shows it if it's an aiming turn
  if (liveSnapshot) { rebuildFromSnapshot(liveSnapshot); liveSnapshot = null; }
  els.select.value = '-1';
  updateUi();
}

// Nudge the playhead by `deltaMs` (±4 ms = one physics substep), pausing first.
// The balls are interpolated to the new instant, so a step lands between
// keyframes exactly like scrubbing.
function step(deltaMs) {
  if (!cur) return;
  cur.playing = false;
  cur.t = Math.max(0, Math.min(cur.duration, cur.t + deltaMs));
  applyAt(cur.t);
  updateUi();
}

function togglePlay() {
  if (!cur) return;
  if (cur.t >= cur.duration) cur.t = 0;   // replay from the start if parked at the end
  cur.playing = !cur.playing;
  lastNow = performance.now();
  updateUi();
}

// Show the balls at playhead `t` (ms), interpolating between the two keyframes
// that bracket it — the same lerp/slerp the live replay uses.
function applyAt(t) {
  const a = cur.anim, frames = a.frames, last = frames.length - 1;

  // Draw-back lead-in: balls parked at the opening frame; pose the cue stick.
  if (t < cur.strikeDur) {
    applyBallsFrame(frames[0].balls);
    poseStick(t / cur.strikeDur);
    return;
  }
  setCueVisible(false);   // strike over — hide the stick for the ball motion

  let tf = (t - cur.strikeDur) / a.dtMs;
  // Clamp the playhead: past the end (or NaN) snaps to the final frame; before
  // the start to the first. Otherwise interpolate the bracketing keyframes, with
  // i in [0, last-1] so i+1 is always a valid frame.
  if (!(tf < last)) { applyBallsFrame(frames[last].balls); return; }
  if (tf < 0) tf = 0;
  const i = Math.floor(tf);
  applyBallsFrameLerp(frames[i].balls, frames[i + 1].balls, tf - i);
}

// Pose the cue stick over the lead-in. `p` is 0..1 across the strike segment:
// hold at full draw-back, then thrust the tip into the ball with an ease-in
// (quadratic) so it accelerates through contact. Sets the aim state to the
// recorded shot line; the loop then renders the stick at the cue-ball position.
function poseStick(p) {
  const shot = cur.anim.shot;
  if (!shot) return;
  setYaw(shot.yaw); setPitch(shot.pitch); setStrikeOffset(shot.strikeX, shot.strikeY);
  let pull = shot.pullback;
  if (p > STRIKE_HOLD) {
    const q = (p - STRIKE_HOLD) / (1 - STRIKE_HOLD);   // 0..1 through the thrust
    pull = shot.pullback * (1 - q * q);
  }
  setPullback(pull);
  setCueVisible(true);
}

function refreshSelect() {
  if (!els) return;
  const sel = els.select;
  sel.innerHTML = '';
  if (!history.length) {
    sel.appendChild(opt('-1', 'No shots yet', true));
  } else {
    sel.appendChild(opt('-1', 'Select a shot…'));
    history.forEach((h, i) => sel.appendChild(opt(String(i), shotLabel(h, i))));
  }
  sel.value = reviewing && cur ? String(cur.index) : '-1';
  updateUi();
}

function opt(value, text, disabled = false) {
  const o = document.createElement('option');
  o.value = value; o.textContent = text; o.disabled = disabled;
  return o;
}

function updateUi() {
  if (!els) return;
  const on = !!cur;
  els.play.disabled = !on;
  els.restart.disabled = !on;
  els.stepBack.disabled = !on;
  els.stepFwd.disabled = !on;
  els.scrub.disabled = !on;
  els.exit.disabled = !reviewing;
  els.play.textContent = on && cur.playing ? '⏸' : '▶';
  if (on) {
    els.scrub.value = String(Math.round((cur.t / cur.duration) * 1000) || 0);
    // 3-decimal seconds so a ±4 ms step visibly moves the clock.
    els.time.textContent = `${(cur.t / 1000).toFixed(3)} / ${(cur.duration / 1000).toFixed(3)}s`;
  } else {
    els.scrub.value = '0';
    els.time.textContent = '0.0 / 0.0s';
  }
}
