/**
 * Synthetic fixtures for every supported agent, written to a temp directory.
 * Nothing here comes from a real user's machine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

export const T0 = Date.parse('2026-11-01T10:00:00.000Z');
export const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

export interface Fixture {
  dir: string;
  roots: { claude: string; codex: string; opencode: string; deepseek: string };
  cacheDir: string;
  cleanup: () => void;
}

export const CLAUDE_ID = '11111111-aaaa-4bbb-8ccc-000000000001';
export const CLAUDE_SUBAGENT_ID = 'agent-a1b2c3d4e5f60789';
export const CODEX_ID = '22222222-aaaa-4bbb-8ccc-000000000002';
export const OPENCODE_ID = 'ses_test0003';
export const DSH_ID = '44444444-aaaa-4bbb-8ccc-000000000004';

export function claudeLines(): unknown[] {
  const base = { sessionId: CLAUDE_ID, cwd: '/work/shop', gitBranch: 'main', version: '2.9.0' };
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 0 } };
  return [
    { type: 'custom-title', customTitle: 'Fix checkout rounding bug', sessionId: CLAUDE_ID },
    { ...base, type: 'user', isMeta: true, timestamp: iso(0), message: { role: 'user', content: '<system-reminder>be nice</system-reminder>' } },
    { ...base, type: 'user', timestamp: iso(1), origin: { kind: 'human' }, message: { role: 'user', content: 'The checkout total is off by one cent. Fix it.' } },
    // One API response split over three lines that repeat the same id + usage.
    { ...base, type: 'assistant', timestamp: iso(5), message: { id: 'msg_1', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'Probably float math.' }], usage } },
    { ...base, type: 'assistant', timestamp: iso(5), message: { id: 'msg_1', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'Let me look at **cart.ts**.' }], usage } },
    { ...base, type: 'assistant', timestamp: iso(6), message: { id: 'msg_1', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/work/shop/cart.ts' } }], usage } },
    { ...base, type: 'user', timestamp: iso(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: 'export const total = (a, b) => a + b;' }] }, toolUseResult: { type: 'text', file: { filePath: '/work/shop/cart.ts' } } },
    { ...base, type: 'assistant', timestamp: iso(10), message: { id: 'msg_2', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/work/shop/cart.ts', old_string: 'a + b', new_string: 'Math.round((a + b) * 100) / 100' } }], usage: { ...usage, output_tokens: 80 } } },
    {
      ...base,
      type: 'user',
      timestamp: iso(12),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'The file has been updated.' }] },
      toolUseResult: {
        filePath: '/work/shop/cart.ts',
        oldString: 'a + b',
        newString: 'Math.round((a + b) * 100) / 100',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-export const total = (a, b) => a + b;', '+export const total = (a, b) => Math.round((a + b) * 100) / 100;'] }],
      },
    },
    { ...base, type: 'assistant', timestamp: iso(14), message: { id: 'msg_3', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }], usage } },
    { ...base, type: 'user', timestamp: iso(20), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', is_error: true, content: 'FAIL cart.test.ts\nError: expected 0.3 got 0.30000000000000004\nexit code 1' }] } },
    { ...base, type: 'user', timestamp: iso(25), message: { role: 'user', content: '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background build finished</summary></task-notification>' } },
    { ...base, type: 'user', timestamp: iso(30), message: { role: 'user', content: '<command-name>/compact</command-name><command-args>keep it short</command-args>' } },
    { ...base, type: 'system', subtype: 'compact_boundary', timestamp: iso(31), content: 'Conversation compacted' },
    { ...base, type: 'assistant', timestamp: iso(40), message: { id: 'msg_4', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'Fixed. Totals are now rounded to cents.' }], usage } },
    { type: 'cost-state', sessionId: CLAUDE_ID, startTime: T0, totalCostUSD: 0.0421, modelUsage: {} },
    { type: 'file-history-snapshot', messageId: 'x', snapshot: {} },
  ];
}

/** A sub-agent's own log: every line is a sidechain; the "user" message is the delegated task. */
export function claudeSubagentLines(): unknown[] {
  const base = { sessionId: CLAUDE_ID, agentId: 'a1b2c3d4e5f60789', isSidechain: true, cwd: '/work/shop', version: '2.9.0' };
  const usage = { input_tokens: 40, output_tokens: 30, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };
  return [
    { ...base, type: 'user', timestamp: iso(3), message: { role: 'user', content: 'Find every helper that rounds money in /work/shop.' } },
    { ...base, type: 'assistant', timestamp: iso(4), message: { id: 'sub_1', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_sub_grep', name: 'Grep', input: { pattern: 'round', path: '/work/shop' } }], usage } },
    { ...base, type: 'user', timestamp: iso(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_sub_grep', content: 'cart.ts:1' }] } },
    { ...base, type: 'assistant', timestamp: iso(6), message: { id: 'sub_2', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: 'Only cart.ts rounds money.' }], usage } },
  ];
}

export function codexLines(): unknown[] {
  const tc = (total: number, last: Record<string, number>) => ({
    timestamp: iso(0),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } },
  });
  return [
    { timestamp: iso(0), type: 'session_meta', payload: { id: CODEX_ID, cwd: '/work/api', timestamp: iso(0), cli_version: '0.80.0', source: 'cli' } },
    { timestamp: iso(0), type: 'turn_context', payload: { model: 'gpt-5.5', cwd: '/work/api' } },
    { timestamp: iso(0), type: 'event_msg', payload: { type: 'task_started' } },
    {
      timestamp: iso(1),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>\n  <cwd>/work/api</cwd>\n</environment_context>' },
          { type: 'input_text', text: 'Add a /health endpoint' },
        ],
      },
    },
    { timestamp: iso(2), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need a route.' }], encrypted_content: 'xx' } },
    { timestamp: iso(3), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls src'] }) } },
    { timestamp: iso(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'server.ts\nroutes.ts\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) } },
    tc(1200, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, reasoning_output_tokens: 50 }),
    tc(1200, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, reasoning_output_tokens: 50 }), // duplicate re-emit
    {
      timestamp: iso(6),
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/routes.ts\n@@\n-export const routes = [];\n+export const routes = [health];\n+export const health = () => "ok";\n*** Add File: src/health.test.ts\n+test("ok", () => {});\n*** End Patch' },
    },
    { timestamp: iso(7), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM src/routes.ts' } },
    { timestamp: iso(8), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c3', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } },
    { timestamp: iso(9), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3', output: JSON.stringify({ output: 'boom', metadata: { exit_code: 2 } }) } },
    tc(2600, { input_tokens: 1300, cached_input_tokens: 1000, output_tokens: 100, reasoning_output_tokens: 0 }),
    { timestamp: iso(10), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added `/health`.' }] } },
    { timestamp: iso(11), type: 'event_msg', payload: { type: 'task_complete' } },
  ];
}

export function dshEvents(): unknown[] {
  return [
    { type: 'session', id: DSH_ID, cwd: 'D:/proj/notes', createdAt: T0, agentPreset: 'code', delegationDepth: 0, isSeeded: false, version: 4 },
    { seq: 1, time: T0 + 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: T0 + 1000, type: 'user/message', data: { id: 'u0', role: 'user', content: [{ type: 'text', text: 'runtime ctx' }], source: { kind: 'runtime-context' } } },
    { seq: 3, time: T0 + 1100, type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '整理一下笔记目录' }], source: { kind: 'user' } } },
    {
      seq: 4,
      time: T0 + 3000,
      type: 'assistant/message',
      data: {
        message: {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看看有哪些文件' },
            { type: 'text', text: '好的，我先列出文件。' },
            { type: 'tool-call', id: 'call_1', name: 'run_code', arguments: '{"code":"ls()","description":"list"}' },
          ],
          source: { kind: 'llm', model: 'deepseek-flash', provider: 'deepseek' },
        },
        usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 4000, cacheWriteTokens: 0, totalTokens: 5020 },
      },
    },
    { seq: 5, time: T0 + 3001, type: 'tool/call', data: { callId: 'call_1', name: 'run_code', arguments: '{"code":"ls()","description":"list"}' } },
    { seq: 6, time: T0 + 3100, type: 'tool/ptc-dispatch-start', data: { subCallId: 'sub_1', parentCallId: 'call_1', rootCallId: 'call_1', name: 'write', arguments: { file_path: 'D:/proj/notes/index.md', content: '# Notes\n- a\n- b\n' } } },
    { seq: 7, time: T0 + 3200, type: 'tool/ptc-dispatch', data: { subCallId: 'sub_1', parentCallId: 'call_1', rootCallId: 'call_1', name: 'write', arguments: {}, content: [{ type: 'text', text: 'ok' }], isError: false } },
    { seq: 8, time: T0 + 3300, type: 'tool/result', data: { message: { id: 'r1', role: 'tool', isError: false, toolCallId: 'call_1', content: [{ type: 'text', text: 'done' }], source: { kind: 'tool', callId: 'call_1' } } } },
    { seq: 9, time: T0 + 3400, type: 'session-log-deepseek/delivery-accepted', data: { sessionId: DSH_ID, throughSeq: 8, sessionFormatVersion: 4 } },
    { seq: 10, time: T0 + 3500, type: 'session/title', data: { title: '整理笔记目录', messageSeqs: [3], source: { kind: 'llm' } } },
    { seq: 11, time: T0 + 3600, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

/** Encode text as many concatenated zstd frames, like an append-only log. */
export function zstdFrames(chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((c) => zlib.zstdCompressSync(Buffer.from(c))));
}

function writeOpencodeDb(path: string): void {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)').run(OPENCODE_ID, 'p1', null, 'brave-fox', '/work/blog', 'Write a blog post outline', '1.2.0', T0, T0 + 60_000);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  msg.run('m1', OPENCODE_ID, T0, T0, JSON.stringify({ role: 'user', time: { created: T0 } }));
  part.run('p1', 'm1', OPENCODE_ID, T0, T0, JSON.stringify({ type: 'text', text: 'Outline a post about caching' }));
  msg.run(
    'm2',
    OPENCODE_ID,
    T0 + 1000,
    T0 + 9000,
    JSON.stringify({ role: 'assistant', modelID: 'kimi-k2', providerID: 'moonshot', cost: 0.0123, time: { created: T0 + 1000, completed: T0 + 9000 }, tokens: { input: 500, output: 300, reasoning: 20, cache: { read: 100, write: 0 } } }),
  );
  part.run('p2', 'm2', OPENCODE_ID, T0 + 1000, T0 + 1000, JSON.stringify({ type: 'reasoning', text: 'Structure first.', time: { start: T0 + 1000 } }));
  part.run(
    'p3',
    'm2',
    OPENCODE_ID,
    T0 + 2000,
    T0 + 3000,
    JSON.stringify({ type: 'tool', tool: 'write', callID: 'call_w', state: { status: 'completed', input: { filePath: '/work/blog/outline.md', content: '# Caching\n## Why\n## How\n' }, output: 'Wrote file', metadata: {}, time: { start: T0 + 2000, end: T0 + 3000 } } }),
  );
  part.run(
    'p4',
    'm2',
    OPENCODE_ID,
    T0 + 4000,
    T0 + 5000,
    JSON.stringify({ type: 'tool', tool: 'bash', callID: 'call_b', state: { status: 'error', input: { command: 'wc -w outline.md' }, error: 'command not found: wc', time: { start: T0 + 4000, end: T0 + 5000 } } }),
  );
  part.run('p5', 'm2', OPENCODE_ID, T0 + 8000, T0 + 8000, JSON.stringify({ type: 'text', text: 'Outline written to outline.md.' }));
  db.close();
}

