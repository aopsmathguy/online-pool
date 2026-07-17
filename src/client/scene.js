// src/scene.js
import * as THREE from "/lib/three.module.js";
import { tableW } from '../shared/constants.js';

let renderer, scene, camera, perspCamera, orthoCamera;
let DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
const canvas = document.getElementById('stage');

// Half-height (world metres, screen-vertical) of the orthographic top view at
// zoom 1 — chosen to match the perspective camera's footprint on the table
// plane at the default overhead height (2.15 m, fov 60: 2.15·tan 30°).
const ORTHO_HALF_H = 1.2414;

export function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b1020');

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.shadowMap.enabled = true;

  perspCamera = new THREE.PerspectiveCamera(60, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.01, 100);
  perspCamera.position.set(-tableW * 0.5, 0.4, 0);
  perspCamera.lookAt(0, 0, 0);

  // Orthographic camera for the bird's-eye view (no perspective distortion:
  // the table renders as a true plan). Frustum is sized in fitCanvas.
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);

  camera = perspCamera;

  // Soft sky/ground fill instead of flat ambient, one dominant key light that
  // casts shadows, and a single gentle fill — a conventional 3-light rig at
  // Three's physically-based default intensities (r155+).
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.5));  // sky / ground fill
  addDir(0, 3, 2, 2.0);      // key light (casts shadows)
  addDir(-1, 2.5, -2, 0.4);  // gentle fill

  window.addEventListener('resize', fitCanvas);
  fitCanvas();
  return { scene, camera, renderer, canvas, DPR };
}

function addDir(x,y,z,intensity=0.8){
  const dir = new THREE.DirectionalLight(0xffffff, intensity);
  dir.castShadow = true;
  dir.position.set(x,y,z);
  scene.add(dir);
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
  if (orthoCamera) {
    orthoCamera.left = -ORTHO_HALF_H * aspect;
    orthoCamera.right = ORTHO_HALF_H * aspect;
    orthoCamera.top = ORTHO_HALF_H;
    orthoCamera.bottom = -ORTHO_HALF_H;
    orthoCamera.updateProjectionMatrix();
  }
}

export function render() {
  renderer.render(scene, camera);
}

export { scene, camera, renderer };
