import { describe, expect, it } from 'vitest';
import type { ToolInvocation } from '../../src/types';
import { askedQuestions, formatAnswers } from '../../src/lib/questions';

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
