import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a request's `model` becomes, measured on the REAL boundary
 * (ADR 0003 invariants 1 and 2).
 *
 * `lib/routing/model-selection.ts` decides which models a person may name and
 * which profile each is served under; `internal/providers/lib/fallback-engine.ts`
 * narrows the candidate list once it is told. Both are tested on their own. The
 * thing neither can see is whether the request path CONNECTS them — a pin that
 * is computed and then not passed on is green in both suites and answers from
 * the profile's default in production.
 *
 * So this drives `buildChatRequestContext` itself and reads what it handed to
 * the resolver. The model-selection module is the real one, over the real
 * routing table; only the surroundings a request needs — the database, credits,
 * the resolver — are replaced.
 */

const resolveModel = vi.fn();
const findAgentById = vi.fn();
const findMcpServerForUser = vi.fn();
const reserveCredits = vi.fn();
const refundReservation = vi.fn();

/**
 * What Oxy says when asked whether this caller may act as a bot account.
 *
 * `'denies'` is a VERDICT and `'unreachable'` is the absence of one, and until
 * this file could set them separately it could not tell them apart — every
 * private-agent case here ran with an unconfigured client, which is the
 * `unreachable` branch wearing the `denies` label. See the tests below.
 */
const oxy = vi.hoisted(() => ({ mode: 'denies' as 'grants' | 'denies' | 'unreachable' }));

vi.mock('@oxyhq/core', async () => {
  const actual = await vi.importActual<typeof import('@oxyhq/core')>('@oxyhq/core');
  return {
    ...actual,
    OxyServices: class {
      setTokens(): void {}
      async getAccount(accountId: string): Promise<unknown> {
        if (oxy.mode === 'unreachable') throw new Error('ECONNREFUSED api.oxy.so');
        return {
          accountId,
          kind: 'bot',
          relationship: oxy.mode === 'grants' ? 'owner' : 'none',
          account: { id: accountId, kind: 'bot' },
          callerMembership: oxy.mode === 'grants'
            ? { status: 'active', role: 'owner', permissions: ['account:act_as'] }
            : null,
        };
      }
    },
  };
});

vi.mock('../../chat-core.js', () => ({
  resolveModel: (...args: unknown[]) => resolveModel(...args),
  getDefaultRoutingProfile: () => 'kaana-lite',
}));

/**
 * The seam the selection reads, backed by the REAL tables.
 *
 * Replacing it with fixtures would make this file measure a routing table
 * nobody ships, and the identifiers below — `anthropic/claude-sonnet-4.6`,
 * `openai/gpt-5.2-pro` — are only interesting because of what the shipped
 * prices say about them.
 */
