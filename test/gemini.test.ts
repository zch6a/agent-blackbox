// Gemini CLI: its append-only JSONL (with $set, $patch, $rewindTo and rewritten messages), the older whole-file
// JSON, sub-agents, and how a ~/.gemini/tmp/<project> folder is mapped back to the project. Synthetic data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ADAPTERS, parseAgent } from '../src/adapters/index.ts';
import { geminiAdapter, parseGemini, readConversation } from '../src/adapters/gemini.ts';
import { listSessions } from '../src/catalog.ts';
import type { Session, ToolEvent, UsageEvent } from '../src/types.ts';
import { catalogRoots, makeFixture } from './helpers.ts';
import { TEST_HOME } from './isolate.ts';

const T = Date.parse('2026-11-02T09:00:00.000Z');
const at = (s: number) => new Date(T + s * 1000).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tools = (s: Session) => s.events.filter((e): e is ToolEvent => e.kind === 'tool');

const MAIN = '7c0ffee0-1111-4222-8333-444444444444';
const SUB = '5ub0a9e7-1111-4222-8333-555555555555';
const OLD = '01d5e551-1111-4222-8333-666666666666';
const fr = (id: string, name: string, output: string) => [{ functionResponse: { id, name, response: { output } } }];

function mainSession() {
  return [
    { sessionId: MAIN, projectHash: sha('/home/ana/code/shop'), startTime: at(0), lastUpdated: at(0), kind: 'main' },
    { id: 'u1', timestamp: at(1), type: 'user', content: [{ text: 'Fix the failing cart test' }] },
    { id: 'u2', timestamp: at(2), type: 'user', content: [{ text: 'never mind, rewound' }] },
    { $rewindTo: 'u2' },
    { id: 'g1', timestamp: at(3), type: 'gemini', content: [{ text: 'thinking…', thought: true }, { text: 'Running the tests.' }], model: 'gemini-2.5-pro',
      thoughts: [{ subject: 'Plan', description: 'Run the tests first', timestamp: at(3) }],
      tokens: { input: 10_000, output: 200, cached: 8_000, thoughts: 50, tool: 100, total: 10_350 },
      toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'executing', timestamp: at(3) }] },
    // The same message again, with the tool's result: replaces the first, in place.
    { id: 'g1', timestamp: at(3), type: 'gemini', content: [{ text: 'thinking…', thought: true }, { text: 'Running the tests.' }], model: 'gemini-2.5-pro',
      thoughts: [{ subject: 'Plan', description: 'Run the tests first', timestamp: at(3) }],
      tokens: { input: 10_000, output: 200, cached: 8_000, thoughts: 50, tool: 100, total: 10_350 },
      toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', timestamp: at(3),
        result: fr('c1', 'run_shell_command', 'Command: npm test\nOutput: 1 failing\nExit Code: 1') }] },
    { id: 'g2', timestamp: at(9), type: 'gemini', content: '', model: 'gemini-2.5-pro',
      toolCalls: [
        { id: 'c2', name: 'replace', args: { file_path: '/home/ana/code/shop/src/cart.ts', old_string: 'a', new_string: 'b' }, status: 'success', timestamp: at(9),
          result: fr('c2', 'replace', 'Successfully modified file'),
          resultDisplay: { fileName: 'cart.ts', fileDiff: 'Index: cart.ts\n===\n--- cart.ts\tCurrent\n+++ cart.ts\tProposed\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n keep\n', originalContent: 'old\nkeep', newContent: 'new\nmore\nkeep' } },
        { id: 'c3', name: 'write_file', args: { file_path: '/home/ana/code/shop/src/new.ts', content: 'x\ny\n' }, status: 'success', timestamp: at(10),
          result: fr('c3', 'write_file', 'ok'),
          resultDisplay: { fileName: 'new.ts', fileDiff: '--- new.ts\tCurrent\n+++ new.ts\tProposed\n@@ -0,0 +1,2 @@\n+x\n+y\n', originalContent: '', newContent: 'x\ny\n' } },
        { id: 'c4', name: 'read_file', args: { absolute_path: '/home/ana/code/shop/secret.env' }, status: 'error', timestamp: at(11),
          result: [{ functionResponse: { id: 'c4', name: 'read_file', response: { error: 'File not found' } } }] },
        { id: 'c5', name: 'web_fetch', args: { prompt: 'x' }, status: 'cancelled', timestamp: at(12) },
      ] },
    { $patch: { id: 'g2', content: [{ text: 'Fixed the cart.' }] } },
    { id: 'i1', timestamp: at(20), type: 'info', content: 'Chat history compressed.' },
    { id: 'e1', timestamp: at(21), type: 'error', content: 'Quota exceeded' },
    { $set: { summary: 'Fix the cart test', lastUpdated: at(21) } },
  ];
}

