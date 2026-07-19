// src/client/shotReview.js — a local "video player" for past shots.
//
// Every completed shot arrives as one delta-keyframe `anim` (see main.js
// beginReplay, which expands it so each frame carries a full `balls` list). We
// stash those anims here; a collapsible panel lets the player pick one and
// play / pause / restart / scrub it like a video, with the SAME frame
// interpolation the live replay uses (shotPlayer.js). Reviewing is purely
// local: on entry we snapshot the live table and borrow the ball meshes; on
// exit we rebuild the table from that snapshot, so the authoritative game is
// never disturbed.
import { snapshotRack, syncRack } from './balls.view.js';
import { setVisible as setCueVisible } from './cue.js';
import { makeShotPlayer, openingBalls } from './shotPlayer.js';

// One entry per completed shot, in order. `anim` is the recording — null for a
// shot restored after a reconnect, where only the label metadata was sent and
// the recording is fetched on demand (see enter/provideShot). Everything the
// dropdown renders lives on the entry itself, so a placeholder looks the same.
const history = [];            // { anim|null, index, shooter, pocketedBefore, removals }
let numberById = new Map();    // id -> number|null for THIS game (fixed per rack)
let reviewing = false;
let liveSnapshot = null;       // the live table, saved on entry / restored on exit
let cur = null;                // { anim, index, duration, t, playing } while a shot is loaded
let lastNow = 0;               // for per-frame dt while playing
let els = null;
let fetchShot = null;          // (rackIndex) => void — ask the server for a recording
let pendingSlot = -1;          // history slot waiting on a fetch

// Wire the DOM once (called from buildScene). Safe to call before any shot.
// `onNeedShot(rackIndex)` is called when the player opens a shot whose
// recording we don't hold; feed the result back through provideShot.
export function initReview({ onNeedShot } = {}) {
  fetchShot = onNeedShot || null;
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

// id -> number (null = cue) for the current rack. Replay frames carry only ids,
// so anything that has to (re)build a ball mesh from a frame needs this map.
export function numberForBallId(id) {
  return numberById.has(id) ? numberById.get(id) : null;
}

// Called from beginReplay with the already-expanded anim (frames carry .balls),
// the name of the player who took the shot, and the pocketed set BEFORE it (so
// the pocketed HUD can be rebuilt correctly as balls drop during the review).
export function recordShot(anim, shooter, pocketedBefore) {
  history.push({
    anim, index: anim.index,
    shooter: shooter || 'Player',
    pocketedBefore: (pocketedBefore || []).slice(),
    removals: anim.removals || [],
  });
  refreshSelect();
}

// A shot restored after a reconnect: label only, recording fetched on demand.
export function recordShotMeta(m) {
  history.push({
    anim: null, index: m.index,
    shooter: m.shooter || 'Player',
    pocketedBefore: (m.pocketedBefore || []).slice(),
    removals: m.removals || [],
  });
  refreshSelect();
}

// A requested recording arrived. Fill its slot, and open it if that is what the
// player was waiting on.
export function provideShot(anim) {
  const slot = history.findIndex(h => h.index === anim.index);
  if (slot < 0) return;
  history[slot].anim = anim;
  if (pendingSlot === slot) { pendingSlot = -1; enter(slot); }
}

// The pocketed numbers as of the start of the loaded review shot (union with
// balls currently below the felt gives the live pocketed column during review).
export function reviewPocketedBaseline() { return cur ? cur.pocketedBefore : []; }

// debug: the recorded shot history (used by tests to inspect frames/ids)
export function reviewHistory() { return history; }

// Dropdown label: "Shot N · <shooter>" plus the numbers sunk on that shot, if
// any. Pocketed balls are exactly the anim's removals (the cue never appears —
// a scratch respots it rather than removing it); map their ids to numbers.
function shotLabel(h, i) {
  const sunk = (h.removals || [])
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
  pendingSlot = -1;
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
  // Restored shot: we have the label but not the recording. Ask for it and
  // pick this back up in provideShot. Staying OUT of review mode until it
  // lands means a failed or slow fetch leaves the live table alone.
  if (!h.anim) {
    pendingSlot = i;
    els.select.value = String(i);
    els.time.textContent = 'Loading…';
    if (fetchShot) fetchShot(h.index);
    return;
  }
  if (!reviewing) { liveSnapshot = snapshotRack(); reviewing = true; }
  // Rebuild the rack to this shot's opening frame, matching numbers to ids.
  const frame0 = openingBalls(h.anim);
  syncRack(frame0.map(b => ({ ...b, number: numberForBallId(b.id) })));
  const cue0 = frame0.find(b => b.id === 0);                  // cue's resting start
  const player = makeShotPlayer(h.anim, { animateStick: true });
  cur = {
    player, duration: player.duration,
    anim: h.anim, index: i, t: 0, playing: false,
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
  if (liveSnapshot) { syncRack(liveSnapshot); liveSnapshot = null; }
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

// Show the shot at playhead `t` (ms). All the actual work — draw-back posing,
// keyframe interpolation, clamping — lives in the shared player, so scrubbing
// here and watching live are the same code path by construction.
function applyAt(t) { cur.player.applyAt(t); }

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
