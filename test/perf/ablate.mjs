// test/perf/ablate.mjs — what does each graphics feature actually cost?
//
//   npm run perf:ablate
//
// Toggles one feature at a time and prints its marginal frame-time cost. This is
// what QUALITY_LEVELS in src/client/settings.js is built from: re-run it after
// touching the lighting rig or the materials, because the answer has already
// changed once (the first version of those presets spent four of its dials on
// things that measure zero).
//
// Two things about the method matter, and both were learned by getting them
// wrong first:
//
//   PAIRED MEASUREMENT. Measuring one baseline and comparing every feature
//   against it lets slow drift — thermals, the bot's search running hot — land
//   on the features as fake cost. It reported anisotropy at 3.2 ms, which is
//   nonsense. Here each feature is measured off-then-on BACK TO BACK and only
//   the difference is kept, so drift has to happen inside one ~18 s pair to
//   matter.
//
//   VALID CONTEXTS. A feature has to be able to DO something in the base you add
//   it to. Adding "soft shadow filter" or "2048 shadow maps" onto a base with
//   renderer shadows switched off changes nothing, and the resulting numbers are
//   pure noise — they came back NEGATIVE, which is the tell. Every feature below
//   is measured in two bases, LEAN and RICH, both of which have shadows on.
//
// The two contexts also expose interaction, which is the interesting part: a
// shadow lookup is per-pixel, so it costs more when more lights are lit, and
// anisotropy should in principle cost more on a 4K bed than a 512 one.
import { launchPerf, haveChrome, median, LEAN, RICH } from './harness.mjs';

if (!haveChrome()) {
  console.log('Chrome not found — set CHROME=/path/to/chrome. Skipping.');
  process.exit(0);
}

const REPS = Number(process.env.REPS || 3);
const NOISE = 0.5;   // ms; anything under this is not a real difference

// [label, off-state, on-state] — applied over whichever base is under test, so
// each pair differs in exactly this feature and nothing else.
const FEATURES = [
  ['side lights lit',        { sideLights: false, sideShadows: false }, { sideLights: true, sideShadows: false }],
  ['side lights cast',       { sideLights: true, sideShadows: false },  { sideLights: true, sideShadows: true }],
  ['lamps casting 1 -> 3',   { shadows: true, shadowBulbs: 1 },         { shadows: true, shadowBulbs: 3 }],
  ['shadows at all (0->1)',  { shadows: false, shadowBulbs: 0 },        { shadows: true, shadowBulbs: 1 }],
  ['normal map',             { normalMap: false },                      { normalMap: true }],
  ['scanned tex 512 -> 4K',  { texMax: 512 },                           { texMax: 4096 }],
  ['ball texture 256->1024', { ballTex: 256 },                          { ballTex: 1024 }],
  ['ball mesh 24 -> 64',     { ballSegs: 24 },                          { ballSegs: 64 }],
];

const h = await launchPerf({ settle: 3, sample: 4 });
try {
  console.log('renderer:', await h.renderer());
  console.log('warming up (the full texture set has to finish decoding first)...');
  await h.warmUp(RICH);

  const out = {};
  for (const [name, base] of [['LEAN', LEAN], ['RICH', RICH]]) {
    out[name] = { base: await h.measure(base), rows: [] };
    for (const [label, off, on] of FEATURES) {
      const deltas = [];
      for (let r = 0; r < REPS; r++) {
        const a = await h.measure({ ...base, ...off });
        const b = await h.measure({ ...base, ...on });
        deltas.push(b - a);
      }
      out[name].rows.push({ label, delta: median(deltas) });
      process.stderr.write(`  ${name} ${label}: ${median(deltas).toFixed(2)} ms\n`);
    }
  }

  console.log(`\n=== FEATURE COST — median of ${REPS} paired differences ===`);
  console.log(`    LEAN base ${out.LEAN.base.toFixed(2)} ms    RICH base ${out.RICH.base.toFixed(2)} ms\n`);
  console.log('  feature                    lean scene    loaded scene');
  console.log('  ' + '-'.repeat(56));
  const rows = out.LEAN.rows
    .map((r, i) => ({ label: r.label, lean: r.delta, rich: out.RICH.rows[i].delta }))
    .sort((a, b) => Math.max(b.lean, b.rich) - Math.max(a.lean, a.rich));
  let underLine = false;
  for (const r of rows) {
    if (!underLine && Math.max(r.lean, r.rich) < NOISE) {
      underLine = true;
      console.log(`  ${'-'.repeat(20)} noise floor ${NOISE} ms ${'-'.repeat(14)}`);
    }
    const f = (v) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2).padStart(5)} ms`;
    console.log(`  ${r.label.padEnd(24)} ${f(r.lean)}      ${f(r.rich)}`);
  }
  console.log('\nAnything below the line is free: pin it at its best value rather');
  console.log('than making it a preset dial. Note "free" means free in TIME —');
  console.log('texMax still governs VRAM and normalMap still governs download.');
  console.log('\npage errors:', await h.errors());
} finally {
  await h.close();
}
