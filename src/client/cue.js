// src/cue.js
import * as THREE from "/lib/three.module.js";
import { scene, camera, setCameraMode } from './scene.js';
import { R } from '../shared/constants.js';

// Cue stick dimensions
const STICK_LEN = 1.45;
const TIP_R = 0.007;
const BUTT_R = 0.014;
const GAP = 0.012;          // distance between cue tip and ball when at rest
const PULLBACK_MAX = 0.825;  // maximum draw-back distance (drives shot power); ai.js MAX_POWER must match
const VISUAL_PULLBACK_SCALE = 0.35; // visual stick draw is this fraction of pullback

// Third-person orbit camera. The camera orbits the cue ball at a fixed
// distance, with yaw/pitch controlled by the mouse. Pitch raises the camera
// above the table; pitch=0 is horizontal, pitch=π/2 is straight down.
const CAM_DIST       = 0.8;     // distance from cue ball to camera
const CAM_LOOK_AHEAD = 0.25;     // shift the look target past the ball along aim
const CAM_RAISE      = 0.1;     // extra vertical lift so the cue stick passes below the camera
const PITCH_MIN = 0.0;          // ~6°  (almost horizontal)
const PITCH_MAX = 1.50;          // ~75° (steep top-down)

// View mode: 'aim' is the third-person orbit camera (sighting down the stick);
// 'top' is a fixed overhead view of the whole table (planning/ball-in-hand);
// 'free' is a fly-around spectator camera (mouse looks, WASD/QE move).
const TOP_CAM_HEIGHT = 2.15;    // camera height for the overhead view
let viewMode = 'aim';
export function getViewMode() { return viewMode; }

// Free-fly ("look around the table") camera. Position + look yaw/pitch are its
// own state, seeded from the live camera when the mode is entered so it never
// jumps. Mouse turns it; WASD walk horizontally (relative to look yaw), Q/E go
// down/up. No bounds — it can roam anywhere.
const FREE_SENS_X = 0.0025;     // radians per pixel, look yaw
const FREE_SENS_Y = 0.0022;     // radians per pixel, look pitch
const FREE_PITCH_LIMIT = 1.5;   // clamp shy of straight up/down (~86°)
const FREE_SPEED = 0.9;         // metres per second of WASD + Space/Shift travel
const freeCam = { x: 0, y: 1, z: 0, yaw: 0, pitch: 0 };

// Scroll-wheel dolly. The wheel moves a *target* (throttled in input.js); the
// live value eases toward it each frame (see placeCamera) so it never jumps.
// In aim mode it slides the camera along the stick (distance); in overhead mode
// it moves the camera vertically (height).
let camDist = CAM_DIST, camDistTarget = CAM_DIST;
let topHeight = TOP_CAM_HEIGHT, topHeightTarget = TOP_CAM_HEIGHT;
const CAM_DIST_MIN = 0.35, CAM_DIST_MAX = 2.0, CAM_DIST_STEP = 0.12;
const TOP_H_MIN = 1.2, TOP_H_MAX = 4.2, TOP_H_STEP = 0.22;
const ZOOM_EASE = 0.18;   // per-frame smoothing toward the target
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Called from the (throttled) wheel handler; deltaY < 0 is scroll-up.
export function zoomCamera(deltaY) {
  const dir = Math.sign(deltaY);
  if (viewMode === 'top') {
    // scroll up → camera higher
    topHeightTarget = clamp(topHeightTarget - dir * TOP_H_STEP, TOP_H_MIN, TOP_H_MAX);
  } else if (viewMode === 'free') {
    // Free view height is on Space/Shift (held keys, see input.js), not scroll.
  } else {
    // scroll up → forward along the stick, toward the ball (closer)
    camDistTarget = clamp(camDistTarget + dir * CAM_DIST_STEP, CAM_DIST_MIN, CAM_DIST_MAX);
  }
}
// The overhead view renders through the orthographic camera (true plan view);
// everything else uses the perspective one. scene.js swaps the active camera.
export function setViewMode(v) {
  viewMode = v;
  setCameraMode(v === 'top' ? 'ortho' : 'persp');
}
export function toggleView() { setViewMode(viewMode === 'aim' ? 'top' : 'aim'); }