vi.mock('../../gateway-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../../internal/providers/lib/routing-profile-catalogue.js')>(
    '../../../internal/providers/lib/routing-profile-catalogue.js',
  );
  return {
    getTierMappings: async () => actual.TIER_MODEL_MAPPINGS,
    getAllRoutingProfiles: async () => Object.values(actual.KAANA_ROUTING_PROFILES),
  };
});

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: async () => undefined,
}));
vi.mock('../../../db/chat/conversationRepository.js', () => ({
}));
vi.mock('../../../db/agents/skillRepository.js', () => ({ findSkillPrompt: async () => undefined }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: (...args: unknown[]) => findAgentById(...args),
  // The turn's skill runtime asks which skills the agent carries; an agent with
  // none is the case every fixture here is about.
  findAgentSkills: async () => [],
}));
vi.mock('../../agent-identity.js', () => ({
  attachAgentIdentity: async (agent: Record<string, unknown>) => ({
    ...agent, name: 'Pepe', handle: 'pepe', avatar: null, authorName: null,
  }),
}));
vi.mock('../../../db/integrations/mcpServerRepository.js', () => ({
  findMcpServerForUser: (...args: unknown[]) => findMcpServerForUser(...args),
}));
vi.mock('../../user-credits-helpers.js', () => ({ getOrCreateUserCredits: async () => ({}) }));
vi.mock('../../credits-manager.js', () => ({
  reserveCredits: (...args: unknown[]) => reserveCredits(...args),
  // A SPY, not a stub. Every branch here that rejects a request after credits
  // were held has to give the credit back, and a stub cannot say whether it did.
  refundReservation: (...args: unknown[]) => refundReservation(...args),
  safeRefund: async () => undefined,
}));
vi.mock('../../plan-access.js', () => ({ getUserEntitlements: async () => null }));
vi.mock('../../../middleware/auth.js', () => ({ oxyClient: { getUserById: async () => null } }));
vi.mock('../../hooks/index.js', () => ({ runBeforeChatHooks: async () => null }));
vi.mock('../../autonomy/runtime.js', () => ({ runAutonomyBeforeChat: async () => null }));
vi.mock('../../logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});

const { buildChatRequestContext } = await import('../request-context.js');
const { clearAgentAccountVerdicts } = await import('../../agent-account.js');

interface Captured {
  status: number | null;
  body: { error?: { code?: string; message?: string; param?: string } } | null;
}

/** Drive the real function for one `model` value and capture what came back. */
async function run(
  model: string | undefined,
  options: {
    mcpServerId?: unknown;
    directUserId?: string;
    apiKey?: boolean;
    agentId?: string;
    /** A streaming request: headers are already out, so a refusal is an SSE event. */
    sseSent?: boolean;
  } = {},
) {
  const captured: Captured = { status: null, body: null };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Captured['body']) {
      captured.body = body;
      return res;
    },
  };
  const sse = { sent: options.sseSent === true, openEarly: vi.fn(), writeError: vi.fn() };
  const timer = setTimeout(() => undefined, 60_000);
  const req = {
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      ...(model === undefined ? {} : { model }),
      ...('mcpServerId' in options ? { mcpServerId: options.mcpServerId } : {}),
    },
    ...(options.directUserId === undefined ? {} : { user: { id: options.directUserId } }),
    ...(options.apiKey ? { apiKey: { id: 'key-1' } } : {}),
    accessToken: 'token-1',
  };
  if (options.agentId !== undefined) {
    (req.body as Record<string, unknown>).agentId = options.agentId;
  }
  const ctx = await buildChatRequestContext(
    req as never,
    res as never,
    sse as never,
    timer as never,
  );
  clearTimeout(timer);
  return { ctx, captured, sse };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveModel.mockResolvedValue({
    routingProfileId: 'kaana-v1-pro',
    provider: 'an-operator',
    modelId: 'a-deployment',
    keyConfig: { provider: 'an-operator', key: 'secret', modelId: 'a-deployment' },
    routingProfile: { name: 'x', creditMultiplier: 1 },
    isFallback: false,
  });
  findMcpServerForUser.mockResolvedValue(null);
  reserveCredits.mockResolvedValue({ reservationId: 'reservation-1' });
  findAgentById.mockResolvedValue(null);
  oxy.mode = 'denies';
  clearAgentAccountVerdicts();
});

/**
 * The ENTRYPOINT half of "a turn names its agent".
 *
 * `lib/__tests__/turn-names-its-agent.test.ts` asserts that a prompt built WITH
 * an agent differs from one built without — but it hands the agent in directly,
 * so it stays green while nothing resolves one. Measured: disabling the
 * `body.agentId` read entirely left that file passing, which is the same shape
 * as the bug being replaced (a resolver that resolved nothing, with no symptom).
 *
 * So this drives the real `buildChatRequestContext` and reads what it put on
 * the context. It is the assertion that would have failed on the day
 * `findConversationAgentById` was pointed at the primary key.
 */
/** Private and published: listed, but only its owner may use it. */
const privateAgent = {
  _id: 'agent-2',
  oxyAccountId: 'oxy-bot-2',
  isPublished: true,
  access: 'private',
  status: 'active',
  systemPrompt: 'p',
};

