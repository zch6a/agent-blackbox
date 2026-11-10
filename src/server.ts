import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discover, listSessions, loadSession, type CatalogOptions } from './catalog.ts';
import { scriptJson, toPayload } from './payload.ts';
import { PRICES_UPDATED } from './pricing.ts';
import { aggregate, GROUPS, overview, type GroupBy } from './stats.ts';
import { ownCost, type Session, type SessionSummary } from './types.ts';
import { uiFile } from './ui-assets.ts';
import { VERSION } from './version.ts';

export interface ServeOptions extends CatalogOptions {
  port?: number;
  host?: string;
  open?: boolean;
  /** Called once the server is listening. */
  onReady?: (url: string) => void;
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
};

/** Keep the last few parsed sessions in memory; big sessions take seconds to parse. */
class SessionCache {
  private readonly max: number;
  private readonly map = new Map<string, { mtimeMs: number; session: Session }>();
  constructor(max: number) {
    this.max = max;
  }
  get(key: string, mtimeMs: number): Session | undefined {
    const hit = this.map.get(key);
    if (!hit || hit.mtimeMs !== mtimeMs) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.session;
  }
  set(key: string, mtimeMs: number, session: Session): void {
    this.map.delete(key);
    this.map.set(key, { mtimeMs, session });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  res.end(body);
}

const json = (res: ServerResponse, value: unknown, status = 200) => send(res, status, JSON.stringify(value));

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser available (SSH session, container): the URL is printed anyway
  }
}

export interface RunningServer {
  url: string;
  /** Resolves when the first full index of all sessions is done. */
  indexed: Promise<SessionSummary[]>;
  close: () => Promise<void>;
}

export async function serve(opts: ServeOptions = {}): Promise<RunningServer> {
  const token = randomBytes(18).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  const sessions = new SessionCache(4);
  let summaries: SessionSummary[] | null = null;
  let summariesAt = 0;
  let inflight: Promise<SessionSummary[]> | null = null;
  const progress = { done: 0, total: 0, indexing: false };
  let port = 0;

  /** Single-flight: concurrent callers share one scan instead of parsing every log several times. */
  const getSummaries = (refresh: boolean): Promise<SessionSummary[]> => {
    const fresh = summaries && !refresh && Date.now() - summariesAt < 15_000;
    if (fresh) return Promise.resolve(summaries as SessionSummary[]);
    if (inflight) return inflight;
    progress.indexing = true;
    inflight = listSessions({
      ...opts,
      onProgress: (done, total) => {
        progress.done = done;
        progress.total = total;
        opts.onProgress?.(done, total);
      },
    })
      .then((list) => {
        summaries = list;
        summariesAt = Date.now();
        return list;
      })
      .finally(() => {
        inflight = null;
        progress.indexing = false;
      });
    // While a background rescan runs, keep serving the previous list.
    return summaries && !refresh ? Promise.resolve(summaries) : inflight;
  };

  const getSession = async (key: string): Promise<Session | null> => {
    const refs = await discover(opts);
    const ref = refs.find((r) => r.key === key);
    if (!ref) return null;
    const cached = sessions.get(key, ref.mtimeMs);
    if (cached) return cached;
    const s = await loadSession(ref);
    sessions.set(key, ref.mtimeMs, s);
    return s;
  };

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`]);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding protection: only answer requests addressed to our own loopback origin.
    if (!allowedHosts().has(String(req.headers.host ?? '').toLowerCase())) return send(res, 421, 'Misdirected request', 'text/plain');
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');

    if (path === '/' || path === '/index.html') {
      const html = (await readFile(uiFile('index.html'), 'utf8')).replace(
        '<!--BOOT-->',
        `<script>window.__BLACKBOX__=${scriptJson({ mode: 'live', token, version: VERSION, pricesUpdated: PRICES_UPDATED })}</script>`,
      );
      return send(res, 200, html, MIME['.html']);
    }
    if (path === '/app.js' || path === '/style.css' || path === '/favicon.svg') {
      const name = path.slice(1);
      return send(res, 200, await readFile(uiFile(name)), MIME[name.slice(name.lastIndexOf('.'))]);
    }

    if (!path.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain');
    if (req.headers['x-blackbox-token'] !== token) return json(res, { error: 'forbidden' }, 403);

    try {
      if (path === '/api/status') {
        return json(res, { ...progress, sessions: summaries?.length ?? null, version: VERSION });
      }
      if (path === '/api/sessions') {
        return json(res, { sessions: await getSummaries(url.searchParams.get('refresh') === '1') });
      }
      if (path === '/api/stats') {
        const all = await getSummaries(false);
        const since = Number(url.searchParams.get('since') ?? 0);
        const agent = url.searchParams.get('agent');
        // A session belongs to the range if it was active in it, not only if it started in it.
        const list = all.filter((s) => (!since || s.endedAt >= since) && (!agent || s.agent === agent));
        const groups: Partial<Record<GroupBy, ReturnType<typeof aggregate>>> = {};
        for (const by of GROUPS) groups[by] = aggregate(list, by, { fillGaps: true });
        const top = list
          .filter((s) => !s.costInParent)
          .sort((a, b) => ownCost(b) - ownCost(a))
          .slice(0, 12);
        return json(res, { overview: overview(list), groups, top });
      }
      const m = /^\/api\/session\/([^/]+)(?:\/event\/(\d+))?$/.exec(path);
      if (m) {
        const key = decodeURIComponent(m[1] ?? '');
        const s = await getSession(key);
        if (!s) return json(res, { error: 'not found' }, 404);
        if (m[2] !== undefined) {
          const ev = s.events[Number(m[2])];
          return ev ? json(res, ev) : json(res, { error: 'not found' }, 404);
        }
        return json(res, toPayload(s));
      }
      return json(res, { error: 'not found' }, 404);
    } catch (err) {
      return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, String(err), 'text/plain'));
  });

  await new Promise<void>((resolve, reject) => {
    const tryListen = (p: number, retry: boolean) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (retry && err.code === 'EADDRINUSE') tryListen(0, false);
        else reject(err);
      });
      server.listen(p, host, () => resolve());
    };
    tryListen(opts.port ?? 4777, opts.port === undefined);
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
  // Start indexing right away so the first page load is fast.
  const indexed = getSummaries(false);
  indexed.catch(() => {});
  // Keep the index fresh in the background so requests never wait for, or miss, new activity.
  // Unchanged files come from the cache, so a rescan is just a directory walk plus the logs that grew.
  const rescan = setInterval(() => {
    if (!inflight) getSummaries(true).catch(() => {});
  }, 15_000);
  rescan.unref();
  opts.onReady?.(url);
  if (opts.open) openBrowser(url);
  return {
    url,
    indexed,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(rescan);
        server.close(() => resolve());
      }),
  };
}
