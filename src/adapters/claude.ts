import { basename, join } from 'node:path';
import { SessionBuilder, countImages, textOf } from '../builder.ts';
import { fromReplace, fromStructuredPatch, fromWrite } from '../edits.ts';
import { costOf } from '../pricing.ts';
import type { Adapter, FileEdit, Session, SessionRef, Usage, UsageEvent } from '../types.ts';
import { arr, home, isObject, makeKey, num, obj, readJsonl, statSafe, str, toMs, walk } from '../util.ts';
import { classifyUserText } from './common.ts';

/**
 * Claude Code writes one JSONL file per session under
 * `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects`).
 *
 * Quirks handled here:
 * - One API response is split across several lines (one per content block) that
 *   all repeat the same `message.id` and `usage` → usage must be de-duplicated,
 *   otherwise token counts come out 2–3× too high.
 * - Human prompts, slash commands, background-task notifications, hook output and
 *   injected reminders all arrive as `type: "user"` lines → classify them so
 *   "prompts" means real human input.
 * - `cost-state` lines carry Claude Code's own cost accounting → preferred over estimates.
 */
export const claudeAdapter: Adapter = {
  agent: 'claude-code',

  defaultRoots() {
    const roots: string[] = [];
    const env = process.env.CLAUDE_CONFIG_DIR;
    if (env) for (const dir of env.split(/[,;]/)) if (dir.trim()) roots.push(join(dir.trim(), 'projects'));
    roots.push(join(home(), '.claude', 'projects'), join(home(), '.config', 'claude', 'projects'));
    return [...new Set(roots)];
  },

  async discover(roots) {
    const refs: SessionRef[] = [];
    for (const root of roots) {
      const files = await walk(root, (n) => n.endsWith('.jsonl'), 1);
      for (const path of files) {
        const s = await statSafe(path);
        if (!s || s.size === 0) continue;
        const id = basename(path, '.jsonl');
        refs.push({ agent: 'claude-code', key: makeKey('claude-code', id), path, id, mtimeMs: s.mtimeMs, sizeBytes: s.size });
      }
    }
    return refs;
  },

  async load(ref) {
    return parseClaude(ref, readJsonl(ref.path, SKIP_PREFIXES));
  },
};

/**
 * Bookkeeping lines that never affect the timeline. `api-request-blob` alone is
 * about a quarter of a large log (it stores whole API request bodies).
 */
const SKIP_PREFIXES = [
  '{"type":"api-request',
  '{"type":"file-history',
  '{"type":"queue-operation"',
  '{"type":"last-prompt"',
  '{"type":"isolation-latch"',
  '{"type":"atis-latch"',
  '{"type":"agent-name"',
  '{"type":"mode"',
  '{"type":"relocated"',
];

function claudeUsage(u: Record<string, unknown>): { usage: Usage; write1h: number } {
  const cc = obj(u.cache_creation);
  return {
    usage: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      reasoning: 0,
    },
    write1h: num(cc.ephemeral_1h_input_tokens),
  };
}

function editsFor(toolName: string, input: unknown, result: unknown): FileEdit[] | undefined {
  const r = obj(result);
  const inp = obj(input);
  const path = str(r.filePath) || str(inp.file_path) || str(inp.notebook_path);
  if (!path) return undefined;
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
    return [fromStructuredPatch(path, r.structuredPatch, r.type === 'create' ? 'create' : 'modify')];
  }
  if (toolName === 'Write' || r.type === 'create') {
    const content = str(r.content) || str(inp.content);
    return [fromWrite(path, content, r.type === 'update' ? 'modify' : 'create')];
  }
  if (toolName === 'Edit' && (typeof inp.old_string === 'string' || typeof inp.new_string === 'string')) {
    return [fromReplace(path, str(inp.old_string), str(inp.new_string))];
  }
  if (toolName === 'MultiEdit') {
    const parts = arr(inp.edits)
      .filter(isObject)
      .map((e) => fromReplace(path, str(e.old_string), str(e.new_string)));
    if (parts.length) {
      return [
        {
          path,
          op: 'modify',
          added: parts.reduce((a, p) => a + p.added, 0),
          removed: parts.reduce((a, p) => a + p.removed, 0),
          diff: parts.map((p) => p.diff).join('\n@@\n'),
        },
      ];
    }
  }
  return undefined;
}

/**
 * `cost-state` totals are cumulative within one Claude Code process. When a
 * session is resumed in a new process the counter either restarts from zero or
 * is restored from the previous total; detect which one happened per segment.
 */
export function combineProcessCosts(segments: { first: number; last: number }[]): number {
  let committed = 0;
  let current = 0;
  for (const seg of segments) {
    if (current > 0 && seg.first >= current * 0.999) {
      current = seg.last; // restored: this process continues the previous total
    } else {
      committed += current;
      current = seg.last;
    }
  }
  return committed + current;
}

type Lines = AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>;

