import { describe, expect, it } from 'vitest';
import { speakerChanges } from '../../src/runtime/thread/speaker-changes';

const user = (id: string) => ({ id, role: 'user' });
const lead = (id: string) => ({ id, role: 'assistant' });
const agent = (id: string, agentId: string, name: string) => ({
  id,
  role: 'assistant',
  agentInfo: { id: agentId, name },
});

const ids = (changes: ReturnType<typeof speakerChanges>) =>
  [...changes].map(([id, change]) => `${id}:${change.agentName}`);

describe('speakerChanges', () => {
  it('marks nothing in a conversation with only the lead', () => {
    expect(speakerChanges([user('u1'), lead('a1'), user('u2'), lead('a2')]).size).toBe(0);
  });

  it('marks the turn where a consulted agent first speaks', () => {
    expect(ids(speakerChanges([user('u1'), agent('a1', 'x', 'Nadia')]))).toEqual(['a1:Nadia']);
  });

  it('marks an agent once however many replies it gives in a row', () => {
    const rows = [user('u1'), agent('a1', 'x', 'Nadia'), agent('a2', 'x', 'Nadia')];
    expect(ids(speakerChanges(rows))).toEqual(['a1:Nadia']);
  });

  it('announces another agent, and the same agent again after the lead spoke in between', () => {
    const rows = [
      agent('a1', 'x', 'Nadia'),
      agent('a2', 'y', 'Claudio'),
      user('u1'),
      lead('a3'),
      agent('a4', 'y', 'Claudio'),
    ];
    expect(ids(speakerChanges(rows))).toEqual(['a1:Nadia', 'a2:Claudio', 'a4:Claudio']);
  });

  it('is not moved by the person speaking between two replies of one agent', () => {
    const rows = [agent('a1', 'x', 'Nadia'), user('u1'), agent('a2', 'x', 'Nadia')];
    expect(ids(speakerChanges(rows))).toEqual(['a1:Nadia']);
  });

  it('announces nobody who is a member of the conversation: a group speaks as itself', () => {
    const rows = [
      user('u1'),
      agent('a1', 'x', 'Nadia'),
      agent('a2', 'y', 'Claudio'),
      user('u2'),
      agent('a3', 'x', 'Nadia'),
    ];
    expect(speakerChanges(rows, new Set(['x', 'y'])).size).toBe(0);
  });

  it('still announces an agent from outside the group', () => {
    const rows = [user('u1'), agent('a1', 'x', 'Nadia'), agent('a2', 'z', 'Guest')];
    expect(ids(speakerChanges(rows, new Set(['x', 'y'])))).toEqual(['a2:Guest']);
  });
});