// Seed the free-fly camera from wherever the active camera currently is, so
// entering free-look doesn't teleport the view. Call this when switching INTO
// free mode.
const _freeDir = new THREE.Vector3();
export function initFreeCamFromCurrent() {
  freeCam.x = camera.position.x;
  freeCam.y = camera.position.y;
  freeCam.z = camera.position.z;
  camera.getWorldDirection(_freeDir);
  freeCam.yaw = Math.atan2(_freeDir.z, _freeDir.x);
  freeCam.pitch = clamp(Math.asin(clamp(_freeDir.y, -1, 1)), -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
}

// Mouse look for the free camera (pixel deltas). Right/down mouse → look
// right/down, matching the aim view.
export function freeLookMouse(dx, dy) {
  freeCam.yaw += dx * FREE_SENS_X;
  freeCam.pitch = clamp(freeCam.pitch - dy * FREE_SENS_Y, -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
}

// Move the free camera. fwd/strafe/vert are each in [-1, 1] (held-key axes),
// applied directly per frame like WASD — no easing or rate-limiting. Horizontal
// motion follows the look yaw (WASD); vert is world up (Space) / down (Shift).
export function freeMove(fwd, strafe, vert, dt) {
  if (!fwd && !strafe && !vert) return;
  const step = FREE_SPEED * dt;
  const cy = Math.cos(freeCam.yaw), sy = Math.sin(freeCam.yaw);
  // Horizontal forward = (cos yaw, sin yaw); right = (-sin yaw, cos yaw).
  freeCam.x += (cy * fwd - sy * strafe) * step;
  freeCam.z += (sy * fwd + cy * strafe) * step;
  freeCam.y += vert * step;
}

let stickGroup = null;
let stickMesh = null;

// Last cue-ball anchor used by the camera. Persists across shots so the
// camera keeps orbiting the spot the cue was at when the shot was taken,
// instead of teleporting around mid-shot.
const cameraAnchor = { x: 0, y: 0, z: 0, set: false };

// State
const state = {
  yaw: 0,            // aim angle around Y, radians (0 = +X)
  pitch: 0.25,       // camera elevation angle above the table (radians, ~14°)
  pullback: 0,       // current draw-back of the cue stick
  visible: true,
  // Strike point on the cue ball, normalized within the unit disk:
  //   x: -1 (left english) .. +1 (right english)
  //   y: -1 (back/draw)    .. +1 (top/follow)
  strikeX: 0,
  strikeY: 0,
};

export function initCueStick() {
  stickGroup = new THREE.Group();

  // Build a cone-ish stick along +X (tip at origin, butt at +X = STICK_LEN)
  const geo = new THREE.CylinderGeometry(TIP_R, BUTT_R, STICK_LEN, 24, 1, false);
  // Default cylinder is along +Y; rotate so length is along +X
  geo.rotateZ(-Math.PI / 2);
  // Move so tip sits at x=0 and the stick extends in the -X direction
  geo.translate(-STICK_LEN / 2, 0, 0);

  const mat = new THREE.MeshStandardMaterial({
    color: 0xb98a4a,
    roughness: 0.45,
    metalness: 0.05,
  });
  stickMesh = new THREE.Mesh(geo, mat);
  stickMesh.castShadow = true;

  // Tip ferrule (white) for a bit of detail
  const ferruleGeo = new THREE.CylinderGeometry(TIP_R * 1.05, TIP_R * 1.05, 0.02, 16);
  ferruleGeo.rotateZ(-Math.PI / 2);
  ferruleGeo.translate(-0.01, 0, 0);
  const ferrule = new THREE.Mesh(
    ferruleGeo,
    new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.3 })
  );
  stickGroup.add(ferrule);

  stickGroup.add(stickMesh);
  scene.add(stickGroup);

  return stickGroup;
}

export function setYaw(y) { state.yaw = y; }
export function getYaw() { return state.yaw; }
export function addYaw(dy) { state.yaw += dy; }

export function getPitch() { return state.pitch; }
export function addPitch(dp) {
  state.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, state.pitch + dp));
}
export function setPitch(p) {
  state.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, p));
}

