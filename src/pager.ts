import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Find an executable on PATH (honours PATHEXT on Windows). */
export function which(cmd: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** The pager to use, or null for "print directly". */
export function resolvePager(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.BLACKBOX_PAGER ?? env.PAGER;
  if (configured !== undefined) {
    const cmd = configured.trim();
    return cmd && cmd !== 'cat' ? cmd : null;
  }
  if (which('less')) return 'less -FRX';
  // Windows: Git for Windows ships a less that is usually not on PATH.
  if (process.platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
      const less = base && join(base, 'Git', 'usr', 'bin', 'less.exe');
      if (less && existsSync(less)) return `"${less}" -FRX`;
    }
  }
  return null;
}

/**
 * Print long output through a pager, like `git log`: only when stdout is a
 * terminal and the text is taller than it. `$BLACKBOX_PAGER` / `$PAGER`
 * override the default `less -FRX`; set either to `cat` (or pass --no-pager)
 * to disable. Falls back to plain printing if no pager is available.
 */
export async function printPaged(text: string, opts: { enabled?: boolean } = {}): Promise<void> {
  const out = text.endsWith('\n') ? text : text + '\n';
  const rows = process.stdout.rows || 0;
  const pager = opts.enabled === false || !process.stdout.isTTY || !rows || text.split('\n').length <= rows - 1 ? null : resolvePager();
  if (!pager) {
    process.stdout.write(out);
    return;
  }
  const ok = await new Promise<boolean>((resolve) => {
    let started = false;
    const child = spawn(pager, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], env: { LESS: 'FRX', LESSCHARSET: 'utf-8', ...process.env } });
    child.on('spawn', () => {
      started = true;
      child.stdin.on('error', () => {}); // the user quit the pager early
      child.stdin.end(out);
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(started && code !== 127 && code !== 9009)); // 127 / 9009: command not found
  });
  if (!ok) process.stdout.write(out);
}
