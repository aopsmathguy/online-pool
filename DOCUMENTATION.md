# Online Pool — Codebase Documentation

A server-authoritative, multiplayer 3D pool game (8-ball and 9-ball) that runs in the
browser. Rendering is Three.js; physics is ammo.js (Bullet). The same physics/rules
code runs headless in Node on the server, which is the single source of truth — clients
only send input and render what the server streams.

- **Play online**: two humans via room codes / quick-play matchmaking.
- **Play vs Computer**: a server-side bot ("ghost-ball" aimer with deliberate
  inaccuracy) fills the second seat.

---

## 1. Quick start

```bash
npm install        # only dependency: ws
npm start          # node server/index.js → http://localhost:8731
```

The Node server hosts **both** the static client and the WebSocket game on port `8731`
(override with `PORT=…`). Open two browser tabs to play against yourself, or press
**vs Computer** for a single-player game.

Client ES modules import `"/lib/three.module.js"` by absolute path, so the client must
always be served with the project root as the web root — which `npm start` does.

### URL parameters (deep links / testing)

| Param | Effect |
|---|---|
| `?name=Alice` | pre-fills the name field |
| `?game=0` / `?game=1` | pre-selects 8-ball / 9-ball |
| `?join=CODE` | auto-joins a room on connect |
| `?create` | auto-creates a room |
| `?quick` | auto-enters quick-play matchmaking |
| `?bot` | auto-starts a game against the computer |

The client also exposes `window.__net = { socket, state(), me() }` and
`window.__errors` for headless/automated testing.

---

## 2. Repository layout

```
index.html            Menu / lobby / game shell + sidebar HUD markup
styles.css            All styling
package.json          npm start = node server/index.js  (type: module)

server/
  index.js            HTTP static server + WebSocket rooms + matchmaking +
                      per-room simulation tick + the bot driver

src/                  Game code. Everything here except main.js and the *.view/
                      scene/cue/input/hud modules is renderer-free and runs on
                      the server too.
  constants.js        Table dimensions, ball radius/mass, friction/restitution
  table.js            Pure table outline generators (rails, felt, pocket centres)
  balldefs.js         Ball colours + solid/stripe/cue styling by number
  physics.js          Ammo bootstrap, world factory, collision groups, stepAndDamp
  geometry.physics.js Ammo collision builders (rail polyline capsules, pocket cups)
  geometry.js         Three.js visual meshes for the same geometry (client-only)
  balls.logic.js      Ball rigid bodies: rack build, teleport, spot, pocket (no Three)
  balls.view.js       Ball meshes/textures keyed by server ball id (no physics)
  clearance.js        Min cue elevation to clear balls/rails behind the cue ball
  sim.js              RoomSim: one authoritative simulation per room
  game.js             Generic two-player match controller (ruleset-agnostic)
  ai.js               Computer opponent (ghost-ball aiming, shot selection)
  scene.js            Three renderer/scene/camera/lights
  cue.js              Cue stick mesh + orbit/top cameras + aim state (yaw/pitch/spin)
  input.js            Pointer-lock mouse/keyboard bindings
  hud.js              Sidebar HUD renderer (from gameState packets)
  main.js             Client entry: networking, render loop, menu wiring
  net/packets.js      Shared packet schemas + phase/lobby/game enums
  rules/
    index.js          Ruleset registry
    eightball.js      8-ball rules (reference ruleset implementation)
    nineball.js       9-ball rules
    util.js           shuffle()

lib/                  Vendored: three.module.js, ammo (browser wasm + node cjs),
                      schemapack.js, socketUtility.js, buffer shim
```

---

## 3. Architecture

```
   BROWSER (per player)                      NODE SERVER
┌──────────────────────────┐          ┌───────────────────────────────┐
│ main.js                  │  input   │ server/index.js               │
│  ├ input.js  (mouse/kb)  │ ───────► │  ├ rooms + matchmaking        │
│  ├ cue.js    (aim state) │ shoot,   │  ├ 60 Hz tick loop            │
│  ├ scene.js  (Three)     │ aim,     │  └ tickBot (vs-Computer)      │
│  ├ balls.view.js (meshes)│ place…   │        │                      │
│  └ hud.js    (sidebar)   │          │  RoomSim (src/sim.js) ── one  │
│                          │ ◄─────── │   per room:                   │
│ renders streamed state,  │  balls,  │   ├ Ammo world (physics.js)   │
│ NO physics, NO rules     │ gameState│   ├ balls (balls.logic.js)    │
└──────────────────────────┘ placing, │   └ createGame (game.js)      │
                             aimState │       └ ruleset (src/rules/)  │
                                      └───────────────────────────────┘
```

