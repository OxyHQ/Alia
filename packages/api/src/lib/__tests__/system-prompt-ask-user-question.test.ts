import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder } from '../system-prompt-builder.js';

/**
 * The rule that sends a choice to the card instead of the reply is injected only
 * when `askUserQuestion` is in the turn's tool set: a client with no card must not
 * be told to call a tool it does not have.
 */
const MARKER = 'Asking the person (`askUserQuestion`)';

const build = (extra: { askUserQuestion?: boolean; responseMode?: 'voice' | null }) =>
  SystemPromptBuilder.build({ isDirectUserSession: true, ...extra });

describe('the askUserQuestion prompt rule', () => {
  it('is present when the tool is registered', async () => {
    const prompt = await build({ askUserQuestion: true });
    expect(prompt).toContain(MARKER);
    expect(prompt).toContain('instead of writing the question in your reply');
    expect(prompt.split(MARKER)).toHaveLength(2);
  });

  it('is absent when the tool is not registered', async () => {
    expect(await build({})).not.toContain(MARKER);
    expect(await build({ askUserQuestion: false })).not.toContain(MARKER);
  });

  it('is absent from a spoken turn, which cannot draw a card', async () => {
    expect(await build({ askUserQuestion: true, responseMode: 'voice' })).not.toContain(MARKER);
  });
});
