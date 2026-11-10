import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { activeTime, SessionBuilder } from '../src/builder.ts';
import { errorBrief, toolBrief } from '../src/describe.ts';
import { fromApplyPatch, fromReplace, fromUnifiedDiff, fromWrite, guessEdits } from '../src/edits.ts';
import { duration, fit, money, parseSince, tokens, width } from '../src/format.ts';
import { scriptJson } from '../src/payload.ts';
import { costOf, priceFor, resetPricingCache } from '../src/pricing.ts';
import { makeRedactor } from '../src/redact.ts';
import { aggregate, overview } from '../src/stats.ts';
import { VERSION } from '../src/version.ts';
import { decompressZstdFrames, splitZstdFrames, ZstdFormatError } from '../src/zstd.ts';
import { ref, zstdFrames } from './helpers.ts';

describe('zstd frame splitting', () => {
  it('decodes every frame of a concatenated stream', () => {
    const buf = zstdFrames(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']);
    assert.equal(splitZstdFrames(buf).length, 3);
    assert.equal(decompressZstdFrames(buf), '{"a":1}\n{"b":2}\n{"c":3}\n');
  });

  it('handles large multi-block frames', () => {
    const big = 'x'.repeat(300_000) + '\n' + JSON.stringify({ n: Math.random() }).repeat(5000);
    const buf = Buffer.concat([zlib.zstdCompressSync(Buffer.from(big)), zlib.zstdCompressSync(Buffer.from('tail'))]);
    assert.equal(decompressZstdFrames(buf), big + 'tail');
  });

  it('ignores a truncated frame that is still being written', () => {
    const full = zstdFrames(['one\n', 'two\n']);
    const partial = zlib.zstdCompressSync(Buffer.from('three-'.repeat(100)));
    const buf = Buffer.concat([full, partial.subarray(0, partial.length - 5)]);
    assert.equal(decompressZstdFrames(buf), 'one\ntwo\n');
  });

  it('skips skippable frames', () => {
    const skip = Buffer.alloc(12);
    skip.writeUInt32LE(0x184d2a50, 0);
    skip.writeUInt32LE(4, 4);
    const buf = Buffer.concat([zstdFrames(['a']), skip, zstdFrames(['b'])]);
    assert.equal(decompressZstdFrames(buf), 'ab');
  });

  it('rejects data that is not zstd', () => {
    assert.throws(() => splitZstdFrames(Buffer.from('hello world')), ZstdFormatError);
  });
});

describe('edits', () => {
  it('parses apply_patch envelopes including moves and deletes', () => {
    const edits = fromApplyPatch('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n+z\n*** Delete File: c.ts\n*** End Patch');
    assert.deepEqual(
      edits.map((e) => [e.path, e.op, e.added, e.removed]),
      [
        ['b.ts', 'modify', 2, 1],
        ['c.ts', 'delete', 0, 0],
      ],
    );
  });

  it('parses unified diffs', () => {
    const edits = fromUnifiedDiff('Index: x\n===\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n');
    assert.deepEqual(
      edits.map((e) => [e.path, e.added, e.removed]),
      [['src/x.ts', 1, 1]],
    );
  });

  it('trims common context from string replacements', () => {
    const e = fromReplace('f', 'a\nb\nc\nd', 'a\nB\nc\nd');
    assert.equal(e.added, 1);
    assert.equal(e.removed, 1);
    assert.match(e.diff!, /-b\n\+B/);
  });

  it('counts lines of a new file', () => {
    assert.equal(fromWrite('f', 'a\nb\n').added, 2);
    assert.equal(fromWrite('f', '').added, 0);
  });

  it('guesses edits from common tool conventions', () => {
    assert.equal(guessEdits('write', { file_path: 'a', content: 'x\ny' })[0]?.added, 2);
    assert.equal(guessEdits('edit', { filePath: 'a', oldString: 'x', newString: 'y' })[0]?.removed, 1);
    assert.equal(guessEdits('mcp__fs__write_file', { path: 'a', content: 'x' }).length, 1);
    assert.equal(guessEdits('read', { file_path: 'a' }).length, 0);
    assert.equal(guessEdits('bash', { command: 'echo hi > a' }).length, 0);
  });
});

describe('pricing', () => {
  it('matches model ids with provider prefixes and dates', () => {
    assert.equal(priceFor('claude-opus-5-5')?.input, 4);
    assert.equal(priceFor('anthropic/claude-sonnet-5-5@20260901')?.output, 10);
    assert.equal(priceFor('gpt-5.5')?.cacheRead, 0.5);
    assert.equal(priceFor('DeepSeek-V4.1-Flash-1017')?.input, 0.3);
    assert.equal(priceFor('totally-unknown-model'), null);
  });

  it('bills 1-hour cache writes at 2x input', () => {
    const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, reasoning: 0 };
    assert.equal(costOf('claude-opus-5-5', u).usd, 5); // 5m writes: 1.25x
    assert.equal(costOf('claude-opus-5-5', u, { cacheWrite1h: 1_000_000 }).usd, 8); // 1h writes: 2x
  });

  it('lets users override prices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-price-'));
    const file = join(dir, 'pricing.json');
    writeFileSync(file, JSON.stringify({ 'my-model': { input: 1, output: 2 }, 'claude-opus': { input: 100, output: 100 } }));
    process.env.BLACKBOX_PRICING = file;
    resetPricingCache();
    try {
      assert.equal(priceFor('my-model-v2')?.output, 2);
      assert.equal(priceFor('my-model-v2')?.cacheRead, 0.1);
      assert.equal(priceFor('claude-opus-5-5')?.input, 100);
    } finally {
      delete process.env.BLACKBOX_PRICING;
      resetPricingCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('builder', () => {
  it('pairs tool results with calls and ignores orphans', () => {
    const b = new SessionBuilder(ref('codex', 'x'));
    b.tool(1000, 'a', 'shell', { command: 'ls' });
    b.result('a', 'ok', false, 3000);
    b.result('missing', 'nobody asked', false, 4000);
    const s = b.build();
    assert.equal(s.toolCalls, 1);
    const t = s.events[0];
    assert.ok(t && t.kind === 'tool' && t.endT === 3000);
  });

  it('measures active time without idle gaps', () => {
    const ev = [0, 60_000, 120_000, 120_000 + 3 * 3600_000].map((t) => ({ kind: 'user' as const, t: t + 1, text: 'x' }));
    assert.equal(activeTime(ev), 120_000 + 5 * 60_000);
  });

  it('marks costs partial when a model has no price', () => {
    const b = new SessionBuilder(ref('codex', 'x'));
    b.usage(1, 'gpt-5.5', { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    b.usage(2, 'secret-internal-model', { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    assert.equal(b.build().cost.source, 'partial');
  });

  it('clips gigantic tool output', () => {
    const b = new SessionBuilder(ref('codex', 'x'));
    b.tool(1, 'a', 'shell', {});
    b.result('a', 'y'.repeat(100_000), false);
    const t = b.build().events[0];
    assert.ok(t && t.kind === 'tool' && t.output.length < 21_000 && t.output.includes('truncated'));
  });
});

describe('formatting', () => {
  it('measures CJK and emoji width', () => {
    assert.equal(width('abc'), 3);
    assert.equal(width('整理笔记'), 8);
    assert.equal(width('\x1b[31mred\x1b[39m'), 3);
    assert.equal(width(fit('整理笔记目录很长的标题', 9)), 9);
  });

  it('formats money, tokens and durations', () => {
    assert.equal(money(0), '$0');
    assert.equal(money(0.004), '<$0.01');
    assert.equal(money(12.345), '$12.35');
    assert.equal(money(12345), '$12,345');
    assert.equal(tokens(999), '999');
    assert.equal(tokens(1500), '1.5k');
    assert.equal(tokens(2_500_000), '2.50M');
    assert.equal(duration(65_000), '1m 05s');
    assert.equal(duration(0), '—');
  });

  it('parses --since values', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    assert.equal(parseSince('7d', now), now - 7 * 86400e3);
    assert.equal(parseSince('12h', now), now - 12 * 3600e3);
    assert.equal(parseSince('2026-11-01', now), Date.parse('2026-11-01'));
    assert.equal(parseSince('soon', now), null);
  });
});

describe('describe', () => {
  it('summarises tool inputs', () => {
    assert.equal(toolBrief('Bash', { command: 'npm   test\n --watch' }), 'npm test --watch');
    assert.equal(toolBrief('Read', { file_path: '/x/a.ts', offset: 10, limit: 20 }), '/x/a.ts:10-29');
    assert.equal(toolBrief('Grep', { pattern: 'TODO', path: 'src' }), 'TODO in src');
    assert.equal(toolBrief('apply_patch', '*** Begin Patch\n*** Update File: a.ts\n'), 'patch a.ts');
    assert.equal(toolBrief('x', { foo: 1 }), '{"foo":1}');
  });

  it('extracts short failure reasons', () => {
    assert.equal(errorBrief('blah\nexit code 2'), 'exit 2');
    assert.equal(errorBrief('ok\nError: ENOENT no such file'), 'Error: ENOENT no such file');
  });
});

describe('redaction', () => {
  it('scrubs common secrets', () => {
    const r = makeRedactor({ paths: false });
    const out = r(
      [
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
        'AKIAABCDEFGHIJKLMNOP',
        'Authorization: Bearer abcdefghijklmnop1234567890',
        'password = "hunter2hunter2"',
        'postgres://admin:s3cr3tpass@db:5432/x',
        'me@example.com',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      ].join('\n'),
    );
    for (const secret of ['abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', 'hunter2hunter2', 's3cr3tpass', 'me@example.com', 'dozjgNryP4J3']) {
      assert.ok(!out.includes(secret), `leaked ${secret}\n${out}`);
    }
    assert.ok(out.includes('postgres://admin:[REDACTED]@db'));
  });
});

describe('payload', () => {
  it('escapes JSON for inline <script> tags', () => {
    const s = scriptJson({ a: '</script><img src=x onerror=alert(1)>&' + String.fromCharCode(0x2028) });
    assert.ok(!s.includes('<') && !s.includes('>') && !s.includes('&'));
    assert.deepEqual(JSON.parse(s), { a: '</script><img src=x onerror=alert(1)>&' + String.fromCharCode(0x2028) });
  });
});

describe('stats', () => {
  it('aggregates by model with recorded costs spread proportionally', () => {
    const b = new SessionBuilder(ref('claude-code', 'x'));
    b.usage(1, 'claude-opus-5-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }); // $4 est
    b.usage(2, 'claude-haiku-5-5', { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }); // $1 est
    b.recordedCostUsd = 10;
    const s = b.build();
    const rows = aggregate([s], 'model');
    assert.deepEqual(
      rows.map((r) => [r.key, Number(r.usd.toFixed(6))]),
      [
        ['claude-opus-5-5', 8],
        ['claude-haiku-5-5', 2],
      ],
    );
    assert.equal(overview([s]).usd, 10);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });
});
