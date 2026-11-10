import type { FileEdit } from './types.ts';
import { arr, isObject, num, str } from './util.ts';

const MAX_DIFF_LINES = 400;

function capDiff(lines: string[]): string {
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`].join('\n');
}


/** Claude Code `structuredPatch`: [{ oldStart, newStart, lines: ['+a', '-b', ' c'] }]. */
export function fromStructuredPatch(path: string, patch: unknown, op: FileEdit['op'] = 'modify'): FileEdit {
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of arr(patch)) {
    if (!isObject(hunk)) continue;
    out.push(`@@ -${num(hunk.oldStart)},${num(hunk.oldLines)} +${num(hunk.newStart)},${num(hunk.newLines)} @@`);
    for (const line of arr(hunk.lines)) {
      const l = str(line);
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
      out.push(l);
    }
  }
  return { path, op, added, removed, diff: capDiff(out) };
}

/** A whole-file write (no previous content known). */
export function fromWrite(path: string, content: string, op: FileEdit['op'] = 'create'): FileEdit {
  const lines = content ? content.replace(/\n$/, '').split('\n') : [];
  return { path, op, added: lines.length, removed: 0, diff: capDiff(lines.map((l) => '+' + l)) };
}

/** A simple old → new string replacement (no line numbers known). */
export function fromReplace(path: string, oldText: string, newText: string): FileEdit {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];
  // Trim the common prefix/suffix so the diff shows only what actually changed.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const removedLines = a.slice(pre, a.length - suf);
  const addedLines = b.slice(pre, b.length - suf);
  const ctxBefore = a.slice(Math.max(0, pre - 2), pre).map((l) => ' ' + l);
  const ctxAfter = a.slice(a.length - suf, a.length - suf + 2).map((l) => ' ' + l);
  return {
    path,
    op: 'modify',
    added: addedLines.length,
    removed: removedLines.length,
    diff: capDiff([...ctxBefore, ...removedLines.map((l) => '-' + l), ...addedLines.map((l) => '+' + l), ...ctxAfter]),
  };
}

/**
 * Codex / OpenAI `apply_patch` envelope:
 *   *** Begin Patch
 *   *** Update File: src/a.ts
 *   @@
 *   -old
 *   +new
 *   *** Add File: b.ts
 *   +content
 *   *** Delete File: c.ts
 *   *** End Patch
 */
export function fromApplyPatch(patch: string): FileEdit[] {
  const edits: FileEdit[] = [];
  let cur: { edit: FileEdit; lines: string[] } | null = null;
  const flush = () => {
    if (cur) {
      cur.edit.diff = capDiff(cur.lines);
      edits.push(cur.edit);
    }
    cur = null;
  };
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      flush();
      const kind = header[1];
      cur = {
        edit: { path: (header[2] ?? '').trim(), op: kind === 'Add' ? 'create' : kind === 'Delete' ? 'delete' : 'modify', added: 0, removed: 0 },
        lines: [],
      };
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && cur) {
      (cur as { edit: FileEdit }).edit.path = (move[1] ?? '').trim();
      continue;
    }
    if (line.startsWith('*** ')) continue; // Begin/End Patch, End of File
    if (!cur) continue;
    const c = cur as { edit: FileEdit; lines: string[] };
    if (line.startsWith('+')) c.edit.added++;
    else if (line.startsWith('-')) c.edit.removed++;
    c.lines.push(line);
  }
  flush();
  return edits;
}

/** Standard unified diff (`--- a/x`, `+++ b/x`, `@@`). Used by OpenCode metadata. */
export function fromUnifiedDiff(diff: string, fallbackPath = ''): FileEdit[] {
  const edits: FileEdit[] = [];
  let cur: { edit: FileEdit; lines: string[] } | null = null;
  const flush = () => {
    if (cur) {
      cur.edit.diff = capDiff(cur.lines);
      edits.push(cur.edit);
    }
    cur = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      flush();
      cur = { edit: { path: fallbackPath, op: line.includes('/dev/null') ? 'create' : 'modify', added: 0, removed: 0 }, lines: [] };
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!cur) cur = { edit: { path: fallbackPath, op: 'modify', added: 0, removed: 0 }, lines: [] };
      const target = line.slice(4).trim().replace(/^b\//, '');
      if (target === '/dev/null') cur.edit.op = 'delete';
      else if (target) cur.edit.path = target.replace(/\t.*$/, '');
      continue;
    }
    if (line.startsWith('Index: ') || line.startsWith('====') || line.startsWith('diff --git')) continue;
    if (!cur) {
      if (!line.startsWith('@@')) continue;
      cur = { edit: { path: fallbackPath, op: 'modify', added: 0, removed: 0 }, lines: [] };
    }
    if (line.startsWith('+')) cur.edit.added++;
    else if (line.startsWith('-')) cur.edit.removed++;
    cur.lines.push(line);
  }
  flush();
  return edits;
}

const WRITE_TOOLS = /^(write|write_file|create_file|file_write|str_replace_based_edit_tool)$/i;
const EDIT_TOOLS = /^(edit|edit_file|str_replace|replace|multiedit|multi_edit|file_edit)$/i;

/**
 * Best-effort edit extraction for agents whose file tools follow the common
 * `{file_path|filePath|path, content}` / `{old_string, new_string}` conventions.
 */
export function guessEdits(toolName: string, input: unknown): FileEdit[] {
  if (typeof input === 'string') {
    return input.includes('*** Begin Patch') ? fromApplyPatch(input) : [];
  }
  if (!isObject(input)) return [];
  const path = str(input.file_path) || str(input.filePath) || str(input.path) || str(input.target_file);
  // `mcp__filesystem__write_file`, `fs.write`, `tools/edit` → the bare tool name
  const name = toolName.replace(/^mcp__.*__/, '').replace(/^.*[.:/]/, '');
  if (typeof input.patch === 'string' || typeof input.patchText === 'string') {
    const patch = str(input.patch) || str(input.patchText);
    if (patch.includes('*** Begin Patch')) return fromApplyPatch(patch);
    return fromUnifiedDiff(patch, path);
  }
  if (!path) return [];
  if (Array.isArray(input.edits) && EDIT_TOOLS.test(name)) {
    const parts = input.edits
      .filter(isObject)
      .map((e) => fromReplace(path, str(e.old_string) || str(e.oldString), str(e.new_string) || str(e.newString)));
    if (!parts.length) return [];
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
  const oldS = input.old_string ?? input.oldString ?? input.old_str;
  const newS = input.new_string ?? input.newString ?? input.new_str;
  if ((typeof oldS === 'string' || typeof newS === 'string') && (EDIT_TOOLS.test(name) || WRITE_TOOLS.test(name))) {
    return [fromReplace(path, str(oldS), str(newS))];
  }
  const content = input.content ?? input.file_text ?? input.text;
  if (typeof content === 'string' && WRITE_TOOLS.test(name)) return [fromWrite(path, content, 'create')];
  return [];
}
