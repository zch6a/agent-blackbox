import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ADAPTERS, parseAgent } from './adapters/index.ts';
import { AmbiguousSessionError, cacheDir, discover, listSessions, loadSession, resolveSession, rootsFor, SessionNotFoundError, type CatalogOptions } from './catalog.ts';
import { writeDemo } from './demo.ts';
import { exportHtml, exportJson, exportMarkdown, type ExportFormat } from './export.ts';
import { c, money, parseSince, plural, setColor } from './format.ts';
import { PRICES_UPDATED } from './pricing.ts';
import { redactSession } from './redact.ts';
import { renderList, renderSession, renderStats } from './render/terminal.ts';
import { printPaged } from './pager.ts';
import { serve } from './server.ts';
import { hasSqlite } from './sqlite.ts';
import { aggregate, GROUPS, overview, type GroupBy } from './stats.ts';
import { AGENT_LABELS, type AgentKind, type Session, type SessionSummary } from './types.ts';
import { safeDeep, safeText, statSafe, tildify } from './util.ts';
import { VERSION } from './version.ts';
import { hasZstdSupport } from './zstd.ts';

const HELP = `${c.bold('agent-blackbox')} — a flight recorder for AI coding agents

${c.bold('Usage')}
  blackbox [command] [options]

${c.bold('Commands')}
  ui                 Open the local web UI (default)
  list               List recent sessions
  show <session>     Replay a session in the terminal
  stats              Cost, tokens and activity, grouped by day/agent/model/project/tool
  export <session>   Export a session as a self-contained HTML replay, Markdown or JSON
  doctor             Show which agents were found and where
  demo               Try the UI with fictional sample sessions (no agent needed)

  <session> is an id prefix (like git), a full id, ${c.cyan('last')}, or ${c.cyan('-2')} for the 2nd most recent.

${c.bold('Common options')}
  -a, --agent <name>     Only these agents: claude, codex, opencode, deepseek, gemini (repeatable or comma-separated)
      --root <a=path>    Read an agent's logs from another directory (repeatable)
      --since <when>     Only sessions since 7d, 24h, 2w, today, or a date (2026-11-01)
  -p, --project <text>   Only sessions whose working directory contains <text>
      --json             Machine-readable output
      --no-cache         Re-parse every log instead of using the summary cache
      --no-color         Disable colors (also respects NO_COLOR)
      --demo             Use the fictional demo sessions instead of your own logs

${c.bold('list')}       -n, --limit <n> (default 25)   --all   -q, --search <text>   --sort time|cost|tokens|tools   --subagents
${c.bold('show')}       --thinking   --full   --cost   --errors   --no-tools   --no-pager
${c.bold('stats')}      --by day|week|month|agent|model|project|tool (default agent)
${c.bold('export')}     -o, --output <file|->   -f, --format html|md|json   --redact   --thinking   --outputs   --no-subagents
${c.bold('ui')}         --port <n> (default 4777)   --no-open

${c.bold('Examples')}
  agent-blackbox                           open the UI
  blackbox list --since 7d --sort cost     the week's most expensive sessions
  blackbox show last --errors              only what went wrong in the last session
  blackbox stats --by day --since 30d      daily spend for the past month
  blackbox export last --redact            shareable HTML replay with secrets scrubbed

Everything runs locally. Nothing is uploaded anywhere.
`;

const OPTIONS = {
  agent: { type: 'string', short: 'a', multiple: true },
  root: { type: 'string', multiple: true },
  since: { type: 'string' },
  project: { type: 'string', short: 'p' },
  json: { type: 'boolean' },
  cache: { type: 'boolean', default: true },
  'no-cache': { type: 'boolean' },
  color: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  limit: { type: 'string', short: 'n' },
  all: { type: 'boolean' },
  search: { type: 'string', short: 'q' },
  sort: { type: 'string' },
  thinking: { type: 'boolean' },
  full: { type: 'boolean' },
  cost: { type: 'boolean' },
  errors: { type: 'boolean' },
  'no-tools': { type: 'boolean' },
  by: { type: 'string' },
  output: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f' },
  redact: { type: 'boolean' },
  outputs: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  open: { type: 'boolean', default: true },
  'no-open': { type: 'boolean' },
  subagents: { type: 'boolean' },
  'no-pager': { type: 'boolean' },
  'no-subagents': { type: 'boolean' },
  demo: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} satisfies ParseArgsConfig['options'];

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

