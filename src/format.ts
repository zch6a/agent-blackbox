/** Terminal formatting helpers: colors that respect NO_COLOR / non-TTY, numbers, money, durations, tables. */

let colorEnabled = !process.env.NO_COLOR && (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !!process.stdout.isTTY);

export function setColor(on: boolean): void {
  colorEnabled = on;
}

const wrap = (open: number, close: number) => (s: string) => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function money(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return '$' + usd.toFixed(2);
  return '$' + Math.round(usd).toLocaleString('en-US');
}

/** `plural(1, 'prompt')` → "1 prompt", `plural(3, 'file')` → "3 files". */
export function plural(n: number, word: string, many = word + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M';
  return (n / 1_000_000_000).toFixed(2) + 'B';
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(ms: number, now = Date.now()): string {
  if (!ms) return '—';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function clock(ms: number): string {
  if (!ms) return '--:--:--';
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Display width: strips ANSI codes and counts East Asian wide characters as 2 columns. */
export function width(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 32 || (cp >= 0x300 && cp < 0x370) || cp === 0x200b) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Truncate to a display width (ANSI-unaware: call on plain text). */
export function fit(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function pad(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, w - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

export interface Column {
  header: string;
  align?: 'left' | 'right';
  /** Column may shrink to fit the terminal; the flexible column absorbs the slack. */
  flex?: boolean;
  min?: number;
}

/** Render a table that fits the terminal width by shrinking the flex column. */
export function table(columns: Column[], rows: string[][], termWidth = process.stdout.columns || 120): string {
  const widths = columns.map((col, i) => Math.max(width(col.header), ...rows.map((r) => width(r[i] ?? ''))));
  const total = widths.reduce((a, w) => a + w, 0) + (columns.length - 1) * 2;
  const flexIdx = columns.findIndex((col) => col.flex);
  if (total > termWidth && flexIdx >= 0) {
    const over = total - termWidth;
    widths[flexIdx] = Math.max(columns[flexIdx]!.min ?? 12, widths[flexIdx]! - over);
  }
  const line = (cells: string[], style?: (s: string) => string) =>
    cells
      .map((cell, i) => {
        const col = columns[i]!;
        const w = widths[i]!;
        const plain = cell.replace(ANSI, '');
        const shown = width(plain) > w ? fit(plain, w) : cell;
        const padded = pad(shown, w, col.align);
        return style ? style(padded) : padded;
      })
      .join('  ')
      .trimEnd();
  return [line(columns.map((col) => col.header), c.dim), ...rows.map((r) => line(r))].join('\n');
}

export function bar(value: number, max: number, w = 24): string {
  if (max <= 0) return '';
  const blocks = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const exact = (value / max) * w;
  const full = Math.floor(exact);
  const rest = Math.round((exact - full) * 8);
  return '█'.repeat(full) + (rest > 0 && full < w ? (blocks[rest] ?? '') : '');
}

/** Parse `7d`, `12h`, `30m`, `2w`, or an ISO date into an epoch-ms lower bound. */
export function parseSince(v: string, now = Date.now()): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w|mo|y)$/i.exec(v.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    const ms = { m: 60e3, min: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, mo: 30 * 86400e3, y: 365 * 86400e3 }[unit] ?? 0;
    return now - n * ms;
  }
  if (/^today$/i.test(v)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
