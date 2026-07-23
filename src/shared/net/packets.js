// src/net/packets.js — shared packet schemas (schemapack format), imported by
// BOTH the client and the server so event codes line up. SocketConfig sorts
// event names alphabetically to assign codes, so the object just has to match.
//
// Types: 'uint8' 'int8' 'uint16' 'int32' 'float32' 'string' 'boolean', arrays as
// [schema], nested objects as {...}. `number:255` in a ball spec means the cue.

// These three describe the state of a room at a moment in time. They are sent
// standalone (a new rack, a placement move) AND nested inside shotAnim.post, so
// they are defined once and referenced in both places — the shapes cannot drift.
const GAME_STATE = {
  interact: 'uint8', current: 'uint8', ballInHand: 'boolean', winner: 'int8',
  message: 'string', status: 'string',
  chips: [ { text: 'string', active: 'boolean' } ], pocketed: [ 'uint8' ],
};
// The AUTHORITATIVE ball set, not just a position correction: these items are
// exactly the balls that exist. The client reconciles its rack to match
// (syncRack) — creating any it is missing and deleting any it has spare — which
// is why `number` rides along (255 = cue) and why a ghost ball cannot survive a
// shot.
const BALLS = {
  items: [ { id: 'uint8', number: 'uint8',
             x: 'float32', y: 'float32', z: 'float32',
             qx: 'float32', qy: 'float32', qz: 'float32', qw: 'float32' } ],
};
const PLACING = { active: 'boolean', player: 'uint8', behindLine: 'boolean', x: 'float32', z: 'float32' };

