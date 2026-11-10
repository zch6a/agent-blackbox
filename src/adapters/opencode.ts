import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionBuilder } from '../builder.ts';
import { fromUnifiedDiff, guessEdits } from '../edits.ts';
import type { Adapter, FileEdit, Session, SessionRef } from '../types.ts';
import { home, makeKey, num, obj, statSafe, str, tryJson } from '../util.ts';
import { openSqlite, type SqliteDb } from '../sqlite.ts';

/**
 * OpenCode (sst/opencode) stores everything in a SQLite database at
 * `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode`):
 * tables `session`, `message` (JSON `data` with role/model/cost/tokens) and
 * `part` (JSON `data`: text, reasoning, tool, step-finish, ...).
 *
 * Older releases wrote the same objects as JSON files under `storage/`:
 * `storage/session/<project>/<id>.json`, `storage/message/<session>/<id>.json`,
 * `storage/part/<message>/<id>.json`. Both layouts are supported.
 */
export const opencodeAdapter: Adapter = {
  agent: 'opencode',

  defaultRoots() {
    const xdg = process.env.XDG_DATA_HOME;
    const roots = [join(xdg || join(home(), '.local', 'share'), 'opencode')];
    if (process.platform === 'win32' && process.env.APPDATA) roots.push(join(process.env.APPDATA, 'opencode'));
    if (process.platform === 'darwin') roots.push(join(home(), 'Library', 'Application Support', 'opencode'));
    return [...new Set(roots)];
  },

  async discover(roots) {
    const refs: SessionRef[] = [];
    for (const root of roots) {
      const dbPath = join(root, 'opencode.db');
      const dbStat = await statSafe(dbPath);
      if (dbStat) {
        const db = openSqlite(dbPath);
        if (db) {
          try {
            refs.push(...discoverDb(db, dbPath));
          } finally {
            db.close();
          }
          continue;
        }
      }
      refs.push(...(await discoverLegacy(root)));
    }
    return refs;
  },

  async load(ref) {
    const [file, frag] = splitRef(ref.path);
    if (file.endsWith('.db')) {
      const db = openSqlite(file);
      if (!db) throw new Error('This Node.js version cannot read SQLite (node:sqlite needs Node 22.13+).');
      try {
        return loadDb(ref, db, frag);
      } finally {
        db.close();
      }
    }
    return loadLegacy(ref, file, frag);
  },
};

function splitRef(path: string): [string, string] {
  const i = path.lastIndexOf('#');
  return i === -1 ? [path, ''] : [path.slice(0, i), path.slice(i + 1)];
}

function discoverDb(db: SqliteDb, dbPath: string): SessionRef[] {
  const sizes = new Map<string, number>();
  for (const row of db.all('SELECT session_id AS id, SUM(LENGTH(data)) AS size FROM part GROUP BY session_id')) {
    sizes.set(str(row.id), num(row.size));
  }
  return db.all('SELECT id, time_updated FROM session').map((row) => {
    const id = str(row.id);
    return {
      agent: 'opencode' as const,
      key: makeKey('opencode', id),
      path: `${dbPath}#${id}`,
      id,
      mtimeMs: num(row.time_updated),
      sizeBytes: sizes.get(id) ?? 0,
    };
  });
}

interface RawSession {
  title: string;
  directory: string;
  parentId: string;
  created: number;
  updated: number;
}
interface RawMessage {
  id: string;
  data: Record<string, unknown>;
  parts: Record<string, unknown>[];
}

