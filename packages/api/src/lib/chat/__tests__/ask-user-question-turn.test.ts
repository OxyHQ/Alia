/**
 * A turn that asks a question ENDS there: no tools-disabled synthesis pass.
 *
 * Without the guard, `finish` after a tool result and no text reads as "progress
 * without an answer" and the runner asks the model to write one, so the person
 * would get a card AND a guessed answer under it. The positive control is the
 * same stream with an ordinary tool, which must still be synthesized.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      v1: child,
      chat: child,
      general: child,
      agents: child,
      credits: child,
      providers: child,
    },
  };
});
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');

const turn = (toolName: string) => [
  { type: 'tool-call', toolCallId: 'c1', toolName, input: { questions: [] } },
  { type: 'tool-result', toolCallId: 'c1', toolName, output: { asked: 1 } },
  { type: 'finish', finishReason: 'tool-calls' },
];

describe('a turn that ends at a question', () => {
  it('finishes without writing an answer and keeps the call for the save', async () => {
    const { toolInvocations, hasStreamedText, written } = await runChunks(turn('askUserQuestion'));

    expect(hasStreamedText).toBe(false);
    expect(toolInvocations).toMatchObject([{ toolName: 'askUserQuestion', state: 'result' }]);
    expect(written.some((frame) => frame.includes('"finish_reason":"tool-calls"'))).toBe(true);
  });

  it('control: any other tool with no text still demands an answer', async () => {
    // The synthesis pass cannot run against the double (no model), so the turn
    // fails — which is exactly the path the question must NOT take.
    await expect(runChunks(turn('webSearch'))).rejects.toThrow();
  });
});
