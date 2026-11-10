import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { claudeAdapter, combineProcessCosts, parseClaude } from '../src/adapters/claude.ts';
import { codexAdapter, parseCodex } from '../src/adapters/codex.ts';
import { classifyUserText } from '../src/adapters/common.ts';
import { deepseekAdapter } from '../src/adapters/deepseek.ts';
import { opencodeAdapter } from '../src/adapters/opencode.ts';
import type { Session, ToolEvent } from '../src/types.ts';
import { claudeLines, CLAUDE_ID, CLAUDE_SUBAGENT_ID, CODEX_ID, codexLines, DSH_ID, iso, makeFixture, OPENCODE_ID, ref, type Fixture } from './helpers.ts';

const tools = (s: Session) => s.events.filter((e): e is ToolEvent => e.kind === 'tool');
const kinds = (s: Session) => s.events.map((e) => e.kind);

let fx: Fixture;
before(() => {
  fx = makeFixture();
});
after(() => fx.cleanup());

describe('Claude Code adapter', () => {
  it('discovers sessions by file name', async () => {
    const refs = await claudeAdapter.discover([fx.roots.claude]);
    const top = refs.filter((r) => !r.id.startsWith('agent-'));
    assert.equal(top.length, 1);
    assert.equal(top[0]!.id, CLAUDE_ID);
    assert.equal(top[0]!.key, `claude-code:${CLAUDE_ID}`);
  });

  it('parses prompts, tools, edits, usage and recorded cost', async () => {
    const s = await parseClaude(ref('claude-code', CLAUDE_ID), claudeLines() as Record<string, unknown>[]);
    assert.equal(s.title, 'Fix checkout rounding bug');
    assert.equal(s.cwd, '/work/shop');
    // the human prompt and the /compact command; meta reminders and task notifications are not prompts
    assert.equal(s.prompts, 2);
    assert.deepEqual(
      s.events.filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text),
      ['The checkout total is off by one cent. Fix it.', '/compact keep it short'],
    );
    assert.equal(s.toolCalls, 3);
    assert.equal(s.toolErrors, 1);
    assert.deepEqual(
      tools(s).map((t) => t.name),
      ['Read', 'Edit', 'Bash'],
    );
    const edit = tools(s)[1]!;
    assert.equal(edit.edits?.[0]?.path, '/work/shop/cart.ts');
    assert.equal(edit.edits?.[0]?.added, 1);
    assert.equal(edit.edits?.[0]?.removed, 1);
    assert.equal(s.filesChanged, 1);
    assert.ok(kinds(s).includes('thinking'));
    assert.ok(kinds(s).includes('compact'));
    assert.ok(s.events.some((e) => e.kind === 'system' && e.text.includes('Background build finished')));
  });

  it('counts a response split over several lines only once', async () => {
    const s = await parseClaude(ref('claude-code', CLAUDE_ID), claudeLines() as Record<string, unknown>[]);
    assert.equal(s.events.filter((e) => e.kind === 'usage').length, 4);
    assert.deepEqual(s.usage, { input: 400, output: 230, cacheRead: 4000, cacheWrite: 800, reasoning: 0 });
  });

  it('prefers the cost Claude Code recorded itself', async () => {
    const s = await parseClaude(ref('claude-code', CLAUDE_ID), claudeLines() as Record<string, unknown>[]);
    assert.equal(s.cost.usd, 0.0421);
    assert.equal(s.cost.source, 'recorded');
  });

  it('estimates the part of a session that cost-state does not cover', async () => {
    // cost-state started 30 s in: the first requests (t = 5 s, 10 s, 14 s) are not in the recorded total.
    const lines = (claudeLines() as Record<string, unknown>[]).map((l) => (l.type === 'cost-state' ? { ...l, startTime: Date.parse(iso(30)) } : l));
    const s = await parseClaude(ref('claude-code', CLAUDE_ID), lines);
    assert.equal(s.cost.source, 'mixed');
    const early = (100 * 2 + 50 * 10 + 1000 * 0.1 + 200 * 2.5) / 1e6 + (100 * 2 + 80 * 10 + 1000 * 0.1 + 200 * 2.5) / 1e6 + (100 * 2 + 50 * 10 + 1000 * 0.1 + 200 * 2.5) / 1e6;
    assert.ok(Math.abs(s.cost.usd - (0.0421 + early)) < 1e-12);
    // A cost-state written when an old session was merely reopened covers nothing.
    const reopened = (claudeLines() as Record<string, unknown>[]).map((l) => (l.type === 'cost-state' ? { ...l, startTime: Date.parse(iso(9999)), totalCostUSD: 0 } : l));
    assert.equal((await parseClaude(ref('claude-code', CLAUDE_ID), reopened)).cost.source, 'estimated');
  });

  it('reads sub-agent logs and links them to the parent tool call', async () => {
    const refs = await claudeAdapter.discover([fx.roots.claude]);
    const child = refs.find((r) => r.id === CLAUDE_SUBAGENT_ID);
    assert.ok(child, 'sub-agent file is discovered');
    const s = await claudeAdapter.load(child!);
    assert.equal(s.parentKey, `claude-code:${CLAUDE_ID}`);
    assert.equal(s.parentToolId, 'tu_task');
    assert.equal(s.agentName, 'Explore');
    assert.equal(s.title, 'Find rounding helpers');
    assert.equal(s.prompts, 0, 'a delegated task is not a human prompt');
    const task = s.events.find((e) => e.kind === 'user');
    assert.ok(task && task.kind === 'user' && task.from === 'agent');
    assert.ok(s.flags.includes('subagent'));
    assert.equal(s.toolCalls, 1);
  });

  it('falls back to an estimate without cost-state', async () => {
    const lines = (claudeLines() as Record<string, unknown>[]).filter((l) => l.type !== 'cost-state');
    const s = await parseClaude(ref('claude-code', CLAUDE_ID), lines);
    assert.equal(s.cost.source, 'estimated');
    // sonnet-5-5: $2 in, $10 out, $0.10 cache read, $2.50 cache write per 1M
    const expected = (400 * 2 + 230 * 10 + 4000 * 0.1 + 800 * 2.5) / 1e6;
    assert.ok(Math.abs(s.cost.usd - expected) < 1e-12, `${s.cost.usd} != ${expected}`);
  });

  it('combines cost-state across resumed processes', () => {
    assert.equal(combineProcessCosts([{ first: 0.1, last: 1 }]), 1);
    // restarted from zero → add
    assert.equal(combineProcessCosts([{ first: 0.1, last: 1 }, { first: 0.05, last: 0.5 }]), 1.5);
    // restored the previous total → continue
    assert.equal(combineProcessCosts([{ first: 0.1, last: 1 }, { first: 1, last: 1.7 }]), 1.7);
  });

  it('flags a session whose last tool call never got a result', async () => {
    const lines = [
      { type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: '2026-11-01T00:00:01Z', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep 1000' } }] } },
    ];
    const s = await parseClaude(ref('claude-code', 'x'), lines);
    assert.ok(s.flags.includes('incomplete'));
  });

  it('treats non-human origins as automation, not prompts', async () => {
    const lines = [{ type: 'user', timestamp: '2026-11-01T00:00:00Z', origin: { kind: 'cron' }, message: { role: 'user', content: 'check the deploy' } }];
    const s = await parseClaude(ref('claude-code', 'x'), lines);
    assert.equal(s.prompts, 0);
    assert.ok(s.events.some((e) => e.kind === 'system' && e.text.includes('[cron] check the deploy')));
  });

  it('survives garbage lines and unknown types', async () => {
    const s = await parseClaude(ref('claude-code', 'x'), [{ type: 'mystery' }, { nope: true }, { type: 'assistant' }, { type: 'user' }]);
    assert.equal(s.events.length, 0);
    assert.equal(s.title, '(untitled session)');
  });
});

