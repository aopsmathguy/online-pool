// src/geometry.physics.js — table collision bodies (rails, pocket cups).
// Ammo only, no Three. Each builder takes the target `world` so a room can
// build its own table. Ported verbatim from the physics halves of the old
// geometry.js (the mesh halves stay in geometry.js for the client).
import { mu_wall, e_rail, mu_ground, e_table, pocketWireY } from '../shared/constants.js';
import { AmmoLib, createRigidBody } from './physics.js';
import { triangulate } from '../shared/triangulate.js';
import { table_parts, rail_solid } from '../shared/table.js';

// Static triangulated felt at height `y`, built from the displayed felt outline
// `feltPts` ([[x,z],...]) so the pocket cutouts are REAL holes: a ball on this
// surface rolls to a mouth and tips in over the actual edge (vs. the flat plane,
// which the sim uses away from pockets). Returns the rigid body (caller filters
// it into the felt-mesh collision group).
export function createFeltMesh(world, feltPts, y = 0, opts = {}) {
  const Ammo = AmmoLib;
  const mu = opts.mu ?? mu_ground;
  const e  = opts.e  ?? e_table;

  const tris = triangulate(feltPts);
  const mesh = new Ammo.btTriangleMesh();
  const va = new Ammo.btVector3(), vb = new Ammo.btVector3(), vc = new Ammo.btVector3();
  for (let i = 0; i < tris.length; i += 3) {
    const a = feltPts[tris[i]], b = feltPts[tris[i + 1]], c = feltPts[tris[i + 2]];
    va.setValue(a[0], y, a[1]); vb.setValue(b[0], y, b[1]); vc.setValue(c[0], y, c[1]);
    mesh.addTriangle(va, vb, vc, true);
  }
  Ammo.destroy(va); Ammo.destroy(vb); Ammo.destroy(vc);

  const shape = new Ammo.btBvhTriangleMeshShape(mesh, true, true);   // quantized AABB + build BVH
  return createRigidBody(world, {
    mass: 0, shape, pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 },
    fric: mu, rest: e, rollF: 0, spinF: 0, linD: 0, angD: 0,
  });
}

// quaternion to rotate (0,1,0) -> dir (unit)
function quatFromUpToDir(Ammo, dir) {
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

// Capsules along a polyline at height `wireY`, added to an existing compound.
function addPolylineCapsules(Ammo, compound, pointsXZ, wireR, wireY, margin) {
  const tmpTr = new Ammo.btTransform();
  for (let i = 0; i + 1 < pointsXZ.length; i++) {
    const [x1,z1] = pointsXZ[i];
    const [x2,z2] = pointsXZ[i+1];
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;

    const cap = new Ammo.btCapsuleShape(wireR, Math.max(0, len - 2 * wireR));
    cap.setMargin(margin);

    tmpTr.setIdentity();
    tmpTr.setOrigin(new Ammo.btVector3((x1 + x2) * 0.5, wireY, (z1 + z2) * 0.5));
    tmpTr.setRotation(quatFromUpToDir(Ammo, [dx/len, 0, dz/len]));
    compound.addChildShape(tmpTr, cap);
  }
}

// The whole table boundary as ONE static body: six solid trapezoidal rails
// (convex hulls, from the shared rail_solid) and six wire pocket throats
// (capsules). They share a body deliberately — the contact scanner in sim.js
// recognises a rail hit by a single body pointer, so splitting these into
// twelve bodies would make every cushion contact read as "not a rail".
//
// A ball centre sits at y=R, below the rails' y=wireY top edge, so contact
// lands on that 45 deg nose edge — the same line the old wire ran along.
export function createTableBoundary(world, tableW, tableH, wireR, wireY, opts = {}) {
  const Ammo = AmmoLib;
  const mu = opts.mu ?? mu_wall;     // tangential friction vs balls
  const e  = opts.e  ?? e_rail;      // restitution vs balls
  const margin = opts.margin ?? 0.001;

  const { wires, rails } = table_parts(tableW, tableH);
  const compound = new Ammo.btCompoundShape();
  const tmpTr = new Ammo.btTransform();
  tmpTr.setIdentity();

  for (const rail of rails) {
    const hull = new Ammo.btConvexHullShape();
    const v = new Ammo.btVector3();
    for (const [x, y, z] of rail_solid(rail, wireY)) {
      v.setValue(x, y, z);
      hull.addPoint(v, true);
    }
    Ammo.destroy(v);
    hull.setMargin(margin);
    tmpTr.setIdentity();
    compound.addChildShape(tmpTr, hull);
  }

  // Wire only where the rails don't already reach — see table_parts. It rides
  // at pocketWireY, level with the rails' raised outer-top corners it joins.
  for (const wire of wires) {
    addPolylineCapsules(Ammo, compound, wire, wireR, pocketWireY, margin);
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
