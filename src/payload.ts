import { toolBrief, errorBrief } from './describe.ts';
import type { Session, SessionEvent } from './types.ts';

/** Shape sent to the browser: tool events carry a pre-computed one-line `brief`. */
export type UiEvent = SessionEvent & { brief?: string; err?: string; clipped?: boolean };
export interface UiSession extends Omit<Session, 'events'> {
  events: UiEvent[];
}

function clipText(text: string, max: number): [string, boolean] {
  if (text.length <= max) return [text, false];
  return [text.slice(0, max), true];
}

function clipInput(input: unknown, max: number): [unknown, boolean] {
  if (typeof input === 'string') return clipText(input, max);
  const json = JSON.stringify(input ?? null);
  if (json.length <= max) return [input, false];
  return [json.slice(0, max), true];
}

/**
 * Make a session small enough to ship to a browser: long tool outputs, inputs
 * and messages are clipped (the UI can fetch a single event in full).
 */
export function toPayload(session: Session, maxText = 6000): UiSession {
  const events = session.events.map((ev): UiEvent => {
    switch (ev.kind) {
      case 'tool': {
        const [output, oc] = clipText(ev.output, maxText);
        const [input, ic] = clipInput(ev.input, maxText);
        const out: UiEvent = { ...ev, output, input, brief: toolBrief(ev.name, ev.input) };
        if (ev.isError) out.err = errorBrief(ev.output, ev.exitCode);
        if (oc || ic) out.clipped = true;
        return out;
      }
      case 'assistant':
      case 'user':
      case 'thinking':
      case 'system':
      case 'compact': {
        const [text, clipped] = clipText(ev.text, maxText * 3);
        return clipped ? { ...ev, text, clipped } : ev;
      }
      default:
        return ev;
    }
  });
  return { ...session, events };
}

/** Serialize JSON safely for embedding inside a <script> tag. */
// Built from char codes so the source stays plain ASCII.
const BACKSLASH = String.fromCharCode(92);
const ESCAPES: [string, string][] = [
  ['<', 'u003c'],
  ['>', 'u003e'],
  ['&', 'u0026'],
  [String.fromCharCode(0x2028), 'u2028'],
  [String.fromCharCode(0x2029), 'u2029'],
];

export function scriptJson(value: unknown): string {
  let out = JSON.stringify(value) ?? 'null';
  for (const [ch, code] of ESCAPES) out = out.split(ch).join(BACKSLASH + code);
  return out;
}
