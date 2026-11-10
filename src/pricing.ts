import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from './types.ts';
import { home, isObject } from './util.ts';

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PriceRule {
  /** Matched against the lower-cased model id (provider prefixes like `anthropic/` are stripped first). */
  match: RegExp;
  price: Price;
}

/** Last reviewed 2026-11. These are public list prices; your contract may differ — override with a pricing.json. */
export const PRICES_UPDATED = '2026-11';

const p = (input: number, output: number, cacheRead: number, cacheWrite = input * 1.25): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

/** Order matters: the first match wins, so more specific patterns come first. */
const BUILTIN: PriceRule[] = [
  // Anthropic
  { match: /fable-5/, price: p(10, 50, 1) },
  { match: /opus-5/, price: p(4, 20, 0.2) },
  { match: /sonnet-5/, price: p(2, 10, 0.1) },
  { match: /haiku-5/, price: p(0.1, 0.5, 0.01) },
  { match: /opus-4-[5-9]/, price: p(5, 25, 0.5) },
  { match: /opus-4|claude-3-opus/, price: p(15, 75, 1.5) },
  { match: /sonnet-4|sonnet-3-7|3-7-sonnet|3-5-sonnet/, price: p(3, 15, 0.3) },
  { match: /haiku-4/, price: p(1, 5, 0.1) },
  { match: /haiku-3-5|3-5-haiku/, price: p(0.8, 4, 0.08) },
  // OpenAI (cache writes are free on OpenAI except where noted)
  { match: /gpt-6.*astra/, price: p(10, 50, 1, 12.5) },
  { match: /gpt-6.*luna/, price: p(0.1, 0.5, 0.01, 0) },
  { match: /gpt-6.*sol/, price: p(2, 10, 0.2, 0) },
  { match: /gpt-6.*terra/, price: p(1, 6, 0.1, 0) },
  { match: /gpt-5\.6.*sol/, price: p(4, 20, 0.4, 0) },
  { match: /gpt-5\.6.*terra/, price: p(2, 12, 0.2, 0) },
  { match: /gpt-5\.6.*luna/, price: p(0.2, 1.2, 0.02, 0) },
  { match: /gpt-5\.5-pro|gpt-5-pro/, price: p(30, 180, 30, 0) },
  { match: /gpt-5\.5/, price: p(5, 30, 0.5, 0) },
  { match: /gpt-5(\.\d)?-mini|codex-mini/, price: p(0.25, 2, 0.025, 0) },
  { match: /gpt-5(\.\d)?-nano/, price: p(0.05, 0.4, 0.005, 0) },
  { match: /gpt-5\.[4-9]/, price: p(2.5, 15, 0.25, 0) },
  { match: /gpt-5/, price: p(1.25, 10, 0.125, 0) },
  { match: /gpt-4\.1-mini/, price: p(0.4, 1.6, 0.1, 0) },
  { match: /gpt-4\.1/, price: p(2, 8, 0.5, 0) },
  { match: /gpt-4o-mini/, price: p(0.15, 0.6, 0.075, 0) },
  { match: /gpt-4o/, price: p(2.5, 10, 1.25, 0) },
  { match: /\bo4-mini|\bo3-mini/, price: p(1.1, 4.4, 0.275, 0) },
  { match: /\bo3\b/, price: p(2, 8, 0.5, 0) },
  // DeepSeek (peak-hour list prices; off-peak is half)
  { match: /deepseek.*(v4-?pro|pro)/, price: p(1.32, 3.96, 0.044, 0) },
  { match: /deepseek.*flash|deepseek-chat|deepseek-v4/, price: p(0.3, 1.2, 0.006, 0) },
  { match: /deepseek-reasoner|deepseek-r1/, price: p(0.55, 2.19, 0.14, 0) },
  // Google
  { match: /gemini-.*pro/, price: p(1.25, 10, 0.31, 0) },
  { match: /gemini-.*flash-lite/, price: p(0.1, 0.4, 0.025, 0) },
  { match: /gemini-.*flash/, price: p(0.3, 2.5, 0.075, 0) },
  // Others commonly used through OpenCode
  { match: /kimi-k2/, price: p(0.6, 2.5, 0.15, 0) },
  { match: /minimax-m3(\.\d)?-flash/, price: p(0.15, 0.6, 0.015, 0) },
  { match: /minimax-m3/, price: p(0.3, 1.2, 0.06, 0) },
  { match: /glm-5\.[2-9]/, price: p(1.4, 4.4, 0.26, 0) },
  { match: /glm-4\.[5-9]|glm-5/, price: p(0.6, 2.2, 0.11, 0) },
  { match: /qwen3-coder/, price: p(0.45, 1.8, 0.1, 0) },
];

let userRules: PriceRule[] | null = null;

function loadUserRules(): PriceRule[] {
  if (userRules) return userRules;
  userRules = [];
  const file = process.env.BLACKBOX_PRICING || join(home(), '.config', 'agent-blackbox', 'pricing.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return userRules;
  }
  if (!isObject(raw)) return userRules;
  for (const [pattern, v] of Object.entries(raw)) {
    if (!isObject(v)) continue;
    const input = Number(v.input ?? 0);
    try {
      userRules.push({
        match: new RegExp(pattern, 'i'),
        price: {
          input,
          output: Number(v.output ?? 0),
          cacheRead: Number(v.cacheRead ?? input * 0.1),
          cacheWrite: Number(v.cacheWrite ?? input),
        },
      });
    } catch {
      // invalid regex in user config: ignore that entry
    }
  }
  return userRules;
}

/** For tests. */
export function resetPricingCache(): void {
  userRules = null;
}

export function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/^.*\//, '').replace(/@.*$/, '').replace(/\[.*\]$/, '');
}

export function priceFor(model: string): Price | null {
  if (!model) return null;
  const m = normalizeModel(model);
  for (const rule of loadUserRules()) if (rule.match.test(m)) return rule.price;
  for (const rule of BUILTIN) if (rule.match.test(m)) return rule.price;
  return null;
}

export function costOf(model: string, u: Usage, opts: { cacheWrite1h?: number } = {}): { usd: number; priced: boolean } {
  const price = priceFor(model);
  if (!price) return { usd: 0, priced: false };
  const write1h = Math.min(opts.cacheWrite1h ?? 0, u.cacheWrite);
  const write5m = u.cacheWrite - write1h;
  const usd =
    (u.input * price.input +
      u.output * price.output +
      u.cacheRead * price.cacheRead +
      write5m * price.cacheWrite +
      // Anthropic bills 1-hour cache writes at 2x the input price.
      write1h * price.input * 2) /
    1_000_000;
  return { usd, priced: true };
}
