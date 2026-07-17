import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.Ammo = require('/Users/min/MIT/pool/lib/ammo.server.cjs');
const { initPhysics } = await import('/Users/min/MIT/pool/src/physics.js');
await initPhysics();
const { RoomSim, PH_AIMING } = await import('/Users/min/MIT/pool/src/sim.js');
const { computeBotShot } = await import('/Users/min/MIT/pool/src/ai.js');
const { setBallPosition } = await import('/Users/min/MIT/pool/src/balls.logic.js');

const P = { x: 1.135, z: -0.575 };
const ux = 0.655 / 0.7962, uz = -0.4525 / 0.7962;
function geom(dPocket, dCue) {
  const T = { x: P.x - ux * dPocket, z: P.z - uz * dPocket };
  const C = { x: T.x - ux * dCue, z: T.z - uz * dCue };
  if (Math.abs(C.z) > 0.52 || Math.abs(C.x) > 1.08) throw new Error('cue off table');
  return { T, C };
}
function setup(g) {
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
  setBallPosition(sim.world, byNum(1), g.T.x, g.T.z);
  setBallPosition(sim.world, sim.balls[0], g.C.x, g.C.z);
  return sim;
}
function run(sim, params) {
  const before = sim.balls.length;
  sim.applyShoot(sim.currentPlayer(), params);
  let guard = 0;
  while (sim.phase() === 1 && guard++ < 60 * 120) sim.advance(1 / 60);
  return { potted: before - sim.balls.length, scratched: /Scratch/.test(sim.game.getState().message) };
}

for (const [dP, dC] of [[0.45, 0.45], [0.8, 0.5], [1.2, 0.6], [0.9, 0.9], [1.4, 0.5]]) {
  const g = geom(dP, dC);
  let sim = setup(g);
  const shot = computeBotShot(sim, 1.0);
  const rBot = run(sim, shot);
  sim = setup(g);
  const rCtl = run(sim, { ...shot, strikeY: 0 });
  sim = setup(g);
  const rHot = run(sim, { ...shot, strikeY: 0, power: 0.4 });   // hard, no spin
  sim = setup(g);
  const rHotD = run(sim, { ...shot, power: 0.4 });              // hard, with the bot's draw
  console.log(`dP=${dP} dC=${dC} pow=${shot.power.toFixed(2)} drawY=${shot.strikeY} | bot: ${rBot.potted}/${rBot.scratched ? 'SCR' : 'ok'} | noSpin: ${rCtl.potted}/${rCtl.scratched ? 'SCR' : 'ok'} | hard-noSpin: ${rHot.potted}/${rHot.scratched ? 'SCR' : 'ok'} | hard-draw: ${rHotD.potted}/${rHotD.scratched ? 'SCR' : 'ok'}`);
}
process.exit(0);
