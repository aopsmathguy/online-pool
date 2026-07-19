// test/browser/driver.mjs — drive the real client in a real browser.
//
// The client is the part of this codebase with no unit coverage, and it is
// where every replay-ordering bug has lived. These tests boot an actual server,
// point headless Chrome at it, and drive the page over CDP — no test doubles,
// so they exercise the same packets, the same rAF loop and the same rendering
// that a player gets.
//
// Kept out of `npm test` (which is fast and dependency-free) and run with
// `npm run test:browser`, because they need Chrome and take tens of seconds.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Chrome is not a dependency; if it isn't here the suite skips rather than fails.
export const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const haveChrome = () => fs.existsSync(CHROME);

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Boot a server + a browser on it, and hand back a handle to drive the page.
// `query` is appended to the URL (e.g. '?bot' to open straight into a game).
export async function launch({ query = '', width = 1280, height = 800 } = {}) {
  const port = await freePort();
  const cdpPort = await freePort();
  // A profile dir we own, so teardown can pkill by it — never by "Google
  // Chrome", which would take down the developer's own browser.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-chrome-'));

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', d => serverLog.push(String(d)));
  server.stderr.on('data', d => serverLog.push(String(d)));
  await waitForHttp(port, 10_000);

  const chrome = spawn(CHROME, [
    '--headless=new', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--run-all-compositor-stages-before-draw',
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    `http://localhost:${port}/${query}`,
  ], { stdio: 'ignore' });

  const consoleLines = [];
  const page = await connectPage(cdpPort, 20_000, consoleLines);

  // Console output is captured (see connectPage).
  //
  // window.__errors only catches window.onerror, which misses the failure mode
  // this codebase is most prone to: socketUtility wraps every packet handler in
  // a try/catch and logs the result as "Packet doesn't fit schema". A plain
  // ReferenceError in a handler therefore leaves NO trace a test can see — the
  // handler simply stops half way and the game quietly never starts. That
  // exact bug once wedged a full suite run with a green-looking page.


  const handle = {
    port, cdpPort, profile, serverLog, consoleLines,
    /** Console lines that look like a real problem, not ordinary chatter. */
    consoleProblems: () => consoleLines.filter(l =>
      /Packet doesn't fit schema|is not defined|is not a function|Uncaught|TypeError|ReferenceError/.test(l)),
    evaluate: page.evaluate,
    /**
     * Poll `expr` until it is truthy. Returns its value; throws on timeout.
     *
     * A page exception counts as "not ready yet", not as a failure: across a
     * location.reload() the document is torn down and rebuilt, so anything
     * touching window.__net will throw for a while. Waiting is exactly how a
     * test rides that out.
     */
    async waitFor(expr, { timeout = 20_000, every = 200, what = expr } = {}) {
      const deadline = Date.now() + timeout;
      let last, lastErr = null;
      while (Date.now() < deadline) {
        try { last = await page.evaluate(expr); lastErr = null; }
        catch (e) { last = undefined; lastErr = e.message; }
        if (last) return last;
        await sleep(every);
      }
      throw new Error(`timed out after ${timeout}ms waiting for: ${what}`
        + `\n  last value: ${JSON.stringify(last)}${lastErr ? `\n  last error: ${lastErr}` : ''}`);
    },
    /**
     * Reload, and don't return until the NEW document is running.
     *
     * `location.reload()` returns immediately — the old page keeps executing for
     * a while afterwards. Every naive `evaluate('location.reload()')` followed
     * by a wait is therefore a race against the outgoing page, and it fails in
     * the worst way: the wait is satisfied by the OLD document, so the test
     * asserts on pre-reload state and passes while the thing it guards is
     * broken. This cost three false results before it was noticed, so the
     * correct sequence lives here rather than in each test.
     *
     * The marker is the trick: it only exists on the outgoing page, so its
     * absence proves we are talking to the new one.
     */
    async reload({ timeout = 40_000 } = {}) {
      await page.evaluate(`window.__preReload = 1`);
      await page.evaluate(`location.reload()`);
      await handle.waitFor(
        `typeof window.__preReload === 'undefined' && !!window.__net && !!window.__replay`,
        { timeout, what: 'the reloaded document to finish booting' });
    },
    /**
     * Start a brand-new game on a clean slate.
     *
     * Tests share one browser and one server, so game state carries between
     * them: a test that leaves the game FINISHED makes every later test that
     * waits for a turn hang until it times out. (That is not hypothetical — it
     * cascaded here, turning one flaky failure into two.) Clearing the session
     * and reloading with ?bot gives each test a fresh rack it can rely on.
     */
    async freshGame({ timeout = 40_000 } = {}) {
      await page.evaluate(`window.__preReload = 1; sessionStorage.clear();`);
      await page.evaluate(`location.href = 'http://localhost:${port}/?bot'`);
      await handle.waitFor(
        `typeof window.__preReload === 'undefined' && !!window.__net && window.__net.me().inGame`,
        { timeout, what: 'a fresh game to start' });
      // The opening break is mine and starts in ball-in-hand.
      await handle.waitFor(`(window.__net.state()||{}).interact === 2`,
        { timeout, what: 'the break placement' });
    },
    async close() {
      try { page.ws.close(); } catch {}
      try { chrome.kill(); } catch {}
      try { server.kill(); } catch {}
      // Chrome forks; make sure nothing survives holding our profile dir.
      try { spawn('pkill', ['-f', profile], { stdio: 'ignore' }); } catch {}
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
  return handle;
}

async function waitForHttp(port, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`server never came up on ${port}`);
}

// Attach to the page target and expose a promise-based Runtime.evaluate.
async function connectPage(cdpPort, timeout, consoleLines = []) {
  const deadline = Date.now() + timeout;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes('localhost'));
    } catch { /* devtools not listening yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('no page target from Chrome');

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    const done = pending.get(msg.id);
    if (done) { pending.delete(msg.id); done(msg); return; }
    // Console + uncaught exceptions, so a swallowed handler throw is visible.
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map(a => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      consoleLines.push(`[${msg.params.type}] ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleLines.push(`[exception] ${d.text} ${d.exception?.description || ''}`);
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  // Console/exception events only arrive once Runtime is enabled.
  const enable = () => new Promise((res) => {
    const n = ++id; pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method: 'Runtime.enable', params: {} }));
  });
  await enable();

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(`page threw: ${ex.text} ${ex.exception?.description || ''}`);
    return r.result?.result?.value;
  };
  return { ws, evaluate, send };
}

export { sleep };
