import { basename } from 'node:path';
import { localDate } from './format.ts';
import { AGENT_LABELS, addUsage, emptyUsage, ownCost, totalTokens, type SessionSummary, type Usage } from './types.ts';

export const GROUPS = ['day', 'week', 'month', 'agent', 'model', 'project', 'tool'] as const;
export type GroupBy = (typeof GROUPS)[number];

export interface StatRow {
  key: string;
  sessions: number;
  usd: number;
  tokens: number;
  prompts: number;
  toolCalls: number;
  toolErrors: number;
  linesAdded: number;
  linesRemoved: number;
  durationMs: number;
}

function row(key: string): StatRow {
  return { key, sessions: 0, usd: 0, tokens: 0, prompts: 0, toolCalls: 0, toolErrors: 0, linesAdded: 0, linesRemoved: 0, durationMs: 0 };
}

/** Time actually spent working (idle gaps excluded); falls back to wall-clock span for old cache entries. */
export function activeDuration(s: SessionSummary): number {
  return typeof s.activeMs === 'number' ? s.activeMs : Math.max(0, s.endedAt - s.startedAt);
}

export function wallDuration(s: SessionSummary): number {
  return Math.max(0, s.endedAt - s.startedAt);
}

export function projectName(cwd: string): string {
  if (!cwd) return '(unknown)';
  return basename(cwd.replace(/[\\/]+$/, '')) || cwd;
}

/** One key per directory: `F:\a\b`, `F:/a/b/` and `f:\a\b` are the same project. */
function dirKey(cwd: string): string {
  const p = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
}

/**
 * Short, unique labels for project directories: the folder name, plus as many
 * parent folders as needed when two different directories share a name
 * (`work/api` vs `personal/api`).
 */
