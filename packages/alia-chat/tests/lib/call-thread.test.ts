import { describe, expect, it } from 'vitest';
import { callThread } from '../../src/lib/call-thread';
import type { Message } from '../../src/runtime/types';
import type { VoiceMessage } from '../../src/types';

const live = (id: string, role: 'user' | 'assistant', content: string): VoiceMessage => ({
  id,
  role,
  content,
  timestamp: 0,
  isStreaming: false,
});

describe('callThread', () => {
  const before: Message[] = [{ id: 'm1', role: 'user', content: 'Escrito antes', createdAt: '' }];
  const call = [
    live('voice-u1', 'user', 'Mis posts en Mention'),
    {
      ...live('voice-t1', 'assistant', 'Buscando tus posts. No pude recuperarlos.'),
      toolInvocations: [
        { toolCallId: 'c1', toolName: 'oxy_mention__search', state: 'result' as const },
      ],
    },
  ];

  it('shows the text before the call, then the call, one message per call message', () => {
    expect(callThread(before, call, undefined).map((message) => message.id)).toEqual([
      'm1',
      'voice-u1',
      'voice-t1',
    ]);
  });

  it('shows a saved call message exactly as stored, never beside it', () => {
    const stored: Message = {
      id: 'voice-t1',
      role: 'assistant',
      content: 'Buscando tus posts. No pude recuperarlos.',
      createdAt: '2026-10-16T04:42:57.025Z',
      toolInvocations: [
        {
          toolCallId: 'c1',
          toolName: 'oxy_mention__search',
          state: 'result',
          args: { query: 'mine' },
          result: { error: { type: 'unknown' } },
        },
      ],
    } as Message;
    const thread = callThread(before, call, [before[0]!, stored]);
    expect(thread.map((message) => message.id)).toEqual(['m1', 'voice-u1', 'voice-t1']);
    expect(thread[2]).toBe(stored);
  });
});
