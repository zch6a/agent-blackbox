import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listSessions } from '../src/catalog.ts';
import { serve } from '../src/server.ts';
import { catalogRoots, CLAUDE_ID, CODEX_ID, makeFixture, rootArgs, type Fixture } from './helpers.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture();
  process.env.BLACKBOX_CACHE_DIR = fx.cacheDir;
});
after(() => {
  delete process.env.BLACKBOX_CACHE_DIR;
  fx.cleanup();
});

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

/** Run the real CLI in a child process, exactly as a user would. */
function cli(args: string[], withRoots = true): Promise<{ out: string; err: string; result: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args, ...(withRoots ? rootArgs(fx) : []), '--no-color'],
      { env: { ...process.env, BLACKBOX_CACHE_DIR: fx.cacheDir, NO_COLOR: '1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ out: stdout, err: stderr, result: error ? Number((error as { code?: number }).code ?? 1) : 0 }),
    );
  });
}
const run = (...args: string[]) => cli(args);

describe('catalog', () => {
  it('lists all four agents, newest first, and caches summaries', async () => {
    const list = await listSessions({ roots: catalogRoots(fx) });
    assert.deepEqual(new Set(list.map((s) => s.agent)), new Set(['claude-code', 'codex', 'opencode', 'deepseek-harness']));
    assert.ok(existsSync(join(fx.cacheDir, 'index.json')));
    const again = await listSessions({ roots: catalogRoots(fx) });
    assert.deepEqual(
      again.map((s) => s.key),
      list.map((s) => s.key),
    );
  });
});

describe('cli', () => {
  it('list --json returns summaries without events', async () => {
    const { out, result } = await run('list', '--json');
    assert.equal(result, 0);
    const rows = JSON.parse(out);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r: Record<string, unknown>) => !('events' in r)));
  });

  it('list filters by agent and project', async () => {
    const { out } = await run('list', '--json', '-a', 'codex,claude', '-p', 'shop');
    const rows = JSON.parse(out);
    assert.deepEqual(
      rows.map((r: { id: string }) => r.id),
      [CLAUDE_ID],
    );
  });

  it('show resolves id prefixes and renders a timeline', async () => {
    const { out, result } = await run('show', CODEX_ID.slice(0, 6));
    assert.equal(result, 0);
    assert.match(out, /Add a \/health endpoint/);
    assert.match(out, /apply_patch/);
    assert.match(out, /✗ exit 2/);
  });

  it('show --errors only prints what failed', async () => {
    const { out } = await run('show', CLAUDE_ID.slice(0, 8), '--errors');
    assert.match(out, /Bash/);
    assert.doesNotMatch(out, /❯ you/);
  });

  it('reports unknown sessions with exit code 1', async () => {
    const { err, result } = await run('show', 'zzzzzzzz');
    assert.equal(result, 1);
    assert.match(err, /No session matches/);
  });

  it('stats groups by agent and model', async () => {
    const { out } = await run('stats', '--by', 'model');
    assert.match(out, /claude-sonnet-5-5/);
    assert.match(out, /gpt-5\.5/);
    const { out: json } = await run('stats', '--by', 'agent', '--json');
    const parsed = JSON.parse(json);
    assert.equal(parsed.overview.sessions, 4);
    assert.equal(parsed.rows.length, 4);
  });

  it('export writes a self-contained HTML replay', async () => {
    const file = join(fx.dir, 'out', 'replay.html');
    const { result } = await run('export', CLAUDE_ID.slice(0, 8), '-o', file);
    assert.equal(result, 0);
    const html = readFileSync(file, 'utf8');
    assert.match(html, /window\.__BLACKBOX__=/);
    assert.match(html, /Fix checkout rounding bug/);
    assert.doesNotMatch(html, /src="app\.js"|href="style\.css"/, 'assets must be inlined');
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href="https?:/i, 'an export must not load anything from the network');
  });

  it('export --redact -f md scrubs the home directory', async () => {
    const { out } = await run('export', 'last', '-f', 'md', '-o', '-', '--redact');
    assert.match(out, /^# /);
  });

  it('rejects bad flags with exit code 2', async () => {
    assert.equal((await run('stats', '--by', 'planet')).result, 2);
    assert.equal((await run('list', '--since', 'whenever')).result, 2);
    assert.equal((await cli(['--definitely-not-a-flag'], false)).result, 2);
  });

  it('doctor lists every agent', async () => {
    const { out } = await run('doctor');
    for (const name of ['Claude Code', 'Codex', 'OpenCode', 'DeepSeek Harness']) assert.match(out, new RegExp(name));
  });

  it('--help and --version', async () => {
    assert.match((await cli(['--help'], false)).out, /flight recorder/);
    assert.match((await cli(['-v'], false)).out, /^\d+\.\d+\.\d+/);
  });
});

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server', () => {
  it('serves the UI and guards the API with a token and Host check', async () => {
    const srv = await serve({ roots: catalogRoots(fx), port: 0, open: false });
    try {
      await srv.indexed;
      const page = await get(srv.url);
      assert.equal(page.status, 200);
      const token = /"token":"([^"]+)"/.exec(page.body)?.[1];
      assert.ok(token, 'token is injected into the page');

      assert.equal((await get(srv.url + 'api/sessions')).status, 403);
      const ok = await get(srv.url + 'api/sessions', { 'x-blackbox-token': token! });
      assert.equal(ok.status, 200);
      const { sessions } = JSON.parse(ok.body);
      assert.equal(sessions.length, 4);

      const one = await get(srv.url + 'api/session/' + encodeURIComponent(sessions[0].key), { 'x-blackbox-token': token! });
      assert.equal(one.status, 200);
      assert.ok(Array.isArray(JSON.parse(one.body).events));

      const stats = await get(srv.url + 'api/stats', { 'x-blackbox-token': token! });
      assert.equal(JSON.parse(stats.body).overview.sessions, 4);

      // DNS rebinding: a request for another Host must be refused.
      assert.equal((await get(srv.url + 'api/sessions', { host: 'evil.example:80', 'x-blackbox-token': token! })).status, 421);
      assert.equal((await get(srv.url + 'app.js')).status, 200);
      assert.equal((await get(srv.url + '../package.json')).status, 404);
    } finally {
      await srv.close();
    }
  });
});
