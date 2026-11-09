import { describe, expect, it } from 'vitest';
import { parseGroupMembers } from '../conversation-groups.js';

describe('parseGroupMembers', () => {
  it('accepts two to six distinct agents and keeps their order', () => {
    expect(parseGroupMembers(['b', 'a'])).toEqual({ ok: true, agentIds: ['b', 'a'] });
    expect(parseGroupMembers(['1', '2', '3', '4', '5', '6']).ok).toBe(true);
  });

  it.each([
    ['one agent', ['a']],
    ['seven agents', ['1', '2', '3', '4', '5', '6', '7']],
    ['a repeat', ['a', 'a']],
    ['an empty id', ['a', '']],
    ['a non-string', ['a', 3]],
    ['not an array', 'a,b'],
  ])('refuses %s', (_name, value) => {
    expect(parseGroupMembers(value).ok).toBe(false);
  });
});
