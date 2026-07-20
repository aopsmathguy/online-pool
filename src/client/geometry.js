// src/geometry.js — visual table geometry (Three meshes). Client-only.
// Pure point generators now live in table.js (shared with the server); they are
// re-exported here so existing client imports keep working. The physics builders
// moved to geometry.physics.js.
import * as THREE from "/lib/three.module.js";
import { table_parts, rail_solid, RAIL_FACES, cabinet_section, table_top_outline } from '../shared/table.js';
import { pocketWireY, cabinetDeckThickness } from '../shared/constants.js';
export { rail_pts, felt_pts, pocket_positions, table_parts } from '../shared/table.js';

export function makePolylineMesh(pointsXZ, wireR, wireY, opts = {}) {
      const {
        color = 0xbfc5ca,         // soft steel
        roughness = 0.35,         // lower = glossier
        metalness = 0.0,          // 0 = dielectric (plastic), 1 = metal
        radialSegments = 16
      } = opts;

      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });

      // Spheres at joints
      const sphereGeo = new THREE.SphereGeometry(wireR, radialSegments, Math.max(8, radialSegments/2));
      for (let i = 0; i < pointsXZ.length; i++) {
        const [x, z] = pointsXZ[i];
        const s = new THREE.Mesh(sphereGeo, mat);
        s.position.set(x, wireY, z);
        group.add(s);
      }

      // Cylinders for each segment (Y-axis default; rotate to segment dir)
      for (let i = 0; i + 1 < pointsXZ.length; i++) {
        const [x1, z1] = pointsXZ[i];
        const [x2, z2] = pointsXZ[i + 1];
        const dx = x2 - x1, dz = z2 - z1;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;

        const cylGeo = new THREE.CylinderGeometry(wireR, wireR, len, radialSegments, 1, true);
        const cyl = new THREE.Mesh(cylGeo, mat);
        cyl.position.set((x1 + x2) * 0.5, wireY, (z1 + z2) * 0.5);

        // Rotate Y-up axis to (dx,0,dz)
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(dx / len, 0, dz / len)
        );
        cyl.setRotationFromQuaternion(q);

        group.add(cyl);
      }

      group.traverse(n => { n.castShadow = false; n.receiveShadow = false; });

      return group;
}

