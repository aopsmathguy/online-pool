// src/geometry.js — visual table geometry (Three meshes). Client-only.
// Pure point generators now live in table.js (shared with the server); they are
// re-exported here so existing client imports keep working. The physics builders
// moved to geometry.physics.js.
import * as THREE from "/lib/three.module.js";
import { table_parts, rail_solid, RAIL_FACES, cabinet_section, table_top_outline, pocket_positions } from '../shared/table.js';
import { pocketWireY, inset, cabinetRTop, cabinetEdgeR } from '../shared/constants.js';
import { qualityLevel, onQualityChange } from './settings.js';
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
// are in METRES, so `repeat` is exactly "tiles per metre". The scan's real-world
// footprint is 50 cm square, so one tile spans 0.5 m, 2 tiles per metre, ~4.5
// across a 2.24 m table.
const FELT_TILE_METRES = 0.5;
const FELT_REPEAT = 1 / FELT_TILE_METRES;
const FELT_MAPS = {
      map:          '/assets/felt/color.jpg',
      normalMap:    '/assets/felt/normal.png',
      roughnessMap: '/assets/felt/roughness.jpg',
};

// Scanned oak table wood (assets/wood/) for the cabinet, replacing the old flat
// brown. Same idea as the felt: the colour lives IN the photo, so the material
// tints white and lets the roughness map carry the sheen of the grain. Only the
// diffuse and roughness maps ship — the source set's normal is an EXR (needs a
// separate loader) and its displacement is useless on the two-ring skirt.
//
// UVs on both the skirt and the deck are in METRES, so WOOD_REPEAT is "tiles per
// metre". The scan's authored density is 109.2 px/cm, so a 4096-px tile spans
// 4096 / 109.2 = 37.5 cm — deriving the repeat from that pins the grain to its
// real-world scale rather than a guessed number.
const WOOD_PX = 4096;
const WOOD_PX_PER_CM = 109.2;
const WOOD_TILE_METRES = WOOD_PX / WOOD_PX_PER_CM / 100;   // ≈ 0.375 m
const WOOD_REPEAT = 1 / WOOD_TILE_METRES;                  // ≈ 2.666 tiles/m
const WOOD_MAPS = {
      map:          '/assets/wood/color.jpg',
      roughnessMap: '/assets/wood/roughness.jpg',
};

// ---- Texture sets, sized by the graphics preset -------------------------------
//
// Both surfaces are the same story: a memoised set of GPU textures shared by
// every mesh that wears them (the bed and the rails are the same cloth, the
// skirt and the deck the same oak), built at whatever resolution and map count
// the current preset asks for.
//
// Two dials, and they save different things:
//   texMax     caps each map's edge, redrawing the decoded image into a smaller
//              canvas. That is a VRAM and mip-chain saving only — the file still
//              downloads at full size, because there is one file per map on
//              disk. 4096 -> 1024 is 16x less texture memory for that map.
//   normalMap/roughnessMap
//              drop the map entirely, so it is never even fetched. This is the
//              bandwidth dial: felt/normal.png alone is 11 MB, and anything
//              below High never asks for it.
//
// Every slot a preset omits must be actively nulled on the material rather than
// just left out of the assign — a material built at Ultra and then dropped to
// Low would otherwise keep the very maps the preset is trying to shed. That is
// what TEX_SLOTS is for.
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap'];

function buildTextureSet(maps, repeat) {
      const q = qualityLevel();
      const loader = new THREE.TextureLoader();
      const out = {};
      for (const [slot, url] of Object.entries(maps)) {
        if (slot === 'normalMap' && !q.normalMap) continue;
        if (slot === 'roughnessMap' && !q.roughnessMap) continue;
        // The image is decoded at full size and then shrunk in place: three has
        // already stamped it onto the texture by the time onLoad runs, so
        // swapping .image and re-flagging it is what makes the upload use the
        // small one. Textures below the cap are left exactly as they are.
        const tex = loader.load(url, (t) => {
          const small = downscaleImage(t.image, q.texMax);
          if (small !== t.image) { t.image = small; t.needsUpdate = true; }
        });
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeat, repeat);
        tex.anisotropy = q.anisotropy;
        // Only the colour map is authored in sRGB; normal/roughness are data.
        if (slot === 'map') tex.colorSpace = THREE.SRGBColorSpace;
        out[slot] = tex;
      }
      return out;
}