let dir: string;
let root: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'blackbox-gemini-'));
  root = join(dir, '.gemini', 'tmp');
});
after(() => rmSync(dir, { recursive: true, force: true }));

function writeTree() {
  mkdirSync(join(root, 'shop', 'chats', MAIN), { recursive: true });
  writeFileSync(join(root, 'shop', '.project_root'), '/home/ana/code/shop');
  writeFileSync(join(root, 'shop', 'chats', `session-2026-11-02T09-00-${MAIN.slice(0, 8)}.jsonl`), jsonl(mainSession()));
  writeFileSync(join(root, 'shop', 'chats', MAIN, `${SUB}.jsonl`), jsonl([
    { sessionId: SUB, projectHash: sha('/home/ana/code/shop'), startTime: at(4), kind: 'subagent' },
    { id: 's1', timestamp: at(4), type: 'user', content: 'Find the cart tests' },
    { id: 's2', timestamp: at(5), type: 'gemini', content: 'Found 3.', model: 'gemini-2.5-flash', tokens: { input: 1000, output: 10, cached: 0, total: 1010 } },
  ]));
  // An older layout: the folder is the SHA-256 of the project path, no marker; the session is one pretty JSON.
  const oldDir = join(root, sha('/home/ana/code/blog'), 'chats');
  mkdirSync(oldDir, { recursive: true });
  const legacy = { sessionId: OLD, projectHash: sha('/home/ana/code/blog'), startTime: at(-86400), lastUpdated: at(-86000),
    messages: [{ id: 'm1', timestamp: at(-86400), type: 'user', content: 'Draft a post' }, { id: 'm2', timestamp: at(-86300), type: 'gemini', content: 'Here is a draft.', model: 'gemini-2.5-flash' }] };
  writeFileSync(join(oldDir, 'session-2026-11-01T09-00-01d5e551.json'), JSON.stringify(legacy, null, 2));
  // Migrated to .jsonl later: the same session twice; the newer file wins.
  writeFileSync(join(oldDir, 'session-2026-11-01T09-00-01d5e551.jsonl'), jsonl([{ ...legacy, messages: undefined }, ...legacy.messages, { id: 'm3', timestamp: at(-86000), type: 'user', content: 'Shorter, please' }]));
  utimesSync(join(oldDir, 'session-2026-11-01T09-00-01d5e551.json'), new Date(T - 2e8), new Date(T - 2e8));
  writeFileSync(join(dir, '.gemini', 'projects.json'), JSON.stringify({ projects: { '/home/ana/code/shop': 'shop', '/home/ana/code/blog': 'blog' } }, null, 2));
  // Not sessions: logs and checkpoints next to chats/.
  writeFileSync(join(root, 'shop', 'logs.json'), '[]');
  mkdirSync(join(root, 'shop', 'checkpoints'), { recursive: true });
  writeFileSync(join(root, 'shop', 'checkpoints', 'checkpoint-x.json'), '{"sessionId":"nope"}');
}

