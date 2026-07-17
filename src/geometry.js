// src/geometry.js — visual table geometry (Three meshes). Client-only.
// Pure point generators now live in table.js (shared with the server); they are
// re-exported here so existing client imports keep working. The physics builders
// moved to geometry.physics.js.
import * as THREE from "/lib/three.module.js";
export { rail_pts, felt_pts, pocket_positions } from './table.js';

export function makePolylineMesh(pointsXZ, wireR, wireY, opts = {}) {
      const {
        color = 0xbfc5ca,         // soft steel
        shininess = 80,           // Phong highlight
        radialSegments = 16
      } = opts;

      const group = new THREE.Group();
      const mat = new THREE.MeshPhongMaterial({
        color,
        shininess,
        specular: new THREE.Color(0x777777)
      });

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

export function makePlanarMeshFromPolyline(points, thickness, y, options = {}) {
      if (!points || points.length < 3) throw new Error("Need ≥3 points");
      const {
        color = 0x2b6e3f,
        metalness = 0.0,
        roughness = 0.9,
        receiveShadow = true,
        castShadow = false,
        holes = [],
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

      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = receiveShadow;
      mesh.castShadow = castShadow;
      mesh.rotation.x = -Math.PI/2;
      return mesh;
    }

export function makeCylindricalCupMesh(radius, height, opts = {}) {
  const {
    wall = 0.01,
    base = wall,
    color = 0xbfc5ca,
    shininess = 80,
    radialSegments = 32,
    castShadow = false,
    receiveShadow = true,
    pos = { x: 0, y: 0, z: 0 },
  } = opts;

  const group = new THREE.Group();

  const matOuter = new THREE.MeshPhongMaterial({
    color, shininess, specular: new THREE.Color(0x777777), side: THREE.FrontSide,
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

  group.traverse(n => {
    if (n.isMesh) {
      n.castShadow = castShadow;
      n.receiveShadow = receiveShadow;
    }
  });

  return group;
}
