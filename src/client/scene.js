// src/scene.js
import * as THREE from "/lib/three.module.js";
import { tableW, tableH, cabinetRTop } from '../shared/constants.js';

let renderer, scene, camera, perspCamera, orthoCamera;
let DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
const canvas = document.getElementById('stage');

// Full half-extents of the table INCLUDING the pockets + rail lip, plus a little
// margin. The overhead (orthographic) view is sized to contain this at zoom 1, so
// the whole table always fits on screen whatever the aspect ratio (esp. portrait
// mobile). The top view lays the table's long axis (world X) along whichever
// screen axis is longer — see topPortrait.
//
// The cabinet's widest section (cabinetRTop, at the rail line) is the outermost
// thing in the scene, so the bounds come from it rather than from a hand-tuned
// pad off the cushions — widen the cabinet and the top view still frames it.
const CABINET_HALF_X = tableW / 2 + 0.015 + cabinetRTop;   // ≈ 1.30
const CABINET_HALF_Z = tableH / 2 + 0.015 + cabinetRTop;   // ≈ 0.74
const TABLE_HALF_X = CABINET_HALF_X + 0.02;
const TABLE_HALF_Z = CABINET_HALF_Z + 0.02;

// True when the overhead view is turned a quarter turn so the table's long axis
// runs UP the screen instead of across it. Set from the canvas aspect in
// fitCanvas; cue.js reads it to orient the camera and the pan/pinch mapping.
//
// The rule is just `aspect < 1`, and that is not a guess about what "feels"
// portrait — it is exactly the crossover. Contain-fitting a 2*Hx by 2*Hz box
// needs a half-height of max(Hz, Hx/aspect) laid out along X and max(Hx,
// Hz/aspect) laid out along Z; with Hx > Hz those two are equal at aspect 1 and
// each wins on its own side of it. So turning at 1 always shows the table as
// large as it can possibly be drawn.
let topPortrait = false;
export function isTopPortrait() { return topPortrait; }

export function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1020');

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.shadowMap.enabled = true;
  // PCF with a soft kernel. The default (PCFShadowMap) point-samples the depth
  // map, so a shadow edge lands on texel boundaries and reads as stair-stepped
  // pixels — which is most of why these looked like a bitmap.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  perspCamera = new THREE.PerspectiveCamera(45, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.01, 100);
  perspCamera.position.set(-tableW * 0.5, 0.4, 0);
  perspCamera.lookAt(0, 0, 0);

  // Orthographic camera for the bird's-eye view (no perspective distortion:
  // the table renders as a true plan). Frustum is sized in fitCanvas.
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);

  camera = perspCamera;

  // Pool-hall rig: three shaded bulbs in a row down the long axis, hung low
  // over the cloth, plus a dim hemisphere standing in for light bouncing off
  // the cloth and walls so the shadows don't go to pure black.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.15));
  // Flat fill on top of the hemisphere. The hemisphere is directional — it
  // gives a surface nothing once that surface faces sideways — so it leaves the
  // cabinet's outward faces dark, the lamps all being inside the table's own
  // footprint and firing straight down. This lifts those by a constant amount
  // regardless of which way they point. Deliberately small next to the 3.0
  // bulbs: ambient reaches into the shadows too, so more than this and the
  // cloth's shadows start washing out.
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  for (const x of [-BULB_SPACING, 0, BULB_SPACING]) addBulb(x);

  // Soft fill from the four cardinal directions (see addSideLight): reads as
  // ambient from the sides, but grazes in low enough that each rail's overhang
  // casts a shadow band onto the cloth — which is what makes the cushion line
  // legible from the overhead view.
  addSideLight(1, 0); addSideLight(-1, 0);
  addSideLight(0, 1); addSideLight(0, -1);

  window.addEventListener('resize', fitCanvas);
  fitCanvas();
  return { scene, camera, renderer, canvas, DPR };
}

