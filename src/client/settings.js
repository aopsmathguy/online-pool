// src/client/settings.js — player options (the ≡ menu's "Options" panel).
//
// Two settings, both persisted in localStorage (they are per-device preferences,
// not per-tab like the session token) and both applied LIVE: changing either one
// never rebuilds the scene or reloads the page.
//
//   reverseAim — flips the direction the aim drag turns the cue.
//   quality    — one of five graphics presets, below.
//
// This module owns the values and nothing else. The three modules that actually
// hold GPU resources subscribe and reconfigure themselves:
//   scene.js       lights, shadow maps, renderer pixel ratio
//   geometry.js    the scanned felt/wood texture sets
//   balls.view.js  the procedurally drawn ball textures

// ---- The five presets ---------------------------------------------------------
//
// Each step down sheds the most expensive thing left. Measured on an M5 through
// headless Chrome (ANGLE/Metal) at 2800x1800, median frame time with the pixel
// ratio pinned at 1 so the resolution dial doesn't mask the rest:
//
//   Ultra    7.3 ms
//   High     5.8 ms   -- drop the 4 grazing fill lights' shadows (7 shadow maps
//                        become 3). Costs only the soft band the rails drop onto
//                        the cloth, which reads mostly from the overhead view.
//   Medium   5.1 ms   -- halve the lamp shadow maps (2048->1024), drop the normal
//                        map, halve the scanned textures (4K->2K).
//   Low      2.4 ms   -- one shadow-casting lamp instead of three, 512 maps, hard
//                        PCF instead of the soft kernel, colour maps only at 1K.
//   Minimum  1.1 ms   -- no real-time shadows at all, 512 colour maps.
//
// So what actually costs: how many lights cast and how the filter samples. Map
// SIZE and texture resolution barely move a desktop GPU at all — they are in
// here for memory rather than for milliseconds, which is the constraint that
// bites first on a phone (7 maps at 2048 is ~50 MB of depth texture, and the
// felt set alone is ~100 MB of texture at 4K).
//
// The exception is `maxPixelRatio`, which is the single biggest lever the moment
// there is a retina display under it — at devicePixelRatio 3 the same sweep runs
// 8.3 / 6.0 / 1.0 / 0.8 / 0.6 ms, and nearly all of that Medium-to-High cliff is
// 1.5x pixels becoming 2x. It is the last dial rather than the first because it
// is also the one you SEE, on every edge on the screen.
//
// `shadowBulbs` is how many of the three overhead lamps cast — the centre one
// first (scene.js hangs them centre-first for exactly this reason), because it
// is the lamp over the middle of the table and its cone covers the most balls.
// The other two keep LIGHTING the cloth either way; they just stop casting, so
// dropping to one is a shadow change, not a lighting change.
export const QUALITY_LEVELS = [
  {
    name: 'Minimum',
    blurb: 'No shadows. Flat colour maps.',
    shadows: false, shadowBulbs: 0, sideShadows: false, shadowMapSize: 512, softShadows: false,
    texMax: 512, normalMap: false, roughnessMap: false, anisotropy: 1,
    ballTex: 256, maxPixelRatio: 1,
  },
  {
    name: 'Low',
    blurb: 'One shadow lamp. Colour maps only.',
    shadows: true, shadowBulbs: 1, sideShadows: false, shadowMapSize: 512, softShadows: false,
    texMax: 1024, normalMap: false, roughnessMap: false, anisotropy: 2,
    ballTex: 512, maxPixelRatio: 1,
  },
  {
    name: 'Medium',
    blurb: 'Three shadow lamps. No normal map.',
    shadows: true, shadowBulbs: 3, sideShadows: false, shadowMapSize: 1024, softShadows: true,
    texMax: 2048, normalMap: false, roughnessMap: true, anisotropy: 4,
    ballTex: 512, maxPixelRatio: 1.5,
  },
  {
    name: 'High',
    blurb: 'Sharp lamp shadows. Full PBR cloth.',
    shadows: true, shadowBulbs: 3, sideShadows: false, shadowMapSize: 2048, softShadows: true,
    texMax: 4096, normalMap: true, roughnessMap: true, anisotropy: 8,
    ballTex: 1024, maxPixelRatio: 2,
  },
  {
    name: 'Ultra',
    blurb: 'Adds the rail shadows from the side lights.',
    shadows: true, shadowBulbs: 3, sideShadows: true, shadowMapSize: 2048, softShadows: true,
    texMax: 4096, normalMap: true, roughnessMap: true, anisotropy: 16,
    ballTex: 1024, maxPixelRatio: 2,
  },
];

// High, not Ultra. Ultra is what the table used to render unconditionally, and
// the only thing it adds is four more shadow maps for a band along the cushions
// that reads from the overhead view — a real touch, but a 1.26x frame time and
// more than double the shadow memory for it. It is one notch away for anyone
// who wants it back.
export const DEFAULT_QUALITY = 3;

const KEY = 'poolSettings';
const DEFAULTS = { reverseAim: false, quality: DEFAULT_QUALITY };

const clampQuality = (q) => Math.max(0, Math.min(QUALITY_LEVELS.length - 1, q | 0));

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw) return { ...DEFAULTS };
    return {
      reverseAim: !!raw.reverseAim,
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
export const getQuality = () => current.quality;
export const qualityLevel = () => QUALITY_LEVELS[current.quality];

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
