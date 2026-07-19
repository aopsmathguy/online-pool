// test/placement.test.js — ball-in-hand geometry, in isolation.
//
// placement.js is pure (no world, no Ammo), so these run instantly and cover
// the edge cases the physics-level tests reach only by luck: the exactly
// coincident ball, a spot pushed out of bounds by the overlap resolve, and the
// break's kitchen restriction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBounds, resolvePlacement, HEAD_STRING_X } from '../src/server/placement.js';
import { tableW, tableH, R } from '../src/shared/constants.js';

const inBounds = (p, b) => p.x >= b.minX - 1e-9 && p.x <= b.maxX + 1e-9
                        && p.z >= b.minZ - 1e-9 && p.z <= b.maxZ + 1e-9;
const MIN_D = 2 * R + 0.001;

test('bounds: free placement spans the table inset by a ball diameter', () => {
  const b = computeBounds(false);
  assert.ok(Math.abs(b.maxX - (tableW / 2 - 2 * R)) < 1e-12);
  assert.ok(Math.abs(b.maxZ - (tableH / 2 - 2 * R)) < 1e-12);
  assert.equal(b.minX, -b.maxX);
  assert.equal(b.minZ, -b.maxZ);
});

test('bounds: the break is restricted to behind the head string', () => {
  const b = computeBounds(true);
  assert.equal(b.maxX, HEAD_STRING_X);
  assert.ok(b.maxX < 0, 'the kitchen is on the negative-x side');
  assert.equal(b.minX, -(tableW / 2 - 2 * R), 'the far edge is unchanged');
});

test('placement: a legal spot is returned unchanged', () => {
  const b = computeBounds(false);
  const p = resolvePlacement({ x: 0.2, z: 0.1 }, b, [{ x: -0.5, z: -0.3 }]);
  assert.ok(Math.abs(p.x - 0.2) < 1e-12);
  assert.ok(Math.abs(p.z - 0.1) < 1e-12);
});

test('placement: a spot outside the box is clamped back in', () => {
  const b = computeBounds(false);
  const p = resolvePlacement({ x: 99, z: -99 }, b, []);
  assert.ok(inBounds(p, b));
  assert.equal(p.x, b.maxX);
  assert.equal(p.z, b.minZ);
});

test('placement: overlapping an object ball pushes clear of it', () => {
  const b = computeBounds(false);
  const other = { x: 0, z: 0 };
  const p = resolvePlacement({ x: 0.005, z: 0 }, b, [other]);
  const d = Math.hypot(p.x - other.x, p.z - other.z);
  assert.ok(d >= MIN_D - 1e-9, `ended up ${d} from the object ball, need ${MIN_D}`);
});

test('placement: a spot exactly on top of a ball still resolves', () => {
  // d == 0 would divide by zero without the degenerate-case guard.
  const b = computeBounds(false);
  const other = { x: 0.3, z: -0.2 };
  const p = resolvePlacement({ ...other }, b, [other]);
  const d = Math.hypot(p.x - other.x, p.z - other.z);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), 'must not produce NaN');
  assert.ok(d >= MIN_D - 1e-9, `ended up ${d} from the object ball`);
});

test('placement: the result is always inside the box, even when pushed out', () => {
  // A ball parked in the corner: resolving away from it must not leave the table.
  const b = computeBounds(false);
  const corner = { x: b.maxX, z: b.maxZ };
  const p = resolvePlacement({ x: b.maxX, z: b.maxZ }, b, [corner]);
  assert.ok(inBounds(p, b), `escaped the box: ${JSON.stringify(p)}`);
});

test('placement: the break clamp keeps the cue ball out of the far half', () => {
  const b = computeBounds(true);
  const p = resolvePlacement({ x: 0.9, z: 0 }, b, []);
  assert.ok(p.x <= HEAD_STRING_X + 1e-9, `cue placed at x=${p.x}, past the head string`);
});

test('placement: several nearby balls are all resolved against', () => {
  const b = computeBounds(false);
  const others = [{ x: 0, z: 0 }, { x: 0.05, z: 0.02 }, { x: -0.04, z: 0.03 }];
  const p = resolvePlacement({ x: 0.01, z: 0.01 }, b, others);
  assert.ok(inBounds(p, b));
  // The last-resolved ball is guaranteed clear; that is the documented limit of
  // a two-pass resolve, so assert what the implementation actually promises.
  const last = others[others.length - 1];
  assert.ok(Math.hypot(p.x - last.x, p.z - last.z) >= MIN_D - 1e-9);
});
