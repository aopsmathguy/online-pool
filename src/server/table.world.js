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
import { tableW, tableH, wireY, rodR, mu_wall, mu_ground, mu_pocket, e_rail, e_table, e_pocket, cupDepth, cupY } from '../shared/constants.js';
import {
  createWorld, createRigidBody, setBodyFilter, AmmoLib,
  CG_FELT, CG_BALL, CG_RAIL, CG_POCKET, CG_SUNK, CG_FELTMESH,
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

  // Felt is modelled two ways. AWAY from pockets a ball rolls on this flat,
  // edge-free plane (cheap, snag-free). NEAR a pocket updatePocketMasks swaps
  // the ball onto the triangulated felt below, which has the real hole, so it
  // rolls over the lip and tips in. The two are coplanar (y=0), so the swap
  // never pops the ball.
  const planeShape = new AmmoLib.btStaticPlaneShape(new AmmoLib.btVector3(0, 1, 0), 0);
  const feltBody = createRigidBody(world, {
    mass: 0, shape: planeShape, pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 },
    fric: mu_ground, rest: e_table, group: CG_FELT, mask: CG_BALL,
  });
  feltBody.setUserIndex(3);

  // Triangulated felt (real pocket holes), collided with only near a pocket.
  const feltMesh = createFeltMesh(world, feltPoints, 0);
  feltMesh.setUserIndex(3);
  setBodyFilter(world, feltMesh, CG_FELTMESH, CG_BALL);

  // Rails (solid cushions) + pocket throats (wire), one body — see
  // createTableBoundary for why they must not be split.
  const railBody = createTableBoundary(world, tableW, tableH, rodR, wireY, {
    mu: mu_wall, e: e_rail, margin: 0.0002,
  });
  railBody.setUserIndex(2);
  setBodyFilter(world, railBody, CG_RAIL, CG_BALL);

  // Pocket cups.
  for (const [x, z] of pocketPositions) {
    const cup = createCylindricalCup(world, 0.08, cupDepth, {
      mu: mu_pocket, e: e_pocket, pos: { x, y: cupY, z },
    });
    cup.setUserIndex(4);
    setBodyFilter(world, cup, CG_POCKET, CG_BALL | CG_SUNK);   // holds live + pocketed balls
  }

  return { world, railPtr: railBody.ptr };
}
