import zlib from 'node:zlib';

/**
 * Append-only logs (DeepSeek Harness, and anything that appends one zstd frame
 * per write) are a concatenation of many independent zstd frames. Node's
 * `zstdDecompressSync` stops after the first frame, so we walk the frame
 * headers ourselves (RFC 8878 §3.1) and decompress frame by frame.
 *
 * Only the frame/block *headers* are parsed here — the actual decoding is done
 * by Node's built-in zstd implementation.
 */

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

export class ZstdFormatError extends Error {}

/** Split a buffer into byte ranges of complete zstd frames. A truncated trailing frame is ignored. */
export function splitZstdFrames(buf: Uint8Array): Uint8Array[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frames: Uint8Array[] = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const magic = view.getUint32(p, true);
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (p + 8 > buf.length) break;
      p += 8 + view.getUint32(p + 4, true);
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      if (frames.length === 0) throw new ZstdFormatError(`not a zstd stream (bad magic at byte ${p})`);
      break; // trailing garbage after valid frames: stop, keep what we have
    }
    const start = p;
    p += 4;
    if (p >= buf.length) break;
    const fhd = buf[p++] as number;
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictIdFlag = fhd & 3;
    if (!singleSegment) p += 1; // window descriptor
    p += [0, 1, 2, 4][dictIdFlag] as number;
    p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag] as number;
    let complete = false;
    while (p + 3 <= buf.length) {
      const h = (buf[p] as number) | ((buf[p + 1] as number) << 8) | ((buf[p + 2] as number) << 16);
      p += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      if (type === 3) throw new ZstdFormatError(`reserved block type at byte ${p - 3}`);
      p += type === 1 ? 1 : size;
      if (last) {
        complete = true;
        break;
      }
    }
    if (checksum) p += 4;
    if (!complete || p > buf.length) break; // partial frame being written right now
    frames.push(buf.subarray(start, p));
  }
  return frames;
}

export function hasZstdSupport(): boolean {
  return typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function';
}

/** Decompress every complete frame and concatenate the output as UTF-8 text. */
export function decompressZstdFrames(buf: Uint8Array): string {
  if (!hasZstdSupport()) {
    throw new Error('This Node.js version has no built-in zstd. Please use Node.js 22.15+ or 23.8+.');
  }
  const decoder = new TextDecoder();
  let out = '';
  for (const frame of splitZstdFrames(buf)) {
    try {
      out += decoder.decode(zlib.zstdDecompressSync(frame), { stream: true });
    } catch {
      // A corrupt frame should not hide the rest of the session.
    }
  }
  return out + decoder.decode();
}
