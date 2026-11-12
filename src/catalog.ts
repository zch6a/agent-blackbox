import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ADAPTERS, adapterFor } from './adapters/index.ts';
import type { AgentKind, Session, SessionRef, SessionSummary } from './types.ts';
import { home, mapLimit } from './util.ts';
import { VERSION } from './version.ts';

export interface CatalogOptions {
  agents?: AgentKind[];
  /** Override the search roots per agent (from `--root agent=path` or env). */
  roots?: Partial<Record<AgentKind, string[]>>;
  /** Use the on-disk summary cache (default true). */
  cache?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Bump when the cache file layout changes. */
const CACHE_SCHEMA = 6;

let fingerprint: string | undefined;

/**
 * Cached summaries are only valid for the exact parsing code that produced
 * them. Hashing the parser sources means any change — a release or a local
 * edit — invalidates the cache automatically, instead of relying on someone
 * remembering to bump a number.
 */
function parserFingerprint(): string {
  if (fingerprint) return fingerprint;
  const here = dirname(fileURLToPath(import.meta.url));
  const hash = createHash('sha1').update(VERSION);
  const files: string[] = [];
  for (const dir of [here, join(here, 'adapters')]) {
    try {
      for (const name of readdirSync(dir).sort()) if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) files.push(join(dir, name));
    } catch {
      // unreadable install dir: fall back to the version alone
    }
  }
  for (const file of files) {
    try {
      hash.update(file.slice(here.length)).update(readFileSync(file));
    } catch {
      // ignore
    }
  }
  fingerprint = `${VERSION}+${hash.digest('hex').slice(0, 12)}`;
  return fingerprint;
}

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  summary: SessionSummary;
}
interface CacheFile {
  schema: number;
  version: string;
  entries: Record<string, CacheEntry>;
}

export function cacheDir(): string {
  if (process.env.BLACKBOX_CACHE_DIR) return process.env.BLACKBOX_CACHE_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(home(), 'AppData', 'Local'), 'agent-blackbox', 'cache');
  if (process.platform === 'darwin') return join(home(), 'Library', 'Caches', 'agent-blackbox');
  return join(process.env.XDG_CACHE_HOME || join(home(), '.cache'), 'agent-blackbox');
}

function cachePath(): string {
  return join(cacheDir(), 'index.json');
}

async function readCache(): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), 'utf8')) as CacheFile;
    if (parsed.schema === CACHE_SCHEMA && parsed.version === parserFingerprint() && parsed.entries) return parsed;
  } catch {
    // missing or corrupt cache: start fresh
  }
  return { schema: CACHE_SCHEMA, version: parserFingerprint(), entries: {} };
}

async function writeCache(cache: CacheFile): Promise<void> {
  const path = cachePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, path);
  } catch {
    // A read-only home directory should never break the tool.
  }
}

export function rootsFor(agent: AgentKind, opts: CatalogOptions = {}): string[] {
  return opts.roots?.[agent] ?? adapterFor(agent).defaultRoots();
}

