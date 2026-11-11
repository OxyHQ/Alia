/**
 * Two things the nested turn does for SPACES (ADR 0028):
 *
 *  - an agent that is in a space is told about it in its system prompt, here and not only in a chat with
 *    the person, because this is the prompt of every group-room turn and every `consultAgent`;
 *  - Alia can be the CALLEE (`agent: null`, `askAlia`), and then she only ANSWERS: her tool set is cut to
 *    read-only tools and her Oxy apps are held to `read_only`, so a question is never a way to borrow the
 *    powers she holds and the asking agent may not (sending messages, writing memory, connectors that act).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  streamed: null as null | { system: string; tools: Record<string, unknown> },
  /** Every `streamText` call, in order. */
  streams: [] as Array<{ tools?: unknown; messages: Array<{ role: string }> }>,
  /** The loop ends on tool results: its steps ran out before it wrote an answer. */
  owed: false,
  pipeline: null as null | Record<string, unknown>,
  tools: {} as Record<string, unknown>,
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    stepCountIs: () => () => false,
    streamText: (args: {
      system: string;
      tools: Record<string, unknown>;
      messages: Array<{ role: string }>;
    }) => {
      H.streamed = { system: args.system, tools: args.tools };
      H.streams.push(args);
      // The loop offers tools; the pass that answers what it owes does not.
      const isLoop = args.tools !== undefined;
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: isLoop && H.owed ? 'Let me look. ' : 'an answer' };
        })(),
        totalUsage: Promise.resolve({ totalTokens: 3, inputTokens: 1, outputTokens: 2 }),
        providerMetadata: Promise.resolve(undefined),
        steps: Promise.resolve([{ toolResults: isLoop && H.owed ? [{}] : [] }]),
        response: Promise.resolve({ messages: [{ role: 'tool' }] }),
      };
    },
  };
});
vi.mock('../../chat-core.js', () => ({
  resolveStoredModel: async () => ({ modelId: 'acme/chat-1', catalogue: null }),
  getAIModel: () => ({}),
}));
vi.mock('../../tool-pipeline.js', () => ({
  ToolPipeline: {
    forUser: async (options: Record<string, unknown>) => {
      H.pipeline = options;
      return { tools: H.tools, routing: {}, appCatalogPrompt: '', toolNameMapping: new Map() };
    },
  },
}));
vi.mock('../../product-credit-access', () => ({
  reserveBackgroundProductCredits: async () => ({ id: 'reservation' }),
}));
vi.mock('../../credits-manager.js', () => ({
  finalizeCredits: async () => ({ creditsCharged: 1 }),
  refundReservation: async () => undefined,
}));
vi.mock('../../external-agents/turn.js', () => ({
  isExternalAgent: async () => false,
  runExternalAgentTurn: async () => ({ response: '', tokensUsed: 0, creditsCharged: 0 }),
}));
vi.mock('../../agent/soul.js', () => ({ evolveAgentSoul: async () => undefined }));
vi.mock('../../agent/archetype-prompts.js', () => ({ agentRemitPrompt: () => 'REMIT' }));
vi.mock('../../agent/space-prompt.js', () => ({
  agentSpacePrompt: async (agent: { spaceId?: string | null }) =>
    agent.spaceId ? '\n\nSPACE SECTION' : '',
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, credits: child } };
});

const { aliaConsultTools, runAgentTurn } = await import('../agent-turn.js');

const person = {
  oxyUserId: 'person-1',
  accessToken: 'TOKEN',
  isDirectSession: true,
  surfaceApplicationId: null,
};
const member = (spaceId: string | null) =>
  ({
    _id: 'member-1',
    oxyAccountId: 'bot-1',
    ownerOxyAccountId: 'person-1',
    name: 'Nadia',
    modelId: null,
    spaceId,
    featureGates: {},
  }) as unknown as NonNullable<Parameters<typeof runAgentTurn>[0]['agent']>;

const ALL_TOOLS = {
  getCurrentDate: {},
  getWeather: {},
  webSearch: {},
  webScraper: {},
  loadTools: {},
  oxy_inbox__searchEmails: {},
  oxy_nilo_memories__recallMemories: {},
  sendTelegramMessage: {},
  sendWhatsAppMessage: {},
  memory: {},
  createAutomation: {},
  mcp_row_a__act: {},
  integration_row_a__act: {},
  delegate: {},
  run_computer_command: {},
};

