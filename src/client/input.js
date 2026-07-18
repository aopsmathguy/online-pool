// src/input.js
// First-person mouse controls:
//   - Move mouse left/right: rotate aim around the cue ball (yaw)
//   - Move mouse up/down: raise/lower camera pitch (also tilts the cue stick)
//   - HOLD ALT + move mouse: adjust the cue-tip strike point on the cue ball
//     (instead of yaw/pitch) — left/right = english, up/down = top/back spin
//   - Hold left mouse button: pull cue stick back (charge shot)
//   - Release left mouse button: shoot (impulse proportional to pullback)
//   - X: reset strike point to center
//   - V: cycle camera — down-the-stick aim → free fly-around → overhead
//   - Click on canvas to lock the pointer; ESC to unlock.
//
// Free fly-around view: WASD walk and Space/Shift go up/down whether or not the
// pointer is locked, but MOUSE-LOOK only turns the view while the pointer is
// locked (cursor hidden). Click the canvas to lock; ESC to release.
//
// Ball-in-hand: when handlers.isPlacing() is true, the cursor (visible in the
// overhead view) points at the table — onPlaceMove receives the absolute cursor
// position and a left click confirms the placement (onPlaceConfirm).
//
// The pointer is locked (cursor hidden, for mouselook) in the aim/free views;
// the overhead view keeps the OS cursor visible.
import { addYaw, addPitch, addStrikeOffset, resetStrikeOffset,
         getPullback, setPullback, getMaxPullback,
         getViewMode, freeLookMouse, freeMove } from './cue.js';

const MOUSE_SENS_X = 0.0025;     // radians per pixel of horizontal mouse motion (yaw)
const MOUSE_SENS_Y = 0.0020;     // radians per pixel of vertical mouse motion (pitch)
const STRIKE_SENS = 0.005;       // strike-offset units per pixel while Alt is held
const CHARGE_RATE = 0.825;       // pullback meters per second while holding (1 s to full charge)

