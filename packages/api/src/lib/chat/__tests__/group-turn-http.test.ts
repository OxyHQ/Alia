import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app-surface.js', () => ({ appSurfaceOf: async () => null }));
vi.mock('../room/start.js', () => ({ prepareRoom: vi.fn() }));

const { GROUP_REQUEST_BUDGET_MS, serveGroupTurn } = await import('../group-turn-http.js');
const { createInMemoryRoomBus } = await import('../room/bus.js');
import type { RoomEvent } from '../room/bus.js';
import type { PreparedRoom } from '../room/start.js';

interface Frame {
  event: string | null;
  data: Record<string, unknown>;
}

/** What the response wrote, parsed back into SSE frames. */
function parse(chunks: string[]): Frame[] {
  return chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.startsWith('event:') || block.startsWith('data:'))
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null;
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(raw) as Record<string, unknown> };
    });
}

const e = (
  event: RoomEvent['event'],
  data: Record<string, unknown>,
  chainId = 'p1',
): RoomEvent => ({ userId: 'u1', conversationId: 'conv', chainId, event, data });

function setup(options: {
  firstRoundSize?: number;
  unreachable?: string[];
  /** Runs when the chain is started, with the bus: the room "answering". */
  onStart?: (publish: (event: RoomEvent) => Promise<void>) => Promise<void> | void;
  startedAt?: number;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const bus = createInMemoryRoomBus();
  const chunks: string[] = [];
  const res = {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    headersSent: true,
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
  const sse = { ensureHeaders: vi.fn(), done: vi.fn() };
  const abandoned = vi.fn(async () => undefined);
  const started = vi.fn();
  const prepareRoom = vi.fn(
    async (): Promise<PreparedRoom> => ({
      chainId: 'p1',
      ready: options.firstRoundSize !== 0,
      start: async () => {
        started();
        await options.onStart?.((event) => bus.publish(event));
      },
      abandon: abandoned,
    }),
  );
  const req = {
    body: options.body ?? {
      stream: true,
      messages: [{ role: 'user', content: 'hello all' }],
    },
    accessToken: 'token',
  } as unknown as Request;
  const run = () =>
    serveGroupTurn(
      {
        req,
        res,
        sse: sse as never,
        userId: 'u1',
        conversationId: 'conv',
        memberAgentIds: ['a', 'b'],
        requestId: 'req-1',
        startedAt: options.startedAt ?? Date.now(),
        signal: options.signal ?? new AbortController().signal,
      },
      { bus, prepareRoom },
    );
  return { run, chunks, res, sse, bus, prepareRoom, started, abandoned };
}

const member = (consultId: string, id: string) =>
  e('alia.agent_start', {
    consultId,
    agent: { id, name: id, handle: id, color: null, character: null },
    task: 'hello all',
  });

describe('serveGroupTurn as a subscriber of the room', () => {
  it('forwards the entire chain until idle as the existing SSE frames', async () => {
    const t = setup({
      onStart: async (publish) => {
        await publish(member('k1', 'a'));
        await publish(e('alia.agent_delta', { consultId: 'k1', content: 'Hel' }));
        await publish(
          e('alia.agent_end', {
            consultId: 'k1',
            status: 'completed',
            content: 'Hello',
            messageId: 'm1',
          }),
        );
        await publish(e('group.message', { message: { id: 'm1' } }));
        await publish(member('k2', 'b'));
        await publish(
          e('alia.agent_tool', {
            consultId: 'k2',
            phase: 'call',
            toolCallId: 't',
            name: 'x',
            input: {},
          }),
        );
        await publish(e('alia.agent_end', { consultId: 'k2', status: 'completed', content: 'Hi' }));
        await publish(e('group.idle', { reason: 'done' }));
        // after the room ends: events are ignored
        await publish(member('k3', 'a'));
        await publish(e('alia.agent_delta', { consultId: 'k3', content: 'late' }));
      },
    });
    const outcome = await t.run();

    expect(outcome).toEqual({ completed: 2, settled: true, status: 'completed' });
    const frames = parse(t.chunks);
    expect(frames.map((f) => f.event ?? 'data')).toEqual([
      'alia.group_turn',
      'alia.agent_start',
      'alia.agent_delta',
      'alia.agent_end',
      'alia.agent_start',
      'alia.agent_tool',
      'alia.agent_end',
      'data',
    ]);
    expect(frames[0]!.data).toMatchObject({
      eventVersion: 1,
      conversationId: 'conv',
      agentIds: ['a', 'b'],
    });
    expect(frames[1]!.data).toMatchObject({ eventVersion: 1, consultId: 'k1', task: 'hello all' });
    expect(frames[3]!.data).toMatchObject({ status: 'completed', content: 'Hello' });
    const last = frames.at(-1)!.data as { choices: Array<{ finish_reason: string }> };
    expect(last.choices[0]!.finish_reason).toBe('stop');
    expect(t.sse.done).toHaveBeenCalledTimes(1);
    // nothing of the room after the round reached this response
    expect(t.chunks.join('')).not.toContain('late');
  });

  it('subscribes before the first step is queued, so no early event is lost', async () => {
    const t = setup({
      firstRoundSize: 1,
      onStart: async (publish) => {
        await publish(member('k1', 'a'));
        await publish(e('alia.agent_end', { consultId: 'k1', status: 'completed', content: 'x' }));
        await publish(e('group.idle', { reason: 'done' }));
      },
    });
    expect(await t.run()).toEqual({ completed: 1, settled: true, status: 'completed' });
    expect(t.started).toHaveBeenCalledTimes(1);
  });

  it('ignores the events of other chains of the room', async () => {
    const t = setup({
      firstRoundSize: 1,
      onStart: async (publish) => {
        await publish(e('alia.agent_delta', { consultId: 'zz', content: 'old chain' }, 'p0'));
        await publish(e('alia.agent_end', { consultId: 'zz', status: 'completed' }, 'p0'));
        await publish(member('k1', 'a'));
        await publish(e('alia.agent_end', { consultId: 'k1', status: 'completed', content: 'x' }));
        await publish(e('group.idle', { reason: 'done' }));
      },
    });
    expect(await t.run()).toEqual({ completed: 1, settled: true, status: 'completed' });
    expect(t.chunks.join('')).not.toContain('old chain');
  });

  it('a member that declines is invisible to the request', async () => {
    const t = setup({
      firstRoundSize: 2,
      onStart: async (publish) => {
        await publish(member('k1', 'a'));
        await publish(e('alia.agent_end', { consultId: 'k1', status: 'declined' }));
        await publish(member('k2', 'b'));
        await publish(e('alia.agent_end', { consultId: 'k2', status: 'completed', content: 'me' }));
        await publish(e('group.idle', { reason: 'done' }));
      },
    });
    expect(await t.run()).toEqual({ completed: 1, settled: true, status: 'completed' });
    const frames = parse(t.chunks);
    expect(frames.filter((f) => f.event === 'alia.agent_start')).toHaveLength(1);
    expect(frames.some((f) => f.data.status === 'declined')).toBe(false);
  });

  it('a failed member still shows start then failed end, and every member failing is a typed failure', async () => {
    const t = setup({
      firstRoundSize: 2,
      onStart: async (publish) => {
        await publish(member('k1', 'a'));
        await publish(
          e('alia.agent_end', {
            consultId: 'k1',
            status: 'failed',
            error: { code: 'agent_unavailable' },
          }),
        );
        await publish(member('k2', 'b'));
        await publish(
          e('alia.agent_end', {
            consultId: 'k2',
            status: 'failed',
            error: { code: 'agent_timeout' },
          }),
        );
        await publish(e('group.idle', { reason: 'error' }));
      },
    });
    const outcome = await t.run();
    expect(outcome).toEqual({ completed: 0, settled: true, status: 'failed' });
    expect(parse(t.chunks).map((f) => f.event ?? 'data')).toEqual([
      'alia.group_turn',
      'alia.agent_start',
      'alia.agent_end',
      'alia.agent_start',
      'alia.agent_end',
    ]);
    // the caller ends the stream with the typed error: no finish chunk, no [DONE] from here
    expect(t.sse.done).not.toHaveBeenCalled();
  });

  it('ends cleanly when the request limit nears, closing the open member and leaving the room running', async () => {
    const t = setup({
      firstRoundSize: 2,
      startedAt: Date.now() - GROUP_REQUEST_BUDGET_MS + 30,
      onStart: async (publish) => {
        await publish(member('k1', 'a'));
        await publish(e('alia.agent_delta', { consultId: 'k1', content: 'Thinking' }));
      },
    });
    const outcome = await t.run();
    expect(outcome).toEqual({ completed: 0, settled: false, status: 'continuing' });
    const frames = parse(t.chunks);
    expect(frames.at(-2)).toMatchObject({
      event: 'alia.agent_end',
      data: { consultId: 'k1', status: 'failed', error: { code: 'room_continues' } },
    });
    expect(t.sse.done).toHaveBeenCalledTimes(1);
  });

  it('stops watching when the client goes away, without ending the room', async () => {
    const controller = new AbortController();
    const t = setup({
      firstRoundSize: 2,
      signal: controller.signal,
      onStart: async (publish) => {
        await publish(member('k1', 'a'));
        await publish(e('alia.agent_delta', { consultId: 'k1', content: 'hi' }));
        controller.abort();
      },
    });
    const outcome = await t.run();
    expect(outcome?.settled).toBe(false);
    expect(t.abandoned).not.toHaveBeenCalled();
  });

  it('fails the request without ghost member cards when no member is available', async () => {
    const t = setup({ firstRoundSize: 0, unreachable: ['a', 'b'] });
    const outcome = await t.run();
    expect(outcome).toEqual({ completed: 0, settled: true, status: 'failed' });
    expect(t.started).not.toHaveBeenCalled();
    const ends = parse(t.chunks).filter((f) => f.event === 'alia.agent_end');
    expect(ends).toHaveLength(0);
    expect(t.sse.done).not.toHaveBeenCalled();
  });

  it('a chain that ends (superseded, capped) settles the request', async () => {
    const t = setup({
      firstRoundSize: 3,
      onStart: async (publish) => {
        await publish(e('group.idle', { reason: 'superseded' }));
      },
    });
    expect((await t.run())?.settled).toBe(true);
  });

  it('gives the minted authority back when the first step cannot be queued', async () => {
    const t = setup({
      onStart: async () => {
        throw new Error('queue down');
      },
    });
    await expect(t.run()).rejects.toThrow('queue down');
    expect(t.abandoned).toHaveBeenCalledTimes(1);
  });

  it('refuses a request that is not a stream or does not end in the person’s message', async () => {
    const noStream = setup({ body: { messages: [{ role: 'user', content: 'x' }] } });
    expect(await noStream.run()).toBeNull();
    expect(noStream.res.status).toHaveBeenCalledWith(400);
    expect(noStream.prepareRoom).not.toHaveBeenCalled();

    const lastIsAssistant = setup({
      body: { stream: true, messages: [{ role: 'assistant', content: 'x' }] },
    });
    expect(await lastIsAssistant.run()).toBeNull();
    expect(lastIsAssistant.prepareRoom).not.toHaveBeenCalled();
  });
});

describe('group completion is not the same as producing text', () => {
  it('deliberate silence closes normally without activating a member', async () => {
    const t = setup({
      onStart: async (publish) => {
        await publish(e('group.idle', { reason: 'done' }));
      },
    });
    expect(await t.run()).toEqual({ completed: 0, settled: true, status: 'quiet' });
    expect(t.sse.done).toHaveBeenCalledOnce();
    expect(parse(t.chunks).map((f) => f.event ?? 'data')).toEqual(['alia.group_turn', 'data']);
  });

  it('a selector error is a failure even after a member answered', async () => {
    const t = setup({
      onStart: async (publish) => {
        await publish(member('k1', 'a'));
        await publish(
          e('alia.agent_end', { consultId: 'k1', status: 'completed', content: 'some result' }),
        );
        await publish(e('group.idle', { reason: 'error' }));
      },
    });
    expect(await t.run()).toEqual({ completed: 1, settled: true, status: 'failed' });
    expect(t.sse.done).not.toHaveBeenCalled();
    expect(t.chunks.join('')).not.toContain('finish_reason');
  });

  it('does not finish after a fixed number of speakers while selection continues', async () => {
    const t = setup({
      firstRoundSize: 1,
      onStart: async (publish) => {
        for (const id of ['a', 'b', 'c']) {
          await publish(member(id, id));
          await publish(e('alia.agent_end', { consultId: id, status: 'completed', content: id }));
        }
        await publish(e('group.idle', { reason: 'done' }));
      },
    });
    expect(await t.run()).toEqual({ completed: 3, settled: true, status: 'completed' });
  });
});

describe('group subscriber failure boundaries', () => {
  it('a pre-aborted request revokes prepared tasks and never starts a chain', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Stopped'));
    const t = setup({ signal: controller.signal });
    await expect(t.run()).rejects.toThrow('Stopped');
    expect(t.started).not.toHaveBeenCalled();
    expect(t.abandoned).toHaveBeenCalledOnce();
    expect(t.sse.done).not.toHaveBeenCalled();
  });

  it('a failed member remains failed when the idle event is missing at the deadline', async () => {
    const t = setup({
      startedAt: Date.now() - GROUP_REQUEST_BUDGET_MS + 10,
      onStart: async (publish) => {
        await publish(member('a', 'a'));
        await publish(
          e('alia.agent_end', {
            consultId: 'a',
            status: 'failed',
            error: { code: 'agent_unavailable' },
          }),
        );
      },
    });
    expect((await t.run())?.status).toBe('failed');
    expect(t.sse.done).not.toHaveBeenCalled();
  });

  it('an abandoned active member is failed, not marked as continuing', async () => {
    const t = setup({
      onStart: async (publish) => {
        await publish(member('a', 'a'));
        await publish(e('alia.agent_delta', { consultId: 'a', content: 'partial' }));
        await publish(e('group.idle', { reason: 'error' }));
      },
    });
    expect((await t.run())?.status).toBe('failed');
    expect(parse(t.chunks).at(-1)?.data).toMatchObject({
      status: 'failed',
      error: { code: 'room_failed' },
    });
  });
});

it('uses the existing SSE declined representation when an open member is superseded', async () => {
  const t = setup({
    onStart: async (publish) => {
      await publish(member('a', 'a'));
      await publish(e('alia.agent_delta', { consultId: 'a', content: 'obsolete' }));
      await publish(e('group.idle', { reason: 'superseded' }));
    },
  });
  expect((await t.run())?.status).toBe('quiet');
  expect(parse(t.chunks).find((frame) => frame.event === 'alia.agent_end')?.data).toMatchObject({
    status: 'failed',
    error: { code: 'agent_declined' },
  });
});

it('a recovered consultation replaces its storage failure and duplicate replay counts once', async () => {
  const t = setup({
    onStart: async (publish) => {
      await publish(member('stable-consult', 'a'));
      await publish(e('alia.agent_delta', { consultId: 'stable-consult', content: 'answer' }));
      await publish(
        e('alia.agent_end', {
          consultId: 'stable-consult',
          status: 'failed',
          error: { code: 'store_failed' },
        }),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await publish(member('stable-consult', 'a'));
        await publish(
          e('alia.agent_end', {
            consultId: 'stable-consult',
            status: 'completed',
            content: 'answer',
            messageId: 'stored',
          }),
        );
      }
      await publish(e('group.idle', { reason: 'done' }));
    },
  });
  expect(await t.run()).toEqual({ completed: 1, settled: true, status: 'completed' });
});
