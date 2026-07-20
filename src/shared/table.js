// src/table.js — pure table geometry (point generators only, no Three / no Ammo).
// Shared by the server (to build rail/pocket physics) and the client (to build
// the visual rail/felt meshes), so it must stay free of Three/Ammo imports.
import { mid_mouth, mid_throat, corner_mouth, corner_throat, inset, wireY, rail_rise, rail_cap } from './constants.js';

// The table boundary is one closed loop that alternates POCKET and RAIL:
// pocket throat, cushion, pocket throat, cushion, ... six of each. The throats
// stay round wire (a ball that misses the mouth hits the wire and comes back);
// the cushions are solid trapezoidal rails. table_parts() is the structured
// form both builders consume; rail_pts() is the same loop flattened, kept for
// the cue-clearance scan and the AI, which only care about the outline.
export function table_parts(tableW, tableH) {
  const reflectX = ([x, y]) => [ x, -y];
  const reflectY = ([x, y]) => [-x,  y];
  const SQRT2 = Math.SQRT2;

  const TL_CORNER = [
    [-tableW*0.5,                          -tableH*0.5 + corner_mouth/SQRT2],
    [-tableW*0.5 - inset,                  -tableH*0.5 - inset + corner_throat/SQRT2],
    [-tableW*0.5 - inset - 0.025,          -tableH*0.5 - inset + 0.055],
    [-tableW*0.5 - inset - 0.025,          -tableH*0.5 - inset],
    [-tableW*0.5 - inset,                  -tableH*0.5 - inset - 0.025],
    [-tableW*0.5 - inset + 0.055,          -tableH*0.5 - inset - 0.025],
    [-tableW*0.5 - inset + corner_throat/SQRT2, -tableH*0.5 - inset],
    [-tableW*0.5 + corner_mouth/SQRT2,     -tableH*0.5],
  ];

  const TOP_MID = [
    [-mid_mouth/2, -tableH*0.5],
    [-mid_throat/2, -tableH*0.5 - inset],
    [-0.035, -tableH*0.5 - inset - 0.035],
    [0, -tableH*0.5 - inset - 0.05],
    [0.035, -tableH*0.5 - inset - 0.035],
    [mid_throat/2, -tableH*0.5 - inset],
    [mid_mouth/2, -tableH*0.5],
  ];

  const TR_CORNER    = TL_CORNER.map(reflectY).reverse();
  const BR_CORNER    = TR_CORNER.slice().reverse().map(reflectX);
  const BOTTOM_MID   = TOP_MID.slice().reverse().map(reflectX);
  const BL_CORNER    = TL_CORNER.slice().reverse().map(reflectX);

  // Order matters: consecutive throats are joined by exactly one cushion, and
  // concatenating them in this order reproduces the original closed outline.
  const pockets = [TL_CORNER, TOP_MID, TR_CORNER, BR_CORNER, BOTTOM_MID, BL_CORNER];

  // Each rail spans the gap from one throat's last point to the next throat's
  // first. `dirA`/`dirB` are the directions the throats leave the cushion in —
  // the angle the pocket opens at — which is what the rail's end faces are cut
  // along so rail and wire stay flush in plan view.
  const sub  = (p, q) => [p[0] - q[0], p[1] - q[1]];
  const norm = ([x, y]) => { const l = Math.hypot(x, y); return [x/l, y/l]; };

  const rails = pockets.map((throat, i) => {
    const next = pockets[(i + 1) % pockets.length];
    const a = throat[throat.length - 1];
    const b = next[0];
    return {
      a, b,
      dirA: norm(sub(throat[throat.length - 2], a)),
      dirB: norm(sub(next[1], b)),
    };
  });

  // What's left for the wire to do. A rail's angled end cap already forms the
  // first segment of the throat on each side: the throat point adjacent to a
  // cushion lies exactly on the table's outer edge line (z = ±tableH/2 - inset,
  // x = ±tableW/2 - inset), which is exactly where the cap's outer corner
  // lands. So the wire runs only between those two points — carrying it all the
  // way to the mouth would double the rail. The trimmed ends coincide with the
  // cap corners to the last bit, so the throat still reads as one closed curve.
  const wires = pockets.map(throat => throat.slice(1, -1));

  return { pockets, wires, rails };
}