function loadDb(ref: SessionRef, db: SqliteDb, id: string): Session {
  const s = db.get('SELECT * FROM session WHERE id = ?', id);
  if (!s) throw new Error(`OpenCode session ${id} not found`);
  const messages: RawMessage[] = db.all('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id', id).map((m) => ({
    id: str(m.id),
    data: obj(tryJson(str(m.data))),
    parts: [],
  }));
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const p of db.all('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id', id)) {
    byId.get(str(p.message_id))?.parts.push(obj(tryJson(str(p.data))));
  }
  return buildOpencode(
    ref,
    { title: str(s.title), directory: str(s.directory), parentId: str(s.parent_id), created: num(s.time_created), updated: num(s.time_updated) },
    messages,
  );
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return obj(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return {};
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

async function discoverLegacy(root: string): Promise<SessionRef[]> {
  const sessionRoot = join(root, 'storage', 'session');
  const refs: SessionRef[] = [];
  let projects: string[] = [];
  try {
    projects = await readdir(sessionRoot);
  } catch {
    return refs;
  }
  for (const project of projects) {
    for (const file of await listJson(join(sessionRoot, project))) {
      const path = join(sessionRoot, project, file);
      const info = await readJson(path);
      const id = str(info.id) || file.replace(/\.json$/, '');
      const st = await statSafe(path);
      refs.push({
        agent: 'opencode',
        key: makeKey('opencode', id),
        path: `${root}#${id}`,
        id,
        mtimeMs: num(obj(info.time).updated) || st?.mtimeMs || 0,
        sizeBytes: st?.size ?? 0,
      });
    }
  }
  return refs;
}

async function loadLegacy(ref: SessionRef, root: string, id: string): Promise<Session> {
  const storage = join(root, 'storage');
  let info: Record<string, unknown> = {};
  try {
    for (const project of await readdir(join(storage, 'session'))) {
      const candidate = await readJson(join(storage, 'session', project, `${id}.json`));
      if (Object.keys(candidate).length) {
        info = candidate;
        break;
      }
    }
  } catch {
    // no session dir
  }
  const messages: RawMessage[] = [];
  for (const file of await listJson(join(storage, 'message', id))) {
    const data = await readJson(join(storage, 'message', id, file));
    const mid = str(data.id) || file.replace(/\.json$/, '');
    const parts: Record<string, unknown>[] = [];
    for (const pf of await listJson(join(storage, 'part', mid))) parts.push(await readJson(join(storage, 'part', mid, pf)));
    messages.push({ id: mid, data, parts });
  }
  messages.sort((a, b) => num(obj(a.data.time).created) - num(obj(b.data.time).created));
  const time = obj(info.time);
  return buildOpencode(
    ref,
    { title: str(info.title), directory: str(info.directory), parentId: str(info.parentID), created: num(time.created), updated: num(time.updated) },
    messages,
  );
}

function toolEdits(tool: string, state: Record<string, unknown>): FileEdit[] {
  const meta = obj(state.metadata);
  const input = state.input;
  const path = str(obj(input).filePath) || str(obj(input).path);
  if (typeof meta.diff === 'string' && meta.diff.includes('@@')) {
    const edits = fromUnifiedDiff(meta.diff, path);
    if (edits.length) return edits.map((e) => ({ ...e, path: path || e.path }));
  }
  const fd = obj(meta.filediff);
  if (Object.keys(fd).length && (typeof fd.additions === 'number' || typeof fd.deletions === 'number')) {
    return [{ path: str(fd.file) || path, op: 'modify', added: num(fd.additions), removed: num(fd.deletions) }];
  }
  return guessEdits(tool, input);
}

function buildOpencode(ref: SessionRef, s: RawSession, messages: RawMessage[]): Session {
  const b = new SessionBuilder(ref);
  b.title = s.title.replace(/^New session - \d{4}-\d{2}-\d{2}T[\d:.Z-]+$/, '');
  b.cwd = s.directory;
  if (s.parentId) b.parentKey = makeKey('opencode', s.parentId);
  b.touch(s.created);
  let allCostsRecorded = messages.some((m) => m.data.role === 'assistant');
  let recorded = 0;

  for (const m of messages) {
    const role = str(m.data.role);
    const time = obj(m.data.time);
    const t = num(time.created);
    const model = str(m.data.modelID);
    const textParts: string[] = [];
    let images = 0;

    for (const part of m.parts) {
      const type = str(part.type);
      const pt = num(obj(part.time).start) || t;
      if (type === 'text') {
        if (part.synthetic === true || part.ignored === true) continue;
        if (role === 'user') textParts.push(str(part.text));
        else b.assistant(pt, str(part.text), model);
      } else if (type === 'file') {
        if (/^image\//.test(str(part.mime))) images++;
        else if (role === 'user') textParts.push(`[file: ${str(part.filename) || str(part.url)}]`);
      } else if (type === 'reasoning') {
        b.thinking(pt, str(part.text));
      } else if (type === 'tool') {
        const state = obj(part.state);
        const st = obj(state.time);
        const name = str(part.tool);
        const id = str(part.callID) || str(part.id);
        b.tool(num(st.start) || pt, id, name, state.input);
        const status = str(state.status);
        if (status === 'completed' || status === 'error') {
          const isError = status === 'error';
          const output = isError ? str(state.error) : str(state.output);
          b.result(id, output, isError, num(st.end), isError ? undefined : toolEdits(name, state));
        }
      } else if (type === 'compaction') {
        b.compact(pt, 'Conversation compacted');
      } else if (type === 'subtask' || type === 'agent') {
        b.system(pt, `${type}: ${str(part.description) || str(part.name) || str(part.prompt)}`);
      }
    }

    if (role === 'user') {
      b.user(t, textParts.join('\n'), images, s.parentId ? 'agent' : undefined);
      continue;
    }
    if (role !== 'assistant') continue;

    const err = obj(m.data.error);
    if (Object.keys(err).length) {
      const data = obj(err.data);
      b.system(num(time.completed) || t, str(data.message) || str(err.name) || 'error', 'error');
    }
    const tokens = obj(m.data.tokens);
    const cache = obj(tokens.cache);
    const usage = {
      input: num(tokens.input),
      output: num(tokens.output),
      cacheRead: num(cache.read),
      cacheWrite: num(cache.write),
      reasoning: num(tokens.reasoning),
    };
    const cost = num(m.data.cost, NaN);
    if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
      // OpenCode bills reasoning separately from output for some providers; fold it in so costs line up.
      const billed = { ...usage, output: usage.output + usage.reasoning };
      b.usage(num(time.completed) || t, model, billed, Number.isFinite(cost) && cost > 0 ? { usd: cost } : {});
    }
    if (Number.isFinite(cost) && cost > 0) recorded += cost;
    else allCostsRecorded = false;
  }
  if (allCostsRecorded && recorded > 0) b.recordedCostUsd = recorded;
  b.touch(s.updated);
  return b.build();
}
