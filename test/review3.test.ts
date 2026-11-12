// The findings of the 2026-11 independent review, each reproduced and kept fixed. (The Markdown XSS is in
// markdown.test.ts.) Synthetic data only; fake secrets are obviously fake.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SessionBuilder } from '../src/builder.ts';
import { resolveSession } from '../src/catalog.ts';
import { closeCommand } from '../src/cli.ts';
import { errorBrief } from '../src/describe.ts';
import { makeRedactor, redactSession } from '../src/redact.ts';
import { hostAllowed, serverUrl } from '../src/server.ts';
import { aggregate, fillDays, projectName, type StatRow } from '../src/stats.ts';
import type { Session } from '../src/types.ts';
import { safeDeep, safeText, walk } from '../src/util.ts';
import './isolate.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src', 'bin.ts');
const dir = mkdtempSync(join(tmpdir(), 'blackbox-review3-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const ms = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

// A Gemini CLI session full of terminal escape sequences, as a tool or a web page could print them.
const ESC = '\u001b';
const NASTY = `${ESC}]0;pwned${ESC}\\ ${ESC}]52;c;ZmFrZQ==\u0007 ${ESC}]8;;https://evil.example/${ESC}\\click${ESC}]8;;${ESC}\\ ${ESC}[2J${ESC}[?1049h \u009b31m`;
function nastySession(root: string) {
  const chats = join(root, 'proj', 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(root, 'proj', '.project_root'), `/work/${ESC}[31mproj`);
  writeFileSync(join(chats, 'session-2026-11-10T10-00-e5ca9e00.jsonl'), jsonl([
    { sessionId: 'e5ca9e00-0000-4000-8000-000000000001', projectHash: 'h', startTime: '2026-11-10T10:00:00Z' },
    { id: 'u', timestamp: '2026-11-10T10:00:01Z', type: 'user', content: `fix it ${NASTY}` },
    { id: 'g', timestamp: '2026-11-10T10:00:02Z', type: 'gemini', content: `done ${NASTY}`, model: `gemini-2.5-pro${ESC}[0m`,
      toolCalls: [{ id: 'c', name: `run_shell_command${ESC}[8m`, args: { command: `ls ${NASTY}` }, status: 'error', timestamp: '2026-11-10T10:00:02Z',
        result: [{ functionResponse: { id: 'c', name: 'x', response: { error: `failed ${NASTY}` } } }] }] },
    { $set: { summary: `title ${NASTY}` } },
  ]));
}

describe('review 3: terminal output', () => {
  const root = join(dir, 'gemini-nasty');
  nastySession(root);
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args, '--root', `gemini=${root}`, '--no-pager'], { encoding: 'utf8', env: { ...process.env, BLACKBOX_CACHE_DIR: join(dir, 'cache') } });

  it('never passes an escape sequence from a log to the terminal', () => {
    for (const args of [['list', '--no-color'], ['show', 'e5ca9e00', '--full', '--no-color'], ['show', 'e5ca9e00', '--errors', '--no-color'], ['stats', '--by', 'tool', '--no-color'], ['stats', '--by', 'model', '--no-color'], ['export', 'e5ca9e00', '-f', 'md', '-o', '-']]) {
      const r = run(...args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /[\u001b\u0007\u009b]/, `${args.join(' ')} printed a control character`);
    }
    assert.match(run('show', 'e5ca9e00', '--full', '--no-color').stdout, /␛\]52;c;/, 'shown, visibly');
  });

  it('with colours on, the only escapes are its own colours', () => {
    const r = run('show', 'e5ca9e00', '--full', '--color');
    const escapes = r.stdout.match(/\u001b[^m]*m?/g) ?? [];
    assert.ok(escapes.length > 0);
    for (const e of escapes) assert.match(e, /^\u001b\[[0-9;]*m$/, JSON.stringify(e));
  });

  it('safeText and safeDeep', () => {
    assert.equal(safeText(`a${ESC}[2Jb\u0007c\u202ed\te\nf`), 'a␛[2Jb␇c\ufffdd\te\nf');
    const deep = safeDeep({ list: [`x${ESC}`], n: 1, ['__proto__']: `y${ESC}` } as Record<string, unknown>);
    assert.deepEqual(deep.list, ['x␛']);
    assert.equal(Object.getPrototypeOf(deep), Object.prototype, 'a "__proto__" key stays a key');
  });
});