export const packetSchemas = {
  // ---- Client → Server ----
  createRoom:   { name: 'string', game: 'uint8' },
  joinRoom:     { name: 'string', code: 'string' },
  quickPlay:    { name: 'string', game: 'uint8' },
  playBot:      { name: 'string', game: 'uint8', skill: 'uint8' },   // single-player vs the computer (skill 0-100)
  botSkill:     { value: 'uint8' },                  // bot difficulty 0-100 (live-adjustable)
  // Spectate the demo table — two computer players at full difficulty, playing
  // forever. The menu renders it as its background. A watcher holds no seat: it
  // receives the room's broadcasts (startGame / balls / gameState / shotAnim /
  // aimState, exactly as a player does) and can send nothing that touches the
  // game. `stopWatch` detaches; so does entering any real room.
  watchDemo:    {},
  stopWatch:    {},
  leaveRoom:    {},
  newGame:      { game: 'uint8' },                 // 255 = keep current ruleset
  aim:          { yaw: 'float32', pitch: 'float32', strikeX: 'float32', strikeY: 'float32', pullback: 'float32' },
  shoot:        { yaw: 'float32', pitch: 'float32', strikeX: 'float32', strikeY: 'float32', power: 'float32' },
  placeMove:    { x: 'float32', z: 'float32' },
  placeConfirm: {},
  // Reclaim a seat after a drop/reload. `token` is the seat token the server
  // issued in roomJoined (kept in sessionStorage); `lastShot` is the index of
  // the next shotAnim this client still needs, so the server can replay
  // everything it missed while away.
  resume:       { token: 'string', lastShot: 'uint16' },
  // Fetch one past shot's full recording, by its index in the current rack.
  // Sent when the player opens a shot in the review list that they watched
  // before dropping — see shotHistory.
  requestShot:  { index: 'uint16' },

  // ---- Server → Client ----
  // `token` identifies this SEAT (not the socket) for the lifetime of the room;
  // the client stores it and sends it back in `resume` after a drop/reload.
  // `bot` says the other seat is the computer — a resuming client has no other
  // way to know, and needs it for the difficulty slider.
  roomJoined:   { code: 'string', playerIndex: 'uint8', game: 'uint8', host: 'boolean', token: 'string', bot: 'boolean' },
  lobby:        { state: 'uint8', players: [ { name: 'string' } ] },
  startGame:    { game: 'uint8', firstPlayer: 'uint8',
                  layout: [ { id: 'uint8', number: 'uint8', x: 'float32', z: 'float32' } ] },
  balls:        BALLS,
  // One whole shot, pre-simulated server-side: keyframes at dtMs intervals
  // from strike to rest, plus which balls vanish (pocketed) at which frame.
  // Frames are DELTA-encoded, positions and rotations independently: frame 0
  // carries every ball in both lists; a later frame carries a ball's `pos`
  // entry only if it moved since the last frame that carried one, and its
  // `rot` entry only if it rotated — a resting ball costs nothing, a ball
  // spinning in place resends only its quaternion. The client expands back to
  // full frames (beginReplay) and replays smoothly with interpolation.
  // `shot` carries the cue parameters the strike was taken with (final pitch
  // after the elevation floor, and pullback = power) so the replay can render
  // the cue stick drawing back and thrusting into the ball before the recording.
  // `index` is this shot's position in the current rack (reset to 0 on each new
  // game). The client remembers the last one it finished watching so a resume
  // can ask for everything after it.
  //
  // A shot is SELF-CONTAINED: it carries the state of the table before it (as
  // frame 0) and the state after it (`post`). Post-shot state used to be sent
  // as separate balls/gameState/placing packets immediately after this one,
  // while the client was still watching — so the client had to queue them and
  // apply them when the replay ended, which made a `gameState` packet mean
  // different things depending on whether a reconnect backlog was draining.
  // Bundling them makes playback a pure function of one packet: apply `post`
  // when the recording finishes, and there is nothing to defer or reorder.
  shotAnim:     { index: 'uint16', dtMs: 'float32',
                  shot: { yaw: 'float32', pitch: 'float32', strikeX: 'float32', strikeY: 'float32', pullback: 'float32' },
                  frames: [ { pos: [ { id: 'uint8', x: 'float32', y: 'float32', z: 'float32' } ],
                              rot: [ { id: 'uint8', qx: 'float32', qy: 'float32', qz: 'float32', qw: 'float32' } ] } ],
                  // Which balls were pocketed, and on which frame. Metadata only
                  // — playback never deletes meshes (a sunk ball just rests in
                  // the cup); `post.balls` decides what exists. Used for the
                  // review player's "sank 3, 7" labels.
                  removals: [ { id: 'uint8', frame: 'uint16' } ],
                  // Who took it, and what was already pocketed when they did.
                  // Carried on the packet rather than read off the client's live
                  // state, because a shot replayed into the review list on
                  // resume has no matching live state to read — and because it
                  // removes the live path's reliance on `gs` still holding the
                  // PRE-shot value at the moment playback starts.
                  shooter: 'string',
                  pocketedBefore: [ 'uint8' ],
                  // TRUE = this shot is being sent only to rebuild the review
                  // list after a reconnect; the client files it and does NOT
                  // play it back. The player already watched it before dropping.
                  history: 'boolean',
                  // `placing.active` is false unless the shot ended in ball-in-hand.
                  post: { state: GAME_STATE, balls: BALLS, placing: PLACING } },
  // The rack's shot list WITHOUT the recordings — everything the review
  // dropdown renders (who shot, what they sank) and nothing else. Sent on
  // resume to rebuild the list, because re-entering the rack clears it.
  //
  // Recordings are far too big to push speculatively: ~83 KB encoded on
  // average and up to 827 KB for a break, so a full rack is over a megabyte —
  // ten seconds at 1 Mbps, on the flaky link that just dropped you. The client
  // asks for one (requestShot) only when the player actually opens it.
  shotHistory:  { shots: [ { index: 'uint16', shooter: 'string',
                             pocketedBefore: [ 'uint8' ],
                             removals: [ { id: 'uint8', frame: 'uint16' } ] } ] },
  gameState:    GAME_STATE,
  placing:      PLACING,
  aimState:     { yaw: 'float32', pitch: 'float32', strikeX: 'float32', strikeY: 'float32', pullback: 'float32' },
  // The opponent dropped (connected:false, with the seconds left on their
  // reconnect grace) or came back (connected:true). Distinct from opponentLeft,
  // which is final.
  opponentState:{ connected: 'boolean', secondsLeft: 'uint8' },
  opponentLeft: {},
  errorMsg:     { message: 'string' },
};

// Interaction phase codes (gameState.interact / placing).
export const PH_AIMING = 0, PH_SHOOTING = 1, PH_PLACING = 2, PH_OVER = 3;

// Lobby state codes (lobby.state).
export const LOBBY_WAITING = 0;   // waiting for an opponent
export const LOBBY_READY   = 1;   // both present (game about to start)

// game byte for menu selection.
export const GAME_8BALL = 0, GAME_9BALL = 1;
export const gameIdFromByte = (b) => (b === GAME_9BALL ? '9ball' : '8ball');
export const gameByteFromId = (id) => (id === '9ball' ? GAME_9BALL : GAME_8BALL);