export function projectLabels(cwds: string[]): Map<string, string> {
  const dirs = new Map<string, string[]>(); // key -> path segments
  for (const cwd of cwds) {
    if (!cwd) continue;
    const key = dirKey(cwd);
    if (!dirs.has(key)) dirs.set(key, cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean));
  }
  const depth = new Map<string, number>([...dirs.keys()].map((k) => [k, 1]));
  const label = (k: string) => (dirs.get(k) ?? []).slice(-(depth.get(k) ?? 1)).join('/');
  for (let round = 0; round < 6; round++) {
    const byLabel = new Map<string, string[]>();
    for (const k of dirs.keys()) byLabel.set(label(k), [...(byLabel.get(label(k)) ?? []), k]);
    let changed = false;
    for (const keys of byLabel.values()) {
      if (keys.length < 2) continue;
      for (const k of keys) {
        if ((depth.get(k) ?? 1) < (dirs.get(k)?.length ?? 1)) {
          depth.set(k, (depth.get(k) ?? 1) + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const out = new Map<string, string>();
  for (const cwd of cwds) out.set(cwd, cwd ? label(dirKey(cwd)) || cwd : '(unknown)');
  return out;
}

function weekKey(ms: number): string {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return localDate(d.getTime());
}

function add(r: StatRow, s: SessionSummary, share = 1): void {
  // Sub-agents add their tokens, tools and (unless already inside the parent) cost — but are not extra sessions.
  if (!s.parentKey) r.sessions += 1;
  r.usd += ownCost(s) * share;
  r.tokens += totalTokens(s.usage) * share;
  r.prompts += s.prompts;
  r.toolCalls += s.toolCalls;
  r.toolErrors += s.toolErrors;
  r.linesAdded += s.linesAdded;
  r.linesRemoved += s.linesRemoved;
  r.durationMs += activeDuration(s);
}

/** Insert empty rows for days without sessions so a chart's time axis is continuous. */
export function fillDays(rows: StatRow[], maxDays = 800): StatRow[] {
  const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  if (sorted.length < 2) return sorted;
  const byKey = new Map(sorted.map((r) => [r.key, r]));
  const [y, m, d] = (sorted[0] as StatRow).key.split('-').map(Number) as [number, number, number];
  const last = (sorted[sorted.length - 1] as StatRow).key;
  const out: StatRow[] = [];
  const cur = new Date(y, m - 1, d, 12); // noon: immune to DST jumps
  for (let i = 0; i < maxDays; i++) {
    const key = localDate(cur.getTime());
    out.push(byKey.get(key) ?? row(key));
    if (key >= last) break;
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export function aggregate(sessions: SessionSummary[], by: GroupBy, opts: { fillGaps?: boolean } = {}): StatRow[] {
  const rows = new Map<string, StatRow>();
  let labels: Map<string, string> | undefined;
  // A recorded cost covers a whole family (parent + sub-agents whose cost is inside it).
  // Spread it over every member's models in proportion to their estimated cost.
  const estOf = (s: SessionSummary) => Object.values(s.modelUsage).reduce((a, m) => a + m.usd, 0);
  const family = new Map<string, number>();
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  for (const s of sessions) {
    if (s.costInParent && s.parentKey) family.set(s.parentKey, (family.get(s.parentKey) ?? 0) + estOf(s));
  }
  const scale = (s: SessionSummary): number => {
    const owner = s.costInParent && s.parentKey ? byKey.get(s.parentKey) : s;
    if (!owner) return s.costInParent ? 0 : 1;
    const est = estOf(owner) + (family.get(owner.key) ?? 0);
    return est > 0 ? owner.cost.usd / est : s.costInParent ? 0 : 1;
  };
  const get = (k: string) => {
    let r = rows.get(k);
    if (!r) rows.set(k, (r = row(k)));
    return r;
  };
  for (const s of sessions) {
    switch (by) {
      case 'day':
        add(get(localDate(s.startedAt)), s);
        break;
      case 'week':
        add(get(weekKey(s.startedAt)), s);
        break;
      case 'month':
        add(get(localDate(s.startedAt).slice(0, 7)), s);
        break;
      case 'agent':
        add(get(AGENT_LABELS[s.agent]), s);
        break;
      case 'project':
        add(get((labels ??= projectLabels(sessions.map((x) => x.cwd))).get(s.cwd) ?? projectName(s.cwd)), s);
        break;
      case 'model': {
        const entries = Object.entries(s.modelUsage);
        if (!entries.length) {
          add(get('(no usage data)'), s);
          break;
        }
        const k = scale(s);
        for (const [model, m] of entries) {
          const r = get(model);
          r.sessions += 1;
          r.usd += m.usd * k;
          r.tokens += m.tokens;
        }
        break;
      }
      case 'tool':
        for (const [tool, n] of Object.entries(s.toolCounts)) {
          const r = get(tool);
          r.sessions += 1;
          r.toolCalls += n;
        }
        break;
    }
  }
  const list = [...rows.values()];
  if (by === 'day' && opts.fillGaps) return fillDays(list);
  if (by === 'day' || by === 'week' || by === 'month') return list.sort((a, b) => a.key.localeCompare(b.key));
  if (by === 'tool') return list.sort((a, b) => b.toolCalls - a.toolCalls);
  return list.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

export interface Overview {
  /** Top-level sessions (what a human started). */
  sessions: number;
  /** Sub-agent sessions spawned by them. */
  subagents: number;
  usd: number;
  usage: Usage;
  prompts: number;
  toolCalls: number;
  toolErrors: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  durationMs: number;
  /** Share of prompt tokens served from cache (0..1). */
  cacheHitRate: number;
  costPerPrompt: number;
  recordedShare: number;
  mostExpensive: SessionSummary | null;
  uploadedSessions: number;
}

export function overview(sessions: SessionSummary[]): Overview {
  const usage = emptyUsage();
  let usd = 0;
  let recordedUsd = 0;
  let prompts = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let filesChanged = 0;
  let durationMs = 0;
  let uploaded = 0;
  let top: SessionSummary | null = null;
  for (const s of sessions) {
    addUsage(usage, s.usage);
    usd += ownCost(s);
    if (s.cost.source === 'recorded') recordedUsd += ownCost(s);
    prompts += s.prompts;
    toolCalls += s.toolCalls;
    toolErrors += s.toolErrors;
    linesAdded += s.linesAdded;
    linesRemoved += s.linesRemoved;
    filesChanged += s.filesChanged;
    durationMs += activeDuration(s);
    if (s.flags.includes('log-uploaded')) uploaded++;
    if (!top || ownCost(s) > ownCost(top)) top = s;
  }
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const subagents = sessions.filter((s) => s.parentKey).length;
  return {
    sessions: sessions.length - subagents,
    subagents,
    usd,
    usage,
    prompts,
    toolCalls,
    toolErrors,
    linesAdded,
    linesRemoved,
    filesChanged,
    durationMs,
    cacheHitRate: promptTokens ? usage.cacheRead / promptTokens : 0,
    costPerPrompt: prompts ? usd / prompts : 0,
    recordedShare: usd ? recordedUsd / usd : 0,
    mostExpensive: top && top.cost.usd > 0 ? top : null,
    uploadedSessions: uploaded,
  };
}