// The six cushions, as solid trapezoidal rails, plus the six pocket throats as
// wire — one group, built from the same table_parts() the server builds physics
// from. Flat-shaded on purpose: the 45 deg face and the two right angles should
// read as crisp edges, and smoothing them would round the nose the ball plays
// off. Winding is fixed against the centroid rather than hand-ordered, which is
// what lets RAIL_FACES stay a plain membership list.
export function makeTableRails(tableW, tableH, wireR, wireY, opts = {}) {
      const { color = 0xb8c2cc, roughness = 0.35, metalness = 0.0 } = opts;
      const { wires, rails } = table_parts(tableW, tableH);

      const group = new THREE.Group();
      const mat = feltMaterial();

      for (const rail of rails) {
        const v = rail_solid(rail, wireY);
        const centroid = v.reduce(
          (s, p) => [s[0] + p[0]/v.length, s[1] + p[1]/v.length, s[2] + p[2]/v.length], [0, 0, 0]);

        const pos = [], uv = [];
        const tri = (a, b, c) => {
          const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
          const e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
          const n = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
          const outward = n[0]*(a[0]-centroid[0]) + n[1]*(a[1]-centroid[1]) + n[2]*(a[2]-centroid[2]);
          const [p, q, r] = outward >= 0 ? [a, b, c] : [a, c, b];
          pos.push(...p, ...q, ...r);

          // UVs in METRES — the same convention the bed's ExtrudeGeometry UVs
          // use — so one shared `repeat` puts the cloth at an identical scale
          // on the bed and on every rail facet.
          //
          // Horizontal faces project straight down onto world (x, z), which
          // keeps the weave on the rail tops continuous with the bed beside
          // them. Every other face is unwrapped in its OWN plane instead of
          // being box-projected: the 45 deg nose face is the one you look
          // down at while aiming, and projecting it onto a world axis would
          // squash the weave across it by cos 45 (a visible 41% stretch).
          // "Horizontal" means within ~10 deg of flat, which covers the rail
          // cap AND the shallow top slant running down to the nose. Both then
          // share the bed's projection, so the weave stays continuous across
          // the crest and out onto the cloth; the slant pays 0.8% of stretch
          // for that, which is nothing. It must NOT be a plain "largest
          // component" test: on the 45 deg face |n.y| and |n.z| are EQUAL, so
          // that comparison is decided by floating-point noise and lands on a
          // different branch on different rails.
          const L = Math.hypot(n[0], n[1], n[2]);
          let project;
          if (Math.abs(n[1]) >= L * 0.985) {
            project = t => [t[0], t[2]];
          } else {
            const nh = [n[0]/L, n[1]/L, n[2]/L];
            // t1 = nh x up, horizontal and lying in the face; t2 = nh x t1.
            const t1 = [-nh[2], 0, nh[0]];
            const t1L = Math.hypot(t1[0], t1[2]);
            t1[0] /= t1L; t1[2] /= t1L;
            const t2 = [
              nh[1]*t1[2] - nh[2]*t1[1],
              nh[2]*t1[0] - nh[0]*t1[2],
              nh[0]*t1[1] - nh[1]*t1[0],
            ];
            project = t => [
              t[0]*t1[0] + t[1]*t1[1] + t[2]*t1[2],
              t[0]*t2[0] + t[1]*t2[1] + t[2]*t2[2],
            ];
          }
          for (const t of [p, q, r]) uv.push(...project(t));
        };
        // Fan each face: the end caps are pentagons, the sides quads.
        for (const f of RAIL_FACES) {
          for (let k = 1; k + 1 < f.length; k++) tri(v[f[0]], v[f[k]], v[f[k + 1]]);
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geom.computeVertexNormals();
        geom.computeBoundingBox();
        geom.computeBoundingSphere();
        const mesh = new THREE.Mesh(geom, mat);
        mesh.receiveShadow = true;   // felt rails sit in the balls' shadows
        mesh.castShadow = true;      // ...and throw their own onto the bed
        group.add(mesh);
      }

      // Throat wire, picking up where the rails' end caps leave off, so the
      // pocket is closed all the way round: a ball that misses the mouth meets
      // rail then wire, never a gap.
      for (const wire of wires) {
        const w = makePolylineMesh(wire, wireR, pocketWireY, { color, roughness, metalness });
        w.traverse(n => { n.castShadow = false; n.receiveShadow = false; });
        group.add(w);
      }

      return group;
}

// Scanned worsted billiard baize (assets/felt/) as a real PBR set: the colour map
// carries the green, the normal map the weave, the roughness map the way the nap
// catches the light. Because the colour is IN the texture the felt material tints
// with white — a green base colour here would multiply the green twice and turn
// the cloth muddy. All three tiles are seamless and power-of-two, so they repeat
// without a join and mipmap correctly.
//
// UVs on the felt come from ExtrudeGeometry's world-space UV generator, i.e. they
// are in METRES, so `repeat` is exactly "tiles per metre". Sizing the tile in
// inches keeps it tied to the scan's real-world footprint rather than to a magic
// number: one tile spans 25", ~1.57 tiles per metre, ~3.5 across a 2.24 m table.
const FELT_TILE_INCHES = 25;
const FELT_REPEAT = 1 / (FELT_TILE_INCHES * 0.0254);
const FELT_MAPS = {
      map:          '/assets/felt/color.jpg',
      normalMap:    '/assets/felt/normal.png',
      roughnessMap: '/assets/felt/roughness.jpg',
};
// Memoised: the bed and the rails are the same cloth, so they share one set of
// GPU textures. Loading a second copy would both waste memory and risk the two
// drifting to different repeats — and the whole point is that the weave runs
// across the bed and up onto the rails at one continuous scale.
let feltTextures = null;
function makeFeltTextures() {
      if (feltTextures) return { ...feltTextures };
      const loader = new THREE.TextureLoader();
      const out = {};
      for (const [slot, url] of Object.entries(FELT_MAPS)) {
        const tex = loader.load(url);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(FELT_REPEAT, FELT_REPEAT);
        tex.anisotropy = 8;
        // Only the colour map is authored in sRGB; normal/roughness are data.
        if (slot === 'map') tex.colorSpace = THREE.SRGBColorSpace;
        out[slot] = tex;
      }
      feltTextures = out;
      return { ...out };
}

// Felt on a mesh whose UVs are already in metres (see makeTableRails). Kept
// beside the bed's felt setup so the two can't drift apart.
function feltMaterial() {
      const mat = new THREE.MeshStandardMaterial({ side: THREE.FrontSide, flatShading: true });
      Object.assign(mat, makeFeltTextures());
      mat.color.set(0xffffff);          // the baize photo IS the colour
      mat.roughness = 1.0;              // roughnessMap multiplies this
      mat.metalness = 0.0;
      mat.normalScale = new THREE.Vector2(0.6, 0.6);
      return mat;
}

export function makePlanarMeshFromPolyline(points, thickness, y, options = {}) {
      if (!points || points.length < 3) throw new Error("Need ≥3 points");
      const {
        color = 0x2b6e3f,
        metalness = 0.0,
        roughness = 0.9,
        receiveShadow = true,
        castShadow = false,
        holes = [],
        felt = false,        // add the woven-felt grain (the green table cloth)
      } = options;

      const shape = new THREE.Shape();
      shape.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        shape.lineTo(points[i][0], points[i][1]);
      }
      shape.closePath();

      for (const hole of holes) {
        if (!hole || hole.length < 3) continue;
        const h = new THREE.Path();
        h.moveTo(hole[0][0], hole[0][1]);
        for (let i = 1; i < hole.length; i++) {
          h.lineTo(hole[i][0], hole[i][1]);
        }
        h.closePath();
        shape.holes.push(h);
      }

      const extrudeSettings = { depth: thickness, bevelEnabled: false, curveSegments: 12 };
      const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      geom.translate(0, 0, y-thickness / 2);
      geom.computeVertexNormals();
      geom.computeBoundingBox();
      geom.computeBoundingSphere();

      const mat = new THREE.MeshStandardMaterial({
        color, metalness, roughness, side: THREE.DoubleSide,
      });
      if (felt) {
        Object.assign(mat, makeFeltTextures());
        mat.color.set(0xffffff);          // the baize photo IS the colour
        mat.roughness = 1.0;              // roughnessMap multiplies this
        mat.normalScale = new THREE.Vector2(0.6, 0.6);
      }

      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = receiveShadow;
      mesh.castShadow = castShadow;
      mesh.rotation.x = -Math.PI/2;
      return mesh;
    }