Design rules that keep this split clean:

- **`src/` modules are instanced, not singletons.** `RoomSim`, `createGame`,
  `resetRack(world, balls, …)` all take their world/state explicitly so the server can
  run many rooms in one process (a single Ammo runtime hosts many independent
  `btDiscreteDynamicsWorld`s).
- **Shared modules are renderer-free.** Anything imported by `sim.js` must not touch
  Three or the DOM. Visual counterparts live in paired files
  (`balls.logic.js`/`balls.view.js`, `geometry.physics.js`/`geometry.js`).
- **The client is dumb.** It draws the last streamed `balls` frame, renders HUD text
  it receives verbatim, and forwards raw input. Even the cue-elevation floor is
  re-enforced server-side (`applyShoot` clamps pitch with `minPitchForShot`), the
  client version exists only for feel.

### Coordinates & units

SI units (metres, kg, seconds). The table lies in the XZ plane, Y is up:

- `tableW = 2.24` (long axis = X), `tableH = 1.12` (short axis = Z), centred on origin.
- Ball radius `R = 0.028575`, mass `m = 0.170097`.
- Yaw 0 aims toward +X; `dir = (cos yaw, 0, sin yaw)`. Pitch tilts the cue down into
  the ball (impulse gets a −Y component).
- The head string (break placement limit) is `x = −tableW/4`; the foot spot (racking,
  re-spotting) is `x = +tableW/4`.

---

## 4. Physics (`physics.js`, `geometry.physics.js`, `constants.js`)

- `initPhysics()` loads the Ammo runtime once (browser: wasm global; Node: the server
  sets `globalThis.Ammo = require('lib/ammo.server.cjs')` first). `createWorld()`
  builds an independent world per room (24 solver iterations, split impulse).
- **Table construction** (in `RoomSim`): an infinite static plane for the felt, a
  compound capsule polyline for the rail cushions (from `table.js` outline points),
  and six static cylinder cups sunk below each pocket.
- **Pockets have no holes in the felt.** Instead each ball has a collision *mask*
  toggled per tick: when a ball's centre is within `POCKET_OPEN_RADIUS` of a pocket
  centre its felt bit is dropped (`MASK_BALL_OVER_POCKET`) and it falls into the cup.
  See `updatePocketMasks()` in sim.js.
- `stepAndDamp()` steps the world at `FIXED_DT = 4 ms` (250 Hz — far more often than
  anything is sent to clients; accuracy comes from here) and then applies hand-rolled
  felt drag: linear deceleration `mu_felt_linear·g` on horizontal speed and a tapered
  decay on Y-axis (english) spin. Bullet's own rolling/spinning friction is disabled.
- Balls use CCD (swept spheres) so break shots can't tunnel through cushions.
- `body.ptr` is a stable numeric pointer identity in both Ammo builds; the manifold
  scanner relies on `manifold.getBody0().ptr` matching it.

**User indices** (debug labels): 1 = ball, 2 = rail, 3 = felt, 4 = pocket cup.

---

## 5. The simulation (`src/sim.js` — `RoomSim`)

One instance per room; owns the world, the ball list (`balls[0]` is always the cue),
and a `createGame` match controller. Public API used by the server:

| Method | Purpose |
|---|---|
| `newGame(changeGame?)` | reset/re-rack (optionally switch ruleset), then `settleRack()`: steps physics until the ~1 mm rack jitter has settled, squares every ball onto the shared number-up `RACK_QUAT` (constants.js) and zeroes motion — so the layout broadcast is truly at rest and nothing shuffles at the start of the break replay; returns `{game, firstPlayer, layout}` |
| `applyAim(idx, aim)` | accept the active player's aim (relay-only) |
| `applyShoot(idx, params)` | validate & strike the cue ball, then **simulate the whole shot to rest synchronously** (`runShotAndRecord`); returns `{packet, durationMs}` — the keyframe recording for `shotAnim` |
| `applyPlaceMove / applyPlaceConfirm` | ball-in-hand placement; `startPlacement` begins from wherever the cue was left (a scratched cue is clamped from the pocket to the nearest legal felt spot) |
| `ballsFrame / gameStatePacket / placingPacket / startInfo` | wire snapshots |

