// Straight-in pot aligned with the corner pocket: without spin the cue follows
// the 1-ball in (scratch); the bot should add draw and avoid it.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.Ammo = require('/Users/min/MIT/pool/lib/ammo.server.cjs');
const { initPhysics } = await import('/Users/min/MIT/pool/src/server/physics.js');
await initPhysics();
const { RoomSim, PH_AIMING } = await import('/Users/min/MIT/pool/src/server/sim.js');
const { computeBotShot } = await import('/Users/min/MIT/pool/src/server/ai.js');
const { setBallPosition } = await import('/Users/min/MIT/pool/src/server/balls.logic.js');

// pocket (1.135, -0.575); line unit dir ≈ (0.655, -0.4525)/0.796
const P = { x: 1.135, z: -0.575 };
const T = { x: 0.635, z: -0.288 };
const d = Math.hypot(P.x - T.x, P.z - T.z);
const ux = (P.x - T.x) / d, uz = (P.z - T.z) / d;
const C = { x: T.x - ux * 0.45, z: T.z - uz * 0.45 };   // cue 0.45m behind, dead straight

function setup() {
  const sim = new RoomSim('9ball');
  sim.newGame();
  sim.game.getState().phase = 'play';
  sim.interact = PH_AIMING;
  const byNum = n => sim.balls.find(b => b.number === n);
  let i = 0;
  for (const b of sim.balls.slice(1)) {
    if (b.number === 1) continue;
    setBallPosition(sim.world, b, -1.0 + 0.055 * (i % 4), 0.45 - 0.055 * ((i / 4) | 0));
    i++;
  }
  setBallPosition(sim.world, byNum(1), T.x, T.z);
  setBallPosition(sim.world, sim.balls[0], C.x, C.z);
  return sim;
}
function run(sim, params) {
  const before = sim.balls.length;
  sim.applyShoot(sim.currentPlayer(), params);
  let guard = 0;
  while (sim.phase() === 1 && guard++ < 60 * 120) sim.advance(1 / 60);
  const s = sim.game.getState();
  return { potted: before - sim.balls.length, scratched: /Scratch/.test(s.message), msg: s.message };
}

// --- bot shot (should include draw) ---
let sim = setup();
const shot = computeBotShot(sim, 1.0);
console.log(`bot shot: yaw=${shot.yaw.toFixed(3)} strikeY=${shot.strikeY} power=${shot.power.toFixed(2)} pitch=${shot.pitch.toFixed(3)}`);
console.log(shot.strikeY < -0.2 ? 'draw applied ✓' : 'NO draw ✗');
const r1 = run(sim, shot);
console.log(`bot result: potted=${r1.potted} scratched=${r1.scratched} :: "${r1.msg}"`);

// --- control: same shot but no spin ---
sim = setup();
const r2 = run(sim, { ...shot, strikeY: 0 });
console.log(`control (no spin): potted=${r2.potted} scratched=${r2.scratched} :: "${r2.msg}"`);

console.log(r1.potted >= 1 && !r1.scratched ? 'PASS: pots without scratching' : 'FAIL');
console.log(r2.scratched ? '(control confirms the scratch threat ✓)' : '(control did not scratch — threat unconfirmed)');
process.exit(0);
