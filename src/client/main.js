// src/main.js — online pool client. No physics/rules here: the client renders
// the table + balls + cue from server state and sends input. All authoritative
// simulation runs on the server (see server/index.js + src/sim.js).
import * as THREE from "/lib/three.module.js";
import { initScene, render, camera } from './scene.js';
import { tableW, tableH, wireY, rodR, R } from '../shared/constants.js';
import {
  rail_pts, felt_pts, pocket_positions,
  makePolylineMesh, makePlanarMeshFromPolyline, makeCylindricalCupMesh,
} from './geometry.js';
import {
  initCueStick, updateCueAndCamera, placeCamera, setVisible as setCueVisible,
  getStrikeOffset, setStrikeOffset, resetStrikeOffset, setViewMode,
  getYaw, setYaw, getPitch, setPitch, getPullback, setPullback, getMaxPullback,
  zoomCamera, initFreeCamFromCurrent,
} from './cue.js';
import { bindInput } from './input.js';
import {
  buildRack, applyBallsFrame, applyBallsFrameLerp, removeBallView, setCuePosition,
  getCueMeshPosition, getObstaclePositions, clearRack,
} from './balls.view.js';
import { minPitchForShot, densify } from '../shared/clearance.js';
import { renderHUD, renderPocketed } from './hud.js';
import { SocketClient } from '../../lib/socketUtility.js';
import {
  packetSchemas, PH_AIMING, PH_SHOOTING, PH_PLACING, PH_OVER,
  LOBBY_WAITING, gameByteFromId,
} from '../shared/net/packets.js';

// ---- Networking -------------------------------------------------------------
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new SocketClient(new WebSocket(`${proto}//${location.host}`), { packetSchemas });

// ---- Client state -----------------------------------------------------------
const net = { myIndex: -1, code: '', inGame: false, bot: false };  // bot: vs-Computer room
let gs = { interact: PH_AIMING, current: 0, ballInHand: false, winner: -1 };  // last gameState
let prevTurnKey = '';                                   // to detect my-turn transitions
// opponentAim = the latest streamed target (from `aimState`, ~20 Hz).
// opponentView = the smoothed value actually shown, eased toward the target
// every render frame so the opponent's/bot's aiming and draw-back look fluid
// instead of stepping at the packet rate.
const opponentAim = { yaw: 0, pitch: 0.25, strikeX: 0, strikeY: 0, pullback: 0 };
const opponentView = { ...opponentAim };
let snapOpponent = false;                // snap (don't ease) the next opponent aim
const AIM_SMOOTH = 0.22;                 // per-frame ease toward the target
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));   // shortest-arc delta
function easeOpponentView() {
  opponentView.yaw += wrapPi(opponentAim.yaw - opponentView.yaw) * AIM_SMOOTH;
  opponentView.pitch += (opponentAim.pitch - opponentView.pitch) * AIM_SMOOTH;
  opponentView.strikeX += (opponentAim.strikeX - opponentView.strikeX) * AIM_SMOOTH;
  opponentView.strikeY += (opponentAim.strikeY - opponentView.strikeY) * AIM_SMOOTH;
  opponentView.pullback += (opponentAim.pullback - opponentView.pullback) * AIM_SMOOTH;
}
const localPlace = { x: -tableW / 4, z: 0 };
let sceneReady = false;
let stageCanvas = null;

// Ball-in-hand placement is driven by the actual (visible) cursor in the
// overhead view: raycast the cursor through the camera onto the ball plane
// (y = R) to get the table point the cursor is over.
const placeRay = new THREE.Raycaster();
const placeNdc = new THREE.Vector2();
const placePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);   // y = R
const placeHit = new THREE.Vector3();
function cursorToTable(clientX, clientY) {
  if (!stageCanvas || !camera) return null;
  const rect = stageCanvas.getBoundingClientRect();
  placeNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  placeNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  placeRay.setFromCamera(placeNdc, camera);
  return placeRay.ray.intersectPlane(placePlane, placeHit) ? placeHit : null;
}
let input = null;
// V-key cycles the camera preference: 'aim' (down the stick) → 'free'
// (fly-around) → 'top' (overhead). Resolved against game state each frame.
let camPref = 'aim';
const railPoints = densify(rail_pts(tableW, tableH));   // sampled rail for cue-clearance

