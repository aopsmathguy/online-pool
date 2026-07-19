// test/helpers/serverHarness.js — spawn a real server and talk to it.
//
// For behaviour that only exists in server/index.js: seats, tokens, resume,
// the shot log. None of it is reachable from the sim tests (index.js starts a
// listener on import), and it has already produced two bugs — a stale-rack
// clamp that silently skipped shots, and a resume race that could lose a game.
// So the tests drive it the way a client does: over a socket, on the wire.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { SocketClient } from '../../lib/socketUtility.js';
import { packetSchemas } from '../../src/shared/net/packets.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); });
});

export async function startServer() {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proc.stdout.on('data', d => log.push(String(d)));
  proc.stderr.on('data', d => log.push(String(d)));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch { /* not up */ }
    await sleep(150);
  }
  return {
    port, log,
    stop() { try { proc.kill(); } catch {} },
  };
}

// A client that records everything it is sent, so tests can await a packet
// rather than sleep and hope.
export async function connect(port) {
  const sock = new SocketClient(new WebSocket(`ws://localhost:${port}`), { packetSchemas });
  const seen = [];
  for (const ev of ['roomJoined', 'startGame', 'gameState', 'shotAnim', 'shotHistory',
                    'placing', 'balls', 'errorMsg', 'opponentLeft', 'lobby']) {
    sock.on(ev, (data) => seen.push({ ev, data }));
  }
  await new Promise((res) => sock.on('connect', res));

  // How many of each event a test has already consumed. Waiting must not start
  // from "now": packets arrive in bursts, so `roomJoined` and `startGame` are
  // typically both in `seen` before the test asks for the first one — and a
  // naive "wait for one to arrive from here" then hangs on a packet it already
  // has. Consume in order instead.
  const consumed = new Map();

  return {
    sock, seen,
    emit: (ev, data) => sock.emit(ev, data),
    /** Wait for the next unconsumed packet of `ev`, returning its payload. */
    async next(ev, { timeout = 10_000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const all = seen.filter(p => p.ev === ev);
        const k = consumed.get(ev) || 0;
        if (all.length > k) { consumed.set(ev, k + 1); return all[k].data; }
        await sleep(50);
      }
      throw new Error(`timed out waiting for '${ev}'; saw: ${seen.map(p => p.ev).join(', ') || '(nothing)'}`);
    },
    /** Whichever of `evs` lands first — for "success or rejection" branches. */
    async nextAny(evs, { timeout = 10_000 } = {}) {
      const deadline = Date.now() + timeout;
      const start = new Map(evs.map(e => [e, seen.filter(p => p.ev === e).length]));
      while (Date.now() < deadline) {
        for (const e of evs) {
          const all = seen.filter(p => p.ev === e);
          if (all.length > start.get(e)) return { ev: e, data: all[start.get(e)].data };
        }
        await sleep(50);
      }
      throw new Error(`timed out waiting for any of ${evs.join('/')}; saw: ${seen.map(p => p.ev).join(', ')}`);
    },
    /** Did any `ev` arrive within the window? */
    async sawWithin(ev, ms) {
      const from = seen.length;
      await sleep(ms);
      return seen.slice(from).some(p => p.ev === ev);
    },
    // Kill the socket WITHOUT a close handshake, the way a dropped network or a
    // suspended tab does — the server keeps the seat until its heartbeat gives
    // up (keepAliveTimeout, 10s).
    killSilently() {
      const ws = sock._ws;
      ws.onclose = null; ws.onerror = null; ws.onmessage = null;
      try { ws.terminate ? ws.terminate() : ws.close(); } catch {}
    },
    close() { try { sock._ws.close(); } catch {} },
  };
}