// Redraw an image into a canvas whose long edge is at most maxPx. Both source
// tiles are square powers of two, so every step down stays a power of two and
// keeps repeat-wrapping + mipmapping happy.
function downscaleImage(img, maxPx) {
      const w = img?.naturalWidth || img?.width || 0;
      const h = img?.naturalHeight || img?.height || 0;
      const longest = Math.max(w, h);
      if (!longest || longest <= maxPx) return img;
      const s = maxPx / longest;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
}

// The two live sets, plus the materials wearing them. Both are rebuilt in place
// when the quality slider moves, which is why the materials have to be tracked:
// they are handed out to meshes all over the scene and there is no other way
// back to them.
let feltTextures = null, woodTextures = null;
const feltMaterials = new Set(), woodMaterials = new Set();

const feltSet = () => (feltTextures ||= buildTextureSet(FELT_MAPS, FELT_REPEAT));
const woodSet = () => (woodTextures ||= buildTextureSet(WOOD_MAPS, WOOD_REPEAT));

// Dress a material as baize. The photo IS the colour, so the material tints
// white — a green base here would multiply the green twice and turn the cloth
// muddy.
function applyFelt(mat) {
      feltMaterials.add(mat);
      const set = feltSet();
      for (const slot of TEX_SLOTS) mat[slot] = set[slot] || null;
      mat.color.set(0xffffff);
      mat.metalness = 0.0;
      // roughnessMap MULTIPLIES this, so 1.0 is "let the map decide". With no
      // map that same 1.0 is a real value — dead matte, which for worsted cloth
      // is close enough to right that the low presets need no other fix-up.
      mat.roughness = set.roughnessMap ? 1.0 : 0.95;
      mat.normalScale = new THREE.Vector2(0.6, 0.6);
      mat.needsUpdate = true;
      return mat;
}

// Dress a material as the scanned oak. Same reasoning as applyFelt, except the
// no-map roughness matters more here: the grain's sheen lives entirely in the
// roughness map, so without it the wood needs the old hand-set 0.62 or the
// cabinet reads as cardboard.
function applyWood(mat) {
      woodMaterials.add(mat);
      const set = woodSet();
      for (const slot of TEX_SLOTS) mat[slot] = set[slot] || null;
      mat.color.set(0xffffff);
      mat.roughness = set.roughnessMap ? 1.0 : 0.62;
      mat.needsUpdate = true;
      return mat;
}

// Quality changed: throw both sets away and re-dress every material that was
// ever built from them. The old textures are disposed rather than dropped —
// they are the megabytes the lower preset was asked to reclaim.
onQualityChange(() => {
      for (const set of [feltTextures, woodTextures]) {
        if (set) for (const tex of Object.values(set)) tex.dispose();
      }
      feltTextures = woodTextures = null;
      for (const mat of feltMaterials) applyFelt(mat);
      for (const mat of woodMaterials) applyWood(mat);
});

// Felt on a mesh whose UVs are already in metres (see makeTableRails).
function feltMaterial() {
      return applyFelt(new THREE.MeshStandardMaterial({ side: THREE.FrontSide, flatShading: true }));
}

