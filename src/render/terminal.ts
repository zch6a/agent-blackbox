import { errorBrief, toolBrief } from '../describe.ts';
import { ago, bar, c, clock, duration, fit, localDate, money, pad as padTo, plural, table, tokens, width } from '../format.ts';
import { activeDuration, aggregate, overview, projectName, wallDuration, type GroupBy, type StatRow } from '../stats.ts';
import { AGENT_LABELS, totalTokens, type Cost, type Session, type SessionEvent, type SessionSummary } from '../types.ts';
import { oneLine, tildify } from '../util.ts';

const AGENT_SHORT: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  'deepseek-harness': 'deepseek',
  'gemini-cli': 'gemini',
};

const AGENT_COLOR: Record<string, (s: string) => string> = {
  'claude-code': c.yellow,
  codex: c.cyan,
  opencode: c.magenta,
  'deepseek-harness': c.blue,
  'gemini-cli': c.green,
};

export function costLabel(cost: Cost): string {
  if (cost.source === 'unknown') return c.dim('—');
  const m = money(cost.usd);
  if (cost.source === 'recorded' || cost.usd < 0.01) return m;
  return cost.source === 'partial' ? `~${m}+` : `~${m}`;
}

function shortId(id: string, len = 8): string {
  return id.slice(0, len);
}

/**
 * Shortest prefix (at least 8 chars) that tells every id apart — like git's
 * abbreviated hashes. Time-ordered UUIDv7 ids (Codex) often share 8+ chars.
 */
export function uniquePrefixLength(ids: string[], min = 8): number {
  const sorted = [...new Set(ids)].sort();
  let need = min;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1] as string;
    const b = sorted[i] as string;
    let common = 0;
    while (common < a.length && a[common] === b[common]) common++;
    need = Math.max(need, common + 1);
  }
  return Math.min(need, 36);
}

export function renderList(sessions: SessionSummary[]): string {
  if (!sessions.length) return c.dim('No sessions match.');
  const idLen = uniquePrefixLength(sessions.map((s) => s.id));
  const rows = sessions.map((s) => {
    const flags = [
      s.flags.includes('log-uploaded') ? c.red('↑') : '',
      s.children ? c.cyan(`⑂${s.children}`) : '',
      s.flags.includes('subagent') ? c.dim('↳') : '',
      s.toolErrors ? c.red(`✗${s.toolErrors}`) : '',
    ]
      .filter(Boolean)
      .join(' ');
    return [
      c.dim(shortId(s.id, idLen)),
      (AGENT_COLOR[s.agent] ?? ((x: string) => x))(AGENT_SHORT[s.agent] ?? s.agent),
      ago(s.endedAt),
      duration(activeDuration(s)),
      s.costInParent ? c.dim('(in parent)') : costLabel(s.cost),
      tokens(totalTokens(s.usage)),
      String(s.toolCalls),
      flags,
      fit(oneLine(s.title), 80),
      c.dim(projectName(s.cwd)),
    ];
  });
  return table(
    [
      { header: 'ID' },
      { header: 'AGENT' },
      { header: 'WHEN' },
      { header: 'TOOK', align: 'right' },
      { header: 'COST', align: 'right' },
      { header: 'TOKENS', align: 'right' },
      { header: 'TOOLS', align: 'right' },
      { header: '' },
      { header: 'TITLE', flex: true, min: 20 },
      { header: 'PROJECT' },
    ],
    rows,
  );
}

export interface ShowOptions {
  thinking?: boolean;
  full?: boolean;
  cost?: boolean;
  errorsOnly?: boolean;
  /** Hide tool calls (just the conversation). */
  noTools?: boolean;
  /** Sub-agent sessions spawned by this one (linked to the tool call that started them). */
  children?: SessionSummary[];
}

