// src/server/ai.js — server-side computer opponent ("ghost-ball" aimer), v2.
//
// The bot picks a shot by a single geometric measure, `shotEase` (bigger =
// easier), computed for every (legal object ball, pocket) pair, and plays the
// easiest one. The measure and the aim geometry are built as follows.
//
// AIM DIRECTION for the object ball. Let the pocket mouth have endpoints p1, p2,
// the object ball be at O and the cue ball at C.
//   * If O is already PAST the p1–p2 line (on the pocket side of the mouth), we
//     just roll it on straight: the desired direction is C→O extended.
//   * Otherwise we build the two jaw-clearance points
//         x1 = p1 + R·bisector(∠O p1 p2)      (R from p1, on that bisector)
//         x2 = p2 + R·bisector(∠O p2 p1)      (R from p2, on that bisector)
//     — the points a ball centre must pass to clear each jaw — and aim the
//     object ball along the bisector of ∠x1 O x2. θ3 = ∠x1 O x2 is how wide the
//     usable mouth looks from the ball: the whole aiming window.
//
// GHOST BALL. Extend the desired object direction backward from O by 2R to the
// aim point A (the ghost-ball centre the cue must arrive at). With that triangle
// A-O-C: θ2 = ∠A O C (the cut angle at the object ball), θ1 = ∠A C O (the angle
// at the cue between the aim line and the line to the object), d1 = |C−O|.
//
// EASE. shotEase = θ3 / ( d1·cosθ1 / (2R·cos(θ1+θ2)) − 1 ). A wide mouth (large
// θ3) over a small denominator scores high; the denominator grows with distance
// and with the cut, so far/thin shots score low. θ1+θ2 must be acute for the
// shot to be makeable at all — when it is, the denominator is positive.
//
// POSSIBLE? A shot is discarded (never played as a pot) when θ1+θ2 is not acute,
// the ghost lies off the table, or a ball other than the target sits within 2R
// of either the cue→ghost segment or the object→mouth segment.
//
// With NO makeable pot the bot plays safe: for each legal ball it measures how
// EASY it is to merely CONTACT — the angular width of aim directions from C that
// strike the 2R disc around the ball, after removing the shadow of every ball
// lying across the way (each an ∠-window of its own). It hits the ball with the
// widest surviving window, aiming down that window's bisector. If even that is
// impossible for every ball, it falls back to a one-rail kick, then a poke.
//
// Server-only (driven from botClient.js) but lives in src/ beside the headless
// game logic. It reads a plain table snapshot (RoomSim.readTable()) and touches
// no Ammo, no rules object and no simulation state — a pure function of that
// snapshot.
import {
  tableW, tableH, R, g, mu_felt_linear, rodR, wireY,
} from '../shared/constants.js';
import { rail_pts } from '../shared/table.js';
import { SHOT_IMPULSE_PER_M } from './strike.js';
import { legalPitch, densify } from '../shared/clearance.js';
import { POCKET_MOUTHS as POCKETS } from '../shared/pockets.js';

// --- Tunables -----------------------------------------------------------------
const JITTER_EASIEST_RAD = 0.07;   // difficulty 0: ~4° of aim error — misses most pots
const MAX_POWER = 0.825;           // client's PULLBACK_MAX (see cue.js)
const MIN_POWER = 0.16;            // never just dribble a ball in
const POCKET_SPEED_MARGIN = 3.5;   // arrive at the pocket briskly, not just barely
const A_FELT = mu_felt_linear * g; // felt deceleration applied by stepAndApplyFriction
const EPS = 1e-9;

// Sampled rail cushion for cue-stick clearance checks (same data the server uses
// to enforce the elevation floor in applyShoot).
const RAIL_CLEAR_PTS = densify(rail_pts(tableW, tableH));

// --- Small helpers ------------------------------------------------------------
function jitter(rad) { return (Math.random() + Math.random() - 1) * rad; }   // triangular
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Aim-error half-width for a difficulty in [0..1] (0 = easiest, 1 = hardest).
// Quadratic in the headroom left on the slider: zero at difficulty 1.
function aimJitterRad(difficulty) {
  const t = clamp(difficulty, 0, 1);
  const headroom = 1 - t;
  return JITTER_EASIEST_RAD * headroom * headroom;
}

