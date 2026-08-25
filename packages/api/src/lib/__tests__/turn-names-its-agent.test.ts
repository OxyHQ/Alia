/**
 * A turn that NAMES an agent is a different turn.
 *
 * ## The bug this is shaped to catch
 *
 * The agent behind a chat turn used to be inferred:
 * `findConversationAgentById(conversationId)` addressed the conversations
 * table's PRIMARY KEY while `conversationId` is the client's BUSINESS key, a
 * `randomUUID()` minted by `POST /conversations/new`. It could never match. The
 * Mongoose original threw a `CastError` that both call sites caught and turned
 * into `null`, so the failure had no symptom at all: the agent-escalation
 * branch, the archetype prompt and the agent's own identity were dead for the
 * entire life of the feature and nothing anywhere went red.
 *
 * What would have caught it on the day it was written is exactly this: assert
 * that a turn WITH an agent produces a different prompt from one without. That
 * assertion fails the moment the resolution stops resolving, whatever the
 * reason — a wrong key, a swallowed throw, a renamed field, an option that
 * stopped being passed through.
 *
 * ## Why the PROMPT and not the resolver
 *
 * A test of the resolver alone measures the lookup. This measures the
 * CONSEQUENCE, which is the thing anybody would notice was missing: the agent's
 * own instructions in the composition, and its own name in the identity guard.
 * A resolver that works while nothing threads its answer through is precisely
 * the state this repository was already in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, agents: child, chat: child, v1: child, providers: child } };
});
vi.mock('../gateway-client.js', () => ({ getAliaModel: vi.fn(async () => ({ name: 'Alia V1' })) }));
vi.mock('../tools/oxy-services.js', () => ({
  getOxyServicePromptFragment: vi.fn(async () => ''),
  getOxyServiceContext: vi.fn(async () => ''),
}));
vi.mock('../prompt-loader.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'BASE ALIA PROMPT'),
  loadPrompt: vi.fn(async () => ''),
}));
vi.mock('../autonomy/runtime.js', () => ({ buildAutonomyPromptFragment: vi.fn(() => '') }));

const { SystemPromptBuilder } = await import('../system-prompt-builder.js');
const { agentPromptName } = await import('../agent-identity.js');

/** A hydrated agent with its own prompt, in the shape the builder reads. */
function agent(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'agent-1',
    id: 'agent-1',
    oxyAccountId: 'oxy-bot-1',
    name: 'Pepe',
    handle: 'pepe',
    avatar: null,
    authorName: null,
    tagline: 't',
    description: 'd',
    author: 'owner',
    category: 'research',
    tags: [],
    rating: 0,
    reviewCount: 0,
    usageCount: 0,
    hireCount: 0,
    price: null,
    capabilities: [],
    isFeatured: false,
    isTrending: false,
    isPublished: true,
    status: 'active',
    allowHiring: false,
    handlesAutonomousEvents: false,
    systemPrompt: 'YOU ARE A SPECIALIST IN BOTANY.',
    preferredImage: null,
    allowedModels: [],
    scheduleInterval: null,
    archetype: 'general',
    archetypeConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const BASE = {
  aliasModelId: 'alia-v1',
  isDirectUserSession: true,
  userId: 'user-1',
} as const;

let build: (linkedAgent: ReturnType<typeof agent> | null) => Promise<string>;

beforeEach(() => {
  vi.clearAllMocks();
  build = (linkedAgent) =>
    SystemPromptBuilder.build({ ...BASE, linkedAgent } as Parameters<typeof SystemPromptBuilder.build>[0]);
});

describe('naming an agent changes the turn', () => {
  it('produces a DIFFERENT prompt from a turn that named none', async () => {
    const withAgent = await build(agent());
    const without = await build(null);

    // The floor: both really are prompts, so "different" is not "one is empty".
    expect(without.length).toBeGreaterThan(50);
    expect(withAgent.length).toBeGreaterThan(without.length);
    expect(withAgent).not.toEqual(without);
  });

  it('carries the agent’s own instructions', async () => {
    const withAgent = await build(agent());
    const without = await build(null);

    expect(withAgent).toContain('YOU ARE A SPECIALIST IN BOTANY.');
    // The negative half: without it, `toContain` above would pass against a
    // base prompt that happened to mention botany.
    expect(without).not.toContain('YOU ARE A SPECIALIST IN BOTANY.');
  });

  it('gives the agent its OWN name in the identity guard, not the model’s', async () => {
    const withAgent = await build(agent());
    const without = await build(null);

    expect(withAgent).toContain('You are Pepe,');
    expect(without).toContain('You are Alia V1,');
    // The regression the guard rewrite fixed: an agent told to call itself Alia.
    expect(withAgent).not.toContain('You are Alia V1,');
  });

  it('keeps the provider secrecy on both, which is what stays scoped', async () => {
    for (const prompt of [await build(agent()), await build(null)]) {
      expect(prompt).toContain('NON-NEGOTIABLE');
      expect(prompt).toContain('OpenAI');
      expect(prompt).toContain('Anthropic');
    }
  });

  it('names the agent by the SAME rule the rest of the runtime uses', async () => {
    // Not a second copy of the fallback. An agent whose Oxy account could not
    // be resolved has `name: null`, and the prompt must still say something —
    // `agentPromptName` is the one place that decides what.
    const unresolved = agent({ name: null, handle: null });
    const prompt = await build(unresolved);

    expect(agentPromptName(unresolved)).toBe('Agent');
    expect(prompt).toContain('You are Agent,');
    expect(prompt).not.toContain('You are null,');
  });
});
