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
import { useRoomEvents } from '../../src/runtime/use-room-events';
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

let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;

function Probe({ conversationId }: { conversationId: string }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new conversation is a new ledger
  const room = useMemo(() => createRoomLedger(), [conversationId]);
  api = useConversationStream({ conversationId, room });
  useRoomEvents(conversationId, room, api.setMessages);
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
});
