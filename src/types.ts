/**
 * The normalized data model. Every adapter (Claude Code, Codex, OpenCode,
 * DeepSeek Harness, ...) turns its native log format into these shapes, so the
 * CLI, the web UI and the exporters never have to know where a session came from.
 */

export type AgentKind = 'claude-code' | 'codex' | 'opencode' | 'deepseek-harness';

export const AGENT_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'deepseek-harness': 'DeepSeek Harness',
};

/** Token counts. `input` never includes cached tokens; cache reads/writes are separate. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning/thinking tokens when the provider reports them separately (already part of `output` for most providers). */
  reasoning: number;
}

export interface Cost {
  usd: number;
  /**
   * - `recorded`: the agent wrote the cost into its own log for the whole session
   * - `mixed`: recorded for part of the session (e.g. after an agent upgrade started
   *   recording costs), estimated for the rest
   * - `estimated`: computed from token counts and the built-in price table
   * - `partial`: estimated, but some models had no known price
   * - `unknown`: no usage data at all
   */
  source: 'recorded' | 'mixed' | 'estimated' | 'partial' | 'unknown';
  /** For `recorded`/`mixed`: epoch ms from which the agent's own accounting covers the session. */
  recordedSince?: number;
}

export interface FileEdit {
  path: string;
  added: number;
  removed: number;
  /** `create`, `modify` or `delete`. */
  op: 'create' | 'modify' | 'delete';
  /** Unified-diff style body (lines prefixed with `+`, `-` or ` `), possibly truncated. */
  diff?: string;
}

interface EventBase {
  /** Epoch milliseconds. 0 when the log has no timestamp for this event. */
  t: number;
}

export interface UserEvent extends EventBase {
  kind: 'user';
  text: string;
  images?: number;
  /** Set when the "prompt" was written by a parent agent delegating a task, not by a human. */
  from?: 'agent';
}

export interface AssistantEvent extends EventBase {
  kind: 'assistant';
  text: string;
  model?: string;
}

export interface ThinkingEvent extends EventBase {
  kind: 'thinking';
  text: string;
}

export interface ToolEvent extends EventBase {
  kind: 'tool';
  id: string;
  name: string;
  /** Parsed JSON input when possible, otherwise the raw string. */
  input: unknown;
  output: string;
  isError: boolean;
  /** Process exit code for shell-like tools, when the agent recorded it. */
  exitCode?: number;
  /** Epoch ms when the result arrived, if known. */
  endT?: number;
  edits?: FileEdit[];
  /** For nested calls (e.g. DeepSeek Harness programmatic tool calls). */
  parentId?: string;
}

/** One model request (one API call) and what it cost. */
export interface UsageEvent extends EventBase {
  kind: 'usage';
  model: string;
  usage: Usage;
  usd: number;
  /** false when no price is known for this model. */
  priced: boolean;
}

export interface SystemEvent extends EventBase {
  kind: 'system';
  text: string;
  level: 'info' | 'warning' | 'error';
}

export interface CompactEvent extends EventBase {
  kind: 'compact';
  text: string;
}

export type SessionEvent =
  | UserEvent
  | AssistantEvent
  | ThinkingEvent
  | ToolEvent
  | UsageEvent
  | SystemEvent
  | CompactEvent;

export type SessionFlag =
  /** DeepSeek Harness acknowledged uploading this session's log to the DeepSeek API. */
  | 'log-uploaded'
  /** The session is a sub-agent spawned by another session. */
  | 'subagent'
  /** The log ended in the middle of a turn (crash, kill, or still running). */
  | 'incomplete';

/** Where a session lives on disk. `path` may carry a `#fragment` for DB-backed agents. */
export interface SessionRef {
  agent: AgentKind;
  /** Stable key used in URLs and the cache. */
  key: string;
  path: string;
  /** Native session id. */
  id: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface SessionSummary {
  key: string;
  agent: AgentKind;
  id: string;
  path: string;
  title: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  /** Time actually spent working: gaps longer than 5 minutes between events count as idle. */
  activeMs: number;
  models: string[];
  /** Number of human prompts. */
  prompts: number;
  toolCalls: number;
  toolErrors: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  usage: Usage;
  cost: Cost;
  /** Calls per tool name. */
  toolCounts: Record<string, number>;
  /** Estimated cost and total tokens per model. */
  modelUsage: Record<string, { usd: number; tokens: number }>;
  flags: SessionFlag[];
  sizeBytes: number;
  /** For sub-agent sessions: the key of the session that spawned it. */
  parentKey?: string;
  /** For sub-agent sessions: the parent's tool call that spawned it (Claude Code `toolUseId`). */
  parentToolId?: string;
  /** Sub-agent type or nickname, e.g. `Explore` or `Ampere`. */
  agentName?: string;
  /** Computed when listing: how many sub-agent sessions this session spawned. */
  children?: number;
  /**
   * Computed when listing: this sub-agent's cost is already part of its parent's
   * recorded cost (Claude Code records process-wide cost), so totals must not add it again.
   */
  costInParent?: boolean;
}

export interface Session extends SessionSummary {
  events: SessionEvent[];
}

export interface Adapter {
  agent: AgentKind;
  /** Directories (or files) searched by default. */
  defaultRoots(): string[];
  discover(roots: string[]): Promise<SessionRef[]>;
  load(ref: SessionRef): Promise<Session>;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function addUsage(into: Usage, u: Partial<Usage>): Usage {
  into.input += u.input ?? 0;
  into.output += u.output ?? 0;
  into.cacheRead += u.cacheRead ?? 0;
  into.cacheWrite += u.cacheWrite ?? 0;
  into.reasoning += u.reasoning ?? 0;
  return into;
}

/** The cost a session adds to totals: 0 when it is already counted in its parent's recorded cost. */
export function ownCost(s: Pick<SessionSummary, 'cost' | 'costInParent'>): number {
  return s.costInParent ? 0 : s.cost.usd;
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}
