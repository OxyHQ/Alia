import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ alia: [] as Array<[string, Record<string, unknown>]> }));

vi.mock('../../../socket.js', () => ({
  emitAgentActivity: vi.fn(),
  emitAliaActivity: (userId: string, data: Record<string, unknown>) => {
    sent.alia.push([userId, data]);
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn() }));
vi.mock('../../../db/agents/eventStreamEntryRepository.js', () => ({
  appendEventStreamEntries: vi.fn(),
  listEventStreamEntries: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ log: { agents: { warn: vi.fn() } } }));

import { EventStream } from '../event-stream.js';

const states = () => sent.alia.map(([, data]) => data.state);

describe('EventStream tells the person what Alia is doing', () => {
  beforeEach(() => {
    sent.alia = [];
  });

  it('sends the state to the run owner, once per change', () => {
    const stream = new EventStream({ agentId: 'a', sessionId: 's', userId: 'u' });

    stream.append('thinking', '…');
    stream.append('action', 'search', { toolName: 'search' });
    stream.append('action', 'open', { toolName: 'open' });
    stream.append('screenshot', 'img');
    stream.append('observation', 'ok');
    stream.append('response', 'text');
    stream.append('complete', 'done');

    expect(states()).toEqual(['thinking', 'working', 'thinking', 'writing', 'idle']);
    expect(sent.alia.every(([userId]) => userId === 'u')).toBe(true);
    expect(sent.alia[0][1]).toMatchObject({ agentId: 'a', sessionId: 's' });
  });

  it('says nothing for a run with no owner, and nothing for a run that stays idle', () => {
    new EventStream({ agentId: 'a', sessionId: 's' }).append('thinking', '…');
    new EventStream({ agentId: 'a', sessionId: 's', userId: 'u' }).append('screenshot', 'x');
    expect(sent.alia).toEqual([]);
  });

  it('an error ends the run as idle', () => {
    const stream = new EventStream({ agentId: 'a', sessionId: 's', userId: 'u' });
    stream.append('action', 'x');
    stream.append('error', 'boom');
    expect(states()).toEqual(['working', 'idle']);
  });
});