function unit(dx, dz) {
  const l = Math.hypot(dx, dz);
  return l < EPS ? null : { x: dx / l, z: dz / l };
}
// Angle between two UNIT vectors, in [0, π].
function angleU(a, b) { return Math.acos(clamp(a.x * b.x + a.z * b.z, -1, 1)); }

function distPointSegSq(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz || 1e-12;
  const t = clamp(((px - ax) * abx + (pz - az) * abz) / len2, 0, 1);
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return dx * dx + dz * dz;
}

// Is the corridor from A to B free of every ball not in `skip`? `width` scales
// the corridor: 1 = exactly one ball wide (a ball within 2R blocks it).
function pathClear(ax, az, bx, bz, balls, skip, width = 1) {
  const rr = (2 * R * width) ** 2;
  for (const b of balls) {
    if (skip && skip.includes(b)) continue;
    if (distPointSegSq(b.x, b.z, ax, az, bx, bz) < rr) return false;
  }
  return true;
}

function inBounds(x, z, margin = R * 0.9) {
  return Math.abs(x) <= tableW / 2 - margin && Math.abs(z) <= tableH / 2 - margin;
}

// Jaw-clearance point: `from` + R along the bisector of the angle at `from`
// between (from→toward) and (from→ball). This is x1 (from=p1,toward=p2) and x2
// (from=p2,toward=p1) — the point a ball centre must reach to just clear the jaw.
function bisectorPoint(from, toward, ball) {
  const a = unit(toward.x - from.x, toward.z - from.z);
  const b = unit(ball.x - from.x, ball.z - from.z);
  if (!a || !b) return null;
  const h = unit(a.x + b.x, a.z + b.z);            // sum of unit dirs = bisector
  if (!h) return null;
  return { x: from.x + h.x * R, z: from.z + h.z * R };
}