describe('Gemini CLI adapter', () => {
  it('tests never fall back to anyone\'s real folders', () => {
    const home = resolve(TEST_HOME).toLowerCase();
    for (const a of ADAPTERS) for (const r of a.defaultRoots()) assert.ok(resolve(r).toLowerCase().startsWith(home), `${a.agent}: ${r}`);
    const fx = makeFixture();
    try {
      assert.deepEqual(Object.keys(catalogRoots(fx)).sort(), ADAPTERS.map((a) => a.agent).sort(), 'the fixture names a root for every agent');
    } finally {
      fx.cleanup();
    }
    assert.equal(parseAgent('gemini'), 'gemini-cli');
  });

  it('reads the log as Gemini CLI does: rewrites, rewinds, patches, $set', () => {
    const c = readConversation(jsonl(mainSession()));
    assert.deepEqual(c.messages.map((m) => m.id), ['u1', 'g1', 'g2', 'i1', 'e1']);
    assert.equal(c.meta.summary, 'Fix the cart test');
    assert.deepEqual(c.messages[2]?.content, [{ text: 'Fixed the cart.' }]);
    assert.equal((c.messages[1]?.toolCalls as { status: string }[])[0]?.status, 'success', 'the later copy replaced the first');
    assert.deepEqual(readConversation(jsonl([{ sessionId: 'x', projectHash: 'h' }, { id: 'a', type: 'user', content: 'a' }, { $rewindTo: 'missing' }])).messages, [], 'an unknown rewind target clears all');
    assert.deepEqual(readConversation(jsonl([{ sessionId: 'x', projectHash: 'h' }, { $set: { messages: [{ id: 'z', type: 'user', content: 'z' }] } }])).messages.map((m) => m.id), ['z']);
    assert.deepEqual(readConversation('not json at all\n{"broken": \n').messages, []);
  });

  it('finds main sessions and sub-agents, the newer of a migrated pair, and nothing else', async () => {
    writeTree();
    const refs = await geminiAdapter.discover([root]);
    assert.deepEqual(refs.map((r) => r.id).sort(), [MAIN, OLD, SUB].sort());
    assert.ok(refs.find((r) => r.id === OLD)?.path.endsWith('.jsonl'));
    assert.ok(refs.every((r) => r.key === `gemini-cli:${r.id}`));
  });

  it('turns a session into the timeline: tools, results, exit codes, edits, usage, title, project', async () => {
    const refs = await geminiAdapter.discover([root]);
    const s = await geminiAdapter.load(refs.find((r) => r.id === MAIN)!);
    assert.equal(s.title, 'Fix the cart test');
    assert.equal(s.cwd, '/home/ana/code/shop', 'from the .project_root marker');
    assert.equal(s.prompts, 1, 'the rewound prompt is gone');
    const t = tools(s);
    assert.deepEqual(t.map((x) => [x.name, x.isError]), [['run_shell_command', true], ['replace', false], ['write_file', false], ['read_file', true], ['web_fetch', true]]);
    assert.equal(t[0]?.exitCode, 1);
    assert.match(t[0]?.output ?? '', /1 failing/);
    assert.equal(t[3]?.output, 'File not found');
    assert.deepEqual(t[1]?.edits?.map((e) => [e.path, e.op, e.added, e.removed]), [['/home/ana/code/shop/src/cart.ts', 'modify', 2, 1]]);
    assert.deepEqual(t[2]?.edits?.map((e) => [e.path, e.op, e.added]), [['/home/ana/code/shop/src/new.ts', 'create', 2]]);
    assert.deepEqual([s.filesChanged, s.linesAdded, s.linesRemoved], [2, 4, 1]);
    const u = s.events.find((e): e is UsageEvent => e.kind === 'usage')!;
    // 10,000 prompt tokens of which 8,000 cached, plus 100 for tool use; thoughts are billed as output.
    assert.deepEqual(u.usage, { input: 2_100, output: 250, cacheRead: 8_000, cacheWrite: 0, reasoning: 50 });
    assert.equal(s.cost.source, 'estimated');
    assert.ok(s.cost.usd > 0);
    assert.ok(s.events.some((e) => e.kind === 'thinking' && e.text === 'Plan: Run the tests first'));
    assert.ok(!s.events.some((e) => e.kind === 'assistant' && e.text.includes('thinking…')), 'thought parts are not the answer');
    assert.deepEqual(s.events.filter((e) => e.kind === 'system').map((e) => (e as { level: string }).level), ['info', 'error']);
    assert.ok(!s.flags.includes('incomplete'));
  });

  it('links a sub-agent to its parent, and maps a hashed project folder through projects.json', async () => {
    const refs = await geminiAdapter.discover([root]);
    const sub = await geminiAdapter.load(refs.find((r) => r.id === SUB)!);
    assert.equal(sub.parentKey, `gemini-cli:${MAIN}`);
    assert.ok(sub.flags.includes('subagent'));
    assert.equal(sub.prompts, 0, 'a delegated task is not a human prompt');
    const old = await geminiAdapter.load(refs.find((r) => r.id === OLD)!);
    assert.equal(old.cwd, '/home/ana/code/blog');
    assert.equal(old.prompts, 2);
    const list = await listSessions({ roots: { ...Object.fromEntries(ADAPTERS.map((a) => [a.agent, [join(dir, 'none')]])), 'gemini-cli': [root] }, cache: false });
    assert.equal(list.find((x) => x.id === MAIN)?.children, 1);
  });

  it('a tool still running at the end marks the session incomplete; the old whole-file format still loads', () => {
    const running = readConversation(jsonl([{ sessionId: 'r', projectHash: 'h' }, { id: 'g', type: 'gemini', content: 'x', toolCalls: [{ id: 'c', name: 'run_shell_command', args: {}, status: 'awaiting_approval' }] }]));
    assert.equal(running.messages.length, 1);
    const s = parseGemini({ agent: 'gemini-cli', key: 'gemini-cli:r', path: join(dir, 'x', 'chats', 'session-r.jsonl'), id: 'r', mtimeMs: T, sizeBytes: 1 }, running);
    assert.ok(s.flags.includes('incomplete'));
    assert.equal(tools(s)[0]?.output, '', 'no result yet');
    const legacy = readConversation(JSON.stringify({ sessionId: 'l', projectHash: 'h', messages: [{ id: 'a', type: 'user', content: 'hi' }] }, null, 2));
    assert.deepEqual(legacy.messages.map((m) => m.id), ['a']);
    assert.equal(legacy.meta.sessionId, 'l');
  });
});