function indentBody(text: string, full: boolean, pad: string, maxLines = 4): string {
  const lines = text.replace(/\r/g, '').trimEnd().split('\n');
  const shown = full ? lines : lines.slice(0, maxLines);
  const cols = (process.stdout.columns || 120) - width(pad) - 1;
  const out = shown.map((l, i) => (i === 0 ? '' : pad) + (full ? l : fit(l, cols)));
  if (!full && lines.length > maxLines) out.push(pad + c.dim(`… ${lines.length - maxLines} more lines (use --full)`));
  return out.join('\n');
}

export function renderHeader(s: SessionSummary): string {
  const u = s.usage;
  const promptTok = u.input + u.cacheRead + u.cacheWrite;
  const cached = promptTok ? Math.round((u.cacheRead / promptTok) * 100) : 0;
  const lines = [
    `${c.bold(AGENT_LABELS[s.agent])} ${c.dim('·')} ${c.bold(oneLine(s.title))}`,
    c.dim(
      [
        tildify(s.cwd) || '(no cwd)',
        `${localDate(s.startedAt)} ${clock(s.startedAt)} → ${s.endedAt - s.startedAt > 86400_000 ? localDate(s.endedAt) + ' ' : ''}${clock(s.endedAt)} (${duration(activeDuration(s))} active${wallDuration(s) - activeDuration(s) > 60_000 ? ` over ${duration(wallDuration(s))}` : ''})`,
        s.models.join(', ') || 'unknown model',
      ].join(' · '),
    ),
    [
      costLabel(s.cost) + c.dim(s.cost.source === 'unknown' ? '' : ` ${s.cost.source}`),
      `${tokens(totalTokens(u))} tokens${promptTok ? c.dim(` (${cached}% cached)`) : ''}`,
      plural(s.prompts, 'prompt'),
      plural(s.toolCalls, 'tool call') + (s.toolErrors ? c.red(` (${s.toolErrors} failed)`) : ''),
      s.filesChanged ? `${plural(s.filesChanged, 'file')} ${c.green('+' + s.linesAdded)} ${c.red('−' + s.linesRemoved)}` : '',
    ]
      .filter(Boolean)
      .join(c.dim(' · ')),
  ];
  if (s.parentKey) {
    const parentId = s.parentKey.slice(s.parentKey.indexOf(':') + 1);
    lines.push(c.dim(`↳ Sub-agent${s.agentName ? ` (${s.agentName})` : ''} of ${parentId}${s.costInParent ? ' — its cost is included in the parent’s' : ''}`));
  }
  if (s.flags.includes('log-uploaded')) lines.push(c.red('↑ This session log was uploaded to the DeepSeek API (session-log delivery was enabled).'));
  if (s.flags.includes('incomplete')) lines.push(c.yellow('… The log ends mid-turn (still running, interrupted or crashed).'));
  return lines.join('\n');
}

