import { describe, expect, it } from 'vitest';
import { historyForMembers, lastUserText, textOf } from '../transcript.js';

describe('room transcript helpers', () => {
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
});