// The wooden cabinet: a tapered skirt around the whole table, plus the flat
// deck that closes it off at the top.
//
// The skirt is one ruled surface. Both sections come from cabinet_section() with
// the same segment count, so lofting them is an index-for-index quad strip — and
// because the radius varies linearly with height, two rings describe the taper
// EXACTLY. Subdividing vertically would add triangles and no shape.
//
// The deck closes the top off: a flat ring of wood from the rail line out to the
// widest section. Its inner edge is cut to table_top_outline(), so it meets the
// rails and the pocket throats along their own outer boundary instead of a shape
// of its own. The pocket MOUTHS fall inside that outline, so they stay open with
// no holes cut for them — the wood does overhang the back of each cup, which is
// how a real pocket liner sits.
//
// Vertically its face is flush with the rails, which is also the wire's axis, and
// it is one rod radius thick (see cabinetYTop) — so it cuts the rod through the
// middle, leaving the lower half buried and the upper half standing proud.
export function makeTableCabinet(tableW, tableH, opts = {}) {
      const {
        rTop, rBottom, yTop, yBottom,
        color = 0x5c3a21,
        roughness = 0.62,
        segments = 24,
        deckThickness = cabinetDeckThickness,
      } = opts;

      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color, roughness, metalness: 0.0, side: THREE.DoubleSide, flatShading: false,
      });

      // --- skirt ---------------------------------------------------------
      const top = cabinet_section(tableW, tableH, rTop, segments);
      const bot = cabinet_section(tableW, tableH, rBottom, segments);
      const n = top.length;

      const pos = [];
      const idx = [];
      for (let i = 0; i < n; i++) {
        pos.push(top[i][0], yTop, top[i][1]);
        pos.push(bot[i][0], yBottom, bot[i][1]);
      }
      for (let i = 0; i < n; i++) {
        const a = 2 * i, b = a + 1;
        const c = 2 * ((i + 1) % n), d = c + 1;   // wraps, closing the loop
        idx.push(a, b, d, a, d, c);
      }

      const skirt = new THREE.BufferGeometry();
      skirt.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      skirt.setIndex(idx);
      skirt.computeVertexNormals();

      const skirtMesh = new THREE.Mesh(skirt, mat);
      skirtMesh.castShadow = true;
      skirtMesh.receiveShadow = true;
      group.add(skirtMesh);

      // --- deck ----------------------------------------------------------
      // Outer edge is the skirt's own top ring, so the two meet exactly at yTop.
      const deck = makePlanarMeshFromPolyline(
        top,
        deckThickness,
        yTop - deckThickness / 2,
        {
          color, roughness, metalness: 0.0,
          holes: [table_top_outline(tableW, tableH)],
          castShadow: true, receiveShadow: true,
        },
      );
      group.add(deck);

      return group;
}