const myTurn = () => gs.current === net.myIndex;

// ---- Scene (built once; renders behind the menu until a match starts) --------
function buildScene() {
  if (sceneReady) return;
  const { canvas, scene } = initScene();
  stageCanvas = canvas;

  const railPoints = rail_pts(tableW, tableH);
  const feltPoints = felt_pts(tableW, tableH);
  const pocketPositions = pocket_positions(tableW, tableH);
  scene.add(makePlanarMeshFromPolyline(feltPoints, 0.2, -0.1, {}));
  scene.add(makePolylineMesh(railPoints, rodR, wireY, { color: 0xb8c2cc }));
  for (const [x, z] of pocketPositions) {
    scene.add(makeCylindricalCupMesh(0.075, 0.4, { pos: { x, y: -0.21, z } }));
  }
  initCueStick();

  input = bindInput(canvas, {
    isReady:  () => net.inGame && !replaying() && gs.interact === PH_AIMING && myTurn(),
    isPlacing: () => net.inGame && !replaying() && gs.interact === PH_PLACING && myTurn(),
    onToggleView: () => {                               // V: cycle aim → free → top
      camPref = camPref === 'aim' ? 'free' : camPref === 'free' ? 'top' : 'aim';
      // Snapshot the current view when entering free so it doesn't jump (read
      // the live camera BEFORE the loop swaps to the perspective one).
      if (camPref === 'free') initFreeCamFromCurrent();
    },
    onZoom: (deltaY) => zoomCamera(deltaY),            // scroll: dolly the camera
    onPlaceMove: (clientX, clientY) => {
      if (!(gs.interact === PH_PLACING && myTurn())) return;
      const p = cursorToTable(clientX, clientY);   // where the cursor points on the felt
      if (!p) return;
      localPlace.x = p.x; localPlace.z = p.z;       // server clamps to the legal region
      socket.emit('placeMove', { x: localPlace.x, z: localPlace.z });
    },
    onPlaceConfirm: () => { if (gs.interact === PH_PLACING && myTurn()) socket.emit('placeConfirm', {}); },
    onShoot: (pull) => {
      if (!(gs.interact === PH_AIMING && myTurn())) return;
      const s = getStrikeOffset();
      socket.emit('shoot', { yaw: getYaw(), pitch: getPitch(), strikeX: s.x, strikeY: s.y, power: pull });
    },
  });

  sceneReady = true;
}

// ---- Menu / lobby / game visibility -----------------------------------------
const $ = (id) => document.getElementById(id);
function show(el, on) { $(el).classList.toggle('hidden', !on); }
function showMenu()  { show('menu', true);  show('lobby', false); net.inGame = false; net.bot = false; }
function showLobby(code) { show('menu', false); show('lobby', true); $('lobbyCode').textContent = code; }
function showGame()  { show('menu', false); show('lobby', false); net.inGame = true; }

function nameVal() { return ($('nameInput').value || 'Player').slice(0, 16); }
function gameVal() { return parseInt($('gameSelect').value, 10) || 0; }

$('btnCreate').addEventListener('click', () => socket.emit('createRoom', { name: nameVal(), game: gameVal() }));
$('btnQuick').addEventListener('click',  () => socket.emit('quickPlay',  { name: nameVal(), game: gameVal() }));
$('btnBot').addEventListener('click',    () => { net.bot = true; socket.emit('playBot', { name: nameVal(), game: gameVal(), skill: botSkillVal() }); });

