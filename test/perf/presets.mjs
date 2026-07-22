// test/perf/presets.mjs — frame time of each of the five quality presets.
//
//   npm run perf:presets
//
// Where ablate.mjs asks "what does this feature cost", this asks "is the ladder
// well spaced" — every notch on the slider should buy the player something they
// can measure, and a step that comes back under ~1 ms is a wasted notch that
// should be merged or re-tiered.
//
// Each preset is measured in BOTH sweep directions and the better median kept.
// A preset sampled right after a heavier one inherits its texture churn (the
// scanned maps are re-fetched and re-downscaled on every change), so a
// single-direction sweep biases every row in the same direction.
import { launchPerf, haveChrome, RICH } from './harness.mjs';
import { QUALITY_LEVELS } from '../../src/client/settings.js';

if (!haveChrome()) {
  console.log('Chrome not found — set CHROME=/path/to/chrome. Skipping.');
  process.exit(0);
}

const h = await launchPerf({ settle: 8, sample: 6 });
try {
  console.log('renderer:', await h.renderer());
  console.log('warming up...');
  await h.warmUp(RICH);

  const idx = QUALITY_LEVELS.map((_, i) => i);
  const up = [], down = [];
  for (const i of idx) up[i] = await h.measure(QUALITY_LEVELS[i]);
  for (const i of [...idx].reverse()) {
    down[i] = await h.measure(QUALITY_LEVELS[i]);
    down[`gfx${i}`] = await h.gfx();
  }

  console.log('\nframe time, ms — vsync off, full device pixel ratio\n');
  console.log('  #  preset     median     fps   lit lights  shadow maps  tris/frame');
  console.log('  ' + '-'.repeat(66));
  const med = idx.map(i => Math.min(up[i], down[i]));
  for (const i of idx) {
    const g = down[`gfx${i}`];
    console.log(
      `  ${i}  ${QUALITY_LEVELS[i].name.padEnd(9)}` +
      `${med[i].toFixed(2).padStart(7)} ${(1000 / med[i]).toFixed(0).padStart(7)}` +
      `${String(g.litLights).padStart(11)}${String(g.liveShadowMaps).padStart(12)}` +
      `${g.triangles.toLocaleString().padStart(13)}`);
  }
  console.log('\n  step sizes (a notch under ~1 ms is not worth being a notch):');
  for (let i = 1; i < idx.length; i++) {
    console.log(`    ${QUALITY_LEVELS[i - 1].name} -> ${QUALITY_LEVELS[i].name}:`
      + ` +${(med[i] - med[i - 1]).toFixed(2)} ms`);
  }
  console.log('\npage errors:', await h.errors());
} finally {
  await h.close();
}
