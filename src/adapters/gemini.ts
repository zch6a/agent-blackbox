import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SessionBuilder, textOf } from '../builder.ts';
import { fromUnifiedDiff, guessEdits } from '../edits.ts';
import type { Adapter, FileEdit, Session, SessionRef } from '../types.ts';
import { arr, home, isObject, makeKey, num, obj, parseJsonlText, statSafe, str, toMs, tryJson, walk } from '../util.ts';

/**
 * Gemini CLI records every chat under `~/.gemini/tmp/<project>/chats/` (`$GEMINI_CLI_HOME`
 * replaces the home folder):
 *
 * - `session-<yyyy-mm-ddThh-mm>-<id8>.jsonl`, append-only: a metadata line
 *   `{sessionId, projectHash, startTime, kind, ...}`, one line per message
 *   (`{id, timestamp, type: user|gemini|info|warning|error, content, toolCalls?, thoughts?, tokens?, model?}`;
 *   a message written again with the same id replaces it), and update records:
 *   `{$set: {...metadata}}`, `{$patch: {id, content?, toolCalls?}}` (or `{updates, removeIds}`),
 *   `{$rewindTo: id}` (that message and everything after it is gone).
 * - `session-*.json`: the older format, the whole conversation as one JSON object.
 * - `chats/<parent session id>/<id>.jsonl`: a sub-agent's session.
 *
 * `<project>` is a short name (`my-app`) mapped to the project folder in `~/.gemini/projects.json`
 * and in a `.project_root` file beside `chats/`; older versions used the SHA-256 of the folder path.
 */
export const geminiAdapter: Adapter = {
  agent: 'gemini-cli',

  defaultRoots() {
    return [join(process.env.GEMINI_CLI_HOME || home(), '.gemini', 'tmp')];
  },

  async discover(roots) {
    const byId = new Map<string, SessionRef>();
    for (const root of roots) {
      const files = await walk(root, (n) => /\.jsonl?$/.test(n), 3);
      for (const path of files) {
        const parent = basename(dirname(path));
        const main = parent === 'chats' && /^session-.*\.jsonl?$/.test(basename(path));
        const sub = !main && basename(dirname(dirname(path))) === 'chats' && path.endsWith('.jsonl');
        if (!main && !sub) continue;
        const s = await statSafe(path);
        if (!s || s.size === 0) continue;
        const id = (await sessionIdOf(path)) || basename(path).replace(/\.jsonl?$/, '').replace(/^session-/, '');
        const ref: SessionRef = { agent: 'gemini-cli', key: makeKey('gemini-cli', id), path, id, mtimeMs: s.mtimeMs, sizeBytes: s.size };
        // A session migrated from .json to .jsonl leaves both behind: keep the one written last.
        const seen = byId.get(id);
        if (!seen || seen.mtimeMs < ref.mtimeMs || (seen.mtimeMs === ref.mtimeMs && path.endsWith('.jsonl'))) byId.set(id, ref);
      }
    }
    return [...byId.values()];
  },

  async load(ref) {
    const text = await readFile(ref.path, 'utf8');
    const record = readConversation(text);
    const projectDir = dirname(basename(dirname(ref.path)) === 'chats' ? dirname(ref.path) : dirname(dirname(ref.path)));
    const cwd = (await projectRoot(projectDir, str(record.meta.projectHash))) || str(arr(record.meta.directories)[0]);
    return parseGemini(ref, record, cwd);
  },
};

/** The session id, from the start of the file (both formats put it near the top). */
async function sessionIdOf(path: string): Promise<string> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    return /"sessionId"\s*:\s*"([^"\\]{1,200})"/.exec(head)?.[1] ?? '';
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

