/**
 * `blackbox demo`: realistic but entirely fictional sessions, written in each
 * agent's *native* log format so they go through exactly the same parsers as
 * real logs. Lets people try the UI before they have run any agent, and keeps
 * screenshots free of anyone's real data.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { costOf } from './pricing.ts';
import type { AgentKind } from './types.ts';

// ---------- deterministic randomness ----------
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- a neutral script every serializer understands ----------
type Step =
  | { k: 'user'; text: string }
  | { k: 'think'; text: string }
  | { k: 'say'; text: string }
  | { k: 'read'; path: string; body: string }
  | { k: 'grep'; pattern: string; hits: string }
  | { k: 'shell'; cmd: string; out: string; code: number; secs: number }
  | { k: 'edit'; path: string; before: string; after: string }
  | { k: 'write'; path: string; body: string }
  | { k: 'compact' }
  /** Hand a task to a sub-agent (Claude Code `Agent` tool); it runs its own little session. */
  | { k: 'delegate'; agentType: string; description: string; task: string; result: string; secs: number; work: { tool: string; input: Record<string, unknown>; out: string }[] };

interface Scenario {
  agent: AgentKind;
  id: string;
  title: string;
  cwd: string;
  model: string;
  daysAgo: number;
  steps: Step[];
  uploaded?: boolean;
}

const code = (name: string) =>
  `import { config } from './config';\n\nexport async function ${name}(input: Request) {\n  const body = await input.json();\n  return handle(body, config);\n}\n`;

function testCycle(cmd: string, failures: string[], fixes: { path: string; before: string; after: string }[], pass: string): Step[] {
  const steps: Step[] = [];
  failures.forEach((f, i) => {
    steps.push({ k: 'shell', cmd, out: f, code: 1, secs: 14 + i * 3 });
    steps.push({ k: 'think', text: 'The failure points at the edge case. Fix it and rerun.' });
    const fix = fixes[i % fixes.length];
    if (fix) steps.push({ k: 'edit', ...fix });
  });
  steps.push({ k: 'shell', cmd, out: pass, code: 0, secs: 19 });
  return steps;
}

