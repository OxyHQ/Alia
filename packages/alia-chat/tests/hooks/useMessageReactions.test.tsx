import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({
  accountId: 'u1',
  requests: [] as {
    path: string;
    body: { emoji: string; active: boolean; mutationId: string };
    resolve: (result: unknown) => void;
    reject: (reason: unknown) => void;
  }[],
}));
const transport = vi.hoisted(() => ({
  post: (path: string, body: (typeof wire.requests)[number]['body']) =>
    new Promise((resolve, reject) => wire.requests.push({ path, body, resolve, reject })),
}));
vi.mock('../../src/runtime/api', () => ({ useAliaApi: () => transport }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ user: { id: wire.accountId } }) }));
vi.mock('../../src/lib/labels', () => ({ useLabels: () => ({ t: (key: string) => key }) }));
const errors = vi.hoisted(() => vi.fn());
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: errors } }));

import { useMessageReactions } from '../../src/hooks/useMessageReactions';
import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import {
  applyMessageReaction,
  type MessageReactionUpdate,
} from '../../src/runtime/message-reactions';
import { createRoomLedger, type RoomEvent } from '../../src/runtime/room-events';
import { useRoomEvents } from '../../src/runtime/use-room-events';
import { aliaQueryKeys } from '../../src/runtime/query-keys';
import type { Message } from '../../src/runtime/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const initial: Message = {
  id: 'm1',
  role: 'assistant',
  content: 'Hola',
  agentInfo: { id: 'salina', name: 'Salina' },
  reactions: [],
  reactionRevision: 0,
};
let reactionsListener: ((update: MessageReactionUpdate) => void) | undefined;
let roomListener: ((event: RoomEvent) => void) | undefined;
const release = vi.fn();
const roomFailure = vi.fn();
const host: AliaRuntimeHost = {
  subscribeConversationReactions: (_id, listener) => {
    reactionsListener = listener;
    return release;
  },
  subscribeRoomEvents: (_id, listener) => {
    roomListener = listener;
    return () => {};
  },
};
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
let current: { messages: Message[]; reaction: ReturnType<typeof useMessageReactions> };
function Probe({ conversationId }: { conversationId: string }) {
  const [messages, setMessages] = useState([initial]);
  const room = useMemo(() => createRoomLedger(), []);
  const reaction = useMessageReactions({
    conversationIds: [conversationId],
    onChange: (update) => setMessages((previous) => applyMessageReaction(previous, update)),
  });
  useRoomEvents(conversationId, room, setMessages, roomFailure);
  current = { messages, reaction };
  return null;
}
const tree = (conversationId: string) => (
  <QueryClientProvider client={client}>
    <AliaRuntimeProvider host={host}>
      <Probe conversationId={conversationId} />
    </AliaRuntimeProvider>
  </QueryClientProvider>
);
const mount = (conversationId = 'c1') =>
  act(async () => {
    renderer = create(tree(conversationId));
  });
const toggle = (conversationId = 'c1') =>
  act(async () => {
    const m = current.messages[0];
    if (!m) throw new Error('Missing target message');
    current.reaction.toggle(m.id, '❤️', m.reactions, conversationId, m.reactionRevision);
  });
const visible = (conversationId = 'c1') => {
  const m = current.messages[0];
  if (!m) throw new Error('Missing target message');
  return current.reaction.reactionsOf(m.id, m.reactions, conversationId, m.reactionRevision);
};
const acknowledge = (revision = 1, reactions = ['❤️']) =>
  act(async () => {
    const request = wire.requests.at(-1);
    if (!request) throw new Error('Missing request');
    request.resolve({
      data: { messageId: 'm1', reactions, revision, mutationId: request.body.mutationId },
    });
  });
const room = (conversationId: string, event: string, data: Record<string, unknown>) =>
  act(async () => roomListener?.({ conversationId, chainId: 'reaction-event-1', event, data }));
beforeEach(() => {
  wire.requests = [];
  wire.accountId = 'u1';
  errors.mockClear();
  release.mockClear();
  roomFailure.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  client.clear();
});

