import { userInfo } from 'node:os';
import type { Session, SessionEvent } from './types.ts';
import { safeHomedir } from './util.ts';

/**
 * Redaction for sharing a session (`blackbox export --redact`). It is a safety
 * net, not a guarantee: always skim an export before posting it publicly.
 */
// Every pattern starts where its token can start (a lookbehind for "not the same kind of character") and has
// bounded runs, so a long line of dots, dashes or letters is scanned once, not once per position (a 100 KB line
// of "a." took 7.5 s through the old e-mail pattern).
const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // To the END line, or to the end of the text if it was cut off.
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED ANTHROPIC KEY]'],
  // OpenAI-style keys mix cases and digits; DeepSeek's are long and have no dashes. A branch called
  // `sk-feature-login-flow-v2` is neither.
  [/(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, (m) => {
    const body = m.replace(/^sk-(?:proj-|svcacct-)?/, '');
    return /\d/.test(body) && (/[A-Z]/.test(body) || !body.includes('-')) ? '[REDACTED API KEY]' : m;
  }],
  [/(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED GITHUB TOKEN]'],
  [/(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED GITHUB TOKEN]'],
  [/(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED GITLAB TOKEN]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]'],
  [/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, '[REDACTED GOOGLE KEY]'],
  [/(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,}/g, '[REDACTED GOOGLE OAUTH SECRET]'],
  [/(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK TOKEN]'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,}/g, '[REDACTED SLACK WEBHOOK]'],
  [/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g, '[REDACTED DISCORD WEBHOOK]'],
  [/(?<![A-Za-z0-9_])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g, '[REDACTED STRIPE KEY]'],
  [/(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}\b/g, '[REDACTED NPM TOKEN]'],
  [/(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}\b/g, '[REDACTED HF TOKEN]'],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [REDACTED]'],
  // name = value, name: value, "name": "value", and the same JSON-escaped inside a string (\"name\": \"value\").
  // The name may be part of a longer one (SECRET_KEY, PGPASSWORD, db_password). Code is left alone:
  // `token = getToken()`, `password: process.env.DB_PASSWORD`.
  [
    /(?<![A-Za-z0-9_])([A-Za-z0-9_]{0,40}?(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key)[A-Za-z0-9_]{0,40}\\?["']?[ \t]*[:=][ \t]*\\?["']?)([^\s"'\\,;]{6,})/gi,
    (m, name: string, value: string) =>
      // A call, an environment lookup, or a dotted name without digits (form.value, cfg.db.password) is code.
      /[()]|^(?:process\.env|os\.environ|env\.|\$|self\.|this\.)/.test(value) || (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value) && !/\d/.test(value))
        ? m
        : name + '[REDACTED]',
  ],
  // user:password@ in URLs (database URLs, git remotes, proxies); the password may itself contain "@", so it runs
  // to the last "@" before the host.
  [/((?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,200}:)[^\s/]{1,200}@(?=[^\s/@]{1,253}(?:[/:?#\s]|$))/g, '$1[REDACTED]@'],
];

// Bounded local part and domain, starting only at the start of a run: linear. Not e-mail: `git@host` (an SSH
// remote) and `name@1.2.3` / `pkg@1.2.3.tgz` (package versions).
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24})(?![A-Za-z0-9-])/g;
const NOT_A_PERSON = /^(?:git|hg|svn)$/i;
const FILE_EXT = /\.(?:tgz|tar|gz|zip|js|mjs|cjs|ts|json|md|txt|lock|whl|jar|png|jpg|svg)$/i;

function email(m: string, local: string, domain: string): string {
  if (NOT_A_PERSON.test(local) || /^\d/.test(domain) || FILE_EXT.test(domain)) return m;
  return '[REDACTED EMAIL]';
}

export interface RedactOptions {
  emails?: boolean;
  /** Replace the home directory and user name with placeholders. */
  paths?: boolean;
  /** The home folder to replace (default: this machine's). */
  home?: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The home folder as a whole path component: `/home/al` must not eat the start of `/home/alex`. */
function homePattern(h: string): RegExp | null {
  const trimmed = h.replace(/[\\/]+$/, '');
  // `/` (a container user with no home) or a drive root would match every path.
  if (trimmed.replace(/^[A-Za-z]:/, '').length < 2) return null;
  // Windows and macOS folders ignore case; Linux ones do not.
  const flags = process.platform === 'linux' ? 'g' : 'gi';
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeRe(trimmed)}(?![A-Za-z0-9._-])`, flags);
}

export function makeRedactor(opts: RedactOptions = {}): (text: string) => string {
  const extra: [RegExp, string][] = [];
  if (opts.paths !== false) {
    const h = opts.home ?? safeHomedir();
    if (h) {
      for (const form of new Set([h, h.replace(/\\/g, '/'), h.replace(/\\/g, '\\\\')])) {
        const re = homePattern(form);
        if (re) extra.push([re, '~']);
      }
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
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep as never);
    if (opts.emails !== false) out = out.replace(EMAIL, email as never);
    for (const [re, rep] of extra) out = out.replace(re, rep);
    return out;
  };
}

/** Keys whose string values are secrets whatever they look like (`{env: {PGPASSWORD: "…"}}`, `{token: "…"}`). */
const SECRET_KEY = /(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?|cookie)$/i;

function redactValue(v: unknown, r: (s: string) => string, key = ''): unknown {
  if (typeof v === 'string') return key && SECRET_KEY.test(key) && v.trim() ? '[REDACTED]' : r(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, r));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: redactValue(x, r, k), enumerable: true, writable: true, configurable: true });
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
