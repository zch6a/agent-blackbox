import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Stream a JSONL file line by line. Malformed lines are skipped, never fatal.
 * Lines starting with one of `skipPrefixes` are dropped *before* JSON.parse —
 * a big win for logs full of bookkeeping lines we never look at.
 */
export async function* readJsonl(path: string, skipPrefixes: readonly string[] = []): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  outer: for await (const line of rl) {
    for (const p of skipPrefixes) if (line.startsWith(p)) continue outer;
    const parsed = parseJsonLine(line);
    if (parsed) yield parsed;
  }
}

export function* parseJsonlText(text: string): Generator<Record<string, unknown>> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const parsed = parseJsonLine(text.slice(start, end));
    if (parsed) yield parsed;
    start = end + 1;
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function obj(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

/** Parse an ISO string or epoch (s or ms) into epoch ms; 0 when unknown. */
export function toMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

export function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return text;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

/** Recursively list files whose basename matches `test`, skipping unreadable dirs. */
export async function walk(root: string, test: (name: string) => boolean, maxDepth = 8): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < maxDepth && e.name !== 'node_modules') await visit(full, depth + 1);
        } else if (e.isFile() && test(e.name)) {
          out.push(full);
        }
      }),
    );
  }
  await visit(root, 0);
  return out;
}

export async function statSafe(path: string): Promise<{ mtimeMs: number; size: number; isDir: boolean } | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

export function home(): string {
  return process.env.BLACKBOX_HOME_OVERRIDE || homedir();
}

/** Replace the home directory prefix with `~` for display. */
export function tildify(p: string): string {
  const h = homedir();
  if (!p || !h) return p;
  const lower = process.platform === 'win32';
  const a = lower ? p.toLowerCase() : p;
  const b = lower ? h.toLowerCase() : h;
  if (a === b) return '~';
  if (a.startsWith(b + sep) || a.startsWith(b + '/')) return '~' + p.slice(h.length).replace(/\\/g, '/');
  return p;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Stable, URL-safe key for a session ref. */
export function makeKey(agent: string, id: string): string {
  return `${agent}:${id}`;
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