describe('saved message reactions', () => {
  it('persists explicit intent, updates live/query/history state and accepts newer cross-device state', async () => {
    client.setQueryData(aliaQueryKeys.conversations.detail('c1'), {
      id: 'c1',
      messages: [initial],
    });
    client.setQueryData(aliaQueryKeys.threads.messages('salina'), {
      pages: [
        {
          messages: [
            { ...initial, conversationId: 'c1', cursor: 'cursor' },
            { ...initial, conversationId: 'other', cursor: 'other' },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    await mount();
    await toggle();
    expect(visible()).toEqual(['❤️']);
    expect(wire.requests[0]?.path).toBe('/v1/conversations/c1/messages/m1/reactions');
    expect(wire.requests[0]?.body).toEqual({
      emoji: '❤️',
      active: true,
      mutationId: expect.any(String),
    });
    await acknowledge();
    expect(current.messages[0]).toMatchObject({ reactions: ['❤️'], reactionRevision: 1 });
    expect(client.getQueryData(aliaQueryKeys.conversations.detail('c1'))).toMatchObject({
      messages: [{ reactions: ['❤️'], reactionRevision: 1 }],
    });
    expect(client.getQueryData(aliaQueryKeys.threads.messages('salina'))).toMatchObject({
      pages: [
        {
          messages: [
            { reactions: ['❤️'], reactionRevision: 1 },
            { reactions: [], reactionRevision: 0 },
          ],
        },
      ],
    });
    await act(async () =>
      reactionsListener?.({
        conversationId: 'c1',
        messageId: 'm1',
        reactions: ['🎉'],
        revision: 3,
      }),
    );
    expect(visible()).toEqual(['🎉']);
    await act(async () =>
      reactionsListener?.({ conversationId: 'c1', messageId: 'm1', reactions: [], revision: 2 }),
    );
    expect(visible()).toEqual(['🎉']);
    expect(current.messages[0]?.reactionRevision).toBe(3);
    await act(async () =>
      reactionsListener?.({ conversationId: 'other', messageId: 'm1', reactions: [], revision: 5 }),
    );
    expect(visible()).toEqual(['🎉']);
    expect(errors).not.toHaveBeenCalled();
  });
  it('accepts legacy acknowledgements without replaying a toggle or inventing a revision', async () => {
    await mount();
    await toggle();
    await act(async () => wire.requests[0]?.resolve({ data: { reactions: ['❤️'] } }));
    expect(wire.requests).toHaveLength(1);
    expect(visible()).toEqual(['❤️']);
    expect(current.messages[0]).toMatchObject({ reactions: ['❤️'], reactionRevision: 0 });
    expect(errors).not.toHaveBeenCalled();
  });
  it('never retries an ambiguous POST, even after a modern worker has acknowledged a prior reaction', async () => {
    await mount();
    await toggle();
    await acknowledge();
    await toggle();
    await act(async () => wire.requests[1]?.reject(new Error('connection lost')));
    expect(wire.requests).toHaveLength(2);
    expect(visible()).toEqual(['❤️']);
    expect(errors).toHaveBeenCalledExactlyOnceWith('chat.reactionFailed');
  });
  it('preserves a newer socket revision over an unversioned legacy HTTP acknowledgement', async () => {
    await mount();
    await toggle();
    await act(async () =>
      reactionsListener?.({
        conversationId: 'c1',
        messageId: 'm1',
        reactions: ['🎉'],
        revision: 3,
      }),
    );
    await act(async () => wire.requests[0]?.resolve({ data: { reactions: ['❤️'] } }));
    expect(visible()).toEqual(['🎉']);
    expect(current.messages[0]).toMatchObject({ reactions: ['🎉'], reactionRevision: 3 });
  });

  it('keeps rapid retraction visible while acknowledgements arrive', async () => {
    await mount();
    await toggle();
    await toggle();
    expect(visible()).toEqual([]);
    expect(wire.requests).toHaveLength(1);
    await acknowledge();
    expect(visible()).toEqual([]);
    expect(wire.requests[1]?.body.active).toBe(false);
    await acknowledge(2, []);
    expect(current.messages[0]?.reactions).toEqual([]);
  });
  it.each(['direct', 'group'])(
    'keeps a quiet %s reaction silent and draws only a real selected agent response',
    async (conversationId) => {
      await mount(conversationId);
      await toggle(conversationId);
      await acknowledge();
      await room(conversationId, 'group.idle', { reason: 'done' });
      expect(current.messages).toHaveLength(1);
      expect(current.messages[0]?.isStreaming).not.toBe(true);
      expect(errors).not.toHaveBeenCalled();
      expect(roomFailure).not.toHaveBeenCalled();
      const id = 'reaction-reply-1';
      await room(conversationId, 'alia.agent_start', {
        consultId: id,
        agent: { id: 'salina', name: 'Salina' },
      });
      expect(current.messages).toHaveLength(2);
      expect(current.messages[1]).toMatchObject({
        content: '',
        isStreaming: true,
        agentInfo: { id: 'salina' },
      });
      await room(conversationId, 'alia.agent_delta', { consultId: id, content: 'Me alegra' });
      await room(conversationId, 'alia.agent_end', {
        consultId: id,
        status: 'completed',
        content: 'Me alegra',
        messageId: id,
      });
      await room(conversationId, 'group.message', {
        message: {
          id,
          role: 'assistant',
          content: 'Me alegra',
          agentInfo: { id: 'salina', name: 'Salina' },
        },
      });
      await room(conversationId, 'group.message', {
        message: {
          id,
          role: 'assistant',
          content: 'Me alegra',
          agentInfo: { id: 'salina', name: 'Salina' },
        },
      });
      expect(current.messages.map((m) => [m.id, m.content])).toEqual([
        ['m1', 'Hola'],
        [id, 'Me alegra'],
      ]);
      expect(wire.requests).toHaveLength(1);
      expect(wire.requests[0]?.path).toContain('/reactions');
    },
  );
  it('refuses unsaved targets and rolls back permission failures without retry', async () => {
    await mount();
    await act(async () => current.reaction.toggle('draft', '❤️', [], undefined));
    expect(wire.requests).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockClear();
    await toggle();
    await act(async () => wire.requests[0]?.reject({ status: 403 }));
    expect(visible()).toEqual([]);
    expect(wire.requests).toHaveLength(1);
    expect(errors).toHaveBeenCalledExactlyOnceWith('chat.reactionFailed');
  });
  it('drops pending acknowledgements on account changes and unsubscribes', async () => {
    await mount();
    await toggle();
    wire.accountId = 'u2';
    await act(async () => renderer?.update(tree('c1')));
    await acknowledge();
    expect(current.messages[0]?.reactions).toEqual([]);
    expect(visible()).toEqual([]);
    expect(release).toHaveBeenCalled();
  });
});
