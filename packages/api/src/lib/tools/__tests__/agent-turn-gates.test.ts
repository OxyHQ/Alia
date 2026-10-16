/**
 * The nested turn of `consultAgent` applies the CONSULTED agent's feature gates
 * to the outer turn's attachments (ADR 0020 §6), on the person's own lane,
 * before anything is reserved: a refusal reserves nothing and never runs the
 * callee, an entitled person's consultation spends and runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  sequence: [] as string[],
  check: null as Record<string, unknown> | null,
  spend: null as Record<string, unknown> | null,
  people: [] as unknown[],
}));

vi.mock('../../agent-features.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-features.js')>();
  return {
    ...actual,
    checkGatedParts: async (_agent: unknown, person: unknown) => {
      H.sequence.push('check');
      H.people.push(person);
      return H.check;
    },
    spendGatedParts: async () => {
      H.sequence.push('spend');
      return H.spend;
    },
  };
});
vi.mock('../../chat-core.js', () => ({
  resolveStoredModel: async () => ({ modelId: 'acme/chat-1', catalogue: null }),
  getAIModel: () => ({}),
}));
vi.mock('../../tool-pipeline.js', () => ({
  ToolPipeline: {
    forUser: async () => ({
      tools: {},
      routing: {},
      appCatalogPrompt: '',
      toolNameMapping: new Map(),
    }),
  },
}));
vi.mock('../../product-credit-access', () => ({
  reserveBackgroundProductCredits: async () => {
    H.sequence.push('reserve');
    return null;
  },
}));
vi.mock('../../credits-manager.js', () => ({
  finalizeCredits: async () => ({ creditsCharged: 0 }),
  refundReservation: async () => undefined,
}));
vi.mock('../../agent/soul.js', () => ({ evolveAgentSoul: async () => undefined }));
vi.mock('../../agent/archetype-prompts.js', () => ({ agentRemitPrompt: () => 'remit' }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child, credits: child } };
});

const { runAgentTurn } = await import('../agent-turn.js');

const SINDI = {
  _id: 'sindi',
  oxyAccountId: 'sindi-bot',
  ownerOxyAccountId: 'homiio',
  name: 'Sindi',
  featureGates: { 'attachments.documents': { app: 'homiio', feature: 'files' } },
} as unknown as Parameters<typeof runAgentTurn>[0]['agent'];

const person = { oxyUserId: 'person-1', accessToken: 'PERSON-TOKEN', isDirectSession: true };
const lease = { feature: 'attachments.documents' as const, operationKey: 'LEASE' };
const photo = { feature: 'attachments.images' as const, operationKey: 'PHOTO' };

beforeEach(() => {
  H.sequence.length = 0;
  H.people.length = 0;
  H.check = null;
  H.spend = null;
});

const run = (attachments: readonly (typeof lease | typeof photo)[]) =>
  runAgentTurn({
    agent: SINDI,
    task: 'Is this lease fair?',
    person,
    payerOxyUserId: 'person-1',
    attachments,
  });

describe("a consultation under the callee's gates", () => {
  it('checks then spends what the callee gates, on the person’s lane, before reserving', async () => {
    await run([lease, photo]);
    expect(H.sequence).toEqual(['check', 'spend', 'reserve']);
    expect(H.people[0]).toMatchObject({ accountId: 'person-1', accessToken: 'PERSON-TOKEN' });
  });

  it('refuses a locked attachment typed, reserving nothing and never running the callee', async () => {
    H.check = {
      code: 'feature_entitlement_required',
      feature: 'attachments.documents',
      retryable: false,
    };
    const result = await run([lease]);
    expect(H.sequence).toEqual(['check']);
    expect(result.refusal).toEqual(H.check);
    expect(result.error).toContain('upgrade');
  });

  it('asks nothing when the callee gates none of what the turn carries', async () => {
    await run([photo]);
    expect(H.sequence).toEqual(['reserve']);
  });
});
