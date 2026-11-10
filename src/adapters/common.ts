/**
 * Classification shared by agents that smuggle automation and context into
 * "user" messages. Getting this right is what makes "prompts" mean
 * "things a human actually typed".
 */

export type UserTextKind =
  | { kind: 'human'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'system'; text: string; level: 'info' | 'warning' }
  | { kind: 'shell'; text: string }
  | { kind: 'ignore' };

/** Tags whose whole message is injected context, never human input. */
const INJECTED_TAGS = new Set([
  'system-reminder',
  'environment_context',
  'user_instructions',
  'permissions instructions',
  'app-context',
  'collaboration_mode',
  'skills_instructions',
  'subagent_notification',
  'codex_internal_context',
  'heartbeat',
  'in-app-browser-context',
  'recommended_plugins',
  'external_codex_apps_writing_block_edits',
  'local-command-caveat',
  'multi_agent_role',
  'multi_agent_mode',
]);

const INJECTED_PREFIXES = ['# AGENTS.md instructions', 'Caveat: The messages below were generated'];

/** Turn `<command-name>/foo</command-name><command-args>bar</command-args>` into `/foo bar`. */
export function slashCommand(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return (name.startsWith('/') ? name : '/' + name) + (args ? ' ' + args : '');
}

/** `<task-notification>…<summary>X</summary>…` → "Task notification (completed): X". */
export function taskNotification(text: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  const status = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim();
  return 'Task notification' + (status ? ` (${status})` : '') + (summary ? `: ${summary}` : '');
}

function leadingTag(text: string): string | null {
  return /^<([a-zA-Z][\w -]*)>/.exec(text)?.[1] ?? null;
}

export function classifyUserText(raw: string): UserTextKind {
  const text = raw.trimStart();
  if (!text) return { kind: 'ignore' };
  if (text.startsWith('<task-notification>')) return { kind: 'system', text: taskNotification(text), level: 'info' };
  const cmd = slashCommand(text);
  if (cmd) return { kind: 'command', text: cmd };
  if (text.startsWith('<local-command-stdout>') || text.startsWith('<local-command-stderr>')) {
    const out = text.replace(/<\/?local-command-std(out|err)>/g, '').trim();
    return out ? { kind: 'system', text: out, level: text.startsWith('<local-command-stderr>') ? 'warning' : 'info' } : { kind: 'ignore' };
  }
  if (text.startsWith('<bash-input>')) return { kind: 'shell', text: text.replace(/<\/?bash-input>/g, '').trim() };
  if (text.startsWith('<user_shell_command>')) return { kind: 'shell', text: text.replace(/<\/?user_shell_command>/g, '').trim() };
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) {
    const out = text.replace(/<\/?bash-std(out|err)>/g, '').trim();
    return out ? { kind: 'system', text: out, level: 'info' } : { kind: 'ignore' };
  }
  if (text.startsWith('[Request interrupted') || text.startsWith('<turn_aborted>')) {
    return { kind: 'system', text: text.startsWith('<turn_aborted>') ? 'Turn aborted by user' : text, level: 'warning' };
  }
  const tag = leadingTag(text);
  if (tag && INJECTED_TAGS.has(tag)) return { kind: 'ignore' };
  if (INJECTED_PREFIXES.some((p) => text.startsWith(p))) return { kind: 'ignore' };
  if (tag === 'send_user_message_question_reply') {
    return { kind: 'human', text: text.replace(/<\/?send_user_message_question_reply>/g, '').trim() };
  }
  if (text.startsWith('# Context from my IDE setup')) {
    const req = /## My request for Codex:\s*([\s\S]*)$/.exec(text)?.[1]?.trim();
    return req ? { kind: 'human', text: req } : { kind: 'ignore' };
  }
  return { kind: 'human', text: raw };
}
