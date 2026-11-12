import type { Adapter, AgentKind } from '../types.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { deepseekAdapter } from './deepseek.ts';
import { geminiAdapter } from './gemini.ts';
import { opencodeAdapter } from './opencode.ts';

export const ADAPTERS: readonly Adapter[] = [claudeAdapter, codexAdapter, opencodeAdapter, deepseekAdapter, geminiAdapter];

export function adapterFor(agent: AgentKind): Adapter {
  const a = ADAPTERS.find((x) => x.agent === agent);
  if (!a) throw new Error(`Unknown agent: ${agent}`);
  return a;
}

/** Accept friendly aliases on the command line. */
export function parseAgent(name: string): AgentKind | null {
  const n = name.toLowerCase().replace(/[\s_]/g, '-');
  if (['claude', 'claude-code', 'cc'].includes(n)) return 'claude-code';
  if (['codex', 'openai', 'codex-cli'].includes(n)) return 'codex';
  if (['opencode', 'oc'].includes(n)) return 'opencode';
  if (['deepseek', 'deepseek-harness', 'dsh', 'ds'].includes(n)) return 'deepseek-harness';
  if (['gemini', 'gemini-cli', 'google'].includes(n)) return 'gemini-cli';
  return null;
}