// --- Pot evaluation -----------------------------------------------------------
// The whole per-(ball,pocket) geometry. Returns a shot descriptor with `ease`
// (bigger = easier) plus everything the shooter needs, or null when the shot is
// not a makeable pot (bad angle, ghost off-table, or a corridor blocked).
//
// WHAT `ease` IS — and where its denominator comes from.
//
//   ease = θ3 / ( d1·cosθ1 / (2R·cos(θ1+θ2)) − 1 )
//
// θ3 is the pocket window seen from the object ball O (angle ∠x1 O x2): the span
// of OBJECT-BALL directions that still drop. θ1 is the angle at the cue (∠A C O),
// θ2 the cut angle at the ball (∠A O C), in triangle A-O-C where A is the ghost
// (2R from O). The denominator is an ERROR-AMPLIFICATION FACTOR — it is exactly
// the derivative of the object ball's launch direction with respect to the cue's
// aim angle, so dividing θ3 by it converts the pocket window from object-ball
// space into CUE-AIM space:  ease = the angular width of the aiming window that
// still sinks the ball (your margin for aim error, in radians).
//
// Derivation of the denominator. Contact happens when the two centres are 2R
// apart, so the cue centre meets a circle of radius 2R about O at a point P; the
// ball launches along P→O, whose angle β tracks P around that circle 1:1. For P
// seen from the fixed cue C, dβ/dφ = r / (2R·sinγ), with r = |CA| the cue→ghost
// distance and γ the angle between the sightline and the circle's tangent at the
// contact. From triangle A-O-C: r = 2R·sinθ2/sinθ1 and sinγ = cos(θ1+θ2) (the
// interior angle at A is π−θ1−θ2), so
//   dβ/dφ = sinθ2 / (sinθ1·cos(θ1+θ2)) = tan(θ1+θ2)/tanθ1 − 1,
// and the law of sines (d1·sinθ1 = 2R·sin(θ1+θ2)) rewrites that as the
// d1/(2R)/cos form used below. Limits check out: a dead-straight pot has θ2 = 0,
// denominator 0, ease → ∞ (huge aim margin); as θ1+θ2 → 90° the cos → 0, the
// sensitivity blows up and ease → 0 — which is exactly the makeability gate.
function evalPot(cue, t, p, objects) {
  const p1 = p.e1, p2 = p.e2;
  const O = { x: t.x, z: t.z }, C = { x: cue.x, z: cue.z };

  // Jaw-clearance points and the mouth window angle θ3 seen from the ball.
  const x1 = bisectorPoint(p1, p2, O);
  const x2 = bisectorPoint(p2, p1, O);
  if (!x1 || !x2) return null;
  const ox1 = unit(x1.x - O.x, x1.z - O.z);
  const ox2 = unit(x2.x - O.x, x2.z - O.z);
  if (!ox1 || !ox2) return null;
  // θ3 is SIGNED. angleU (acos) only ever gives |θ3|, so an inverted window —
  // where the two jaw-clearance directions have crossed and no object-ball
  // direction actually drops — would still read as a positive, open window.
  // Orient the window by the mouth as seen from O (sweep O→p1 → O→p2): a valid
  // pot sweeps O→x1 → O→x2 the same way. When it sweeps the other way the pot is
  // impossible and θ3 comes out negative, which the `ease > 0` gate then rejects.
  const op1 = unit(p1.x - O.x, p1.z - O.z);
  const op2 = unit(p2.x - O.x, p2.z - O.z);
  if (!op1 || !op2) return null;
  const refSign = Math.sign(op1.x * op2.z - op1.z * op2.x);
  const theta3 = refSign * Math.atan2(
    ox1.x * ox2.z - ox1.z * ox2.x,   // cross(ox1, ox2)
    ox1.x * ox2.x + ox1.z * ox2.z,   // dot(ox1, ox2)
  );

  // Desired object-ball direction. If the ball is past the mouth line (pocket
  // side, (O−mouth)·n > 0 since n points toward the pocket), roll it in straight
  // along C→O; otherwise send it down the bisector of the mouth window.
  const past = (O.x - p.x) * p.nx + (O.z - p.z) * p.nz > 0;
  let dir;
  if (past) {
    dir = unit(O.x - C.x, O.z - C.z);
  } else {
    dir = unit(ox1.x + ox2.x, ox1.z + ox2.z);
  }
  if (!dir) return null;

  // Ghost ball A: extend the desired direction backward from O by 2R.
  const A = { x: O.x - dir.x * 2 * R, z: O.z - dir.z * 2 * R };
  if (!inBounds(A.x, A.z)) return null;                 // cue can't sit there

  // Triangle A-O-C angles.
  const oa = unit(A.x - O.x, A.z - O.z);                // = −dir
  const oc = unit(C.x - O.x, C.z - O.z);
  const ca = unit(A.x - C.x, A.z - C.z);
  const co = unit(O.x - C.x, O.z - C.z);
  if (!oa || !oc || !ca || !co) return null;
  const theta2 = angleU(oa, oc);                        // cut angle at the ball
  const theta1 = angleU(ca, co);                        // angle at the cue
  const d1 = Math.hypot(C.x - O.x, C.z - O.z);

  if (theta1 + theta2 >= Math.PI / 2 - 1e-6) return null;   // not makeable
  // denom = dβ/dφ, object-direction sensitivity to aim error (see header).
  const denom = d1 * Math.cos(theta1) / (2 * R * Math.cos(theta1 + theta2)) - 1;
  if (denom <= EPS) return null;
  const ease = theta3 / denom;                          // θ3 in object space ÷ sensitivity = aim margin
  if (!(ease > 0) || !isFinite(ease)) return null;

  // Corridor checks: cue→ghost and object→mouth must be clear of other balls.
  if (!pathClear(C.x, C.z, A.x, A.z, objects, [t])) return null;

  // Object path runs from O to where its aim ray crosses the mouth line p1p2
  // (falling back to the pocket centre if the ray doesn't cross ahead).
  const ex = p2.x - p1.x, ez = p2.z - p1.z;             // mouth-line direction
  const nlx = ez, nlz = -ex;                            // mouth-line normal
  const denL = dir.x * nlx + dir.z * nlz;
  let mouth;
  if (Math.abs(denL) > EPS) {
    const tt = -((O.x - p1.x) * nlx + (O.z - p1.z) * nlz) / denL;
    mouth = tt > 1e-6 ? { x: O.x + dir.x * tt, z: O.z + dir.z * tt } : { x: p.x, z: p.z };
  } else {
    mouth = { x: p.x, z: p.z };
  }
  if (!pathClear(O.x, O.z, mouth.x, mouth.z, objects, [t])) return null;

  const dCue = Math.hypot(A.x - C.x, A.z - C.z);
  const dPocket = Math.hypot(O.x - p.x, O.z - p.z);
  return { t, p, gx: A.x, gz: A.z, ease, dCue, dPocket, cutCos: Math.cos(theta2) };
}