### Interaction phases

`PH_AIMING (0) → [PH_PLACING (2)] → PH_AIMING …`, `PH_OVER (3)` when a game ends.
Codes live in `net/packets.js` and are shared with the client. `PH_SHOOTING (1)`
only exists transiently inside `runShotAndRecord` (the shot resolves before the
packet leaves the server); the *client* synthesizes it locally while its replay
plays.

### Shot pipeline (`applyShoot`)

1. Reject if not the current player / not aiming / balls still moving.
2. `game.beginShot()` — opens the per-shot event record.
3. Clamp pitch to `minPitchForShot(...)` (authoritative cue-clearance).
4. Build the pitched stick frame (`dir`, `right`, `stickUp`).
5. **Squirt**: side english deflects the launch direction by up to ~4.9°
   (`SQUIRT_MAX_TAN`) away from the english side; spin is still computed on the true
   cue line.
6. Impulse `J = power · SHOT_IMPULSE_PER_M · m` (i.e. launch speed = 8 m/s per metre
   of pullback; max pullback is 0.825 m → max 6.6 m/s).
7. Angular velocity from the off-centre strike: `ω = (contact × dir) · J·SPIN_GAIN/I`,
   with the strike point limited to `MISCUE_LIMIT = 0.5·R` off-centre.

### During the shot (`runShotAndRecord`)

The entire shot is simulated **synchronously** the moment it is taken: a 250 Hz
fixed-step loop runs until every ball rests (capped at `MAX_SHOT_SECONDS`), capturing
a keyframe every `REPLAY_FRAME_DT = 16 ms` (4 substeps exactly, so keyframes land on
step boundaries with uniform spacing) and noting the keyframe index at which each
pocketed ball disappears. Keyframes are **delta-encoded** with positions and rotations
as independent sparse lists: frame 0 carries every ball in both; later frames carry a
ball's `pos` only if it moved (>0.1 mm vs the last transmitted value) and its `rot`
only if it rotated (>~0.11°) — resting balls cost zero bytes, and a ball spinning in
place resends only its quaternion. The recording is returned as the `shotAnim` packet;
by the time it leaves the server the shot is already resolved. Per substep / per
keyframe:

- `scanContacts()` reads Bullet's manifolds each substep and feeds the match
  controller: first ball the cue touched, rail contacts (for rail-after-contact and
  break legality), per-ball rail touches.
- `checkPocketed()` classifies any ball below the felt or outside the table:
  pocketed (in a cup) → removed + recorded; cue → scratch; off-table → **parked**
  (frozen in place, gravity zeroed) and re-spotted at the foot spot once everything
  stops (`respotPending`). The 8-ball pocketed *on the break* is also parked and
  re-spotted rather than ending the game.
- When every ball is at rest: `game.endShot()` resolves the shot via the ruleset,
  then the phase becomes `PH_OVER`, `PH_PLACING` (ball-in-hand), or `PH_AIMING`.

---

## 6. Match control & rules (`src/game.js`, `src/rules/`)

`createGame(rulesetId, balls)` returns a controller bound to its own `match` state:
players, whose turn, phase, ball-in-hand, per-shot event record. Everything
game-specific is delegated to a pluggable **ruleset**:

```js
{
  meta: { id, name },
  rack(ctx)             -> [ballSpec…]           // ctx = { tableW, tableH }
  init(match)                                    // set opening phase/message
  snapshot(match)       -> any                   // pre-shot state (legality inputs)
  resolve(shot, match)  -> decision              // judge the finished shot
  hud(match)            -> { chips, status }     // sidebar strings
}
// decision: { gameOver, winner, foul, reason, continues, ballInHand, message }
```

