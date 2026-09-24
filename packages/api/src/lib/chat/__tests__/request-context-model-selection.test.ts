import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a request's `model` becomes, measured on the REAL boundary (ADR 0012).
 *
 * This drives `buildChatRequestContext` itself and reads what it handed to the
 * resolver: a `publisher/model` goes to `resolveModel`, an absent one to the
 * person's default, and an unknown one is a 400 `model_not_found` before any
 * credit is held. Only the surroundings a request needs — the database,
 * credits, the catalogue-backed resolver — are replaced.
 */

const resolveModel = vi.fn();
const resolveDefaultModel = vi.fn();
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

vi.mock('@oxy.so/core', async () => {
  const actual = await vi.importActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return {
    ...actual,
    OxyServices: class {
      setTokens(): void {}
      async getAccount(accountId: string): Promise<unknown> {
        if (oxy.mode === 'unreachable') throw new Error('ECONNREFUSED api.oxy.so');
        return {
          accountId,
          parentAccountId: 'owner-account-1',
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
  resolveDefaultModel: (...args: unknown[]) => resolveDefaultModel(...args),
}));

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
const { ModelNotFoundError } = await import('../../models/errors.js');

/** The one model the fake catalogue offers, and the person's default. */
const KNOWN = 'acme/chat-1';
const DEFAULT = 'acme/default-1';
function hosted(id: string) {
  return {
    provider: 'kaana',
    publisher: 'acme',
    model: id.slice(5),
    modelId: id,
    keyConfig: { provider: 'kaana', modelId: id },
    oxyInferenceTarget: { kind: 'model', model: id },
    catalogue: { id, name: id, publisher: { id: 'acme', name: 'Acme' }, reasoningEfforts: ['low', 'high'] },
  };
}
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
    agentId?: unknown;
    serviceApp?: {
      appId: string;
      scopes: string[];
    };
    delegatedScopes?: string[];
    /** A present requester Oxy's introspection already consumed (ADR 0025). */
    oxyRequester?: { userId: string; agentId: string; applicationId: string; credentialId: string };
    accessToken?: string;
    /** A streaming request: headers are already out, so a refusal is an SSE event. */
    sseSent?: boolean;
    /** Any other body fields. */
    body?: Record<string, unknown>;
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
      ...(options.body ?? {}),
    },
    ...(options.directUserId === undefined ? {} : { user: { id: options.directUserId } }),
    ...(options.serviceApp === undefined
      ? {}
      : {
          serviceApp: {
            ...options.serviceApp,
            appName: 'product',
            credentialId: 'credential-1',
            ownerAccountId: 'product-cost-centre',
            environment: 'production',
          },
        }),
    ...(options.delegatedScopes === undefined || options.directUserId === undefined
      ? {}
      : { serviceActingAs: { userId: options.directUserId, scopes: options.delegatedScopes } }),
    ...(options.oxyRequester === undefined
      ? {}
      : { oxyRequester: { ...options.oxyRequester, jti: 'jti-1', expiresAt: '2026-09-17T12:02:00.000Z' } }),
    accessToken: options.accessToken ?? 'token-1',
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
  resolveModel.mockImplementation(async (id: string) => {
    if (id !== KNOWN) throw new ModelNotFoundError(id);
    return hosted(id);
  });
  resolveDefaultModel.mockResolvedValue(hosted(DEFAULT));
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

    const { ctx, captured } = await run(undefined, { directUserId: 'user-1', agentId: 'agent-2' });

    expect(findAgentById).toHaveBeenCalledWith(expect.anything(), 'agent-2');
    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
    expect(captured.body?.error).toMatchObject({
      code: 'agent_unavailable',
      param: 'agentId',
      message: 'The selected agent is unavailable.',
    });
    expect(refundReservation).toHaveBeenCalledWith({ reservationId: 'reservation-1' });
  });

  it('refuses an id that does not resolve with the same neutral error', async () => {
    findAgentById.mockResolvedValue(null);

    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1', agentId: 'agent-does-not-exist',
    });

    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
    expect(captured.body?.error).toMatchObject({
      code: 'agent_unavailable',
      param: 'agentId',
      message: 'The selected agent is unavailable.',
    });
    expect(refundReservation).toHaveBeenCalledTimes(1);
  });

  it('refuses a repository failure instead of converting it to no agent', async () => {
    findAgentById.mockRejectedValue(new Error('database unavailable'));

    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1', agentId: 'agent-1',
    });

    expect(ctx).toBeNull();
    expect(captured.status).toBe(503);
    expect(captured.body?.error).toMatchObject({
      code: 'AGENT_RESOLUTION_UNAVAILABLE',
      param: 'agentId',
    });
    expect(refundReservation).toHaveBeenCalledTimes(1);
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

