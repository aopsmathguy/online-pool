// src/client/hudCanvas.js — in-game HUD drawn on a 2D overlay canvas over the 3D
// stage: the strike/spin dial, the power meter, the current camera view, and the
// pocketed balls. Pure canvas 2D drawing (no DOM widgets); main.js calls drawHud
// once per render frame with the live values, or clearHud outside a game.
import { BALL_COLORS, ballStyle } from '../shared/balldefs.js';

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
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
}

export function clearHud() {
  if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
}

const VIEW_LABELS = { aim: 'Aim (down cue)', free: 'Free fly-around', top: 'Overhead' };
const MARGIN = 16;
const DIAL_R = 46;      // spin dial radius (cue-ball face)
const DOT_R = 8;        // strike-point marker

// state: { strikeX, strikeY (each -1..1), power (0..1), view, pocketed:[numbers] }
export function drawHud(state = {}) {
  if (!ctx) return;
  const { strikeX = 0, strikeY = 0, power = 0, view = 'aim', pocketed = [] } = state;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.scale(dpr, dpr);
  const w = cv.width / dpr, h = cv.height / dpr;

  drawSpinDial(w, h, strikeX, strikeY, view);
  drawPowerMeter(w, h, power);
  drawViewLabel(w, h, view);
  drawPocketed(w, h, pocketed);

  ctx.restore();
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

// Vertical meter right of the dial; fills bottom→top, green→yellow→red.
function drawPowerMeter(w, h, power) {
  const bw = 16;
  const bh = 2 * DIAL_R;
  const x = MARGIN + 2 * DIAL_R + 16;
  const y = h - MARGIN - bh;
  const p = Math.max(0, Math.min(1, power));

  ctx.fillStyle = 'rgba(12,18,48,0.85)';
  roundRect(x, y, bw, bh, 6); ctx.fill();

  if (p > 0.001) {
    const fh = bh * p;
    const grad = ctx.createLinearGradient(0, y + bh, 0, y);
    grad.addColorStop(0, '#2ecc71');
    grad.addColorStop(0.5, '#f1c40f');
    grad.addColorStop(1, '#e63946');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y + bh - fh, bw, fh);
  }

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(42,53,102,0.9)';
  roundRect(x, y, bw, bh, 6); ctx.stroke();

  ctx.fillStyle = 'rgba(159,176,216,0.75)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Power', x + bw / 2, y - 6);
}

// Bottom-left row, right of the power meter: the current camera view.
function drawViewLabel(w, h, view) {
  const bw = 16;                                  // power-meter width (mirrors drawPowerMeter)
  const x = MARGIN + 2 * DIAL_R + 16 + bw + 20;   // just past the meter
  const cy = h - MARGIN - DIAL_R;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(231,238,247,0.92)';
  ctx.font = '13px sans-serif';
  ctx.fillText(`View: ${VIEW_LABELS[view] || view}`, x, cy - 6);
  ctx.fillStyle = 'rgba(159,176,216,0.75)';
  ctx.font = '11px sans-serif';
  ctx.fillText('V to cycle', x, cy + 12);
}

// Top-centre: a row of the pocketed balls (real solid/stripe colours + number).
function drawPocketed(w, h, pocketed) {
  if (!pocketed || !pocketed.length) return;
  const r = 18, gap = 9;
  const total = pocketed.length * (2 * r + gap) - gap;
  let x = (w - total) / 2 + r;
  const y = MARGIN + r;
  for (const n of pocketed) { drawBall(x, y, r, n); x += 2 * r + gap; }
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
