/**
 * Read one public page through Clarity, waiting for it when Clarity has to
 * index it first.
 *
 * `indexing.resolve` answers within `waitMs`; a page Clarity has not seen yet
 * comes back as `queued` with an `operationId` and no document. Indexing is an
 * asynchronous operation, so "queued" is not a failure: the answer arrives when
 * the operation settles. This polls `operations.get` with a growing delay up to
 * a deadline, honours the caller's abort signal, and reads the document once
 * the operation has finished. Only an exhausted deadline, or an operation that
 * ended without a document, is an error, and it is a typed one.
 */

import type { Document, ResolveResult } from '@clarity.surf/sdk';

import { clarityClient } from './clarity-client.js';

/** How long a tool call may wait for Clarity to index a page. */
export const CLARITY_INDEX_DEADLINE_MS = 45_000;
const RESOLVE_WAIT_MS = 8_000;
const FIRST_POLL_MS = 500;
const MAX_POLL_MS = 4_000;

export type ClarityReadFailure =
  | 'timeout' // the operation was still running when the deadline passed
  | 'throttled' // Clarity had no crawl capacity for the whole deadline
  | 'operation_failed' // the operation ended without a document
  | 'unreadable'; // Clarity answered but has nothing for this URL

export type ClarityReadResult =
  | { ok: true; document: Document }
  | { ok: false; reason: ClarityReadFailure; operationId?: string; detail?: string };

export interface ClarityReadOptions {
  /** The turn's cancellation. An abort rejects with the signal's reason. */
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Test seam: sleeping is the only thing that is timed. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const SETTLED = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function readClarityDocument(
  url: string,
  options: ClarityReadOptions = {},
): Promise<ClarityReadResult> {
  const deadlineMs = options.deadlineMs ?? CLARITY_INDEX_DEADLINE_MS;
  const sleep = options.sleep ?? sleepFor;
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const clarity = clarityClient();

  // The caller's cancellation propagates; our own deadline becomes a result.
  const guard = async <T>(run: () => Promise<T>): Promise<T | 'deadline'> => {
    try {
      return await run();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (deadline.aborted) return 'deadline';
      throw error;
    }
  };

  let delayMs = FIRST_POLL_MS;
  let operationId: string | undefined;

  while (true) {
    const resolved = await guard(() =>
      clarity.indexing.resolve({ urls: [url], waitMs: RESOLVE_WAIT_MS }, { signal }),
    );
    if (resolved === 'deadline') {
      return { ok: false, reason: operationId ? 'timeout' : 'throttled', operationId };
    }
    const item: ResolveResult | undefined = resolved.data[0];
    if (item?.document) return { ok: true, document: item.document };
    operationId = item?.operationId ?? operationId;

    if (item?.status === 'indexed' || item?.status === 'extracted') {
      const document = await guard(() => clarity.documents.byUrl(url, { signal }));
      if (document === 'deadline') return { ok: false, reason: 'timeout', operationId };
      return { ok: true, document };
    }
    // `throttled` is newer than the published SDK's status union (0.4.0).
    if ((item?.status as string | undefined) === 'throttled') {
      // No operation exists yet: capacity frees, then resolve again.
      const slept = await guard(() => sleep(delayMs, signal));
      if (slept === 'deadline') return { ok: false, reason: 'throttled' };
      delayMs = Math.min(delayMs * 2, MAX_POLL_MS);
      continue;
    }
    if (item?.status !== 'queued' || !operationId) {
      return { ok: false, reason: 'unreadable', detail: item?.status };
    }
    break;
  }

  const id = operationId;
  while (true) {
    const operation = await guard(() => clarity.operations.get(id, { signal }));
    if (operation === 'deadline') return { ok: false, reason: 'timeout', operationId };
    if (SETTLED.has(operation.status)) {
      const document = await guard(() =>
        clarity.documents.byUrl(url, { signal }).catch((error: unknown) => {
          if (signal.aborted) throw error;
          return undefined;
        }),
      );
      if (document === 'deadline') return { ok: false, reason: 'timeout', operationId };
      if (document) return { ok: true, document };
      return {
        ok: false,
        reason: 'operation_failed',
        operationId,
        detail: operation.error?.code ?? operation.status,
      };
    }
    const slept = await guard(() => sleep(delayMs, signal));
    if (slept === 'deadline') return { ok: false, reason: 'timeout', operationId };
    delayMs = Math.min(delayMs * 2, MAX_POLL_MS);
  }
}

/** The sentence a model (and a person) reads when a page could not be read. */
export function describeClarityFailure(
  failure: Extract<ClarityReadResult, { ok: false }>,
  url: string,
): string {
  switch (failure.reason) {
    case 'timeout':
      return `Clarity did not finish indexing ${url} in time (operation ${failure.operationId}). Try again later or use another source.`;
    case 'throttled':
      return `Clarity has no crawl capacity free right now for ${url}. Try again later or use another source.`;
    case 'operation_failed':
      return `Clarity could not index ${url} (${failure.detail ?? 'operation failed'}). Use another source.`;
    default:
      return `Clarity could not fetch ${url}. Use another source.`;
  }
}
