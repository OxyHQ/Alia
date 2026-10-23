import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});

const H = vi.hoisted(() => ({
  forUser: vi.fn(),
  buildMeasured: vi.fn(async (options: Record<string, unknown>) => ({
    text: `PROMPT responseMode=${String(options.responseMode)} ask=${String(options.askUserQuestion)}`,
    memoryChars: 0,
    skillsChars: 0,
  })),
  oxyTools: vi.fn(async () => ({
    oxy_inbox__search: {
      description: 'Search the owner’s inbox',
      inputSchema: {},
      execute: async () => [],
    },
  })),
}));

vi.mock('../../chat/turn-inputs.js', () => ({
  EMPTY_SKILL_RUNTIME: {
    index: '',
    active: '',
    tools: {},
    agentScoped: false,
    candidateIds: [],
    activated: () => [],
  },
  buildTurnSkills: vi.fn(async () => null),
  recallTurnMemories: vi.fn(async () => [{ title: 'Likes', summary: 'tea' }]),
}));
vi.mock('../../tool-pipeline.js', () => ({ ToolPipeline: { forUser: H.forUser } }));
vi.mock('../../system-prompt-builder.js', () => ({
  SystemPromptBuilder: { buildMeasured: H.buildMeasured },
}));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn() }));
vi.mock('../../tools/oxy-services.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tools/oxy-services.js')>()),
  buildOxyServiceTools: H.oxyTools,
}));

const { buildVoiceTurn } = await import('../turn.js');

/**
 * What a call speaks with is a typed turn's: the voice prompt layer, the
 * actor's memory and the tool pipeline with the person on the socket as the
 * requester — so an agent's owner data reaches a call only when its owner is
 * the one talking (ADR 0015; ADR 0017 Enforcement).
 */

function input(overrides: Partial<Parameters<typeof buildVoiceTurn>[0]> = {}) {
  return {
    oxyUserId: 'stranger',
    accessToken: () => 'token',
    conversationId: 'conv-1',
    requestId: 'vc_1',
    linkedAgent: null,
    surfaceApplicationId: null,
    userMemory: null,
    oxyUser: null,
    language: 'es',
    history: [],
    ...overrides,
  };
}

describe('the call’s tools', () => {
  it('are the pipeline’s, with the person on the socket as the requester, the agent as the actor', async () => {
    H.forUser.mockResolvedValueOnce({
      tools: {},
      toolNameMapping: new Map(),
      routing: {},
      appCatalogPrompt: '',
      activeToolNames: () => [],
    });
    const agent = { _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: 'owner-1' } as never;
    await buildVoiceTurn(input({ linkedAgent: agent }));
    const options = H.forUser.mock.calls[0]![0];
    expect(options).toMatchObject({
      userId: 'stranger',
      requesterAccountId: 'stranger',
      agent,
      isDirectSession: true,
      actsForPerson: true,
      toolsEnabled: true,
    });
    // No SSE surface in a call: the question card and plan preview are not built.
    expect(options.sseEmitter).toBeUndefined();
    // Nothing in a call files an action for the person's OK (ADR 0020 §3).
    expect(options).not.toHaveProperty('oxyApprovals');
  });

  it('an agent reaches the owner’s apps only for the owner, and anybody else’s own apps for them', async () => {
    const actual =
      await vi.importActual<typeof import('../../tool-pipeline.js')>('../../tool-pipeline.js');
    const agent = {
      _id: 'agent-1',
      oxyAccountId: 'bot-1',
      ownerOxyAccountId: 'owner-1',
      capabilityGrants: [],
      primaryTools: [],
    } as never;
    const oxyToolsOf = async (oxyUserId: string) => {
      H.forUser.mockImplementationOnce((options) =>
        actual.ToolPipeline.forUser({ ...options, instancedSources: ['oxy_service'] }),
      );
      const turn = await buildVoiceTurn(input({ oxyUserId, linkedAgent: agent }));
      return Object.keys(turn.tools).filter((name) => name.startsWith('oxy_'));
    };
    // The control: the owner on the socket gets them, so the stranger's empty list means something.
    expect(await oxyToolsOf('owner-1')).toEqual(['oxy_inbox__search']);
    expect(H.oxyTools).toHaveBeenLastCalledWith(
      'owner-1',
      expect.objectContaining({
        requesterAccountId: 'owner-1',
        agentIdentity: expect.objectContaining({ forUser: 'owner' }),
      }),
    );
    H.oxyTools.mockClear();
    // Somebody else on the call reaches their OWN apps with their verified context (ADR 0022).
    await oxyToolsOf('stranger');
    expect(H.oxyTools).toHaveBeenCalledWith(
      'stranger',
      expect.objectContaining({
        requesterAccountId: 'stranger',
        ownerAccountId: 'stranger',
        agentIdentity: { forUser: 'requester', self: false },
      }),
    );
  });

  it('speak with the voice prompt layer and no question card', async () => {
    H.forUser.mockResolvedValueOnce({
      tools: {},
      toolNameMapping: new Map(),
      routing: {},
      appCatalogPrompt: '',
      activeToolNames: () => [],
    });
    const turn = await buildVoiceTurn(input());
    const text = await turn.instructions([{ role: 'user', content: 'hola' }]);
    expect(text).toContain('PROMPT responseMode=voice ask=false');
    expect(text).toContain('Person: hola');
    expect(H.buildMeasured).toHaveBeenLastCalledWith(
      expect.objectContaining({ recalledMemories: [{ title: 'Likes', summary: 'tea' }] }),
    );
  });
});
