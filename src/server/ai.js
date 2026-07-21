// src/ai.js — server-side computer opponent ("ghost-ball" aimer).
//
// Strategy (deliberately simple, beatable): enumerate every pair of
// (legal target ball, pocket) and keep the ones that are OPEN:
//   1. the target ball can reach the pocket without hitting another ball
//      (a clear corridor one ball wide along target→pocket), and the approach
//      angle into the pocket mouth is acceptable,
//   2. the cue ball can reach the ghost-ball position — the point of aim for a
//      perfect ghost-ball pot, one ball-diameter behind the target along the
//      target→pocket line — without clipping any other ball on the way, and
//   3. the cut angle is physically makeable (< ~83°). Note the cue-path check
//      covers >90° cuts automatically: the corridor to the ghost then clips
//      the target ball itself.
// Among the open shots the bot picks the one with the highest SCORE (see
// shotScore) = gap / f, where f is a geometric difficulty measure
//
//   f = d2 · sqrt(d1² − 4R²·sin²θ2) / (2R·cosθ2)
//
// (d1 = cue→object-ball, d2 = object-ball→aim-point, θ2 = the acute cut angle),
// and `gap` is the APPARENT pocket opening seen from the object ball: with p1
// the mouth endpoint farther from the ball and p2 the nearer, project p1 and p2
// onto the axis perpendicular to the aim→ball sightline and take the distance
// between the projections — how wide the mouth looks from the ball. Wider-
// looking openings and easier angles score higher. The aim point is the
// midpoint of A and B, where A is one ball radius inside the p1 jaw along the
// bisector of (p1→p2, p1→ball) and B is the analogue at p2 — i.e. the centre of
// the window in which a ball of radius R clears both jaws (no split cases). The
// bot aims at that shot's ghost ball, then perturbs the aim by a small random
// angle so it misses sometimes.
//
// With NO open shot it plays a safety, in order of preference:
//   1. a direct hit on a legal ball whose follow line avoids the pockets
//      (won't scratch) — aimed at the middle of the ball's VISIBLE stretch
//      (see visibleAim): partially covered balls, from a thin sliver to
//      just-under-half shade, get the aim offset sideways by up to one ball
//      radius to hit around the blocker,
//   2. a simple one-rail kick (mirror the target across a cushion) when every
//      legal ball is blocked,
//   3. the least-bad direct hit (all of them risk a scratch), hit gently,
//   4. a poke at the nearest legal ball.
//
// This module is server-only (driven from server/index.js) but lives in src/
// beside the rest of the headless game logic. It reads a live RoomSim.
import {
  tableW, tableH, R, g, mu_felt_linear, rodR, wireY,
} from '../shared/constants.js';
import { rail_pts } from '../shared/table.js';
import { SHOT_IMPULSE_PER_M } from './strike.js';
import { legalPitch, densify } from '../shared/clearance.js';
import { POCKET_MOUTHS as POCKETS } from '../shared/pockets.js';

// --- Tunables -----------------------------------------------------------------
// Aim error (the only thing the difficulty slider controls): triangular ± this
// many radians, falling off as the square of the remaining difficulty so the
// error shrinks fastest near the top of the slider and hits exactly 0 there.
const JITTER_EASIEST_RAD = 0.07;   // difficulty 0: ~4° — misses most pots
const BREAK_JITTER_SCALE = 1.7;    // the break is always a bit sloppier
const MAX_POWER = 0.825;        // client's PULLBACK_MAX (see cue.js)
const MIN_POWER = 0.16;        // never just dribble a ball in
const CLEAR_FACTOR = 0.99;      // corridor width factor: blocked if a ball sits
                                //   closer than 2R*CLEAR_FACTOR to the path
const MIN_CUT_COS = 0.12;       // reject cuts sharper than ~83°
const POCKET_SPEED_MARGIN = 3.5;// arrive at the pocket briskly, not just barely
const A_FELT = mu_felt_linear * g;  // felt deceleration applied by stepAndDamp

// Sampled rail cushion for cue-stick clearance checks (same data the server
// uses to enforce the elevation floor in applyShoot).
const RAIL_CLEAR_PTS = densify(rail_pts(tableW, tableH));