// ---- Bot difficulty slider ----------------------------------------------------
// Lives next to the Computer's name: renderHUD rebuilds the player chips on
// every gameState, so after each render we re-parent the (persistent) slider
// element into the bot's chip. Value 0-100, higher = more accurate bot.
const botSkillWrap = $('botSkillWrap');
const botSkillVal = () => Math.max(0, Math.min(100, parseInt($('botSkillSlider').value, 10) || 0));
$('botSkillSlider').addEventListener('input', () => socket.emit('botSkill', { value: botSkillVal() }));
function placeBotSlider() {
  if (!net.bot) { botSkillWrap.classList.add('hidden'); return; }
  const chips = $('turnInfo').children;
  if (chips.length >= 2) {          // chip[1] is always the Computer
    chips[1].appendChild(botSkillWrap);
    botSkillWrap.classList.remove('hidden');
  }
}
$('btnJoin').addEventListener('click',   () => {
  const code = ($('codeInput').value || '').toUpperCase().trim();
  if (code.length) socket.emit('joinRoom', { name: nameVal(), code });
});
$('btnLeaveLobby').addEventListener('click', () => { socket.emit('leaveRoom', {}); showMenu(); });
$('btnLeaveGame').addEventListener('click',  () => { socket.emit('leaveRoom', {}); cancelReplay(); clearRack(); showMenu(); });
$('btnNewGame').addEventListener('click',    () => socket.emit('newGame', { game: 255 }));

// ---- Shot replay --------------------------------------------------------------
// The server simulates the ENTIRE shot the moment it's taken and sends one
// `shotAnim` packet: delta-encoded keyframes at dtMs intervals from strike to
// rest (see packets.js; beginReplay expands them back to full frames), plus
// which balls vanish at which frame. The client plays that back at
// wall-clock rate, interpolating between the two keyframes bracketing the
// playhead (lerp + slerp) — perfectly smooth at any refresh rate, no network
// hiccups possible mid-shot. Post-shot packets (gameState/placing/balls) are
// broadcast immediately after the recording, so they're QUEUED while the
// replay runs and applied when it finishes — HUD messages and ball-in-hand
// don't spoil the outcome early.
const replay = { anim: null, start: 0, nextRemoval: 0, queue: [] };
const replaying = () => !!replay.anim;

function beginReplay(anim) {
  // Frames arrive delta-encoded, positions and rotations independently: after
  // full frame 0, a frame carries a ball's `pos` entry only if it moved since
  // the last frame that sent one, and its `rot` entry only if it rotated —
  // nothing on the wire is ever a duplicate. Expand back to full per-ball
  // frames here by carrying last-known values forward, so the lerp below can
  // keep treating every frame as complete.
  const pos = new Map(), rot = new Map();         // id -> latest pos / rot
  for (const f of anim.frames) {
    for (const p of f.pos) pos.set(p.id, p);
    for (const r of f.rot) rot.set(r.id, r);
    f.balls = [];
    for (const [id, p] of pos) {
      const r = rot.get(id);
      f.balls.push({ id, x: p.x, y: p.y, z: p.z, qx: r.qx, qy: r.qy, qz: r.qz, qw: r.qw });
    }
  }
  replay.anim = anim;
  replay.start = performance.now();
  replay.nextRemoval = 0;
}

function tickReplay(now) {
  const a = replay.anim;
  if (!a) return;
  // Playhead in keyframes. Clamped at 0: the rAF timestamp marks the start of
  // the frame batch, so it can PREDATE the performance.now() beginReplay took
  // inside the socket handler — unclamped that indexes frames[-1].
  const tf = Math.max(0, (now - replay.start) / a.dtMs);
  while (replay.nextRemoval < a.removals.length && a.removals[replay.nextRemoval].frame <= tf) {
    removeBallView(a.removals[replay.nextRemoval].id);
    replay.nextRemoval++;
  }
  const i = Math.floor(tf);
  if (i >= a.frames.length - 1) return endReplay();
  applyBallsFrameLerp(a.frames[i].balls, a.frames[i + 1].balls, tf - i);
}

function endReplay() {
  const a = replay.anim;
  if (!a) return;
  while (replay.nextRemoval < a.removals.length) removeBallView(a.removals[replay.nextRemoval++].id);
  applyBallsFrame(a.frames[a.frames.length - 1].balls);
  replay.anim = null;
  const q = replay.queue.splice(0);
  for (const { fn, data } of q) fn(data);        // deliver the post-shot packets
}

