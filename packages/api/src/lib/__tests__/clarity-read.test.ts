/**
 * Reading a page through Clarity when Clarity has to index it first.
 *
 * Production failed 3 of 3 `webScraper` calls with "Clarity is still indexing
 * this page": the operation is asynchronous and the tool gave up on the first
 * answer instead of waiting for it. These pin the waiting, its bound, and that
 * the turn's cancellation ends it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const clarity = vi.hoisted(() => ({
  resolve: vi.fn(),
  operationsGet: vi.fn(),
  byUrl: vi.fn(),
}));

vi.mock('../clarity-client.js', () => ({
  clarityClient: () => ({
    indexing: { resolve: clarity.resolve },
    operations: { get: clarity.operationsGet },
    documents: { byUrl: clarity.byUrl },
  }),
}));

const { describeClarityFailure, readClarityDocument } = await import('../clarity-read.js');

const URL_ = 'https://example.com/post';
const doc = { id: 'd1', title: 'T', canonicalUrl: URL_, content: 'hello' };
const queued = { data: [{ url: URL_, status: 'queued', operationId: 'op-1' }] };

/** A clock-free sleep that records the delays it was asked for. */
function recorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readClarityDocument', () => {
  it('returns the document at once when Clarity already has it', async () => {
    clarity.resolve.mockResolvedValue({ data: [{ url: URL_, status: 'indexed', document: doc }] });
    const result = await readClarityDocument(URL_);
    expect(result).toEqual({ ok: true, document: doc });
    expect(clarity.operationsGet).not.toHaveBeenCalled();
  });

  it('waits for a queued operation to finish, then reads the document', async () => {
    clarity.resolve.mockResolvedValue(queued);
    clarity.operationsGet
      .mockResolvedValueOnce({ id: 'op-1', status: 'queued' })
      .mockResolvedValueOnce({ id: 'op-1', status: 'running' })
      .mockResolvedValueOnce({ id: 'op-1', status: 'succeeded' });
    clarity.byUrl.mockResolvedValue(doc);
    const { delays, sleep } = recorder();

    const result = await readClarityDocument(URL_, { sleep });

    expect(result).toEqual({ ok: true, document: doc });
    expect(clarity.operationsGet).toHaveBeenCalledTimes(3);
    expect(clarity.operationsGet).toHaveBeenCalledWith(
      'op-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Backoff: it does not hammer the operation endpoint.
    expect(delays).toEqual([500, 1000]);
  });

  it('caps the backoff', async () => {
    clarity.resolve.mockResolvedValue(queued);
    for (let i = 0; i < 6; i += 1) {
      clarity.operationsGet.mockResolvedValueOnce({ id: 'op-1', status: 'running' });
    }
    clarity.operationsGet.mockResolvedValueOnce({ id: 'op-1', status: 'partial' });
    clarity.byUrl.mockResolvedValue(doc);
    const { delays, sleep } = recorder();

    await readClarityDocument(URL_, { sleep });

    expect(delays).toEqual([500, 1000, 2000, 4000, 4000, 4000]);
  });

  it('reports an operation that ended without a document as a typed failure', async () => {
    clarity.resolve.mockResolvedValue(queued);
    clarity.operationsGet.mockResolvedValue({
      id: 'op-1',
      status: 'failed',
      error: { code: 'blocked_by_robots' },
    });
    clarity.byUrl.mockRejectedValue(new Error('404'));

    const result = await readClarityDocument(URL_, { sleep: recorder().sleep });

    expect(result).toEqual({
      ok: false,
      reason: 'operation_failed',
      operationId: 'op-1',
      detail: 'blocked_by_robots',
    });
  });

  it('gives a typed timeout, not an indefinite wait, when the operation never finishes', async () => {
    clarity.resolve.mockResolvedValue(queued);
    clarity.operationsGet.mockResolvedValue({ id: 'op-1', status: 'running' });

    // The real clock, a tiny deadline: the bound is the deadline signal.
    const result = await readClarityDocument(URL_, { deadlineMs: 60 });

    expect(result).toMatchObject({ ok: false, reason: 'timeout', operationId: 'op-1' });
    const failure = result as Extract<typeof result, { ok: false }>;
    expect(describeClarityFailure(failure, URL_)).toContain('operation op-1');
  });

  it('retries a throttled page until capacity frees', async () => {
    clarity.resolve
      .mockResolvedValueOnce({ data: [{ url: URL_, status: 'throttled' }] })
      .mockResolvedValueOnce({ data: [{ url: URL_, status: 'indexed', document: doc }] });
    const { delays, sleep } = recorder();

    const result = await readClarityDocument(URL_, { sleep });

    expect(result).toEqual({ ok: true, document: doc });
    expect(delays).toEqual([500]);
  });

  it('says so when Clarity has nothing for the URL and no operation', async () => {
    clarity.resolve.mockResolvedValue({ data: [{ url: URL_, status: 'blocked' }] });
    const result = await readClarityDocument(URL_);
    expect(result).toMatchObject({ ok: false, reason: 'unreadable', detail: 'blocked' });
  });

  it('stops polling and rejects when the turn is cancelled', async () => {
    clarity.resolve.mockResolvedValue(queued);
    clarity.operationsGet.mockResolvedValue({ id: 'op-1', status: 'running' });
    const turn = new AbortController();
    const reason = new Error('turn cancelled');

    const pending = readClarityDocument(URL_, {
      signal: turn.signal,
      sleep: async () => {
        turn.abort(reason);
        throw reason;
      },
    });

    await expect(pending).rejects.toBe(reason);
    expect(clarity.operationsGet).toHaveBeenCalledTimes(1);
  });

  it('does not start when the turn is already cancelled', async () => {
    const turn = new AbortController();
    turn.abort(new Error('gone'));
    clarity.resolve.mockImplementation(async (_req: unknown, options: { signal: AbortSignal }) => {
      if (options.signal.aborted) throw options.signal.reason;
      return queued;
    });

    await expect(readClarityDocument(URL_, { signal: turn.signal })).rejects.toThrow('gone');
  });
});