function scenarios(): Scenario[] {
  return [
    {
      agent: 'claude-code',
      id: 'de30c1a0-0001-4a1b-9c2d-0000000000a1',
      title: 'Migrate billing webhooks to Stripe API v3',
      cwd: '/home/dev/work/payments',
      model: 'claude-opus-5-5',
      daysAgo: 0.1,
      steps: [
        { k: 'user', text: 'Stripe is sunsetting the v2 webhook format. Migrate our billing webhooks to v3, keep idempotency, and make sure the test suite passes.' },
        { k: 'think', text: 'Start by finding every place that parses webhook payloads.' },
        { k: 'say', text: "I'll map the webhook code first, then migrate handler by handler. An explorer sub-agent can check the Stripe changelog in parallel." },
        {
          k: 'delegate',
          agentType: 'Explore',
          description: 'Summarise Stripe v2 → v3 webhook changes',
          task: 'Read the Stripe API changelog and list every breaking change to webhook payloads between v2 and v3. Be concise; cite event names.',
          result: 'Breaking changes: payload moved under data.object; invoice.payment_succeeded renamed to invoice.paid; refund amounts are cumulative (amount_refunded).',
          secs: 41,
          work: [
            { tool: 'WebFetch', input: { url: 'https://docs.stripe.com/changelog', prompt: 'webhook payload changes' }, out: 'Changelog: data.object envelope, invoice.paid, amount_refunded is cumulative…' },
            { tool: 'Grep', input: { pattern: 'event.type', path: '/home/dev/work/payments/src' }, out: 'src/webhooks/router.ts:12' },
            { tool: 'Read', input: { file_path: '/home/dev/work/payments/src/webhooks/router.ts' }, out: "switch (event.type) {\n  case 'invoice.payment_succeeded':" },
          ],
        },
        { k: 'grep', pattern: 'stripe.webhooks|event.type ===', hits: 'src/webhooks/router.ts:12\nsrc/webhooks/invoice.ts:8\nsrc/webhooks/subscription.ts:15\nsrc/webhooks/refund.ts:9' },
        ...['router', 'invoice', 'subscription', 'refund'].map((f): Step => ({ k: 'read', path: `src/webhooks/${f}.ts`, body: code(f) })),
        { k: 'read', path: 'src/lib/idempotency.ts', body: 'export const seen = new Map<string, number>();\n' },
        { k: 'say', text: 'v3 wraps the object in `data.object` and renames `invoice.payment_succeeded` → `invoice.paid`. Updating the router and each handler.' },
        { k: 'edit', path: 'src/webhooks/router.ts', before: "case 'invoice.payment_succeeded':", after: "case 'invoice.paid':" },
        { k: 'edit', path: 'src/webhooks/invoice.ts', before: 'const invoice = event.data;', after: 'const invoice = event.data.object;' },
        { k: 'edit', path: 'src/webhooks/subscription.ts', before: 'const sub = event.data;', after: 'const sub = event.data.object;\nif (!sub.id) throw new WebhookError("missing id");' },
        { k: 'edit', path: 'src/webhooks/refund.ts', before: 'event.data.amount', after: 'event.data.object.amount_refunded' },
        { k: 'write', path: 'src/webhooks/v3.ts', body: 'export interface V3Event<T> {\n  id: string;\n  type: string;\n  data: { object: T };\n  created: number;\n}\n' },
        ...testCycle(
          'npm test -- webhooks',
          [
            'FAIL test/webhooks/invoice.test.ts\n  ● invoice.paid › marks invoice as paid\n    TypeError: Cannot read properties of undefined (reading "object")\n\nTests: 1 failed, 23 passed',
            'FAIL test/webhooks/refund.test.ts\n  ● refund › handles partial refunds\n    expect(received).toBe(expected)\n    Expected: 1250\n    Received: 2500\n\nTests: 1 failed, 23 passed',
          ],
          [
            { path: 'test/fixtures/invoice.json', before: '"data": { "id"', after: '"data": { "object": { "id"' },
            { path: 'src/webhooks/refund.ts', before: 'amount_refunded', after: 'amount_refunded - (prev?.amount_refunded ?? 0)' },
          ],
          'PASS test/webhooks/router.test.ts\nPASS test/webhooks/invoice.test.ts\nPASS test/webhooks/refund.test.ts\n\nTests: 24 passed, 24 total',
        ),
        { k: 'compact' },
        { k: 'user', text: 'Nice. Also add a replay-protection test for duplicate event ids.' },
        { k: 'write', path: 'test/webhooks/idempotency.test.ts', body: "it('ignores a replayed event id', async () => {\n  await post(event);\n  await post(event);\n  expect(charges).toHaveLength(1);\n});\n" },
        { k: 'shell', cmd: 'npm test -- idempotency', out: 'PASS test/webhooks/idempotency.test.ts\n\nTests: 1 passed', code: 0, secs: 9 },
        { k: 'shell', cmd: 'npm run lint', out: '✔ No problems found', code: 0, secs: 6 },
        { k: 'say', text: 'Done. All five handlers use the v3 envelope, duplicate event ids are ignored (new test), and the suite is green: **25 passed**.' },
      ],
    },
    {
      agent: 'codex',
      id: 'de30c0de-0002-4a1b-9c2d-0000000000b2',
      title: 'Add OpenTelemetry tracing to the API',
      cwd: '/home/dev/work/api',
      model: 'gpt-5.5',
      daysAgo: 0.8,
      steps: [
        { k: 'user', text: 'Add OpenTelemetry tracing to every HTTP route and the Postgres client. Export to OTLP over HTTP.' },
        { k: 'think', text: 'Need the SDK bootstrap before the server starts, then instrument pg.' },
        { k: 'shell', cmd: 'rg -n "createServer|new Pool" src', out: 'src/server.ts:8:const app = createServer()\nsrc/db.ts:3:export const pool = new Pool()', code: 0, secs: 1 },
        { k: 'read', path: 'src/server.ts', body: code('start') },
        { k: 'write', path: 'src/tracing.ts', body: "import { NodeSDK } from '@opentelemetry/sdk-node';\nexport const sdk = new NodeSDK({ serviceName: 'api' });\nsdk.start();\n" },
        { k: 'edit', path: 'src/server.ts', before: "import { config } from './config';", after: "import './tracing';\nimport { config } from './config';" },
        { k: 'shell', cmd: 'npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http', out: 'added 61 packages in 7s', code: 0, secs: 7 },
        ...testCycle(
          'npm run typecheck',
          ["src/tracing.ts(2,41): error TS2353: Object literal may only specify known properties, and 'serviceName' does not exist in type 'NodeSDKConfiguration'."],
          [{ path: 'src/tracing.ts', before: "{ serviceName: 'api' }", after: "{ resource: resourceFromAttributes({ 'service.name': 'api' }) }" }],
          'tsc --noEmit: 0 errors',
        ),
        { k: 'shell', cmd: 'npm test', out: 'Tests: 88 passed, 88 total', code: 0, secs: 31 },
        { k: 'say', text: 'Tracing is wired up: `src/tracing.ts` boots the SDK before the server, HTTP and `pg` are auto-instrumented, and spans export to `OTEL_EXPORTER_OTLP_ENDPOINT`.' },
      ],
    },
    {
      agent: 'deepseek-harness',
      id: 'de30dee9-0003-4a1b-9c2d-0000000000c3',
      title: '整理笔记目录并生成索引',
      cwd: 'D:/notes',
      model: 'deepseek-flash',
      daysAgo: 1.6,
      uploaded: true,
      steps: [
        { k: 'user', text: '把 D:/notes 里的笔记按主题整理一下，生成一个 index.md 目录。' },
        { k: 'think', text: '先列出所有文件，再按文件名里的关键词分组。' },
        { k: 'shell', cmd: 'Get-ChildItem -Recurse -Filter *.md | Select-Object -ExpandProperty Name', out: 'rust-所有权.md\nrust-生命周期.md\n分布式-raft.md\n分布式-一致性哈希.md\n读书-人月神话.md', code: 0, secs: 1 },
        ...['rust-所有权', '分布式-raft', '读书-人月神话'].map((f): Step => ({ k: 'read', path: `D:/notes/${f}.md`, body: `# ${f}\n\n要点……\n` })),
        { k: 'write', path: 'D:/notes/index.md', body: '# 笔记索引\n\n## Rust\n- [所有权](rust-所有权.md)\n- [生命周期](rust-生命周期.md)\n\n## 分布式\n- [Raft](分布式-raft.md)\n- [一致性哈希](分布式-一致性哈希.md)\n\n## 读书\n- [人月神话](读书-人月神话.md)\n' },
        { k: 'say', text: '已生成 `index.md`，按 Rust、分布式、读书三个主题分组，共 5 篇笔记。' },
      ],
    },
    {
      agent: 'claude-code',
      id: 'de30c1a0-0004-4a1b-9c2d-0000000000d4',
      title: 'Fix flaky login E2E test',
      cwd: '/home/dev/work/web-app',
      model: 'claude-sonnet-5-5',
      daysAgo: 2.3,
      steps: [
        { k: 'user', text: 'tests/e2e/login.spec.ts fails about 1 in 5 runs on CI. Find out why and fix it properly, no retries.' },
        { k: 'read', path: 'tests/e2e/login.spec.ts', body: "await page.click('#submit');\nawait expect(page).toHaveURL('/dashboard');\n" },
        { k: 'shell', cmd: 'npx playwright test login --repeat-each=10', out: '8 passed, 2 failed\n  Error: expect(page).toHaveURL: Timeout 5000ms exceeded\n  Received: "/login?redirect=%2Fdashboard"', code: 1, secs: 48 },
        { k: 'think', text: 'Redirect race: the session cookie is set after navigation starts.' },
        { k: 'grep', pattern: 'setSessionCookie', hits: 'src/auth/session.ts:22\nsrc/routes/login.ts:31' },
        { k: 'read', path: 'src/routes/login.ts', body: 'res.redirect("/dashboard");\nawait setSessionCookie(res, user);\n' },
        { k: 'edit', path: 'src/routes/login.ts', before: 'res.redirect("/dashboard");\nawait setSessionCookie(res, user);', after: 'await setSessionCookie(res, user);\nres.redirect("/dashboard");' },
        { k: 'shell', cmd: 'npx playwright test login --repeat-each=30', out: '30 passed (1.4m)', code: 0, secs: 84 },
        { k: 'say', text: 'Root cause: the server redirected **before** setting the session cookie, so the dashboard sometimes bounced back to /login. Swapped the order; 30/30 runs pass.' },
      ],
    },
    {
      agent: 'opencode',
      id: 'ses_de30open0005',
      title: 'Outline a blog post about HTTP caching',
      cwd: '/home/dev/blog',
      model: 'kimi-k2',
      daysAgo: 3.2,
      steps: [
        { k: 'user', text: 'Outline a post: "HTTP caching for people who are tired of stale deploys".' },
        { k: 'think', text: 'Lead with the deploy pain, then explain cache-control and immutable assets.' },
        { k: 'write', path: '/home/dev/blog/posts/http-caching.md', body: '# HTTP caching for people tired of stale deploys\n\n## 1. Why your users see yesterday\n## 2. Cache-Control in one table\n## 3. Hash your assets, cache them forever\n## 4. HTML: no-cache, not no-store\n## 5. Checklist\n' },
        { k: 'shell', cmd: 'wc -w posts/http-caching.md', out: 'wc: command not found', code: 127, secs: 1 },
        { k: 'say', text: 'Outline saved to `posts/http-caching.md` — five sections ending with a deploy checklist.' },
      ],
    },
    {
      agent: 'codex',
      id: 'de30c0de-0006-4a1b-9c2d-0000000000f6',
      title: 'Fix timezone bug in the daily revenue report',
      cwd: '/home/dev/work/reports',
      model: 'gpt-5.6-terra',
      daysAgo: 5.4,
      steps: [
        { k: 'user', text: "The daily revenue report for Tokyo shows yesterday's numbers. Fix the date bucketing." },
        { k: 'shell', cmd: 'rg -n "startOfDay|toISOString" src/report', out: 'src/report/daily.ts:14:  const day = new Date(row.created).toISOString().slice(0, 10)', code: 0, secs: 1 },
        { k: 'edit', path: 'src/report/daily.ts', before: 'new Date(row.created).toISOString().slice(0, 10)', after: 'formatInTimeZone(row.created, account.timezone, "yyyy-MM-dd")' },
        ...testCycle(
          'npm test -- daily',
          ['FAIL daily.test.ts › buckets by account timezone\n  Expected: "2026-11-02"\n  Received: "2026-11-01"'],
          [{ path: 'test/daily.test.ts', before: "timezone: 'UTC'", after: "timezone: 'Asia/Tokyo'" }],
          'PASS daily.test.ts (6 tests)',
        ),
        { k: 'say', text: 'Rows are now bucketed in the account’s own timezone, with a regression test for Asia/Tokyo.' },
      ],
    },
    {
      agent: 'claude-code',
      id: 'de30c1a0-0007-4a1b-9c2d-0000000000a7',
      title: 'Terraform: move staging to us-east-2',
      cwd: '/home/dev/work/infra',
      model: 'claude-opus-5-5',
      daysAgo: 8.7,
      steps: [
        { k: 'user', text: 'Move the staging environment from us-west-2 to us-east-2. Plan only, do not apply.' },
        { k: 'grep', pattern: 'us-west-2', hits: 'envs/staging/main.tf:4\nenvs/staging/rds.tf:11\nenvs/staging/s3.tf:7' },
        ...['main', 'rds', 's3'].map((f): Step => ({ k: 'edit', path: `envs/staging/${f}.tf`, before: 'region = "us-west-2"', after: 'region = "us-east-2"' })),
        { k: 'shell', cmd: 'terraform -chdir=envs/staging plan -no-color', out: 'Error: Invalid provider configuration\n  Provider "aws" requires an explicit region alias for the replica bucket.', code: 1, secs: 22 },
        { k: 'edit', path: 'envs/staging/s3.tf', before: 'provider = aws', after: 'provider = aws.replica' },
        { k: 'shell', cmd: 'terraform -chdir=envs/staging plan -no-color', out: 'Plan: 14 to add, 0 to change, 14 to destroy.', code: 0, secs: 37 },
        { k: 'say', text: 'Plan is ready: **14 to add, 14 to destroy** (RDS will be recreated — snapshot first). Nothing was applied.' },
      ],
    },
    {
      agent: 'deepseek-harness',
      id: 'de30dee9-0008-4a1b-9c2d-0000000000b8',
      title: '写一个查汇率的命令行小工具',
      cwd: 'D:/code/fx',
      model: 'deepseek-v4-pro',
      daysAgo: 12.5,
      steps: [
        { k: 'user', text: '写一个 Python 命令行小工具：fx 100 USD CNY 输出换算结果，汇率要缓存一小时。' },
        { k: 'write', path: 'D:/code/fx/fx.py', body: 'import json, sys, time, urllib.request\n\nCACHE = ".fx-cache.json"\n\ndef rate(a, b):\n    ...\n\nif __name__ == "__main__":\n    amount, a, b = sys.argv[1:4]\n    print(float(amount) * rate(a, b))\n' },
        { k: 'shell', cmd: 'python fx.py 100 USD CNY', out: 'Traceback (most recent call last):\n  File "fx.py", line 9, in <module>\n    amount, a, b = sys.argv[1:4]\nValueError: not enough values to unpack', code: 1, secs: 1 },
        { k: 'edit', path: 'D:/code/fx/fx.py', before: '    amount, a, b = sys.argv[1:4]', after: '    if len(sys.argv) != 4:\n        sys.exit("用法: fx <金额> <币种> <目标币种>")\n    amount, a, b = sys.argv[1:4]' },
        { k: 'shell', cmd: 'python fx.py 100 USD CNY', out: '100 USD = 718.20 CNY', code: 0, secs: 2 },
        { k: 'say', text: '完成：`fx.py` 支持 `fx <金额> <币种> <目标币种>`，汇率缓存在 `.fx-cache.json`，一小时后自动刷新。' },
      ],
    },
  ];
}

