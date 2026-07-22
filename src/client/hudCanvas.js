// src/client/hudCanvas.js — in-game HUD drawn on a 2D overlay canvas over the 3D
// stage: the strike/spin dial, the left-middle power bar + drag-to-shoot cue
// stick, the current camera view, and the pocketed-ball column. Pure canvas 2D
// drawing; main.js calls drawHud once per render frame with the live values (or
// clearHud outside a game), and input.js hit-tests powerBarRect() for the stick.
import { BALL_COLORS, ballStyle } from '../shared/balldefs.js';
import { CUE_DIMS } from './cue.js';

let cv = null, ctx = null, dpr = 1;

export function initHud(canvasEl) {
  cv = canvasEl;
  ctx = cv.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

// Size the backing store to the element's CSS box × devicePixelRatio so drawing
// stays crisp; all draw code below works in CSS pixels (we scale by dpr).
function resize() {
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  // Full device ratio, uncapped, matching the 3D stage (see scene.js fitCanvas):
  // the HUD is nothing but thin strokes and small type, which is exactly what a
  // capped backing store softens first.
  dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
}

export function clearHud() {
  if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
}

// Height of any chrome covering the bottom of the screen (the replay transport
// bar). Everything bottom-anchored here lays out against the REDUCED height so
// it lifts clear, and dialHitArea agrees with what was drawn.
let bottomInset = 0;

const MARGIN = 16;
const DIAL_R = 46;      // spin dial radius (cue-ball face)
const DOT_R = 8;        // strike-point marker

// state: { strikeX, strikeY (each -1..1), power (0..1), view, pocketed:[numbers] }
export function drawHud(state = {}) {
  if (!ctx) return;
  const { strikeX = 0, strikeY = 0, power = 0, view = 'aim', pocketed = [], ballCount = 15,
          bottomInset: inset = 0 } = state;
  bottomInset = inset;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.scale(dpr, dpr);
  const w = cv.width / dpr, h = cv.height / dpr - bottomInset;

  drawSpinDial(w, h, strikeX, strikeY, view);
  drawPowerStick(power);
  drawPocketed(w, h, pocketed, ballCount);

  ctx.restore();
}

// Geometry of the left-middle power bar, in CSS pixels (shared with input.js,
// which hit-tests it for the drag-to-shoot stick). Null before the HUD inits.
const POWER_BAR_W = 20;
const POWER_BAR_MAXH = 300;
export function powerBarRect() {
  if (!cv) return null;
  const w = cv.width / dpr, h = cv.height / dpr - bottomInset;
  const barH = Math.min(POWER_BAR_MAXH, h * 0.5);
  return { x: MARGIN + 6, yTop: (h - barH) / 2, w: POWER_BAR_W, h: barH };
}

// Geometry of the bottom-left spin dial (cue-ball face), in CSS pixels — shared
// with input.js, which hit-tests it so you can click/drag the strike point.
export function spinDialRect() {
  if (!cv) return null;
  const h = cv.height / dpr - bottomInset;
  return { cx: MARGIN + DIAL_R, cy: h - MARGIN - DIAL_R, r: DIAL_R };
}

// Bottom-left: cue-ball face with crosshair + red strike dot, "Spin" caption above.
function drawSpinDial(w, h, sx, sy, view) {
  const cx = MARGIN + DIAL_R;
  const cy = h - MARGIN - DIAL_R;

  ctx.fillStyle = 'rgba(159,176,216,0.75)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Spin', MARGIN, cy - DIAL_R - 6);

  ctx.beginPath();
  ctx.arc(cx, cy, DIAL_R, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(245,245,245,0.92)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(42,53,102,0.9)';
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - DIAL_R, cy); ctx.lineTo(cx + DIAL_R, cy);
  ctx.moveTo(cx, cy - DIAL_R); ctx.lineTo(cx, cy + DIAL_R);
  ctx.stroke();

  // strikeX +1 = right english, strikeY +1 = top spin (screen up = -y).
  const dx = cx + sx * (DIAL_R - DOT_R);
  const dy = cy - sy * (DIAL_R - DOT_R);
  ctx.beginPath();
  ctx.arc(dx, dy, DOT_R, 0, Math.PI * 2);
  ctx.fillStyle = '#e63946';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#6b1820';
  ctx.stroke();
}

