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

vi.mock('../../chat-core.js', () => ({
  resolveModel: (...args: unknown[]) => resolveModel(...args),
  getDefaultAliaModel: () => 'alia-lite',
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
  const actual = await vi.importActual<typeof import('../../../internal/providers/lib/alia-models.js')>(
    '../../../internal/providers/lib/alia-models.js',
  );
  return {
    getTierMappings: async () => actual.TIER_MODEL_MAPPINGS,
    getAllAliaModels: async () => Object.values(actual.ALIA_MODELS),
  };
});

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: async () => undefined,
}));
vi.mock('../../../db/chat/conversationRepository.js', () => ({
  findConversationAgentById: async () => undefined,
}));
vi.mock('../../../db/agents/skillRepository.js', () => ({ findSkillPrompt: async () => undefined }));
vi.mock('../../../db/agents/agentRepository.js', () => ({ findAgentById: async () => null }));
vi.mock('../../user-credits-helpers.js', () => ({ getOrCreateUserCredits: async () => ({}) }));
vi.mock('../../credits-manager.js', () => ({
  reserveCredits: async () => null,
  refundReservation: async () => undefined,
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

interface Captured {
  status: number | null;
  body: { error?: { code?: string; message?: string; param?: string } } | null;
}

/** Drive the real function for one `model` value and capture what came back. */
async function run(model: string | undefined) {
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
  const sse = { sent: false, openEarly: vi.fn(), writeError: vi.fn() };
  const timer = setTimeout(() => undefined, 60_000);
  const req = {
    body: { messages: [{ role: 'user', content: 'hi' }], ...(model === undefined ? {} : { model }) },
  };
  const ctx = await buildChatRequestContext(
    req as never,
    res as never,
    sse as never,
    timer as never,
  );
  clearTimeout(timer);
  return { ctx, captured };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveModel.mockResolvedValue({
    aliasModelId: 'alia-v1-pro',
    provider: 'an-operator',
    modelId: 'a-deployment',
    keyConfig: { provider: 'an-operator', key: 'secret', modelId: 'a-deployment' },
    aliaModel: { name: 'x', creditMultiplier: 1 },
    isFallback: false,
  });
});

describe('a named model reaches the resolver as a pin, not as a tier', () => {
  it('routes on the profile’s alias and pins the identity beside it', async () => {
    const { ctx } = await run('anthropic/claude-sonnet-4.6');
    expect(ctx).not.toBeNull();

    // The alias is what everything downstream reads for price, plan and prompt.
    const [alias, , , options] = resolveModel.mock.calls[0];
    expect(alias).toBe('alia-v1-pro');
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

  it('does not pin anything when a PROFILE was named', async () => {
    // The control. Without it, a `pinnedModel` set unconditionally — to the
    // tier's default, say — would satisfy every assertion above.
    const { ctx } = await run('profile:v1');
    const [alias, , , options] = resolveModel.mock.calls[0];
    expect(alias).toBe('alia-v1');
    expect(options).toEqual({});
    expect(ctx?.routingOptions).toEqual({});
  });

  it('does not pin anything for a legacy alias, which still resolves', async () => {
    const { ctx } = await run('alia-lite');
    expect(resolveModel.mock.calls[0][0]).toBe('alia-lite');
    expect(ctx?.routingOptions).toEqual({});
  });

  it('does not pin anything when the request names no model at all', async () => {
    const { ctx } = await run(undefined);
    expect(resolveModel.mock.calls[0][0]).toBe('alia-lite');
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