export function bindInput(canvas, handlers) {
  const {
    onShoot,
    isReady = () => true,
    isPlacing = () => false,
    onPlaceMove = () => {},
    onPlaceConfirm = () => {},
    onToggleView = () => {},
    onZoom = () => {},
  } = handlers;

  let pointerLocked = false;
  let charging = false;
  let altHeld = false;
  let lastTime = performance.now();
  // Held movement keys for the free-fly ("look around") camera: WASD walk,
  // Space up, Shift down. Map an event to its axis key (or null).
  const moveKeys = { w: false, a: false, s: false, d: false, up: false, down: false };
  const moveKeyFor = (e) => {
    if (e.code === 'Space' || e.key === ' ') return 'up';
    if (e.key === 'Shift') return 'down';
    const k = e.key.length === 1 ? e.key.toLowerCase() : '';
    return (k === 'w' || k === 'a' || k === 's' || k === 'd') ? k : null;
  };

  // Lock the pointer (hides the cursor for mouselook) in the aim/free views; the
  // overhead view keeps the OS cursor visible (ball-in-hand placement raycasts
  // the real cursor). Free-fly ALSO works with the cursor visible: when unlocked,
  // moving the mouse still turns the view (see mousemove) and WASD/Space/Shift
  // still fly (see keydown/tick).
  canvas.addEventListener('click', () => {
    if (!pointerLocked && getViewMode() !== 'top') canvas.requestPointerLock();
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // Scroll wheel → camera dolly. Rate-limited: wheel events fire rapidly, so we
  // accumulate the delta and flush at most once per ZOOM_THROTTLE ms. The
  // camera itself eases toward the target (in cue.js) so motion stays smooth.
  const ZOOM_THROTTLE = 40;
  let zoomAccum = 0, lastZoom = 0;
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAccum += e.deltaY;
    const now = performance.now();
    if (now - lastZoom >= ZOOM_THROTTLE && zoomAccum !== 0) {
      onZoom(zoomAccum);
      zoomAccum = 0;
      lastZoom = now;
    }
  }, { passive: false });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = (document.pointerLockElement === canvas);
    if (!pointerLocked) {
      // Cancel any in-progress charge if pointer unlocks
      charging = false;
      setPullback(0);
    }
  });

  document.addEventListener('mousemove', e => {
    if (getViewMode() === 'free') {
      // Free-fly spectator camera: mouse turns the view — never the aim, and
      // never the ball-in-hand position (checked before isPlacing on purpose).
      // Look only works while the pointer is locked (cursor hidden); with the
      // cursor visible the mouse is free to move without swinging the view.
      if (pointerLocked) freeLookMouse(e.movementX, e.movementY);
      return;
    }
    if (isPlacing()) {
      // Ball-in-hand (overhead): the cursor is visible; place the ball where it
      // points (absolute position, not relative — main.js raycasts it).
      onPlaceMove(e.clientX, e.clientY);
      return;
    }
    if (!pointerLocked) return;
    // Aiming only happens while sighting down the stick. In the bird's-eye
    // (top) view the mouse must NOT change the aim.
    if (getViewMode() !== 'aim') return;
    if (altHeld || e.altKey) {
      // Adjust the cue-tip strike point on the cue ball instead of aiming.
      // Screen Y is inverted from spin "up": mouse up (movementY < 0) → top spin.
      addStrikeOffset(e.movementX * STRIKE_SENS, -e.movementY * STRIKE_SENS);
      return;
    }
    addYaw(e.movementX * MOUSE_SENS_X);
    // Mouse up (movementY < 0) → raise camera (increase pitch),
    // mouse down → lower camera toward horizontal.
    addPitch(-e.movementY * MOUSE_SENS_Y);
  });

  document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // Ball-in-hand: click to drop the cue ball — but NOT in free view, which is
    // look-only. There a click just locks the pointer for mouselook (see the
    // click handler above); it must not also confirm the placement.
    if (isPlacing() && getViewMode() !== 'free') { onPlaceConfirm(); return; }
    if (!pointerLocked || !isReady()) return;      // charging needs the locked aim view
    charging = true;
  });

  // Alt held → mouse adjusts the cue-tip strike point. X resets to center.
  // V toggles the overhead view.
  document.addEventListener('keydown', e => {
    // While charging (holding to draw the cue back), ANY key aborts the shot:
    // drop the draw and swallow the key so the release doesn't fire (mouseup
    // sees charging=false and bails).
    if (charging) { charging = false; setPullback(0); e.preventDefault(); return; }
    if (e.key === 'Alt') altHeld = true;
    if (e.key === 'v' || e.key === 'V') onToggleView();   // cycle aim → free → overhead
    // Free-fly movement (WASD/Space/Shift) works in free view whether or not the
    // pointer is locked, so the cursor can stay visible.
    const k = moveKeyFor(e);
    if (k && (getViewMode() === 'free' || pointerLocked)) { moveKeys[k] = true; e.preventDefault(); return; }
    if (!pointerLocked) return;
    if (e.key === 'x' || e.key === 'X') { resetStrikeOffset(); e.preventDefault(); }
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Alt') altHeld = false;
    const k = moveKeyFor(e);
    if (k) moveKeys[k] = false;
  });
  // If we lose focus while Alt/movement keys are down, drop the held state.
  window.addEventListener('blur', () => {
    altHeld = false;
    for (const k in moveKeys) moveKeys[k] = false;
  });

  document.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    if (!charging) return;
    charging = false;
    const pull = getPullback();
    setPullback(0);
    if (pull <= 0.001) return;
    onShoot(pull); // main.js builds the 3D impulse from pull + yaw + pitch + strike
  });

  function tick() {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    // Overhead view: release the pointer so the OS cursor is visible.
    if (pointerLocked && getViewMode() === 'top') document.exitPointerLock();
    if (charging) {
      setPullback(Math.min(getMaxPullback(), getPullback() + CHARGE_RATE * dt));
    }
    // Free-fly movement: WASD walk (relative to look yaw), Space up / Shift down.
    // Works whether or not the pointer is locked (cursor may be visible).
    if (getViewMode() === 'free') {
      const fwd = (moveKeys.w ? 1 : 0) - (moveKeys.s ? 1 : 0);
      const strafe = (moveKeys.d ? 1 : 0) - (moveKeys.a ? 1 : 0);
      const vert = (moveKeys.up ? 1 : 0) - (moveKeys.down ? 1 : 0);
      freeMove(fwd, strafe, vert, dt);
    }
  }

  return {
    tick,
    isPointerLocked: () => pointerLocked,
    isCharging: () => charging,
  };
}