describe('the turn resolves the agent it NAMED', () => {
  it('reads body.agentId and puts the agent on the context', async () => {
    findAgentById.mockResolvedValue({
      _id: 'agent-1',
      oxyAccountId: 'oxy-bot-1',
      isPublished: true,
      // PUBLIC, which is what makes it reachable — being listed is a separate
      // question and stopped granting use.
      access: 'public',
      status: 'active',
      systemPrompt: 'p',
    });

    const { ctx } = await run(undefined, { directUserId: 'user-1', agentId: 'agent-1' });

    expect(findAgentById).toHaveBeenCalledWith(expect.anything(), 'agent-1');
    expect(ctx?.linkedAgent?._id).toBe('agent-1');
    // Identity is attached on the way through, so the prompt can name it.
    expect(ctx?.linkedAgent?.name).toBe('Pepe');
  });

  it('resolves NOTHING when the turn named no agent', async () => {
    // The negative control. Without it the assertion above passes against a
    // context that attaches an agent to every turn.
    const { ctx } = await run(undefined, { directUserId: 'user-1' });

    expect(findAgentById).not.toHaveBeenCalled();
    expect(ctx?.linkedAgent).toBeNull();
  });

  it('refuses a PRIVATE agent Oxy says the caller has no standing in', async () => {
    /**
     * `body.agentId` is client input, and a private agent is reachable only
     * through ownership or a membership on its bot account. Published,
     * deliberately: being listed is not being usable.
     *
     * This case used to run with an UNCONFIGURED Oxy client and call the result
     * a denial — which is the `identity_unavailable` branch wearing the wrong
     * label, so the test agreed with the bug instead of testing it. Oxy answers
     * here, and answers no.
     */
    oxy.mode = 'denies';
    findAgentById.mockResolvedValue(privateAgent);

    const { ctx } = await run(undefined, { directUserId: 'user-1', agentId: 'agent-2' });

    expect(findAgentById).toHaveBeenCalledWith(expect.anything(), 'agent-2');
    expect(ctx?.linkedAgent).toBeNull();
    // A valid turn, answered by ordinary Alia. Decided and documented — a
    // deleted agent, an unshared one, a stale id in an old client.
    expect(ctx).not.toBeNull();
    expect(refundReservation).not.toHaveBeenCalled();
  });

  it('grants a PRIVATE agent when Oxy says the caller may act as it — the control', async () => {
    // Without this, "the turn ran as ordinary Alia" would be true of a fixture
    // that can never grant anything, which is what the case above used to be.
    oxy.mode = 'grants';
    findAgentById.mockResolvedValue(privateAgent);

    const { ctx } = await run(undefined, { directUserId: 'user-1', agentId: 'agent-2' });

    expect(ctx?.linkedAgent?._id).toBe('agent-2');
  });
});

/**
 * An identity failure is REFUSED, never answered by somebody else.
 *
 * The second, independent cause of the symptom `#453` fixed. The client keeps
 * rendering the agent's name and colour around the reply — `[username].tsx`
 * draws the header from the thread, not from the turn — so substituting Alia
 * tells the person they are talking to Claudio while Alia answers.
 *
 * It was INTERMITTENT, which is what made it nearly unreportable. A positive
 * verdict is cached five minutes and separately per ECS task, so the collapse
 * only bit on the first turn after that expired. A person lives it as "sometimes
 * it forgets who it is".
 *
 * Only "Oxy could not be asked". An agent genuinely out of reach still runs as
 * ordinary Alia — the case above — and that is deliberately a different
 * question.
 */
describe('a turn naming an agent Oxy could not be asked about', () => {
  it('answers the refusal instead of substituting Alia', async () => {
    oxy.mode = 'unreachable';
    findAgentById.mockResolvedValue(privateAgent);

    const { ctx, captured } = await run(undefined, { directUserId: 'user-1', agentId: 'agent-2' });

    expect(ctx).toBeNull();
    expect(captured.status).toBe(502);
    expect(captured.body?.error?.code).toBe('IDENTITY_UNAVAILABLE');
    expect(captured.body?.error?.param).toBe('agentId');
  });

  it('gives the credit back', async () => {
    // The reservation DEBITS on the way in, so an exit that neither charges nor
    // refunds silently costs the person a credit. It is the first thing that
    // breaks on a new early-return branch.
    oxy.mode = 'unreachable';
    findAgentById.mockResolvedValue(privateAgent);

    await run(undefined, { directUserId: 'user-1', agentId: 'agent-2' });

    expect(refundReservation).toHaveBeenCalledTimes(1);
    expect(refundReservation).toHaveBeenCalledWith({ reservationId: 'reservation-1' });
  });

  it('leaves a turn that named NO agent alone', async () => {
    // The blast-radius control: an Oxy outage must not refuse ordinary chat.
    oxy.mode = 'unreachable';

    const { ctx, captured } = await run(undefined, { directUserId: 'user-1' });

    expect(ctx).not.toBeNull();
    expect(captured.status).toBeNull();
    expect(refundReservation).not.toHaveBeenCalled();
  });

  it('writes the refusal as an SSE event once the stream has opened', async () => {
    // `sse.openEarly()` fires before any of this work, so on a streaming
    // request the status line is already gone. The refusal has to travel as an
    // error EVENT — the same shape every other gate here uses — or the client
    // waits out the timeout on a stream that will never produce a token.
    oxy.mode = 'unreachable';
    findAgentById.mockResolvedValue(privateAgent);

    const { ctx, captured, sse } = await run(undefined, {
      directUserId: 'user-1', agentId: 'agent-2', sseSent: true,
    });

    expect(ctx).toBeNull();
    expect(captured.status).toBeNull();
    expect(sse.writeError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'IDENTITY_UNAVAILABLE' }),
    );
    expect(refundReservation).toHaveBeenCalledTimes(1);
  });

  it('leaves a PUBLIC agent alone, because Oxy is never asked about one', async () => {
    // `canReachAgent` short-circuits on public-and-active before any round trip,
    // so an outage cannot touch these turns at all.
    oxy.mode = 'unreachable';
    findAgentById.mockResolvedValue({ ...privateAgent, _id: 'agent-1', access: 'public' });

    const { ctx, captured } = await run(undefined, { directUserId: 'user-1', agentId: 'agent-1' });

    expect(captured.status).toBeNull();
    expect(ctx?.linkedAgent?._id).toBe('agent-1');
  });
});