describe('agentId is an exact fail-closed selector', () => {
  it('rejects malformed ids before lookup or credit reservation', async () => {
    for (const agentId of ['', '   ', ' agent-1', 'agent-1 ', 42, null]) {
      const { ctx, captured } = await run(undefined, { directUserId: 'user-1', agentId });
      expect(ctx).toBeNull();
      expect(captured.status).toBe(400);
      expect(captured.body?.error).toMatchObject({ code: 'invalid_agent_id', param: 'agentId' });
    }
    expect(findAgentById).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  it('accepts an app-bound agent only through the exact delegated product credential', async () => {
    findAgentById.mockResolvedValue({
      ...privateAgent,
      access: 'public',
      applicationId: 'homiio-app-id',
    });

    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'agent-2',
      serviceApp: { appId: 'homiio-app-id', scopes: ['inference:invoke'] },
      delegatedScopes: ['inference:invoke'],
      accessToken: 'verified-homiio-service-token',
    });

    expect(captured.status).toBeNull();
    expect(ctx?.linkedAgent?._id).toBe('agent-2');
    expect(ctx?.inferenceServiceToken).toBe('verified-homiio-service-token');
  });

  it('does not let the agent id select Alia as payer when product inference scope is absent', async () => {
    findAgentById.mockResolvedValue({
      ...privateAgent,
      access: 'public',
      applicationId: 'homiio-app-id',
    });

    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'agent-2',
      serviceApp: { appId: 'homiio-app-id', scopes: ['user:read'] },
      delegatedScopes: ['user:read'],
      accessToken: 'verified-homiio-service-token',
    });

    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
    expect(captured.body?.error).toMatchObject({ code: 'agent_unavailable', param: 'agentId' });
  });

  it('does not let a human bearer invoke a public app-bound agent by known id', async () => {
    findAgentById.mockResolvedValue({
      ...privateAgent,
      access: 'public',
      applicationId: 'homiio-app-id',
    });

    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'agent-2',
    });

    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
    expect(captured.body?.error).toMatchObject({ code: 'agent_unavailable', param: 'agentId' });
  });
});

/**
 * A present requester (ADR 0025 in OxyHQServices): Homiio's service token plus a
 * requester assertion Oxy consumed live. No acting-as grant exists, and none is
 * needed — but the assertion admits ONE agent, bound to the presenting product,
 * and nothing else Alia can do for that person.
 */