describe('Codex adapter', () => {
  it('discovers rollout files and extracts the uuid', async () => {
    const refs = await codexAdapter.discover([fx.roots.codex]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.id, CODEX_ID);
  });

  it('drops injected context but keeps the human request', async () => {
    const s = await parseCodex(ref('codex', CODEX_ID), codexLines() as Record<string, unknown>[]);
    assert.equal(s.prompts, 1);
    assert.equal((s.events.find((e) => e.kind === 'user') as { text: string }).text, 'Add a /health endpoint');
    assert.equal(s.title, 'Add a /health endpoint');
    assert.equal(s.cwd, '/work/api');
  });

  it('de-duplicates token_count events and separates cached input', async () => {
    const s = await parseCodex(ref('codex', CODEX_ID), codexLines() as Record<string, unknown>[]);
    assert.equal(s.events.filter((e) => e.kind === 'usage').length, 2);
    assert.deepEqual(s.usage, { input: 700, output: 300, cacheRead: 1600, cacheWrite: 0, reasoning: 50 });
    const expected = (700 * 5 + 300 * 30 + 1600 * 0.5) / 1e6; // gpt-5.5
    assert.ok(Math.abs(s.cost.usd - expected) < 1e-12);
    assert.equal(s.cost.source, 'estimated');
  });

  it('reads apply_patch edits and exit codes', async () => {
    const s = await parseCodex(ref('codex', CODEX_ID), codexLines() as Record<string, unknown>[]);
    const t = tools(s);
    assert.deepEqual(
      t.map((x) => [x.name, x.isError]),
      [
        ['shell', false],
        ['apply_patch', false],
        ['shell', true],
      ],
    );
    assert.equal(t[0]!.output, 'server.ts\nroutes.ts\n');
    const edits = t[1]!.edits!;
    assert.deepEqual(
      edits.map((e) => [e.path, e.op, e.added, e.removed]),
      [
        ['src/routes.ts', 'modify', 2, 1],
        ['src/health.test.ts', 'create', 1, 0],
      ],
    );
    assert.equal(s.filesChanged, 2);
    assert.ok(!s.flags.includes('incomplete'));
  });

  it('accepts the legacy line format without a payload wrapper', async () => {
    const s = await parseCodex(ref('codex', 'legacy'), [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }], timestamp: '2025-05-01T00:00:00Z' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }], timestamp: '2025-05-01T00:00:01Z' },
    ]);
    assert.deepEqual(kinds(s), ['user', 'assistant']);
  });
});