export function rail_pts(tableW, tableH) {
  const { pockets } = table_parts(tableW, tableH);
  const pts = pockets.flat();
  pts.push(pts[0]);
  return pts;
}

// The ten corners of one rail solid, as [x, y, z], in the order
// [A0..A4, B0..B4] where A is the `a` end and the profile index is:
//
//              1 .____. 2       y = height + rail_rise
//        0 ._--'      |
//          |\         |         the top is TWO segments: a flat cap (1-2) at
//          |  \       |         the outer height, then a shallow slant (0-1)
//        4 .____\_____. 3       y = 0
//          ^ 135 deg
//        s=height      s=width
//                s = width - rail_cap  (the crest, 1)
//
// Corner 0 is the nose: it stays at y = height (= wireY), which is what keeps
// the ball's contact line put however the top is shaped. s is the outward
// offset from the nose line. Because the slope 4->0 is 45 deg the vertical
// drop equals the horizontal run, which puts corner 4 at s = height.
//
// Two right angles now, both on the outer edge (2 and 3) — a flat cap meeting
// a vertical face can't avoid them.
// Both end faces are vertical planes sheared along the rail axis so they follow
// the pocket-opening direction; that shear is linear in s, so every face stays
// planar and the solid stays convex (btConvexHullShape depends on this).
export function rail_solid(rail, height = wireY, width = inset) {
  const { a, b, dirA, dirB } = rail;
  const dot = (p, q) => p[0]*q[0] + p[1]*q[1];

  const ux = b[0] - a[0], uz = b[1] - a[1];
  const len = Math.hypot(ux, uz);
  const u = [ux/len, uz/len];
  const o = [u[1], -u[0]];        // outward normal (away from the playing area)

  // Shear per unit of outward offset: how far along the rail the cut plane
  // travels as it moves outward. Negative at `a` (the throat opens backwards).
  const kA = dot(dirA, u) / dot(dirA, o);
  const kB = dot(dirB, u) / dot(dirB, o);

  const profile = [
    [0,                 height],              // 0 nose, on the wire line
    [width - rail_cap,  height + rail_rise],  // 1 crest, where slant meets cap
    [width,             height + rail_rise],  // 2 outer top
    [width,             0],                   // 3 outer bottom
    [height,            0],                   // 4 inner bottom
  ];
  const corner = (end, k, [s, y]) => [
    end[0] + s*o[0] + s*k*u[0],
    y,
    end[1] + s*o[1] + s*k*u[1],
  ];

  return [
    ...profile.map(p => corner(a, kA, p)),
    ...profile.map(p => corner(b, kB, p)),
  ];
}

// Faces of the solid returned by rail_solid, as vertex indices: the two end
// caps (n-gons) plus one quad per profile edge. Derived from the profile size
// rather than written out, so changing the cross-section can't leave a stale
// index behind. Winding is fixed up against the centroid by the mesh builder,
// so only membership matters — and the mesh builder fans each face, so faces
// need not all have the same number of corners.
export const RAIL_PROFILE_N = 5;
export const RAIL_FACES = (() => {
  const n = RAIL_PROFILE_N;
  const a = [...Array(n).keys()];                 // a-end cap
  const b = [...Array(n).keys()].map(i => n + i).reverse();   // b-end cap
  const sides = a.map(i => {
    const j = (i + 1) % n;
    return [i, n + i, n + j, j];
  });
  return [a, b, ...sides];
})();

