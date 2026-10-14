import { describe, expect, it } from 'vitest';
import type { ToolInvocation } from '../../src/types';
import { askedQuestions, formatAnswers, pendingQuestions } from '../../src/lib/questions';

const call = (args: unknown, state: ToolInvocation['state'] = 'result'): ToolInvocation => ({
  toolName: 'askUserQuestion',
  state,
  args: args as Record<string, unknown>,
});
const q = { question: 'Which one?', options: [{ label: 'A' }, { label: 'B', description: 'b' }] };

describe('askedQuestions', () => {
  it('reads a finished call, defaulting to single-select', () => {
    expect(askedQuestions(call({ questions: [q] }))).toEqual([
      {
        question: 'Which one?',
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B', description: 'b' }],
      },
    ]);
  });

  it('is nothing before the call has returned, and nothing for another tool', () => {
    expect(askedQuestions(call({ questions: [q] }, 'call'))).toBeNull();
    expect(askedQuestions({ ...call({ questions: [q] }), toolName: 'webSearch' })).toBeNull();
  });

  it('refuses arguments it cannot draw rather than throwing', () => {
    expect(askedQuestions(call(undefined))).toBeNull();
    expect(askedQuestions(call({ questions: [] }))).toBeNull();
    expect(askedQuestions(call({ questions: [{ ...q, options: [{ label: 'A' }] }] }))).toBeNull();
    expect(askedQuestions(call({ questions: [{ ...q, question: ' ' }] }))).toBeNull();
    expect(
      askedQuestions(call({ questions: [{ ...q, options: [{ label: 'A' }, {}] }] })),
    ).toBeNull();
  });
});

describe('formatAnswers', () => {
  const asked = askedQuestions(
    call({
      questions: [
        { ...q, multiSelect: true },
        { question: 'When?', options: [{ label: 'Now' }, { label: 'Later' }] },
      ],
    }),
  );

  it('writes one line pair per question, picked labels then typed text', () => {
    expect(
      formatAnswers(asked!, [{ picked: [0, 1], other: ' both, honestly ' }, { picked: [1] }]),
    ).toBe('Which one?\n→ A, B, both, honestly\n\nWhen?\n→ Later');
  });

  it('survives an answer that is missing or points past the options', () => {
    expect(formatAnswers(asked!, [{ picked: [9] }])).toBe('Which one?\n→ \n\nWhen?\n→ ');
  });
});

describe('pendingQuestions', () => {
  const asked = (role: 'assistant' | 'user' = 'assistant') => ({
    role,
    toolInvocations: [call({ questions: [q] })],
  });

  it('is what the last message, hers and finished, asked', () => {
    expect(pendingQuestions([{ role: 'user' }, asked()], false)).toHaveLength(1);
  });

  it('is nothing while she is still streaming, or once anything follows the question', () => {
    expect(pendingQuestions([asked()], true)).toEqual([]);
    expect(pendingQuestions([asked(), { role: 'user' }], false)).toEqual([]);
  });

  it('is nothing for a last message that asked nothing, or an empty chat', () => {
    expect(pendingQuestions([{ role: 'assistant' }], false)).toEqual([]);
    expect(pendingQuestions([], false)).toEqual([]);
  });
});
