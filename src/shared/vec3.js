// src/vec3.js — tiny plain-scalar 3-vector helpers ({x,y,z} objects).
// Pure math, no Three/Ammo, so the server sim (and anything else running
// headless) can do vector algebra without pulling in THREE. Kept deliberately
// minimal; grow it as shared math lands here.
export function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function lenSq(a) { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function normalize(a) {
  const l = Math.sqrt(lenSq(a)) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