export function felt_pts(tableW, tableH) {
  const reflectX = ([x, y]) => [ x, -y];
  const reflectY = ([x, y]) => [-x,  y];

  const TL_FELT = [
    [-tableW * 0.5 - inset,              -tableH * 0.5 - inset + 0.095],
    [-tableW * 0.5 - inset + 0.05,       -tableH * 0.5 - inset + 0.095],
    [-tableW * 0.5 - inset + 0.079,      -tableH * 0.5 - inset + 0.079],
    [-tableW * 0.5 - inset + 0.095,      -tableH * 0.5 - inset + 0.05],
    [-tableW * 0.5 - inset + 0.095,      -tableH * 0.5 - inset],
  ];
  const TOP_MID = [
    [-0.051, -tableH * 0.5 - inset],
    [-0.048, -tableH * 0.5 - inset + 0.015],
    [-0.031, -tableH * 0.5 - inset + 0.031],
    [0.0,    -tableH * 0.5 - inset + 0.04],
    [0.031,  -tableH * 0.5 - inset + 0.031],
    [0.048,  -tableH * 0.5 - inset + 0.015],
    [0.051,  -tableH * 0.5 - inset],
  ];
  const TR_FELT = TL_FELT.map(reflectY).reverse();
  const TOP = [...TL_FELT, ...TOP_MID, ...TR_FELT];
  const BOTTOM = TOP.slice().reverse().map(reflectX);
  const pts = [...TOP, ...BOTTOM];
  pts.push(pts[0]);
  return pts;
}

// The closed outer boundary of the whole table assembly at the rail top: rails
// AND pocket throats, as one loop. It is just the wires concatenated, because a
// rail's outer-top corner lands exactly on the wire endpoint next to it (the
// same coincidence table_parts() relies on to trim the wires) — so the straight
// run between two consecutive throats IS that rail's outer top edge, with no
// point needed to describe it. This is what the cabinet's top deck is cut
// against, so the wood meets rail and wire with no seam of its own.
export function table_top_outline(tableW, tableH) {
  return table_parts(tableW, tableH).wires.flat();
}

// Even-odd ray cast against a closed [x, z] loop. Used to tell which part of a
// pocket cup sits under the cabinet deck (outside the outline) rather than under
// the open mouth (inside it) — the two want different wall heights.
export function point_in_outline(px, pz, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// One horizontal cross-section of the wooden cabinet: a rounded rectangle whose
// four corner arcs are centred on the four CORNER pockets. The radius is the
// only free parameter — each straight side is the common tangent between two
// consecutive arcs, so it slides outward as `r` grows and the section stays a
// true rounded rectangle at every height. Returned counter-clockwise in [x, z],
// unclosed (the caller closes it), so lofting two sections is an index-for-index
// walk. Arc joins are tangent-continuous, which is why smooth normals are right
// along the whole loop.
export function cabinet_section(tableW, tableH, r, segments = 24) {
  const p = pocket_positions(tableW, tableH);
  // Quadrant order (+,+), (-,+), (-,-), (+,-) so arc c sweeps c*90 -> (c+1)*90.
  const centres = [p[3], p[5], p[0], p[2]];

  const pts = [];
  for (let c = 0; c < centres.length; c++) {
    const [ox, oz] = centres[c];
    for (let i = 0; i <= segments; i++) {
      const th = (c + i / segments) * (Math.PI / 2);
      pts.push([ox + r * Math.cos(th), oz + r * Math.sin(th)]);
    }
  }
  return pts;
}

export function pocket_positions(tableW, tableH){
  return [
    [-tableW/2 - 0.015, -tableH/2 - 0.015],
    [0, -tableH/2 - 0.05],
    [tableW/2 + 0.015, -tableH/2 - 0.015],
    [tableW/2 + 0.015, tableH/2 + 0.015],
    [0, tableH/2 + 0.05],
    [-tableW/2 - 0.015, tableH/2 + 0.015],
  ];
}
