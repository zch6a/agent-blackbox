import { basename, dirname, join } from 'node:path';
import { SessionBuilder, countImages, textOf } from '../builder.ts';
import { fromApplyPatch } from '../edits.ts';
import type { Adapter, FileEdit, Session, SessionRef } from '../types.ts';
import { home, isObject, makeKey, num, obj, readJsonl, statSafe, str, toMs, tryJson, walk } from '../util.ts';
import { classifyUserText } from './common.ts';

/**
 * OpenAI Codex CLI / Codex desktop writes "rollout" files:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` (or `$CODEX_HOME/sessions`).
 *
 * Each line is `{ timestamp, type, payload }` where type is `session_meta`,
 * `turn_context`, `response_item` (the model-visible transcript), `event_msg`
 * (UI events incl. token counts) or `compacted`. Older versions wrote the
 * payload directly on the line; both shapes are accepted.
 */
export const codexAdapter: Adapter = {
  agent: 'codex',

  defaultRoots() {
    const base = process.env.CODEX_HOME || join(home(), '.codex');
    return [join(base, 'sessions'), join(base, 'archived_sessions')];
  },

  async discover(roots) {
    const refs: SessionRef[] = [];
    for (const root of roots) {
      const files = await walk(root, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), 4);
      for (const path of files) {
        const s = await statSafe(path);
        if (!s || s.size === 0) continue;
        const m = /([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\.jsonl$/i.exec(basename(path));
        const id = m?.[1] ?? basename(path, '.jsonl');
        refs.push({ agent: 'codex', key: makeKey('codex', id), path, id, mtimeMs: s.mtimeMs, sizeBytes: s.size });
      }
    }
    return refs;
  },

  async load(ref) {
    const session = await parseCodex(ref, readJsonl(ref.path));
    const name = (await threadNames(ref.path)).get(ref.id);
    if (name) session.title = name;
    return session;
  },
};

/** `$CODEX_HOME` for a rollout path: the parent of its `sessions/` or `archived_sessions/` folder. */
function codexHomeFor(path: string): string | null {
  let dir = dirname(path);
  for (let i = 0; i < 6; i++) {
    const name = basename(dir);
    if (name === 'sessions' || name === 'archived_sessions') return dirname(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const indexCache = new Map<string, { mtimeMs: number; names: Map<string, string> }>();

/** Codex keeps user-visible thread names (renames included) in `session_index.jsonl`. */
async function threadNames(rolloutPath: string): Promise<Map<string, string>> {
  const home = codexHomeFor(rolloutPath);
  if (!home) return new Map();
  const file = join(home, 'session_index.jsonl');
  const st = await statSafe(file);
  if (!st) return new Map();
  const hit = indexCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.names;
  const names = new Map<string, string>();
  for await (const row of readJsonl(file)) {
    const id = str(row.id);
    const name = str(row.thread_name).trim();
    if (id && name) names.set(id, name); // later lines win: renames are appended
  }
  indexCache.set(file, { mtimeMs: st.mtimeMs, names });
  return names;
}

const PATCH_RE = /\*\*\* Begin Patch[\s\S]*?(\*\*\* End Patch|$)/g;

/** Find apply_patch envelopes anywhere in a tool input (custom tool, shell heredoc, or code-mode script). */
function patchEdits(input: unknown): FileEdit[] {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (!text.includes('*** Begin Patch')) return [];
  // JSON-encoded inputs escape newlines; undo that before parsing.
  const raw = typeof input === 'string' && !text.includes('\\n*** ') ? text : text.replace(/\\r\\n|\\n/g, '\n').replace(/\\"/g, '"');
  const edits: FileEdit[] = [];
  for (const m of raw.matchAll(PATCH_RE)) edits.push(...fromApplyPatch(m[0]));
  return edits;
}

function outputText(output: unknown): string {
  if (typeof output === 'string') {
    const parsed = tryJson(output);
    if (isObject(parsed) && typeof parsed.output === 'string') return parsed.output;
    return output;
  }
  return textOf(output);
}

/** The exit code Codex recorded for a shell call, from structured metadata or the output text. */
function exitCodeOf(output: unknown, text: string): number | undefined {
  if (typeof output === 'string') {
    const parsed = tryJson(output);
    if (isObject(parsed)) {
      const code = obj(parsed.metadata).exit_code;
      if (typeof code === 'number') return code;
    }
  }
  const m = /"exit_code"\s*:\s*(-?\d+)/.exec(text) ?? /Process exited with code (-?\d+)/.exec(text) ?? /^Exit code: (-?\d+)/m.exec(text);
  return m ? Number(m[1]) : undefined;
}

function outputFailed(exitCode: number | undefined, text: string): boolean {
  if (exitCode !== undefined) return exitCode !== 0;
  return /^(error|Error|ERROR)[:\s]/.test(text.trim()) || /^(Script failed|apply_patch verification failed)/m.test(text);
}

export async function parseCodex(ref: SessionRef, lines: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>): Promise<Session> {
  const b = new SessionBuilder(ref);
  let model = '';
  let lastTotal = -1;
  let sawResponseUser = false;
  const fallbackUsers: { t: number; text: string; images: number }[] = [];
  let openTurn = false;

  for await (const line of lines) {
    const t = toMs(line.timestamp);
    // Current format: { type, payload }. Legacy format: the response item itself is the line.
    const wrapped = isObject(line.payload);
    const type = wrapped ? str(line.type) : 'response_item';
    const payload = wrapped ? (line.payload as Record<string, unknown>) : line;
    const ptype = str(payload.type);

    if (type === 'session_meta') {
      b.cwd = str(payload.cwd) || b.cwd;
      b.touch(toMs(payload.timestamp) || t);
      const source = payload.source;
      if (isObject(source) ? 'subagent' in source : /sub.?agent/i.test(str(source))) b.flags.add('subagent');
      // { subagent: { thread_spawn: { parent_thread_id, agent_nickname, agent_path } } }
      const spawn = obj(obj(obj(source).subagent).thread_spawn);
      if (str(spawn.parent_thread_id)) b.parentKey = makeKey('codex', str(spawn.parent_thread_id));
      const nick = str(spawn.agent_nickname) || str(spawn.agent_path).replace(/^.*\//, '');
      if (nick) b.agentName = nick;
      continue;
    }
    if (type === 'turn_context') {
      model = str(payload.model) || model;
      if (!b.cwd) b.cwd = str(payload.cwd);
      continue;
    }
    if (type === 'compacted') {
      b.compact(t, str(payload.message) || 'Conversation compacted');
      continue;
    }
    if (type === 'event_msg') {
      switch (ptype) {
        case 'token_count': {
          const info = obj(payload.info);
          const total = obj(info.total_token_usage);
          const last = obj(info.last_token_usage);
          const totalTokens = num(total.total_tokens, -1);
          // Codex re-emits the same counter (e.g. after rate-limit updates); count each request once.
          if (totalTokens < 0 || totalTokens === lastTotal || !Object.keys(last).length) break;
          lastTotal = totalTokens;
          const cached = num(last.cached_input_tokens);
          b.usage(t, model || 'gpt-5', {
            input: Math.max(0, num(last.input_tokens) - cached),
            cacheRead: cached,
            cacheWrite: num(last.cache_write_input_tokens),
            output: num(last.output_tokens),
            reasoning: num(last.reasoning_output_tokens),
          });
          break;
        }
        case 'task_started':
          openTurn = true;
          break;
        case 'task_complete':
          openTurn = false;
          break;
        case 'turn_aborted':
          openTurn = false;
          b.system(t, 'Turn aborted' + (payload.reason ? `: ${str(payload.reason)}` : ''), 'warning');
          break;
        case 'error':
          b.system(t, str(payload.message) || 'error', 'error');
          break;
        case 'user_message': {
          const text = str(payload.message);
          const c = classifyUserText(text);
          if (c.kind === 'human' || c.kind === 'command') fallbackUsers.push({ t, text: c.text, images: Array.isArray(payload.images) ? payload.images.length : 0 });
          break;
        }
      }
      continue;
    }
    if (type && type !== 'response_item') continue;

    switch (ptype) {
      case 'message': {
        const role = str(payload.role);
        const text = textOf(payload.content);
        if (role === 'user') {
          // One message may mix injected context parts with what the human typed: classify each part.
          const parts = Array.isArray(payload.content) ? payload.content.map((c) => textOf([c])) : [text];
          const human: string[] = [];
          for (const part of parts) {
            const c = classifyUserText(part);
            if (c.kind === 'human') human.push(c.text);
            else if (c.kind === 'command') human.push(c.text);
            else if (c.kind === 'shell') human.push('! ' + c.text);
            else if (c.kind === 'system') b.system(t, c.text, c.level);
          }
          const images = countImages(payload.content);
          if (human.length || images) {
            sawResponseUser = true;
            b.user(t, human.join('\n'), images, b.flags.has('subagent') ? 'agent' : undefined);
          }
        } else if (role === 'assistant') {
          b.assistant(t, text, model);
        }
        break;
      }
      case 'reasoning': {
        const summary = Array.isArray(payload.summary) ? textOf(payload.summary) : '';
        const content = payload.content ? textOf(payload.content) : '';
        b.thinking(t, summary || content);
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const id = str(payload.call_id) || str(payload.id);
        const name = str(payload.name) || (ptype === 'local_shell_call' ? 'shell' : 'tool');
        const input = ptype === 'function_call' ? tryJson(str(payload.arguments)) : (payload.input ?? payload.action);
        const ev = b.tool(t, id, name, input);
        const edits = patchEdits(input);
        if (edits.length) ev.edits = edits;
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const id = str(payload.call_id);
        const text = outputText(payload.output);
        const exitCode = exitCodeOf(payload.output, text);
        const failed = outputFailed(exitCode, text);
        const ev = b.result(id, text, failed, t);
        if (ev && exitCode !== undefined) ev.exitCode = exitCode;
        if (ev && failed && ev.edits) delete ev.edits; // a rejected patch changed nothing
        break;
      }
      case 'web_search_call': {
        const action = obj(payload.action);
        const id = str(payload.id) || `ws-${t}-${b.events.length}`;
        b.tool(t, id, 'web_search', action.query ?? action.queries ?? action);
        b.result(id, str(payload.status), payload.status === 'failed', t);
        break;
      }
    }
  }

  if (!sawResponseUser && fallbackUsers.length) {
    for (const u of fallbackUsers) b.user(u.t, u.text, u.images, b.flags.has('subagent') ? 'agent' : undefined);
    b.events.sort((x, y) => x.t - y.t); // stable: keeps same-timestamp order
  }
  if (openTurn) b.flags.add('incomplete');
  return b.build();
}
