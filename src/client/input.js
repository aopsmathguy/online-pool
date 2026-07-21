// src/input.js — pointer-based controls (mouse + touch), no pointer lock.
//   - Aim view: DRAG on the table to rotate aim (yaw) + camera pitch.
//   - Spin: tap / drag the spin dial (bottom-left cue-ball face); X recenters.
//   - Free view: DRAG to look; the on-screen pad (or WASD/Space/Shift) moves.
//   - Shoot: grab the cue stick over the left-middle power bar, DRAG it DOWN to
//       build power (the tip marks how much), release to fire; ESC cancels.
//   - Zoom: the on-screen +/- buttons (aim + overhead), the mouse wheel, or a
//       two-finger pinch (aim slides along the stick; overhead also pans).
//   - V cycles the camera; the on-screen view button does the same.
//   - Ball-in-hand: drag to position the cue ball, release to place it.
import { addYaw, addPitch, setStrikeOffset, resetStrikeOffset,
         getPullback, setPullback, getMaxPullback,
         getViewMode, freeLookMouse, freeMove, zoomStep, dragPanTop, pinchTop, pinchAim,
         beginAimOrbit, dragAimOrbit, endAimOrbit, isAimOrbiting } from './cue.js';
import { powerBarRect, spinDialRect } from './hudCanvas.js';

const MOUSE_SENS_X = 0.0025;     // radians per pixel of horizontal drag (yaw)
const MOUSE_SENS_Y = 0.0020;     // radians per pixel of vertical drag (pitch)
const POWER_PAD = 20;            // px slop around the power bar for grabbing the stick
const SPIN_PAD = 8;              // px slop around the spin dial
const GESTURE_SLOP = 12;         // px a two-finger gesture must move before it's ruled pinch vs drag