// ---------- timing ----------
interface Timed {
  step: Step;
  t: number;
  end: number;
}

function schedule(sc: Scenario, now: number, rand: () => number): Timed[] {
  let t = now - sc.daysAgo * 86400_000 - 2 * 3600_000;
  return sc.steps.map((step) => {
    const gap =
      step.k === 'user' ? 60_000 + rand() * 240_000 : step.k === 'think' ? 2_000 + rand() * 6_000 : step.k === 'say' ? 3_000 + rand() * 8_000 : 1_500 + rand() * 5_000;
    t += gap;
    const dur = step.k === 'shell' || step.k === 'delegate' ? step.secs * 1000 : step.k === 'read' || step.k === 'grep' ? 300 + rand() * 900 : step.k === 'edit' || step.k === 'write' ? 200 + rand() * 500 : 0;
    const item = { step, t: Math.round(t), end: Math.round(t + dur) };
    t += dur;
    return item;
  });
}

const iso = (ms: number) => new Date(ms).toISOString();
const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function patchLines(before: string, after: string): string[] {
  return [...before.split('\n').map((l) => '-' + l), ...after.split('\n').map((l) => '+' + l)];
}

/** Context grows over a session; most of it is served from cache. */
function usageFor(i: number, rand: () => number) {
  const context = 9_000 + i * 2_400;
  return { input: Math.round(150 + rand() * 900), cacheRead: context, cacheWrite: Math.round(600 + rand() * 1800), output: Math.round(120 + rand() * 900) };
}