// Pocket mouth geometry (endpoints `e1`/`e2`, inward normal, approach-angle
// gate `minDot`) comes from pockets.js as POCKET_MOUTHS → imported as POCKETS.
// The per-shot aim point is computed from the mouth endpoints and the object
// ball (pocketAim); the mouth midpoint feeds the scratch/kick keep-out checks.

// --- Small helpers --------------------------------------------------------------
function jitter(rad) { return (Math.random() + Math.random() - 1) * rad; }   // triangular
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Aim-error half-width for a difficulty in [0..1] (0 = easiest, 1 = hardest).
// Quadratic in the headroom left on the slider: zero at difficulty 1 by
// construction, no special case needed.
function aimJitterRad(difficulty) {
  const t = clamp(difficulty, 0, 1);
  const headroom = 1 - t;
  return JITTER_EASIEST_RAD * headroom * headroom;
}

function distPointSegSq(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz || 1e-12;
  const t = clamp(((px - ax) * abx + (pz - az) * abz) / len2, 0, 1);
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return dx * dx + dz * dz;
}

// Is the corridor from A to B free of every ball not in `skip`? `width` scales
// the corridor: 1 = exactly one ball wide (touching passes), >1 adds margin.
function pathClear(ax, az, bx, bz, balls, skip, width = CLEAR_FACTOR) {
  const rr = (2 * R * width) ** 2;
  for (const b of balls) {
    if (skip && skip.includes(b)) continue;
    if (distPointSegSq(b.x, b.z, ax, az, bx, bz) < rr) return false;
  }
  return true;
}

// Aim point + apparent opening of pocket `p` as seen from object ball `t`.
// p1 = mouth endpoint FARTHER from the ball, p2 = the nearer one. No split cases:
//   A = p1 + R·bisector(p1→p2, p1→ball)   — R inside the p1 jaw, angled for approach
//   B = p2 + R·bisector(p2→p1, p2→ball)   — the analogue at the p2 jaw
// A and B bound the window of ball-centre positions that clear both jaws; the
// aim is their midpoint (window centre). `gap` (for scoring) is the APPARENT
// opening: p1 and p2 projected onto the axis ⟂ to the aim→ball sightline, and the
// distance between the projections. Returns { aim, gap } or null when the gap is
// narrower than the ball (< 2R) — it can't physically pass at this angle.
function bisectorPoint(from, toward, ball) {
  let ax = toward.x - from.x, az = toward.z - from.z;
  let al = Math.hypot(ax, az); if (al < 1e-9) return null; ax /= al; az /= al;
  let bx = ball.x - from.x, bz = ball.z - from.z;
  let bl = Math.hypot(bx, bz); if (bl < 1e-9) return null; bx /= bl; bz /= bl;
  let hx = ax + bx, hz = az + bz;                  // sum of unit dirs = bisector
  const hl = Math.hypot(hx, hz); if (hl < 1e-9) return null; hx /= hl; hz /= hl;
  return { x: from.x + hx * R, z: from.z + hz * R };
}
function pocketAim(p, t) {
  const d1 = Math.hypot(p.e1.x - t.x, p.e1.z - t.z);
  const d2 = Math.hypot(p.e2.x - t.x, p.e2.z - t.z);
  const [p1, p2] = d1 >= d2 ? [p.e1, p.e2] : [p.e2, p.e1];

  const A = bisectorPoint(p1, p2, t);
  const B = bisectorPoint(p2, p1, t);
  if (!A || !B) return null;
  const aim = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };

  // Apparent gap: |p1 − p2| projected onto the axis ⟂ to the aim→ball sightline.
  let sx = aim.x - t.x, sz = aim.z - t.z;
  const sl = Math.hypot(sx, sz); if (sl < 1e-9) return null; sx /= sl; sz /= sl;
  const nx = -sz, nz = sx;                          // unit ⟂ to the sightline
  const gap = Math.abs((p1.x - p2.x) * nx + (p1.z - p2.z) * nz);
  if (gap < 2 * R) return null;                     // ball (diam 2R) can't fit

  return { aim, gap };
}