export function bindInput(canvas, handlers) {
  const {
    onShoot,
    isReady = () => true,
    isPlacing = () => false,
    isOverCueBall = () => false,
    onPlaceMove = () => {},
    onToggleView = () => {},
    onZoom = () => {},
  } = handlers;

  let drag = null;      // null | 'aim' | 'spin' | 'look' | 'power' | 'place' | 'pan' | 'orbit'
  let dragId = null;    // pointerId of the active drag
  let lastX = 0, lastY = 0;
  let powerGrabY = 0, powerGrabVal = 0;   // power drag is RELATIVE to the grab point
  const pointers = new Map();   // active canvas pointers: id -> {x, y} (client px)
  let pinch = null;             // { dist, midX, midY } (canvas px) — previous frame of a two-finger gesture
  let pinchStart = null;        // the { dist, midX, midY } the gesture opened at (for classification)
  let pinchMode = null;         // null (undecided) | 'zoom' (pinch) | 'drag' (two-finger pan)
  let lastTime = performance.now();

  // Pinch state from the two active pointers, in canvas-local CSS pixels.
  function pinchInfo(rect) {
    const [a, b] = [...pointers.values()];
    const ax = a.x - rect.left, ay = a.y - rect.top;
    const bx = b.x - rect.left, by = b.y - rect.top;
    return { dist: Math.hypot(bx - ax, by - ay), midX: (ax + bx) / 2, midY: (ay + by) / 2 };
  }
  // Held movement keys / buttons for the free-fly camera.
  const moveKeys = { w: false, a: false, s: false, d: false, up: false, down: false };
  const moveKeyFor = (e) => {
    if (e.code === 'Space' || e.key === ' ') return 'up';
    if (e.key === 'Shift') return 'down';
    const k = e.key.length === 1 ? e.key.toLowerCase() : '';
    return (k === 'w' || k === 'a' || k === 's' || k === 'd') ? k : null;
  };

  // Canvas-local CSS-pixel coords (the same space the HUD draws in).
  function local(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }
  function overPowerBar(p) {
    const b = powerBarRect();
    return !!b && p.x >= b.x - POWER_PAD && p.x <= b.x + b.w + POWER_PAD
              && p.y >= b.yTop - POWER_PAD && p.y <= b.yTop + b.h + POWER_PAD;
  }
  // Power is a RELATIVE drag-back: the tip stays where it was when grabbed and
  // moves with the drag (down = more power), rather than jumping to the pointer.
  function updatePowerDrag(clientY) {
    const b = powerBarRect();
    if (!b) return;
    const v = powerGrabVal + (clientY - powerGrabY) / b.h;
    setPullback(Math.max(0, Math.min(1, v)) * getMaxPullback());
  }
  function overSpinDial(p) {
    const d = spinDialRect();
    return !!d && Math.hypot(p.x - d.cx, p.y - d.cy) <= d.r + SPIN_PAD;
  }
  function setSpinFrom(p) {
    const d = spinDialRect();
    if (!d) return;
    setStrikeOffset((p.x - d.cx) / d.r, -(p.y - d.cy) / d.r);
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // Mouse-wheel zoom (desktop). Rate-limited; the camera eases in cue.js.
  const ZOOM_THROTTLE = 40;
  let zoomAccum = 0, lastZoom = 0;
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAccum += e.deltaY;
    const now = performance.now();
    if (now - lastZoom >= ZOOM_THROTTLE && zoomAccum !== 0) {
      onZoom(zoomAccum); zoomAccum = 0; lastZoom = now;
    }
  }, { passive: false });

  canvas.addEventListener('pointerdown', e => {
    // Right mouse drag is the desktop twin of the two-finger drag: orbit-preview
    // in aim, pan in overhead. (contextmenu is suppressed above so it isn't cut off.)
    if (e.pointerType === 'mouse' && e.button === 2) {
      const view = getViewMode();
      let mode = null;
      if (view === 'aim') { beginAimOrbit(); mode = 'orbit'; }
      else if (view === 'top') mode = 'pan';
      if (!mode) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag = mode; dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Two fingers → pinch to zoom: overhead zooms + pans about the midpoint, aim
    // slides the camera along the stick. Whatever single-finger drag was in
    // progress is abandoned (a part-charged shot is cancelled, not fired).
    if (pointers.size === 2 && (getViewMode() === 'top' || getViewMode() === 'aim')) {
      if (drag === 'power') setPullback(0);
      drag = null; dragId = null;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      pinch = pinchInfo(canvas.getBoundingClientRect());
      pinchStart = pinch; pinchMode = null;   // undecided until the fingers move enough to tell
      e.preventDefault();
      return;
    }
    if (pointers.size !== 1 || drag) return;   // only the first finger starts a drag
    const p = local(e.clientX, e.clientY);
    lastX = e.clientX; lastY = e.clientY;
    let mode = null;
    if (isReady() && overPowerBar(p)) { mode = 'power'; powerGrabY = e.clientY; powerGrabVal = getPullback() / getMaxPullback(); }
    else if (isReady() && overSpinDial(p)) { mode = 'spin'; setSpinFrom(p); }
    else if (isPlacing()) {
      // Ball-in-hand: grab the cue ball to drag it, or drag anything else to move
      // the camera — look-around in free view, pan in overhead. Placement is
      // finalised only with the on-screen ✓ button, not on release.
      if (isOverCueBall(e.clientX, e.clientY)) { mode = 'place'; onPlaceMove(e.clientX, e.clientY); }
      else mode = getViewMode() === 'free' ? 'look' : 'pan';
    }
    else if (getViewMode() === 'free') mode = 'look';
    else if (getViewMode() === 'aim') mode = 'aim';
    else if (getViewMode() === 'top') mode = 'pan';   // overhead: drag to pan the table
    if (!mode) return;
    drag = mode; dragId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });

  // Deltas from the previous position (works for touch, unlike movementX/Y).
  window.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const rect = canvas.getBoundingClientRect();
      const info = pinchInfo(rect);
      // Tell a PINCH (fingers change separation → zoom) from a two-finger DRAG
      // (midpoint slides while separation holds → pan). Whichever axis moves more
      // past the slop wins, then the gesture is locked to it so jitter in the
      // other axis can't bleed in (a drag no longer creeps the zoom, and vice versa).
      if (!pinchMode) {
        const dDist = Math.abs(info.dist - pinchStart.dist);
        const dMid  = Math.hypot(info.midX - pinchStart.midX, info.midY - pinchStart.midY);
        if (Math.max(dDist, dMid) >= GESTURE_SLOP) {
          pinchMode = dDist >= dMid ? 'zoom' : 'drag';
          // Open the orbit fresh the moment a drag is recognised — even mid glide-
          // back from a previous one — so a re-grab starts from the live view.
          if (pinchMode === 'drag' && getViewMode() === 'aim') beginAimOrbit();
        }
      }
      if (pinchMode === 'zoom') {
        // Pinch: aim slides the camera along the stick; overhead zooms about the
        // finger midpoint (prevMid == mid, so no pan contribution).
        if (getViewMode() === 'aim') pinchAim(info.dist, pinch.dist);
        else pinchTop(info.midX, info.midY, info.midX, info.midY, info.dist, pinch.dist, rect.width, rect.height);
      } else if (pinchMode === 'drag') {
        // Two-finger drag: overhead pans by the midpoint delta; aim orbits a fixed
        // pivot out past the aim point (a shot-line preview that snaps back on lift).
        if (getViewMode() === 'top') dragPanTop(info.midX - pinch.midX, info.midY - pinch.midY, rect.height);
        else if (getViewMode() === 'aim') dragAimOrbit(info.midX - pinch.midX, info.midY - pinch.midY);
      }
      pinch = info;
      return;
    }
    if (drag && e.pointerId === dragId) {
      const p = local(e.clientX, e.clientY);
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (drag === 'power') return updatePowerDrag(e.clientY);
      if (drag === 'spin')  return setSpinFrom(p);
      if (drag === 'place') return onPlaceMove(e.clientX, e.clientY);
      if (drag === 'aim')   { addYaw(-dx * MOUSE_SENS_X); addPitch(-dy * MOUSE_SENS_Y); return; }
      if (drag === 'orbit') { dragAimOrbit(dx, dy); return; }
      if (drag === 'look')  { freeLookMouse(dx, dy); return; }
      if (drag === 'pan')   { dragPanTop(dx, dy, canvas.getBoundingClientRect().height); return; }
      return;
    }
  });

  function endDrag(e) {
    if (e && e.pointerId !== dragId) return;
    const mode = drag;
    drag = null; dragId = null;
    if (mode === 'orbit') { endAimOrbit(); return; }   // snap back to the sighting view
    if (mode === 'power') {
      const pull = getPullback();
      // Deliberately NOT reset here. The shot is away but the recording has to
      // come back before anything can be shown, and snapping the stick to rest
      // in that gap only to replay the same draw-back a moment later reads as a
      // stutter. Leaving it drawn means the replay's lead-in (which opens at
      // full draw and holds) continues from exactly where the player let go.
      // onShoot arranges the fallback if no shot ever materialises.
      if (pull > 0.001) onShoot(pull); else setPullback(0);
    }
    // 'place' just drops the drag — placement is finalised by the ✓ button.
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        const wasOrbiting = isAimOrbiting();
        pinch = null; pinchStart = null; pinchMode = null;
        // An orbit preview ends the moment a finger lifts: snap back to the
        // sighting view rather than handing the leftover finger a real aim drag.
        if (wasOrbiting) { endAimOrbit(); return; }
        // One finger still down → hand off to that view's drag, starting from
        // where the finger actually is so the camera doesn't jump.
        if (pointers.size === 1) {
          const view = getViewMode();
          const mode = view === 'top' ? 'pan' : view === 'aim' ? 'aim' : null;
          if (mode) {
            const [remId, rem] = [...pointers.entries()][0];
            drag = mode; dragId = remId; lastX = rem.x; lastY = rem.y;
          }
        }
      }
      return;
    }
    endDrag(e);
  }
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // Sliders keep focus after a click, so anything that isn't text entry has to
  // let movement keys through — the range controls only use arrows/Home/End.
  const isTextEntry = (t) => {
    if (!t) return false;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
    return t.tagName === 'INPUT' && t.type !== 'range';
  };

  document.addEventListener('keydown', e => {
    if (isTextEntry(e.target)) return;
    if (drag === 'power' && e.key === 'Escape') { drag = null; dragId = null; setPullback(0); e.preventDefault(); return; }
    if (e.key === 'v' || e.key === 'V') onToggleView();
    const k = moveKeyFor(e);
    if (k && getViewMode() === 'free') { moveKeys[k] = true; e.preventDefault(); return; }
    if (e.key === 'x' || e.key === 'X') { resetStrikeOffset(); e.preventDefault(); }
  });
  document.addEventListener('keyup', e => {
    const k = moveKeyFor(e);
    if (k) moveKeys[k] = false;
  });

  // A clicked button/slider keeps focus, and then it — not the game — owns the
  // keyboard: Space re-fires the button instead of flying the camera up, and the
  // arrows scrub the range control. Hand focus back to the page once the pointer
  // is done with it. Tabbing still focuses normally, so keyboard nav survives.
  document.addEventListener('pointerup', () => {
    const el = document.activeElement;
    if (!el || isTextEntry(el)) return;
    if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && el.type === 'range')) el.blur();
  });
  // Selects are left alone above (blurring mid-pointer would shut the open
  // dropdown); drop them once a choice has actually been committed.
  document.addEventListener('change', e => {
    if (e.target && e.target.tagName === 'SELECT') e.target.blur();
  });

  // ---- On-screen controls (bottom-right): zoom + free-camera movement ----------
  let zoomTimer = null;
  const startZoom = (dir) => { zoomStep(dir); clearInterval(zoomTimer); zoomTimer = setInterval(() => zoomStep(dir), 90); };
  const stopZoom = () => { clearInterval(zoomTimer); zoomTimer = null; };
  // A press-and-hold button: captures the pointer so release fires even if the
  // finger slides off, and works for mouse + touch.
  const holdBtn = (id, onDown, onUp) => {
    const el = document.getElementById(id);
    if (!el) return;
    let active = false;
    el.addEventListener('pointerdown', e => { e.preventDefault(); active = true; try { el.setPointerCapture(e.pointerId); } catch {} onDown(); });
    const up = (e) => { if (e) e.preventDefault && e.preventDefault(); if (active) { active = false; onUp(); } };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  holdBtn('zoomIn',  () => startZoom(+1), stopZoom);
  holdBtn('zoomOut', () => startZoom(-1), stopZoom);
  const moveBtns = { freeFwd: 'w', freeBack: 's', freeLeft: 'a', freeRight: 'd', freeUp: 'up', freeDown: 'down' };
  for (const [id, key] of Object.entries(moveBtns)) holdBtn(id, () => { moveKeys[key] = true; }, () => { moveKeys[key] = false; });

  // Losing focus drops everything held.
  window.addEventListener('blur', () => {
    for (const k in moveKeys) moveKeys[k] = false;
    stopZoom();
    if (drag === 'power') setPullback(0);
    drag = null; dragId = null;
    pointers.clear(); pinch = null; pinchStart = null; pinchMode = null;
  });

  function tick() {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    if (getViewMode() === 'free') {
      const fwd = (moveKeys.w ? 1 : 0) - (moveKeys.s ? 1 : 0);
      const strafe = (moveKeys.d ? 1 : 0) - (moveKeys.a ? 1 : 0);
      const vert = (moveKeys.up ? 1 : 0) - (moveKeys.down ? 1 : 0);
      freeMove(fwd, strafe, vert, dt);
    }
  }

  return { tick, isDragging: () => !!drag };
}