// Every makeable pot from `cue`, and the easiest of them.
function potShots(cue, objects, targetNumbers) {
  const shots = [];
  for (const t of objects) {
    if (!targetNumbers.includes(t.number)) continue;
    for (const p of POCKETS) {
      const s = evalPot(cue, t, p, objects);
      if (s) shots.push(s);
    }
  }
  return shots;
}
function bestPot(shots) {
  let best = null;
  for (const s of shots) if (!best || s.ease > best.ease) best = s;
  return best;
}

// Cue-independent ghost-ball centre for (ball, pocket): O extended 2R back along
// the mouth-window bisector. Used only to seed ball-in-hand candidate spots.
function ghostPoint(t, p) {
  const x1 = bisectorPoint(p.e1, p.e2, t);
  const x2 = bisectorPoint(p.e2, p.e1, t);
  if (!x1 || !x2) return null;
  const ox1 = unit(x1.x - t.x, x1.z - t.z);
  const ox2 = unit(x2.x - t.x, x2.z - t.z);
  if (!ox1 || !ox2) return null;
  const dir = unit(ox1.x + ox2.x, ox1.z + ox2.z);
  if (!dir) return null;
  return { x: t.x - dir.x * 2 * R, z: t.z - dir.z * 2 * R, dirx: dir.x, dirz: dir.z };
}

// Power for a pot: arrive at the pocket still rolling (margin), work backwards
// through the collision (target gets ≈ cutCos of the cue speed) and the felt
// drag over the cue's run-up. `power` is the client-side pullback in metres;
// launch speed = power · SHOT_IMPULSE_PER_M (see resolveStrike in strike.js).
function potPower({ dCue, dPocket, cutCos }) {
  const vPocket = Math.sqrt(2 * A_FELT * dPocket) * POCKET_SPEED_MARGIN;
  const vContact = vPocket / Math.max(cutCos, 0.25);
  const v0 = Math.sqrt(vContact * vContact + 2 * A_FELT * dCue);
  return clamp(v0 / SHOT_IMPULSE_PER_M, MIN_POWER, MAX_POWER);
}

// --- Safety: easiest ball to CONTACT ------------------------------------------
// The angular window of aim directions from the cue that strike the 2R disc
// around ball `t`, minus the shadow of every ball crossing the way. Returns the
// window's width (bigger = easier; Infinity difficulty ⇒ null) and its bisector
// aim angle, or null if the ball can't be hit at all.
const HIT_COLLECT = 4 * R;         // blockers within this of the C→O line count

function halfAngle(dist) {
  // Half-angle of the cone from the cue subtending a 2R disc at `dist`.
  return dist <= 2 * R ? Math.PI / 2 : Math.asin(2 * R / dist);
}

// Subtract [flo,fhi] from a list of disjoint intervals.
function subtract(ivs, flo, fhi) {
  const out = [];
  for (const [a, c] of ivs) {
    if (fhi <= a || flo >= c) { out.push([a, c]); continue; }
    if (flo > a) out.push([a, flo]);
    if (fhi < c) out.push([fhi, c]);
  }
  return out;
}

function hitWindow(cue, t, objects) {
  const u = unit(t.x - cue.x, t.z - cue.z);
  if (!u) return null;
  const d = Math.hypot(t.x - cue.x, t.z - cue.z);
  const base = Math.atan2(t.z - cue.z, t.x - cue.x);   // centre aim angle
  const px = -u.z, pz = u.x;                            // unit perpendicular

  let ivs = [[-halfAngle(d), halfAngle(d)]];            // relative to `base`
  for (const b of objects) {
    if (b === t) continue;
    const rx = b.x - cue.x, rz = b.z - cue.z;
    const along = rx * u.x + rz * u.z;
    if (along <= EPS || along >= d) continue;           // not between cue and ball
    if (Math.abs(rx * px + rz * pz) > HIT_COLLECT) continue;   // too far off the line
    const db = Math.hypot(rx, rz);
    const rel = Math.atan2(rz, rx) - base;              // blocker's angle, relative
    const wrapped = Math.atan2(Math.sin(rel), Math.cos(rel));
    const ab = halfAngle(db);
    ivs = subtract(ivs, wrapped - ab, wrapped + ab);
    if (!ivs.length) return null;
  }
  let win = ivs[0];
  for (const iv of ivs) if (iv[1] - iv[0] > win[1] - win[0]) win = iv;
  return { width: win[1] - win[0], aim: base + (win[0] + win[1]) / 2, d };
}

