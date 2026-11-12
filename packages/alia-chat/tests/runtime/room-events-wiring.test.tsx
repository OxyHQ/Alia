import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The room's socket (`host.subscribeRoomEvents`) and the chat request (SSE) both draw a group's
 * members: over a mocked transport and a fake socket, the thread shows each member once, a member
 * still speaking when the request ends (`room_continues`) goes on over the socket, and the
 * subscription follows the open conversation.
 */

type Reply = { status: number; frames: string[] };
const harness = vi.hoisted(() => ({ replies: [] as Reply[] }));

vi.mock('@oxy.so/services/ui/client', async () => ({
  ...(await import('../support/app-assertion-host')).hostWithoutAppAssertion,
  useOxy: () => ({
    user: { id: 'u1' },
    oxyServices: {
      createLinkedClient: () => ({
        client: {
          getSessionEpoch: () => 0,
          addTokenChangeListener: () => () => {},
          requestAuthenticatedResponse: async () => {
            const reply = harness.replies.shift() ?? { status: 200, frames: [] };
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const frame of reply.frames) controller.enqueue(encoder.encode(frame));
                controller.close();
              },
            });
            return { ok: reply.status < 400, status: reply.status, statusText: '', body };
          },
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import type { RoomEvent } from '../../src/runtime/room-events';
import { createRoomLedger } from '../../src/runtime/room-events';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';
import { ROOM_SILENCE_MS, useRoomEvents } from '../../src/runtime/use-room-events';
import { useMemo } from 'react';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NADIA = { id: 'nadia', name: 'Nadia', handle: 'nadia' };
let listeners: { conversationId: string; listener: (event: RoomEvent) => void }[] = [];
let unsubscribed = 0;
const subscribeRoomEvents = vi.fn((conversationId: string, listener: (e: RoomEvent) => void) => {
  const entry = { conversationId, listener };
  listeners.push(entry);
  return () => {
    unsubscribed += 1;
    listeners = listeners.filter((l) => l !== entry);
  };
});
const host: AliaRuntimeHost = { subscribeRoomEvents };
const onRoomFailure = vi.fn();

let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;

function Probe({ conversationId }: { conversationId: string }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new conversation is a new ledger
  const room = useMemo(() => createRoomLedger(), [conversationId]);
  api = useConversationStream({ conversationId, room });
  useRoomEvents(conversationId, room, api.setMessages, onRoomFailure);
  return null;
}

const tree = (conversationId: string) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AliaRuntimeProvider apiUrl="http://api.test" host={host}>
      <Probe conversationId={conversationId} />
    </AliaRuntimeProvider>
  </QueryClientProvider>
);
const mount = async (conversationId = 'c1') => {
  await act(async () => {
    renderer = create(tree(conversationId));
  });
};
/** What the server pushes to every socket of the person. */
const push = (event: string, data: Record<string, unknown>, conversationId = 'c1') =>
  act(async () => {
    for (const l of [...listeners]) {
      l.listener({ conversationId, chainId: 'p1', event, data });
    }
  });

const frame = (payload: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
const sse = (event: string, payload: Record<string, unknown>) =>
  frame({ eventVersion: 1, consultId: 'k1', ...payload }, `alia.${event}`);
const members = () => api.messages.filter((m) => m.agentInfo !== undefined);

beforeEach(() => {
  listeners = [];
  unsubscribed = 0;
  subscribeRoomEvents.mockClear();
  harness.replies.length = 0;
  onRoomFailure.mockClear();
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('the open group conversation', () => {
  it('subscribes for its conversation and lets go on unmount', async () => {
    await mount('c1');
    expect(subscribeRoomEvents).toHaveBeenCalledWith('c1', expect.any(Function));
    await act(async () => renderer?.unmount());
    renderer = null;
    expect(unsubscribed).toBe(1);
    expect(listeners).toEqual([]);
  });

  it('follows the open conversation: events of the previous one are ignored', async () => {
    await mount('c1');
    await act(async () => renderer?.update(tree('c2')));
    expect(unsubscribed).toBe(1);
    await push('alia.agent_start', { consultId: 'k9', agent: NADIA }, 'c1');
    expect(members()).toHaveLength(0);
    await push('alia.agent_start', { consultId: 'k9', agent: NADIA }, 'c2');
    expect(members()).toHaveLength(1);
  });

  it('draws a member who speaks after the request, from typing to the stored reply', async () => {
    await mount();
    await push('alia.agent_start', { consultId: 'k1', agent: NADIA });
    expect(members()[0]).toMatchObject({ isStreaming: true, content: '' });
    await push('alia.agent_delta', { consultId: 'k1', content: 'Hola' });
    await push('alia.agent_end', {
      consultId: 'k1',
      status: 'completed',
      content: 'Hola',
      messageId: 'group-reply-p1-0',
    });
    await push('group.message', {
      message: { id: 'group-reply-p1-0', role: 'assistant', agentInfo: NADIA, content: 'Hola' },
    });
    await push('group.idle', { reason: 'done' });
    expect(members().map((m) => [m.id, m.content, m.isStreaming])).toEqual([
      ['group-reply-p1-0', 'Hola', false],
    ]);
  });

  it('draws a member once when the request and the socket both carry it, and keeps it going after room_continues', async () => {
    harness.replies.push({
      status: 200,
      frames: [
        frame({ eventVersion: 1, conversationId: 'c1', agentIds: ['nadia'] }, 'alia.group_turn'),
        sse('agent_start', { agent: NADIA }),
        sse('agent_delta', { content: 'Hola ' }),
        sse('agent_end', { status: 'failed', error: { code: 'room_continues' } }),
        'data: [DONE]\n\n',
      ],
    });
    await mount();
    // The socket sees the member before the request does.
    await push('alia.agent_start', { consultId: 'k1', agent: NADIA });
    await act(async () => {
      await api.append({ role: 'user', content: 'hi' });
    });
    expect(members()).toHaveLength(1);
    expect(api.messages).toHaveLength(2);
    expect(api.error).toBeNull();
    expect(members()[0]).toMatchObject({ content: 'Hola ', isStreaming: true });
    expect(members()[0]?.turnOutcome).toBeUndefined();

    await push('alia.agent_delta', { consultId: 'k1', content: 'mundo' });
    expect(members()[0]?.content).toBe('Hola mundo');
    await push('alia.agent_end', {
      consultId: 'k1',
      status: 'completed',
      content: 'Hola mundo',
      messageId: 'group-reply-p1-0',
    });
    expect(members().map((m) => [m.id, m.content, m.isStreaming])).toEqual([
      ['group-reply-p1-0', 'Hola mundo', false],
    ]);
  });

  it.each(['sse', 'socket-first', 'socket-completed-first'] as const)(
    'converges a failed attempt and stored completion replay across transports (%s)',
    async (ownership) => {
      const id = 'group-reply-p1-1';
      const completion = {
        consultId: id,
        status: 'completed',
        content: 'Stored answer',
        messageId: id,
      };
      harness.replies.push({
        status: 200,
        frames: [
          frame({ eventVersion: 1, conversationId: 'c1', agentIds: ['nadia'] }, 'alia.group_turn'),
          sse('agent_start', { consultId: id, agent: NADIA }),
          sse('agent_delta', { consultId: id, content: 'Partial' }),
          sse('agent_end', { consultId: id, status: 'failed', error: { code: 'store_failed' } }),
          sse('agent_start', { consultId: id, agent: NADIA }),
          sse('agent_end', completion),
          sse('agent_end', completion),
          sse('agent_delta', { consultId: id, content: 'late duplicate' }),
          'data: [DONE]\n\n',
        ],
      });
      await mount();
      if (ownership !== 'sse') {
        await push('alia.agent_start', { consultId: id, agent: NADIA });
        await push('alia.agent_delta', { consultId: id, content: 'Socket partial' });
        await push('alia.agent_end', {
          consultId: id,
          status: 'failed',
          error: { code: 'store_failed' },
        });
        if (ownership === 'socket-completed-first') await push('alia.agent_end', completion);
      }
      await act(async () => {
        await api.append({ role: 'user', content: 'hi' });
      });
      expect(members()).toHaveLength(1);
      expect(members()[0]).toMatchObject({
        id,
        content: 'Stored answer',
        turnOutcome: 'completed',
        isStreaming: false,
      });
      await push('alia.agent_end', completion);
      await push('group.message', {
        message: { id, role: 'assistant', agentInfo: NADIA, content: 'Stored answer' },
      });
      expect(api.messages).toHaveLength(2);
      expect(members()[0]).toMatchObject({
        id,
        content: 'Stored answer',
        turnOutcome: 'completed',
      });
      expect(members()[0]?.unsaved).toBeUndefined();
      expect(api.failedTurn).toBeNull();
      expect(api.error).toBeNull();
    },
  );

  it('repairs the failed provisional row when stored socket replay arrives after HTTP failed', async () => {
    const id = 'group-reply-p1-1';
    harness.replies.push({
      status: 200,
      frames: [
        frame({ eventVersion: 1, conversationId: 'c1', agentIds: ['nadia'] }, 'alia.group_turn'),
        sse('agent_start', { consultId: id, agent: NADIA }),
        sse('agent_delta', { consultId: id, content: 'Partial' }),
        sse('agent_end', { consultId: id, status: 'failed', error: { code: 'store_failed' } }),
        frame({ error: { code: 'provider_unavailable', message: 'Room failed', retryable: true } }),
      ],
    });
    await mount();
    await act(async () => {
      await api.append({ role: 'user', content: 'hi' });
    });
    expect(members()[0]?.turnOutcome).toBe('failed');
    expect(api.failedTurn).not.toBeNull();
    await push('alia.agent_start', { consultId: id, agent: NADIA });
    // The stored event alone must recover the row if the completed frame was lost.
    await push('group.message', {
      message: { id, role: 'assistant', agentInfo: NADIA, content: 'Stored answer' },
    });
    await push('alia.agent_end', {
      consultId: id,
      status: 'completed',
      content: 'Stored answer',
      messageId: id,
    });
    expect(api.messages).toHaveLength(2);
    expect(members()[0]).toMatchObject({
      id,
      content: 'Stored answer',
      turnOutcome: 'completed',
      isStreaming: false,
    });
    // A stored reply cannot disprove a separate selector failure in the same request.
    expect(api.failedTurn?.anchorMessageId).toBe(api.messages.find((m) => m.role === 'user')?.id);
  });

  it('drops a superseded provisional reply across SSE and socket without a phantom saved message', async () => {
    harness.replies.push({
      status: 200,
      frames: [
        frame({ eventVersion: 1, conversationId: 'c1', agentIds: ['nadia'] }, 'alia.group_turn'),
        sse('agent_start', { agent: NADIA }),
        sse('agent_delta', { content: 'Old answer' }),
        sse('agent_end', { status: 'failed', error: { code: 'agent_declined' } }),
        'data: [DONE]\n\n',
      ],
    });
    await mount();
    await push('alia.agent_start', { consultId: 'k1', agent: NADIA });
    await act(async () => {
      await api.append({ role: 'user', content: 'hi' });
    });
    expect(api.messages).toHaveLength(1);
    expect(api.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    await push('alia.agent_end', { consultId: 'k1', status: 'declined' });
    await push('alia.agent_delta', { consultId: 'k1', content: 'late fragment' });
    await push('group.idle', { reason: 'superseded' });
    expect(api.messages).toHaveLength(1);
    expect(api.failedTurn).toBeNull();
    expect(api.error).toBeNull();
    expect(onRoomFailure).not.toHaveBeenCalled();
  });

  it.each(['error', 'rate_limited', 'turn_cap', 'reply_cap'])(
    'reports a late %s without needing an active member, once per chain',
    async (reason) => {
      await mount();
      await push('group.idle', { reason });
      await push('group.idle', { reason });
      expect(onRoomFailure).toHaveBeenCalledTimes(1);
      expect(onRoomFailure).toHaveBeenCalledWith({ chainId: 'p1', reason });
      expect(api.messages).toEqual([]);
    },
  );

  it('does not report deliberate silence, supersession, missing events or another room as failures', async () => {
    await mount();
    for (const reason of ['done', 'superseded', 'silent']) await push('group.idle', { reason });
    await push('group.idle', { reason: 'error' }, 'other');
    expect(onRoomFailure).not.toHaveBeenCalled();
  });

  describe('a room that goes quiet while a member shows as typing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('stops waiting once the room has been silent past the limit, as group.idle would have', async () => {
      await mount();
      await push('alia.agent_start', { consultId: 'k1', agent: NADIA });
      await push('alia.agent_delta', { consultId: 'k1', content: 'Hola' });
      expect(members()[0]).toMatchObject({ isStreaming: true, content: 'Hola' });

      await act(async () => {
        vi.advanceTimersByTime(ROOM_SILENCE_MS + 20_000);
      });

      expect(members()[0]).toMatchObject({ isStreaming: false, content: 'Hola' });
    });

    it('drops a draft that never said anything instead of leaving an empty bubble', async () => {
      await mount();
      await push('alia.agent_start', { consultId: 'k1', agent: NADIA });
      await act(async () => {
        vi.advanceTimersByTime(ROOM_SILENCE_MS + 20_000);
      });
      expect(members()).toHaveLength(0);
    });

    it('waits while the member is still speaking: each event restarts the silence', async () => {
      await mount();
      await push('alia.agent_start', { consultId: 'k1', agent: NADIA });
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(ROOM_SILENCE_MS - 20_000);
        });
        await push('alia.agent_delta', { consultId: 'k1', content: '.' });
      }
      expect(members()[0]).toMatchObject({ isStreaming: true, content: '....' });
    });
  });
});
