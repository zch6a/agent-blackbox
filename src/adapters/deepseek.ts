import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SessionBuilder, textOf } from '../builder.ts';
import { guessEdits } from '../edits.ts';
import type { Adapter, Session, SessionRef } from '../types.ts';
import { arr, home, isObject, makeKey, num, obj, parseJsonlText, statSafe, str, toMs, tryJson, walk } from '../util.ts';
import { decompressZstdFrames } from '../zstd.ts';

/**
 * DeepSeek Harness (`dsh`) keeps an append-only event log per session:
 * `~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd`.
 *
 * The file is a concatenation of zstd frames (one per append), each holding
 * JSONL events `{ seq, time, type, data }`: `user/message`, `assistant/message`
 * (with `usage`), `tool/call`, `tool/result`, `tool/ptc-dispatch[-start]`
 * (calls made from inside `run_code`), `turn/start|end`, `compaction/*`, ...
 *
 * `session-log-deepseek/delivery-accepted` means the harness uploaded the log
 * to the DeepSeek API (on by default for the official API) — we surface that as
 * a privacy flag so users can see which sessions left their machine.
 */
export const deepseekAdapter: Adapter = {
  agent: 'deepseek-harness',

  defaultRoots() {
    return [join(process.env.DSH_HOME || join(home(), '.dsh'), 'sessions')];
  },

  async discover(roots) {
    const refs: SessionRef[] = [];
    for (const root of roots) {
      const files = await walk(root, (n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n), 3);
      for (const path of files) {
        const s = await statSafe(path);
        if (!s || s.size === 0) continue;
        const dir = basename(dirname(path));
        const id = dir.replace(/^session-/, '');
        refs.push({ agent: 'deepseek-harness', key: makeKey('deepseek-harness', id), path, id, mtimeMs: s.mtimeMs, sizeBytes: s.size });
      }
    }
    return refs;
  },

  async load(ref) {
    const buf = await readFile(ref.path);
    const text = ref.path.endsWith('.zstd') ? decompressZstdFrames(buf) : buf.toString('utf8');
    return parseDeepseek(ref, parseJsonlText(text));
  },
};

/** `user/message` sources other than `user` are context the harness injects. */
const VISIBLE_SOURCES: Record<string, 'user' | 'system'> = {
  user: 'user',
  'agent-message': 'system',
  'subagent-settled': 'system',
  schedule: 'system',
};

function parseArgs(v: unknown): unknown {
  return typeof v === 'string' ? tryJson(v) : v;
}

export function parseDeepseek(ref: SessionRef, lines: Iterable<Record<string, unknown>>): Session {
  const b = new SessionBuilder(ref);
  const titles: string[] = [];
  let openTurn = false;

  for (const line of lines) {
    const type = str(line.type);
    const t = toMs(line.time);
    const data = obj(line.data);

    switch (type) {
      case 'session': {
        b.cwd = str(line.cwd) || b.cwd;
        b.touch(toMs(line.createdAt));
        if (num(line.delegationDepth) > 0) b.flags.add('subagent');
        if (str(line.parentSession)) b.parentKey = makeKey('deepseek-harness', str(line.parentSession).replace(/^session-/, ''));
        break;
      }
      case 'user/message': {
        const kind = str(obj(data.source).kind) || 'user';
        const as = VISIBLE_SOURCES[kind];
        const text = textOf(data.content);
        const images = arr(data.content).filter((c) => isObject(c) && /image/.test(str(c.type))).length;
        if (as === 'user') b.user(t, text, images, b.flags.has('subagent') ? 'agent' : undefined);
        else if (as === 'system') b.system(t, text);
        break;
      }
      case 'assistant/message': {
        const msg = obj(data.message);
        const source = obj(msg.source);
        const model = str(source.model);
        for (const block of arr(msg.content)) {
          if (!isObject(block)) continue;
          const bt = str(block.type);
          if (bt === 'reasoning' || bt === 'thinking') b.thinking(t, str(block.text) || str(block.thinking));
          else if (bt === 'text') b.assistant(t, str(block.text), model);
          else if (bt === 'tool-call' || bt === 'tool_use') {
            const name = str(block.name);
            const input = parseArgs(block.arguments ?? block.input);
            const ev = b.tool(t, str(block.id), name, input);
            const edits = guessEdits(name, input);
            if (edits.length) ev.edits = edits;
          }
        }
        const u = obj(data.usage);
        if (Object.keys(u).length) {
          b.usage(t, model, {
            input: num(u.inputTokens),
            output: num(u.outputTokens),
            cacheRead: num(u.cacheReadTokens),
            cacheWrite: num(u.cacheWriteTokens),
            reasoning: num(u.reasoningTokens),
          });
        }
        break;
      }
      case 'tool/call': {
        const name = str(data.name);
        const input = parseArgs(data.arguments);
        const ev = b.tool(t, str(data.callId), name, input);
        if (!ev.edits) {
          const edits = guessEdits(name, input);
          if (edits.length) ev.edits = edits;
        }
        break;
      }
      case 'tool/result': {
        const msg = obj(data.message);
        const id = str(data.toolCallId) || str(msg.toolCallId) || str(obj(msg.source).callId);
        const isError = msg.isError === true || data.isError === true;
        const ev = b.result(id, textOf(msg.content), isError, t);
        if (ev && isError) delete ev.edits;
        break;
      }
      case 'tool/ptc-dispatch-start': {
        const name = str(data.name);
        const input = parseArgs(data.arguments);
        const ev = b.tool(t, str(data.subCallId), name, input, str(data.parentCallId) || undefined);
        const edits = guessEdits(name, input);
        if (edits.length) ev.edits = edits;
        break;
      }
      case 'tool/ptc-dispatch': {
        const id = str(data.subCallId);
        if (!b.getTool(id)) b.tool(t, id, str(data.name), parseArgs(data.arguments), str(data.parentCallId) || undefined);
        const isError = data.isError === true;
        const ev = b.result(id, textOf(data.content), isError, t);
        if (ev && isError) delete ev.edits;
        break;
      }
      case 'session/title':
        if (str(data.title)) titles.push(str(data.title));
        break;
      case 'turn/start':
        openTurn = true;
        break;
      case 'turn/end': {
        openTurn = false;
        const reason = obj(data.reason);
        const kind = str(reason.kind);
        if (kind === 'error') b.system(t, str(obj(reason.error).message) || 'Turn failed', 'error');
        else if (kind === 'aborted' || kind === 'interrupted') b.system(t, 'Turn ' + kind, 'warning');
        else if (kind === 'max-tokens') b.system(t, 'Stopped: max output tokens reached', 'warning');
        break;
      }
      case 'compaction/summary':
        b.compact(t, textOf(data.summary ?? data.content ?? data.text) || 'Conversation compacted');
        break;
      case 'llm/retry':
        b.system(t, 'Model request retried' + (data.reason ? `: ${textOf(data.reason) || JSON.stringify(data.reason)}` : ''), 'warning');
        break;
      case 'deliverables/presented': {
        const files = arr(data.files).map((f) => str(obj(f).path)).filter(Boolean);
        if (files.length) b.system(t, 'Presented: ' + files.join(', '));
        break;
      }
      case 'session-log-deepseek/delivery-accepted':
        b.flags.add('log-uploaded');
        break;
      default:
        if (type.endsWith('/error')) b.system(t, str(data.message) || type, 'error');
    }
  }

  b.title = titles[titles.length - 1] ?? '';
  if (openTurn) b.flags.add('incomplete');
  return b.build();
}
