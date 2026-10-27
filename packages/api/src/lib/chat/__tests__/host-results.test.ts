import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Awaited host tools (`docs/agent-embedding.md` §2): the answer route and the batched wait.
 *
 * The store is an in-memory stand-in with the repository's contract (the real statements run in
 * `hostResults.pgdb.test.ts`). Two waiters over one store are two replicas: the answer reaches the
 * one whose turn waits, whichever received it.
 */

type Key = { turnId: string; toolCallId: string; authorityKey: string };
type Answer = { outcome: string; detail?: string; result?: unknown };
type Row = Key & { state: 'pending' | 'answered'; answer?: Answer };

const store = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const id = (key: { turnId: string; toolCallId: string }) => `${key.turnId}|${key.toolCallId}`;
  return { rows, id, takes: 0, failNextTake: false };
});

vi.mock('../../../db/chat/hostResultRepository', () => {
  class HostResultError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  const repository = {
    async open(key: Key) {
      if (!store.rows.has(store.id(key)))
        store.rows.set(store.id(key), { ...key, state: 'pending' });
    },
    async answer(key: Key, answer: Answer) {
      const row = store.rows.get(store.id(key));
      if (!row || row.authorityKey !== key.authorityKey)
        throw new HostResultError('host_result_not_found');
      if (row.state === 'answered') throw new HostResultError('host_result_already_answered');
      row.state = 'answered';
      row.answer = answer;
    },
    async take(keys: Key[]) {
      store.takes += 1;
      if (store.failNextTake) {
        store.failNextTake = false;
        throw new Error('db down');
      }
      return keys.flatMap((key) => {
        const row = store.rows.get(store.id(key));
        if (row?.state !== 'answered') return [];
        store.rows.delete(store.id(key));
        return [{ turnId: key.turnId, toolCallId: key.toolCallId, answer: row.answer }];
      });
    },
    async close(key: Key) {
      const row = store.rows.get(store.id(key));
      store.rows.delete(store.id(key));
      return row?.state === 'answered' ? (row.answer ?? null) : null;
    },
  };
  return { HostResultError, hostResultRepository: () => repository };
});
vi.mock('../../../db', () => ({ getDb: () => ({}) }));
const limiter = vi.hoisted(() => ({ allowed: true }));
vi.mock('../../sliding-window-limiter', () => ({
  checkWindowLimit: vi.fn(async () => ({ allowed: limiter.allowed, resetInSeconds: 30 })),
}));
vi.mock('../turn-control', async () => {
  const actual = await vi.importActual<typeof import('../turn-control')>('../turn-control');
  return {
    ...actual,
    turnIdentity: async (req: { headers: Record<string, string> }, id: unknown) => {
      if (typeof id !== 'string' || id.length !== 36)
        throw new TypeError('turnId must be a UUID v4');
      return { id, conversationId: null, authorityKey: req.headers['x-authority'] ?? 'person-a' };
    },
  };
});
vi.mock('../../logger', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});

const { HostResultWaiter, parseHostResultBody, submitHostResult } = await import('../host-results');
const { hostResultRepository } = await import('../../../db/chat/hostResultRepository');
const { HOST_RESULT_MAX_CHARS, HOST_RESULT_WAIT_MS } = await import(
  '../../../domain/chat-host-results'
);

const TURN = '6f1c2d3e-4b5a-4c6d-8e7f-001122334455';
const KEY = { turnId: TURN, toolCallId: 'call-1', authorityKey: 'person-a' };

async function post(body: unknown, options: { turnId?: string; authority?: string } = {}) {
  const captured: {
    status: number | null;
    body: { error?: Record<string, unknown> } & Record<string, unknown>;
  } = {
    status: null,
    body: {},
  };
  const res = {
    setHeader: vi.fn(),
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: typeof captured.body) {
      captured.body = payload;
      return res;
    },
  };
  await submitHostResult(
    {
      body,
      params: { turnId: options.turnId ?? TURN },
      headers: options.authority ? { 'x-authority': options.authority } : {},
    } as never,
    res as never,
  );
  return captured;
}

const repository = () => hostResultRepository({} as never);

