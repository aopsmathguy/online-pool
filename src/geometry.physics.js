// src/geometry.physics.js — table collision bodies (rails, pocket cups).
// Ammo only, no Three. Each builder takes the target `world` so a room can
// build its own table. Ported verbatim from the physics halves of the old
// geometry.js (the mesh halves stay in geometry.js for the client).
import { mu_wall, e_rail } from './constants.js';
import { AmmoLib, createRigidBody } from './physics.js';

export function createPhysicsPolyline(world, pointsXZ, wireR, wireY, opts = {}) {
  const Ammo = AmmoLib;
  const mu = opts.mu ?? mu_wall;     // tangential friction vs balls
  const e  = opts.e  ?? e_rail;      // restitution vs balls
  const margin = opts.margin ?? 0.001;

  const compound = new Ammo.btCompoundShape();

  function makeCapsule(height) {
    const shape = new Ammo.btCapsuleShape(wireR, Math.max(0, height));
    shape.setMargin(margin);
    return shape;
  }

  const tmpTr = new Ammo.btTransform();
  tmpTr.setIdentity();

  // quaternion to rotate (0,1,0) -> dir (unit)
  function quatFromUpToDir(dir) {
    const ux=0, uy=1, uz=0;
    const dx=dir[0], dy=dir[1], dz=dir[2];
    const dot = uy*dy;
    const cx = uy*dz - uz*dy;
    const cy = uz*dx - ux*dz;
    const cz = ux*dy - uy*dx;
    if (dot < -0.999999) {
      return new Ammo.btQuaternion(1,0,0,0);
    } else {
      const s = Math.sqrt((1 + dot) * 2);
      const invs = 1 / s;
      return new Ammo.btQuaternion(cx * invs, cy * invs, cz * invs, s * 0.5);
    }
  }

  for (let i = 0; i + 1 < pointsXZ.length; i++) {
    const [x1,z1] = pointsXZ[i];
    const [x2,z2] = pointsXZ[i+1];
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;

    const height = Math.max(len - 2 * wireR, 0);
    const cap = makeCapsule(height);

    const mx = (x1 + x2) * 0.5;
    const mz = (z1 + z2) * 0.5;

    const dir = [dx/len, 0, dz/len];
    const q = quatFromUpToDir(dir);

    tmpTr.setIdentity();
    tmpTr.setOrigin(new Ammo.btVector3(mx, wireY, mz));
    tmpTr.setRotation(q);
    compound.addChildShape(tmpTr, cap);
  }

  return createRigidBody(world, {
    mass: 0,
    shape: compound,
    pos:   { x: 0, y: 0, z: 0 },
    quat:  { x: 0, y: 0, z: 0, w: 1 },
    fric:  mu,
    rest:  e,
    rollF: 0, spinF: 0, linD: 0, angD: 0,
  });
}

export function createCylindricalCup(world, radius, height, opts = {}) {
  const Ammo = AmmoLib;

  const wall     = opts.wall     ?? 0.01;
  const base     = opts.base     ?? wall;
  const segments = opts.segments ?? 32;
  const mu       = opts.mu       ?? mu_wall;
  const e        = opts.e        ?? e_rail;
  const margin   = opts.margin   ?? 0.001;
  const pos      = opts.pos      ?? { x: 0, y: 0, z: 0 };

  const compound = new Ammo.btCompoundShape();
  const tmpTr = new Ammo.btTransform();
  tmpTr.setIdentity();

  // Bottom disc
  {
    const halfH = base * 0.5;
    const bottom = new Ammo.btCylinderShape(new Ammo.btVector3(radius, halfH, radius));
    bottom.setMargin(margin);
    tmpTr.setIdentity();
    tmpTr.setOrigin(new Ammo.btVector3(pos.x, pos.y - height * 0.5, pos.z));
    compound.addChildShape(tmpTr, bottom);
  }

  // Side wall (ring of thin boxes)
  const hx = wall * 0.5;
  const hy = height * 0.5;
  const segLen = (2 * Math.PI * radius / segments) * 1.02;
  const hz = segLen * 0.5;
  const stave = new Ammo.btBoxShape(new Ammo.btVector3(hx, hy, hz));
  stave.setMargin(margin);

  function quatAroundY(theta) {
    const half = 0.5 * theta;
    return new Ammo.btQuaternion(0, Math.sin(half), 0, Math.cos(half));
  }

  for (let i = 0; i < segments; i++) {
    const theta = (i + 0.5) * (2 * Math.PI / segments);
    const rCenter = radius - hx;
    const cx = pos.x + rCenter * Math.cos(theta);
    const cz = pos.z + rCenter * Math.sin(theta);
    tmpTr.setIdentity();
    tmpTr.setOrigin(new Ammo.btVector3(cx, pos.y, cz));
    tmpTr.setRotation(quatAroundY(theta));
    compound.addChildShape(tmpTr, stave);
  }

  return createRigidBody(world, {
    mass: 0,
    shape: compound,
    pos:  { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    fric: mu,
    rest: e,
    rollF: 0, spinF: 0, linD: 0, angD: 0,
  });
}
