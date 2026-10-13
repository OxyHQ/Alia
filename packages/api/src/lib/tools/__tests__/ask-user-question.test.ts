/**
 * The model may put questions to the person; the shape it may use is bounded.
 *
 * The schema is what keeps a card drawable: 1-4 questions, 2-4 options each, and
 * the model is told the turn ends — the wire half of that (no synthesis pass
 * after the card) is `chat/__tests__/ask-user-question-turn.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { createAskUserQuestionTool } from '../ask-user-question.js';

const tool = createAskUserQuestionTool();
const schema = tool.inputSchema as unknown as {
  safeParse: (v: unknown) => { success: boolean; data?: { questions: { multiSelect: boolean }[] } };
};
const option = (label: string) => ({ label });
const question = (options = [option('A'), option('B')]) => ({ question: 'Which?', options });

describe('askUserQuestion input', () => {
  it('takes one question with two options, single-select by default', () => {
    const parsed = schema.safeParse({ questions: [question()] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.questions[0].multiSelect).toBe(false);
  });

  it('refuses no questions, five questions, one option and five options', () => {
    expect(schema.safeParse({ questions: [] }).success).toBe(false);
    expect(schema.safeParse({ questions: Array(5).fill(question()) }).success).toBe(false);
    expect(schema.safeParse({ questions: [question([option('A')])] }).success).toBe(false);
    expect(
      schema.safeParse({ questions: [question(['A', 'B', 'C', 'D', 'E'].map(option))] }).success,
    ).toBe(false);
  });

  it('refuses a blank question or option label', () => {
    expect(
      schema.safeParse({ questions: [{ question: ' ', options: [option('A'), option('B')] }] })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ questions: [question([option('A'), option(' ')])] }).success).toBe(
      false,
    );
  });
});

describe('askUserQuestion result', () => {
  it('counts the questions and tells the model to stop', async () => {
    const execute = tool.execute;
    if (execute === undefined) throw new Error('the tool has no execute');
    const result = (await execute(
      { questions: [{ ...question(), multiSelect: false }] },
      { toolCallId: 'c1', messages: [] },
    )) as { asked: number; note: string };
    expect(result.asked).toBe(1);
    expect(result.note).toMatch(/next message/);
  });
});
