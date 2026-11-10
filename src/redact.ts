import { homedir, userInfo } from 'node:os';
import type { Session, SessionEvent } from './types.ts';

/**
 * Redaction for sharing a session (`blackbox export --redact`). It is a safety
 * net, not a guarantee: always skim an export before posting it publicly.
 */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED ANTHROPIC KEY]'],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED API KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, '[REDACTED GITHUB TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED GITLAB TOKEN]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK TOKEN]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g, '[REDACTED STRIPE KEY]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED NPM TOKEN]'],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, '[REDACTED HF TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [REDACTED]'],
  [/((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, '$1[REDACTED]'],
  // user:password@ in URLs (database URLs, git remotes, proxies)
  [/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/g, '$1[REDACTED]@'],
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export interface RedactOptions {
  emails?: boolean;
  /** Replace the home directory and user name with placeholders. */
  paths?: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makeRedactor(opts: RedactOptions = {}): (text: string) => string {
  const extra: [RegExp, string][] = [];
  if (opts.paths !== false) {
    const h = homedir();
    if (h) {
      extra.push([new RegExp(escapeRe(h), 'gi'), '~']);
      extra.push([new RegExp(escapeRe(h.replace(/\\/g, '/')), 'gi'), '~']);
      extra.push([new RegExp(escapeRe(h.replace(/\\/g, '\\\\')), 'gi'), '~']);
    }
    let user = '';
    try {
      user = userInfo().username;
    } catch {
      // no user info in some sandboxes
    }
    if (user && user.length >= 3) extra.push([new RegExp(`(?<=[\\\\/])${escapeRe(user)}(?=[\\\\/])`, 'g'), 'user']);
  }
  return (text: string) => {
    let out = text;
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    if (opts.emails !== false) out = out.replace(EMAIL, '[REDACTED EMAIL]');
    for (const [re, rep] of extra) out = out.replace(re, rep);
    return out;
  };
}

function redactValue(v: unknown, r: (s: string) => string): unknown {
  if (typeof v === 'string') return r(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, r));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactValue(x, r);
    return out;
  }
  return v;
}

export function redactSession(session: Session, opts: RedactOptions = {}): Session {
  const r = makeRedactor(opts);
  const events = session.events.map((ev) => redactValue(ev, r) as SessionEvent);
  return {
    ...session,
    title: r(session.title),
    cwd: r(session.cwd),
    path: r(session.path),
    events,
  };
}