describe('one MCP connector can be selected for one direct-user turn', () => {
  it('keeps omission as the legacy all-connectors path and null as explicit none', async () => {
    const omitted = await run(undefined);
    const none = await run(undefined, { mcpServerId: null });

    expect(omitted.ctx?.mcpServerId).toBeUndefined();
    expect(none.ctx?.mcpServerId).toBeNull();
    expect(findMcpServerForUser).not.toHaveBeenCalled();
  });

  it('accepts only an owned, enabled, running hosted connector', async () => {
    findMcpServerForUser.mockResolvedValue({
      id: 'server-1',
      enabled: true,
      status: 'running',
      runtime: 'server',
    });

    const { ctx, captured } = await run(undefined, {
      mcpServerId: 'server-1',
      directUserId: 'user-1',
    });

    expect(captured.status).toBeNull();
    expect(ctx?.mcpServerId).toBe('server-1');
    expect(findMcpServerForUser).toHaveBeenCalledWith({}, 'server-1', 'user-1');
  });

  it('returns one neutral refusal for a missing, foreign, stopped, or local connector', async () => {
    for (const row of [
      null,
      { id: 'server-1', enabled: false, status: 'running', runtime: 'server' },
      { id: 'server-1', enabled: true, status: 'stopped', runtime: 'server' },
      { id: 'server-1', enabled: true, status: 'running', runtime: 'local' },
    ]) {
      findMcpServerForUser.mockResolvedValueOnce(row);
      const { ctx, captured } = await run(undefined, {
        mcpServerId: 'server-1',
        directUserId: 'user-1',
      });
      expect(ctx).toBeNull();
      expect(captured.status).toBe(400);
      expect(captured.body?.error).toMatchObject({
        code: 'mcp_server_unavailable',
        param: 'mcpServerId',
        message: 'The selected connector is unavailable.',
      });
    }
  });

  it('rejects malformed ids and never permits API keys to select a user connector', async () => {
    const malformed = await run(undefined, { mcpServerId: 42, directUserId: 'user-1' });
    expect(malformed.ctx).toBeNull();
    expect(malformed.captured.body?.error?.code).toBe('invalid_mcp_server_id');

    const apiKey = await run(undefined, {
      mcpServerId: 'server-1',
      directUserId: 'user-1',
      apiKey: true,
    });
    expect(apiKey.ctx).toBeNull();
    expect(apiKey.captured.body?.error?.code).toBe('mcp_server_unavailable');
    expect(findMcpServerForUser).not.toHaveBeenCalled();
  });
});