describe('a present requester reaches exactly the native agent it was admitted for', () => {
  const sindi = {
    ...privateAgent,
    _id: 'sindi-agent',
    access: 'private',
    applicationId: 'homiio-app-id',
  };
  const requester = {
    userId: 'user-1',
    agentId: 'sindi-agent',
    applicationId: 'homiio-app-id',
    credentialId: 'credential-1',
  };
  const product = { appId: 'homiio-app-id', scopes: ['inference:invoke', 'acting-as:offline'] };

  it('admits the named product agent with no delegation grant, billed to the product token', async () => {
    findAgentById.mockResolvedValue(sindi);
    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'sindi-agent',
      serviceApp: product,
      oxyRequester: requester,
      accessToken: 'verified-homiio-service-token',
    });
    expect(captured.status).toBeNull();
    expect(ctx?.linkedAgent?._id).toBe('sindi-agent');
    expect(ctx?.inferenceServiceToken).toBe('verified-homiio-service-token');
    expect(ctx?.isDirectUserSession).toBe(false);
  });

  it('refuses a turn that names no agent, so the entry cannot become plain Alia with the person\'s memory', async () => {
    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      serviceApp: product,
      oxyRequester: requester,
    });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
    expect(captured.body?.error).toMatchObject({ code: 'agent_unavailable' });
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  it('refuses any other agent, including a public one', async () => {
    findAgentById.mockResolvedValue({ ...privateAgent, _id: 'agent-2', access: 'public', applicationId: null });
    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'agent-2',
      serviceApp: product,
      oxyRequester: requester,
    });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
    expect(findAgentById).not.toHaveBeenCalled();
  });

  it('refuses a requester context that does not match the verified service token', async () => {
    for (const mismatch of [
      { ...requester, applicationId: 'other-app' },
      { ...requester, credentialId: 'other-credential' },
      { ...requester, userId: 'someone-else' },
    ]) {
      const { ctx, captured } = await run(undefined, {
        directUserId: 'user-1',
        agentId: 'sindi-agent',
        serviceApp: product,
        oxyRequester: mismatch,
      });
      expect(ctx).toBeNull();
      expect(captured.status).toBe(404);
    }
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  it('refuses when the agent is bound to a different product application', async () => {
    findAgentById.mockResolvedValue({ ...sindi, applicationId: 'clarity-app-id' });
    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'sindi-agent',
      serviceApp: product,
      oxyRequester: requester,
    });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
  });

  it('refuses when the product credential cannot pay for inference', async () => {
    findAgentById.mockResolvedValue(sindi);
    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'sindi-agent',
      serviceApp: { appId: 'homiio-app-id', scopes: ['user:read'] },
      oxyRequester: requester,
    });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
    expect(ctx?.inferenceServiceToken).toBeUndefined();
  });

  it('still refuses offline delegation without a grant — the consent lane is unchanged', async () => {
    findAgentById.mockResolvedValue(sindi);
    const { ctx, captured } = await run(undefined, {
      directUserId: 'user-1',
      agentId: 'sindi-agent',
      serviceApp: product,
    });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(404);
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
 * "Oxy could not be asked" remains retryable and distinct from the neutral
 * unavailable result, but both stop before any model can substitute Alia.
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

  it('rejects malformed ids and never permits a service caller to select a user connector', async () => {
    const malformed = await run(undefined, { mcpServerId: 42, directUserId: 'user-1' });
    expect(malformed.ctx).toBeNull();
    expect(malformed.captured.body?.error?.code).toBe('invalid_mcp_server_id');

    const service = await run(undefined, {
      mcpServerId: 'server-1',
      directUserId: 'user-1',
      serviceApp: { appId: 'homiio-app-id', scopes: ['inference:invoke'] },
      delegatedScopes: ['inference:invoke'],
    });
    expect(service.ctx).toBeNull();
    expect(service.captured.body?.error?.code).toBe('mcp_server_unavailable');
    expect(findMcpServerForUser).not.toHaveBeenCalled();
  });
});

describe('a hosted turn runs on a real catalogue model', () => {
  it('resolves a named publisher/model exactly', async () => {
    const { ctx } = await run(KNOWN, { directUserId: 'user-1' });
    expect(resolveModel).toHaveBeenCalledWith(KNOWN);
    expect(resolveDefaultModel).not.toHaveBeenCalled();
    expect(ctx?.modelId).toBe(KNOWN);
    expect(ctx?.requestedModel).toBe(KNOWN);
    expect(ctx?.surface).toBe('chat');
  });

  it('runs the person\'s default when the request names no model', async () => {
    const { ctx } = await run(undefined, { directUserId: 'user-1' });
    expect(resolveDefaultModel).toHaveBeenCalledWith('user-1');
    expect(resolveModel).not.toHaveBeenCalled();
    expect(ctx?.modelId).toBe(DEFAULT);
    // What the caller asked for is recorded as the default it resolved to.
    expect(ctx?.requestedModel).toBe(DEFAULT);
  });

  it('refuses an unknown model as 400 model_not_found, before any credit is held', async () => {
    const { ctx, captured } = await run('nobody/no-such-model', { directUserId: 'user-1' });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error).toMatchObject({ code: 'model_not_found', param: 'model' });
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  it('refuses a model that is not a string', async () => {
    const { ctx, captured } = await run(undefined, { body: { model: 42 } });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.param).toBe('model');
  });

  it('takes deep research only from body.deepResearch', async () => {
    expect((await run(KNOWN)).ctx?.deepResearch).toBeUndefined();
    expect((await run(KNOWN, { body: { deepResearch: true } })).ctx?.deepResearch).toBe(true);
  });

  it('reads the prompt surface from body.surface and refuses an unknown one', async () => {
    expect((await run(KNOWN, { body: { surface: 'codea' } })).ctx?.surface).toBe('codea');
    const refused = await run(KNOWN, { body: { surface: 'nope' } });
    expect(refused.ctx).toBeNull();
    expect(refused.captured.body?.error?.param).toBe('surface');
  });
});

