#!/usr/bin/env node
/**
 * Record the README replay GIF from the demo data.
 *
 *   node src/bin.ts demo --port 4778 --no-open   # in another terminal
 *   node scripts/record-replay.mjs [out.gif]
 *
 * Drives headless Chrome over the DevTools protocol (Node's built-in WebSocket,
 * no dependencies), starts a replay, captures frames and encodes them with ffmpeg.
 * Needs Chrome/Chromium and ffmpeg on the machine; CHROME=/path overrides discovery.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'docs/replay.gif');
const URL_ = process.env.DEMO_URL ?? 'http://127.0.0.1:4778/#/s/claude-code%3Ade30c1a0-0001-4a1b-9c2d-0000000000a1';
const W = 1280;
const H = 760;
const FPS = 10;
const SECONDS = Number(process.env.SECONDS ?? 16); // the demo replay takes ~15 s at 1x; hold the last frame briefly

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chromePath = candidates.find((p) => existsSync(p));
if (!chromePath) throw new Error('Chrome not found; set CHROME=/path/to/chrome');

const work = mkdtempSync(join(tmpdir(), 'bb-gif-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-dark-mode', `--remote-debugging-port=${port}`, `--user-data-dir=${join(work, 'profile')}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
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
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(2500);
  // Start the replay at 1x (the demo session is short enough to show whole).
  await send('Runtime.evaluate', { expression: "localStorage.setItem('blackbox:replay-speed','1'); document.querySelector('#play').click(); true" });
  const frames = FPS * SECONDS;
  for (let i = 0; i < frames; i++) {
    const t = Date.now();
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(work, `f${String(i).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    await sleep(Math.max(0, 1000 / FPS - (Date.now() - t)));
  }
} finally {
  ws.close();
  chrome.kill();
}

// Two-pass palette for a sharp, small GIF.
const args = ['-y', '-framerate', String(FPS), '-i', join(work, 'f%04d.png')];
const filter = `fps=${FPS},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
const r = spawnSync('ffmpeg', [...args, '-filter_complex', filter, '-loop', '0', OUT], { stdio: 'inherit' });
rmSync(work, { recursive: true, force: true });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('wrote', OUT);