function cancelReplay() {
  replay.anim = null;
  replay.queue.length = 0;
}

// Defer a handler while a replay is playing; run it live otherwise.
const afterReplay = (fn) => (data) => {
  if (replaying()) replay.queue.push({ fn, data });
  else fn(data);
};

// ---- Server events ----------------------------------------------------------
socket.on('errorMsg', ({ message }) => { $('menuMsg').textContent = message; });

socket.on('roomJoined', ({ code, playerIndex, host }) => {
  net.myIndex = playerIndex; net.code = code;
  $('menuMsg').textContent = '';
  if (host) showLobby(code);   // waiting for opponent; startGame will reveal the game
});

socket.on('lobby', ({ state, players }) => {
  if (state === LOBBY_WAITING) showLobby(net.code);
});

socket.on('startGame', ({ layout }) => {
  buildScene();
  cancelReplay();
  buildRack(layout);
  const cue = layout.find(b => b.id === 0);
  if (cue) { localPlace.x = cue.x; localPlace.z = cue.z; }
  showGame();
  if (net.bot) socket.emit('botSkill', { value: botSkillVal() });  // sync slider → server
});

socket.on('gameState', afterReplay((state) => {
  const wasMyAimingTurn = prevTurnKey === `${PH_AIMING}:${net.myIndex}`;
  gs = state;
  renderHUD(gs);
  renderPocketed(gs.pocketed);
  placeBotSlider();               // re-attach the difficulty slider to the bot chip

  const turnKey = `${gs.interact}:${gs.current}`;
  // Reset my spin/charge/view at the start of my aiming turn.
  if (gs.interact === PH_AIMING && myTurn() && !wasMyAimingTurn) {
    resetStrikeOffset(); setPullback(0); camPref = 'aim';
  }
  // Start of an opponent's aiming turn: snap the smoothed cue to their first
  // aim (below) instead of sweeping across the table from last turn's pose.
  if (gs.interact === PH_AIMING && !myTurn() && turnKey !== prevTurnKey) snapOpponent = true;
  prevTurnKey = turnKey;
}));

socket.on('placing', afterReplay((p) => {
  gs.interact = PH_PLACING;
  gs.current = p.player;
  if (p.player === net.myIndex) { localPlace.x = p.x; localPlace.z = p.z; }
  setCuePosition(p.x, p.z);
}));

socket.on('shotAnim', (anim) => beginReplay(anim));
socket.on('balls', afterReplay(({ items }) => { applyBallsFrame(items); }));
socket.on('removeBall', afterReplay(({ id }) => { removeBallView(id); }));
socket.on('aimState', (a) => {
  Object.assign(opponentAim, a);
  // First aim of a new spectated turn → snap the shown cue to it, then ease.
  if (snapOpponent) { Object.assign(opponentView, opponentAim); snapOpponent = false; }
});

socket.on('opponentLeft', () => {
  $('menuMsg').textContent = 'Opponent left the game.';
  cancelReplay(); clearRack(); showMenu();
});
socket.on('disconnect', () => {
  $('menuMsg').textContent = 'Disconnected from server.';
  cancelReplay(); clearRack(); showMenu();
});

// ---- Strike-point widget ----------------------------------------------------
const strikeDot = $('strikeDot');
const STRIKE_WIDGET_R = 36;
function updateStrikeWidget() {
  if (!strikeDot) return;
  const { x, y } = getStrikeOffset();
  strikeDot.style.transform = `translate(${x * STRIKE_WIDGET_R}px, ${-y * STRIKE_WIDGET_R}px)`;
}

// ---- Power bar ---------------------------------------------------------------
// Sidebar bar showing the current pullback as a fraction of max. Driven from
// the render loop like the strike widget; cue.js pullback is also fed by the
// opponent's/bot's streamed aim, so the bar mirrors their draw-back too.
const powerCover = $('powerCover');
function updatePowerBar() {
  if (!powerCover) return;
  const p = Math.min(1, Math.max(0, getPullback() / getMaxPullback()));
  powerCover.style.width = `${(1 - p) * 100}%`;
}

