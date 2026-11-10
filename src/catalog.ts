import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/** Bump when parsing changes in a way that invalidates cached summaries. */
const CACHE_SCHEMA = 4;

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
    if (parsed.schema === CACHE_SCHEMA && parsed.version === VERSION && parsed.entries) return parsed;
  } catch {
    // missing or corrupt cache: start fresh
  }
  return { schema: CACHE_SCHEMA, version: VERSION, entries: {} };
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

/** Summaries for every session, newest first. Unchanged files are served from the cache. */
export async function listSessions(opts: CatalogOptions = {}): Promise<SessionSummary[]> {
  const refs = await discover(opts);
  const useCache = opts.cache !== false;
  const cache = useCache ? await readCache() : { schema: CACHE_SCHEMA, version: VERSION, entries: {} as Record<string, CacheEntry> };
  let dirty = false;
  let done = 0;
  const summaries = await mapLimit(refs, 4, async (ref) => {
    const hit = cache.entries[ref.key];
    let summary: SessionSummary | null = null;
    if (hit && hit.mtimeMs === ref.mtimeMs && hit.sizeBytes === ref.sizeBytes && hit.summary.path === ref.path) {
      summary = hit.summary;
    } else {
      try {
        summary = summarize(await loadSession(ref));
        cache.entries[ref.key] = { mtimeMs: ref.mtimeMs, sizeBytes: ref.sizeBytes, summary };
        dirty = true;
      } catch {
        summary = null; // unreadable session: skip it rather than failing the whole list
      }
    }
    opts.onProgress?.(++done, refs.length);
    return summary;
  });
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
  return summaries.filter((s): s is SessionSummary => s !== null).sort((a, b) => b.endedAt - a.endedAt);
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
  if (!refs.length) throw new SessionNotFoundError('No sessions found. Run `blackbox doctor` to see where agent-blackbox looked.');
  const q = query.trim();
  const nth = /^(?:last|latest)$/i.test(q) ? 1 : /^-(\d+)$/.exec(q) ? Number(/^-(\d+)$/.exec(q)![1]) : 0;
  if (nth) {
    const ref = refs[nth - 1];
    if (!ref) throw new SessionNotFoundError(`Only ${refs.length} sessions exist.`);
    return ref;
  }
  const exact = refs.find((r) => r.key === q || r.id === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const matches = refs.filter((r) => r.id.toLowerCase().startsWith(lower) || r.key.toLowerCase().startsWith(lower));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new AmbiguousSessionError(`"${q}" matches ${matches.length} sessions; use a longer prefix.`, matches.slice(0, 10));
  throw new SessionNotFoundError(`No session matches "${q}". Try \`blackbox list\`.`);
}
