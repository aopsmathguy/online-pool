// Boot the app against a bot game and screenshot the table from a few angles.
import fs from 'fs';
import { WebSocket } from 'ws';
import { launch, sleep } from '/Users/min/MIT/pool/test/browser/driver.mjs';

const OUT = '/private/tmp/claude-502/-Users-min-MIT-pool/7971fb55-5829-4d4c-a5ae-67499bbe1fcc/scratchpad';

// Second CDP session, just for Page.captureScreenshot (the driver's session
// only exposes Runtime.evaluate).
async function shooter(cdpPort) {
  const list = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
  const target = list.find(t => t.type === 'page' && t.url.includes('localhost'));
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', m => { const msg = JSON.parse(m); const d = pending.get(msg.id); if (d) { pending.delete(msg.id); d(msg); } });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  return {
    async grab(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
      console.log('wrote', name + '.png');
    },
    close: () => ws.close(),
  };
}

const h = await launch({ query: '?bot', width: 1400, height: 900 });
try {
  await h.waitFor('!!(window.__net && window.__net.state)', { timeout: 40_000, what: 'game to start' });
  await sleep(3000);
  const cam = await shooter(h.cdpPort);

  const pressV = () => h.evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true })), 1`);

  // Default aim view: shows the 45 deg face and the nose in profile.
  await cam.grab('plastic-aim');

  // 'v' cycles aim -> free -> top.
  await pressV(); await sleep(1500); await cam.grab('plastic-free');
  await pressV(); await sleep(1500); await cam.grab('plastic-top');

  console.log('console problems:', h.consoleProblems());
  cam.close();
} finally {
  await h.close();
}
