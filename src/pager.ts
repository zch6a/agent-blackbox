import { spawn } from 'node:child_process';

/**
 * Print long output through a pager, like `git log`: only when stdout is a
 * terminal and the text is taller than it. `$BLACKBOX_PAGER` / `$PAGER`
 * override the default `less -FRX`; set either to `cat` (or pass --no-pager)
 * to disable. Falls back to plain printing if no pager can be started.
 */
export async function printPaged(text: string, opts: { enabled?: boolean } = {}): Promise<void> {
  const rows = process.stdout.rows || 0;
  const lines = text.split('\n').length;
  const pagerCmd = process.env.BLACKBOX_PAGER ?? process.env.PAGER ?? 'less -FRX';
  if (opts.enabled === false || !process.stdout.isTTY || !rows || lines <= rows - 1 || !pagerCmd.trim() || pagerCmd.trim() === 'cat') {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    return;
  }
  const ok = await new Promise<boolean>((resolve) => {
    let started = false;
    const child = spawn(pagerCmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], env: { LESS: 'FRX', ...process.env } });
    child.on('spawn', () => {
      started = true;
      child.stdin.on('error', () => {}); // user quit the pager early
      child.stdin.end(text);
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(started && code !== 127 && code !== 9009)); // 127 / 9009: command not found
  });
  if (!ok) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}
