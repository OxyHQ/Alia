import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder, type UserMemoryData } from '../system-prompt-builder.js';
import { STYLE_PROMPT_MAX_CHARS, formatStyleForPrompt } from '../style/style-prompt.js';
import type { IWritingStyleProfile } from '../../domain/writing-style.js';
import type { HydratedAgent } from '../agent-identity.js';

/**
 * The learned writing style reaches the system message — and only where the
 * person's memory would.
 *
 * `style-learning-hook.ts` built this profile after every chat and
 * `formatStyleForPrompt` had no caller, so every assertion here was false
 * before this suite existed. Each "reaches" case has a control that must NOT
 * carry it, so a builder that pasted the block in unconditionally fails.
 */

const HEADER = "## USER'S WRITING STYLE";

function profile(overrides: Partial<IWritingStyleProfile> = {}): IWritingStyleProfile {
  return {
    messagesAnalyzed: 40,
    isReady: true,
    lastAnalyzedAt: new Date('2026-09-01T00:00:00Z'),
    vocabularyLevel: 'intermediate',
    commonWords: ['basically', 'honestly'],
    commonPhrases: [],
    jargonTerms: [],
    avgSentenceLength: 9,
    sentenceComplexity: 'simple',
    avgMessageLength: 40,
    formality: 'informal',
    toneDescriptors: ['warm', 'direct'],
    usesEmoji: false,
    emojiFrequency: 'never',
    commonEmojis: [],
    usesExclamationMarks: false,
    usesEllipsis: false,
    capitalizationStyle: 'all_lowercase',
    greetingPatterns: ['hey'],
    closingPatterns: ['cheers'],
    signOff: '— nate',
    primaryLanguage: 'en',
    secondaryLanguages: [],
    codeSwitch: false,
    ...overrides,
  } as IWritingStyleProfile;
}

function memory(overrides: Partial<UserMemoryData> = {}): UserMemoryData {
  return {
    memories: [],
    preferences: {},
    context: {},
    settings: { recallEnabled: true },
    writingStyle: profile(),
    ...overrides,
  };
}

async function build(opts: {
  userMemory?: UserMemoryData | null;
  isDirectUserSession?: boolean;
  linkedAgent?: HydratedAgent | null;
}): Promise<string> {
  return SystemPromptBuilder.build({
    routingProfileId: 'route:auto',
    isDirectUserSession: opts.isDirectUserSession ?? true,
    userMemory: opts.userMemory,
    linkedAgent: opts.linkedAgent ?? null,
  });
}

function agentWithGrants(capabilityGrants: string[]): HydratedAgent {
  return {
    _id: 'agent-1',
    oxyAccountId: 'bot-1',
    name: 'Claudio',
    username: 'claudio',
    avatar: null,
    archetype: 'general',
    systemPrompt: 'You help with invoices.',
    capabilityGrants,
  } as unknown as HydratedAgent;
}

describe("the person's writing style in the system message", () => {
  it('reaches the prompt when the profile is ready', async () => {
    const prompt = await build({ userMemory: memory() });
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain('Writes mostly in lowercase');
    expect(prompt).toContain('"— nate"');
    // The footer that keeps it from restyling Alia's own answers comes with it.
    expect(prompt).toContain('Only apply this style when composing text that will be sent AS the user');
  });

  it('is appended as context, below the base prompt', async () => {
    const prompt = await build({ userMemory: memory() });
    expect(prompt.indexOf(HEADER)).toBeGreaterThan(prompt.indexOf('Today is'));
  });

  it('is absent when there is no profile yet', async () => {
    const prompt = await build({ userMemory: memory({ writingStyle: null }) });
    expect(prompt).not.toContain(HEADER);
  });

  it('is absent while the profile is still learning', async () => {
    const prompt = await build({ userMemory: memory({ writingStyle: profile({ isReady: false }) }) });
    expect(prompt).not.toContain(HEADER);
  });

  it('is absent when the person turned off "Use in AI responses"', async () => {
    const prompt = await build({ userMemory: memory({ settings: { recallEnabled: false } }) });
    expect(prompt).not.toContain(HEADER);
    expect(prompt).not.toContain('— nate');
  });

  it('is absent for a request that is not the person\'s own session', async () => {
    const prompt = await build({ userMemory: memory(), isDirectUserSession: false });
    expect(prompt).not.toContain(HEADER);
  });

  it('is absent for an agent without the memory grant, and present with it', async () => {
    const denied = await build({ userMemory: memory(), linkedAgent: agentWithGrants([]) });
    expect(denied).not.toContain(HEADER);

    const granted = await build({ userMemory: memory(), linkedAgent: agentWithGrants(['memory']) });
    expect(granted).toContain(HEADER);
  });
});

describe('formatStyleForPrompt budget', () => {
  it('never exceeds its ceiling, however long the edited fields are', () => {
    const huge = 'x'.repeat(5_000);
    const block = formatStyleForPrompt(profile({
      signOff: huge,
      llmSummary: huge,
      greetingPatterns: Array.from({ length: 50 }, () => huge),
      closingPatterns: Array.from({ length: 50 }, () => huge),
      toneDescriptors: Array.from({ length: 50 }, () => huge),
    }));
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThanOrEqual(STYLE_PROMPT_MAX_CHARS);
    expect(block.startsWith(HEADER)).toBe(true);
    // Trimming drops body lines, never the footer.
    expect(block).toContain('Only apply this style when composing text that will be sent AS the user');
  });

  it('keeps an ordinary profile whole', () => {
    const block = formatStyleForPrompt(profile({ llmSummary: 'Short, friendly, lowercase.' }));
    expect(block).toContain('**Style summary**: "Short, friendly, lowercase."');
    expect(block).toContain('- **Tone**: warm, direct');
  });
});
