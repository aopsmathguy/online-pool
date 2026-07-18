// src/shared/triangulate.js — ear-clipping triangulation of a simple polygon.
// Pure JS (no THREE/Ammo) so the server can triangulate the felt outline into a
// collision mesh (with the pocket cutouts as real holes). Handles concave
// polygons; assumes the input is simple (non-self-intersecting).
//
// Input:  [[x, z], ...] — a simple polygon, open or closed (a duplicated closing
//         vertex is ignored).
// Output: a flat array of vertex indices [i0,i1,i2, ...] into the input, three
//         per triangle, wound counter-clockwise (upward-facing in the xz plane).
export function triangulate(polyIn) {
  const poly = polyIn.slice();
  if (poly.length > 1) {                 // drop a duplicated closing vertex
    const a = poly[0], b = poly[poly.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) poly.pop();
  }
  const n = poly.length;
  if (n < 3) return [];

  const idx = [...Array(n).keys()];
  if (signedArea(poly) < 0) idx.reverse();   // make CCW so ear tips are left turns

  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (cross2(a, b, c) <= 0) continue;      // reflex/collinear vertex → not an ear tip
      let empty = true;                         // ear only if no other vertex is inside abc
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(poly[j], a, b, c)) { empty = false; break; }
      }
      if (!empty) continue;
      tris.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;   // degenerate input; return what we have
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}
// z-component of (b−a)×(c−b); > 0 = left turn (convex on a CCW polygon).
function cross2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
}
// Strictly inside triangle abc (points on an edge don't block an ear).
function pointInTri(p, a, b, c) {
  const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
  return d1 > 0 && d2 > 0 && d3 > 0;
}