The per-shot record (`match.shot`) accumulates: `firstHit`, `railAfterContact`,
`railedBalls`, `pocketed`, `cueScratch`, `ballsOffTable`, `isBreak`, and the ruleset's
pre-shot `snapshot`. `endShot()` applies the decision: game over, turn pass on
foul/no-continue, ball-in-hand on fouls.

- **eightball.js** — WPA-style casual subset: open table after the break, group
  assignment on first legal pocket, must-hit-own-group, rail-after-contact, break
  legality (pocket or 4+ balls to a rail), 8-ball win/loss conditions. Shots are not
  "called". The rack enforces the 8 in the centre and one ball of each group in the
  back corners. Exports `groupOf(n)` (used by the bot too).
- **nineball.js** — rotation play (lowest ball first), any pocket on a legal shot
  continues, 9 on a legal shot wins, 9 on a foul loses (no re-spot machinery).
- **Adding a game**: write a module exporting that object, register it in
  `rules/index.js`, and (for the menu) add an option + byte mapping in
  `net/packets.js` (`gameIdFromByte`/`gameByteFromId`) and `index.html`.

Match state that rules use lives on `match`: `players[i].group` (8-ball),
`match.phase` (`'break' | 'open' | 'play' | 'over'`), and `match.balls` — the room's
**live** ball array, so "balls remaining" checks are always current.

---

## 7. Networking

### Transport (`lib/socketUtility.js` + `lib/schemapack.js`)

A tiny binary event bus over WebSocket. Both sides construct their codec from the
**same** `packetSchemas` object (`src/net/packets.js`); event names are sorted
alphabetically to assign byte codes, so client and server always agree as long as they
share that file. Packets are schemapack-encoded binary (first byte = event code).
Built-in ping/pong keeps connections alive. The browser gets a small `buffer` shim via
an import map in `index.html`.

### Packet reference (`src/net/packets.js`)

Client → server:

| Event | Payload | Notes |
|---|---|---|
| `createRoom` | `{name, game}` | private room, share the 4-char code |
| `joinRoom` | `{name, code}` | |
| `quickPlay` | `{name, game}` | matchmaking pool, same-game only |
| `playBot` | `{name, game}` | single-player vs the computer, starts immediately |
| `botSkill` | `{value}` | bot difficulty 0–100, live-adjustable (bot rooms only) |
| `newGame` | `{game}` | rematch; `255` = keep current ruleset |
| `aim` | `{yaw, pitch, strikeX, strikeY, pullback}` | ~20 Hz while aiming, relayed to opponent |
| `shoot` | `{yaw, pitch, strikeX, strikeY, power}` | `power` = pullback metres (≤ 0.825) |
| `placeMove` / `placeConfirm` | `{x, z}` / `{}` | ball-in-hand |
| `leaveRoom` | `{}` | |

Server → client:

| Event | Payload | Notes |
|---|---|---|
| `roomJoined` | `{code, playerIndex, game, host}` | `host` shows the waiting lobby |
| `lobby` | `{state, players}` | `LOBBY_WAITING/READY` |
| `startGame` | `{game, firstPlayer, layout}` | layout: `{id, number, x, z}`; number 255 = cue |
| `shotAnim` | `{dtMs, frames:[{pos:[{id, x,y,z}], rot:[{id, qx..qw}]}], removals:[{id, frame}]}` | one whole pre-simulated shot, delta-encoded (only changed pos/rot per frame); client expands + replays it |
| `balls` | `{items:[{id, x,y,z, qx..qw}]}` | final resting frame after each shot |
| `gameState` | `{interact, current, ballInHand, winner, message, status, chips, pocketed}` | phase + HUD |
| `placing` | `{active, player, behindLine, x, z}` | live cue-ball placement |
| `aimState` | same as `aim` | opponent's (or the bot's) cue for spectating |
| `removeBall` | `{id}` | pocketed |
| `opponentLeft` / `errorMsg` | | |

### Rooms & matchmaking (`server/index.js`)

- `room = { code, rulesetId, conns[], sim, public, bot? }`. Codes are 4 chars from an
  unambiguous alphabet.
- **Quick play** matches only another waiting quick-play seeker for the *same* game;
  otherwise it opens a new public room. Private (code) rooms are never matched.