/** Find every session on disk. The same native id seen twice (e.g. archived copy) keeps the newest file. */
export async function discover(opts: CatalogOptions = {}): Promise<SessionRef[]> {
  const agents = opts.agents?.length ? opts.agents : ADAPTERS.map((a) => a.agent);
  const lists = await Promise.all(
    agents.map(async (agent) => {
      try {
        return await adapterFor(agent).discover(rootsFor(agent, opts));
      } catch {
        return [];
      }
    }),
  );
  const byKey = new Map<string, SessionRef>();
  for (const ref of lists.flat()) {
    const prev = byKey.get(ref.key);
    if (!prev || ref.mtimeMs > prev.mtimeMs) byKey.set(ref.key, ref);
  }
  return [...byKey.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function loadSession(ref: SessionRef): Promise<Session> {
  return adapterFor(ref.agent).load(ref);
}

export function summarize(session: Session): SessionSummary {
  const { events: _events, ...summary } = session;
  return summary;
}

/** Below this much uncached data, starting worker threads costs more than it saves. */
const WORKER_THRESHOLD_BYTES = 48 * 1024 * 1024;

/**
 * Parse sessions on a small pool of worker threads, biggest files first so the
 * pool does not end up waiting on one huge log. Returns the indices that still
 * need parsing in the main thread (none if everything went well; all of them
 * when the pool is not worth starting or workers are unavailable).
 */
async function parseInWorkers(
  refs: SessionRef[],
  onSummary: (k: number, s: SessionSummary) => void,
  onError: (k: number) => void,
): Promise<number[]> {
  const all = refs.map((_, k) => k);
  const bytes = refs.reduce((a, r) => a + r.sizeBytes, 0);
  const size = Math.min(refs.length, Math.max(2, availableParallelism() - 1), 6);
  const threshold = Number(process.env.BLACKBOX_WORKER_MIN_BYTES ?? WORKER_THRESHOLD_BYTES);
  if (process.env.BLACKBOX_NO_WORKERS || bytes < threshold || size < 2) return all;
  const script = new URL(`./index-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);
  const order = [...all].sort((a, b) => refs[b]!.sizeBytes - refs[a]!.sizeBytes);
  const finished = new Set<number>();
  let next = 0;
  await new Promise<void>((resolve) => {
    let alive = size;
    const retire = () => {
      if (--alive === 0) resolve();
    };
    for (let w = 0; w < size; w++) {
      let worker: Worker;
      try {
        worker = new Worker(script);
      } catch {
        retire();
        continue;
      }
      const feed = () => {
        if (next >= order.length) {
          void worker.terminate();
          return;
        }
        const k = order[next++]!;
        worker.postMessage({ i: k, ref: refs[k] });
      };
      worker.on('message', (m: { i: number; summary?: SessionSummary; error?: string }) => {
        finished.add(m.i);
        if (m.summary) onSummary(m.i, m.summary);
        else onError(m.i);
        feed();
      });
      // A crashed worker exits; the job it was on is not in `finished` and gets retried in the main thread.
      worker.on('error', () => {});
      worker.on('exit', retire);
      feed();
    }
  });
  return all.filter((k) => !finished.has(k));
}

/** Summaries for every session, newest first. Unchanged files are served from the cache. */
export async function listSessions(opts: CatalogOptions = {}): Promise<SessionSummary[]> {
  const refs = await discover(opts);
  const useCache = opts.cache !== false;
  const cache = useCache ? await readCache() : { schema: CACHE_SCHEMA, version: parserFingerprint(), entries: {} as Record<string, CacheEntry> };
  let dirty = false;
  let done = 0;
  const summaries: (SessionSummary | null)[] = new Array(refs.length).fill(null);
  const todo: number[] = [];
  refs.forEach((ref, i) => {
    const hit = cache.entries[ref.key];
    if (hit && hit.mtimeMs === ref.mtimeMs && hit.sizeBytes === ref.sizeBytes && hit.summary.path === ref.path) {
      summaries[i] = hit.summary;
      done++;
    } else {
      todo.push(i);
    }
  });
  if (done) opts.onProgress?.(done, refs.length);
  const store = (i: number, summary: SessionSummary | null) => {
    const ref = refs[i]!;
    summaries[i] = summary;
    if (summary) {
      cache.entries[ref.key] = { mtimeMs: ref.mtimeMs, sizeBytes: ref.sizeBytes, summary };
      dirty = true;
    }
    opts.onProgress?.(++done, refs.length);
  };
  const failed = new Set<number>();
  const pending = await parseInWorkers(
    todo.map((i) => refs[i]!),
    (k, summary) => store(todo[k]!, summary),
    (k) => failed.add(todo[k]!),
  );
  // Whatever the workers did not finish (or when workers are not worth it) is parsed here.
  await mapLimit(
    pending.map((k) => todo[k]!).filter((i) => !failed.has(i)),
    4,
    async (i) => {
      try {
        store(i, summarize(await loadSession(refs[i]!)));
      } catch {
        store(i, null); // unreadable session: skip it rather than failing the whole list
      }
    },
  );
  if (useCache) {
    // Drop entries for sessions that no longer exist.
    const live = new Set(refs.map((r) => r.key));
    for (const key of Object.keys(cache.entries)) {
      if (!live.has(key) && (!opts.agents?.length || opts.agents.includes(cache.entries[key]!.summary.agent))) {
        delete cache.entries[key];
        dirty = true;
      }
    }
    if (dirty) await writeCache(cache);
  }
  return linkFamilies(summaries.filter((s): s is SessionSummary => s !== null)).sort((a, b) => b.endedAt - a.endedAt);
}

/**
 * Connect sub-agent sessions to their parents: count children, and mark
 * children whose cost is already inside the parent's recorded total
 * (Claude Code's `cost-state` is process-wide, so it includes its sub-agents).
 */
export function linkFamilies(list: SessionSummary[]): SessionSummary[] {
  const byKey = new Map(list.map((s) => [s.key, s]));
  const children = new Map<string, number>();
  for (const s of list) if (s.parentKey) children.set(s.parentKey, (children.get(s.parentKey) ?? 0) + 1);
  const root = (s: SessionSummary): SessionSummary => {
    let cur = s;
    for (let i = 0; i < 8 && cur.parentKey; i++) {
      const up = byKey.get(cur.parentKey);
      if (!up) break;
      cur = up;
    }
    return cur;
  };
  return list.map((s) => {
    const { children: _c, costInParent: _p, ...out } = s;
    const linked: SessionSummary = out;
    const n = children.get(s.key);
    if (n) linked.children = n;
    if (s.parentKey) {
      const top = root(s);
      if (top !== s && top.agent === 'claude-code') {
        const since = top.cost.recordedSince;
        // Inside the parent's recorded total only if it ran while the parent was recording costs.
        const covered = since !== undefined ? s.startedAt >= since : top.cost.source === 'recorded';
        if (covered) linked.costInParent = true;
      }
    }
    return linked;
  });
}

export class SessionNotFoundError extends Error {}
export class AmbiguousSessionError extends Error {
  readonly candidates: SessionRef[];
  constructor(message: string, candidates: SessionRef[]) {
    super(message);
    this.candidates = candidates;
  }
}

/**
 * Resolve a user-supplied session reference:
 * `last` / `latest` / `-1`, `-2` … (n-th most recent), a full key (`codex:<id>`),
 * or a unique id prefix (like git commit hashes).
 */
export async function resolveSession(query: string, opts: CatalogOptions = {}): Promise<SessionRef> {
  const refs = await discover(opts);
  if (!refs.length) throw new SessionNotFoundError('No sessions found. Run `blackbox doctor` to see where agent-blackbox looked, or `blackbox demo` to try it on sample sessions.');
  const q = query.trim();
  const nth = /^(?:last|latest)$/i.test(q) ? 1 : /^-(\d+)$/.exec(q) ? Number(/^-(\d+)$/.exec(q)![1]) : 0;
  if (nth) {
    // "last" means the last session a human ran, not the sub-agent that happened to finish last.
    const top = (await listSessions({ ...opts, onProgress: undefined })).filter((s) => !s.parentKey);
    const pick = top[nth - 1];
    const ref = pick && refs.find((r) => r.key === pick.key);
    if (!ref) throw new SessionNotFoundError(`Only ${top.length} sessions exist.`);
    return ref;
  }
  const exact = refs.find((r) => r.key === q || r.id === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  // A key prefix only when the query names the agent (`codex:019a`): every key starts with its agent's name, so
  // `c` or `claude` would otherwise match all of that agent's sessions.
  const matches = refs.filter((r) => r.id.toLowerCase().startsWith(lower) || (lower.includes(':') && r.key.toLowerCase().startsWith(lower)));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new AmbiguousSessionError(`"${q}" matches ${matches.length} sessions; use a longer prefix.`, matches.slice(0, 10));
  throw new SessionNotFoundError(`No session matches "${q}". Try \`blackbox list\`.`);
}