// --- Shot enumeration -----------------------------------------------------------
// Every (target, pocket) pair whose target→aim-point corridor is clear and
// whose pocket-approach angle is acceptable. Adds the per-shot aim point, its
// apparent gap (for scoring), the ghost-ball centre (gx, gz) and the unit
// direction (dx, dz) of travel target→aim-point.
function potLines(objects, targetNumbers) {
  const lines = [];
  for (const t of objects) {
    if (!targetNumbers.includes(t.number)) continue;
    for (const p of POCKETS) {
      const pa = pocketAim(p, t);
      if (!pa) continue;
      const aim = pa.aim;
      const dPocket = Math.hypot(aim.x - t.x, aim.z - t.z);
      if (dPocket < 1e-4) continue;
      const dx = (aim.x - t.x) / dPocket, dz = (aim.z - t.z) / dPocket;
      if (dx * p.nx + dz * p.nz < p.minDot) continue;            // too shallow
      const gx = t.x - dx * 2 * R, gz = t.z - dz * 2 * R;        // ghost ball
      // Ghost must be somewhere the cue ball can actually sit.
      if (Math.abs(gx) > tableW / 2 - R * 0.9 || Math.abs(gz) > tableH / 2 - R * 0.9) continue;
      if (!pathClear(t.x, t.z, aim.x, aim.z, objects, [t])) continue; // ball's road blocked
      lines.push({ t, p, dx, dz, gx, gz, dPocket, aim, gap: pa.gap });
    }
  }
  return lines;
}

// Filter pot lines down to the ones the CUE ball can play from `cue`:
// makeable cut angle + clear corridor to the ghost. The target ball is kept in
// the obstacle list on purpose — on an impossible (>90°) cut, the corridor to
// the ghost passes through the target and the check rejects the shot.
function openShots(cue, objects, targetNumbers, lines = potLines(objects, targetNumbers)) {
  const shots = [];
  for (const L of lines) {
    const dCue = Math.hypot(L.gx - cue.x, L.gz - cue.z);
    if (dCue < 1e-4) continue;
    const ux = (L.gx - cue.x) / dCue, uz = (L.gz - cue.z) / dCue;
    const cutCos = ux * L.dx + uz * L.dz;
    if (cutCos < MIN_CUT_COS) continue;
    if (!pathClear(cue.x, cue.z, L.gx, L.gz, objects, null)) continue;
    shots.push({ ...L, dCue, cutCos });
  }
  return shots;
}

// Geometric difficulty factor f of an open shot — smaller is easier:
//   d2 · sqrt(d1² − 4R²·sin²θ2) / (2R·cosθ2)
// d1 = cue→object ball, d2 = object ball→aim-point, θ2 = acute angle between the
// cue→ball and ball→aim-point lines. Grows with both distances and blows up as
// the cut approaches 90° (cosθ2 → 0).
function shotDifficulty(cue, s) {
  const d1 = Math.hypot(s.t.x - cue.x, s.t.z - cue.z);
  if (d1 < 1e-6) return Infinity;
  const ux = (s.t.x - cue.x) / d1, uz = (s.t.z - cue.z) / d1;
  const cos2 = ux * s.dx + uz * s.dz;          // (dx,dz) is unit ball→aim-point
  if (cos2 <= 0) return Infinity;              // >90° cut: not makeable
  const sin2sq = Math.max(0, 1 - cos2 * cos2);
  const under = Math.max(0, d1 * d1 - 4 * R * R * sin2sq);
  return s.dPocket * Math.sqrt(under) / (2 * R * cos2);
}

// Score of an open shot — LARGER is better. The apparent pocket opening (how
// wide the mouth looks from the object ball) over the geometric difficulty f:
// gap / f. A wide-open, easy-angle shot scores high; a tight or thin-cut one
// scores low.
function shotScore(cue, s) {
  const f = shotDifficulty(cue, s);
  if (!(f > 0) || !isFinite(f)) return -Infinity;
  return s.gap / f;
}