// Easiest legal ball to contact (widest surviving window), or null.
function easiestContact(cue, objects, targetNumbers) {
  let best = null;
  for (const t of objects) {
    if (!targetNumbers.includes(t.number)) continue;
    const w = hitWindow(cue, t, objects);
    if (w && (!best || w.width > best.width)) best = { t, ...w };
  }
  return best;
}

// --- Bank (one-rail kick), the last structured fallback -----------------------
// See the long note kept from v1: a rolling ball does not mirror off a cushion,
// so the reflection line is inset and the outgoing angle behaves like
// tanθ_out = E_RAIL_EFF·tanθ_in. Both legs demand a wider corridor.
const RAIL_BOUNCE_INSET = Math.sqrt((R + rodR) ** 2 - (wireY - R) ** 2);
const RAIL_LINES = [
  { axis: 'x', pos:  tableW / 2 - RAIL_BOUNCE_INSET }, { axis: 'x', pos: -tableW / 2 + RAIL_BOUNCE_INSET },
  { axis: 'z', pos:  tableH / 2 - RAIL_BOUNCE_INSET }, { axis: 'z', pos: -tableH / 2 + RAIL_BOUNCE_INSET },
];
const E_RAIL_EFF = 0.85;            // effective rebound compression (calibrated)
const KICK_POCKET_KEEPOUT = 0.18;   // bounce point must stay off the pocket mouths
const KICK_CLEAR = 1.35;            // corridor width factor for kick legs