// Sidebar label of the current camera view. Driven from the render loop with
// the resolved view ('aim'|'free'|'top'), so it reflects forced-overhead states
// (placing/spectating/game-over) too, not just the V preference.
const viewNameEl = $('viewName');
const VIEW_LABELS = { aim: 'Aim (down cue)', free: 'Free fly-around', top: 'Overhead' };
let lastViewName = '';
function setViewName(view) {
  if (!viewNameEl || view === lastViewName) return;
  lastViewName = view;
  viewNameEl.textContent = VIEW_LABELS[view] || view;
}

// ---- Aim streaming (so the opponent sees my cue) ----------------------------
let lastAimSent = 0;
function maybeSendAim(now) {
  if (now - lastAimSent < 50) return;   // ~20 Hz
  lastAimSent = now;
  const s = getStrikeOffset();
  socket.emit('aim', { yaw: getYaw(), pitch: getPitch(), strikeX: s.x, strikeY: s.y, pullback: getPullback() });
}

// ---- Render loop ------------------------------------------------------------
function loop(now) {
  requestAnimationFrame(loop);
  if (!sceneReady) return;
  if (input) input.tick();
  updateStrikeWidget();
  updatePowerBar();
  tickReplay(now);

  if (net.inGame) {
    // While a shot replay is playing, behave as if the table were live-shooting
    // (spectator camera, cue hidden) regardless of the — deferred — game state.
    const interact = replaying() ? PH_SHOOTING : gs.interact;
    const cuePos = getCueMeshPosition();
    // Feed cue.js the active aim: mine (already set by input) or the opponent's.
    if (interact === PH_AIMING) {
      if (myTurn()) {
        // Enforce cue elevation: raise pitch to clear any ball/rail behind the
        // cue ball along the current aim (the player can't dip below it).
        if (cuePos) {
          const minP = minPitchForShot(cuePos.x, cuePos.z, getYaw(), getStrikeOffset().y, getObstaclePositions(), railPoints);
          if (getPitch() < minP) setPitch(minP);
        }
        maybeSendAim(now);
      } else {
        // Spectating the opponent/bot: ease the shown cue toward the streamed
        // target so their aim and draw-back interpolate smoothly.
        easeOpponentView();
        setYaw(opponentView.yaw); setPitch(opponentView.pitch);
        setStrikeOffset(opponentView.strikeX, opponentView.strikeY); setPullback(opponentView.pullback);
      }
    }
    // Resolve the camera. Free (V-cycle) overrides everything — a fly-around
    // works any time. Otherwise overhead is forced while placing, spectating
    // the opponent, or at game-over (bird's-eye of the final table); on my own
    // shot the V preference ('aim' or 'top') applies.
    const forcedTop = interact === PH_PLACING || interact === PH_OVER || !myTurn();
    const view = camPref === 'free' ? 'free' : (forcedTop ? 'top' : camPref);
    setViewMode(view);
    setViewName(view);
    setCueVisible(interact === PH_AIMING);

    if (cuePos && interact === PH_AIMING) updateCueAndCamera(cuePos);
    else placeCamera();
  }

  render();
}

// ---- Deep-link / auto-join (shareable room links; also drives tests) --------
window.__errors = [];
window.addEventListener('error', e => window.__errors.push(String(e.message || e.error)));
window.__net = { socket, state: () => gs, me: () => net };

const params = new URLSearchParams(location.search);
if (params.get('name')) $('nameInput').value = params.get('name');
if (params.get('game')) $('gameSelect').value = params.get('game');
socket.on('connect', () => {
  const j = params.get('join');
  if (j) socket.emit('joinRoom', { name: nameVal(), code: j.toUpperCase() });
  else if (params.has('create')) socket.emit('createRoom', { name: nameVal(), game: gameVal() });
  else if (params.has('quick')) socket.emit('quickPlay', { name: nameVal(), game: gameVal() });
  else if (params.has('bot')) { net.bot = true; socket.emit('playBot', { name: nameVal(), game: gameVal(), skill: botSkillVal() }); }
});

showMenu();
requestAnimationFrame(loop);