describe('review 3: redaction', () => {
  const red = makeRedactor();
  it('stays linear on long runs (was 7.5 s for 100 KB of "a.")', () => {
    for (const input of ['a.'.repeat(50_000), 'x+'.repeat(500_000), 'a-b'.repeat(30_000), 'ab'.repeat(100_000) + '://', 'sk-' + 'a-'.repeat(50_000), 'password' + '='.repeat(50_000), `${'a'.repeat(100_000)}@${'b.'.repeat(50_000)}`]) {
      const t = ms(() => red(input));
      assert.ok(t < 800, `${t.toFixed(0)} ms for ${JSON.stringify(input.slice(0, 16))}…`);
    }
  });

  it('catches what it missed', () => {
    const cases: [string, RegExp][] = [
      [String.raw`{"input":"{\"api_key\": \"FAKEfakeFAKEfake1234\"}"}`, /\\"api_key\\": \\"\[REDACTED\]/],
      ['SECRET_KEY=FAKEfakeFAKEfake1234', /^SECRET_KEY=\[REDACTED\]$/],
      ['PGPASSWORD=FAKEfake99', /^PGPASSWORD=\[REDACTED\]$/],
      ['client_secret: FAKEfakeFAKE', /^client_secret: \[REDACTED\]$/],
      ['password=hunter2', /^password=\[REDACTED\]$/],
      ['Authorization: Token FAKEfakeFAKEfake1234abcd', /^Authorization: Token \[REDACTED\]$/],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKE\nMIIFAKE', /^\[REDACTED PRIVATE KEY\]$/],
      ['github_pat_FAKE1234567890FAKE1234_FAKEfake', /^\[REDACTED GITHUB TOKEN\]$/],
      ['sk-0123456789abcdef0123456789abcdef', /^\[REDACTED API KEY\]$/],
      ['GOCSPX-FAKEfakeFAKEfakeFAKEfake12', /^\[REDACTED GOOGLE OAUTH SECRET\]$/],
      ['https://hooks.slack.com/services/TFAKE0000/BFAKE0000/FAKEfakeFAKEfake', /^\[REDACTED SLACK WEBHOOK\]$/],
      ['postgres://admin:p@ss@db.example:5432/app', /^postgres:\/\/admin:\[REDACTED\]@db\.example:5432\/app$/],
      ['mail me at ana@example.com', /^mail me at \[REDACTED EMAIL\]$/],
    ];
    for (const [input, want] of cases) assert.match(red(input), want, input);
  });

  it('leaves code, branches, packages and remotes alone', () => {
    for (const s of ['const token = getToken(); const password = form.value;', 'password: process.env.DB_PASSWORD', 'git checkout sk-feature-login-flow-rewrite-v2', 'npm i @scope/sk-learn-wrapper-utilities', 'node_modules/foo@1.2.3.tgz', 'git@github.com:acme/app.git', 'react@18.3.1', 'max_tokens: 4096']) {
      assert.equal(red(s), s);
    }
  });

  it('redacts values by their key in parsed tool inputs', () => {
    const session = { title: 't', cwd: '', path: '', events: [{ kind: 'tool', t: 0, id: 'c', name: 'shell', isError: false, output: '', input: { command: 'psql', env: { PGPASSWORD: 'FAKEpass', HOME: '/x' }, password: 'short', token: 'abc', max_tokens: 'x' } }] } as unknown as Session;
    const input = (redactSession(session).events[0] as { input: Record<string, unknown> }).input;
    assert.deepEqual(input, { command: 'psql', env: { PGPASSWORD: '[REDACTED]', HOME: '/x' }, password: '[REDACTED]', token: '[REDACTED]', max_tokens: 'x' });
  });

  it('replaces the home folder only as a whole path component, and never "/"', () => {
    const r = makeRedactor({ emails: false, home: '/home/al' });
    assert.equal(r('/home/al/notes.txt and /home/alex/notes.txt'), '~/notes.txt and /home/alex/notes.txt');
    const root = makeRedactor({ emails: false, home: '/' });
    assert.equal(root('/workspace/app/src/main.ts https://example.com/docs'), '/workspace/app/src/main.ts https://example.com/docs');
    const win = makeRedactor({ emails: false, home: 'C:\\Users\\al' });
    assert.equal(win('C:\\Users\\al\\x.txt, C:/Users/al/y.txt, C:\\Users\\alex\\z.txt'), '~\\x.txt, ~/y.txt, C:\\Users\\alex\\z.txt');
  });
});

describe('review 3: the rest', () => {
  it('error briefs stay fast on long runs of spaces', () => {
    assert.ok(ms(() => errorBrief('exit code' + ' '.repeat(100_000) + 'x')) < 200);
    assert.equal(errorBrief('Exit code: 3'), 'exit 3');
    assert.equal(errorBrief('exit_code = 2'), 'exit 2');
  });

  it('follows symbolic links (and junctions), once each, and never a FIFO', async () => {
    const real = join(dir, 'real-project');
    const root = join(dir, 'links');
    mkdirSync(real, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(real, 'a.jsonl'), '{}\n');
    symlinkSync(real, join(root, 'linked'), 'junction');
    symlinkSync(root, join(real, 'loop'), 'junction'); // back up the tree
    const found = await walk(root, (n) => n.endsWith('.jsonl'));
    assert.deepEqual(found.map((f) => resolve(f).replace(/\\/g, '/').split('/').slice(-2).join('/')), ['linked/a.jsonl']);
  });

  it('a project name from either kind of path', () => {
    assert.equal(projectName('C:\\Users\\alice\\work\\api'), 'api');
    assert.equal(projectName('/home/a/web/'), 'web');
  });

  it('a long history keeps its newest days', () => {
    const rows = ['2024-01-01', '2026-11-10'].map((key) => ({ key, usd: key === '2026-11-10' ? 50 : 1 }) as unknown as StatRow);
    const days = fillDays(rows);
    assert.equal(days.length, 800);
    assert.equal(days.at(-1)?.key, '2026-11-10');
    assert.equal(days.at(-1)?.usd, 50);
    assert.deepEqual(fillDays(rows, 5000).map((r) => r.key).slice(0, 1), ['2024-01-01'], 'short enough: from the first day');
  });

  it('tool and model names that are Object.prototype members are just names', () => {
    const b = new SessionBuilder({ agent: 'codex', key: 'codex:p', path: '', id: 'p', mtimeMs: 0, sizeBytes: 0 });
    for (const name of ['constructor', 'toString', '__proto__']) b.result(b.tool(1, name, name, {}).id, 'x', name === 'toString', 2);
    b.usage(1, '__proto__', { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    const s = b.build();
    assert.equal(s.toolCounts.constructor, 1);
    assert.equal(s.toolErrorCounts.toString, 1);
    assert.equal(({} as Record<string, unknown>).usd, undefined, 'nothing written onto Object.prototype');
    for (const summary of [s, JSON.parse(JSON.stringify(s))]) {
      const rows = aggregate([summary], 'tool');
      assert.deepEqual(rows.map((r) => [r.key, r.toolCalls, r.toolErrors]).sort(), [['__proto__', 1, 0], ['constructor', 1, 0], ['toString', 1, 1]]);
      for (const r of rows) assert.ok(Number.isFinite(r.durationMs));
    }
  });

  it('the server: IPv6 URLs, and LAN addresses accepted only when bound to every interface', () => {
    assert.equal(serverUrl('::1', 4777), 'http://[::1]:4777/');
    assert.equal(serverUrl('0.0.0.0', 4777), 'http://127.0.0.1:4777/');
    assert.ok(hostAllowed('127.0.0.1:4777', '127.0.0.1', 4777));
    assert.ok(!hostAllowed('192.168.1.50:4777', '127.0.0.1', 4777));
    assert.ok(hostAllowed('192.168.1.50:4777', '0.0.0.0', 4777));
    assert.ok(hostAllowed('[fe80::1]:4777', '::', 4777));
    assert.ok(!hostAllowed('evil.example:4777', '0.0.0.0', 4777), 'a domain name is still refused: rebinding');
    assert.ok(!hostAllowed('192.168.1.50:9999', '0.0.0.0', 4777));
  });

  it('the UI decodes the address hash safely', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(join(ROOT, 'ui', 'app.js'), 'utf8');
    assert.equal(app.match(/decodeURIComponent\(/g)?.length, 1, 'only inside decodeKey, which catches');
  });

  it('the command line: typos, prefixes, formats', async () => {
    assert.equal(closeCommand('stat'), 'stats');
    assert.equal(closeCommand('lsit'), 'list');
    assert.equal(closeCommand('exprot'), 'export');
    assert.equal(closeCommand('de30'), null, 'an id prefix');
    assert.equal(closeCommand('banana'), null);
    const root = join(dir, 'gemini-two');
    nastySession(root);
    const other = join(root, 'proj', 'chats', 'session-2026-11-10T11-00-c0ffee00.jsonl');
    writeFileSync(other, jsonl([{ sessionId: 'c0ffee00-0000-4000-8000-000000000002', projectHash: 'h' }, { id: 'u', type: 'user', content: 'hi' }]));
    const opts = { roots: { 'gemini-cli': [root] }, cache: false } as const;
    await assert.rejects(resolveSession('g', opts), /No session matches/, '"g" is not a prefix of every gemini-cli: key');
    assert.equal((await resolveSession('gemini-cli:c0f', opts)).id, 'c0ffee00-0000-4000-8000-000000000002');
    const r = spawnSync(process.execPath, [BIN, 'export', 'c0ffee00', '-o', join(dir, 'out.txt'), '--root', `gemini=${root}`], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Cannot tell the format from .*out\.txt.*--format/);
    const typo = spawnSync(process.execPath, [BIN, 'stat', '--no-color'], { encoding: 'utf8' });
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /Did you mean blackbox stats\?/);
  });
});
