// src/client/settings.js — player options (the ≡ menu's "Options" panel).
//
// Three settings, all persisted in localStorage (they are per-device
// preferences, not per-tab like the session token) and all applied LIVE:
// changing one never rebuilds the scene or reloads the page.
//
//   reverseAim — flips the direction the aim drag turns the cue.
//   showFps    — the frame-rate readout in the top-right corner.
//   quality    — one of five graphics presets, below.
//
// This module owns the values and nothing else. The three modules that actually
// hold GPU resources subscribe and reconfigure themselves:
//   scene.js       lights, shadow maps, renderer pixel ratio
//   geometry.js    the scanned felt/wood texture sets
//   balls.view.js  the procedurally drawn ball textures

// ---- The five presets ---------------------------------------------------------
//
// These are built from a per-feature ablation, not from intuition. Each feature
// was toggled on and off BACK TO BACK (so drift cancels in the difference) in two
// contexts — a lean scene and a fully loaded one — on an M5 through headless
// Chrome (ANGLE/Metal) at 1400x900 CSS, devicePixelRatio 3, vsync off. Median of
// 3 paired differences; the noise floor is about 0.5 ms.
//
//                            lean scene   loaded scene
//   side lights CAST           +6.2 ms      +5.3 ms
//   shadows at all (0->1 lamp) +1.9         (n/a *)
//   lamps casting 1 -> 3       +1.8         +0.6
//   side lights LIT            +1.4         +0.8
//   ------------------------------------ noise floor ----
//   normal map                 +0.2         +0.6
//   roughness map              +0.2         +0.2
//   ball mesh 24 -> 64 segs    +0.1         +0.4
//   soft PCF vs hard            0.0         -1.0
//   shadow map 512 -> 2048      0.0         -0.2
//   anisotropy 1 -> 16          0.0         +0.2
//   ball texture 256 -> 1024    0.0         +0.2
//   scanned textures 512 -> 4K -0.2         -1.6
//
//   * in the loaded scene the side lights are already casting, so switching
//     shadows off kills all five maps at once (+8.6 ms) rather than isolating the
//     one lamp. The lean column is the clean number for a single lamp.
//
// THE WHOLE BUDGET IS SHADOWS AND LIGHT COUNT. Nothing else clears the noise
// floor. That is why the ladder below moves exactly four things, in cost order:
// whether the side lights cast, whether they are lit, how many lamps cast, and
// whether anything casts at all. The span those four cover is the span of the
// slider — roughly 14.6 ms at the top to 3.7 ms at the bottom.
//
// Everything under the line is PINNED AT ITS BEST VALUE and is not a dial:
// the soft PCF filter, 2048 shadow maps, and anisotropy 16 all measured free, so
// degrading them would cost looks and buy nothing. An earlier cut of these
// presets spent four of its dials down there; it was trading away image quality
// for zero milliseconds, which is the worst deal available.
//
// The three that remain below the line — texMax, normalMap, ballTex/ballSegs —
// are kept as dials for reasons that are NOT frame time, and the distinction is
// worth preserving when retuning:
//   texMax     VRAM. Free in time, enormous in memory: the five scanned maps at
//              4K are ~380 MB of decoded texture with mipmaps, against ~28 MB at
//              1K. That is an out-of-memory on a phone, not a slow frame. Note it
//              does NOT save download — the file is fetched at full size and
//              shrunk after decode, because there is one file per map on disk.
//   normalMap  DOWNLOAD. felt/normal.png is 11 MB on its own, and dropping the
//              slot is the only lever here that actually avoids a fetch.
//   ballSegs   vertex throughput, which this desktop GPU does not care about
//              (+0.4 ms for 16 balls at 64 segments across 7 shadow passes) but a
//              weak mobile one might.
//
// RESOLUTION IS NOT ONE OF THE DIALS. It is by far the largest lever available —
// an earlier cut capped the pixel ratio per level, and that cap alone was worth
// more than every other setting put together (Medium ran 1.0 ms against High's
// 6.0 on a dpr-3 display, almost all of it 1.5x pixels against 2x) — and it is
// left on the table deliberately. Every preset renders at the display's full
// ratio; see scene.js fitCanvas. Resolution is the one cost that buys sharpness
// in everything at once, and the one the eye reads first. Everything above is a
// trade you can look at and accept; a soft image is not.
//
// `shadowBulbs` is how many of the three overhead lamps cast — the centre one
// first (scene.js hangs them centre-first for exactly this reason), because it is
// the lamp over the middle of the table and its cone covers the most balls. The
// other two keep LIGHTING the cloth either way; they just stop casting. The three
// lamps are never unlit at any preset: they are what you read the table by, and a
// rack lit from one point plays worse, not just looks worse.
//
// `sideLights` vs `sideShadows` is the same split for the four grazing fills, and
// it is the one that matters most. Lit-but-not-casting costs 0.8 ms; casting
// costs another 5.3. What you lose by unlighting them entirely is a highlight per
// ball (seven specular dots become three) and the lift on the cabinet's outward
// faces, which then falls back on the ambient.
export const QUALITY_LEVELS = [
  {
    name: 'Minimum',
    blurb: 'No shadows. Overhead lamps only.',
    shadows: false, shadowBulbs: 0, sideLights: false, sideShadows: false,
    texMax: 1024, normalMap: false, ballTex: 512, ballSegs: 32,
  },
  {
    name: 'Low',
    blurb: 'One lamp casts. No side lights.',
    shadows: true, shadowBulbs: 1, sideLights: false, sideShadows: false,
    texMax: 1024, normalMap: false, ballTex: 512, ballSegs: 32,
  },
  {
    name: 'Medium',
    blurb: 'Side lights lit. One lamp casts.',
    shadows: true, shadowBulbs: 1, sideLights: true, sideShadows: false,
    texMax: 2048, normalMap: true, ballTex: 1024, ballSegs: 48,
  },
  {
    name: 'High',
    blurb: 'All three lamps cast. Full PBR cloth.',
    shadows: true, shadowBulbs: 3, sideLights: true, sideShadows: false,
    texMax: 4096, normalMap: true, ballTex: 1024, ballSegs: 64,
  },
  {
    name: 'Ultra',
    blurb: 'Side lights cast the rail shadows too.',
    shadows: true, shadowBulbs: 3, sideLights: true, sideShadows: true,
    texMax: 4096, normalMap: true, ballTex: 1024, ballSegs: 64,
  },
];

