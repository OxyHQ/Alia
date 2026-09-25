import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder } from '../system-prompt-builder.js';

/**
 * A voice call's turn asks for an answer meant to be heard.
 *
 * Voice calls run on the device and send each spoken turn through the chat
 * handler with `responseMode: 'voice'` (`@alia.onl/sdk` 8.0.0). The turn keeps
 * the conversation's own routing profile, so the product prompt that profile
 * selects still loads, and `prompts/voice.md` is layered over it — the same
 * shape as extended reasoning.
 */

const VOICE_PROFILE_MARKER = '# RESPONSE PROFILE — Voice';
const GENERAL_PROFILE_MARKER = '# RESPONSE PROFILE — V1';

async function build(options: { surface?: 'chat' | 'codea' | 'cowork'; responseMode?: 'voice' | null }): Promise<string> {
  return SystemPromptBuilder.build({ isDirectUserSession: false, ...options });
}

describe('the spoken-answer layer', () => {
  it('is added to a typed profile when the turn is spoken', async () => {
    const prompt = await build({ surface: 'chat', responseMode: 'voice' });
    expect(prompt).toContain(VOICE_PROFILE_MARKER);
    expect(prompt).toContain('No visual formatting');
  });

  it('is absent from a typed turn — the control', async () => {
    const prompt = await build({ surface: 'chat' });
    expect(prompt).not.toContain(VOICE_PROFILE_MARKER);
  });

  it('lands after the profile prompt it modifies, which still loads', async () => {
    const prompt = await build({ surface: 'chat', responseMode: 'voice' });
    const general = prompt.indexOf(GENERAL_PROFILE_MARKER);
    expect(general).toBeGreaterThan(-1);
    expect(prompt.indexOf(VOICE_PROFILE_MARKER)).toBeGreaterThan(general);
  });

  it('is layered exactly once, whatever the surface', async () => {
    for (const surface of ['chat', 'codea', 'cowork'] as const) {
      const prompt = await build({ surface, responseMode: 'voice' });
      expect(prompt.split(VOICE_PROFILE_MARKER)).toHaveLength(2);
    }
  });
});