// Strike-point (spin) controls. Coordinates are normalized to the unit disk;
// magnitudes greater than 1 are clamped onto the rim.
export function getStrikeOffset() { return { x: state.strikeX, y: state.strikeY }; }
export function addStrikeOffset(dx, dy) {
  state.strikeX += dx;
  state.strikeY += dy;
  const r = Math.hypot(state.strikeX, state.strikeY);
  if (r > 1) { state.strikeX /= r; state.strikeY /= r; }
}
export function setStrikeOffset(x, y) {
  state.strikeX = x;
  state.strikeY = y;
  const r = Math.hypot(state.strikeX, state.strikeY);
  if (r > 1) { state.strikeX /= r; state.strikeY /= r; }
}
export function resetStrikeOffset() {
  state.strikeX = 0;
  state.strikeY = 0;
}

export function setPullback(p) {
  state.pullback = Math.max(0, Math.min(PULLBACK_MAX, p));
}
export function getPullback() { return state.pullback; }
export function getMaxPullback() { return PULLBACK_MAX; }

export function setVisible(v) {
  state.visible = v;
  if (stickGroup) stickGroup.visible = v;
}
export function isVisible() { return state.visible; }

// Returns normalized aim direction in world XZ plane (horizontal only).
export function getAimDir() {
  // yaw=0 → +X. We treat the cue as shooting in -aimDir (tip points toward ball).
  return new THREE.Vector3(Math.cos(state.yaw), 0, Math.sin(state.yaw));
}

// Full 3D shot direction (back→tip = direction the impulse pushes the ball).
// Pitch tilts the cue downward: pitch=0 → horizontal, pitch=π/2 → straight down.
export function getShotDir() {
  const cp = Math.cos(state.pitch);
  const sp = Math.sin(state.pitch);
  const aim = getAimDir();
  return new THREE.Vector3(aim.x * cp, -sp, aim.z * cp);
}

// Re-anchor + draw the cue stick + aim line at the current cue-ball position.
// Call this only when the balls are at rest (during aiming).
const _xAxis = new THREE.Vector3(1, 0, 0);
const _worldUp = new THREE.Vector3(0, 1, 0);
const _tmpRight = new THREE.Vector3();
const _tmpStickUp = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
export function updateCueAndCamera(cuePos) {
  if (!stickGroup) return;

  const stickDir = getShotDir();        // 3D back→tip direction (includes pitch)

  // Local frame around the stick: right is horizontal (player's right when
  // looking down the cue toward the ball), up is in the stick's vertical
  // plane perpendicular to stickDir.
  // For the camera at -aim looking toward +aim, the player's right is
  // stickDir × worldUp (NOT worldUp × stickDir, which would give left).
  _tmpRight.crossVectors(stickDir, _worldUp);
  if (_tmpRight.lengthSq() < 1e-8) _tmpRight.set(0, 0, 1);
  _tmpRight.normalize();
  _tmpStickUp.crossVectors(_tmpRight, stickDir).normalize();

  // ---- Stick ----
  // Geometry was built with the tip at local (0,0,0) and the butt at (-STICK_LEN, 0, 0).
  // So local +X points from butt → tip, i.e. it should align with stickDir.
  // The strike point (strikeX, strikeY) shifts the tip laterally on the back
  // hemisphere of the cue ball. Use 0.7·R so the visual offset stays comfortably
  // inside the ball outline; back-distance is reduced accordingly so the tip
  // visibly contacts the surface.
  const sxOff = state.strikeX * R * 0.7;
  const syOff = state.strikeY * R * 0.7;
  const lateralSq = sxOff * sxOff + syOff * syOff;
  const backDist = Math.sqrt(Math.max(0, R * R - lateralSq));

  const tip = cuePos.clone()
    .addScaledVector(stickDir, -(backDist + GAP + state.pullback * VISUAL_PULLBACK_SCALE))
    .addScaledVector(_tmpRight, sxOff)
    .addScaledVector(_tmpStickUp, syOff);
  stickGroup.position.copy(tip);

  // Orient: local +X (back→tip) → stickDir
  _tmpQuat.setFromUnitVectors(_xAxis, stickDir);
  stickGroup.quaternion.copy(_tmpQuat);

  // Anchor the camera orbit to this cue position, then place the camera.
  cameraAnchor.x = cuePos.x;
  cameraAnchor.y = cuePos.y;
  cameraAnchor.z = cuePos.z;
  cameraAnchor.set = true;
  placeCamera();
}

