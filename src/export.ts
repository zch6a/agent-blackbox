import { readFile } from 'node:fs/promises';
import { errorBrief, toolBrief } from './describe.ts';
import { clock, duration, localDate, money, tokens } from './format.ts';
import { scriptJson, toPayload } from './payload.ts';
import { PRICES_UPDATED } from './pricing.ts';
import { activeDuration } from './stats.ts';
import { AGENT_LABELS, totalTokens, type Session } from './types.ts';
import { uiFile } from './ui-assets.ts';
import { tildify } from './util.ts';
import { VERSION } from './version.ts';

export type ExportFormat = 'html' | 'md' | 'json';

/**
 * A single self-contained HTML file: the full replay UI with the session (and
 * its sub-agents, which can be opened from the parent's tool calls) embedded.
 * Works offline.
 */
export async function exportHtml(session: Session, children: Session[] = []): Promise<string> {
  const [html, css, js] = await Promise.all([
    readFile(uiFile('index.html'), 'utf8'),
    readFile(uiFile('style.css'), 'utf8'),
    readFile(uiFile('app.js'), 'utf8'),
  ]);
  // Sub-agents get a tighter output budget so a big family stays a shareable size.
  const boot = {
    mode: 'export',
    version: VERSION,
    pricesUpdated: PRICES_UPDATED,
    session: toPayload(session, 8000),
    children: children.map((c) => toPayload(c, 3000)),
  };
  return html
    .replace('<link rel="stylesheet" href="style.css" />', () => `<style>${css}</style>`)
    .replace('<link rel="icon" href="favicon.svg" type="image/svg+xml" />', '')
    .replace('<!--BOOT-->', () => `<script>window.__BLACKBOX__=${scriptJson(boot)}</script>`)
    .replace('<script src="app.js"></script>', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\s+$/, '')}\n${ticks}`;
}

function quote(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
}

export function exportMarkdown(s: Session, opts: { thinking?: boolean; outputs?: boolean } = {}): string {
  const u = s.usage;
  const out: string[] = [
    `# ${s.title}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Agent | ${AGENT_LABELS[s.agent]} |`,
    `| Project | \`${tildify(s.cwd) || '—'}\` |`,
    `| When | ${localDate(s.startedAt)} ${clock(s.startedAt)} – ${clock(s.endedAt)} (${duration(activeDuration(s))}) |`,
    `| Models | ${s.models.join(', ') || '—'} |`,
    `| Cost | ${money(s.cost.usd)} (${s.cost.source}) |`,
    `| Tokens | ${tokens(totalTokens(u))} (input ${tokens(u.input)}, output ${tokens(u.output)}, cache read ${tokens(u.cacheRead)}, cache write ${tokens(u.cacheWrite)}) |`,
    `| Activity | ${s.prompts} prompts · ${s.toolCalls} tool calls (${s.toolErrors} failed) · ${s.filesChanged} files (+${s.linesAdded} −${s.linesRemoved}) |`,
    '',
    '---',
    '',
  ];
  for (const ev of s.events) {
    switch (ev.kind) {
      case 'user':
        out.push(`### 🧑 ${clock(ev.t)}`, '', quote(ev.text), '');
        break;
      case 'assistant':
        out.push(`### 🤖 ${clock(ev.t)}`, '', ev.text.trimEnd(), '');
        break;
      case 'thinking':
        if (opts.thinking) out.push('<details><summary>Thinking</summary>', '', ev.text.trimEnd(), '', '</details>', '');
        break;
      case 'tool': {
        const status = ev.isError ? `❌ ${errorBrief(ev.output, ev.exitCode)}` : '✅';
        const edits = (ev.edits ?? []).map((e) => ` +${e.added} −${e.removed}`).join('');
        out.push(`- **${ev.name}** \`${toolBrief(ev.name, ev.input, 200).replace(/`/g, "'")}\`${edits} ${status}`);
        if (ev.edits?.some((e) => e.diff)) {
          out.push('', '  <details><summary>Diff</summary>', '');
          for (const e of ev.edits) if (e.diff) out.push(fence(`--- ${e.path}\n${e.diff}`, 'diff'), '');
          out.push('  </details>', '');
        }
        if (opts.outputs || ev.isError) {
          if (ev.output.trim()) out.push('', fence(ev.output.slice(0, 4000)), '');
        }
        break;
      }
      case 'system':
        out.push(`> ${ev.level === 'error' ? '⚠️ ' : ''}*${ev.text.split('\n')[0]}*`, '');
        break;
      case 'compact':
        out.push('---', '', '*Context compacted*', '', '---', '');
        break;
    }
  }
  out.push('', `<sub>Exported with agent-blackbox ${VERSION}</sub>`, '');
  return out.join('\n');
}

export function exportJson(s: Session): string {
  return JSON.stringify({ format: 'agent-blackbox/session', version: 1, exportedBy: `agent-blackbox ${VERSION}`, session: s }, null, 2);
}
