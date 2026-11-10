/** Worker thread: parse sessions and send back their summaries (never the full event list). */
import { parentPort } from 'node:worker_threads';
import { adapterFor } from './adapters/index.ts';
import type { Session, SessionRef, SessionSummary } from './types.ts';

function summarize(session: Session): SessionSummary {
  const { events: _events, ...summary } = session;
  return summary;
}

parentPort?.on('message', async (msg: { i: number; ref: SessionRef }) => {
  try {
    const session = await adapterFor(msg.ref.agent).load(msg.ref);
    parentPort?.postMessage({ i: msg.i, summary: summarize(session) });
  } catch (err) {
    parentPort?.postMessage({ i: msg.i, error: err instanceof Error ? err.message : String(err) });
  }
});