export function renderSession(s: Session, opts: ShowOptions = {}): string {
  const out: string[] = [renderHeader(s), ''];
  const pad = ' '.repeat(21);
  let turnCost = 0;
  const childByTool = new Map((opts.children ?? []).filter((ch) => ch.parentToolId).map((ch) => [ch.parentToolId as string, ch]));
  for (const ev of s.events as SessionEvent[]) {
    const time = c.dim(clock(ev.t));
    switch (ev.kind) {
      case 'user':
        if (opts.errorsOnly) break;
        if (turnCost && opts.cost) out.push(`${pad}${c.dim(`turn cost ${money(turnCost)}`)}`);
        turnCost = 0;
        out.push('');
        out.push(`${time}  ${ev.from === 'agent' ? c.magenta(c.bold('❯ task')) + ' ' : c.green(c.bold('❯ you')) + '  '}   ${indentBody(ev.text + (ev.images ? ` [${ev.images} image${ev.images > 1 ? 's' : ''}]` : ''), !!opts.full, pad, 8)}`);
        break;
      case 'assistant':
        if (opts.errorsOnly) break;
        out.push(`${time}  ${c.blue('● agent')}   ${indentBody(ev.text, !!opts.full, pad, opts.full ? 1e9 : 6)}`);
        break;
      case 'thinking':
        if (!opts.thinking || opts.errorsOnly) break;
        out.push(`${time}  ${c.dim(c.italic('∴ thinks'))}  ${c.dim(c.italic(indentBody(ev.text, !!opts.full, pad, 3)))}`);
        break;
      case 'tool': {
        if (opts.noTools) break;
        if (opts.errorsOnly && !ev.isError) break;
        const status = ev.isError ? c.red('✗ ' + errorBrief(ev.output, ev.exitCode)) : ev.output || ev.endT ? c.green('✓') : c.yellow('…');
        const took = ev.endT && ev.endT > ev.t ? c.dim(' ' + duration(ev.endT - ev.t)) : '';
        const edits = (ev.edits ?? []).map((e) => `${c.green('+' + e.added)} ${c.red('−' + e.removed)}`).join(' ');
        const nest = ev.parentId ? c.dim('↳ ') : '';
        const name = fit(ev.name.replace(/^mcp__.*__/, ''), 13);
        const brief = toolBrief(ev.name, ev.input, 200);
        const budget = (process.stdout.columns || 120) - 21 - width(nest) - 17 - width(edits) - 2;
        out.push(`${time}  ${c.magenta('⚙')} ${nest}${c.magenta(padTo(name, 13))} ${fit(brief, Math.max(20, budget))}${edits ? '  ' + edits : ''}  ${status}${took}`);
        const spawned = childByTool.get(ev.id);
        if (spawned) out.push(`${pad}${c.cyan('⑂ sub-agent')} ${c.dim(spawned.id)}  ${fit(oneLine(spawned.title), 60)}  ${c.dim(`${spawned.toolCalls} tools · ${spawned.costInParent ? 'cost in parent' : costLabel(spawned.cost)}`)}`);
        if (opts.full && ev.edits) for (const e of ev.edits) if (e.diff) out.push(colorDiff(e.diff, pad));
        if (ev.isError && (opts.full || opts.errorsOnly)) out.push(pad + c.red(indentBody(ev.output, !!opts.full, pad, 6)));
        break;
      }
      case 'usage':
        turnCost += ev.usd;
        if (opts.cost && !opts.errorsOnly) {
          out.push(`${time}  ${c.dim('$ ' + (ev.priced ? money(ev.usd) : '?').padEnd(8) + tokens(totalTokens(ev.usage)) + ' tok · ' + ev.model)}`);
        }
        break;
      case 'system':
        if (opts.errorsOnly && ev.level !== 'error') break;
        out.push(`${time}  ${ev.level === 'error' ? c.red('! error') : ev.level === 'warning' ? c.yellow('! note ') : c.dim('· info ')}   ${c.dim(indentBody(ev.text, !!opts.full, pad, 2))}`);
        break;
      case 'compact':
        if (opts.errorsOnly) break;
        out.push(`${time}  ${c.yellow('⇣ context compacted')}`);
        break;
    }
  }
  if (turnCost && opts.cost) out.push(`${pad}${c.dim(`turn cost ${money(turnCost)}`)}`);
  const kids = opts.children ?? [];
  if (kids.length && !opts.errorsOnly) {
    out.push('', c.bold(`Sub-agents (${kids.length})`) + c.dim('  — open one with `blackbox show <id>`'));
    const idLen = uniquePrefixLength(kids.map((k) => k.id), 12);
    for (const k of kids) {
      out.push(
        `  ${c.dim(shortId(k.id, idLen))}  ${padTo(fit(k.agentName ?? '', 14), 14)}  ${fit(oneLine(k.title), 56)}  ${c.dim(`${k.toolCalls} tools${k.toolErrors ? ` (${k.toolErrors} failed)` : ''} · ${k.costInParent ? 'cost in parent' : costLabel(k.cost)}`)}`,
      );
    }
  }
  return out.join('\n');
}