- Bot rooms are private, never matched, and refuse `joinRoom`.
- **Pre-simulated shots** (`performShot` in server/index.js): on `shoot`, the sim runs
  the whole shot to rest synchronously (250 Hz substeps) and the server sends, in one
  burst: `shotAnim` (the full keyframe recording + pocket removal frames), the final
  resting `balls` frame, `gameState`, and `placing` if ball-in-hand. `room.replayUntil`
  (recording duration + margin) makes the server reject the next `shoot` — and hold
  the bot's next decision — until everyone has finished watching. Nothing is streamed
  mid-shot; the 60 Hz tick only paces the bot.
- **Client-side replay** (`beginReplay`/`tickReplay` in main.js): `beginReplay` first
  expands the delta-encoded frames back to full per-ball frames (carrying each ball's
  last-known position/rotation forward), then the recording plays
  back at wall-clock rate, interpolating between the two keyframes bracketing the
  playhead (position lerp + quaternion slerp, `applyBallsFrameLerp`) and removing
  pocketed balls at their recorded frames — perfectly smooth at any refresh rate,
  immune to mid-shot network hiccups. Packets arriving during a replay
  (`gameState`/`placing`/`balls`/`removeBall`) are queued (`afterReplay`) and applied
  when the replay ends, so HUD messages and ball-in-hand never spoil the outcome
  early; while replaying, the client treats the phase as `PH_SHOOTING` (spectator
  camera, cue hidden, input gated).
- Disconnection tears the room down and notifies the opponent.

---

## 8. The computer opponent (`src/ai.js` + `tickBot` in `server/index.js`)

Selected from the menu with **vs Computer** (`playBot` packet). The human is always
player 0 (and breaks); the bot fills seat 1 — there is no fake socket, the server
drives the sim directly with the same `applyShoot`/`applyPlace*` calls a client would
trigger, so all rules/physics apply to it identically.

### Shot selection — "any open shot"

`computeBotShot(sim)` aims at the **perfect ghost ball** with some inaccuracy:

1. **Legal targets**: 9-ball → the lowest ball; 8-ball → own group (the 8 once the
   group is cleared), or everything but the 8 while the table is open.
2. **Pot lines** (`potLines`): every (target, pocket) pair where
   - the aim point is the **pocket opening**, not the cup: the midpoint of the two
     rail-polyline points that define the mouth (corners: `corner_mouth/(2√2)`
     inside each rail; sides: on the rail line at x = 0),
   - the pocket-approach angle is acceptable (side pockets refuse shallow along-rail
     approaches, `minDot = 0.35`; corners accept almost anything), and
   - the target can reach the pocket through a corridor one ball wide with no other
     ball in it (`pathClear`, point-to-segment distance < `2R·0.99`).
   Each line carries the **ghost ball** centre: one ball diameter behind the target
   along the target→pocket direction.
3. **Open shots** (`openShots`): keep lines where the *cue* ball can reach the ghost
   position through an unobstructed corridor and the cut is makeable
   (`cos > 0.12`, ~83°). The target ball itself stays in the obstacle list — on an
   impossible >90° cut the corridor clips it, which rejects the shot for free.