class UsageError extends Error {}

/** Set by `--demo` / `blackbox demo`: every command reads the generated sample logs instead. */
let demoRoots: Partial<Record<AgentKind, string[]>> | null = null;

function catalogOptions(v: Values): CatalogOptions {
  const agents: AgentKind[] = [];
  for (const raw of v.agent ?? []) {
    for (const name of raw.split(',').filter(Boolean)) {
      const a = parseAgent(name);
      if (!a) throw new UsageError(`Unknown agent "${name}". Use one of: claude, codex, opencode, deepseek, gemini.`);
      agents.push(a);
    }
  }
  const roots: Partial<Record<AgentKind, string[]>> = demoRoots ? { ...demoRoots } : {};
  for (const r of v.root ?? []) {
    const i = r.indexOf('=');
    const a = i > 0 ? parseAgent(r.slice(0, i)) : null;
    if (!a) throw new UsageError(`--root expects agent=path, e.g. --root codex=/mnt/backup/.codex/sessions (got "${r}")`);
    (roots[a] ??= []).push(resolve(r.slice(i + 1)));
  }
  const progress = process.stderr.isTTY && !v.json;
  return {
    agents,
    roots,
    cache: !v['no-cache'] && v.cache !== false,
    onProgress: progress
      ? (done, total) => {
          if (total < 20) return;
          if (done === total) process.stderr.write('\r\x1b[K');
          else if (done % 5 === 0) process.stderr.write(`\r${c.dim(`Indexing sessions ${done}/${total}…`)}`);
        }
      : undefined,
  };
}