export function colorDiff(diff: string, pad: string): string {
  return diff
    .split('\n')
    .map((l) => pad + (l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : c.dim(l)))
    .join('\n');
}

export function renderStats(sessions: SessionSummary[], by: GroupBy): string {
  const o = overview(sessions);
  const out: string[] = [];
  out.push(
    `${c.bold(money(o.usd))} across ${c.bold(plural(o.sessions, 'session'))}${o.subagents ? c.dim(` (+${plural(o.subagents, 'sub-agent')})`) : ''} · ${tokens(totalTokens(o.usage))} tokens · ${Math.round(o.cacheHitRate * 100)}% cache hits · ${o.prompts} prompts · ${o.toolCalls} tool calls (${o.toolCalls ? ((o.toolErrors / o.toolCalls) * 100).toFixed(1) : 0}% failed)`,
  );
  out.push(
    c.dim(
      `${o.filesChanged} file changes (+${o.linesAdded} −${o.linesRemoved}) · ${duration(o.durationMs)} of agent time · ${money(o.costPerPrompt)} per prompt · ${Math.round(o.recordedShare * 100)}% of cost recorded by the agents, rest estimated`,
    ),
  );
  if (o.uploadedSessions) {
    const what = o.uploadedSessions === 1 ? '1 DeepSeek Harness session had its log' : `${o.uploadedSessions} DeepSeek Harness sessions had their logs`;
    out.push(c.red(`↑ ${what} uploaded to the DeepSeek API.`));
  }
  out.push('');
  const rows = aggregate(sessions, by);
  if (by === 'tool') {
    const max = Math.max(...rows.map((r) => r.toolCalls), 1);
    out.push(
      table(
        [
          { header: 'TOOL', flex: true },
          { header: 'CALLS', align: 'right' },
          { header: 'FAILED', align: 'right' },
          { header: 'TIME', align: 'right' },
          { header: 'AVG', align: 'right' },
          { header: 'SESSIONS', align: 'right' },
          { header: '' },
        ],
        rows
          .slice(0, 40)
          .map((r) => [
            r.key,
            String(r.toolCalls),
            r.toolErrors ? c.red(`${r.toolErrors} (${((r.toolErrors / r.toolCalls) * 100).toFixed(0)}%)`) : c.dim('—'),
            duration(r.durationMs),
            r.durationMs ? duration(r.durationMs / r.toolCalls) : '—',
            String(r.sessions),
            c.magenta(bar(r.toolCalls, max, 24)),
          ]),
      ),
    );
    if (o.toolMs) out.push(c.dim(`\nTools ran for ${duration(o.toolMs)} in total (parallel calls count separately) over ${duration(o.durationMs)} of active time.`));
    return out.join('\n');
  }
  const max = Math.max(...rows.map((r) => r.usd), 0.0001);
  const fmt = (r: StatRow) => [
    r.key,
    String(r.sessions),
    money(r.usd),
    tokens(r.tokens),
    by === 'model' ? '' : String(r.prompts),
    by === 'model' ? '' : String(r.toolCalls),
    c.cyan(bar(r.usd, max, 28)),
  ];
  out.push(
    table(
      [
        { header: by.toUpperCase(), flex: true, min: 10 },
        { header: 'SESSIONS', align: 'right' },
        { header: 'COST', align: 'right' },
        { header: 'TOKENS', align: 'right' },
        { header: by === 'model' ? '' : 'PROMPTS', align: 'right' },
        { header: by === 'model' ? '' : 'TOOLS', align: 'right' },
        { header: '' },
      ],
      rows.map(fmt),
    ),
  );
  if (o.mostExpensive) {
    out.push('');
    out.push(c.dim(`Most expensive: ${money(o.mostExpensive.cost.usd)} — ${fit(oneLine(o.mostExpensive.title), 70)} (${shortId(o.mostExpensive.id)})`));
  }
  return out.join('\n');
}
