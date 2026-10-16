import { describe, expect, it } from 'vitest';
import type { MessageRow } from '../../db/chat/messageRepository.js';
import { sharedMessagesOf } from '../shared-conversation.js';

const row = (overrides: Partial<MessageRow>): MessageRow => ({
  id: 'r',
  conversationId: 'c',
  oxyUserId: 'u',
  clientMessageId: null,
  role: 'user',
  content: '',
  vote: null,
  toolInvocations: null,
  agentInfoId: null,
  agentInfoName: null,
  agentInfoColor: null,
  agentInfoCharacter: null,
  agentInfoHandle: null,
  seq: null,
  interruptedAfterMs: null,
  createdAt: new Date(0),
  ...overrides,
});

describe('what a share link shows', () => {
  it('keeps text and images, in order, and drops every other part', () => {
    expect(
      sharedMessagesOf([
        row({
          content: [
            { type: 'text', text: 'hola' },
            { type: 'file', file: { file_id: 'f' } },
            { type: 'reasoning', text: 'private scratch' },
            { type: 'tool-result', output: { secret: true } },
            { type: 'image_url', image_url: { url: 'https://cdn/x.jpg' } },
          ],
        }),
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hola' },
          { type: 'image_url', image_url: { url: 'https://cdn/x.jpg' } },
        ],
      },
    ]);
  });

  it('never carries tool invocations, system rows or a message left empty', () => {
    expect(
      sharedMessagesOf([
        row({ role: 'system', content: 'prompt' }),
        row({
          role: 'assistant',
          content: '',
          toolInvocations: [{ toolCallId: 't', toolName: 'x', state: 'result', result: 'secret' }],
        }),
        row({ role: 'user', content: [{ type: 'file', file: { file_id: 'f' } }] }),
        row({ role: 'assistant', content: 'answer', toolInvocations: [{ result: 'secret' }] }),
      ]),
    ).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  it('says which agent spoke', () => {
    expect(
      sharedMessagesOf([
        row({
          role: 'assistant',
          content: 'hi',
          agentInfoId: 'a',
          agentInfoName: 'Sindi',
          agentInfoHandle: 'sindibot',
          agentInfoColor: 'teal',
        }),
      ])[0].agent,
    ).toEqual({ id: 'a', name: 'Sindi', handle: 'sindibot', color: 'teal', character: null });
  });
});
