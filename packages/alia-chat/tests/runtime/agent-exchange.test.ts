import { describe, expect, it } from 'vitest';
import { COPY_EN } from '../../src/lib/copy-en';
import { COPY_ES } from '../../src/lib/copy-es';
import { agentExchange } from '../../src/runtime/thread/agent-exchange';
import type { Message } from '../../src/runtime/types';

const SINDI = { id: 'sindi', name: 'Sindi' };
const NADIA = { id: 'nadia', name: 'Nadia' };

const consult = (id: string, agentId: string, task: string, response: string) => ({
  toolCallId: id,
  toolName: 'consultAgent',
  state: 'result' as const,
  args: { agentId, task },
  result: { agentId, agentName: agentId, response },
});
const user = (id: string): Message => ({ id, role: 'user', content: 'hi' });
const reply = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  role: 'assistant',
  content: 'ok',
  ...over,
});

describe('copy of the agent exchange', () => {
  it('says "chatted with" in the past tense, in both languages', () => {
    expect(COPY_EN['chat.chattedWith']).toBe('Chatted with %{name}');
    expect(COPY_ES['chat.chattedWith']).toContain('%{name}');
    expect(COPY_ES['chat.agentChatNotice']).toBeTruthy();
    expect(COPY_EN['chat.agentChatNotice']).toBeTruthy();
    expect('chat.chatWith' in COPY_EN || 'chat.chatWith' in COPY_ES).toBe(false);
  });
});

describe('agentExchange', () => {
  it('pairs what the lead asked with what the agent answered', () => {
    const rows = [
      user('u1'),
      reply('a1', { toolInvocations: [consult('c1', 'sindi', 'Flats?', 'Three.')] }),
      reply('a2', { content: 'Three.', agentInfo: SINDI }),
    ];
    expect(agentExchange(rows, 'a2')).toEqual({
      agent: SINDI,
      pairs: [{ asker: null, task: 'Flats?', answer: 'Three.' }],
    });
  });

  it('keeps several consultations of the agent in order, and ignores other agents and turns', () => {
    const rows = [
      user('u0'),
      reply('x1', { toolInvocations: [consult('c0', 'sindi', 'Old', 'Old answer')] }),
      reply('x2', { content: 'Old answer', agentInfo: SINDI }),
      user('u1'),
      reply('a1', {
        toolInvocations: [
          consult('c1', 'sindi', 'First', 'One'),
          consult('c2', 'nadia', 'Other', 'Elsewhere'),
          consult('c3', 'sindi', 'Second', 'Two'),
        ],
      }),
      reply('a2', { content: 'One', agentInfo: SINDI }),
      reply('a3', { content: 'Elsewhere', agentInfo: NADIA }),
      reply('a4', { content: 'Two', agentInfo: SINDI }),
    ];
    expect(agentExchange(rows, 'a2')?.pairs).toEqual([
      { asker: null, task: 'First', answer: 'One' },
      { asker: null, task: 'Second', answer: 'Two' },
    ]);
  });

  it('names a consulting agent as the asker', () => {
    const rows = [
      user('u1'),
      reply('a1', {
        agentInfo: NADIA,
        toolInvocations: [consult('c1', 'sindi', 'Flats?', 'Three.')],
      }),
      reply('a2', { content: 'Three.', agentInfo: SINDI }),
    ];
    expect(agentExchange(rows, 'a2')?.pairs[0]?.asker).toEqual(NADIA);
  });

  it('still gives the answer when the task was not stored', () => {
    const rows = [user('u1'), reply('a1'), reply('a2', { content: 'Three.', agentInfo: SINDI })];
    expect(agentExchange(rows, 'a2')?.pairs).toEqual([
      { asker: null, task: null, answer: 'Three.' },
    ]);
  });

  it('is null for a message that is not a consulted agent', () => {
    expect(agentExchange([user('u1'), reply('a1')], 'a1')).toBeNull();
    expect(agentExchange([user('u1')], 'missing')).toBeNull();
  });
});

it('never constructs a self-exchange or an internal exchange for group members', () => {
  const rows = [user('u1'), reply('a1', { content: 'Hello again.', agentInfo: SINDI })];
  expect(agentExchange(rows, 'a1', new Set(['sindi']))).toBeNull();
  expect(agentExchange(rows, 'a1', new Set(['sindi', 'nadia']))).toBeNull();
});