describe('a named model reaches the resolver as a pin, not as a tier', () => {
  it('routes on the profile’s alias and pins the identity beside it', async () => {
    const { ctx } = await run('anthropic/claude-sonnet-4.6');
    expect(ctx).not.toBeNull();

    // The alias is what everything downstream reads for price, plan and prompt.
    const [alias, , , options] = resolveModel.mock.calls[0];
    expect(alias).toBe('kaana-v1-pro');
    // …and the identity travels separately, so the tier is not asked to encode
    // which of its models may answer.
    expect(options).toEqual({ pinnedModel: { publisher: 'anthropic', model: 'claude-sonnet-4.6' } });

    // Carried on the context too, because the provider loop RE-resolves on a
    // retry: a retry that dropped the pin would answer from a different model
    // one attempt later.
    expect(ctx?.routingOptions).toEqual({
      pinnedModel: { publisher: 'anthropic', model: 'claude-sonnet-4.6' },
    });
  });

  it('does not pin anything when a canonical Kaana profile was named', async () => {
    // The control. Without it, a `pinnedModel` set unconditionally — to the
    // tier's default, say — would satisfy every assertion above.
    const { ctx } = await run('kaana-v1');
    const [alias, , , options] = resolveModel.mock.calls[0];
    expect(alias).toBe('kaana-v1');
    expect(options).toEqual({});
    expect(ctx?.routingOptions).toEqual({});
  });

  it('does not pin anything for another canonical Kaana profile', async () => {
    const { ctx } = await run('kaana-lite');
    expect(resolveModel.mock.calls[0][0]).toBe('kaana-lite');
    expect(ctx?.routingOptions).toEqual({});
  });

  it('does not pin anything when the request names no model at all', async () => {
    const { ctx } = await run(undefined);
    expect(resolveModel.mock.calls[0][0]).toBe('kaana-lite');
    expect(ctx?.routingOptions).toEqual({});
  });

  it('keeps an explicit fallback policy beside the pin', async () => {
    // Both travel on one options object, and neither may erase the other: the
    // caller's policy is their decision and the pin is the model they named.
    const captured: Captured = { status: null, body: null };
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(body: Captured['body']) {
        captured.body = body;
        return res;
      },
    };
    const timer = setTimeout(() => undefined, 60_000);
    const ctx = await buildChatRequestContext(
      {
        body: {
          messages: [{ role: 'user', content: 'hi' }],
          model: 'deepseek/deepseek-chat',
          fallbackPolicy: 'no-fallback',
        },
      } as never,
      res as never,
      { sent: false, openEarly: vi.fn(), writeError: vi.fn() } as never,
      timer as never,
    );
    clearTimeout(timer);
    expect(ctx?.routingOptions).toEqual({
      fallbackPolicy: 'no-fallback',
      pinnedModel: { publisher: 'deepseek', model: 'deepseek-chat' },
    });
  });
});

describe('a refusal names the thing the caller got wrong', () => {
  it('refuses a model no profile prices, as a MODEL', async () => {
    /**
     * `openai/gpt-5.2-pro` EXISTS in the routing table. It is refused because
     * it costs $168 per million output tokens against a profile whose own
     * default is $75, so no multiplier the product sells covers it — and the
     * refusal has to say so as a model, not send the caller to the profile
     * list.
     */
    const { ctx, captured } = await run('openai/gpt-5.2-pro');
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.code).toBe('unknown_model');
    expect(captured.body?.error?.message).toContain('openai/gpt-5.2-pro');
    // Nothing was resolved, so no credits and no upstream call.
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('refuses a profile nobody defines, as a PROFILE', async () => {
    const { ctx, captured } = await run('profile:nonsense');
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.code).toBe('unknown_routing_profile');
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it('redacts a credential a caller pasted into the model field', async () => {
    /**
     * The echo is the caller's own text, which is what makes the refusal
     * actionable — and a caller misconfiguring an OpenAI-compatible client can
     * paste a key into the wrong field. `redactUnsafeDetail` is what covers
     * that, and it is applied here for the same reason `UnregisteredModelError`
     * applies it: the absolute half of the sanitiser survives even where route
     * concealment is deliberately not run.
     */
    const key = `sk-proj-${'a1B2c3D4e5'.repeat(5)}`;
    const { captured } = await run(`${key}/some-model`);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.message).not.toContain(key);
    // The control: the message DOES echo an ordinary value, or this would pass
    // for a message that says nothing at all.
    const ordinary = await run('nobody/no-such-model');
    expect(ordinary.captured.body?.error?.message).toContain('nobody/no-such-model');
  });
});
