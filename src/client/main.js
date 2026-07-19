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
  initCueStick, updateCueAndCamera, updateCueStick, placeCamera,
  setVisible as setCueVisible, isVisible as isCueVisible,
  getStrikeOffset, setStrikeOffset, resetStrikeOffset, setViewMode,
  getYaw, setYaw, getPitch, setPitch, getPullback, setPullback, getMaxPullback,
  zoomCamera, initFreeCamFromCurrent, resetTopPan,
} from './cue.js';
import { bindInput } from './input.js';
import {
  buildRack, syncRack, setCuePosition,
  getCueMeshPosition, getObstaclePositions, clearRack, ballIds, sunkNumbers,
} from './balls.view.js';
import { createTimeline } from './timeline.js';
import { legalPitch, densify } from '../shared/clearance.js';
import { renderHUD } from './hud.js';
import { initHud, drawHud, clearHud } from './hudCanvas.js';
import {
  initReview, setReviewLayout, numberForBallId, openReviewPanel,
  render as renderReviewUi, reviewChromeHeight,
} from './shotReview.js';
import { SocketClient } from '../../lib/socketUtility.js';
import {
  packetSchemas, PH_AIMING, PH_SHOOTING, PH_PLACING, PH_OVER,
  LOBBY_WAITING, gameByteFromId, GAME_9BALL,
} from '../shared/net/packets.js';

// ---- Networking -------------------------------------------------------------
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${proto}//${location.host}`;
const socket = new SocketClient(new WebSocket(wsUrl), { packetSchemas });

