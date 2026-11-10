/** Real disks are messy: half-written logs, garbage files, logs deleted while the UI is open. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listSessions } from '../src/catalog.ts';
import { serve } from '../src/server.ts';
import { catalogRoots, CLAUDE_ID, makeFixture, type Fixture } from './helpers.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture();
  process.env.BLACKBOX_CACHE_DIR = fx.cacheDir;
  // A log cut off mid-line (the agent was killed while writing).
  appendFileSync(join(fx.roots.claude, '-work-shop', `${CLAUDE_ID}.jsonl`), '{"type":"assistant","message":{"id":"msg_x","content":[{"type":"te');
  // Garbage that merely looks like logs.
  writeFileSync(join(fx.roots.claude, '-work-shop', 'empty.jsonl'), '');
  writeFileSync(join(fx.roots.claude, '-work-shop', 'binary.jsonl'), Buffer.from([0, 255, 10, 13, 0x7b, 0, 0x7d, 10]));
  mkdirSync(join(fx.roots.claude, '-work-shop', 'folder.jsonl'));
  const badDsh = join(fx.roots.deepseek, '--x--', 'session-bad');
  mkdirSync(badDsh, { recursive: true });
  writeFileSync(join(badDsh, 'session.v4.jsonl.zstd'), Buffer.from('definitely not zstd'));
  mkdirSync(join(fx.roots.codex, '2026', '11', '02'), { recursive: true });
  writeFileSync(join(fx.roots.codex, '2026', '11', '02', 'rollout-2026-11-02T00-00-00-33333333-aaaa-4bbb-8ccc-000000000003.jsonl'), 'not json at all\n{"half":');
  writeFileSync(join(fx.roots.opencode, 'opencode.db-wal'), 'junk');
});
after(() => {
  delete process.env.BLACKBOX_CACHE_DIR;
  fx.cleanup();
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

describe('messy disks', () => {
  it('lists every good session and skips what cannot be read', async () => {
    const list = await listSessions({ roots: catalogRoots(fx), cache: false });
    const keys = list.map((s) => s.key);
    // The four real sessions and the sub-agent survive; the truncated Claude log still parses.
    assert.ok(keys.includes(`claude-code:${CLAUDE_ID}`));
    assert.equal(list.filter((s) => s.agent === 'opencode').length, 1);
    assert.ok(!keys.some((k) => k.includes('session-bad') || k.endsWith(':bad')), 'corrupt zstd log is skipped');
    const claude = list.find((s) => s.key === `claude-code:${CLAUDE_ID}`)!;
    assert.equal(claude.toolCalls, 3, 'a half-written last line changes nothing');
  });

  it('answers 404 (not 500) for a session whose log was deleted while the UI is open', async () => {
    const srv = await serve({ roots: catalogRoots(fx), port: 0, open: false });
    try {
      await srv.indexed;
      const page = await get(srv.url);
      const token = /"token":"([^"]+)"/.exec(page.body)![1]!;
      const victim = join(fx.roots.codex, '2026', '11', '01');
      rmSync(victim, { recursive: true, force: true });
      const res = await get(srv.url + 'api/session/' + encodeURIComponent('codex:22222222-aaaa-4bbb-8ccc-000000000002'), { 'x-blackbox-token': token });
      assert.equal(res.status, 404);
      assert.deepEqual(JSON.parse(res.body), { error: 'not found' });
      const bad = await get(srv.url + 'api/session/%E0%A4%A', { 'x-blackbox-token': token }); // malformed escape
      assert.equal(bad.status, 400);
      assert.doesNotMatch(bad.body, /at .*\.ts:\d+/, 'no stack traces leak to the client');
    } finally {
      await srv.close();
    }
  });
});