// A horizontal surface from a closed polyline, optionally with holes punched in
// it. `thickness` 0 gives a single flat FACE lying at y — no sides, no underside,
// just the one sheet of triangles; any positive thickness extrudes a slab whose
// MIDPLANE is at y. Both are double-sided, so a bare face is still visible from
// underneath.
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
        wood = false,        // add the scanned oak grain (the cabinet)
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

      // ShapeGeometry lays the face in the local XY plane at z = 0 and takes its
      // UVs straight from the shape's own coordinates — metres, same as the
      // extruded top face and the skirt, so the wood tiles across all of them at
      // one scale.
      const geom = thickness > 0
        ? new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 12 })
        : new THREE.ShapeGeometry(shape, 12);
      geom.translate(0, 0, y - thickness / 2);
      geom.computeVertexNormals();
      geom.computeBoundingBox();
      geom.computeBoundingSphere();

      const mat = new THREE.MeshStandardMaterial({
        color, metalness, roughness, side: THREE.DoubleSide,
      });
      if (felt) applyFelt(mat);
      if (wood) applyWood(mat);

      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = receiveShadow;
      mesh.castShadow = castShadow;
      mesh.rotation.x = -Math.PI/2;
      return mesh;
    }

// The wooden cabinet: a tapered skirt around the whole table, capped by a flat
// deck at the top and a flat floor at the bottom.
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
// The floor closes the bottom off the same way, minus the cut-out: the skirt's
// own bottom ring filled solid, so the underside reads as a closed box.
//
// Both caps are single FACES, not slabs. Nothing ever sees an edge of either —
// the deck's outer edge is the skirt's top ring and the floor's is its bottom
// ring, so a thickness would only ever be hidden behind the skirt. The deck's
// plane is flush with the rails, which is also the wire's axis, so it cuts the
// rod through the middle, leaving the lower half buried and the upper half
// standing proud.
export function makeTableCabinet(tableW, tableH, opts = {}) {
      const {
        rTop, rBottom, yTop, yBottom,
        color = 0x5c3a21,
        roughness = 0.62,
        segments = 24,
        edgeR = cabinetEdgeR,
        edgeSegments = 6,
      } = opts;

      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color, roughness, metalness: 0.0, side: THREE.DoubleSide, flatShading: false,
      });
      // The wood photo IS the colour; the roughness map carries the grain's sheen.
      applyWood(mat);

      // --- skirt ---------------------------------------------------------
      // A stack of rings, lofted in order. Every ring is a cabinet_section, so
      // they all carry the same point count and consecutive ones join as a plain
      // index-for-index quad strip however many there are.
      //
      // The bullnose comes first: `edgeR` sweeps a quarter circle from the deck's
      // flat (radius rTop - edgeR at yTop, tangent horizontal) out and down to the
      // cabinet's widest section (rTop at yTop - edgeR, tangent vertical), from
      // where the original taper carries on to the bottom. The roll is therefore
      // paid for out of the DECK's width, not the footprint. The taper still needs
      // only its two rings — radius is linear in height, so two describe it
      // exactly.
      const arc90 = [];
      for (let i = 0; i <= edgeSegments; i++) {
        const th = (i / edgeSegments) * (Math.PI / 2);
        arc90.push({ r: rTop - edgeR + edgeR * Math.sin(th), y: yTop - edgeR + edgeR * Math.cos(th) });
      }
      const rings = [...arc90, { r: rBottom, y: yBottom }]
        .map(({ r, y }) => ({ y, pts: cabinet_section(tableW, tableH, r, segments) }));
      const n = rings[0].pts.length;

      // UVs in METRES so the wood tiles at the same tiles-per-metre as the deck.
      // U is the cumulative arc length around the ring, taken ONCE from the widest
      // ring and reused for all of them: the rings are offsets of each other, so a
      // shared U keeps the grain running in straight vertical lines instead of
      // shearing as the perimeter shrinks. V is the cumulative distance DOWN the
      // profile rather than the raw height, so the grain does not compress over the
      // roll — a point moves by Δr laterally and Δy vertically between rings, and
      // the surface distance is the hypotenuse. The ring closes with a single back
      // seam at the wrap, which the wood's RepeatWrapping absorbs.
      const widest = rings[arc90.length - 1].pts;
      const uAt = [];
      let arc = 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) arc += Math.hypot(widest[i][0] - widest[i - 1][0], widest[i][1] - widest[i - 1][1]);
        uAt.push(arc);
      }

      const pos = [];
      const uv = [];
      const idx = [];
      let v = 0;
      for (let k = 0; k < rings.length; k++) {
        const ring = rings[k];
        if (k > 0) {
          const prev = rings[k - 1];
          // Δr read off the straight sides, where the offset is the whole distance.
          const dr = Math.hypot(ring.pts[0][0] - prev.pts[0][0], ring.pts[0][1] - prev.pts[0][1]);
          v += Math.hypot(dr, ring.y - prev.y);
        }
        for (let i = 0; i < n; i++) {
          pos.push(ring.pts[i][0], ring.y, ring.pts[i][1]);
          uv.push(uAt[i], v);
        }
      }
      for (let k = 0; k < rings.length - 1; k++) {
        const row = k * n, next = (k + 1) * n;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;                 // wraps, closing the loop
          idx.push(row + i, next + i, next + j, row + i, next + j, row + j);
        }
      }

      const skirt = new THREE.BufferGeometry();
      skirt.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      skirt.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      skirt.setIndex(idx);
      skirt.computeVertexNormals();

      const skirtMesh = new THREE.Mesh(skirt, mat);
      skirtMesh.castShadow = true;
      skirtMesh.receiveShadow = true;
      group.add(skirtMesh);

      // --- deck and floor -------------------------------------------------
      // Each cap's outline IS the skirt ring at that height, so the three meet
      // exactly with no seam to close. The deck now takes the bullnose's TOP ring,
      // which the roll leaves tangent to it — the wood runs flat out to there and
      // then turns over.
      const face = { color, roughness, metalness: 0.0, wood: true, castShadow: true, receiveShadow: true };
      group.add(makePlanarMeshFromPolyline(rings[0].pts, 0, yTop, {
        ...face,
        holes: [table_top_outline(tableW, tableH)],
      }));
      const bottom = rings[rings.length - 1];
      group.add(makePlanarMeshFromPolyline(bottom.pts, 0, bottom.y, face));

      return group;
}

