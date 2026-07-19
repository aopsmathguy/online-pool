// src/client/shotReview.js — the replay UI: a shot list and a transport bar.
//
// This is presentation only. It owns no shots, no playback and no notion of
// "reviewing": it renders whatever timeline.js says is on screen, and turns
// button presses into playhead moves. Reviewing a past shot and watching a live
// one are the same playhead at different positions, so there is nothing here to
// keep in step with the live view — which is what used to require snapshotting
// the table on entry and rebuilding it on exit.
const STEP_MS = 16;   // one keyframe: recordings are sampled every 16 ms, so a
                      // step of exactly that lands on a real simulated frame
                      // rather than interpolating between two.

let numberById = new Map();   // id -> number|null for THIS rack
let els = null;
let tl = null;                // the timeline being driven

// Wire the DOM once (from buildScene). `timeline` is the one this UI drives.
export function initReview(timeline) {
  tl = timeline;
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
    bar:     document.getElementById('replayBar'),
    which:   document.getElementById('replayWhich'),
  };
  els.toggle.addEventListener('click', () => {
    const collapsed = els.panel.classList.toggle('collapsed');
    els.toggle.textContent = collapsed ? 'Replays ▸' : 'Replays ▾';
  });
  els.select.addEventListener('change', () => {
    const i = parseInt(els.select.value, 10);
    if (Number.isInteger(i) && i >= 0) tl.seek(i);
  });
  els.play.addEventListener('click', () => tl.togglePlay());
  els.stepBack.addEventListener('click', () => tl.step(-STEP_MS));
  els.stepFwd.addEventListener('click', () => tl.step(STEP_MS));
  els.restart.addEventListener('click', () => tl.restart());
  els.exit.addEventListener('click', () => tl.toLive());
  els.scrub.addEventListener('input', () => {
    const cur = tl.current();
    if (cur) tl.seekTime((parseInt(els.scrub.value, 10) / 1000) * cur.duration);
  });
  render();
}

// Expand the (collapsible) panel — called when the game ends so the replay
// controls are visible without hunting for the toggle.
export function openReviewPanel() {
  if (!els) return;
  els.panel.classList.remove('collapsed');
  els.toggle.textContent = 'Replays ▾';
}

// Called on startGame: fix the id->number map for the new rack. Frames carry
// only ids, so anything rebuilding a mesh from one needs this.
export function setReviewLayout(layout) {
  numberById = new Map();
  for (const b of layout) numberById.set(b.id, b.number === 255 ? null : b.number);
}
export function numberForBallId(id) {
  return numberById.has(id) ? numberById.get(id) : null;
}

// Dropdown label: "Shot N · <shooter>" plus what it sank. Pocketed balls are
// exactly the entry's removals (the cue never appears — a scratch respots it),
// mapped from ids to numbers.
function shotLabel(e, i) {
  const sunk = (e.removals || [])
    .map(r => numberById.get(r.id))
    .filter(n => n != null)
    .sort((a, b) => a - b);
  let s = `Shot ${i + 1} · ${e.shooter}`;
  if (sunk.length) s += ` · sank ${sunk.join(', ')}`;
  return s;
}

// Redraw everything from the timeline. Called whenever it changes, so the UI is
// a pure function of playhead + log rather than something kept in step by hand.
export function render() {
  if (!els || !tl) return;
  const entries = tl.entries();
  const cur = tl.current();
  const loading = tl.loadingSlot();
  const showing = cur ? cur.slot : (loading >= 0 ? loading : -1);

  // Shot list.
  const sel = els.select;
  const want = String(showing);
  if (sel.options.length !== entries.length + 1 || sel.dataset.n !== String(entries.length)) {
    sel.innerHTML = '';
    sel.appendChild(opt('-1', entries.length ? 'Select a shot…' : 'No shots yet', !entries.length));
    entries.forEach((e, i) => sel.appendChild(opt(String(i), shotLabel(e, i))));
    sel.dataset.n = String(entries.length);
  }
  if (sel.value !== want) sel.value = want;

  // Transport bar: up exactly while a past shot is on screen (or loading).
  // `body.reviewing` lifts the other bottom-anchored controls clear of it.
  const barUp = showing >= 0 && !tl.isFollowing();
  els.bar.classList.toggle('hidden', !barUp);
  document.body.classList.toggle('reviewing', barUp);
  els.which.textContent = barUp && entries[showing] ? shotLabel(entries[showing], showing) : '';

  const on = !!cur;
  for (const b of [els.play, els.restart, els.stepBack, els.stepFwd]) b.disabled = !on;
  els.scrub.disabled = !on;
  els.exit.disabled = !barUp;
  els.play.textContent = on && cur.playing ? '⏸' : '▶';
  if (on) {
    els.scrub.value = String(Math.round((cur.t / cur.duration) * 1000) || 0);
    // 3-decimal seconds so a one-frame step visibly moves the clock.
    els.time.textContent = `${(cur.t / 1000).toFixed(3)} / ${(cur.duration / 1000).toFixed(3)}s`;
  } else {
    els.scrub.value = '0';
    els.time.textContent = loading >= 0 ? 'Loading…' : '0.0 / 0.0s';
  }
}

// How much of the bottom of the screen the replay chrome covers, so the HUD
// canvas can draw its dial and pocketed column above it.
export function reviewChromeHeight() {
  if (!els || els.bar.classList.contains('hidden')) return 0;
  return els.bar.offsetHeight || 0;
}

function opt(value, text, disabled = false) {
  const o = document.createElement('option');
  o.value = value; o.textContent = text; o.disabled = disabled;
  return o;
}