beforeEach(() => {
  store.rows.clear();
  store.takes = 0;
  store.failNextTake = false;
  limiter.allowed = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('parseHostResultBody', () => {
  it('reads an outcome, its detail and a JSON or string result', () => {
    expect(parseHostResultBody({ toolCallId: 'c', outcome: 'applied' })).toEqual({
      toolCallId: 'c',
      answer: { outcome: 'applied' },
    });
    expect(
      parseHostResultBody({ toolCallId: 'c', outcome: 'inline', detail: 'ok', result: 'text' }),
    ).toEqual({ toolCallId: 'c', answer: { outcome: 'inline', detail: 'ok', result: 'text' } });
    expect(
      parseHostResultBody({ toolCallId: 'c', outcome: 'failed', result: null }).answer,
    ).toEqual({
      outcome: 'failed',
    });
  });

  it('refuses what is not the contract, naming the field', () => {
    const refusal = (body: unknown) => {
      try {
        parseHostResultBody(body);
      } catch (error) {
        return error as { code: string; param: string };
      }
      throw new Error('accepted');
    };
    expect(refusal({ toolCallId: 'c', outcome: 'done' })).toMatchObject({
      code: 'invalid_host_result',
      param: 'outcome',
    });
    expect(refusal({ outcome: 'applied' })).toMatchObject({ param: 'toolCallId' });
    expect(refusal({ toolCallId: 'c', outcome: 'applied', detail: 'x'.repeat(501) })).toMatchObject(
      { param: 'detail' },
    );
    expect(refusal({ toolCallId: 'c', outcome: 'applied', conversationId: 'x' })).toMatchObject({
      code: 'invalid_host_result',
    });
  });

  it('bounds the result by its JSON size', () => {
    const fits = 'x'.repeat(HOST_RESULT_MAX_CHARS - 2);
    expect(
      parseHostResultBody({ toolCallId: 'c', outcome: 'applied', result: fits }).answer.result,
    ).toBe(fits);
    expect(() =>
      parseHostResultBody({ toolCallId: 'c', outcome: 'applied', result: `${fits}x` }),
    ).toThrow(expect.objectContaining({ code: 'host_result_too_large', param: 'result' }));
  });
});

describe('POST /v1/chat/turns/:turnId/host-results', () => {
  it('records the answer to an action this turn awaits, once', async () => {
    await repository().open(KEY);
    const first = await post({ toolCallId: 'call-1', outcome: 'applied', result: { text: 'hi' } });
    expect(first).toEqual({
      status: 200,
      body: { turnId: TURN, toolCallId: 'call-1', state: 'answered' },
    });
    const second = await post({ toolCallId: 'call-1', outcome: 'applied' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'host_result_already_answered' });
  });

  it('is a 404 for an action never awaited, and for another authority', async () => {
    await repository().open(KEY);
    expect((await post({ toolCallId: 'call-2', outcome: 'applied' })).status).toBe(404);
    const foreign = await post({ toolCallId: 'call-1', outcome: 'applied' }, { authority: 'b' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toMatchObject({ code: 'host_result_not_found' });
    expect(store.rows.get(store.id(KEY))?.state).toBe('pending');
  });

  it('refuses a malformed turn, an oversized result and a caller over its limit', async () => {
    expect(
      (await post({ toolCallId: 'c', outcome: 'applied' }, { turnId: 'nope' })).body.error,
    ).toMatchObject({ code: 'invalid_turn' });
    const large = await post({
      toolCallId: 'c',
      outcome: 'applied',
      result: 'x'.repeat(HOST_RESULT_MAX_CHARS),
    });
    expect(large.status).toBe(400);
    expect(large.body.error).toMatchObject({ code: 'host_result_too_large', param: 'result' });
    limiter.allowed = false;
    expect((await post({ toolCallId: 'c', outcome: 'applied' })).status).toBe(429);
  });
});

describe('HostResultWaiter', () => {
  it('delivers an answer received on another replica, reading every wait in one batch', async () => {
    vi.useFakeTimers();
    const streaming = new HostResultWaiter(repository(), 250);
    const other = { ...KEY, toolCallId: 'call-2' };
    await streaming.open(KEY);
    await streaming.open(other);
    const first = streaming.wait(KEY, undefined);
    const second = streaming.wait(other, undefined);

    await vi.advanceTimersByTimeAsync(250);
    expect(store.takes).toBe(1);
    await post({ toolCallId: 'call-1', outcome: 'applied', result: { text: 'page' } });
    await vi.advanceTimersByTimeAsync(250);
    expect(store.takes).toBe(2);
    await expect(first).resolves.toEqual({ outcome: 'applied', result: { text: 'page' } });
    expect(store.rows.has(store.id(KEY))).toBe(false);

    await post({ toolCallId: 'call-2', outcome: 'rejected', detail: 'No tab' });
    await vi.advanceTimersByTimeAsync(250);
    await expect(second).resolves.toEqual({ outcome: 'rejected', detail: 'No tab' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.takes).toBe(3);
  });

  it('ends unanswered at the deadline, and the late answer finds nothing', async () => {
    vi.useFakeTimers();
    const waiter = new HostResultWaiter(repository(), 250);
    await waiter.open(KEY);
    const waiting = waiter.wait(KEY, undefined);
    await vi.advanceTimersByTimeAsync(HOST_RESULT_WAIT_MS);
    await expect(waiting).resolves.toBeNull();
    expect(store.rows.size).toBe(0);
    expect((await post({ toolCallId: 'call-1', outcome: 'applied' })).status).toBe(404);
  });

  it('keeps an answer that lands between the last read and the deadline', async () => {
    vi.useFakeTimers();
    const waiter = new HostResultWaiter(repository(), 60_000);
    await waiter.open(KEY);
    const waiting = waiter.wait(KEY, undefined, 1_000);
    await post({ toolCallId: 'call-1', outcome: 'applied', result: 'late' });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({ outcome: 'applied', result: 'late' });
  });

  it('ends at once when the turn is stopped', async () => {
    vi.useFakeTimers();
    const waiter = new HostResultWaiter(repository(), 250);
    const stop = new AbortController();
    await waiter.open(KEY);
    const waiting = waiter.wait(KEY, stop.signal);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expect(waiting).resolves.toBeNull();
    expect(store.rows.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.takes).toBe(0);

    await waiter.open(KEY);
    await expect(waiter.wait(KEY, stop.signal)).resolves.toBeNull();
  });

  it('never holds the tool on a wedged store', async () => {
    vi.useFakeTimers();
    const wedged = {
      ...repository(),
      close: () => new Promise<never>(() => undefined),
    } as ReturnType<typeof repository>;
    const waiter = new HostResultWaiter(wedged, 250);
    const waiting = waiter.wait(KEY, undefined, 1_000);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    await expect(waiting).resolves.toBeNull();
  });

  it('keeps waiting through a failed read', async () => {
    vi.useFakeTimers();
    const waiter = new HostResultWaiter(repository(), 250);
    await waiter.open(KEY);
    const waiting = waiter.wait(KEY, undefined);
    store.failNextTake = true;
    await vi.advanceTimersByTimeAsync(250);
    await post({ toolCallId: 'call-1', outcome: 'applied' });
    await vi.advanceTimersByTimeAsync(250);
    await expect(waiting).resolves.toEqual({ outcome: 'applied' });
  });
});
