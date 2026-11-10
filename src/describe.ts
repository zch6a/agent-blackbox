import { isObject, oneLine, str, tildify, truncate } from './util.ts';

/** A one-line human description of a tool call's input, e.g. `npm test` or `src/app.ts:10-40`. */
export function toolBrief(name: string, input: unknown, max = 160): string {
  if (typeof input === 'string') return truncate(oneLine(firstPatchFile(input) ?? input), max);
  if (!isObject(input)) return '';
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v;
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join(' ');
    }
    return '';
  };
  const path = get('file_path', 'filePath', 'notebook_path', 'path', 'target_file');
  const command = get('command', 'cmd', 'script');
  const lower = name.toLowerCase();

  if (command) return truncate(oneLine(command), max);
  if (/^(read|view|read_file|read_image)$/.test(lower) && path) {
    const offset = Number(input.offset ?? input.start_line ?? 0);
    const limit = Number(input.limit ?? 0);
    return tildify(path) + (offset || limit ? `:${offset || 1}${limit ? '-' + ((offset || 1) + limit - 1) : ''}` : '');
  }
  if (/grep|search|glob|find/.test(lower)) {
    const pattern = get('pattern', 'query', 'queries', 'regex', 'q');
    const where = get('path', 'glob', 'include');
    return truncate(oneLine(pattern + (where ? `  in ${tildify(where)}` : '')), max);
  }
  if (path) return tildify(path);
  const url = get('url', 'uri');
  if (url) return truncate(url, max);
  const text =
    get('description', 'prompt', 'query', 'queries', 'pattern', 'title', 'message', 'objective', 'name', 'skill', 'code', 'patch', 'input') ||
    // last resort: compact JSON
    JSON.stringify(input);
  return truncate(oneLine(firstPatchFile(text) ?? text), max);
}

function firstPatchFile(text: string): string | null {
  const m = /\*\*\* (?:Add|Update|Delete) File: (.+)/.exec(text);
  return m ? `patch ${str(m[1]).trim()}` : null;
}

/** Short failure reason from a tool output, e.g. `exit 1` or the first error line. */
export function errorBrief(output: string, exitCode?: number): string {
  if (exitCode !== undefined && exitCode !== 0) return `exit ${exitCode}`;
  const exit = /(?:exit[_ ]code["']?\s*[:=]?\s*|exited with code |Exit code: )(-?\d+)/i.exec(output);
  if (exit && exit[1] !== '0') return `exit ${exit[1]}`;
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /error|failed|denied|not found|exception|cannot|refused|timed out/i.test(l));
  return truncate(oneLine(line ?? output), 80);
}
