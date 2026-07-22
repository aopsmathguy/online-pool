// test/perf/harness.mjs — drive the real client for FRAME-TIME measurement.
//
// Deliberately not test/browser/driver.mjs, which exists for correctness tests
// and makes two choices that are right there and wrong here:
//   - it pins SwiftShader for determinism. That is a CPU rasterizer; timing it
//     measures a software renderer nobody plays on, and it is so slow that
//     texture decode dominates every sample.
//   - it leaves vsync on, which clamps every configuration to 16.7 ms and
//     measures nothing at all.
// So this one asks for the real GPU and unlocks the frame rate.
//
// It also forces a device pixel ratio. Headless reports 1, and the whole scene
// is fill-bound, so measuring at 1 understates every per-pixel cost (shadows
// especially) against the retina displays the presets exist for.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const WebSocket = require('ws');

export const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const haveChrome = () => fs.existsSync(CHROME);
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});

export async function launchPerf({
  dpr = 3, width = 1400, height = 900, gl = 'metal',
  settle = 4, sample = 5, warmup = 25_000,
} = {}) {
  const port = await freePort(), cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-perf-'));

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch { /* not up */ }
    await sleep(150);
  }

  const chrome = spawn(CHROME, [
    '--headless=new', '--use-gl=angle', `--use-angle=${gl}`,
    '--enable-unsafe-swiftshader',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${width},${height}`, `--force-device-scale-factor=${dpr}`,
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    `http://localhost:${port}/?bot`,
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes('localhost'));
    } catch { /* devtools not listening yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('no page target from Chrome');

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    const done = pending.get(msg.id);
    if (done) { pending.delete(msg.id); done(msg); }
  });
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id; pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`page threw: ${r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evaluate(expr)) return true; } catch { /* still booting */ }
      await sleep(200);
    }
    throw new Error(`timed out waiting for: ${expr}`);
  };

  await waitFor(`!!window.__net && window.__net.me().inGame`);
  await waitFor(`!!window.__gfxSet`);

  // Sample the page's own rAF cadence: this loop runs alongside the client's
  // render loop, so consecutive timestamps bracket exactly one client frame.
  await evaluate(`(() => {
    window.__ft = []; let prev = 0;
    (function loop(){ requestAnimationFrame(t => { if (prev) window.__ft.push(t - prev); prev = t; loop(); }); })();
  })()`);

  const handle = {
    port, evaluate, waitFor,
    /**
     * Median frame time (ms) with `level` applied.
     *
     * The settle wait is not politeness: switching a preset re-downloads and
     * re-downscales the scanned textures and recompiles every material, and
     * sampling through that measures the decoder rather than the renderer.
     */
    async measure(level) {
      await evaluate(`window.__gfxSet(${JSON.stringify(level)})`);
      await sleep(settle * 1000);
      await evaluate(`window.__ft.length = 0`);
      await sleep(sample * 1000);
      return median(await evaluate(`JSON.stringify(window.__ft)`).then(JSON.parse));
    },
    gfx: () => evaluate(`JSON.stringify(window.__gfx())`).then(JSON.parse),
    /**
     * PNG of the composited page, as a Buffer.
     *
     * Over CDP rather than canvas.toDataURL(): the renderer is built without
     * preserveDrawingBuffer, so reading the WebGL canvas back outside the frame
     * that drew it returns a blank image.
     */
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.result.data, 'base64');
    },
    errors: () => evaluate(`JSON.stringify(window.__errors)`),
    renderer: () => evaluate(`(() => {
      const gl = document.getElementById('stage').getContext('webgl2');
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })()`),
    /** The page loads at the default preset; its 4K maps and the 11 MB normal
     *  PNG are still decoding for the first several seconds. */
    warmUp: (level) => evaluate(`window.__gfxSet(${JSON.stringify(level)})`).then(() => sleep(warmup)),
    async close() {
      try { ws.close(); } catch { /* already gone */ }
      try { chrome.kill(); } catch { /* already gone */ }
      try { server.kill(); } catch { /* already gone */ }
      try { spawn('pkill', ['-f', profile], { stdio: 'ignore' }); } catch { /* best effort */ }
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
  return handle;
}

// The two endpoints every feature is measured between.
export const RICH = {
  shadows: true, shadowBulbs: 3, sideLights: true, sideShadows: true,
  texMax: 4096, normalMap: true, ballTex: 1024, ballSegs: 64,
};
// Minimal but WORKING — shadows actually render, so shadow-flavoured features
// are meaningful when toggled on top of it. (A base with shadows switched off
// makes "shadow map size" and "soft filter" no-ops that measure pure noise.)
export const LEAN = {
  shadows: true, shadowBulbs: 1, sideLights: false, sideShadows: false,
  texMax: 512, normalMap: false, ballTex: 256, ballSegs: 24,
};