export async function parseClaude(ref: SessionRef, lines: Lines): Promise<Session> {
  const b = new SessionBuilder(ref);
  const usageById = new Map<string, UsageEvent>();
  const costByProcess = new Map<number, { first: number; last: number }>();
  let customTitle = '';
  let summaryTitle = '';
  let lastTool: { id: string; answered: boolean } | null = null;

  /** Route one piece of "user" text to the right kind of event. */
  const userText = (t: number, text: string, images: number, automatedBy: string) => {
    const c = classifyUserText(text);
    switch (c.kind) {
      case 'human':
        if (automatedBy) b.system(t, `[${automatedBy}] ${c.text}`);
        else b.user(t, c.text, images);
        break;
      case 'command':
        if (!automatedBy) b.user(t, c.text);
        break;
      case 'shell':
        b.user(t, '! ' + c.text);
        break;
      case 'system':
        b.system(t, c.text, c.level);
        break;
    }
  };

  for await (const line of lines) {
    const type = str(line.type);
    const t = toMs(line.timestamp);
    if (!b.cwd && typeof line.cwd === 'string') b.cwd = line.cwd;

    if (type === 'custom-title') {
      customTitle = str(line.customTitle) || customTitle;
      continue;
    }
    if (type === 'summary') {
      summaryTitle = str(line.summary) || summaryTitle;
      continue;
    }
    if (type === 'cost-state') {
      const total = num(line.totalCostUSD, NaN);
      if (Number.isFinite(total)) {
        const key = num(line.startTime);
        const prev = costByProcess.get(key);
        costByProcess.set(key, { first: prev ? prev.first : total, last: total });
      }
      continue;
    }
    if (type === 'system') {
      const subtype = str(line.subtype);
      if (subtype === 'compact_boundary') b.compact(t, str(line.content) || 'Conversation compacted');
      else if (str(line.level) === 'error') b.system(t, str(line.content) || subtype || 'error', 'error');
      else if (subtype === 'api_error') b.system(t, str(line.content) || 'API error', 'warning');
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue; // attachments, snapshots, request blobs, … are bookkeeping

    const msg = obj(line.message);
    const sidechain = line.isSidechain === true;

    if (type === 'user') {
      const content = msg.content;
      // isMeta lines and sidechain (old-style sub-agent) prompts are never typed by the human.
      const hidden = line.isMeta === true || sidechain;
      // Newer versions tag where a prompt came from; anything but a human is automation.
      const originKind = str(obj(line.origin).kind);
      const automatedBy = originKind && originKind !== 'human' ? originKind : '';
      if (typeof content === 'string') {
        if (!hidden) userText(t, content, 0, automatedBy);
        continue;
      }
      const texts: string[] = [];
      for (const block of arr(content)) {
        if (!isObject(block)) continue;
        if (block.type === 'tool_result') {
          const id = str(block.tool_use_id);
          const tool = b.getTool(id);
          const isError = block.is_error === true;
          const edits = tool && !isError ? editsFor(tool.name, tool.input, line.toolUseResult) : undefined;
          b.result(id, textOf(block.content), isError, t, edits);
          if (lastTool && lastTool.id === id) lastTool.answered = true;
        } else if (block.type === 'text') {
          texts.push(str(block.text));
        }
      }
      const images = countImages(content);
      if (!hidden && (texts.length || images)) {
        // A message can mix a real prompt with injected blocks; classify each block.
        const human: string[] = [];
        for (const text of texts) {
          const c = classifyUserText(text);
          if (c.kind === 'human' && !automatedBy) human.push(c.text);
          else userText(t, text, 0, automatedBy);
        }
        if (human.length || images) b.user(t, human.join('\n'), images);
      }
      continue;
    }

    // assistant
    const model = str(msg.model);
    const msgId = str(msg.id) || str(line.uuid);
    if (model === '<synthetic>' || line.isApiErrorMessage === true) {
      const text = textOf(msg.content);
      if (text) b.system(t, text, 'error');
      continue;
    }
    if (isObject(msg.usage) && model) {
      const { usage, write1h } = claudeUsage(msg.usage);
      const prev = usageById.get(msgId);
      if (!prev) {
        b.usage(t, model, usage, { cacheWrite1h: write1h });
        const ev = b.events[b.events.length - 1];
        if (ev && ev.kind === 'usage') usageById.set(msgId, ev);
      } else if (usage.output > prev.usage.output || usage.input + usage.cacheRead > prev.usage.input + prev.usage.cacheRead) {
        // Streaming snapshots grow; keep the final numbers.
        prev.usage = usage;
        const c = costOf(model, usage, { cacheWrite1h: write1h });
        prev.usd = c.usd;
        prev.priced = c.priced;
      }
    }
    for (const block of arr(msg.content)) {
      if (!isObject(block)) continue;
      switch (block.type) {
        case 'thinking':
          b.thinking(t, str(block.thinking));
          break;
        case 'text':
          b.assistant(t, str(block.text), model);
          break;
        case 'tool_use':
        case 'server_tool_use': {
          const id = str(block.id);
          b.tool(t, id, str(block.name), block.input);
          lastTool = { id, answered: false };
          break;
        }
        case 'web_search_tool_result':
        case 'web_fetch_tool_result': {
          const id = str(block.tool_use_id);
          b.result(id, JSON.stringify(block.content ?? '', null, 1), false, t);
          if (lastTool && lastTool.id === id) lastTool.answered = true;
          break;
        }
      }
    }
  }

  b.title = customTitle || summaryTitle;
  if (costByProcess.size) b.recordedCostUsd = combineProcessCosts([...costByProcess.values()]);
  if (lastTool && !lastTool.answered) b.flags.add('incomplete');
  return b.build();
}
