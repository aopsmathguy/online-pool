// src/constants.js
export const tableW = 2.24, tableH = 1.12;
export const R = 0.028575, m = 0.170097, g = 9.81;

export const e_ball  = Math.sqrt(0.95);
export const e_rail  = 0.8 / e_ball;
export const e_table = 0.6 / e_ball;
export const e_pocket = 0/e_ball;

export const mu_ball   = Math.sqrt(0.05);
export const mu_wall   = 0.1 / mu_ball;
export const mu_ground = 0.2 / mu_ball;
export const mu_pocket = 0.3/mu_ball;

export const rollingFric = 0.000;
export const spinningFric = 0.000;

export const mu_felt_linear = 0.01;
export const spin_decel_rad_s2 = 10;

export const wireY = 0.034925;
export const rodR  = 0.005;
export const inset = 0.05;

export const mid_mouth = 0.132;
export const mid_throat = 0.112;
export const corner_mouth = 0.117;
export const corner_throat = 0.112;

// Physics substep (250 Hz). Shots are simulated synchronously on the server
// (see sim.js runShotAndRecord); this balances accuracy against how long a
// shot blocks the event loop. Replay keyframes are sampled every 4 substeps.
export const FIXED_DT = 0.004;
export const TEX_V_STRETCH = 2;

// Shared "number-up" ball orientation: the two numbered faces sit at local ±Z
// on the ball texture (u = 0.25/0.75 on the equator), so −90° about X points
// one number straight up. Server bodies are racked/spotted with THIS rotation
// and the client builds rack meshes with it too — they must match exactly,
// because no frames are streamed while the table is at rest, so any mismatch
// snap-rotates every ball on the first frame of the next shot's replay.
export const RACK_QUAT = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };

// Synthetic cue draw-back + strike prepended to every shot replay (client-side
// shotPlayer.js). The recording itself starts at the moment of contact, so this
// lead-in is what makes the stick visible before the balls move. The SERVER
// needs it too: replayUntil gates the next shot on how long everyone is still
// watching, and that window now includes this lead-in. Shared so the two can
// never drift apart.
export const SHOT_STRIKE_MS = 520;