export function makeCylindricalCupMesh(radius, height, opts = {}) {
  const {
    wall = 0.01,
    base = wall,
    color = 0xbfc5ca,
    roughness = 0.35,
    metalness = 0.0,
    radialSegments = 32,
    castShadow = false,
    receiveShadow = true,
    pos = { x: 0, y: 0, z: 0 },
    raiseTo = null,      // height to carry the wall up to, where raiseWhere says so
    raiseWhere = null,   // (x, z) => boolean, tested on the rim
  } = opts;

  const group = new THREE.Group();

  const matOuter = new THREE.MeshStandardMaterial({
    color, roughness, metalness, side: THREE.FrontSide,
  });
  const matInner = matOuter.clone();
  matInner.side = THREE.BackSide;

  const eps = 1e-4;
  const rOuter = radius;
  const rInner = Math.max(radius - wall, eps);

  // Bottom (solid disc)
  {
    const geo = new THREE.CylinderGeometry(rOuter, rOuter, base, radialSegments, 1, false);
    const mesh = new THREE.Mesh(geo, matOuter);
    mesh.position.set(pos.x, pos.y - height * 0.5, pos.z);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    group.add(mesh);
  }

  // Side wall (outer shell, open-ended)
  {
    const geo = new THREE.CylinderGeometry(rOuter, rOuter, height, radialSegments, 1, true);
    const mesh = new THREE.Mesh(geo, matOuter);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    group.add(mesh);
  }

  // Side wall (inner shell, flipped normals, open-ended)
  {
    const geo = new THREE.CylinderGeometry(rInner - eps, rInner - eps, height, radialSegments, 1, true);
    const mesh = new THREE.Mesh(geo, matInner);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    group.add(mesh);
  }

  // Top ring (annular disc between outer and inner wall)
  {
    const geo = new THREE.RingGeometry(rInner - eps, rOuter, radialSegments);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, matOuter);
    mesh.position.set(pos.x, pos.y + height * 0.5, pos.z);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    group.add(mesh);
  }

  // Raised back. The rim sits below the felt, so from inside the table you look
  // straight over it, through the mouth and on into the cabinet — the wire and
  // the cup read as separated by a gap of nothing. Where the rim is OUTSIDE the
  // table's top outline it has the wooden deck above it, so the wall can run up
  // to the deck's underside and close that line of sight. Where it is inside the
  // outline it must stay low: that is the mouth the ball drops through.
  //
  // The run ends where the cup circle crosses the outline, which is on the rail's
  // outer edge — buried inside the rail solid, so the step in height is hidden.
  // Built non-indexed so computeVertexNormals flat-shades it: the wall, the top
  // and the end caps meet at hard edges and must not be smoothed into each other.
  if (raiseTo != null && raiseWhere) {
    const rimY = pos.y + height * 0.5;
    const ring = (k) => (k / radialSegments) * Math.PI * 2;
    const raised = [];
    for (let k = 0; k < radialSegments; k++) {
      const th = ring(k + 0.5);   // the segment's midpoint decides the segment
      raised.push(!!raiseWhere(pos.x + rOuter * Math.cos(th), pos.z + rOuter * Math.sin(th)));
    }

    // Contiguous runs, walking the circle from the first segment that starts one.
    const start = raised.indexOf(false) === -1 ? 0 : (raised.indexOf(false) + 1) % radialSegments;
    const runs = [];
    let cur = null;
    for (let n = 0; n < radialSegments; n++) {
      const k = (start + n) % radialSegments;
      if (raised[k]) (cur ??= { from: k, len: 0 }).len++;
      else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);

    const verts = [];
    const tri = (a, b, c) => verts.push(...a, ...b, ...c);
    const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

    for (const { from, len } of runs) {
      const P = (k, r, y) => {
        const th = ring(k);
        return [pos.x + r * Math.cos(th), y, pos.z + r * Math.sin(th)];
      };
      const rIn = rInner - eps;
      for (let n = 0; n < len; n++) {
        const a = from + n, b = a + 1;
        quad(P(a, rOuter, rimY), P(b, rOuter, rimY), P(b, rOuter, raiseTo), P(a, rOuter, raiseTo));
        quad(P(a, rIn, rimY),    P(a, rIn, raiseTo), P(b, rIn, raiseTo),    P(b, rIn, rimY));
        quad(P(a, rOuter, raiseTo), P(b, rOuter, raiseTo), P(b, rIn, raiseTo), P(a, rIn, raiseTo));
      }
      // Close each end so the wall never reads as paper-thin.
      for (const k of [from, from + len]) {
        quad(P(k, rOuter, rimY), P(k, rIn, rimY), P(k, rIn, raiseTo), P(k, rOuter, raiseTo));
      }
    }

    // No raised run at all (every segment inside the outline) leaves nothing to
    // build — a zero-vertex mesh would still cost a draw call.
    if (verts.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.computeVertexNormals();
      const mat = matOuter.clone();
      mat.side = THREE.DoubleSide;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      group.add(mesh);
    }
  }

  group.traverse(n => {
    if (n.isMesh) {
      n.castShadow = castShadow;
      n.receiveShadow = receiveShadow;
    }
  });

  return group;
}
