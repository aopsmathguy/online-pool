// src/balls.view.js — client-side ball rendering. No physics here: meshes are
// keyed by the server's ball id and driven purely by streamed transforms.
// The texture/mesh code is ported from the old balls.js (incl. two numbers on
// opposite sides of each ball).
import * as THREE from "/lib/three.module.js";
import { scene } from './scene.js';
import { TEX_V_STRETCH, R, RACK_QUAT } from '../shared/constants.js';
import { BALL_COLORS, ballStyle } from '../shared/balldefs.js';
import { isInsideAnyPocket } from '../shared/pockets.js';
import { qualityLevel, onQualityChange } from './settings.js';

function makeBallTexture({ style, color = "#ffffff", number = null }) {
  const q = qualityLevel();
  // Drawn, not loaded, so the graphics preset picks the size straight up front:
  // there are ~16 of these live and they are the only textures on the balls, so
  // 1024 -> 256 is 16x off the whole rack's texture memory. Every coordinate
  // below is a fraction of `size`, so the artwork just scales.
  const size = q.ballTex;
  const sY = TEX_V_STRETCH;
  const c0 = document.createElement('canvas'); c0.width = c0.height = size;
  const ctx0 = c0.getContext('2d');

  const fill = col => { ctx0.fillStyle = col; ctx0.fillRect(0, 0, size, size); };
  const circle = (x, y, r, col) => { ctx0.beginPath(); ctx0.arc(x, y, r, 0, Math.PI * 2); ctx0.fillStyle = col; ctx0.fill(); };
  const drawNumber = (x, y, px) => {
    ctx0.fillStyle = "#111"; ctx0.font = `bold ${Math.floor(px)}px sans-serif`;
    ctx0.textAlign = "center"; ctx0.textBaseline = "middle"; ctx0.fillText(String(number), x, y);
  };

  if (style === "cue") {
    fill("#ffffff");
    circle(size * 0.1, size * 0.50, size * 0.03, "#c92626");
    circle(size * 0.35, size * 0.50, size * 0.03, "#c92626");
    circle(size * 0.6, size * 0.50, size * 0.03, "#c92626");
    circle(size * 0.85, size * 0.50, size * 0.03, "#c92626");
    ctx0.fillStyle = "#c92626";
    ctx0.fillRect(0, size * 0.75 - size * 0.03, size, size * 0.03);
    ctx0.fillRect(0, size * 0.25, size, size * 0.03);
  } else if (style === "solid" || style === "stripe") {
    if (style === "solid") {
      fill(color);
    } else {
      fill("#ffffff");
      const bandH = Math.floor(size * 0.2);
      ctx0.fillStyle = color;
      ctx0.fillRect(0, Math.floor((size - bandH) / 2), size, bandH);
    }
    // Two numbered faces on diametrically opposite sides (u = 0.25 and 0.75 on
    // the equator map to antipodal points on the sphere).
    const drawFace = (cx) => {
      circle(cx, size * 0.50, size * 0.08, "#ffffff");
      if (number != null) drawNumber(cx, size * 0.50, size * 0.12);
    };
    drawFace(size * 0.25);
    drawFace(size * 0.75);
  }

  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  const pad = (sY - 1) * size / 2;
  ctx.drawImage(c0, 0, 0, size, size, 0, -pad, size, size * sY);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = q.anisotropy; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

// Geometry and textures are shared across every ball and live for the whole
// session: syncRack rebuilds meshes after most shots, and at this tessellation
// /texture size re-allocating per mesh would churn megabytes each time. Nothing
// below is ever disposed — only the per-mesh material is (see removeBallView).
const BALL_GEO = new THREE.SphereGeometry(R, 64, 48);
const MARK_GEO = new THREE.SphereGeometry(R * 0.18, 24, 16);
const texCache = new Map();
function ballTexture({ style, color, number }) {
  const key = `${style}|${color}|${number}`;
  let tex = texCache.get(key);
  if (!tex) { tex = makeBallTexture({ style, color, number }); texCache.set(key, tex); }
  return tex;
}

function makeBallMesh({ style, color, number = null }) {
  const map = ballTexture({ style, color, number });
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.05, metalness: 0.0 });
  const mesh = new THREE.Mesh(BALL_GEO, mat);
  mesh.castShadow = true; mesh.receiveShadow = false;

  const mark = new THREE.Mesh(MARK_GEO,
    new THREE.MeshBasicMaterial({ color: 0xff2b2b }));
  mark.position.set(R * 0.7, R * 0.2, R * 0.1);
  mesh.add(mark);

  scene.add(mesh);
  return mesh;
}

// --- id-keyed registry ------------------------------------------------------
const views = new Map();   // id -> { mesh, number, style, color }

// Quality changed: the cached textures are the wrong size now. Redraw them at
// the new one and re-point every live ball's material at its replacement — the
// meshes themselves are untouched, so a rebuild mid-shot can't disturb a
// replay's poses. `color` is carried in the view record purely so a ball can be
// re-textured here without going back to BALL_COLORS for it.
onQualityChange(() => {
  for (const tex of texCache.values()) tex.dispose();
  texCache.clear();
  for (const v of views.values()) {
    v.mesh.material.map = ballTexture(v);
    v.mesh.material.needsUpdate = true;
  }
});

