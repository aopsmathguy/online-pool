// src/server/table.world.js — build one room's static physics world.
//
// Everything here is fixed geometry: the felt, the rails, the pocket cups. It
// depends on nothing but the table dimensions, so it is the same for every room
// and every ruleset, and it never changes once built. Split out of RoomSim's
// constructor so that constructor reads as "set up state" rather than 30 lines
// of collision-shape assembly.
//
// The only thing the caller needs back is `railPtr`: the contact scanner
// identifies rail hits by body pointer (see scanContacts in sim.js).
import { tableW, tableH, wireY, rodR, e_rail, e_table, e_pocket, cupDepth, cupY } from '../shared/constants.js';
import {
  createWorld, createRigidBody, setBodyFilter, AmmoLib,
  CG_FELT, CG_BALL, CG_RAIL, CG_POCKET, CG_SUNK, CG_FELTMESH,
  SURF_RAIL, SURF_FELT, SURF_CUP,
} from './physics.js';
import { createTableBoundary, createCylindricalCup, createFeltMesh } from './geometry.physics.js';
import { rail_pts, felt_pts } from '../shared/table.js';
import { pocketPositions } from '../shared/pockets.js';

// Table outlines are identical for every room, so compute them once.
export const railPoints = rail_pts(tableW, tableH);
export const feltPoints = felt_pts(tableW, tableH);   // felt outline WITH pocket cutouts

// Returns { world, railPtr }.
export function buildTableWorld() {
  const world = createWorld();

  // Felt is modelled two ways. While a ball's centre is ON the felt outline it
  // rolls on this flat, edge-free plane (cheap, snag-free). Once the centre
  // leaves the outline updateFeltMasks swaps it onto the triangulated felt
  // below, which has the real hole, so it pivots over the lip and tips in.
  // The two are coplanar (y=0) AND — while the centre is inside — give a sphere
  // the identical contact, so the swap is invisible; see isOffFelt.
  const planeShape = new AmmoLib.btStaticPlaneShape(new AmmoLib.btVector3(0, 1, 0), 0);
  const feltBody = createRigidBody(world, {
    // Frictionless in Bullet — cloth friction is resolved analytically in
    // physics.js (applyFriction). Bullet does only the normal support/bounce.
    mass: 0, shape: planeShape, pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 },
    fric: 0, rest: e_table, group: CG_FELT, mask: CG_BALL,
  });
  feltBody.setUserIndex(SURF_FELT);

  // Triangulated felt (real pocket holes), collided with only near a pocket.
  // Frictionless like the flat plane — cloth friction is analytic (physics.js).
  const feltMesh = createFeltMesh(world, feltPoints, 0, { mu: 0 });
  feltMesh.setUserIndex(SURF_FELT);
  setBodyFilter(world, feltMesh, CG_FELTMESH, CG_BALL);

  // Rails (solid cushions) + pocket throats (wire), one body — see
  // createTableBoundary for why they must not be split. Frictionless in Bullet;
  // rail tangential friction is resolved analytically (physics.js).
  const railBody = createTableBoundary(world, tableW, tableH, rodR, wireY, {
    mu: 0, e: e_rail, margin: 0.0002,
  });
  railBody.setUserIndex(SURF_RAIL);
  setBodyFilter(world, railBody, CG_RAIL, CG_BALL);

  // Pocket cups are frictionless like every other body — a pocketed ball just
  // dead-drops into the cup (low pocket restitution damps the bounce) and is
  // removed once the shot settles. Live balls never rest here either; they are
  // marked sunk on the way in.
  for (const [x, z] of pocketPositions) {
    const cup = createCylindricalCup(world, 0.08, cupDepth, {
      mu: 0, e: e_pocket, pos: { x, y: cupY, z },
    });
    cup.setUserIndex(SURF_CUP);
    setBodyFilter(world, cup, CG_POCKET, CG_BALL | CG_SUNK);   // holds live + pocketed balls
  }

  return { world, railPtr: railBody.ptr };
}