// One shaded bulb hung over the cloth at world x, pointing straight down.
//
// SpotLight, not PointLight: a pool lamp has a shade that throws light down
// rather than radiating in all directions, and — the practical half — a
// shadow-casting PointLight needs a CUBE shadow map, so three of them would
// render eighteen shadow faces per frame instead of three.
// Height and cone were picked together, not by eye: hung LOW with a wide cone
// the cloth falls off ~9x from the middle spot to the corners and the corner
// balls go murky, while a wide cone also spreads each shadow map over a bigger
// footprint and coarsens it. Going higher with a narrower cone fixes both at
// once — this lands at 2.6x centre-to-corner (pooled, but every ball still
// clearly lit) on a 2.88 m footprint.
const BULB_HEIGHT  = 1.40;   // above the cloth
const BULB_SPACING = 0.80;   // between adjacent bulbs, down the long axis
function addBulb(x) {
  const bulb = new THREE.SpotLight(0xfff4e2, 2.3, 0, 0.80, 0.45, 2);
  //                               warm       int  dist  angle  penumbra  decay
  bulb.position.set(x, BULB_HEIGHT, 0);

  // A SpotLight aims at its target, which defaults to the origin — leaving it
  // there would splay all three lamps inward at the centre spot instead of
  // hanging them straight down. The target is a real object and only counts
  // once it is in the scene graph.
  bulb.target.position.set(x, 0, 0);
  scene.add(bulb.target);

  bulb.castShadow = true;
  // A spot's shadow map covers only its cone, so it buys sharpness the old
  // single directional light couldn't: a 2.88 m footprint at 2048 is ~1.4 mm
  // per texel, against the 2.5 mm that rig managed. Three maps at this size is
  // ~50 MB of depth texture though — this is the dial to turn down first if
  // it's too heavy on a phone, and dropping to 1024 only costs ~2.8 mm.
  const S = bulb.shadow;
  S.mapSize.set(2048, 2048);
  S.camera.near = 0.5;
  S.camera.far  = 3.0;
  // Depth bias only — normalBias MUST stay 0 here, and it is not a matter of
  // picking a small enough value. normalBias offsets the shadow lookup along
  // the RECEIVER's normal, so how much damage it does depends on the local
  // occluder-to-receiver depth gap. A ball resting on the cloth is the worst
  // case there is: at the ball's silhouette the lamp's ray grazes the sphere
  // tangentially, so that gap goes to zero, and any normalBias at all erases
  // the shadow in a band around the silhouette. Since the ball sits ON the
  // bed, silhouette and contact circle coincide — so the erased band lands
  // exactly where the shadow meets the ball and you get a bright halo with the
  // shadow surviving only outside it (an annulus, not a contact shadow).
  // Measured down a column through the contact point, 116 = lit cloth, 21 =
  // full shadow: at 0.002 the first samples read 116 108 85 50 25 21, at 0.01
  // the shadow is gone entirely, at 0 it starts at 21 and is properly attached.
  // Plain `bias` carries the acne duty on its own — the cloth faces the lamps
  // nearly head-on, which is the easy case — and no acne shows up without it.
  S.bias = -0.0001;
  S.normalBias = 0;

  scene.add(bulb);
}

// One distant, low fill light out past a cushion, in cardinal direction (dx, dz)
// (a unit step in X or Z). It sits SIDE_DIST metres out and SIDE_HEIGHT up, so it
// grazes the table at a shallow ~30 deg — high enough not to shine under the rail,
// low enough that the rail's overhanging lip drops a shadow band onto the cloth
// just inside the cushion. Four of these (±X, ±Z) frame the whole playing area
// with an even shadow that reads from bird's-eye.
//
// DirectionalLight, not Spot/Point: the rays are parallel, so the band is the
// same width all the way down a rail rather than fanning out from a bulb; and a
// single square ortho shadow map covers the table, unlike a point light's cube.
const SIDE_DIST   = 7.0;    // metres out past the cushion ("5-10 m away")
const SIDE_HEIGHT = 3.0;    // metres up -> elevation ~23 deg (grazes low; wide band)
const SIDE_INT    = 0.35;   // soft: enough contrast for the band, not a wash-out
function addSideLight(dx, dz) {
  const L = new THREE.DirectionalLight(0xfff4e2, SIDE_INT);
  L.position.set(dx * SIDE_DIST, SIDE_HEIGHT, dz * SIDE_DIST);
  L.target.position.set(0, 0, 0);
  scene.add(L.target);

  L.castShadow = true;
  const S = L.shadow;
  S.mapSize.set(1024, 1024);
  // Ortho frustum big enough to contain the whole table from this oblique angle;
  // near/far bracket its depth along the light's ~8 m line of sight to the centre.
  S.camera.left = -1.8; S.camera.right = 1.8;
  S.camera.top  =  1.8; S.camera.bottom = -1.8;
  S.camera.near = 3.0;
  S.camera.far  = 14.0;
  // A grazing light exaggerates depth acne on the near-flat cloth, so this needs
  // a touch more depth bias than the near-overhead bulbs. normalBias stays 0 for
  // the same contact-shadow reason spelled out in addBulb.
  S.bias = -0.0004;
  S.normalBias = 0;
  scene.add(L);
}

// Swap the active camera: 'ortho' for the bird's-eye view, 'persp' otherwise.
// `camera` is a live export binding, so importers (cue.js) always position the
// active one.
export function setCameraMode(mode) {
  if (!perspCamera) return;   // before initScene
  camera = (mode === 'ortho') ? orthoCamera : perspCamera;
}

export function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  const aspect = (r.width || 1) / (r.height || 1);
  if (perspCamera) {
    perspCamera.aspect = aspect;
    perspCamera.updateProjectionMatrix();
  }
  topPortrait = aspect < 1;
  if (orthoCamera) {
    // Contain-fit against whichever way the table is laid out: the vertical
    // half-height must cover the axis running up the screen AND the across-screen
    // axis once divided by the aspect — whichever is larger wins, so nothing is
    // ever cropped, from wide desktop to portrait phone.
    const [up, across] = topPortrait ? [TABLE_HALF_X, TABLE_HALF_Z] : [TABLE_HALF_Z, TABLE_HALF_X];
    const halfH = Math.max(up, across / aspect);
    orthoCamera.left = -halfH * aspect;
    orthoCamera.right = halfH * aspect;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
    orthoCamera.updateProjectionMatrix();
  }
}

export function render() {
  renderer.render(scene, camera);
}

export { scene, camera, renderer };
