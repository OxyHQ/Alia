import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  prompt: undefined as
    | undefined
    | {
        answer: (text: string) => void;
        emit: (name: string) => boolean;
        listenerCount: (name: string) => number;
      },
}));
vi.mock('readline', () => ({
  createInterface: () => {
    const prompt = Object.assign(new EventEmitter(), {
      answer: (_text: string) => {},
      question: (_text: string, answer: (text: string) => void) => {
        prompt.answer = answer;
      },
      close: () => {
        prompt.emit('close');
      },
    });
    fixture.prompt = prompt;
    return prompt;
  },
}));
vi.mock('../../utils/conversation.js', () => ({ processConversation: vi.fn() }));
import { askApproval } from '../run.js';
const execution = { id: 'fixture', tool: 'write_file', args: { path: 'fixture.txt' } };
afterEach(() => vi.restoreAllMocks());
it.each([
  ['n', false],
  ['yes', true],
])('keeps ordinary %s approval without requesting Stop', async (answer, expected) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const interrupt = vi.fn(),
    lifetime = new AbortController();
  const result = askApproval(execution, lifetime.signal, interrupt);
  fixture.prompt?.answer(String(answer));
  expect(await result).toBe(expected);
  expect(interrupt).not.toHaveBeenCalled();
  expect(fixture.prompt?.listenerCount('SIGINT')).toBe(0);
});
it('readline Ctrl+C invokes explicit Stop and declines the outstanding approval', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const activity = new AbortController();
  const interrupt = vi.fn(() => activity.abort());
  const result = askApproval(execution, activity.signal, interrupt);
  fixture.prompt?.emit('SIGINT');
  expect(await result).toBe(false);
  fixture.prompt?.answer('yes');
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(fixture.prompt?.listenerCount('SIGINT')).toBe(0);
});
it('EOF declines without synthesizing explicit Stop', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const interrupt = vi.fn();
  const result = askApproval(execution, new AbortController().signal, interrupt);
  fixture.prompt?.emit('close');
  expect(await result).toBe(false);
  expect(interrupt).not.toHaveBeenCalled();
});