describe('reasoningEffort is validated against the model', () => {
  it('accepts a level the model declares', async () => {
    const { ctx } = await run(KNOWN, { body: { reasoningEffort: 'high' } });
    expect(ctx?.reasoningEffort).toBe('high');
  });

  it('is null when the request asks for none', async () => {
    expect((await run(KNOWN)).ctx?.reasoningEffort).toBeNull();
  });

  it.each(['medium', 'max', 'instant', 7])('refuses %p, which the model does not declare', async (level) => {
    const { ctx, captured } = await run(KNOWN, { body: { reasoningEffort: level } });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error).toMatchObject({ code: 'invalid_reasoning_effort', param: 'reasoningEffort' });
  });

  it('ignores the retired thinkingMode flag', async () => {
    expect((await run(KNOWN, { body: { thinkingMode: true } })).ctx?.reasoningEffort).toBeNull();
  });
});

describe('fallbackPolicy is refused, because this API cannot carry it', () => {
  /**
   * The public Oxy inference request has no fallback, substitution or route
   * field, and the contract's `authorizedRoutes` is Oxy's own envelope to
   * Kaana (ADR 0017) — resolved from the application's routing policy, never
   * set by a caller. `request-context.ts` used to accept the parameter and hand
   * it to a resolver that ignored it: a silent no-op behind an accepted field.
   */
  async function send(body: Record<string, unknown>, sseSent = false) {
    const captured: Captured = { status: null, body: null };
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(value: Captured['body']) {
        captured.body = value;
        return res;
      },
    };
    const sse = { sent: sseSent, openEarly: vi.fn(), writeError: vi.fn() };
    const timer = setTimeout(() => undefined, 60_000);
    const ctx = await buildChatRequestContext(
      { body: { messages: [{ role: 'user', content: 'hi' }], model: KNOWN, ...body } } as never,
      res as never,
      sse as never,
      timer as never,
    );
    clearTimeout(timer);
    return { ctx, captured, sse };
  }

  it('answers 400 invalid_request naming the parameter, before any resolution', async () => {
    const { ctx, captured } = await send({ fallbackPolicy: 'no-fallback' });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'invalid_request',
      param: 'fallbackPolicy',
    });
    expect(captured.body?.error?.message).toContain('decided by Oxy');
    // Nothing was resolved and nothing was reserved: the refusal is upstream of both.
    expect(resolveModel).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  it('refuses a VALID-looking value too: the parameter, not its spelling, is what is wrong', async () => {
    // The discriminator against the old behaviour, which accepted the three
    // preset names and refused only a mistyped one.
    for (const value of ['cross-model', 'same-model-only', 'no-fallback']) {
      vi.clearAllMocks();
      const { captured } = await send({ fallbackPolicy: value });
      expect(captured.status, value).toBe(400);
      expect(captured.body?.error?.code, value).toBe('invalid_request');
      expect(resolveModel, value).not.toHaveBeenCalled();
    }
  });

  it('refuses the wire spelling GET /catalogue documents, fallback_policy', async () => {
    const { captured } = await send({ fallback_policy: 'cross-model' });
    expect(captured.status).toBe(400);
    expect(captured.body?.error).toMatchObject({ code: 'invalid_request', param: 'fallback_policy' });
  });

  it('writes the refusal as an SSE error once headers are out', async () => {
    const { ctx, captured, sse } = await send({ fallbackPolicy: 'no-fallback' }, true);
    expect(ctx).toBeNull();
    expect(captured.status).toBeNull();
    expect(sse.writeError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_request', param: 'fallbackPolicy' }),
    );
  });

  it('still admits a request that names no policy — the control', async () => {
    const { ctx, captured } = await send({});
    expect(captured.status).toBeNull();
    expect(ctx).not.toBeNull();
    expect(resolveModel).toHaveBeenCalled();
  });
});

describe('a refusal names the thing the caller got wrong', () => {
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
