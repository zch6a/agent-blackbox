import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { listSessions } from '../src/catalog.ts';
import { writeDemo } from '../src/demo.ts';

const dir = mkdtempSync(join(tmpdir(), 'bb-demo-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('demo data', () => {
  it('goes through the real parsers for all five agents', async () => {
    const demo = writeDemo(join(dir, 'demo'), Date.parse('2026-11-10T12:00:00Z'));
    const all = await listSessions({ roots: demo.roots, cache: false });
    const list = all.filter((s) => !s.parentKey);
    assert.equal(list.length, 9);
    const subs = all.filter((s) => s.parentKey);
    assert.equal(subs.length, 1, 'the Stripe session delegates to one sub-agent');
    assert.equal(subs[0]!.agentName, 'Explore');
    assert.equal(subs[0]!.costInParent, true);
    assert.equal(list.find((s) => s.key === subs[0]!.parentKey)?.children, 1);
    const byAgent = new Map<string, number>();
    for (const s of list) byAgent.set(s.agent, (byAgent.get(s.agent) ?? 0) + 1);
    assert.deepEqual(Object.fromEntries(byAgent), { 'claude-code': 3, codex: 2, 'deepseek-harness': 2, opencode: 1, 'gemini-cli': 1 });
    for (const s of list) {
      assert.ok(s.toolCalls > 0, `${s.title} has tool calls`);
      assert.ok(s.prompts > 0, `${s.title} has prompts`);
      assert.ok(s.title && s.title !== '(untitled session)', 'every demo session has a title');
      assert.ok(s.cost.source !== 'unknown', `${s.title} has a cost`);
    }
    // Codex titles come from session_index.jsonl, not the first prompt.
    assert.ok(list.some((s) => s.agent === 'codex' && s.title === 'Add OpenTelemetry tracing to the API'));
    assert.equal(list.filter((s) => s.flags.includes('log-uploaded')).length, 1);
    assert.ok(list.filter((s) => s.agent === 'claude-code').every((s) => s.cost.source === 'recorded'));
    const stripe = list.find((s) => s.title.startsWith('Migrate billing'));
    assert.ok(stripe && stripe.toolErrors === 2 && stripe.filesChanged >= 6);
    // Gemini CLI: the title from a $set line, the project from .project_root, the rewound prompt gone,
    // a shell call written twice counted once, edits from Gemini's own diffs.
    const gemini = list.find((s) => s.agent === 'gemini-cli');
    assert.ok(gemini);
    assert.equal(gemini.title, 'Add per-client rate limiting to the API gateway');
    assert.equal(gemini.cwd, '/Users/dev/src/gateway');
    assert.deepEqual([gemini.prompts, gemini.toolCalls, gemini.toolErrors, gemini.filesChanged], [1, 7, 1, 2]);
    assert.equal(gemini.cost.source, 'estimated');
  });

  it('is deterministic for a given clock', async () => {
    const a = writeDemo(join(dir, 'a'), 1_800_000_000_000);
    const b = writeDemo(join(dir, 'b'), 1_800_000_000_000);
    const [la, lb] = await Promise.all([listSessions({ roots: a.roots, cache: false }), listSessions({ roots: b.roots, cache: false })]);
    assert.deepEqual(
      la.map((s) => [s.id, s.cost.usd, s.usage]),
      lb.map((s) => [s.id, s.cost.usd, s.usage]),
    );
  });
});