// High, not Ultra. Ultra is what the table used to render unconditionally, and
// the only thing it adds is the four side lights' shadows — measured at +5.3 ms,
// which is more than the other four dials put together and is what drops a
// full-screen retina window under 60 fps. What it buys is the soft band the rails
// drop onto the cloth, which mostly reads from the overhead view. One notch away
// for anyone who wants it back.
export const DEFAULT_QUALITY = 3;

const KEY = 'poolSettings';
const DEFAULTS = { reverseAim: false, showFps: false, quality: DEFAULT_QUALITY };

const clampQuality = (q) => Math.max(0, Math.min(QUALITY_LEVELS.length - 1, q | 0));

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw) return { ...DEFAULTS };
    return {
      reverseAim: !!raw.reverseAim,
      showFps: !!raw.showFps,
      quality: Number.isFinite(raw.quality) ? clampQuality(raw.quality) : DEFAULT_QUALITY,
    };
  } catch { return { ...DEFAULTS }; }   // private mode / corrupt entry
}

const current = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(current)); }
  catch { /* private mode — the setting just won't survive a reload */ }
}

// ---- Reads --------------------------------------------------------------------
// isReverseAim is polled per pointer move rather than pushed, so the checkbox
// needs no wiring beyond setReverseAim.
export const isReverseAim = () => current.reverseAim;
export const isShowFps = () => current.showFps;
export const getQuality = () => current.quality;
export const qualityLevel = () => override || QUALITY_LEVELS[current.quality];

// Benchmark hook (window.__gfxSet). Pushes an arbitrary set of level fields
// through the exact path the slider uses, WITHOUT storing it — which is what
// makes a one-feature-at-a-time ablation possible. It has to live here rather
// than in the bench script because the subscribers read qualityLevel() back out
// for themselves (the texture builders in particular), so overriding the getter
// is the only way every one of them sees the same override. Pass null to clear.
let override = null;
export function setQualityOverride(partial) {
  override = partial ? { ...QUALITY_LEVELS[current.quality], ...partial } : null;
  for (const fn of listeners) fn(qualityLevel());
}

// ---- Writes -------------------------------------------------------------------
const listeners = new Set();

// Subscribe to QUALITY changes. Not called on subscribe: the subscribers build
// their GPU resources from qualityLevel() when they first need them, and this is
// only the "tear it down and rebuild at the new level" path.
export function onQualityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setQuality(q) {
  const next = clampQuality(q);
  if (next === current.quality) return;
  current.quality = next;
  save();
  for (const fn of listeners) fn(QUALITY_LEVELS[next]);
}

export function setReverseAim(on) {
  current.reverseAim = !!on;
  save();
}

export function setShowFps(on) {
  current.showFps = !!on;
  save();
}
