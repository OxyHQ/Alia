/**
 * What a page may hand the agent as a file: documents, images and text, at
 * most 20 MiB each, checked by their bytes and not by what the site called them.
 *
 * Adapted from OpenMuse `apps/worker/src/downloads.ts` (MIT, see ../../NOTICE),
 * widened from PDF-only to the types an agent's work needs and narrowed to the
 * worker's memory: the file is streamed to the container's tmpfs with a byte
 * cap, and only once it is complete and recognised does it become a PENDING
 * download. The control API then moves it into the actor's `/workspace/downloads`
 * (`browser-service.ts`) and the worker forgets it.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PENDING_DOWNLOADS = 10;

export interface PendingDownload {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  path: string;
}

export interface DownloadFailure {
  name: string;
  reason: 'too_large' | 'unsupported_type' | 'limit' | 'interrupted';
  at: string;
}

/** The part of Playwright's `Download` this needs, so tests can hand in a stream. */
export interface DownloadSource {
  suggestedFilename(): string;
  createReadStream(): Promise<Readable>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
}

/** A file name safe on any filesystem, with no path in it. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\p{L}\p{N}._ ()-]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'download';
}

/**
 * The type the bytes declare, or `null`. Text is accepted when its first
 * kilobytes are valid UTF-8 with no NUL: CSV, JSON, Markdown, iCalendar.
 */
export function sniffType(head: Buffer): string | null {
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, i) => head[offset + i] === byte);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  // Office documents, OpenDocument and EPUB are zip containers.
  if (starts([0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (head.length === 0 || head.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(trimPartialUtf8(head));
    return 'text/plain';
  } catch {
    return null;
  }
}

/** Drop an incomplete multi-byte sequence at the end of a prefix. */
function trimPartialUtf8(buffer: Buffer): Buffer {
  let end = buffer.length;
  for (let i = 1; i <= 3 && end - i >= 0; i += 1) {
    const byte = buffer[end - i] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (width > i) end -= i;
    break;
  }
  return buffer.subarray(0, end);
}

export type CaptureResult =
  | { ok: true; download: PendingDownload }
  | { ok: false; failure: DownloadFailure };

export async function captureDownload(options: {
  source: DownloadSource;
  directory: string;
  limitReached: boolean;
  now?: () => number;
}): Promise<CaptureResult> {
  const { source, directory } = options;
  const now = options.now ?? Date.now;
  const name = safeFileName(source.suggestedFilename());
  const fail = (reason: DownloadFailure['reason']): CaptureResult => ({
    ok: false,
    failure: { name, reason, at: new Date(now()).toISOString() },
  });
  const id = randomUUID();
  const path = join(directory, id);
  try {
    if (options.limitReached) {
      await source.cancel().catch(() => undefined);
      return fail('limit');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let bytes = 0;
    let oversized = false;
    const stream = await source.createReadStream();
    try {
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > MAX_DOWNLOAD_BYTES) {
              oversized = true;
              done(new Error('too large'));
            } else {
              done(null, chunk);
            }
          },
        }),
        createWriteStream(path, { mode: 0o600, flags: 'wx' }),
      );
    } catch {
      await rm(path, { force: true });
      if (oversized) {
        await source.cancel().catch(() => undefined);
        return fail('too_large');
      }
      return fail('interrupted');
    }
    const handle = await open(path, 'r');
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    await handle.close();
    const mimeType = sniffType(head.subarray(0, bytesRead));
    if (!mimeType) {
      await rm(path, { force: true });
      return fail('unsupported_type');
    }
    return { ok: true, download: { id, name, size: bytes, mimeType, path } };
  } finally {
    await source.delete().catch(() => undefined);
  }
}
