#!/usr/bin/env node
/**
 * The README screenshots, from the demo data (never real logs):
 *
 *   node src/bin.ts demo --port 4778 --no-open   # in another terminal
 *   node scripts/screenshots.mjs                 # writes docs/screenshot-session.png and docs/screenshot-insights.png
 *
 * Headless Chrome over the DevTools protocol (Node's built-in WebSocket, no dependencies), 1440 px wide at 2x, dark.
 * The browser gets no proxy and resolves no host names: it can only reach the local demo server.
 * CHROME=/path overrides discovery; DEMO=http://127.0.0.1:4778 the server.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEMO = process.env.DEMO ?? 'http://127.0.0.1:4778';
const SHOTS = [
  { out: 'docs/screenshot-session.png', path: '/#/s/claude-code%3Ade30c1a0-0001-4a1b-9c2d-0000000000a1', height: 900 },
  { out: 'docs/screenshot-insights.png', path: '/#/insights', height: 1000 },
];
const W = 1440;

const chromePath = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!chromePath) throw new Error('Chrome not found; set CHROME=/path/to/chrome');

const work = mkdtempSync(join(tmpdir(), 'bb-shots-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  chromePath,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${join(work, 'profile')}`, 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });

try {
  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  for (const shot of SHOTS) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: shot.height, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: DEMO + shot.path });
    await sleep(3000);
    // Never write an error page over a screenshot: the app must have loaded and rendered.
    const { result } = await send('Runtime.evaluate', { expression: "document.title.includes('agent-blackbox') && !!document.querySelector('#main *')", returnByValue: true });
    if (result.value !== true) throw new Error(`${DEMO + shot.path} did not load the app (is the demo server running?)`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(shot.out), Buffer.from(data, 'base64'));
    console.log('wrote', shot.out);
  }
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
