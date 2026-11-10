import { createRequire } from 'node:module';

/** Tiny wrapper over `node:sqlite` so the rest of the code never touches the experimental API directly. */
export interface SqliteDb {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
  close(): void;
}

interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}
type DatabaseCtor = new (path: string, opts?: { readOnly?: boolean }) => NodeSqliteDatabase;

let ctor: DatabaseCtor | null | undefined;

function loadCtor(): DatabaseCtor | null {
  if (ctor !== undefined) return ctor;
  // node:sqlite prints an ExperimentalWarning on first load; silence just that one.
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    ctor = (require('node:sqlite') as { DatabaseSync: DatabaseCtor }).DatabaseSync;
  } catch {
    ctor = null;
  } finally {
    process.emitWarning = original;
  }
  return ctor;
}

export function hasSqlite(): boolean {
  return loadCtor() !== null;
}

/** Open a database read-only. Returns null when node:sqlite is unavailable or the file cannot be opened. */
export function openSqlite(path: string): SqliteDb | null {
  const Database = loadCtor();
  if (!Database) return null;
  let db: NodeSqliteDatabase;
  try {
    db = new Database(path, { readOnly: true });
  } catch {
    return null;
  }
  return {
    all: (sql, ...params) => {
      try {
        return db.prepare(sql).all(...params) as Record<string, unknown>[];
      } catch {
        return [];
      }
    },
    get: (sql, ...params) => {
      try {
        return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    },
    close: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}