function filterSessions(list: SessionSummary[], v: Values): SessionSummary[] {
  let out = list;
  if (v.since) {
    const since = parseSince(v.since);
    if (since === null) throw new UsageError(`Cannot understand --since "${v.since}". Try 7d, 24h, 2w, today or 2026-11-01.`);
    out = out.filter((s) => s.endedAt >= since);
  }
  if (v.project) {
    const p = v.project.toLowerCase();
    out = out.filter((s) => s.cwd.toLowerCase().includes(p));
  }
  if (v.search) {
    const q = v.search.toLowerCase();
    out = out.filter((s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.toLowerCase().startsWith(q));
  }
  return out;
}

async function cmdList(v: Values): Promise<void> {
  let list = filterSessions(await listSessions(catalogOptions(v)), v);
  // Sub-agents are noise in a list of "what did I do"; their parents show a ⑂ count instead.
  const hidden = v.subagents ? 0 : list.filter((s) => s.parentKey).length;
  if (!v.subagents) list = list.filter((s) => !s.parentKey);
  const sort = v.sort ?? 'time';
  const sorters: Record<string, (a: SessionSummary, b: SessionSummary) => number> = {
    time: (a, b) => b.endedAt - a.endedAt,
    cost: (a, b) => b.cost.usd - a.cost.usd,
    tokens: (a, b) => b.usage.input + b.usage.output + b.usage.cacheRead - (a.usage.input + a.usage.output + a.usage.cacheRead),
    tools: (a, b) => b.toolCalls - a.toolCalls,
  };
  const sorter = sorters[sort];
  if (!sorter) throw new UsageError(`--sort must be one of: ${Object.keys(sorters).join(', ')}`);
  list = [...list].sort(sorter);
  const total = list.length;
  const limit = v.all ? Infinity : Number(v.limit ?? 25);
  if (!Number.isFinite(limit) && !v.all) throw new UsageError('--limit must be a number');
  list = list.slice(0, limit);
  if (v.json) {
    process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    return;
  }
  // Text from logs goes to the terminal with its control characters made visible (no escape sequences run).
  console.log(renderList(safeDeep(list)));
  const notes: string[] = [];
  if (total > list.length) notes.push(`${list.length} of ${total} sessions shown · --all or -n <count> for more`);
  if (hidden) notes.push(`${plural(hidden, 'sub-agent session')} hidden · --subagents to include`);
  if (notes.length) console.log(c.dim('\n' + notes.join('\n')));
  else if (!total) console.log(c.dim('\nRun `blackbox doctor` to see where agent-blackbox looked, or `blackbox demo` to try it on sample sessions.'));
}

async function cmdShow(v: Values, query: string | undefined): Promise<void> {
  const opts = catalogOptions(v);
  const ref = await resolveSession(query ?? 'last', opts);
  const [loaded, all] = await Promise.all([loadSession(ref), listSessions({ ...opts, onProgress: undefined })]);
  // Family links (children, cost inside parent) are computed across sessions, so take them from the list.
  const summary = all.find((s) => s.key === ref.key);
  const session = { ...loaded, ...(summary?.costInParent ? { costInParent: true } : {}), ...(summary?.children ? { children: summary.children } : {}) };
  if (v.json) {
    process.stdout.write(JSON.stringify(session, null, 2) + '\n');
    return;
  }
  await printPaged(
    renderSession(safeDeep(session), {
      thinking: !!v.thinking,
      full: !!v.full,
      cost: !!v.cost,
      errorsOnly: !!v.errors,
      noTools: !!v['no-tools'],
      children: safeDeep(all.filter((s) => s.parentKey === ref.key).sort((a, b) => a.startedAt - b.startedAt)),
    }),
    { enabled: !v['no-pager'] },
  );
}

async function cmdStats(v: Values): Promise<void> {
  const by = (v.by ?? 'agent') as GroupBy;
  if (!GROUPS.includes(by)) throw new UsageError(`--by must be one of: ${GROUPS.join(', ')}`);
  const list = filterSessions(await listSessions(catalogOptions(v)), v);
  if (v.json) {
    process.stdout.write(JSON.stringify({ overview: overview(list), by, rows: aggregate(list, by) }, null, 2) + '\n');
    return;
  }
  if (!list.length) {
    console.log(c.dim('No sessions match.'));
    return;
  }
  console.log(renderStats(safeDeep(list), by));
  console.log(c.dim(`\nCosts marked ~ are estimates from list prices (updated ${PRICES_UPDATED}). Override with ~/.config/agent-blackbox/pricing.json.`));
}

const COMMANDS = ['ui', 'open', 'list', 'ls', 'show', 'replay', 'stats', 'export', 'doctor', 'demo', 'help'];

/**
 * The command a word is probably a typo of (`stat` → stats, `lsit` → list), or null. Letters only: anything
 * with a digit (`de30c1a0`) is an id prefix, never a typo.
 */
export function closeCommand(word: string): string | null {
  const w = word.toLowerCase();
  if (!/^[a-z]{3,}$/.test(w) || COMMANDS.includes(w)) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const cmd of COMMANDS) {
    if (cmd.length < 3) continue;
    const d = distance(w, cmd);
    if (d < bestD) [best, bestD] = [cmd, d];
  }
  return bestD <= (w.length <= 4 ? 1 : 2) ? best : null;
}