// ---------- Claude Code ----------
function writeClaude(dir: string, sc: Scenario, timed: Timed[], rand: () => number): void {
  const base = { sessionId: sc.id, cwd: sc.cwd, gitBranch: 'main', version: '2.9.0', userType: 'external' };
  const rows: unknown[] = [{ type: 'custom-title', customTitle: sc.title, sessionId: sc.id }];
  const children: { agentId: string; rows: unknown[]; meta: unknown }[] = [];
  let n = 0;
  let total = 0;
  const assistant = (t: number, content: unknown[]) => {
    const u = usageFor(n, rand);
    const usage = { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: u.cacheWrite } };
    total += costOf(sc.model, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: 0 }).usd;
    rows.push({ ...base, type: 'assistant', timestamp: iso(t), uuid: `a${n}`, message: { id: `msg_demo_${n++}`, type: 'message', role: 'assistant', model: sc.model, content, usage } });
  };
  const result = (t: number, id: string, content: string, isError: boolean, toolUseResult?: unknown) =>
    rows.push({ ...base, type: 'user', timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, toolUseResult });
  timed.forEach(({ step, t, end }, i) => {
    const id = `toolu_demo_${i}`;
    switch (step.k) {
      case 'user':
        rows.push({ ...base, type: 'user', timestamp: iso(t), origin: { kind: 'human' }, message: { role: 'user', content: step.text } });
        break;
      case 'think':
        assistant(t, [{ type: 'thinking', thinking: step.text, signature: 'demo' }]);
        break;
      case 'say':
        assistant(t, [{ type: 'text', text: step.text }]);
        break;
      case 'read':
        assistant(t, [{ type: 'tool_use', id, name: 'Read', input: { file_path: `${sc.cwd}/${step.path}` } }]);
        result(end, id, step.body, false, { type: 'text', file: { filePath: `${sc.cwd}/${step.path}`, content: step.body } });
        break;
      case 'grep':
        assistant(t, [{ type: 'tool_use', id, name: 'Grep', input: { pattern: step.pattern, path: sc.cwd, output_mode: 'content' } }]);
        result(end, id, step.hits, false);
        break;
      case 'shell':
        assistant(t, [{ type: 'tool_use', id, name: 'Bash', input: { command: step.cmd, description: 'Run ' + step.cmd.split(' ')[0] } }]);
        result(end, id, step.code ? `Exit code ${step.code}\n${step.out}` : step.out, step.code !== 0);
        break;
      case 'edit': {
        const path = `${sc.cwd}/${step.path}`;
        assistant(t, [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: step.before, new_string: step.after } }]);
        const ls = patchLines(step.before, step.after);
        result(end, id, `The file ${path} has been updated successfully.`, false, {
          filePath: path,
          oldString: step.before,
          newString: step.after,
          structuredPatch: [{ oldStart: 10, oldLines: step.before.split('\n').length, newStart: 10, newLines: step.after.split('\n').length, lines: ls }],
        });
        break;
      }
      case 'write': {
        const path = `${sc.cwd}/${step.path}`;
        assistant(t, [{ type: 'tool_use', id, name: 'Write', input: { file_path: path, content: step.body } }]);
        result(end, id, `File created successfully at: ${path}`, false, { type: 'create', filePath: path, content: step.body, structuredPatch: [] });
        break;
      }
      case 'compact':
        rows.push({ ...base, type: 'system', subtype: 'compact_boundary', timestamp: iso(t), content: 'Conversation compacted' });
        break;
      case 'delegate': {
        assistant(t, [{ type: 'tool_use', id, name: 'Agent', input: { description: step.description, prompt: step.task, subagent_type: step.agentType } }]);
        result(end, id, step.result, false);
        const agentId = `a${(0x1000000 + Math.floor(rand() * 0xeffffff)).toString(16)}${i}`;
        const sub = { ...base, agentId, isSidechain: true };
        const subModel = 'claude-haiku-5-5';
        const subRows: unknown[] = [{ ...sub, type: 'user', timestamp: iso(t + 400), message: { role: 'user', content: step.task } }];
        const span = (end - t - 2000) / (step.work.length + 1);
        step.work.forEach((w, j) => {
          const at = Math.round(t + 1000 + span * j);
          const u = usageFor(j, rand);
          total += costOf(subModel, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: 0, reasoning: 0 }).usd;
          subRows.push({ ...sub, type: 'assistant', timestamp: iso(at), message: { id: `msg_sub_${i}_${j}`, role: 'assistant', model: subModel, content: [{ type: 'tool_use', id: `toolu_sub_${i}_${j}`, name: w.tool, input: w.input }], usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: 0 } } });
          subRows.push({ ...sub, type: 'user', timestamp: iso(at + Math.round(span * 0.6)), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_sub_${i}_${j}`, content: w.out }] } });
        });
        subRows.push({ ...sub, type: 'assistant', timestamp: iso(end - 500), message: { id: `msg_sub_${i}_end`, role: 'assistant', model: subModel, content: [{ type: 'text', text: step.result }], usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0 } } });
        children.push({ agentId, rows: subRows, meta: { agentType: step.agentType, description: step.description, toolUseId: id, spawnDepth: 1 } });
        break;
      }
    }
  });
  // Claude Code's cost-state is process-wide, so it includes the sub-agents' cost.
  rows.push({ type: 'cost-state', sessionId: sc.id, startTime: timed[0]?.t ?? 0, totalCostUSD: Math.round(total * 1e4) / 1e4, modelUsage: {} });
  const projectDir = join(dir, 'claude', 'projects', sc.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sc.id}.jsonl`), lines(rows));
  for (const child of children) {
    const subDir = join(projectDir, sc.id, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, `agent-${child.agentId}.jsonl`), lines(child.rows));
    writeFileSync(join(subDir, `agent-${child.agentId}.meta.json`), JSON.stringify(child.meta));
  }
}

