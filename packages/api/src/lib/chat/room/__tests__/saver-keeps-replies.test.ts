import { describe, expect, it } from 'vitest';
import {
  GROUP_REPLY_MESSAGE_ID_PREFIX,
  isAgentWrittenMessageId,
} from '../../../../domain/conversation.js';
import type { MessageRow } from '../../../../db/chat/messageRepository.js';
import { keepAgentOutreach } from '../../../conversation-saver.js';
import { replyIdOf } from '../engine.js';

const row = (over: Partial<MessageRow>): MessageRow => ({
  id: 'r',
  conversationId: 'c',
  oxyUserId: 'u',
  clientMessageId: null,
  role: 'user',
  content: 'x',
  vote: null,
  reactions: null,
  toolInvocations: null,
  agentInfoId: null,
  agentInfoName: null,
  agentInfoColor: null,
  agentInfoCharacter: null,
  agentInfoHandle: null,
  seq: 0,
  interruptedAfterMs: null,
  createdAt: new Date(0),
  ...over,
});

describe('a room reply the client never saw survives the client’s next turn', () => {
  it('marks room replies as written by someone other than the sending client', () => {
    expect(isAgentWrittenMessageId(replyIdOf('p1', 2))).toBe(true);
    expect(replyIdOf('p1', 2).startsWith(GROUP_REPLY_MESSAGE_ID_PREFIX)).toBe(true);
    expect(isAgentWrittenMessageId('client-id')).toBe(false);
    expect(isAgentWrittenMessageId('agent-push-1')).toBe(true);
  });

  it('puts a stored room reply back after the message it answered', () => {
    const stored = [
      row({ id: '1', clientMessageId: 'u1', role: 'user', content: 'hello', seq: 0 }),
      row({
        id: '2',
        clientMessageId: replyIdOf('1', 0),
        role: 'assistant',
        content: 'late reply',
        agentInfoId: 'a',
        agentInfoName: 'Nadia',
        seq: 1,
      }),
    ];
    // The client only knows its own message and sends a new one.
    const client = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'u2', role: 'user', content: 'and now' },
    ];
    const merged = keepAgentOutreach(stored, client as never);
    expect(merged.map((m) => m.content)).toEqual(['hello', 'late reply', 'and now']);
    expect(merged[1]).toMatchObject({ agentInfo: { name: 'Nadia' } });
  });
});