4. **Pick the easiest**: each open shot is scored with the difficulty measure

   ```
   d₂ · √(d₁² − 4R²·sin²θ₂) / (2R·cosθ₂)
   ```

   where `d₁` = cue→object-ball distance, `d₂` = object-ball→pocket distance and
   `θ₂` = the acute angle between the cue→ball and ball→pocket lines (it grows with
   both distances and blows up toward a 90° cut). The bot takes the minimum, aims
   exactly at that shot's ghost ball, then perturbs the yaw by a
   triangular-distributed random error — the **difficulty slider** (shown inside the
   Computer's HUD chip, live-adjustable via the `botSkill` packet) sets that error's
   half-width, interpolated exponentially from ±0.07 rad (~4°, difficulty 0) down to
   ±0.002 rad (~0.11°, difficulty 100). Inaccuracy is the *only* thing the slider
   changes.
5. **Power** works backward from the pocket: arrive briskly
   (`v = √(2·a·d)·POCKET_SPEED_MARGIN`, `a` = felt drag), divide by the cut cosine
   (thin cuts transfer less speed), add the drag over the cue's run-up, convert to
   pullback metres via `SHOT_IMPULSE_PER_M`, floor at `MIN_POWER` so nothing is ever
   dribbled in.
6. **Anti-scratch draw** — the only spin the bot ever uses: on a near-straight pot
   (`cutCos > 0.9`, pocket dead ahead) the cue would follow the object ball in, so
   it strikes below centre (`strikeY = −0.5`) to stun/draw back at contact. The same
   draw is applied to scratch-risky direct-hit safeties. Still physically legal:
   the clearance floor (next point) is computed *with* this strike offset, since a
   lower strike point needs more cue elevation.
7. **Legal cue elevation**: the chosen shot is passed through `minPitchForShot`
   (`clearance.js`) with the live ball/rail data, so the bot jacks its cue up over
   any ball or cushion behind the cue ball exactly like the server enforces for
   humans — and compensates the power for the reduced horizontal launch component.
   The plan, the physical shot, and the streamed `aimState` therefore all agree.
8. **Safeties** (no open shot), in order of preference:
   1. a direct hit on a legal ball whose follow line avoids the pockets — the aim
      is *scratch-risky* if the cue→ball line extended past the target runs into a
      pocket within ~0.9 m (`scratchRisky`). The aim comes from `visibleAim`, which
      accounts for the cue ball's radius: a centre-line offset `o` contacts while
      `|o| < 2R`, landing on the target's surface at `ℓ = o/2`. Blocker shadows
      (width 2R scaled by d/s — nearer blockers cast wider shadows) are subtracted
      from the ±R silhouette; with `m` the middle of the widest visible stretch, the
      aim line is pushed one extra ball radius past it, away from the shadow:
      `o = m + R·sign(m)`. E.g. 4/5 of the ball visible → aim (1/5)R + R = (6/5)R
      off the centre line; fully visible → dead centre. Falls back to `o = 2m`
      (contact exactly at the visible middle) if that aim is itself shadowed;
   2. a **one-rail kick** when every legal ball is blocked: bounce the cue off a
      cushion into the target. The bounce point comes from a calibrated
      non-mirror model — the reflection line is where the ball *centre* turns
      (≈0.033 m inside the rail plane, from the rod cushion's geometry) and the
      rebound is compressed, `tanθ_out ≈ 0.85·tanθ_in` (`E_RAIL_EFF`, measured by
      sweeping bounce points in-sim). Kick legs demand a wider clear corridor
      (`KICK_CLEAR = 1.35×`) and the bounce point must stay off pocket mouths;
   3. the least-bad scratch-risky direct hit, played gently;
   4. a hopeful poke at the nearest legal ball.
6. **Fallbacks**: on the break, smash the nearest legal ball at full power; with
   nothing open, poke the nearest (preferably reachable) legal ball at low power as a
   safety.

`computeBotPlacement(sim)` (ball-in-hand) tries straight-in lineups behind each pot
line's ghost ball at a few distances, plus up to 64 random in-bounds spots, and of the
legal candidates (in `placeBounds`, not touching a ball) keeps the one whose easiest
open shot has the lowest difficulty; returning `null` keeps the sim's default spot.

### Bot driver (`tickBot`)

Runs every tick for bot rooms. When it becomes the bot's turn it decides **once**,
then acts on a human-ish schedule so the opponent can watch:

- Aiming: broadcasts `aimState` immediately (the human sees the cue line up), waits
  `BOT_SHOT_DELAY = 1.6 s`, streaming an increasing `pullback` over the last 0.7 s
  (~20 Hz) so the cue visibly draws back, then `applyShoot`.
- Placing: moves the cue ball right away (`placing` broadcast), confirms after 0.9 s.
- The plan is dropped whenever it's not the bot's turn or a new game starts, so stale
  decisions can never fire.

Tuning knobs, all in `src/ai.js`: `JITTER_EASIEST/HARDEST_RAD` (the difficulty
slider's range), `MIN_CUT_COS` (shot-selection bravery), `POCKET_SPEED_MARGIN` /
`MIN_POWER` (pace), `CLEAR_FACTOR` (how tight a gap counts as "open"), and the delays
in `server/index.js`.

In self-play testing (8-ball) the bot pots on ~33% of its shots at difficulty 0,
~51% at 50, and ~59% at 100 — with fouls falling as difficulty rises — and every
game finishes.

---

## 9. The client (`src/main.js` and friends)

- **main.js** — owns the socket, menu/lobby/game visibility, and the
  `requestAnimationFrame` loop. Tracks `gs` (last `gameState`) and `net.myIndex`;
  `myTurn()` gates all input. On my aiming turn it enforces the *local* cue-clearance
  pitch floor, streams `aim` at 20 Hz, and sends `shoot` on release. When it's not my
  turn it drives cue.js from the streamed `opponentAim` and switches to the overhead
  camera. Ball-in-hand moves are sent as deltas scaled by `PLACE_SCALE` and echoed
  back via `placing`.
- **scene.js** — renderer, camera, three shadow-casting directional lights; resizes
  with the canvas.
- **cue.js** — all aim state (yaw/pitch/strike/pullback) plus the stick mesh and both
  cameras. The orbit camera anchors to the cue ball's position at aim time and offsets
  its sightline to stay above/beside the stick even with english or an elevated cue;
  `top` mode is a straight-down view used for placing/spectating (toggle with **V**,
  dolly with the scroll wheel).
- **input.js** — pointer-lock mouse controls: move = aim (yaw/pitch), ALT+move = set
  the strike point (spin), hold LMB = charge (2 m/s pullback), release = shoot,
  X = reset spin, V = top view. In placing mode, motion moves the cue ball and click
  confirms.
- **balls.view.js** — one textured sphere per server ball id (canvas-generated
  numbers/stripes, two number faces per ball, red tracking dot); applies streamed
  transforms verbatim; removed on `removeBall`. Rack meshes are built with
  `RACK_QUAT` (numbers up) — this must equal the server's racked body rotation,
  since no frames stream at rest and a mismatch snap-rotates every ball on the
  break's first replay frame.
- **hud.js** — writes the server-provided chips/status/message strings into the
  sidebar and shows the game-over banner. No rule knowledge client-side.
- **clearance.js** — shared pure math: the smallest cue pitch that clears every
  ball/cushion behind the cue ball (stick modelled as a cylinder pivoting at the tip).
  Used for feel on the client and enforcement on the server.

---

## 10. Testing & headless verification

- **Pure logic** (rules, AI, physics) can be exercised directly in Node — no browser:
  ```js
  globalThis.Ammo = require('./lib/ammo.server.cjs');
  await (await import('./src/physics.js')).initPhysics();
  const { RoomSim } = await import('./src/sim.js');
  // drive applyShoot / advance in a loop; see also src/ai.js self-play
  ```
  `applyShoot` simulates the whole shot synchronously — when it returns, the shot is
  already resolved (`phase()` is the post-shot phase) and its return value is the
  keyframe recording.
- **Wire-level**: Node's `ws` client + `lib/socketUtility.js` `SocketClient` +
  `src/net/packets.js` speaks the real protocol (set `ws.binaryType =
  'arraybuffer'`).
- **Rendering**: headless Chrome needs software GL:
  `--headless=new --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`,
  plus `--remote-debugging-port` for CDP-driven input/screenshots. The `?bot` /
  `?quick` / `?join` URL params and `window.__net` exist for exactly this.

---

## 11. Common extension points

| Want to… | Touch |
|---|---|
| Add a ruleset (e.g. straight pool) | `src/rules/<game>.js`, register in `rules/index.js`, byte mapping in `net/packets.js`, menu option in `index.html` |
| Change table size/pockets | `constants.js` (+ pocket detection radii in `sim.js`) |
| Tune shot feel | `SHOT_IMPULSE_PER_M`, `SPIN_GAIN`, `SQUIRT_MAX_TAN` in `sim.js`; felt drag in `constants.js`/`physics.js` |
| Make the bot stronger/weaker | difficulty slider in-game; range via `JITTER_EASIEST/HARDEST_RAD`, policy in `src/ai.js` |
| Add a packet | `src/net/packets.js` (shared), handlers in `server/index.js` + `src/main.js` |
| Change break/placement rules | `startPlacement` bounds in `sim.js`, ruleset `init`/`resolve` |