// Left-middle: a vertical power bar with a cue stick over it (tip at the top).
// Dragging the stick down builds power; the tip marks how much (top = 0, bottom
// = full). The stick is drawn with the REAL cue's proportions (CUE_DIMS) scaled
// so its butt is STICK_BUTT_PX wide — that makes it far longer than the bar, so
// it keeps a constant length and is simply clipped at the bar bottom. `power` 0..1.
const STICK_BUTT_PX = 7;
function drawPowerStick(power) {
  const b = powerBarRect();
  if (!b) return;
  const { x, yTop, w: bw, h: bh } = b;
  const p = Math.max(0, Math.min(1, power));
  const tipY = yTop + p * bh;

  // Track.
  ctx.fillStyle = 'rgba(12,18,48,0.85)';
  roundRect(x, yTop, bw, bh, 8); ctx.fill();

  // Power fill (top → tip), green → yellow → red.
  if (p > 0.001) {
    const grad = ctx.createLinearGradient(0, yTop, 0, yTop + bh);
    grad.addColorStop(0, '#2ecc71');
    grad.addColorStop(0.5, '#f1c40f');
    grad.addColorStop(1, '#e63946');
    ctx.save();
    roundRect(x, yTop, bw, bh, 8); ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(x, yTop, bw, tipY - yTop);
    ctx.restore();
  }

  // Track border.
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(42,53,102,0.9)';
  roundRect(x, yTop, bw, bh, 8); ctx.stroke();

  // Cue stick with the REAL cue's proportions (scaled so the butt is
  // STICK_BUTT_PX wide). tip → butt over CUE_DIMS.len, so it's much longer than
  // the bar and gets clipped at the bottom — constant length, never rescaled.
  const cx = x + bw / 2;
  const sc = STICK_BUTT_PX / CUE_DIMS.buttR;   // px per game-metre
  const tipR = CUE_DIMS.tipR * sc;
  const buttR = CUE_DIMS.buttR * sc;
  const buttY = tipY + CUE_DIMS.len * sc;
  const ferruleLen = 0.02 * sc;                // real ferrule is ~0.02 m
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, yTop, bw, bh);                    // clip to the bar
  ctx.clip();
  // Shaft (tip → butt).
  ctx.beginPath();
  ctx.moveTo(cx - tipR, tipY);
  ctx.lineTo(cx + tipR, tipY);
  ctx.lineTo(cx + buttR, buttY);
  ctx.lineTo(cx - buttR, buttY);
  ctx.closePath();
  ctx.fillStyle = '#b98a4a'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
  // White ferrule at the very tip.
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(cx - tipR * 1.05, tipY, tipR * 2.1, ferruleLen);
  ctx.restore();

  // Tip indicator line across the bar.
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x - 5, tipY); ctx.lineTo(x + bw + 5, tipY); ctx.stroke();

  // Caption + percent.
  ctx.fillStyle = 'rgba(159,176,216,0.9)'; ctx.font = '11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('Power', cx, yTop - 8);
  if (p > 0.001) {
    ctx.fillStyle = 'rgba(231,238,247,0.95)'; ctx.textBaseline = 'top';
    ctx.fillText(`${Math.round(p * 100)}%`, cx, yTop + bh + 6);
  }
}

// Right side: one slot per object ball 1..count in numerical order, stacked
// top-down (15 for 8-ball, 9 for 9-ball). A potted ball shows the real ball; a
// ball still in play shows an empty circle. If a single column would run down
// into the bottom-right controls, it wraps into extra columns growing leftward.
const POCKET_BOTTOM_RESERVE = 155;   // keep clear of the bottom-right zoom / free-cam buttons
function drawPocketed(w, h, pocketed, count = 15) {
  const potted = new Set(pocketed || []);
  const r = 13, gap = 6, step = 2 * r + gap;
  const top = MARGIN + r;
  const usable = h - top - r - POCKET_BOTTOM_RESERVE;   // vertical room for slot centres
  const maxRows = Math.min(count, Math.max(1, Math.floor(usable / step) + 1));
  const cols = Math.ceil(count / maxRows);
  for (let n = 1; n <= count; n++) {
    const i = n - 1;
    const col = Math.floor(i / maxRows);
    const row = i % maxRows;
    // Columns read left → right in order: the first (lowest-numbered) column is
    // leftmost; the last column is anchored to the right edge.
    const x = w - MARGIN - r - (cols - 1 - col) * step;
    const y = top + row * step;
    if (potted.has(n)) drawBall(x, y, r, n);
    else drawEmptySlot(x, y, r);
  }
}

// An empty placeholder for a ball still on the table.
function drawEmptySlot(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.stroke();
}

function drawBall(x, y, r, n) {
  const color = BALL_COLORS[n] || '#ffffff';
  const stripe = ballStyle(n) === 'stripe';

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  if (stripe) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.fillStyle = color;
    ctx.fillRect(x - r, y - r * 0.5, 2 * r, r);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  ctx.beginPath();
  ctx.arc(x, y, r * 0.56, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.stroke();

  ctx.fillStyle = '#111111';
  ctx.font = `bold ${Math.round(r * 0.8)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x, y + 0.5);
}

function roundRect(x, y, w, h, rad) {
  const r = Math.min(rad, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