beforeEach(() => {
  H.streamed = null;
  H.streams = [];
  H.owed = false;
  H.pipeline = null;
  H.tools = { ...ALL_TOOLS };
});

describe('aliaConsultTools', () => {
  it('keeps what only reads, and the person’s Oxy apps (held to read_only elsewhere)', () => {
    expect(Object.keys(aliaConsultTools(ALL_TOOLS as never)).sort()).toEqual([
      'getCurrentDate',
      'getWeather',
      'loadTools',
      'oxy_inbox__searchEmails',
      'oxy_nilo_memories__recallMemories',
      'webScraper',
      'webSearch',
    ]);
  });

  it('drops every tool that sends, writes, acts or runs code', () => {
    const kept = Object.keys(aliaConsultTools(ALL_TOOLS as never));
    for (const name of [
      'sendTelegramMessage',
      'sendWhatsAppMessage',
      'memory',
      'createAutomation',
      'mcp_row_a__act',
      'integration_row_a__act',
      'delegate',
      'run_computer_command',
    ]) {
      expect(kept).not.toContain(name);
    }
  });
});

describe('a turn whose callee is Alia', () => {
  it('runs her read-only: Oxy apps at read_only, connectors that act not even fetched', async () => {
    const result = await runAgentTurn({
      agent: null,
      task: 'What does the person usually eat?',
      person,
      payerOxyUserId: 'person-1',
    });

    expect(result.error).toBeUndefined();
    expect(result.response).toBe('an answer');
    expect(H.pipeline).toMatchObject({
      agent: null,
      nested: true,
      actsForPerson: true,
      oxyAutonomy: 'read_only',
      instancedSources: ['oxy_service'],
    });
  });

  it('gives her the answering prompt and no agent identity, and only the read-only tools', async () => {
    await runAgentTurn({ agent: null, task: 'q', person, payerOxyUserId: 'person-1' });

    expect(H.streamed?.system).toContain('is asking you something');
    expect(H.streamed?.system).not.toContain('REMIT');
    expect(Object.keys(H.streamed?.tools ?? {})).not.toContain('sendTelegramMessage');
    expect(Object.keys(H.streamed?.tools ?? {})).toContain('oxy_inbox__searchEmails');
  });
});

describe('a turn whose steps ran out on tool results', () => {
  it('writes the answer it owes in one tools-disabled pass, and bills both', async () => {
    H.owed = true;

    const result = await runAgentTurn({
      agent: null,
      task: 'q',
      person,
      payerOxyUserId: 'person-1',
    });

    expect(H.streams).toHaveLength(2);
    expect(H.streams[1]?.tools).toBeUndefined();
    expect(H.streams[1]?.messages.at(-1)?.role).toBe('user');
    expect(result.response).toBe('Let me look. an answer');
    expect(result.tokensUsed).toBe(6);
  });

  it('adds no pass when the loop answered', async () => {
    await runAgentTurn({ agent: null, task: 'q', person, payerOxyUserId: 'person-1' });

    expect(H.streams).toHaveLength(1);
  });
});

describe('a turn whose callee is an agent in a space', () => {
  it('tells it about its space after its remit, and leaves its tools to the assembler', async () => {
    await runAgentTurn({ agent: member('space-1'), task: 'q', person, payerOxyUserId: 'person-1' });

    const system = H.streamed?.system ?? '';
    expect(system.indexOf('REMIT')).toBeGreaterThan(-1);
    expect(system.indexOf('SPACE SECTION')).toBeGreaterThan(system.indexOf('REMIT'));
    expect(H.pipeline).not.toHaveProperty('oxyAutonomy');
    expect(Object.keys(H.streamed?.tools ?? {})).toContain('sendTelegramMessage');
  });

  it('says nothing of a space to an agent that is in none', async () => {
    await runAgentTurn({ agent: member(null), task: 'q', person, payerOxyUserId: 'person-1' });

    expect(H.streamed?.system).toContain('REMIT');
    expect(H.streamed?.system).not.toContain('SPACE SECTION');
  });
});
