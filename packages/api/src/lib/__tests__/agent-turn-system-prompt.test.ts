/**
 * ONE assistant per turn: the composed system message names the agent and
 * nobody else, and it carries the agent's remit.
 *
 * ## The bug this freezes
 *
 * An owner made an agent called Claudio and described it as a plant assistant.
 * Asked to write code, Claudio wrote code; asked its name, Claudio said Alia.
 * Both symptoms came from the same defect, and neither was in the agent's own
 * prompt: the COMPOSED message carried three claims about who was answering —
 * the identity guard at the top saying Claudio, `prompts/alia-v1.md` saying
 * "You are Alia, a sharp and personable AI assistant", `prompts/base.md` saying
 * "Always identify as Alia" — and no statement of scope anywhere at all. The
 * longest, most concrete claim won, which was never the guard's.
 *
 * So the assertions here are about the WHOLE message rather than about any
 * layer. A unit test of `buildIdentityGuard` passed throughout: the guard was
 * always right, and was always overruled three sections later.
 *
 * ## It EXTRACTS the claims rather than grepping for known wording
 *
 * `expect(msg).not.toContain('You are Alia')` would go green the moment a
 * prompt file is reworded, which is precisely when it needs to be red. So every
 * "You are <Name>" sentence in the composed message is pulled out and the SET
 * of names is compared with the one name that is allowed. A new layer claiming
 * a new name fails without anybody having predicted its wording.
 *
 * {@link identityClaimsIn} is given a positive control below — an extractor
 * that silently matched nothing would pass every assertion on this page.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HydratedAgent } from '../agent-identity.js';

vi.mock('../gateway-client.js', () => ({
  getAliaModel: vi.fn(async () => ({ name: 'Alia V1' })),
}));
vi.mock('../tools/oxy-services.js', () => ({
  getOxyServicePromptFragment: vi.fn(async () => ''),
  getOxyServiceContext: vi.fn(async () => ''),
}));

const { SystemPromptBuilder } = await import('../system-prompt-builder.js');
const { clearPromptCache } = await import('../prompt-loader.js');

/**
 * Every sentence in a composed message that tells the model what it is called.
 *
 * `You ARE an AI` is deliberately not one — capital ARE, and the guard says it
 * about both Alia and an agent. Nor is "You are currently using…", "You are in
 * a real-time voice conversation" or "You are not a general-purpose assistant":
 * a claim continues with a proper noun, which is what the `[A-Z]` requires.
 */
function identityClaimsIn(message: string): string[] {
  return [...message.matchAll(/\bYou are \**([A-Z][A-Za-z0-9 ]*?)\**[,.]/g)].map((m) => m[1]);
}

/** The exact sentences that used to sit below the guard, before they were removed. */
const HISTORICAL_RIVAL_CLAIMS = [
  'You are Alia, a sharp and personable AI assistant. Witty, direct, and genuinely useful.',
  'You are **Alia**, an AI assistant built by the Alia AI team.',
  'You are currently using the **Alia V1** model. When asked what model you use, say you are using Alia V1.',
  'You are Alia Lite, optimized for speed and efficiency.',
];

const claudio = {
  _id: 'agent-1',
  id: 'agent-1',
  oxyAccountId: 'oxy-account-1',
  name: 'Claudio',
  handle: 'claudiobot',
  color: null,
  authorName: null,
  tagline: 'Your plant care companion',
  description: 'Watering schedules, light, soil, pests and plant disease diagnosis.',
  systemPrompt: 'You help people look after their plants: watering, light, soil, pests, and diagnosing plant diseases.',
  archetype: 'general',
  archetypeConfig: null,
} as unknown as HydratedAgent;

/** The default shape of an agent made through `POST /agents` without a prompt. */
const undescribedClaudio = { ...claudio, systemPrompt: null } as HydratedAgent;

const turn = { aliasModelId: 'alia-v1', isDirectUserSession: true } as const;