/** The project folder a `~/.gemini/tmp/<project>` folder belongs to; '' when unknown. */
async function projectRoot(projectDir: string, projectHash: string): Promise<string> {
  try {
    const marker = (await readFile(join(projectDir, '.project_root'), 'utf8')).trim();
    if (marker) {
      const parsed = tryJson(marker);
      return isObject(parsed) ? str(parsed.path) || str(parsed.projectRoot) : marker;
    }
  } catch {
    // no marker: older layout
  }
  const slug = basename(projectDir);
  // projects.json sits in ~/.gemini, next to tmp/.
  let projects: Record<string, unknown> = {};
  try {
    projects = obj(obj(JSON.parse(await readFile(join(dirname(dirname(projectDir)), 'projects.json'), 'utf8'))).projects);
  } catch {
    return '';
  }
  const sha = (p: string) => createHash('sha256').update(p).digest('hex');
  for (const [path, name] of Object.entries(projects)) {
    if (name === slug || sha(path) === slug || (projectHash && sha(path) === projectHash)) return path;
  }
  return '';
}

export interface GeminiConversation {
  meta: Record<string, unknown>;
  messages: Record<string, unknown>[];
}

/** Apply a JSONL session's lines (or read an old whole-file session) the way Gemini CLI does. */
export function readConversation(text: string): GeminiConversation {
  let meta: Record<string, unknown> = {};
  const messages = new Map<string, Record<string, unknown>>();
  let lines = 0;
  for (const line of parseJsonlText(text)) {
    lines++;
    if (isObject(line.$set)) {
      const { messages: all, ...rest } = line.$set;
      meta = { ...meta, ...rest };
      if (Array.isArray(all)) {
        messages.clear();
        for (const m of all) if (isObject(m) && str(m.id)) messages.set(str(m.id), m);
      }
    } else if (typeof line.$rewindTo === 'string') {
      let found = false;
      for (const id of [...messages.keys()]) {
        if (id === line.$rewindTo) found = true;
        if (found) messages.delete(id);
      }
      if (!found) messages.clear();
    } else if (isObject(line.$patch)) {
      const patch = line.$patch;
      for (const u of str(patch.id) ? [patch] : arr(patch.updates)) applyPatch(messages, obj(u));
      for (const id of arr(patch.removeIds)) messages.delete(str(id));
    } else if (str(line.id)) {
      // Written again (a streamed message completed, a tool result arrived): replaces it, in place.
      messages.set(str(line.id), line);
    } else if (str(line.sessionId)) {
      const { messages: all, ...rest } = line;
      meta = { ...meta, ...rest };
      if (Array.isArray(all)) for (const m of all) if (isObject(m) && str(m.id)) messages.set(str(m.id), m);
    }
  }
  if (!lines || (!str(meta.sessionId) && !messages.size)) {
    // The older format: one JSON object (pretty-printed, so not one line).
    const whole = tryJson(text);
    if (isObject(whole)) {
      const { messages: all, ...rest } = whole;
      return { meta: rest, messages: arr(all).filter(isObject) };
    }
  }
  return { meta, messages: [...messages.values()] };
}

function applyPatch(messages: Map<string, Record<string, unknown>>, p: Record<string, unknown>): void {
  const existing = messages.get(str(p.id));
  if (!existing) return;
  const next = { ...existing };
  if (p.content !== undefined) next.content = p.content;
  if (Array.isArray(p.toolCalls)) {
    next.toolCalls = arr(existing.toolCalls).map((c) => {
      const call = obj(c);
      const update = p.toolCalls && arr(p.toolCalls).map(obj).find((x) => str(x.id) === str(call.id));
      return update ? { ...call, ...update } : call;
    });
  }
  messages.set(str(p.id), next);
}

/** Text of a part list, without the model's thought parts. */
function partsText(content: unknown): string {
  if (Array.isArray(content)) return textOf(content.filter((p) => !(isObject(p) && p.thought === true)));
  return textOf(content);
}

/** What a tool returned: the function response's output or error, else what the UI showed. */
function resultText(result: unknown, display: unknown): string {
  const out: string[] = [];
  for (const part of Array.isArray(result) ? result : result === undefined || result === null ? [] : [result]) {
    if (typeof part === 'string') out.push(part);
    else if (isObject(part)) {
      const response = obj(obj(part.functionResponse).response);
      if (Object.keys(response).length) {
        const v = response.output ?? response.error ?? response.content;
        out.push(typeof v === 'string' ? v : v === undefined ? JSON.stringify(response) : textOf(v) || JSON.stringify(v));
      } else if (typeof part.text === 'string') out.push(part.text);
    }
  }
  if (out.length) return out.join('\n');
  if (typeof display === 'string') return display;
  return '';
}