function kickShots(cue, objects, targetNumbers) {
  const shots = [];
  for (const t of objects) {
    if (!targetNumbers.includes(t.number)) continue;
    for (const L of RAIL_LINES) {
      const onX = L.axis === 'x';
      const a = onX ? L.pos - cue.x : L.pos - cue.z;
      const c = onX ? L.pos - t.x : L.pos - t.z;
      if (Math.abs(a) < 0.05 || Math.abs(c) < 0.05) continue;
      const cueTan = onX ? cue.z : cue.x;
      const tTan = onX ? t.z : t.x;
      const bTan = cueTan + (tTan - cueTan) * Math.abs(a) / (Math.abs(a) + Math.abs(c) / E_RAIL_EFF);
      const b = onX ? { x: L.pos, z: bTan } : { x: bTan, z: L.pos };
      if (Math.abs(b.x) > tableW / 2 - R + 1e-6 || Math.abs(b.z) > tableH / 2 - R + 1e-6) continue;
      if (POCKETS.some(p => Math.hypot(p.x - b.x, p.z - b.z) < KICK_POCKET_KEEPOUT)) continue;
      if (!pathClear(cue.x, cue.z, b.x, b.z, objects, null, KICK_CLEAR)) continue;
      if (!pathClear(b.x, b.z, t.x, t.z, objects, [t], KICK_CLEAR)) continue;
      const leg1 = Math.hypot(b.x - cue.x, b.z - cue.z);
      const leg2 = Math.hypot(t.x - b.x, t.z - b.z);
      shots.push({ t, b, distEff: leg1 + leg2 / E_RAIL_EFF });
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

// The one spin the bot uses: on a near-straight pot the pocket is dead ahead, so
// the cue would follow the object ball in. A little draw stops it at contact.
const DRAW_STRIKE_Y = -0.5;
const DRAW_CUT_COS = 0.9;        // only near-straight pots follow the target line
const DRAW_POWER_PER_M = 0.22;   // backspin decays over the run — boost per metre

// --- Public API ---------------------------------------------------------------
// Decide the bot's shot for the current position. `difficulty` in [0..1] scales
// only the aim inaccuracy (0 = wild, 1 = near-perfect). Returns the params the
// client's `shoot` packet carries: { yaw, pitch, strikeX, strikeY, power }.
export function computeBotShot(table, difficulty = 0.5) {
  const cue = table.balls[0];
  const objects = table.balls.slice(1);
  const targets = table.legalTargets;
  const shot = { yaw: 0, pitch: 0.06, strikeX: 0, strikeY: 0, power: 0.3 };
  const jRad = aimJitterRad(difficulty);

  // Legal cue elevation: with a ball or the rail cushion behind the cue ball the
  // stick must be jacked up to clear it. Same call the server makes in
  // resolveStrike, on the same obstacles and rail sampling — so the floor here is
  // the floor the server enforces. Always called last, once yaw and strikeY are
  // final; power is compensated for the reduced horizontal launch component.
  const legalize = () => {
    shot.pitch = legalPitch(shot.pitch, {
      cx: cue.x, cz: cue.z, yaw: shot.yaw, strikeY: shot.strikeY,
      obstacles: objects, railPts: RAIL_CLEAR_PTS,
    });
    shot.power = clamp(shot.power / Math.max(0.4, Math.cos(shot.pitch)), MIN_POWER, MAX_POWER);
    return shot;
  };

  // Break: smash the nearest legal ball dead straight at full power, no jitter.
  if (table.isBreak) {
    const t = nearestLegal(cue, objects, targets, false);
    if (t) shot.yaw = Math.atan2(t.z - cue.z, t.x - cue.x);
    shot.power = MAX_POWER;
    return legalize();
  }

  // Easiest makeable pot.
  const s = bestPot(potShots(cue, objects, targets));
  if (s) {
    shot.yaw = Math.atan2(s.gz - cue.z, s.gx - cue.x) + jitter(jRad);
    shot.power = potPower(s);
    if (s.cutCos > DRAW_CUT_COS) {   // near-straight: draw so the cue doesn't follow in
      shot.strikeY = DRAW_STRIKE_Y;
      const d1 = Math.hypot(s.t.x - cue.x, s.t.z - cue.z);
      shot.power = clamp(shot.power + DRAW_POWER_PER_M * d1, MIN_POWER, MAX_POWER);
    }
    return legalize();
  }

  // No pot: safety — hit the legal ball that is easiest to contact.
  const hit = easiestContact(cue, objects, targets);
  if (hit) {
    shot.yaw = hit.aim + jitter(jRad);
    shot.power = clamp(0.14 + 0.08 * hit.d, MIN_POWER, 0.32);
    return legalize();
  }

  // Every legal ball blocked: one-rail kick.
  const kicks = kickShots(cue, objects, targets);
  if (kicks.length) {
    const k = kicks.reduce((a, b) => (a.distEff <= b.distEff ? a : b));
    shot.yaw = Math.atan2(k.b.z - cue.z, k.b.x - cue.x) + jitter(jRad);
    shot.power = clamp(0.20 + 0.12 * k.distEff, MIN_POWER, 0.5);
    return legalize();
  }

  // Last resort: poke at the nearest legal ball and hope.
  const t = nearestLegal(cue, objects, targets, true);
  if (t) {
    const d = Math.hypot(t.x - cue.x, t.z - cue.z);
    shot.yaw = Math.atan2(t.z - cue.z, t.x - cue.x) + jitter(jRad);
    shot.power = clamp(0.14 + 0.08 * d, MIN_POWER, 0.3);
  }
  return legalize();
}

// Decide where to put the cue ball for ball-in-hand. Candidates are straight-in
// lineups behind each pot's ghost ball plus random spots; among the legal ones
// (in bounds, not touching a ball) pick the one whose easiest pot scores highest.
export function computeBotPlacement(table) {
  const objects = table.balls.slice(1);
  const targets = table.legalTargets;
  const pb = table.placeBounds;

  const candidates = [];
  // Behind each ghost, along the line from ghost away from its pocket.
  for (const t of objects) {
    if (!targets.includes(t.number)) continue;
    for (const p of POCKETS) {
      const g = ghostPoint(t, p);
      if (!g) continue;
      for (const d of [0.3, 0.45, 0.2, 0.6]) {           // back along −dir, away from pocket
        candidates.push({ x: g.x - g.dirx * d, z: g.z - g.dirz * d });
      }
    }
  }
  for (let i = 0; i < 64; i++) {
    candidates.push({
      x: pb.minX + Math.random() * (pb.maxX - pb.minX),
      z: pb.minZ + Math.random() * (pb.maxZ - pb.minZ),
    });
  }

  let best = null, bestEase = -Infinity;
  for (const c of candidates) {
    if (c.x < pb.minX || c.x > pb.maxX || c.z < pb.minZ || c.z > pb.maxZ) continue;
    if (objects.some(b => Math.hypot(b.x - c.x, b.z - c.z) < 2 * R + 0.002)) continue;
    const s = bestPot(potShots(c, objects, targets));
    const ease = s ? s.ease : -Infinity;
    if (ease > bestEase) { best = c; bestEase = ease; }
  }
  return best;
}
