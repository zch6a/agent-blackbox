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
  type ToolEvent,
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

  constructor(ref: SessionRef) {
    this.ref = ref;
  }

  touch(t: number): void {
    if (!t) return;
    if (!this.startedAt || t < this.startedAt) this.startedAt = t;
    if (t > this.endedAt) this.endedAt = t;
  }

  user(t: number, text: string, images = 0): void {
    if (!text.trim() && !images) return;
    this.touch(t);
    this.events.push(images ? { kind: 'user', t, text, images } : { kind: 'user', t, text });
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
    const toolCounts: Record<string, number> = {};
    const modelUsage: Record<string, { usd: number; tokens: number }> = {};
    let firstPrompt = '';

    for (const ev of this.events) {
      switch (ev.kind) {
        case 'user':
          prompts++;
          if (!firstPrompt) firstPrompt = ev.text;
          break;
        case 'tool':
          toolCalls++;
          toolCounts[ev.name] = (toolCounts[ev.name] ?? 0) + 1;
          if (ev.isError) toolErrors++;
          for (const e of ev.edits ?? []) {
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
    if (this.recordedCostUsd !== undefined) cost = { usd: this.recordedCostUsd, source: 'recorded' };
    else if (!anyUsage) cost = { usd: 0, source: 'unknown' };
    else cost = { usd, source: unpriced ? 'partial' : 'estimated' };

    const title = oneLine(this.title) || truncate(oneLine(firstPrompt), 120) || '(untitled session)';
    const activeMs = activeTime(this.events);
    const ref = this.ref;
    return {
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
      toolCounts,
      modelUsage,
      flags: [...this.flags],
      sizeBytes: ref.sizeBytes,
      events: this.events,
    };
  }
}