// Recompute camera transform from the current anchor + yaw/pitch.
// Safe to call every frame — used both while aiming and while balls are
// moving (so the player can still look around).
export function placeCamera() {
  // Ease the dolly toward its scroll target (smooth, never sudden).
  camDist += (camDistTarget - camDist) * ZOOM_EASE;
  topHeight += (topHeightTarget - topHeight) * ZOOM_EASE;

  // Overhead view: look straight down at the table centre so the whole table
  // is visible. Up = -Z keeps the long axis (X) horizontal on screen. This is
  // independent of the orbit anchor, so handle it before the anchor check —
  // otherwise the very first (break) placement, before any shot has set the
  // anchor, would fall through to the default camera instead of top view.
  if (viewMode === 'top') {
    camera.position.set(0, topHeight, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    // Orthographic size ignores camera height, so map the scroll-driven
    // height onto ortho zoom instead: default height = zoom 1, scrolling
    // closer zooms in. Keeps the same scroll limits and easing.
    if (camera.isOrthographicCamera) {
      camera.zoom = TOP_CAM_HEIGHT / topHeight;
      camera.updateProjectionMatrix();
    }
    return;
  }

  // Free-fly view: place the perspective camera at the free-cam position and
  // look along its yaw/pitch. All movement (incl. height) is applied directly
  // in the input tick (see freeMove).
  if (viewMode === 'free') {
    const cp = Math.cos(freeCam.pitch), sp = Math.sin(freeCam.pitch);
    const fx = Math.cos(freeCam.yaw) * cp, fy = sp, fz = Math.sin(freeCam.yaw) * cp;
    camera.position.set(freeCam.x, freeCam.y, freeCam.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(freeCam.x + fx, freeCam.y + fy, freeCam.z + fz);
    return;
  }

  if (!cameraAnchor.set) return;

  const aim = getAimDir();         // horizontal aim unit vector
  const cp = Math.cos(state.pitch);
  const sp = Math.sin(state.pitch);

  const ax = cameraAnchor.x, ay = cameraAnchor.y, az = cameraAnchor.z;
  // Look DOWN the stick: the sightline runs PARALLEL to the (pitched) stick
  // direction, from a point camDist back along the stick and a fixed
  // perpendicular clearance above it — like sighting along the cue. The
  // pitched stick direction (butt→tip) matches the server's shot dir.
  const dx = aim.x * cp, dy = -sp, dz = aim.z * cp;

  // Perpendicular clearance above the stick. Follow english (strikeY > 0)
  // raises the tip; track that so the stick never rises back into frame.
  // Offsetting the camera and the look target by the SAME amount keeps the
  // sightline parallel to the stick (looking along it from above) rather
  // than tilting the view down onto it.
  const overStick = CAM_RAISE + Math.max(0, state.strikeY) * R * 0.7;

  // The clearance is measured PERPENDICULAR to the stick, not vertically: with
  // an elevated cue a purely vertical raise would sit closer to the (tilted)
  // stick on one side. The stick's "up" vector (perpendicular to stickDir, in
  // its vertical plane) is (aim·sp, cp, aim·sp): world-up when pitch=0, tilting
  // back as the cue elevates. Offsetting along it keeps a constant gap above
  // the stick regardless of pitch.
  const upx = aim.x * sp, upy = cp, upz = aim.z * sp;

  // Left/right english (strikeX) shifts the stick sideways along its horizontal
  // "right" vector by the same sxOff used to place the tip (see updateCueAndCamera).
  // Translate the camera + look target by that offset too so the sightline stays
  // directly over the stick instead of the stick sliding out from under the view.
  // Horizontal right = stickDir × worldUp, which reduces to (-aim.z, 0, aim.x).
  const sideOff = state.strikeX * R * 0.7;
  const rx = -aim.z, rz = aim.x;

  camera.position.set(
    ax - dx * camDist + rx * sideOff + upx * overStick,
    ay - dy * camDist                + upy * overStick,
    az - dz * camDist + rz * sideOff + upz * overStick,
  );
  // Roll reference = the stick's own up vector: always perpendicular to the
  // sightline, so the view stays stable even at near-vertical pitch (where
  // world-up would be almost parallel to the look direction).
  camera.up.set(upx, upy, upz);
  camera.lookAt(
    ax + dx * CAM_LOOK_AHEAD + rx * sideOff + upx * overStick,
    ay + dy * CAM_LOOK_AHEAD                + upy * overStick,
    az + dz * CAM_LOOK_AHEAD + rz * sideOff + upz * overStick,
  );
}