// `loadPrompt` memoizes per process, and these tests read the real files.
beforeEach(() => clearPromptCache());

describe('the extractor', () => {
  /**
   * Vacuity floor, and the only reason the negative assertions below mean
   * anything: a regex that matched nothing would report "no rival claims" over
   * a message full of them.
   */
  it('finds the claims that used to contradict the guard', () => {
    expect(identityClaimsIn(HISTORICAL_RIVAL_CLAIMS.join('\n\n'))).toEqual(['Alia', 'Alia', 'Alia Lite']);
  });

  it('does not mistake the guard\'s other sentences for a name', () => {
    const notClaims = [
      'You ARE an AI: never claim to be human.',
      'You are not a general-purpose assistant.',
      'You are in a real-time voice conversation.',
      'You are processing a triggered task, unattended.',
    ].join('\n');
    expect(identityClaimsIn(notClaims)).toEqual([]);
  });
});

describe('a turn that belongs to an agent', () => {
  it('names the agent, and names nobody else', async () => {
    const message = await SystemPromptBuilder.build({ ...turn, linkedAgent: claudio });

    // The name is there…
    expect(message).toContain('You are Claudio,');
    // …and it is the ONLY name the message gives. This is the assertion that
    // was red before the prompt files stopped claiming one.
    expect([...new Set(identityClaimsIn(message))]).toEqual(['Claudio']);
  });

  it('carries the remit rule, pointing at the description below it', async () => {
    const message = await SystemPromptBuilder.build({ ...turn, linkedAgent: claudio });

    expect(message).toContain('## YOUR REMIT');
    expect(message).toContain('Everything below describes what Claudio is for');
    // The rule is worth nothing without something for it to point at.
    expect(message).toContain(claudio.systemPrompt);
    // And it must say what to DO with a request outside the remit, or it is a
    // statement of fact the model can note and then ignore.
    expect(message).toContain('A request outside it');
  });

  it('describes an agent whose owner never wrote a prompt', async () => {
    // `archetype` defaults to `general`, for which `buildArchetypeSystemPrompt`
    // returns null — so this agent used to reach the model as a bare name with
    // no description of itself anywhere in the message. The reported "responde
    // de todo", in its purest form.
    const message = await SystemPromptBuilder.build({ ...turn, linkedAgent: undescribedClaudio });

    expect(message).toContain('# AGENT: Claudio');
    expect(message).toContain(undescribedClaudio.tagline);
    expect(message).toContain(undescribedClaudio.description);
    expect([...new Set(identityClaimsIn(message))]).toEqual(['Claudio']);
  });

  it('keeps the route secret, which giving an agent a name does not relax', async () => {
    const message = await SystemPromptBuilder.build({ ...turn, linkedAgent: claudio });

    expect(message).toContain('NON-NEGOTIABLE');
    expect(message).toContain('never claim to be human');
    for (const provider of ['Google', 'OpenAI', 'Anthropic', 'Groq', 'xAI']) {
      expect(message).toContain(provider);
    }
  });
});

describe('a turn that belongs to nobody — the control', () => {
  /**
   * Ordinary Alia is general-purpose ON PURPOSE. If the remit rule appeared
   * here too, the tests above would pass while every Alia conversation started
   * refusing things, and the difference between the two cases is the whole
   * feature.
   */
  it('has no remit rule at all', async () => {
    const message = await SystemPromptBuilder.build(turn);

    expect(message).not.toContain('## YOUR REMIT');
    expect(message).not.toContain('is not a general-purpose assistant');
    expect(message).not.toContain('# AGENT:');
  });

  it('still says who it is, and says the model', async () => {
    const message = await SystemPromptBuilder.build(turn);

    expect(message).toContain('You are Alia V1,');
    expect([...new Set(identityClaimsIn(message))]).toEqual(['Alia V1']);
  });
});