const FINISHED = new Set(['success', 'error', 'cancelled']);
const FILE_TOOLS = /^(write_file|replace|edit|smart_edit)$/;

export function parseGemini(ref: SessionRef, conv: GeminiConversation, cwd = ''): Session {
  const b = new SessionBuilder(ref);
  const meta = conv.meta;
  b.cwd = cwd;
  b.touch(toMs(meta.startTime));
  const subagent = str(meta.kind) === 'subagent' || basename(dirname(dirname(ref.path))) === 'chats';
  if (subagent) {
    const parentId = basename(dirname(ref.path));
    if (parentId && parentId !== 'chats') b.parentKey = makeKey('gemini-cli', parentId);
  }
  let open = false;

  for (const m of conv.messages) {
    const t = toMs(m.timestamp);
    const type = str(m.type);
    if (type === 'user') {
      const content = m.displayContent ?? m.content;
      const images = arr(content).filter((p) => isObject(p) && isObject(p.inlineData) && /^image\//.test(str(p.inlineData.mimeType))).length;
      b.user(t, partsText(content), images, subagent ? 'agent' : undefined);
    } else if (type === 'gemini') {
      const model = str(m.model);
      for (const th of arr(m.thoughts)) {
        const o = obj(th);
        const text = [str(o.subject), str(o.description)].filter(Boolean).join(': ');
        b.thinking(toMs(o.timestamp) || t, text);
      }
      b.assistant(t, partsText(m.content), model);
      open = false;
      for (const c of arr(m.toolCalls)) {
        const call = obj(c);
        const name = str(call.name);
        const input = call.args ?? {};
        const status = str(call.status);
        const ev = b.tool(toMs(call.timestamp) || t, str(call.id), name, input);
        if (!FINISHED.has(status)) {
          open = true;
          continue;
        }
        const output = resultText(call.result, call.resultDisplay);
        const exit = /^Exit Code: (-?\d+)/m.exec(output);
        if (exit) ev.exitCode = Number(exit[1]);
        const failed = status !== 'success' || (ev.exitCode !== undefined && ev.exitCode !== 0);
        b.result(str(call.id), output || (status === 'cancelled' ? 'Cancelled' : ''), failed);
        if (status === 'success') {
          const edits = editsOf(name, input, call.resultDisplay);
          if (edits.length) ev.edits = edits;
        }
      }
      const tokens = obj(m.tokens);
      if (Object.keys(tokens).length) {
        const cached = num(tokens.cached);
        const thoughts = num(tokens.thoughts);
        b.usage(t, model, {
          // Gemini counts cached tokens inside the prompt, and thought tokens outside the output.
          input: Math.max(0, num(tokens.input) + num(tokens.tool) - cached),
          output: num(tokens.output) + thoughts,
          cacheRead: cached,
          cacheWrite: 0,
          reasoning: thoughts,
        });
      }
    } else if (type === 'info' || type === 'warning' || type === 'error') {
      b.system(t, partsText(m.content), type);
    }
  }

  b.title = str(meta.summary);
  if (open) b.flags.add('incomplete');
  return b.build();
}

/** File changes: Gemini's own diff when it showed one, else from the arguments. */
function editsOf(name: string, input: unknown, display: unknown): FileEdit[] {
  const args = obj(input);
  const path = str(args.file_path) || str(args.absolute_path) || str(args.path);
  const shown = obj(display);
  if (FILE_TOOLS.test(name) && typeof shown.fileDiff === 'string' && shown.fileDiff) {
    const edits = fromUnifiedDiff(shown.fileDiff, path);
    // Gemini's diff headers carry only the file name: the arguments have the full path.
    const only = edits.length === 1 ? edits[0] : undefined;
    if (only && path) only.path = path;
    if (only && (shown.isNewFile === true || shown.originalContent === null || shown.originalContent === '')) only.op = 'create';
    if (edits.length) return edits;
  }
  return guessEdits(name, input);
}