// The 18 rail sights ("diamonds") of a regulation table. They divide the playing
// surface into an 8 x 4 grid: on each LONG rail three diamonds sit between the
// corner pocket and the side pocket (the 4th grid line is the side pocket itself,
// so no diamond there), and on each SHORT rail three sit at the quarter lines
// (the middle one on the centreline). That is 3*4 (long) + 3*2 (short) = 18.
//
// Positions are referenced to the POCKET CENTRES along each rail, per the WPA
// spec: the corner and side pockets are the grid's end points, and the diamonds
// fall at the equal divisions between them — not at even fractions of the bare
// nose-to-nose rectangle, which lands each sight a few mm short.
//
// Each diamond is inlaid in the wooden deck (the flat wood ring outside the
// rails, whose top is flush with the rail at pocketWireY), centred across the
// width of that wood band. A diamond is a small flat rhombus lying face-up with
// its long axis pointing ACROSS the rail — toward the table — the way a
// mother-of-pearl sight is set.
export function makeTableSights(tableW, tableH, opts = {}) {
      const {
        color = 0xefe6cf,     // aged ivory / mother-of-pearl
        halfLen = 0.013,      // point-to-point ACROSS the rail (~1 in tip to tip)
        halfWid = 0.0075,     // point-to-point ALONG the rail
        lift = 0.001,         // sit just proud of the wood so it can't z-fight
        gap = 0.04,          // diamond CENTRE out from the rail's outer edge
      } = opts;

      const p = pocket_positions(tableW, tableH);
      const cornerX = Math.abs(p[0][0]);   // corner-pocket centre |x|  (long-rail ends)
      const cornerZ = Math.abs(p[0][1]);   // corner-pocket centre |z|  (short-rail ends)

      // Back from the nose onto the wood deck's flat. The deck's inner edge is the
      // rail's outer edge, `inset` out from the nose, and `gap` rides the sight a
      // FIXED distance further out from there — the way a real inlaid diamond hugs
      // the cushion at a set offset regardless of how wide the rest of the cabinet
      // is. It was once a fraction of the wood band's width, which meant retuning
      // cabinetRTop silently walked all 18 diamonds toward or away from the rail.
      //
      // The flat it has to fit on runs out to the cabinet's top section —
      // cabinetRTop past the corner-pocket centres, which themselves sit
      // (cornerX - tableW/2) out from the nose — less cabinetEdgeR, where the
      // bullnose starts rolling over. `gap + halfLen` must stay inside that, or the
      // outer tip creeps onto the roll; the assert says so rather than leaving a
      // subtly bent diamond to be spotted by eye.
      const woodInner = inset;
      const woodOuter = (cornerX - tableW / 2) + cabinetRTop - cabinetEdgeR;
      const setback = woodInner + gap;
      if (setback + halfLen > woodOuter) {
        throw new Error(`sight gap ${gap} runs off the wood flat (${(woodOuter - woodInner).toFixed(3)} m wide)`);
      }
      const y = pocketWireY + lift;

      // Long rails: x at the quarter divisions between a corner pocket (|x|=cornerX)
      // and the side pocket (x=0); z pinned on the sight line, one rail each side.
      const longX = [0.25, 0.5, 0.75].flatMap(f => [-cornerX * f, cornerX * f]);
      // Short rails: z at the quarter divisions between the two corner pockets
      // (z from -cornerZ to +cornerZ), i.e. -cornerZ/2, 0, +cornerZ/2.
      const shortZ = [-cornerZ / 2, 0, cornerZ / 2];

      // One flat rhombus authored with its LONG axis along local +X (halfLen),
      // short axis along local +Y (halfWid); laid flat into the XZ plane below.
      const shape = new THREE.Shape();
      shape.moveTo(halfLen, 0);
      shape.lineTo(0, halfWid);
      shape.lineTo(-halfLen, 0);
      shape.lineTo(0, -halfWid);
      shape.closePath();
      const geom = new THREE.ShapeGeometry(shape);
      geom.rotateX(-Math.PI / 2);          // stand the shape up flat, long axis -> +X

      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.35, metalness: 0.1,
        emissive: 0x3a3320, emissiveIntensity: 0.25,   // a touch of glow so they read under the felt-level light
      });

      const group = new THREE.Group();
      // The rhombus is authored long-axis-along-X; `longAxisZ` turns it 90° so the
      // long axis runs along Z instead. Either way the long axis points ACROSS its
      // rail, toward the table.
      const add = (x, z, longAxisZ) => {
        const d = new THREE.Mesh(geom, mat);
        d.position.set(x, y, z);
        if (longAxisZ) d.rotation.y = Math.PI / 2;
        d.castShadow = false;
        d.receiveShadow = true;
        group.add(d);
      };

      // Top / bottom long rails run along X, so ACROSS is Z: long axis along Z. The
      // nose is at z = tableH/2; the wood sits `setback` further OUT.
      const longZ = tableH / 2 + setback;
      for (const x of longX) {
        add(x, -longZ, true);
        add(x, +longZ, true);
      }
      // Left / right short rails run along Z, so ACROSS is X: long axis along X.
      const shortX = tableW / 2 + setback;
      for (const z of shortZ) {
        add(-shortX, z, false);
        add(+shortX, z, false);
      }

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
  // table's top outline it has the wire and the deck above it, so the wall can
  // run up to `raiseTo` and close that line of sight. Where it is inside the
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