/** Edit distance with transpositions (optimal string alignment). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'session'
  );
}

async function cmdExport(v: Values, query: string | undefined): Promise<void> {
  const opts = catalogOptions(v);
  const ref = await resolveSession(query ?? 'last', opts);
  const fromExt = v.output && v.output !== '-' ? extname(v.output).slice(1).toLowerCase() : '';
  const KNOWN: Record<string, ExportFormat> = { html: 'html', htm: 'html', md: 'md', markdown: 'md', json: 'json' };
  if (!v.format && fromExt && !KNOWN[fromExt]) throw new UsageError(`Cannot tell the format from "${v.output}": add --format html, md or json`);
  const format = v.format ?? (fromExt ? KNOWN[fromExt] : 'html');
  if (!format || !['html', 'md', 'json'].includes(format)) throw new UsageError('--format must be html, md or json');
  // Family links come from the list; an HTML export also carries the sub-agent sessions themselves.
  const all = await listSessions({ ...opts, onProgress: undefined });
  const withLinks = (s: Session): Session => {
    const sum = all.find((x) => x.key === s.key);
    return { ...s, ...(sum?.children ? { children: sum.children } : {}), ...(sum?.costInParent ? { costInParent: true } : {}) };
  };
  let session = withLinks(await loadSession(ref));
  const childRefs = format === 'html' && !v['no-subagents'] ? (await discover(opts)).filter((r) => all.some((s) => s.key === r.key && s.parentKey === ref.key)) : [];
  let children = await Promise.all(childRefs.map(async (r) => withLinks(await loadSession(r))));
  if (v.redact) {
    session = redactSession(session);
    children = children.map((c) => redactSession(c));
  }
  const body =
    format === 'html'
      ? await exportHtml(session, children)
      : format === 'md'
        ? exportMarkdown(safeDeep(session), { thinking: !!v.thinking, outputs: !!v.outputs })
        : exportJson(session);
  if (v.output === '-') {
    process.stdout.write(body);
    return;
  }
  const file = resolve(v.output ?? `${slug(session.title)}-${session.id.slice(0, 8)}.${format as ExportFormat}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  console.log(`${c.green('✓')} Exported ${c.bold(safeText(session.title))}${children.length ? c.dim(` with ${plural(children.length, 'sub-agent')}`) : ''} → ${file}`);
  if (!v.redact) console.log(c.dim('  Tip: add --redact to scrub API keys, tokens, e-mails and your home path before sharing.'));
  else console.log(c.dim('  Redaction is best-effort — skim the file before posting it publicly.'));
}

async function cmdDoctor(v: Values): Promise<void> {
  const opts = catalogOptions(v);
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const ok = (b: boolean) => (b ? c.green('✓') : c.red('✗'));
  console.log(`${c.bold('agent-blackbox')} ${VERSION} · Node.js ${process.versions.node} ${ok(major > 22 || (major === 22 && minor >= 15))}`);
  console.log(`  zstd support (DeepSeek Harness logs)  ${ok(hasZstdSupport())}`);
  console.log(`  SQLite support (OpenCode database)    ${ok(hasSqlite())}`);
  console.log(`  cache                                  ${tildify(cacheDir())}`);
  console.log('');
  const refs = await discover({ ...opts, onProgress: undefined });
  for (const adapter of ADAPTERS) {
    if (opts.agents?.length && !opts.agents.includes(adapter.agent)) continue;
    const count = refs.filter((r) => r.agent === adapter.agent).length;
    console.log(`${count ? c.green('●') : c.dim('○')} ${c.bold(AGENT_LABELS[adapter.agent])}  ${count ? `${count} sessions` : c.dim('no sessions found')}`);
    for (const root of rootsFor(adapter.agent, opts)) {
      const st = await statSafe(root);
      console.log(`    ${st ? c.green('found  ') : c.dim('missing')} ${tildify(root)}`);
    }
  }
  console.log(c.dim('\nUse --root <agent>=<path> to point at logs in another location.'));
}

async function cmdUi(v: Values): Promise<void> {
  const port = v.port !== undefined ? Number(v.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError('--port must be 0–65535');
  const host = v.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.log(c.yellow(`Warning: listening on ${host} exposes your agent logs to your network. Requests still need the session token.`));
  }
  const opts = catalogOptions(v);
  const { url, indexed } = await serve({
    ...opts,
    port,
    host,
    open: v.open !== false && !v['no-open'],
  });
  console.log(`${c.bold('agent-blackbox')} is running at ${c.cyan(url)}`);
  console.log(c.dim('Local only — your sessions never leave this machine. Press Ctrl+C to stop.'));
  const list = await indexed;
  const total = list.reduce((a, s) => a + s.cost.usd, 0);
  console.log(c.dim(`Indexed ${list.length} sessions · ${money(total)} total.`));
}

/**
 * "-2" is the 2nd most recent session, not an option, but parseArgs takes anything that starts with "-" for one
 * ("Unknown option '-2'"). Such tokens are moved after "--", where they are positionals, unless they are the value
 * of an option that takes one (`-n -2`).
 */
