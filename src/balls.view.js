// src/balls.view.js — client-side ball rendering. No physics here: meshes are
// keyed by the server's ball id and driven purely by streamed transforms.
// The texture/mesh code is ported from the old balls.js (incl. two numbers on
// opposite sides of each ball).
import * as THREE from "/lib/three.module.js";
import { scene } from './scene.js';
import { TEX_V_STRETCH, R, RACK_QUAT } from './constants.js';
import { BALL_COLORS, ballStyle } from './balldefs.js';

function makeBallTexture({ style, color = "#ffffff", number = null }) {
  const size = 256;
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
  tex.anisotropy = 8; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

function makeBallMesh({ style, color, number = null }) {
  const geo = new THREE.SphereGeometry(R, 16, 10);
  const map = makeBallTexture({ style, color, number });
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.05, metalness: 0.0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = false;

  const mark = new THREE.Mesh(new THREE.SphereGeometry(R * 0.18, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff2b2b }));
  mark.position.set(R * 0.7, R * 0.2, R * 0.1);
  mesh.add(mark);

  scene.add(mesh);
  return mesh;
}

// --- id-keyed registry ------------------------------------------------------
const views = new Map();   // id -> { mesh, number, style }

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
    views.set(spec.id, { mesh, number, style });
  }
}

export function clearRack() {
  for (const { mesh } of views.values()) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material.map) mesh.material.map.dispose();
    mesh.material.dispose();
  }
  views.clear();
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
  scene.remove(v.mesh);
  v.mesh.geometry.dispose();
  if (v.mesh.material.map) v.mesh.material.map.dispose();
  v.mesh.material.dispose();
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

// XZ positions of every ball except the cue (id 0) — used for cue-clearance.
export function getObstaclePositions() {
  const out = [];
  for (const [id, v] of views) {
    if (id === 0) continue;
    out.push({ x: v.mesh.position.x, z: v.mesh.position.z });
  }
  return out;
}
