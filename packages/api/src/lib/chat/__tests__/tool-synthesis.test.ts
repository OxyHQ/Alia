import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateAnswered, owesAnswer, SYNTHESIS_REQUEST } from '../tool-synthesis.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** A model that calls `lookup` while it is offered tools, and answers once it is not. */
function scriptedModel() {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const offered = (options.tools?.length ?? 0) > 0;
      return offered
        ? {
            content: [
              { type: 'text', text: 'Let me look that up.' },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{}' },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: 'text', text: 'It is Tuesday.' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
            warnings: [],
          };
    },
  });
  return { model, prompts };
}

const tools = {
  lookup: tool({
    description: 'look up',
    inputSchema: z.object({}),
    execute: async () => ({ day: 'Tuesday' }),
  }),
};

describe('owesAnswer', () => {
  it('is owed when the last step ended on tool results', () => {
    expect(owesAnswer([{ toolResults: [] }, { toolResults: [{}] }])).toBe(true);
  });

  it('is not owed when the last step wrote the answer, or there are no steps', () => {
    expect(owesAnswer([{ toolResults: [{}] }, { toolResults: [] }])).toBe(false);
    expect(owesAnswer([])).toBe(false);
  });
});

describe('generateAnswered', () => {
  it('writes the answer the loop owed and sums what both calls spent', async () => {
    const { model, prompts } = scriptedModel();
    const config = {
      model,
      messages: [{ role: 'user' as const, content: 'What day is it?' }],
      tools,
      stopWhen: () => true, // the loop is cut right after its first step of tools
    };

    const answered = await generateAnswered(config);

    expect(answered.text).toBe('It is Tuesday.');
    expect(answered.answer).not.toBeNull();
    expect(answered.finishReason).toBe('stop');
    expect(answered.usage.inputTokens).toBe(20);
    expect(answered.usage.outputTokens).toBe(10);
    const last = prompts.at(-1) as Array<{ role: string; content: unknown }>;
    expect(last.at(-1)).toMatchObject({ role: 'user' });
    expect(JSON.stringify(last.at(-1))).toContain(SYNTHESIS_REQUEST);
    // The history carries the call and its result the model is answering from.
    expect(last.some((m) => m.role === 'tool')).toBe(true);
  });

  it('adds no pass when the loop already answered', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Hello.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      }),
    });

    const answered = await generateAnswered({
      model,
      messages: [{ role: 'user' as const, content: 'hi' }],
    });

    expect(answered.answer).toBeNull();
    expect(answered.text).toBe('Hello.');
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
