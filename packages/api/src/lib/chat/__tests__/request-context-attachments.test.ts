/**
 * A turn's attachments are admitted BEFORE any credit is reserved (ADR 0020 §6,
 * `docs/agent-embedding.md` §5): the agent's gate is checked, the documents are
 * read as the person, each gated part is spent, and only then is a credit held.
 * A locked feature reserves nothing; a retried turn spends nothing new.
 *
 * This drives the real `buildChatRequestContext` and the real gate logic
 * (`lib/agent-features.ts`); what is replaced is the app on the other side of
 * the feature tools, Oxy Files, the turn's inputs and the credit ledger.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sequence = vi.hoisted(() => [] as string[]);
const app = vi.hoisted(() => ({
  available: true,
  consumed: true,
  keys: [] as string[],
}));
const turn = vi.hoisted(() => ({ agent: null as Record<string, unknown> | null }));

vi.mock('../../chat-core.js', () => ({
  resolveModel: async (id: string) =>
    id.includes('/')
      ? {
          provider: 'kaana',
          publisher: 'acme',
          model: id,
          modelId: id,
          keyConfig: { provider: 'kaana', modelId: id },
          oxyInferenceTarget: { kind: 'model', model: id },
          catalogue: {
            id,
            name: id,
            publisher: { id: 'acme', name: 'Acme' },
            reasoningEfforts: [],
            inputModalities: id === 'acme/reader-1' ? ['text', 'file'] : ['text'],
          },
          powerLevel: null,
        }
      : {
          // A power level (ADR 0014): Oxy picks the model.
          provider: 'kaana',
          publisher: 'oxy',
          model: id,
          modelId: id,
          keyConfig: { provider: 'kaana', modelId: id },
          oxyInferenceTarget: { kind: 'routingProfile', routingProfile: id },
          catalogue: null,
          powerLevel: id,
        },
  resolveDefaultModel: () => {
    throw new Error('every request here names its model');
  },
}));

vi.mock('../../tools/oxy-services.js', () => ({
  presentPersonAgentContext: (params: { personAccountId: string; accessToken: string }) => ({
    requesterAccountId: params.personAccountId,
    ownerAccountId: params.personAccountId,
    actor: { type: 'agent', accountId: 'sindi-bot' },
    userAccessToken: params.accessToken,
  }),
  findOxyAppFeature: async (_app: string, key: string) => ({
    feature: { key, description: 'Homiio+', checkTool: 'readFiles', consumeTool: 'spendFile' },
    toolsTakeNoInput: true,
  }),
  callOxyFeatureTool: async (_lane: unknown, _app: string, tool: string, key?: string) => {
    if (tool === 'readFiles') {
      sequence.push('check');
      return { status: 'answered', result: { available: app.available } };
    }
    sequence.push('consume');
    if (key !== undefined) app.keys.push(key);
    return { status: 'answered', result: { consumed: app.consumed } };
  },
}));

vi.mock('../../files/person-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../files/person-files.js')>();
  return {
    ...actual,
    resolveFileParts: async (refs: ReadonlyMap<string, unknown>, options: unknown) => {
      // The real one returns at once for no files, so only a read is recorded.
      if (refs.size === 0) return new Map();
      sequence.push('read-files');
      resolvedWith.push(options);
      return new Map([...refs.keys()].map((id) => [id, { type: 'text', text: `doc ${id}` }]));
    },
  };
});
const resolvedWith = vi.hoisted(() => [] as unknown[]);

vi.mock('../turn-inputs.js', () => ({
  EMPTY_SKILL_RUNTIME: { index: '', active: '', tools: {}, candidateIds: [] },
  prefetchTurnInputs: async () => ({
    userMemory: null,
    oxyUser: null,
    entitlements: null,
    turnAgent: turn.agent === null ? { kind: 'none' } : { kind: 'agent', agent: turn.agent },
  }),
  buildTurnSkills: async () => null,
  recallTurnMemories: async () => undefined,
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/integrations/mcpServerRepository.js', () => ({
  findMcpServerForUser: async () => null,
}));
vi.mock('../../user-credits-helpers.js', () => ({ getOrCreateUserCredits: async () => ({}) }));
vi.mock('../../credits-manager.js', () => ({
  reserveCredits: async () => {
    sequence.push('reserve');
    return { reservationId: 'reservation-1' };
  },
  refundReservation: async () => sequence.push('refund'),
  safeRefund: async () => undefined,
}));
vi.mock('../../credit-price-snapshot.js', () => ({ captureCreditPriceBook: async () => ({}) }));
vi.mock('../../product-credit-access', () => ({
  readConfiguredProductCreditSnapshot: async () => undefined,
}));
vi.mock('../../plan-access.js', () => ({ getUserEntitlements: async () => null }));
vi.mock('../../autonomy/runtime.js', () => ({ runAutonomyBeforeChat: async () => null }));
vi.mock('../../logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});

const { buildChatRequestContext } = await import('../request-context.js');

const SINDI = {
  _id: 'sindi',
  id: 'sindi',
  oxyAccountId: 'sindi-bot',
  ownerOxyAccountId: 'homiio-project',
  applicationId: null,
  featureGates: { 'attachments.documents': { app: 'homiio', feature: 'files' } },
};

const withLease = (id = 'm1') => ({
  id,
  role: 'user',
  content: [
    { type: 'text', text: 'Review my lease' },
    { type: 'file', file: { file_id: 'lease', filename: 'lease.pdf', mime: 'application/pdf' } },
  ],
});

async function run(body: Record<string, unknown>, options: { sseSent?: boolean } = {}) {
  const captured: { status: number | null; body: { error?: Record<string, unknown> } | null } = {
    status: null,
    body: null,
  };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: typeof captured.body) {
      captured.body = payload;
      return res;
    },
  };
  const sse = { sent: options.sseSent === true, openEarly: vi.fn(), writeError: vi.fn() };
  const timer = setTimeout(() => undefined, 60_000);
  const ctx = await buildChatRequestContext(
    {
      body: { model: 'acme/chat-1', ...body },
      user: { id: 'person-1' },
      accessToken: 'PERSON-TOKEN',
    } as never,
    res as never,
    sse as never,
    timer as never,
    'chatcmpl-1',
  );
  clearTimeout(timer);
  return { ctx, captured, sse };
}

beforeEach(() => {
  sequence.length = 0;
  resolvedWith.length = 0;
  app.available = true;
  app.consumed = true;
  app.keys.length = 0;
  turn.agent = SINDI;
});

describe('a gated attachment', () => {
  it('is checked, read and spent, in that order, before the credit is reserved', async () => {
    const { ctx, captured } = await run({ agentId: 'sindi', messages: [withLease()] });
    expect(captured.status).toBeNull();
    expect(sequence).toEqual(['check', 'read-files', 'consume', 'reserve']);
    expect(ctx?.files.get('lease')).toEqual({ type: 'text', text: 'doc lease' });
    expect(resolvedWith[0]).toMatchObject({
      personAccountId: 'person-1',
      accessToken: 'PERSON-TOKEN',
      modelAcceptsFiles: false,
    });
  });

  it('refuses a locked feature before anything is read, spent or reserved', async () => {
    app.available = false;
    const { ctx, captured } = await run({ agentId: 'sindi', messages: [withLease()] });
    expect(ctx).toBeNull();
    expect(sequence).toEqual(['check']);
    expect(captured.status).toBe(403);
    expect(captured.body?.error).toMatchObject({
      code: 'feature_entitlement_required',
      feature: 'attachments.documents',
      retryable: false,
    });
  });

  it('ends an open stream with the same error, still reserving nothing', async () => {
    app.consumed = false;
    const { ctx, sse } = await run(
      { agentId: 'sindi', messages: [withLease()], stream: true },
      { sseSent: true },
    );
    expect(ctx).toBeNull();
    expect(sequence).not.toContain('reserve');
    expect(sse.writeError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'feature_entitlement_required', retryable: false }),
    );
  });

  it('is spent once when the turn is retried, and once when it is later history', async () => {
    await run({ agentId: 'sindi', messages: [withLease()] });
    await run({ agentId: 'sindi', messages: [withLease()] });
    await run({
      agentId: 'sindi',
      messages: [
        withLease(),
        { id: 'a1', role: 'assistant', content: 'It looks fine.' },
        { id: 'm2', role: 'user', content: 'And the deposit?' },
      ],
    });
    expect(new Set(app.keys).size).toBe(1);
    expect(app.keys).toHaveLength(3);
  });
});

describe('an attachment nothing gates', () => {
  it('is read before the credit is reserved, and a model that takes files gets the file', async () => {
    turn.agent = null;
    const { captured } = await run({ model: 'acme/reader-1', messages: [withLease()] });
    expect(captured.status).toBeNull();
    expect(sequence).toEqual(['read-files', 'reserve']);
    expect(resolvedWith[0]).toMatchObject({ modelAcceptsFiles: true });
  });

  it('a malformed file part is a 400 before anything at all', async () => {
    const { ctx, captured } = await run({
      messages: [{ role: 'user', content: [{ type: 'file', file: { name: 'x' } }] }],
    });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error).toMatchObject({ code: 'invalid_file_part' });
    expect(sequence).toEqual([]);
  });

  it('a turn without attachments reserves exactly as before', async () => {
    const { captured } = await run({
      agentId: 'sindi',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captured.status).toBeNull();
    expect(sequence).toEqual(['reserve']);
  });
});

const CLARITY = {
  ...SINDI,
  _id: 'clarity',
  id: 'clarity',
  featureGates: {
    deep_research: { app: 'clarity', feature: 'research' },
    'power_level.pro': { app: 'clarity', feature: 'pro' },
  },
};
const ask = { id: 'm1', role: 'user', content: 'Compare these two papers' };

describe('a gated deep research or power level', () => {
  beforeEach(() => {
    turn.agent = CLARITY;
  });

  it('is checked and spent before the credit is reserved', async () => {
    const { captured } = await run({
      agentId: 'clarity',
      model: 'pro',
      deepResearch: true,
      messages: [ask],
    });
    expect(captured.status).toBeNull();
    expect(sequence).toEqual(['check', 'check', 'consume', 'consume', 'reserve']);
    expect(new Set(app.keys).size).toBe(2);
  });

  it('refuses a locked level with its feature key, reserving nothing', async () => {
    app.available = false;
    const { ctx, captured } = await run({ agentId: 'clarity', model: 'pro', messages: [ask] });
    expect(ctx).toBeNull();
    expect(sequence).toEqual(['check']);
    expect(captured.status).toBe(403);
    expect(captured.body?.error).toMatchObject({
      code: 'feature_entitlement_required',
      feature: 'power_level.pro',
      param: 'model',
      retryable: false,
    });
  });

  it('refuses locked deep research with its feature key', async () => {
    app.available = false;
    const { captured } = await run({
      agentId: 'clarity',
      model: 'auto',
      deepResearch: true,
      messages: [ask],
    });
    expect(captured.body?.error).toMatchObject({
      code: 'feature_entitlement_required',
      feature: 'deep_research',
    });
  });

  it('leaves the levels it does not gate alone', async () => {
    const { captured } = await run({ agentId: 'clarity', model: 'high', messages: [ask] });
    expect(captured.status).toBeNull();
    expect(sequence).toEqual(['reserve']);
  });

  it('refuses an exact hosted model on an agent that gates a level, which would walk around it', async () => {
    const { ctx, captured } = await run({
      agentId: 'clarity',
      model: 'acme/chat-1',
      messages: [ask],
    });
    expect(ctx).toBeNull();
    expect(captured.status).toBe(400);
    expect(captured.body?.error).toMatchObject({ code: 'power_level_required', param: 'model' });
    expect(sequence).toEqual([]);
  });

  it('carries the turn’s attachments on the context, for a consulted agent’s gates', async () => {
    turn.agent = null;
    const { ctx } = await run({ model: 'auto', messages: [withLease()] });
    expect(ctx?.featureUses.map((use) => use.feature)).toEqual(['attachments.documents']);
  });
});
