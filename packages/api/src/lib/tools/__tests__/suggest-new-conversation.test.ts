/**
 * The agent may SUGGEST a new conversation. It may not start one.
 *
 * That is the safety property of the whole feature, and it is the kind that
 * cannot be read off the code with confidence: a tool called
 * `suggestNewConversation` that quietly created a row would look right at every
 * call site. So it is asserted with a positive control — the repository is a
 * spy, and the test that would catch a write is proved able to catch one before
 * it is trusted to say nothing was written.
 *
 * The other half is the bound. A model that calls this on every step of a long
 * turn must not push a suggestion behind a suggestion, and the bound belongs to
 * the SERVER rather than to the model's good behaviour — so it is exercised by
 * calling the tool repeatedly, which is exactly what a model does.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSuggestNewConversationTool } from '../suggest-new-conversation.js';
import * as conversationRepository from '../../../db/chat/conversationRepository.js';
import type { NewConversationSuggestion } from '../suggest-new-conversation.js';

/** The tool's `execute`, which `ai`'s `tool()` leaves on the object. */
function run(
  emitted: NewConversationSuggestion[],
): (input: { reason: string }) => Promise<{ suggested: boolean; message: string }> {
  const built = createSuggestNewConversationTool((suggestion) => emitted.push(suggestion));
  const execute = built.execute;
  if (execute === undefined) throw new Error('the tool has no execute');
  return (input) =>
    execute(input, {
      toolCallId: 'call-1',
      messages: [],
    }) as Promise<{ suggested: boolean; message: string }>;
}

describe('it suggests, and cannot create', () => {
  it('emits one suggestion carrying the reason', async () => {
    const emitted: NewConversationSuggestion[] = [];
    const result = await run(emitted)({ reason: 'we have moved to the billing bug' });

    expect(result.suggested).toBe(true);
    expect(emitted).toEqual([
      { eventVersion: 1, reason: 'we have moved to the billing bug' },
    ]);
  });

  it('writes NO conversation, and the spy can see one being written', async () => {
    /**
     * The assertion this file exists for, with its control.
     *
     * `expect(spy).not.toHaveBeenCalled()` on a spy that could never fire is the
     * same observation as a passing test over nothing, so the control below
     * calls the real export first and asserts the spy SEES it. Only then does
     * "the tool did not call it" mean anything.
     */
    const createSpy = vi
      .spyOn(conversationRepository, 'createConversation')
      .mockResolvedValue({} as Awaited<ReturnType<typeof conversationRepository.createConversation>>);

    // The positive control: this spy really does observe a creation.
    await conversationRepository.createConversation({} as never, {
      oxyUserId: 'u',
      conversationId: 'c',
      title: 't',
      source: 'app',
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    createSpy.mockClear();

    const emitted: NewConversationSuggestion[] = [];
    await run(emitted)({ reason: 'a new subject' });

    expect(createSpy).not.toHaveBeenCalled();
    // And it did do its own job, so "wrote nothing" is not "did nothing".
    expect(emitted).toHaveLength(1);

    createSpy.mockRestore();
  });

  it('leaves nothing behind when it is ignored', async () => {
    // Ignoring a suggestion changes nothing, which is trivially true because
    // nothing was written — stated as a test so it stays trivially true.
    const emitted: NewConversationSuggestion[] = [];
    const suggest = run(emitted);
    await suggest({ reason: 'first' });

    // Nothing to clear, nothing to expire, nothing to accept.
    expect(emitted).toHaveLength(1);
  });
});

describe('the once-per-turn bound is the SERVER’s', () => {
  it('emits once however many times the model calls it', async () => {
    const emitted: NewConversationSuggestion[] = [];
    const suggest = run(emitted);

    const first = await suggest({ reason: 'one' });
    const second = await suggest({ reason: 'two' });
    const third = await suggest({ reason: 'three' });

    expect(first.suggested).toBe(true);
    expect(second.suggested).toBe(false);
    expect(third.suggested).toBe(false);
    expect(emitted).toEqual([{ eventVersion: 1, reason: 'one' }]);
  });

  it('tells the model it already suggested, rather than looking broken', async () => {
    // A bare `{ suggested: false }` reads to a model as a failure, and it
    // retries. The sentence is what makes the refusal an answer.
    const suggest = run([]);
    await suggest({ reason: 'one' });
    const again = await suggest({ reason: 'two' });

    expect(again.message).toContain('already');
  });

  it('is per TURN, because the factory is what holds the flag', async () => {
    // Two turns are two factory calls. If the flag were module-level, the
    // second turn could never suggest anything — which is the failure a
    // longer-lived cache would produce and nobody would report.
    const first: NewConversationSuggestion[] = [];
    const second: NewConversationSuggestion[] = [];
    await run(first)({ reason: 'turn one' });
    await run(second)({ reason: 'turn two' });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

describe('what travels is bounded', () => {
  it('clips a reason to something a chip can hold', async () => {
    const emitted: NewConversationSuggestion[] = [];
    await run(emitted)({ reason: 'x'.repeat(500) });

    expect(emitted[0].reason).toHaveLength(200);
  });

  it('trims, so a reason of whitespace does not become a blank chip', async () => {
    const emitted: NewConversationSuggestion[] = [];
    await run(emitted)({ reason: '   the subject changed   ' });

    expect(emitted[0].reason).toBe('the subject changed');
  });
});