describe('OpenCode adapter', () => {
  it('reads the SQLite database', async () => {
    const refs = await opencodeAdapter.discover([fx.roots.opencode]);
    assert.equal(refs.length, 1);
    const s = await opencodeAdapter.load(refs[0]!);
    assert.equal(s.id, OPENCODE_ID);
    assert.equal(s.title, 'Write a blog post outline');
    assert.equal(s.cwd, '/work/blog');
    assert.equal(s.prompts, 1);
    assert.deepEqual(
      tools(s).map((t) => [t.name, t.isError]),
      [
        ['write', false],
        ['bash', true],
      ],
    );
    assert.equal(tools(s)[0]!.edits?.[0]?.added, 3);
    assert.equal(tools(s)[0]!.endT! - tools(s)[0]!.t, 1000);
    assert.deepEqual(s.cost, { usd: 0.0123, source: 'recorded' });
    assert.equal(s.usage.output, 320); // reasoning folded into billed output
  });

  it('returns nothing (not an error) when no data exists', async () => {
    assert.deepEqual(await opencodeAdapter.discover([fx.dir + '/does-not-exist']), []);
  });
});

describe('DeepSeek Harness adapter', () => {
  it('decodes the multi-frame zstd log', async () => {
    const refs = await deepseekAdapter.discover([fx.roots.deepseek]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.id, DSH_ID);
    const s = await deepseekAdapter.load(refs[0]!);
    assert.equal(s.title, '整理笔记目录');
    assert.equal(s.cwd, 'D:/proj/notes');
    assert.equal(s.prompts, 1); // runtime-context is injected
    assert.ok(s.flags.includes('log-uploaded'));
    const t = tools(s);
    assert.deepEqual(
      t.map((x) => [x.name, x.parentId ?? null]),
      [
        ['run_code', null],
        ['write', 'call_1'],
      ],
    );
    assert.equal(t[0]!.output, 'done');
    assert.equal(t[1]!.edits?.[0]?.path, 'D:/proj/notes/index.md');
    assert.deepEqual(s.usage, { input: 900, output: 120, cacheRead: 4000, cacheWrite: 0, reasoning: 0 });
    assert.ok(kinds(s).includes('thinking'));
    assert.ok(!s.flags.includes('incomplete'));
  });
});

describe('classifyUserText', () => {
  it('recognises every kind of injected message', () => {
    assert.equal(classifyUserText('<system-reminder>x</system-reminder>').kind, 'ignore');
    assert.equal(classifyUserText('<environment_context>x').kind, 'ignore');
    assert.equal(classifyUserText('<heartbeat/>').kind, 'human'); // self-closing tags are not in the list
    assert.equal(classifyUserText('<heartbeat>tick</heartbeat>').kind, 'ignore');
    assert.deepEqual(classifyUserText('<command-name>/review</command-name><command-args>pr 3</command-args>'), { kind: 'command', text: '/review pr 3' });
    assert.deepEqual(classifyUserText('<bash-input>ls</bash-input>'), { kind: 'shell', text: 'ls' });
    assert.equal(classifyUserText('<task-notification><summary>done</summary></task-notification>').kind, 'system');
    assert.deepEqual(classifyUserText('# Context from my IDE setup:\n\n## Open tabs\n- a.ts\n\n## My request for Codex:\nrename foo'), { kind: 'human', text: 'rename foo' });
    assert.deepEqual(classifyUserText('  just do it  '), { kind: 'human', text: '  just do it  ' });
  });
});
