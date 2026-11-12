import { costOf } from './pricing.ts';
import {
  addUsage,
  emptyUsage,
  type Cost,
  type FileEdit,
  type Session,
  type SessionEvent,
  type SessionFlag,
  type SessionRef,
  type SessionSummary,
  type ToolEvent,
  type UserEvent,
  type Usage,
  totalTokens,
} from './types.ts';
import { arr, isObject, oneLine, str, truncate } from './util.ts';

/** Max characters kept per tool output; huge outputs (e.g. `cat` of a big file) would bloat the UI. */
export const MAX_OUTPUT = 20_000;

export function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [${(text.length - max).toLocaleString('en-US')} more characters truncated by agent-blackbox]`;
}

/** Flatten the many "content" shapes (string, [{type:'text',text}], [{type:'input_text'}], ...) into plain text. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isObject(content)) {
    if (typeof content.text === 'string') return content.text;
    if (content.content !== undefined) return textOf(content.content);
    return '';
  }
  const parts: string[] = [];
  for (const block of arr(content)) {
    if (typeof block === 'string') parts.push(block);
    else if (isObject(block)) {
      const type = str(block.type);
      if (type === 'image' || type === 'input_image' || type === 'image_url') parts.push('[image]');
      else if (typeof block.text === 'string') parts.push(block.text);
      else if (block.content !== undefined) parts.push(textOf(block.content));
    }
  }
  return parts.join('\n');
}

export function countImages(content: unknown): number {
  let n = 0;
  for (const block of arr(content)) {
    if (isObject(block) && /image/.test(str(block.type))) n++;
  }
  return n;
}

/**
 * Some agents record edit paths relative to the working directory (Codex
 * `apply_patch`), others absolute. Resolve relative ones so the same file
 * always shows up under one name. Keeps the separator style of `cwd`.
 */
export function absolutePath(path: string, cwd: string): string {
  if (!path || !cwd) return path;
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]|~[\\/]|\\\\)/.test(path)) return path;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  const rel = path.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
  return cwd.replace(/[\\/]+$/, '') + sep + rel;
}

/**
 * A plain object with the same own keys (a key "__proto__" stays a key): what the cache and the worker pool give
 * back after JSON, so every path yields the same shape.
 */
function plain<T>(o: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(o)) Object.defineProperty(out, k, { value: o[k], enumerable: true, writable: true, configurable: true });
  return out;
}

/** A single tool call longer than this is almost certainly a paused session, not work. */
export const MAX_TOOL_MS = 2 * 3600_000;

/** Gaps longer than this between two events are treated as the human being away. */
export const IDLE_GAP_MS = 5 * 60_000;

export function activeTime(events: SessionEvent[]): number {
  const times: number[] = [];
  for (const ev of events) {
    if (ev.t) times.push(ev.t);
    if (ev.kind === 'tool' && ev.endT) times.push(ev.endT);
  }
  times.sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < times.length; i++) total += Math.min(IDLE_GAP_MS, (times[i] as number) - (times[i - 1] as number));
  return total;
}

/** Helper that adapters feed events into; it keeps tool calls paired and computes the summary. */
export class SessionBuilder {
  readonly ref: SessionRef;
  readonly events: SessionEvent[] = [];
  private readonly tools = new Map<string, ToolEvent>();
  readonly models = new Set<string>();
  readonly flags = new Set<SessionFlag>();
  title = '';
  cwd = '';
  startedAt = 0;
  endedAt = 0;
  /** Set when the agent itself recorded the session cost. */
  recordedCostUsd: number | undefined;
  /** When the agent's own cost accounting started covering this session (epoch ms). */
  recordedSince: number | undefined;
  parentKey: string | undefined;
  parentToolId: string | undefined;
  agentName: string | undefined;

  constructor(ref: SessionRef) {
    this.ref = ref;
  }

  touch(t: number): void {
    if (!t) return;
    if (!this.startedAt || t < this.startedAt) this.startedAt = t;
    if (t > this.endedAt) this.endedAt = t;
  }

  /** `from: 'agent'` marks a task delegated by a parent agent: shown like a prompt, never counted as one. */
  user(t: number, text: string, images = 0, from?: 'agent'): void {
    if (!text.trim() && !images) return;
    this.touch(t);
    const ev: UserEvent = { kind: 'user', t, text };
    if (images) ev.images = images;
    if (from) ev.from = from;
    this.events.push(ev);
  }

  assistant(t: number, text: string, model?: string): void {
    if (!text.trim()) return;
    this.touch(t);
    this.events.push(model ? { kind: 'assistant', t, text, model } : { kind: 'assistant', t, text });
  }

  thinking(t: number, text: string): void {
    if (!text.trim()) return;
    this.touch(t);
    this.events.push({ kind: 'thinking', t, text });
  }

  tool(t: number, id: string, name: string, input: unknown, parentId?: string): ToolEvent {
    this.touch(t);
    const existing = id ? this.tools.get(id) : undefined;
    if (existing) {
      // Some logs repeat the call (streaming snapshots); keep the first, refresh the input.
      if (input !== undefined && input !== '') existing.input = input;
      return existing;
    }
    const ev: ToolEvent = { kind: 'tool', t, id, name, input, output: '', isError: false };
    if (parentId) ev.parentId = parentId;
    this.events.push(ev);
    if (id) this.tools.set(id, ev);
    return ev;
  }

  getTool(id: string): ToolEvent | undefined {
    return this.tools.get(id);
  }

  result(id: string, output: string, isError: boolean, t = 0, edits?: FileEdit[]): ToolEvent | undefined {
    const ev = this.tools.get(id);
    if (!ev) return undefined;
    this.touch(t);
    ev.output = clip(output);
    ev.isError = ev.isError || isError;
    if (t && t >= ev.t) ev.endT = t;
    if (edits && edits.length) ev.edits = edits;
    return ev;
  }

  usage(t: number, model: string, usage: Usage, opts: { cacheWrite1h?: number; usd?: number } = {}): void {
    this.touch(t);
    if (model) this.models.add(model);
    const est = costOf(model, usage, opts);
    const usd = opts.usd ?? est.usd;
    const priced = opts.usd !== undefined || est.priced;
    this.events.push({ kind: 'usage', t, model, usage, usd, priced });
  }

  system(t: number, text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (!text.trim()) return;
    this.touch(t);
    this.events.push({ kind: 'system', t, text, level });
  }

  compact(t: number, text: string): void {
    this.touch(t);
    this.events.push({ kind: 'compact', t, text });
  }

  /**
   * An agent's own cost accounting may start in the middle of a session (an
   * upgrade added it, or an old session was merely reopened). Requests before
   * `recordedSince` are not in the recorded total, so they are estimated.
   */
  private combineRecorded(recorded: number, unpriced: boolean): Cost {
    const since = this.recordedSince;
    if (since === undefined) return { usd: recorded, source: 'recorded' };
    let before = 0;
    let beforeCount = 0;
    let afterCount = 0;
    for (const ev of this.events) {
      if (ev.kind !== 'usage') continue;
      if (ev.t && ev.t < since) {
        before += ev.usd;
        beforeCount++;
      } else afterCount++;
    }
    if (!beforeCount) return { usd: recorded, source: 'recorded', recordedSince: since };
    if (!afterCount) return { usd: before + recorded, source: unpriced ? 'partial' : 'estimated', recordedSince: since };
    return { usd: before + recorded, source: 'mixed', recordedSince: since };
  }

  build(): Session {
    const usage = emptyUsage();
    let usd = 0;
    let anyUsage = false;
    let unpriced = false;
    let prompts = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    const files = new Set<string>();
    // Keyed by names from the log: no prototype, so a tool called `constructor` or a model called `__proto__` is
    // just a key (on a plain object they read Object.prototype's members and wrote onto Object.prototype).
    const toolCounts: Record<string, number> = Object.create(null);
    const toolMs: Record<string, number> = Object.create(null);
    const toolErrorCounts: Record<string, number> = Object.create(null);
    const modelUsage: Record<string, { usd: number; tokens: number }> = Object.create(null);
    let firstPrompt = '';

    for (const ev of this.events) {
      switch (ev.kind) {
        case 'user':
          if (!ev.from) prompts++;
          if (!firstPrompt) firstPrompt = ev.text;
          break;
        case 'tool':
          toolCalls++;
          toolCounts[ev.name] = (toolCounts[ev.name] ?? 0) + 1;
          // Results that arrive hours later (a session resumed the next day) are not tool time.
          if (ev.endT && ev.endT > ev.t) toolMs[ev.name] = (toolMs[ev.name] ?? 0) + Math.min(ev.endT - ev.t, MAX_TOOL_MS);
          if (ev.isError) {
            toolErrors++;
            toolErrorCounts[ev.name] = (toolErrorCounts[ev.name] ?? 0) + 1;
          }
          for (const e of ev.edits ?? []) {
            e.path = absolutePath(e.path, this.cwd);
            files.add(e.path);
            linesAdded += e.added;
            linesRemoved += e.removed;
          }
          break;
        case 'usage':
          anyUsage = true;
          addUsage(usage, ev.usage);
          usd += ev.usd;
          if (!ev.priced) unpriced = true;
          if (ev.model && ev.model !== '<synthetic>') {
            const mu = (modelUsage[ev.model] ??= { usd: 0, tokens: 0 });
            mu.usd += ev.usd;
            mu.tokens += totalTokens(ev.usage);
          }
          break;
      }
    }

    let cost: Cost;
    if (this.recordedCostUsd !== undefined) cost = this.combineRecorded(this.recordedCostUsd, unpriced);
    else if (!anyUsage) cost = { usd: 0, source: 'unknown' };
    else cost = { usd, source: unpriced ? 'partial' : 'estimated' };

    const title = oneLine(this.title) || truncate(oneLine(firstPrompt), 120) || '(untitled session)';
    const activeMs = activeTime(this.events);
    const ref = this.ref;
    const links: Pick<SessionSummary, 'parentKey' | 'parentToolId' | 'agentName'> = {};
    if (this.parentKey) links.parentKey = this.parentKey;
    if (this.parentToolId) links.parentToolId = this.parentToolId;
    if (this.agentName) links.agentName = this.agentName;
    if (this.parentKey) this.flags.add('subagent');
    return {
      ...links,
      key: ref.key,
      agent: ref.agent,
      id: ref.id,
      path: ref.path,
      title,
      cwd: this.cwd,
      startedAt: this.startedAt || ref.mtimeMs,
      endedAt: this.endedAt || ref.mtimeMs,
      activeMs,
      models: [...this.models].filter((m) => m && m !== '<synthetic>'),
      prompts,
      toolCalls,
      toolErrors,
      filesChanged: files.size,
      linesAdded,
      linesRemoved,
      usage,
      cost,
      toolCounts: plain(toolCounts),
      toolMs: plain(toolMs),
      toolErrorCounts: plain(toolErrorCounts),
      modelUsage: plain(modelUsage),
      flags: [...this.flags],
      sizeBytes: ref.sizeBytes,
      events: this.events,
    };
  }
}