function bestShot(cue, shots) {
  let best = null, bestScore = -Infinity;
  for (const s of shots) {
    const sc = shotScore(cue, s);
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  return { shot: best, score: bestScore };
}

// Power for a pot: arrive at the pocket still rolling (margin), work backwards
// through the collision (target gets ≈ cutCos of the cue speed) and the felt
// drag over the cue's run-up. power is the client-side pullback in metres;
// launch speed = power * SHOT_IMPULSE_PER_M (see resolveStrike in strike.js).
function potPower({ dCue, dPocket, cutCos }) {
  const vPocket = Math.sqrt(2 * A_FELT * dPocket) * POCKET_SPEED_MARGIN;
  const vContact = vPocket / Math.max(cutCos, 0.25);
  const v0 = Math.sqrt(vContact * vContact + 2 * A_FELT * dCue);
  return clamp(v0 / SHOT_IMPULSE_PER_M, MIN_POWER, MAX_POWER);
}

// --- Safeties (used when no open shot exists) -----------------------------------
const SCRATCH_LOOKAHEAD = 0.9;  // how far past the object ball we worry (m)
const SCRATCH_LANE = 0.14;      // lateral corridor around the follow line

// The ONLY spin the bot ever uses: on a straight(ish) shot whose follow line
// leads into a pocket, strike below centre so the cue ball stuns/draws back
// instead of following the object ball in. Kept small enough to be physically
// safe: legalize() re-runs the cue-clearance floor WITH this strikeY (a lower
// strike point needs more cue elevation), exactly as the server enforces.
const DRAW_STRIKE_Y = -0.5;
const DRAW_CUT_COS = 0.9;       // only near-straight shots follow the target line
// Stop-shot power boost: the cue ball's backspin decays with distance travelled,
// so on a straight draw the farther the cue ball is from the object ball, the
// harder it must be struck for the draw to still bite at contact and stop the
// cue. Added (per metre of cue→object distance) on top of the plain pot power.
const DRAW_POWER_PER_M = 0.22;

// After a direct hit the cue ball tends to keep travelling along the impact
// line; treat the aim as scratch-risky if that line runs into a pocket soon
// after the target ball (the cue could follow it in).
function scratchRisky(cue, t) {
  const d = Math.hypot(t.x - cue.x, t.z - cue.z) || 1;
  const ux = (t.x - cue.x) / d, uz = (t.z - cue.z) / d;
  for (const p of POCKETS) {
    const rx = p.x - t.x, rz = p.z - t.z;
    const along = rx * ux + rz * uz;
    if (along < 0 || along > SCRATCH_LOOKAHEAD) continue;
    if (Math.hypot(rx - along * ux, rz - along * uz) < SCRATCH_LANE) return true;
  }
  return false;
}

// Where should the cue aim to hit target `t` around whatever partially covers
// it? Two spaces matter, because the CUE BALL HAS A RADIUS:
//   - aim-offset space o: where the cue's CENTRE line passes, relative to the
//     target's centre. Contact happens for |o| < 2R, and the contact lands on
//     the target's surface at lateral ℓ = o/2.
//   - silhouette space ℓ ∈ [−R, +R]: the target's visible surface.
// Every blocker between cue and target shadows an o-interval (its lateral
// position ± the 2R passing width, scaled by d/s — nearer blockers cast wider
// shadows); halving maps those shadows onto the silhouette. Take the middle m
// of the widest visible stretch of the silhouette, then push the aim line ONE
// EXTRA BALL RADIUS past it, away from the shadow, so the cue ball's edge —
// not its centre line — meets the exposed surface:
//     o = m + R·sign(m)
// e.g. 4/5 of the ball visible → m = ±R/5 → aim (1/5)R + R = (6/5)R off the
// centre line; a fully visible ball has m = 0 → dead centre. If that aim is
// itself shadowed or would miss (multi-blocker edge cases), fall back to
// o = 2m (contact exactly at the visible middle), then o = m.
// Returns null if the ball is fully shadowed or no candidate aim survives.
function visibleAim(cue, t, objects) {
  const d = Math.hypot(t.x - cue.x, t.z - cue.z);
  if (d < 1e-6) return null;
  const ux = (t.x - cue.x) / d, uz = (t.z - cue.z) / d;
  const px = -uz, pz = ux;                                   // unit perpendicular
  const shadows = [];                                        // in aim-offset space
  for (const b of objects) {
    if (b === t) continue;
    const rx = b.x - cue.x, rz = b.z - cue.z;
    const s = rx * ux + rz * uz;                             // along the aim line
    if (s <= 1e-6 || s >= d) continue;                       // not in between
    const lat = rx * px + rz * pz;                           // lateral at s
    const scale = d / s;
    const half = 2 * R * CLEAR_FACTOR * scale;
    shadows.push([lat * scale - half, lat * scale + half]);
  }
  // Visible part of the silhouette (shadows halved: ℓ = o/2).
  let intervals = [[-R, R]];
  for (const [slo, shi] of shadows) {
    const lo = slo / 2, hi = shi / 2;
    const next = [];
    for (const [a, c] of intervals) {
      if (hi <= a || lo >= c) { next.push([a, c]); continue; }
      if (lo > a) next.push([a, lo]);
      if (hi < c) next.push([hi, c]);
    }
    intervals = next;
    if (!intervals.length) return null;                      // fully covered
  }
  let best = intervals[0];
  for (const iv of intervals) if (iv[1] - iv[0] > best[1] - best[0]) best = iv;
  const m = (best[0] + best[1]) / 2;
  for (const o of [m + R * Math.sign(m), 2 * m, m]) {
    if (Math.abs(o) > 2 * R * 0.98) continue;                // would miss the ball
    if (shadows.some(([lo, hi]) => o > lo && o < hi)) continue;  // cue path blocked
    return { x: t.x + px * o, z: t.z + pz * o };
  }
  return null;
}

// Legal balls the cue can reach directly (through the middle of their visible
// stretch), nearest first, each with its aim point and a scratch-risk flag.
function directHits(cue, objects, targetNumbers) {
  const out = [];
  for (const t of objects) {
    if (!targetNumbers.includes(t.number)) continue;
    const aim = visibleAim(cue, t, objects);
    if (!aim) continue;
    const d = Math.hypot(t.x - cue.x, t.z - cue.z);
    out.push({ t, d, aim, risky: scratchRisky(cue, aim) });
  }
  return out.sort((a, b) => a.d - b.d);
}

// Simple one-rail kicks: bounce the cue ball off a cushion into a legal ball.
//
// The reflection line is where the BALL CENTRE turns: the cushion is a round
// rod of radius rodR at height wireY, so contact puts the centre
// √((R+rodR)² − (wireY−R)²) ≈ 0.033 m inside the rail plane.
//
// A rolling ball does NOT mirror off a cushion: cushion restitution shortens
// the rebound's normal component and the ball's surviving topspin then curls
// the path. Net effect over the whole rebound leg (calibrated end-to-end by
// sweeping bounce points in this sim): the outgoing angle behaves like
// tanθ_out = E_RAIL_EFF·tanθ_in with E_RAIL_EFF ≈ 0.85. Solving "leave B and
// pass through the target" puts the bounce at
//   bTan = cueTan + (tTan − cueTan) · a / (a + c/E_RAIL_EFF)
// (a, c = cue/target distances from the reflection line, tan = the coordinate
// along the rail). E_RAIL_EFF = 1 would be the naive mirror.
//
// Rebounds still carry a few degrees of unpredictability, so both legs demand
// a WIDER clear corridor (KICK_CLEAR) than direct shots — only clean,
// forgiving kicks are considered.
const RAIL_BOUNCE_INSET = Math.sqrt((R + rodR) ** 2 - (wireY - R) ** 2);
const RAIL_LINES = [
  { axis: 'x', pos:  tableW / 2 - RAIL_BOUNCE_INSET }, { axis: 'x', pos: -tableW / 2 + RAIL_BOUNCE_INSET },
  { axis: 'z', pos:  tableH / 2 - RAIL_BOUNCE_INSET }, { axis: 'z', pos: -tableH / 2 + RAIL_BOUNCE_INSET },
];
const E_RAIL_EFF = 0.85;            // effective rebound compression (calibrated, see above)
const KICK_POCKET_KEEPOUT = 0.18;   // bounce point must stay off the pocket mouths
const KICK_CLEAR = 1.35;            // corridor width factor for kick legs

function kickShots(cue, objects, targetNumbers) {
  const shots = [];
  for (const t of objects) {
    if (!targetNumbers.includes(t.number)) continue;
    for (const L of RAIL_LINES) {
      const onX = L.axis === 'x';
      const a = onX ? L.pos - cue.x : L.pos - cue.z;    // cue → rail (signed)
      const c = onX ? L.pos - t.x : L.pos - t.z;        // target → rail (signed)
      if (Math.abs(a) < 0.05 || Math.abs(c) < 0.05) continue;   // hugging the rail
      const cueTan = onX ? cue.z : cue.x;
      const tTan = onX ? t.z : t.x;
      const bTan = cueTan + (tTan - cueTan) * Math.abs(a) / (Math.abs(a) + Math.abs(c) / E_RAIL_EFF);
      const b = onX ? { x: L.pos, z: bTan } : { x: bTan, z: L.pos };
      if (Math.abs(b.x) > tableW / 2 - R + 1e-6 || Math.abs(b.z) > tableH / 2 - R + 1e-6) continue;
      if (POCKETS.some(p => Math.hypot(p.x - b.x, p.z - b.z) < KICK_POCKET_KEEPOUT)) continue;
      if (!pathClear(cue.x, cue.z, b.x, b.z, objects, null, KICK_CLEAR)) continue;   // leg 1
      if (!pathClear(b.x, b.z, t.x, t.z, objects, [t], KICK_CLEAR)) continue;        // leg 2
      const leg1 = Math.hypot(b.x - cue.x, b.z - cue.z);
      const leg2 = Math.hypot(t.x - b.x, t.z - b.z);
      shots.push({ t, b, dist: leg1 + leg2, distEff: leg1 + leg2 / E_RAIL_EFF });
    }
  }
  return shots;
}

function nearestLegal(cue, objects, targetNumbers, preferClearPath) {
  let best = null, bestD = Infinity;
  const pick = (t, d) => { if (d < bestD) { best = t; bestD = d; } };
  if (preferClearPath) {
    for (const t of objects) {
      if (!targetNumbers.includes(t.number)) continue;
      if (!pathClear(cue.x, cue.z, t.x, t.z, objects, [t])) continue;
      pick(t, Math.hypot(t.x - cue.x, t.z - cue.z));
    }
    if (best) return best;
  }
  for (const t of objects) {
    if (!targetNumbers.includes(t.number)) continue;
    pick(t, Math.hypot(t.x - cue.x, t.z - cue.z));
  }
  return best;
}

// --- Public API -------------------------------------------------------------------
// Both entry points take a plain-data table snapshot (RoomSim.readTable()), not
// the sim: { balls: [{id, number, x, z}], placeBounds, phase, isBreak,
// legalTargets }, with balls[0] the cue. This module touches no Ammo, no rules
// object and no simulation state, so it is a pure function of that snapshot.
//
// Decide the bot's shot for the current position. `difficulty` in [0..1] scales
// only the aim inaccuracy (0 = wild, 1 = near-perfect). Returns the same params
// the client's `shoot` packet carries: { yaw, pitch, strikeX, strikeY, power }.
export function computeBotShot(table, difficulty = 0.5) {
  const cue = table.balls[0];
  const objects = table.balls.slice(1);
  const targets = table.legalTargets;
  const shot = { yaw: 0, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.3 };
  const jRad = aimJitterRad(difficulty);

  // Legal cue elevation: with a ball or the rail cushion behind the cue ball,
  // the stick must be jacked up to clear it. This is the SAME call the server
  // makes inside resolveStrike, on the same obstacle list and the same rail
  // sampling, so the floor we compute here is the floor the server will
  // enforce — the plan, the streamed aim and the shot all agree, and the server
  // never silently raises the pitch after the human has watched the cue line up.
  //
  // Always called last, once yaw and strikeY are final, for exactly that reason.
  // Power is compensated for the reduced horizontal component of the launch.
  const legalize = () => {
    shot.pitch = legalPitch(shot.pitch, {
      cx: cue.x, cz: cue.z, yaw: shot.yaw, strikeY: shot.strikeY,
      obstacles: objects, railPts: RAIL_CLEAR_PTS,
    });
    shot.power = clamp(shot.power / Math.max(0.4, Math.cos(shot.pitch)), MIN_POWER, MAX_POWER);
    return shot;
  };

  // Break: smash the nearest legal ball (the apex) at full power.
  if (table.isBreak) {
    const t = nearestLegal(cue, objects, targets, false);
    if (t) shot.yaw = Math.atan2(t.z - cue.z, t.x - cue.x) + jitter(jRad * BREAK_JITTER_SCALE);
    shot.power = MAX_POWER;
    return legalize();
  }

  const { shot: s } = bestShot(cue, openShots(cue, objects, targets));
  if (s) {
    shot.yaw = Math.atan2(s.gz - cue.z, s.gx - cue.x) + jitter(jRad);
    shot.power = potPower(s);
    // Near-straight pot: the pocket is dead ahead by construction, so the cue
    // would follow the object ball in. A little draw stops it at the contact —
    // and it must be struck harder the farther the cue is from the object ball,
    // since the backspin decays over the run (see DRAW_POWER_PER_M).
    if (s.cutCos > DRAW_CUT_COS) {
      shot.strikeY = DRAW_STRIKE_Y;
      const d1 = Math.hypot(s.t.x - cue.x, s.t.z - cue.z);   // cue → object ball
      shot.power = clamp(shot.power + DRAW_POWER_PER_M * d1, MIN_POWER, MAX_POWER);
    }
    return legalize();
  }

  // Nothing open: play a safety.
  // 1) Direct hit on a legal ball (aiming at its exposed sliver if the centre
  //    is blocked) that won't follow the cue into a pocket.
  const direct = directHits(cue, objects, targets);
  const safeHit = direct.find(o => !o.risky);
  if (safeHit) {
    shot.yaw = Math.atan2(safeHit.aim.z - cue.z, safeHit.aim.x - cue.x) + jitter(jRad);
    shot.power = clamp(0.14 + 0.08 * safeHit.d, MIN_POWER, 0.3);
    return legalize();
  }

  // 2) Every legal ball blocked (or scratch-risky): simple one-rail kick.
  const kicks = kickShots(cue, objects, targets);
  if (kicks.length) {
    const k = kicks.reduce((a, b) => (a.distEff <= b.distEff ? a : b));
    shot.yaw = Math.atan2(k.b.z - cue.z, k.b.x - cue.x) + jitter(jRad);
    shot.power = clamp(0.20 + 0.12 * k.distEff, MIN_POWER, 0.5);
    return legalize();
  }

  // 3) Only scratch-risky direct hits remain: take the nearest, gently and
  //    with draw, so the cue stops instead of following through into the pocket.
  if (direct.length) {
    const o = direct[0];
    shot.yaw = Math.atan2(o.aim.z - cue.z, o.aim.x - cue.x) + jitter(jRad);
    shot.power = clamp(0.12 + 0.05 * o.d, MIN_POWER, 0.22);
    shot.strikeY = DRAW_STRIKE_Y;   // risky by definition (straight follow line)
    return legalize();
  }

  // 4) Last resort: poke at the nearest legal ball and hope.
  const t = nearestLegal(cue, objects, targets, true);
  if (t) {
    const d = Math.hypot(t.x - cue.x, t.z - cue.z);
    shot.yaw = Math.atan2(t.z - cue.z, t.x - cue.x) + jitter(jRad);
    shot.power = clamp(0.14 + 0.08 * d, MIN_POWER, 0.3);
  }
  return legalize();
}

// Decide where to put the cue ball for ball-in-hand. Candidates are straight-in
// lineups behind each pot line's ghost ball plus random spots; among the legal
// ones (in bounds, not touching a ball) pick the one whose BEST open shot has
// the highest score. Returns {x, z} or null to keep the default spot.
export function computeBotPlacement(table) {
  const objects = table.balls.slice(1);
  const targets = table.legalTargets;
  const pb = table.placeBounds;
  const lines = potLines(objects, targets);

  const candidates = [];
  for (const L of lines) {
    for (const d of [0.3, 0.45, 0.2, 0.6]) {
      candidates.push({ x: L.gx - L.dx * d, z: L.gz - L.dz * d });
    }
  }
  for (let i = 0; i < 64; i++) {
    candidates.push({
      x: pb.minX + Math.random() * (pb.maxX - pb.minX),
      z: pb.minZ + Math.random() * (pb.maxZ - pb.minZ),
    });
  }

  let best = null, bestScore = -Infinity;
  for (const c of candidates) {
    if (c.x < pb.minX || c.x > pb.maxX || c.z < pb.minZ || c.z > pb.maxZ) continue;
    if (objects.some(b => Math.hypot(b.x - c.x, b.z - c.z) < 2 * R + 0.002)) continue;
    const { score } = bestShot(c, openShots(c, objects, targets, lines));
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}