export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'blackbox-test-'));
  const claude = join(dir, 'claude', 'projects');
  const codex = join(dir, 'codex', 'sessions');
  const opencode = join(dir, 'opencode');
  const deepseek = join(dir, 'dsh', 'sessions');
  mkdirSync(join(claude, '-work-shop'), { recursive: true });
  writeFileSync(join(claude, '-work-shop', `${CLAUDE_ID}.jsonl`), jsonl(claudeLines()));
  const subDir = join(claude, '-work-shop', CLAUDE_ID, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, `${CLAUDE_SUBAGENT_ID}.jsonl`), jsonl(claudeSubagentLines()));
  writeFileSync(join(subDir, `${CLAUDE_SUBAGENT_ID}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Find rounding helpers', toolUseId: 'tu_task', spawnDepth: 1 }));
  mkdirSync(join(codex, '2026', '11', '01'), { recursive: true });
  writeFileSync(join(codex, '2026', '11', '01', `rollout-2026-11-01T10-00-00-${CODEX_ID}.jsonl`), jsonl(codexLines()));
  mkdirSync(opencode, { recursive: true });
  writeOpencodeDb(join(opencode, 'opencode.db'));
  const dshDir = join(deepseek, '--D-proj-notes--', `session-${DSH_ID}`);
  mkdirSync(dshDir, { recursive: true });
  // One frame per event, exactly like the real append-only log.
  writeFileSync(join(dshDir, 'session.v4.jsonl.zstd'), zstdFrames(dshEvents().map((e) => JSON.stringify(e) + '\n')));
  const cacheDir = join(dir, 'cache');
  return {
    dir,
    roots: { claude, codex, opencode, deepseek },
    cacheDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function rootArgs(f: Fixture): string[] {
  return ['--root', `claude=${f.roots.claude}`, '--root', `codex=${f.roots.codex}`, '--root', `opencode=${f.roots.opencode}`, '--root', `deepseek=${f.roots.deepseek}`];
}

export function catalogRoots(f: Fixture) {
  return {
    'claude-code': [f.roots.claude],
    codex: [f.roots.codex],
    opencode: [f.roots.opencode],
    'deepseek-harness': [f.roots.deepseek],
  };
}

export function ref(agent: string, id: string, path = '/dev/null') {
  return { agent: agent as 'claude-code', key: `${agent}:${id}`, path, id, mtimeMs: T0, sizeBytes: 1 };
}

/** Capture console.log/console.error and stdout writes while running fn. */
export async function capture(fn: () => Promise<unknown>): Promise<{ out: string; err: string; result: unknown }> {
  let out = '';
  let err = '';
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => {
    out += a.join(' ') + '\n';
  };
  console.error = (...a: unknown[]) => {
    err += a.join(' ') + '\n';
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, err, result };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}
