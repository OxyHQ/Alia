import { describe, expect, it } from 'vitest';
import {
  GROUP_BUDGET_MS,
  type GroupReply,
  historyForMembers,
  lastUserText,
  memberTimeoutMs,
  taskForMember,
  textOf,
} from '../group-turn.js';

const reply = (name: string, content: string): GroupReply => ({
  role: 'assistant',
  content,
  agentInfo: { id: name, name, color: 'blue', character: { preset: 'blue_beret' }, handle: name },
});

describe('group turn helpers', () => {
  it('reads the text of string or part content', () => {
    expect(textOf('hi')).toBe('hi');
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: {} },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
    expect(textOf(undefined)).toBe('');
  });

  it('takes the last user message as the task', () => {
    expect(
      lastUserText([
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'x' },
        { role: 'user', content: ' two ' },
      ]),
    ).toBe('two');
  });

  it('builds the history before the last user message, naming agents', () => {
    expect(
      historyForMembers([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi', agentInfo: { name: 'Nadia' } },
        { role: 'user', content: 'now' },
      ]),
    ).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Nadia: hi' },
    ]);
  });

  it('shows later members what earlier ones said', () => {
    expect(taskForMember('q', [])).toBe('q');
    const task = taskForMember('q', [reply('Nadia', 'a1')]);
    expect(task).toContain('Nadia: a1');
    expect(task.startsWith('q')).toBe(true);
  });

  it('shares the remaining budget and refuses to start with too little', () => {
    const startedAt = 0;
    expect(memberTimeoutMs({ startedAt, now: 0, membersLeft: 6 })).toBe(
      Math.floor(GROUP_BUDGET_MS / 6),
    );
    expect(memberTimeoutMs({ startedAt, now: 0, membersLeft: 1 })).toBeLessThanOrEqual(
      GROUP_BUDGET_MS,
    );
    expect(memberTimeoutMs({ startedAt, now: GROUP_BUDGET_MS - 1_000, membersLeft: 1 })).toBe(0);
  });
});