// ---- Session (survives a reload) ---------------------------------------------
// The server hands out a per-SEAT token in roomJoined and holds the seat for 45s
// after a drop. Stashing {token, shotIndex} here is what lets a reload rejoin the
// same game instead of landing on the menu. sessionStorage (not localStorage) so
// the token is scoped to this tab — two tabs can never fight over one seat.
const SESSION_KEY = 'poolSession';
let session = null;                       // { token, code, shotIndex }
let firstConnect = true;                  // the page-load connect resumes; later ones reconnect
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function saveSession(next) {
  session = next;
  try {
    if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* private mode — reconnect just won't survive a reload */ }
}
function noteShotWatched(index) {
  // Recorded when a shot FINISHES replaying, not when it arrives: reloading
  // mid-replay should replay that shot from the start, not skip it.
  if (!session || index == null || index + 1 <= session.shotIndex) return;
  saveSession({ ...session, shotIndex: index + 1 });
}

// ---- Client state -----------------------------------------------------------
const net = { myIndex: -1, code: '', inGame: false, bot: false, connected: true };  // bot: vs-Computer room
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
const _reviewAnchor = new THREE.Vector3();   // fixed aim-view anchor during replay
const _placeVec = new THREE.Vector3();       // projects the cue ball to screen for the ✓ button
function cursorToTable(clientX, clientY) {
  if (!stageCanvas || !camera) return null;
  const rect = stageCanvas.getBoundingClientRect();
  placeNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  placeNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  placeRay.setFromCamera(placeNdc, camera);
  return placeRay.ray.intersectPlane(placePlane, placeHit) ? placeHit : null;
}
// True if the pointer is over (near) the cue ball on the felt — used so ball-in-
// hand can tell "drag the ball" from "pan the table". Generous grab radius (5R)
// so it's easy to grab, on mouse and touch.
function isOverCueBall(clientX, clientY) {
  const p = cursorToTable(clientX, clientY);
  const cue = getCueMeshPosition();   // the ball's actual (server-clamped) spot
  if (!p || !cue) return false;
  const dx = p.x - cue.x, dz = p.z - cue.z;
  return dx * dx + dz * dz <= (5 * R) * (5 * R);
}
function confirmPlace() {
  if (gs.interact === PH_PLACING && myTurn()) socket.emit('placeConfirm', {});
}
let input = null;
// V-key cycles the camera preference: 'aim' (down the stick) → 'free'
// (fly-around) → 'top' (overhead). Resolved against game state each frame.
let camPref = 'aim';
let ballCount = 15;         // object balls in play (15 for 8-ball, 9 for 9-ball)
const railPoints = densify(rail_pts(tableW, tableH));   // sampled rail for cue-clearance

const myTurn = () => gs.current === net.myIndex;

// ---- Scene (built once; renders behind the menu until a match starts) --------
function buildScene() {
  if (sceneReady) return;
  const { canvas, scene } = initScene();
  stageCanvas = canvas;
  initHud(document.getElementById('hudCanvas'));   // 2D overlay HUD (spin/power/view/pocketed)
  initReview(timeline);   // shot list + transport bar, driving the playhead

  const railPoints = rail_pts(tableW, tableH);
  const feltPoints = felt_pts(tableW, tableH);
  const pocketPositions = pocket_positions(tableW, tableH);
  // Table slab, 1 inch (0.0254 m) thick; top stays at the felt level (y=0), so
  // pass y = -thickness/2. (Purely visual — the physics felt is a plane at y=0.)
  scene.add(makePlanarMeshFromPolyline(feltPoints, 0.0254, -0.0127, { felt: true }));
  scene.add(makePolylineMesh(railPoints, rodR, wireY, { color: 0xb8c2cc }));
  for (const [x, z] of pocketPositions) {
    scene.add(makeCylindricalCupMesh(0.075, 0.4, { pos: { x, y: -0.21, z } }));
  }
  initCueStick();

  input = bindInput(canvas, {
    // isLive() covers everything at once: a live shot playing, a reconnect
    // backlog draining, and a past shot being reviewed. While the playhead is
    // shots play out, `gs` still describes the state before them, so acting on
    // it would aim at stale ball positions.
    isReady:  () => net.inGame && net.connected && isLive() && gs.interact === PH_AIMING && myTurn(),
    isPlacing: () => net.inGame && net.connected && isLive() && gs.interact === PH_PLACING && myTurn(),
    onToggleView: cycleView,                            // V: cycle aim → free → top
    onZoom: (deltaY) => zoomCamera(deltaY),            // scroll: dolly the camera
    isOverCueBall,
    onPlaceMove: (clientX, clientY) => {
      if (!(gs.interact === PH_PLACING && myTurn())) return;
      const p = cursorToTable(clientX, clientY);   // where the cursor points on the felt
      if (!p) return;
      localPlace.x = p.x; localPlace.z = p.z;       // server clamps to the legal region
      socket.emit('placeMove', { x: localPlace.x, z: localPlace.z });
    },
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

// Connection status strip (reconnecting / opponent reconnecting). `text` is a
// function so the caller can tick a countdown; pass null to clear.
let bannerTimer = null;
function setBanner(text, tick) {
  if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; }
  const el = $('netBanner');
  // Clear the text as well as hiding: a stale "Reconnecting… 37s" left sitting
  // in the DOM long after we reconnected reads as a live countdown to anyone
  // inspecting the page.
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text();
  el.classList.remove('hidden');
  bannerTimer = setInterval(() => {
    if (tick) tick();
    el.textContent = text();
  }, 1000);
}

function nameVal() { return ($('nameInput').value || 'Player').slice(0, 16); }
function gameVal() { return parseInt($('gameSelect').value, 10) || 0; }

$('btnCreate').addEventListener('click', () => socket.emit('createRoom', { name: nameVal(), game: gameVal() }));
$('btnQuick').addEventListener('click',  () => socket.emit('quickPlay',  { name: nameVal(), game: gameVal() }));
$('btnBot').addEventListener('click',    () => { net.bot = true; socket.emit('playBot', { name: nameVal(), game: gameVal(), skill: botSkillVal() }); });

// ---- Bot difficulty slider ----------------------------------------------------
// Lives in the hamburger menu; shown only in bot games. Value 0-100, higher =
// more accurate bot.
const botSkillWrap = $('botSkillWrap');
const botSkillVal = () => Math.max(0, Math.min(100, parseInt($('botSkillSlider').value, 10) || 0));
$('botSkillSlider').addEventListener('input', () => socket.emit('botSkill', { value: botSkillVal() }));
function placeBotSlider() { botSkillWrap.classList.toggle('hidden', !net.bot); }

// ---- Hamburger menu + instructions expanders ----------------------------------
$('menuBtn').addEventListener('click', () => $('sideMenu').classList.toggle('collapsed'));
$('helpToggle').addEventListener('click', () => {
  const collapsed = $('helpPanel').classList.toggle('collapsed');
  $('helpToggle').textContent = collapsed ? 'Instructions ▸' : 'Instructions ▾';
});
$('btnJoin').addEventListener('click',   () => {
  const code = ($('codeInput').value || '').toUpperCase().trim();
  if (code.length) socket.emit('joinRoom', { name: nameVal(), code });
});
// Leaving is deliberate: drop the session too, so a later reload goes to the
// menu instead of trying to resume a game we walked away from.
$('btnLeaveLobby').addEventListener('click', () => { socket.emit('leaveRoom', {}); saveSession(null); showMenu(); });
$('btnLeaveGame').addEventListener('click',  () => { socket.emit('leaveRoom', {}); saveSession(null); timeline.reset(); clearRack(); showMenu(); });
$('btnNewGame').addEventListener('click',    () => socket.emit('newGame', { game: 255 }));

// ---- Shot replay --------------------------------------------------------------
// Sequencing lives in replayQueue.js; playback in shotPlayer.js. Here we only
// wire them to the scene, the HUD and the review recorder.
//
// A `shotAnim` is self-contained: keyframes from strike to rest, plus `post` —
// the state the shot resolved to. So the outcome cannot arrive before you have
// watched the shot, and there is nothing to defer.
// The one thing that decides what is on screen. Live play, catching up after a
// reconnect and reviewing a past shot are the same playhead at different
// positions — see timeline.js.
const timeline = createTimeline({
  // Replay frames carry only ids; a mesh needs the number to be textured.
  // Replay frames carry only ids; a mesh needs the number to be textured.
  syncRack: (balls) => syncRack(balls.map(b => (b.number === undefined
    ? { ...b, number: numberForBallId(b.id) } : b))),
  showState: applyGameState,
  showPlacing: applyPlacing,
  hideCue: () => setCueVisible(false),
  onChange: () => { renderReviewUi(); noteWatched(); },
  fetchShot: (index) => socket.emit('requestShot', { index }),
});

// A shot is "watched" once the playhead has passed it, so a reload mid-replay
// replays it from the start rather than skipping it.
function noteWatched() {
  const entries = timeline.entries();
  for (const e of entries) if (e.watched && e.anim) noteShotWatched(e.index);
}

const isLive = () => timeline.isLive();
const drawingBack = () => timeline.drawingBack();

// Complain loudly (never throw — socketUtility swallows handler exceptions and
// reports them all as "Packet doesn't fit schema", which is how a real bug once
// hid for the life of the project). The push is what test/browser/ asserts on.
function assertLive(what) {
  if (timeline.isLive()) return;
  const msg = `state-during-replay:${what}`;
  console.error(`[pool] ${msg} — the playhead is showing a past shot, so this `
    + `would reveal the outcome before the shot.`);
  window.__errors.push(msg);
}

// ---- Server events ----------------------------------------------------------
socket.on('errorMsg', ({ message }) => {
  // A rejected resume (seat gone, room torn down) is terminal — stop waiting.
  if (net.resuming) { net.resuming = false; giveUp(message); return; }
  $('menuMsg').textContent = message;
});

socket.on('roomJoined', ({ code, playerIndex, host, token, bot }) => {
  net.myIndex = playerIndex; net.code = code;
  // The server is the authority on whether this room has a computer opponent —
  // a resumed client never went through the "Play Computer" button, so without
  // this it would lose the difficulty slider.
  net.bot = bot;
  // Same token = we just resumed this seat, so the watched-shot count still
  // applies; a new token is a new room and starts at zero. (A resume re-sends
  // roomJoined, and it arrives BEFORE the backlog — zeroing here would make us
  // re-watch shots we already finished.)
  const watched = (session && session.token === token) ? session.shotIndex : 0;
  saveSession({ token, code, shotIndex: watched });
  $('menuMsg').textContent = '';
  if (host) showLobby(code);   // waiting for opponent; startGame will reveal the game
});

socket.on('lobby', ({ state, players }) => {
  if (state === LOBBY_WAITING) showLobby(net.code);
});

socket.on('startGame', ({ game, layout }) => {
  buildScene();
  resetTopPan();             // recenter overhead for the new game
  // Pocketed-column length. Taken from the ruleset, NOT from the layout's
  // highest number: a resume rebuilds the rack from the balls still on the
  // table, so the top ball may already be gone.
  ballCount = game === GAME_9BALL ? 9 : 15;
  setReviewLayout(layout);   // fix id→number for this rack
  timeline.reset();          // a new rack: drop the previous one's shots
  buildRack(layout);
  if (net.resuming) {
    // Resuming into the SAME rack: keep the watched-shot counter. Zeroing it
    // here would make the next drop re-request shots we already sat through.
    // (A genuinely new rack while we were away is safe too — the server clamps
    // a stale index to its own shot count.) Shots that follow are the backlog:
    // start it overhead so the whole table is visible — a starting preference,
    // not a lock; V still cycles the view as it does for any opponent shot.
    net.resuming = false;
    camPref = 'top';
  } else if (session) {
    saveSession({ ...session, shotIndex: 0 });   // new rack → new shot numbering
  }
  const cue = layout.find(b => b.id === 0);
  if (cue) { localPlace.x = cue.x; localPlace.z = cue.z; }
  showGame();
  placeBotSlider();          // show/hide the difficulty slider now, not only on the first gameState
  if (net.bot) socket.emit('botSkill', { value: botSkillVal() });  // sync slider → server
});

// Adopt a game state: HUD text, player chips, turn-transition side effects.
// Called for live states and, via a shot's own `post`, when a replay ends — so
// the top bar tracks a replayed shot the same way it tracks a live one.
function applyGameState(state) {
  // The invariant, still asserted even though the timeline now makes it
  // structural: present-tense state must never reach the screen while the
  // playhead is showing the past. renderLive() is the only caller and it is
  // guarded by isLive(), so this cannot fire — which is exactly why it is worth
  // keeping. If a future change calls this directly again, the browser tests
  // fail here instead of a player noticing a spoiled shot weeks later.
  assertLive('gameState');
  const wasMyAimingTurn = prevTurnKey === `${PH_AIMING}:${net.myIndex}`;
  gs = state;
  renderHUD(gs);                  // sidebar: players + status (pocketed now on the HUD canvas)
  placeBotSlider();               // re-attach the difficulty slider to the bot chip
  if (gs.winner >= 0) { $('sideMenu').classList.remove('collapsed'); openReviewPanel(); }   // game over → surface the replay controls

  const turnKey = `${gs.interact}:${gs.current}`;
  // Reset my spin/charge/view at the start of my aiming turn.
  if (gs.interact === PH_AIMING && myTurn() && !wasMyAimingTurn) {
    resetStrikeOffset(); setPullback(0); camPref = 'aim';
  }
  // Start of an opponent's aiming turn: snap the smoothed cue to their first
  // aim (below) instead of sweeping across the table from last turn's pose.
  if (gs.interact === PH_AIMING && !myTurn() && turnKey !== prevTurnKey) snapOpponent = true;
  prevTurnKey = turnKey;
}

// Adopt a ball-in-hand state. Also reached via a shot's `post` when the shot
// ended in a foul.
function applyPlacing(p) {
  assertLive('placing');
  gs.interact = PH_PLACING;
  gs.current = p.player;
  if (p.player === net.myIndex) { localPlace.x = p.x; localPlace.z = p.z; }
  setCuePosition(p.x, p.z);
}

// THE INVARIANT, and the guard that keeps it honest.
//
// While a replay is on screen the client is showing the PAST. A state-bearing
// packet describes the PRESENT. Applying one during the other is the single bug
// this codebase keeps producing: the HUD spoiling a shot before you watch it,
// and a ball deleted from the table moments before the replay shows it being
// pocketed. State must ride on the shot it belongs to (`post`), never arrive
// alongside it.
//
// State packets are STORED as the newest server truth, not applied. The
// timeline renders them once the playhead is live, so one arriving while a
// replay is on screen cannot show the outcome before the shot — the bug this
// codebase kept producing. Nothing to defer, queue or order.
socket.on('gameState', (state) => timeline.setLiveState(state));
socket.on('placing', (p) => timeline.setLivePlacing(p));
// history = a recording we asked for (requestShot) to review a shot watched
// before we dropped. File it against its placeholder; never play it.
socket.on('shotAnim', (anim) => {
  // history = a recording we asked for, to review a shot watched before we
  // dropped. It fills its slot in the log; it is never queued for playback.
  if (anim.history) timeline.provide(anim);
  else timeline.appendShot(anim);
});

// The rack's shot list, labels only — sent on resume, since re-entering the
// rack clears the review list. Recordings are fetched per shot on demand.
socket.on('shotHistory', ({ shots }) => { for (const m of shots) timeline.appendMeta(m); });
// The authoritative ball set, not just positions: reconcile the rack to match
// exactly. This is what stops a ghost ball surviving past a shot — whatever the
// client got up to during playback, this puts it back in agreement.
socket.on('balls', (frame) => timeline.setLiveBalls(frame));
socket.on('aimState', (a) => {
  Object.assign(opponentAim, a);
  // First aim of a new spectated turn → snap the shown cue to it, then ease.
  if (snapOpponent) { Object.assign(opponentView, opponentAim); snapOpponent = false; }
});

socket.on('opponentLeft', () => giveUp('Opponent left the game.'));

// The opponent dropped but their seat is held — show a banner and wait, rather
// than ending the game. opponentLeft still arrives if they never come back.
socket.on('opponentState', ({ connected, secondsLeft }) => {
  if (connected) { setBanner(null); return; }
  let left = secondsLeft;
  setBanner(() => `Opponent reconnecting… ${left}s`, () => (left = Math.max(0, left - 1)));
});

// ---- Reconnect ---------------------------------------------------------------
// A dropped socket is never fatal, on ANY screen. `emit` on a closed socket is
// silently dropped (see emitEventCode in socketUtility.js), so without this the
// menu looks alive but every button does nothing and only a reload fixes it.
//
// Two flavours, differing only in whether there is a clock:
//
//   In a game   The server holds our seat for RECONNECT_GRACE_MS and then tears
//               the room down, so there IS a deadline. We keep the table on
//               screen, dial back in, and `resume` — the server replays every
//               shot taken while we were away (see resumeSeat in
//               server/index.js). The rack and the shot review are deliberately
//               NOT torn down: they're what we resume into.
//
//   Menu/lobby  Nothing is expiring, so there is no deadline and no failure —
//               keep retrying until the server is back. This is what makes a
//               server restart survivable without a reload.
//
// The window is the total budget before giving up, NOT a delay before trying:
// the first attempt goes out 500ms after the drop, then backs off ×2 to a 5s
// cap, so attempts land at 0.5, 1.5, 3.5, 7.5, 12.5 … 37.5s.
//
// Deliberately 5s under the server's 45s RECONNECT_GRACE_MS. What matters is
// where the LAST attempt falls, since the backoff cap makes it land well short
// of the window: at 45s it was t=42.5s, leaving only 2.5s for a handshake plus
// the resume packet on a network that has just failed — and if that overruns,
// the seat is gone and you get "Session expired" instead of reconnecting. At
// 40s the last attempt is t=37.5s, so the margin is 7.5s.
const RECONNECT_WINDOW_MS = 40_000;
const RECONNECT_MAX_DELAY = 5000;
let reconnectDeadline = 0, reconnectDelay = 0, reconnectTimer = null;
let reconnecting = false;

function giveUp(message) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDeadline = 0;
  reconnecting = false;
  setBanner(null);
  saveSession(null);
  $('menuMsg').textContent = message;
  timeline.reset(); clearRack(); showMenu();
}

function tryReconnect() {
  reconnectTimer = null;
  // Only an in-game reconnect can time out; elsewhere reconnectDeadline is 0
  // and we retry for as long as it takes.
  if (reconnectDeadline && Date.now() > reconnectDeadline) {
    giveUp('Disconnected from server.');
    return;
  }
  // The `ws` setter detaches the old socket and re-inits on the new one while
  // keeping every registered listener, so this is the whole reconnect.
  socket.ws = new WebSocket(wsUrl);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(tryReconnect, reconnectDelay);
}

socket.on('connect', () => {
  net.connected = true;
  if (!reconnecting) return;              // first connect — handled at the bottom of this file
  reconnecting = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDeadline = 0;
  setBanner(null);                        // back on the wire; a failed resume re-clears via giveUp

  // Reclaim the seat if we hold a token — in a game OR sitting in a lobby. The
  // server adjudicates: a lobby room is destroyed on drop (it has no sim to
  // preserve), so that resume is rejected and errorMsg lands us back on the
  // menu, now with a working socket instead of a dead one. Without a token
  // there is nothing to reclaim and being connected again is the whole job.
  if (session && session.token) {
    net.resuming = true;
    socket.emit('resume', { token: session.token, lastShot: session.shotIndex | 0 });
  }
});

socket.on('disconnect', () => {
  net.connected = false;
  if (reconnecting) return;               // already retrying
  reconnecting = true;
  reconnectDelay = 500;

  if (session && net.inGame) {
    reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
    let left = Math.round(RECONNECT_WINDOW_MS / 1000);
    setBanner(() => `Reconnecting… ${left}s`, () => (left = Math.max(0, left - 1)));
  } else {
    reconnectDeadline = 0;                // nothing to lose: retry indefinitely
    setBanner(() => 'Reconnecting…');
  }
  reconnectTimer = setTimeout(tryReconnect, reconnectDelay);
});

// The spin dial, power meter, camera-view label and pocketed balls are drawn on
// the HUD overlay canvas (hudCanvas.js) from the render loop — see drawHud below.

// ---- Aim streaming (so the opponent sees my cue) ----------------------------
let lastAimSent = 0;
function maybeSendAim(now) {
  if (!net.connected) return;           // mid-reconnect: emitting on a dead socket re-fires disconnect
  if (now - lastAimSent < 50) return;   // ~20 Hz
  lastAimSent = now;
  const s = getStrikeOffset();
  socket.emit('aim', { yaw: getYaw(), pitch: getPitch(), strikeX: s.x, strikeY: s.y, pullback: getPullback() });
}

// ---- Camera view cycling + on-screen controls -------------------------------
// V key and the on-screen view button both cycle aim → free → overhead.
function cycleView() {
  camPref = camPref === 'aim' ? 'free' : camPref === 'free' ? 'top' : 'aim';
  if (camPref === 'free') initFreeCamFromCurrent();
  // Overhead pan/zoom persist across view switches (recentred only on new game),
  // so returning to bird's-eye restores your last overhead framing.
}
$('viewBtn').addEventListener('click', cycleView);

const VIEW_ICONS = { aim: '🎯', free: '🎥', top: '⬇️' };
const VIEW_NAMES = { aim: 'Aim (down cue)', free: 'Free fly-around', top: 'Overhead' };
// Reflect the current view in the button icon and show the matching bottom-right
// controls: zoom in aim/overhead, the movement pad in free-fly.
function updateViewUi(view) {
  const vb = $('viewBtn');
  vb.textContent = VIEW_ICONS[view] || '🎯';
  vb.title = `View: ${VIEW_NAMES[view] || view} — tap to change`;
  $('zoomControls').classList.toggle('hidden', !(view === 'aim' || view === 'top'));
  $('freeControls').classList.toggle('hidden', view !== 'free');
}
function hideInGameControls() {
  $('zoomControls').classList.add('hidden');
  $('freeControls').classList.add('hidden');
}
// Show the ✓ button next to the cue ball while I'm placing it (ball-in-hand),
// tracking the ball's projected screen position; hidden otherwise.
function updatePlaceButton() {
  const btn = $('placeConfirm');
  const show = net.inGame && isLive() && gs.interact === PH_PLACING && myTurn();
  btn.classList.toggle('hidden', !show);
  if (!show || !stageCanvas) return;
  const cue = getCueMeshPosition();   // track the ball where it actually rests (legal spot)
  if (!cue) return;
  const rect = stageCanvas.getBoundingClientRect();
  _placeVec.set(cue.x, cue.y, cue.z).project(camera);
  btn.style.left = `${(_placeVec.x * 0.5 + 0.5) * rect.width + 26}px`;
  btn.style.top = `${(-_placeVec.y * 0.5 + 0.5) * rect.height}px`;
}
$('placeConfirm').addEventListener('click', confirmPlace);
// Pocketed numbers to display now: the confirmed baseline plus any ball that has
// visibly dropped into a pocket this instant (so the column updates the moment a
// ball sinks, live or in a replay — before the shot fully resolves).
function pocketedNow(baseline) {
  return [...new Set([...(baseline || []), ...sunkNumbers()])];
}

// ---- Render loop ------------------------------------------------------------
// ONE path. Everything that used to need a separate branch — live play, a shot
// replaying, a reconnect backlog draining, a past shot being reviewed — differs
// only in where the playhead is, so the loop asks that and nothing else.
function loop(now) {
  requestAnimationFrame(loop);
  if (!sceneReady) return;
  if (input) input.tick();
  updatePlaceButton();   // ✓ button follows the cue ball during ball-in-hand

  timeline.tick(now);    // advance the playhead if a shot is on screen

  if (!net.inGame) { clearHud(); hideInGameControls(); render(); return; }

  const past = timeline.current();        // the shot on screen, or null if live
  const cuePos = getCueMeshPosition();

  // What the table is DOING. Watching a shot looks like PH_SHOOTING whatever the
  // game state says, because the game state describes the present and a replay
  // is the past.
  const interact = past ? PH_SHOOTING : gs.interact;

  // Aim only matters live: it is present-tense data, and a recorded shot poses
  // the stick from its own recording (shotPlayer).
  if (!past && interact === PH_AIMING) {
    if (myTurn()) {
      // Enforce cue elevation: raise pitch to clear any ball/rail behind the cue
      // ball along the current aim. Same call the server makes authoritatively
      // inside resolveStrike, so what you see is what will be played.
      if (cuePos) {
        setPitch(legalPitch(getPitch(), {
          cx: cuePos.x, cz: cuePos.z, yaw: getYaw(), strikeY: getStrikeOffset().y,
          obstacles: getObstaclePositions(), railPts: railPoints,
        }));
      }
      maybeSendAim(now);
    } else {
      // Spectating: ease the shown cue toward the streamed target so the
      // opponent's aim and draw-back interpolate smoothly.
      easeOpponentView();
      setYaw(opponentView.yaw); setPitch(opponentView.pitch);
      setStrikeOffset(opponentView.strikeX, opponentView.strikeY); setPullback(opponentView.pullback);
    }
  }

  // Camera. Free (V-cycle) overrides everything. Reviewing keeps the V
  // preference as-is — you chose to look at this. Live, overhead is forced while
  // placing, spectating, or at game-over.
  const forcedTop = !past && (interact === PH_PLACING || interact === PH_OVER || !myTurn());
  const view = camPref === 'free' ? 'free' : (forcedTop ? 'top' : camPref);
  setViewMode(view);
  setCueVisible(interact === PH_AIMING || drawingBack());

  // A reviewed shot anchors the aim camera at the cue ball's STARTING rest
  // position, sighting down the shot line, rather than chasing the ball.
  const anchor = past ? timeline.cueAnchor() : null;
  if (view === 'aim' && anchor) {
    _reviewAnchor.set(anchor.x, anchor.y, anchor.z);
    updateCueAndCamera(_reviewAnchor);
  } else if (cuePos && interact === PH_AIMING && !past) {
    updateCueAndCamera(cuePos);
  } else {
    if (cuePos && (drawingBack() || (past && isCueVisible()))) updateCueStick(cuePos);
    placeCamera();
  }

  // HUD. The pocketed column counts from whatever was already down when the
  // shot on screen began, so balls appear in it as they drop — live or replayed.
  const s = getStrikeOffset();
  drawHud({
    strikeX: s.x, strikeY: s.y,
    power: getPullback() / getMaxPullback(),
    view,
    pocketed: pocketedNow(timeline.pocketedBaseline()),
    ballCount,
    bottomInset: reviewChromeHeight(),   // keep clear of the transport bar
  });
  updateViewUi(view);
  // Don't let the win banner cover a replay.
  $('banner').classList.toggle('show', !past && gs.winner >= 0);

  render();
}

// ---- Deep-link / auto-join (shareable room links; also drives tests) --------
window.__errors = [];
window.addEventListener('error', e => window.__errors.push(String(e.message || e.error)));
window.__net = { socket, state: () => gs, me: () => net };
window.__ballIds = ballIds;   // debug: client-side rendered ball set (ghost detection)
window.__sunk = sunkNumbers;  // debug: balls currently dropped into a pocket
window.__reviewHistory = () => timeline.entries();   // debug: the rack's shot log
window.__reviewBaseline = () => timeline.pocketedBaseline();
// debug: cue stick state — visible, how far drawn back, and whether that's the
// catch-up replay's draw-back lead-in driving it
window.__cue = () => ({ visible: isCueVisible(), pullback: getPullback(), drawingBack: drawingBack() });
window.__camera = () => camera;          // debug: live camera (zoom/dolly checks)
window.__cuePos = getCueMeshPosition;    // debug: cue ball position
// debug: where the playhead is — live, following, and what is queued
window.__replay = () => {
  const st = timeline.state();
  return { playing: !st.live, pending: st.unwatched, live: st.live, following: st.following, slot: st.slot };
};
window.__timeline = () => timeline.state();

const params = new URLSearchParams(location.search);
if (params.get('name')) $('nameInput').value = params.get('name');
if (params.get('game')) $('gameSelect').value = params.get('game');
socket.on('connect', () => {
  // FIRST connect only. The URL params below are a one-shot instruction for
  // opening the page, not something to re-run every time the socket comes back:
  // reconnecting with ?bot in the URL must not silently start a second game.
  // (This was previously masked — reconnects only happened mid-game, where the
  // resume above had already set conn.room and the server ignored the duplicate
  // action. Menu reconnects removed that cover.)
  if (!firstConnect) return;
  firstConnect = false;

  // A reload lands here with the seat token still in sessionStorage: resume the
  // game in progress rather than acting on the URL and starting a fresh one.
  session = loadSession();
  if (session && session.token) {
    net.resuming = true;
    socket.emit('resume', { token: session.token, lastShot: session.shotIndex | 0 });
    return;
  }

  const j = params.get('join');
  if (j) socket.emit('joinRoom', { name: nameVal(), code: j.toUpperCase() });
  else if (params.has('create')) socket.emit('createRoom', { name: nameVal(), game: gameVal() });
  else if (params.has('quick')) socket.emit('quickPlay', { name: nameVal(), game: gameVal() });
  else if (params.has('bot')) { net.bot = true; socket.emit('playBot', { name: nameVal(), game: gameVal(), skill: botSkillVal() }); }
});

// Suppress mobile browser gestures that fight the game: iOS pinch-zoom and
// double-tap / double-click zoom. (touch-action + user-scalable=no cover the
// rest; taps and clicks are unaffected.)
['gesturestart', 'gesturechange', 'gestureend'].forEach(t =>
  document.addEventListener(t, e => e.preventDefault(), { passive: false }));
document.addEventListener('dblclick', e => e.preventDefault());

showMenu();
requestAnimationFrame(loop);