// ---------- Codex ----------
function writeCodex(dir: string, sc: Scenario, timed: Timed[], rand: () => number): void {
  const start = timed[0]?.t ?? Date.now();
  const rows: unknown[] = [
    { timestamp: iso(start), type: 'session_meta', payload: { id: sc.id, cwd: sc.cwd, timestamp: iso(start), cli_version: '0.80.0', source: 'cli', model_provider: 'openai' } },
    { timestamp: iso(start), type: 'turn_context', payload: { model: sc.model, cwd: sc.cwd, approval_policy: 'on-request' } },
  ];
  let total = 0;
  let n = 0;
  const tokenCount = (t: number) => {
    const u = usageFor(n++, rand);
    const input = u.input + u.cacheRead;
    total += input + u.output;
    rows.push({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: u.cacheRead, output_tokens: u.output, reasoning_output_tokens: Math.round(u.output * 0.3) } } } });
  };
  const call = (t: number, end: number, id: string, cmd: string, out: string, codeN: number) => {
    rows.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command: ['bash', '-lc', cmd], workdir: sc.cwd }) } });
    rows.push({ timestamp: iso(end), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ output: out, metadata: { exit_code: codeN, duration_seconds: (end - t) / 1000 } }) } });
    tokenCount(end);
  };
  const patch = (t: number, end: number, id: string, body: string) => {
    rows.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: id, status: 'completed', input: body } });
    rows.push({ timestamp: iso(end), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: 'Success. Updated the following files.' } });
    tokenCount(end);
  };
  rows.push({ timestamp: iso(start), type: 'event_msg', payload: { type: 'task_started' } });
  timed.forEach(({ step, t, end }, i) => {
    const id = `call_demo_${i}`;
    switch (step.k) {
      case 'user':
        rows.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${sc.cwd}</cwd>\n</environment_context>` }, { type: 'input_text', text: step.text }] } });
        break;
      case 'think':
        rows.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: step.text }], encrypted_content: 'demo' } });
        break;
      case 'say':
        rows.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: step.text }] } });
        tokenCount(t);
        break;
      case 'read':
        call(t, end, id, `sed -n '1,200p' ${step.path}`, step.body, 0);
        break;
      case 'grep':
        call(t, end, id, `rg -n "${step.pattern}"`, step.hits, 0);
        break;
      case 'shell':
        call(t, end, id, step.cmd, step.out, step.code);
        break;
      case 'edit':
        patch(t, end, id, `*** Begin Patch\n*** Update File: ${step.path}\n@@\n${patchLines(step.before, step.after).join('\n')}\n*** End Patch`);
        break;
      case 'write':
        patch(t, end, id, `*** Begin Patch\n*** Add File: ${step.path}\n${step.body.replace(/\n$/, '').split('\n').map((l) => '+' + l).join('\n')}\n*** End Patch`);
        break;
      case 'compact':
        rows.push({ timestamp: iso(t), type: 'compacted', payload: { message: 'Conversation compacted' } });
        break;
    }
  });
  rows.push({ timestamp: iso(timed[timed.length - 1]?.end ?? start), type: 'event_msg', payload: { type: 'task_complete' } });
  const d = new Date(start);
  const folder = join(dir, 'codex', 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `rollout-${iso(start).slice(0, 19).replace(/:/g, '-')}-${sc.id}.jsonl`), lines(rows));
  // Codex keeps thread names in an index next to sessions/.
  appendFileSync(join(dir, 'codex', 'session_index.jsonl'), JSON.stringify({ id: sc.id, thread_name: sc.title, updated_at: iso(start) }) + '\n');
}

// ---------- DeepSeek Harness ----------
function writeDeepseek(dir: string, sc: Scenario, timed: Timed[], rand: () => number): void {
  let seq = 0;
  const ev = (time: number, type: string, data: unknown) => ({ seq: ++seq, time, type, data });
  const start = timed[0]?.t ?? Date.now();
  const rows: unknown[] = [{ type: 'session', id: sc.id, cwd: sc.cwd, createdAt: start, agentPreset: 'code', delegationDepth: 0, isSeeded: false, version: 4 }];
  rows.push(ev(start, 'turn/start', { turn: 1 }));
  let n = 0;
  const assistant = (t: number, content: unknown[]) => {
    const u = usageFor(n++, rand);
    rows.push(ev(t, 'assistant/message', { message: { id: `a${n}`, role: 'assistant', content, source: { kind: 'llm', model: sc.model, provider: 'deepseek' } }, usage: { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: 0, totalTokens: u.input + u.output + u.cacheRead } }));
  };
  timed.forEach(({ step, t, end }, i) => {
    const callId = `call_demo_${i}`;
    const sub = (name: string, args: unknown, out: string, isError = false) => {
      assistant(t, [{ type: 'tool-call', id: callId, name: 'run_code', arguments: JSON.stringify({ code: `await tools.${name}(${JSON.stringify(args)})`, description: name }) }]);
      rows.push(ev(t + 1, 'tool/call', { callId, name: 'run_code', arguments: JSON.stringify({ code: `await tools.${name}(...)`, description: name }) }));
      rows.push(ev(t + 5, 'tool/ptc-dispatch-start', { subCallId: `${callId}_s`, parentCallId: callId, rootCallId: callId, name, arguments: args }));
      rows.push(ev(end, 'tool/ptc-dispatch', { subCallId: `${callId}_s`, parentCallId: callId, rootCallId: callId, name, arguments: args, content: [{ type: 'text', text: out }], isError }));
      rows.push(ev(end + 5, 'tool/result', { message: { id: `r${i}`, role: 'tool', isError, toolCallId: callId, content: [{ type: 'text', text: out }], source: { kind: 'tool', callId } } }));
    };
    switch (step.k) {
      case 'user':
        rows.push(ev(t, 'user/message', { id: `u${i}`, role: 'user', content: [{ type: 'text', text: step.text }], source: { kind: 'user' } }));
        break;
      case 'think':
        assistant(t, [{ type: 'reasoning', text: step.text }]);
        break;
      case 'say':
        assistant(t, [{ type: 'text', text: step.text }]);
        break;
      case 'read':
        sub('read', { file_path: step.path }, step.body);
        break;
      case 'grep':
        sub('grep', { pattern: step.pattern, path: sc.cwd }, step.hits);
        break;
      case 'shell':
        sub('pwsh', { command: step.cmd, description: step.cmd.split(' ')[0] }, step.out, step.code !== 0);
        break;
      case 'edit':
        sub('edit', { file_path: step.path, old_string: step.before, new_string: step.after }, 'ok');
        break;
      case 'write':
        sub('write', { file_path: step.path, content: step.body }, 'ok');
        break;
      case 'compact':
        rows.push(ev(t, 'compaction/summary', { summary: 'Conversation compacted' }));
        break;
    }
    if (sc.uploaded && i % 3 === 2) rows.push(ev(end + 10, 'session-log-deepseek/delivery-accepted', { sessionId: sc.id, throughSeq: seq, sessionFormatVersion: 4 }));
  });
  rows.push(ev(timed[timed.length - 1]?.end ?? start, 'session/title', { title: sc.title, messageSeqs: [3], source: { kind: 'llm' } }));
  rows.push(ev(timed[timed.length - 1]?.end ?? start, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  const folder = join(dir, 'dsh', 'sessions', '--' + sc.cwd.replace(/[^A-Za-z0-9]/g, '-') + '--', `session-${sc.id}`);
  mkdirSync(folder, { recursive: true });
  // One zstd frame per event, like the real append-only log.
  writeFileSync(join(folder, 'session.v4.jsonl.zstd'), Buffer.concat(rows.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))));
}

// ---------- OpenCode ----------
function writeOpencode(dir: string, sc: Scenario, timed: Timed[], rand: () => number): void {
  const folder = join(dir, 'opencode');
  mkdirSync(folder, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(join(folder, 'opencode.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE IF NOT EXISTS message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE IF NOT EXISTS part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  const start = timed[0]?.t ?? Date.now();
  const end = timed[timed.length - 1]?.end ?? start;
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)').run(sc.id, 'demo', null, 'demo', sc.cwd, sc.title, '1.2.0', start, end);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  let mid = '';
  let k = 0;
  timed.forEach(({ step, t, end: e }, i) => {
    if (step.k === 'user') {
      mid = `m${i}`;
      msg.run(mid, sc.id, t, t, JSON.stringify({ role: 'user', time: { created: t } }));
      part.run(`p${k++}`, mid, sc.id, t, t, JSON.stringify({ type: 'text', text: step.text }));
      const u = usageFor(i, rand);
      mid = `m${i}a`;
      const cost = costOf(sc.model, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: 0, reasoning: 0 }).usd;
      msg.run(mid, sc.id, t + 500, end, JSON.stringify({ role: 'assistant', modelID: sc.model, providerID: 'moonshot', cost, time: { created: t + 500, completed: end }, tokens: { input: u.input, output: u.output, reasoning: 0, cache: { read: u.cacheRead, write: 0 } } }));
      return;
    }
    const data =
      step.k === 'think'
        ? { type: 'reasoning', text: step.text, time: { start: t } }
        : step.k === 'say'
          ? { type: 'text', text: step.text, time: { start: t } }
          : step.k === 'write'
            ? { type: 'tool', tool: 'write', callID: `c${i}`, state: { status: 'completed', input: { filePath: step.path, content: step.body }, output: 'Wrote file', metadata: {}, time: { start: t, end: e } } }
            : step.k === 'shell'
              ? { type: 'tool', tool: 'bash', callID: `c${i}`, state: step.code ? { status: 'error', input: { command: step.cmd }, error: step.out, time: { start: t, end: e } } : { status: 'completed', input: { command: step.cmd }, output: step.out, time: { start: t, end: e } } }
              : null;
    if (data) part.run(`p${k++}`, mid, sc.id, t, t, JSON.stringify(data));
  });
  db.close();
}

export interface DemoData {
  dir: string;
  roots: Record<AgentKind, string[]>;
}

/** Write the demo sessions (replacing any previous demo) and return where they are. */
export function writeDemo(dir = join(tmpdir(), 'agent-blackbox-demo'), now = Date.now()): DemoData {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const rand = rng(42);
  for (const sc of scenarios()) {
    const timed = schedule(sc, now, rand);
    if (sc.agent === 'claude-code') writeClaude(dir, sc, timed, rand);
    else if (sc.agent === 'codex') writeCodex(dir, sc, timed, rand);
    else if (sc.agent === 'deepseek-harness') writeDeepseek(dir, sc, timed, rand);
    else writeOpencode(dir, sc, timed, rand);
  }
  return {
    dir,
    roots: {
      'claude-code': [join(dir, 'claude', 'projects')],
      codex: [join(dir, 'codex', 'sessions')],
      opencode: [join(dir, 'opencode')],
      'deepseek-harness': [join(dir, 'dsh', 'sessions')],
    },
  };
}