export function buildRack(layout) {
  clearRack();
  for (const spec of layout) {
    const number = spec.number === 255 ? null : spec.number;
    const style = ballStyle(number);
    const color = number != null ? BALL_COLORS[number] : "#ffffff";
    const mesh = makeBallMesh({ style, color, number });
    mesh.position.set(spec.x, R, spec.z);
    // Match the server's racked body orientation exactly (numbers face up);
    // no frames stream while the table is at rest, so a mismatch here would
    // snap-rotate every ball on the break's first replay frame.
    mesh.quaternion.set(RACK_QUAT.x, RACK_QUAT.y, RACK_QUAT.z, RACK_QUAT.w);
    views.set(spec.id, { mesh, number, style, color });
  }
}

// Full transform snapshot of every current ball (id + number + exact pose),
// enough to rebuild the identical rack later. Used by the shot-review player to
// stash the live table before it borrows the meshes, and to restore it after.
export function snapshotRack() {
  const out = [];
  for (const [id, v] of views) {
    const p = v.mesh.position, q = v.mesh.quaternion;
    out.push({ id, number: v.number, x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w });
  }
  return out;
}

// Drop a ball mesh. Geometry and texture are shared/cached, so only the
// per-mesh materials (ball + its spin marker) are ours to release.
function disposeBallMesh(mesh) {
  scene.remove(mesh);
  mesh.material.dispose();
  for (const child of mesh.children) child.material?.dispose();
}

export function clearRack() {
  for (const { mesh } of views.values()) disposeBallMesh(mesh);
  views.clear();
}

// Reconcile the rendered rack to EXACTLY `items` (the server's authoritative
// ball set, from the `balls` packet): create meshes we're missing, delete ones
// we have spare, and pose the rest. This is the anti-ghost guarantee — after
// every shot the client's ball set is forced back into agreement with the
// server, so no divergence (a missed removal, a replay that started from the
// wrong rack, a resume mid-game) can persist beyond one shot.
export function syncRack(items) {
  const wanted = new Set();
  for (const it of items) {
    wanted.add(it.id);
    const number = it.number === 255 ? null : it.number;
    let v = views.get(it.id);
    // A ball we don't have, or one whose identity changed under the same id:
    // (re)build the mesh so the texture matches the number.
    if (!v || v.number !== number) {
      if (v) removeBallView(it.id);
      const style = ballStyle(number);
      const color = number != null ? BALL_COLORS[number] : "#ffffff";
      v = { mesh: makeBallMesh({ style, color, number }), number, style, color };
      views.set(it.id, v);
    }
    v.mesh.position.set(it.x, it.y, it.z);
    v.mesh.quaternion.set(it.qx, it.qy, it.qz, it.qw);
  }
  for (const id of [...views.keys()]) if (!wanted.has(id)) removeBallView(id);
}

export function applyBallsFrame(items) {
  for (const it of items) {
    const v = views.get(it.id);
    if (!v) continue;
    v.mesh.position.set(it.x, it.y, it.z);
    v.mesh.quaternion.set(it.qx, it.qy, it.qz, it.qw);
  }
}

// Blend two replay keyframes: position lerp + quaternion slerp at `alpha`
// (0 = frame A, 1 = frame B). Balls without a view (already removed) or
// missing from B are skipped/snapped. Used by the shot-replay player.
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
export function applyBallsFrameLerp(itemsA, itemsB, alpha) {
  const byId = new Map();
  for (const it of itemsB) byId.set(it.id, it);
  for (const a of itemsA) {
    const v = views.get(a.id);
    if (!v) continue;
    const b = byId.get(a.id);
    if (!b) { v.mesh.position.set(a.x, a.y, a.z); v.mesh.quaternion.set(a.qx, a.qy, a.qz, a.qw); continue; }
    v.mesh.position.set(
      a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha, a.z + (b.z - a.z) * alpha,
    );
    _qa.set(a.qx, a.qy, a.qz, a.qw);
    _qb.set(b.qx, b.qy, b.qz, b.qw);
    _qa.slerp(_qb, alpha);
    v.mesh.quaternion.copy(_qa);
  }
}

export function removeBallView(id) {
  const v = views.get(id);
  if (!v) return;
  disposeBallMesh(v.mesh);
  views.delete(id);
}

// Cue ball is always id 0. Used to position it during ball-in-hand placement.
export function setCuePosition(x, z, y = R) {
  const v = views.get(0);
  if (v) v.mesh.position.set(x, y, z);
}

export function getCueMeshPosition() {
  const v = views.get(0);
  return v ? v.mesh.position : null;
}

// Numbers of balls that have visibly dropped into a pocket right now (centre
// below the felt and over a cup). Lets the HUD mark a ball pocketed the instant
// it sinks during a replay, instead of waiting for the shot to fully resolve.
export function sunkNumbers() {
  const out = [];
  for (const v of views.values()) {
    if (v.number == null) continue;   // skip the cue
    const p = v.mesh.position;
    if (p.y < -0.005 && isInsideAnyPocket(p.x, p.z)) out.push(v.number);
  }
  return out;
}

// Every ball currently rendered (id, number, y) — for ghost detection in tests.
export function ballIds() {
  return [...views.entries()].map(([id, v]) => ({
    id, number: v.number,
    x: +v.mesh.position.x.toFixed(3),
    y: +v.mesh.position.y.toFixed(3),
    z: +v.mesh.position.z.toFixed(3),
  }));
}

// XZ positions of every ball except the cue (id 0) — used for cue-clearance.
// Balls resting in a pocket sit below the felt (y < 0); skip them so they don't
// count as obstacles behind the cue ball (the server ignores them too).
export function getObstaclePositions() {
  const out = [];
  for (const [id, v] of views) {
    if (id === 0 || v.mesh.position.y < 0) continue;
    out.push({ x: v.mesh.position.x, z: v.mesh.position.z });
  }
  return out;
}
