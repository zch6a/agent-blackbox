// The Agent Skill (plugin/skills/agent-blackbox/SKILL.md) and the Claude Code plugin around it: the format, and
// that every command the skill gives an AI works. Run on the fictional demo sessions (--demo), never on real logs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src', 'bin.ts');
const SKILL = readFileSync(join(ROOT, 'plugin', 'skills', 'agent-blackbox', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

function frontmatter(): Record<string, string> {
  const m = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m?.[1], 'the frontmatter starts on the first line');
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv?.[1]) out[kv[1]] = kv[2] ?? '';
  }
  return out;
}

test("the skill's frontmatter: portable fields only, within the limits", () => {
  const fm = frontmatter();
  assert.equal(fm.name, 'agent-blackbox');
  const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (const k of Object.keys(fm)) assert.ok(allowed.has(k), `${k} is a field every skill host accepts`);
  const description = fm.description ?? '';
  assert.ok(description.length > 100 && description.length <= 1536);
  assert.doesNotMatch(description, /[<>]/);
  assert.ok((fm.compatibility ?? '').length <= 500);
});

test('the plugin and its marketplace agree, and follow the package version', () => {
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(market.plugins?.[0]?.name, plugin.name);
  assert.ok(existsSync(join(ROOT, market.plugins[0].source, '.claude-plugin', 'plugin.json')));
  assert.equal(plugin.version, pkg.version);
});

test('every export the skill shows is redacted', () => {
  const exports = SKILL.split('\n').filter((l) => /\bexport\b/.test(l) && l.includes('agent-blackbox'));
  assert.ok(exports.length > 0);
  for (const l of exports) assert.match(l, /--redact/, l);
});

const PREFIX = 'npx -y github:zch6a/agent-blackbox';
function skillCommands(): string[][] {
  return [...SKILL.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((m) => (m[1] ?? '').split('\n'))
    .filter((l) => l.startsWith(PREFIX))
    .map((l) => l.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean));
}

test('every command the skill gives works (on the demo sessions)', () => {
  const commands = skillCommands();
  assert.deepEqual(commands.map((c) => c[0]), ['list', 'show', 'stats', 'export', 'doctor']);
  const [listCmd = [], showCmd = [], statsCmd = [], exportCmd = [], doctorCmd = []] = commands;
  const dir = mkdtempSync(join(tmpdir(), 'blackbox-skill-'));
  const env = { ...process.env, BLACKBOX_CACHE_DIR: join(dir, 'cache'), NO_COLOR: '1' };
  const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args, '--demo'], { encoding: 'utf8', env });
  try {
    const list = run(listCmd);
    assert.equal(list.status, 0, list.stderr);
    const sessions = JSON.parse(list.stdout);
    assert.ok(sessions.length >= 2);
    for (const k of ['key', 'agent', 'id', 'title', 'cwd', 'startedAt', 'endedAt', 'cost', 'toolCalls', 'toolErrors', 'filesChanged', 'linesAdded', 'linesRemoved', 'models']) {
      assert.ok(k in sessions[0], k);
    }
    const show = run(showCmd);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, new RegExp(sessions[1].title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '-2 is the second most recent');
    const stats = run(statsCmd);
    assert.equal(stats.status, 0, stats.stderr);
    JSON.parse(stats.stdout);
    const out = join(dir, 'session.html');
    const exp = run(exportCmd.map((a) => (a === 'session.html' ? out : a)));
    assert.equal(exp.status, 0, exp.stderr);
    assert.match(readFileSync(out, 'utf8'), /<html/i);
    assert.equal(run(doctorCmd).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
