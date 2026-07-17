// src/net/packets.js — shared packet schemas (schemapack format), imported by
// BOTH the client and the server so event codes line up. SocketConfig sorts
// event names alphabetically to assign codes, so the object just has to match.
//
// Types: 'uint8' 'int8' 'uint16' 'int32' 'float32' 'string' 'boolean', arrays as
// [schema], nested objects as {...}. `number:255` in a ball spec means the cue.
export const packetSchemas = {
  // ---- Client → Server ----
  createRoom:   { name: 'string', game: 'uint8' },
  joinRoom:     { name: 'string', code: 'string' },
  quickPlay:    { name: 'string', game: 'uint8' },
  playBot:      { name: 'string', game: 'uint8', skill: 'uint8' },   // single-player vs the computer (skill 0-100)
  botSkill:     { value: 'uint8' },                  // bot difficulty 0-100 (live-adjustable)
  leaveRoom:    {},
  newGame:      { game: 'uint8' },                 // 255 = keep current ruleset
  aim:          { yaw: 'float32', pitch: 'float32', strikeX: 'float32', strikeY: 'float32', pullback: 'float32' },
  shoot:        { yaw: 'float32', pitch: 'float32', strikeX: 'float32', strikeY: 'float32', power: 'float32' },
  placeMove:    { x: 'float32', z: 'float32' },
  placeConfirm: {},

  // ---- Server → Client ----
  roomJoined:   { code: 'string', playerIndex: 'uint8', game: 'uint8', host: 'boolean' },
  lobby:        { state: 'uint8', players: [ { name: 'string' } ] },
  startGame:    { game: 'uint8', firstPlayer: 'uint8',
                  layout: [ { id: 'uint8', number: 'uint8', x: 'float32', z: 'float32' } ] },
  balls:        { items: [ { id: 'uint8', x: 'float32', y: 'float32', z: 'float32',
                             qx: 'float32', qy: 'float32', qz: 'float32', qw: 'float32' } ] },
  // One whole shot, pre-simulated server-side: keyframes at dtMs intervals
  // from strike to rest, plus which balls vanish (pocketed) at which frame.
  // Frames are DELTA-encoded, positions and rotations independently: frame 0
  // carries every ball in both lists; a later frame carries a ball's `pos`
  // entry only if it moved since the last frame that carried one, and its
  // `rot` entry only if it rotated — a resting ball costs nothing, a ball
  // spinning in place resends only its quaternion. The client expands back to
  // full frames (beginReplay) and replays smoothly with interpolation.
  shotAnim:     { dtMs: 'float32',
                  frames: [ { pos: [ { id: 'uint8', x: 'float32', y: 'float32', z: 'float32' } ],
                              rot: [ { id: 'uint8', qx: 'float32', qy: 'float32', qz: 'float32', qw: 'float32' } ] } ],
                  removals: [ { id: 'uint8', frame: 'uint16' } ] },
  gameState:    { interact: 'uint8', current: 'uint8', ballInHand: 'boolean', winner: 'int8',
                  message: 'string', status: 'string',
                  chips: [ { text: 'string', active: 'boolean' } ], pocketed: [ 'uint8' ] },
  placing:      { active: 'boolean', player: 'uint8', behindLine: 'boolean', x: 'float32', z: 'float32' },
  aimState:     { yaw: 'float32', pitch: 'float32', strikeX: 'float32', strikeY: 'float32', pullback: 'float32' },
  removeBall:   { id: 'uint8' },
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