export function sessionShorthands(argv: string[]): string[] {
  const takesValue = new Set(Object.entries(OPTIONS).flatMap(([name, o]) =>
    o.type === 'string' ? [`--${name}`, ...('short' in o && o.short ? [`-${o.short}`] : [])] : []));
  const moved: string[] = [];
  const kept: string[] = [];
  argv.forEach((a, i) => (/^-\d+$/.test(a) && !takesValue.has(argv[i - 1] ?? '') ? moved : kept).push(a));
  if (!moved.length) return argv;
  const dashes = kept.indexOf('--');
  return dashes < 0 ? [...kept, '--', ...moved] : [...kept.slice(0, dashes + 1), ...moved, ...kept.slice(dashes + 1)];
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: sessionShorthands(argv), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(c.red((err as Error).message));
    console.error(c.dim('Run `blackbox --help` for usage.'));
    return 2;
  }
  const v = parsed.values;
  if (v['no-color']) setColor(false);
  else if (v.color) setColor(true);
  if (v.version) {
    console.log(VERSION);
    return 0;
  }
  let [cmd = 'ui', ...rest] = parsed.positionals;
  if (v.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'demo' || v.demo) {
    const demo = writeDemo();
    demoRoots = demo.roots;
    // Keep the demo's cache away from the real one.
    process.env.BLACKBOX_CACHE_DIR = join(demo.dir, '.cache');
    if (cmd === 'demo') {
      if (rest[0] === 'path') {
        console.log(demo.dir);
        return 0;
      }
      cmd = 'ui';
      console.log(c.dim(`Demo sessions are fictional and live in ${demo.dir}`));
    }
  }
  try {
    switch (cmd) {
      case 'ui':
      case 'open':
        await cmdUi(v);
        return -1; // keep running
      case 'list':
      case 'ls':
        await cmdList(v);
        return 0;
      case 'show':
      case 'replay':
        await cmdShow(v, rest[0]);
        return 0;
      case 'stats':
        await cmdStats(v);
        return 0;
      case 'export':
        await cmdExport(v, rest[0]);
        return 0;
      case 'doctor':
        await cmdDoctor(v);
        return 0;
      default: {
        // A typo of a command (`stat`, `lsit`) is a typo, not a session id.
        const near = closeCommand(cmd);
        if (near) {
          console.error(c.red(`Unknown command "${safeText(cmd)}".`) + ` Did you mean ${c.bold(`blackbox ${near}`)}?`);
          return 2;
        }
        // `blackbox <id>` is a shortcut for `blackbox show <id>`.
        if (rest.length === 0 && /^[\w:-]{4,}$/.test(cmd)) {
          try {
            await cmdShow(v, cmd);
          } catch (err) {
            if (!(err instanceof SessionNotFoundError)) throw err;
            console.error(c.yellow(`"${safeText(cmd)}" is neither a command nor a session.`) + c.dim(' Run `blackbox --help`, or `blackbox list` for session ids.'));
            return 2;
          }
          return 0;
        }
        console.error(c.red(`Unknown command "${safeText(cmd)}".`) + c.dim(' Run `blackbox --help`.'));
        return 2;
      }
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(c.red(err.message));
      return 2;
    }
    if (err instanceof AmbiguousSessionError) {
      console.error(c.yellow(err.message));
      for (const r of err.candidates) console.error(`  ${safeText(r.id)}  ${c.dim(AGENT_LABELS[r.agent])}`);
      return 1;
    }
    if (err instanceof SessionNotFoundError) {
      console.error(c.yellow(err.message));
      return 1;
    }
    if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') return 0;
    console.error(c.red('Error: ') + ((err as Error)?.stack ?? String(err)));
    return 1;
  }
}
