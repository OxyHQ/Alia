import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/index.js';
import { userCredits } from '../../db/schema/billing.js';
import {
  creditOperations,
  creditOperationRequests,
  creditPriceBooks,
  creditPriceBookModels,
} from '../../db/schema/credit-operations.js';
import { getOrCreateUserCredits, findUserCredits } from '../../db/billing/userCreditsRepository.js';
import { kaanaLanguageModel } from '../inference/kaana-language-model.js';
import { createCreditPriceBook } from '../credit-price-snapshot.js';
import {
  reserveCredits,
  finalizeCredits,
  refundReservation,
  restoreCreditReservation,
  restoreCreditReservationForRequest,
  recordCreditInferenceRequest,
  type CreditReservation,
} from '../credits-manager.js';

const inference = vi.hoisted(() => ({
  events: [] as Record<string, unknown>[],
  calls: 0,
  pauseAfterStart: null as Promise<void> | null,
}));
vi.mock('../inference/oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({
    respond: async () => ({
      requestId: `cpb-generated-${++inference.calls}`,
      model: 'acme/m@revision',
      output: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
      finishReason: 'stop',
      usage: [],
    }),
    stream: (_request: unknown, options: { signal: AbortSignal }) =>
      (async function* () {
        for (const event of inference.events) {
          yield event;
          if (event.type === 'start' && inference.pauseAfterStart !== null) {
            await inference.pauseAfterStart;
            if (options.signal.aborted) throw new DOMException('fixture cancellation', 'AbortError');
          }
        }
      })(),
  }),
}));
const catalogue = vi.hoisted(() => ({ input: '3', output: '15', reads: 0 }));
vi.mock('../models/catalogue.js', () => ({
  findCatalogueModel: async () => {
    catalogue.reads++;
    return { pricing: { inputPerMTok: catalogue.input, outputPerMTok: catalogue.output } };
  },
  listCatalogueModels: async () => [],
}));
beforeAll(() => {
  if (connectPostgres(process.env.DATABASE_URL) === null) throw new Error('Fixture database missing');
});
afterAll(closePostgres);
const usage = {
  promptTokens: 11000,
  completionTokens: 1000,
  totalTokens: 12000,
  systemPromptTokens: 1000,
  reasoningTokens: 200,
};
const book = () =>
  createCreditPriceBook([
    {
      id: 'acme/m',
      pricing: { inputPerMTok: '3', outputPerMTok: '15', priceVersionId: 'existing-price-v1' },
    },
    { id: 'acme/unpriced', pricing: null },
  ]);
async function admitted(name: string, balance = 100): Promise<CreditReservation> {
  const id = `cpb-${name}`;
  await getOrCreateUserCredits(getDb(), id);
  await getDb()
    .update(userCredits)
    .set({ creditsFree: balance, creditsPaid: 0 })
    .where(eq(userCredits.id, id));
  const reservation = await reserveCredits(id, 1, { priceBook: book(), requestedModel: 'auto' });
  if (reservation?.operationId === undefined) throw new Error('Missing operation');
  return reservation;
}
async function operation(reservation: CreditReservation) {
  const [row] = await getDb()
    .select()
    .from(creditOperations)
    .where(eq(creditOperations.id, reservation.operationId ?? ''));
  if (!row) throw new Error('Missing persisted operation');
  return row;
}
async function remaining(reservation: CreditReservation) {
  const row = await findUserCredits(getDb(), reservation.userId);
  if (!row) throw new Error('Missing balance');
  return row.creditsFree + row.creditsPaid;
}

describe('durable admission pricing and atomic turn settlement', () => {
  it('rolls back reservation and snapshot insertion when admission metadata insertion fails', async () => {
    const id = 'cpb-admission-rollback';
    await getOrCreateUserCredits(getDb(), id);
    await getDb().update(userCredits).set({ creditsFree: 100, creditsPaid: 0 }).where(eq(userCredits.id, id));
    const terms = createCreditPriceBook([
      { id: 'acme/admission-only', pricing: { inputPerMTok: '1.234', outputPerMTok: '9.876' } },
    ]);
    await getDb().execute(
      sql`CREATE FUNCTION cpb_fail_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = 'cpb-admission-rollback' THEN RAISE EXCEPTION 'injected admission failure'; END IF; RETURN NEW; END $$`,
    );
    await getDb().execute(
      sql`CREATE TRIGGER cpb_fail_admission BEFORE INSERT ON credit_operations FOR EACH ROW EXECUTE FUNCTION cpb_fail_admission()`,
    );
    try {
      await expect(reserveCredits(id, 1, { priceBook: terms, requestedModel: 'auto' })).rejects.toMatchObject(
        { cause: { message: 'injected admission failure' } },
      );
      expect((await findUserCredits(getDb(), id))?.creditsFree).toBe(100);
      expect(
        await getDb().select().from(creditOperations).where(eq(creditOperations.userId, id)),
      ).toHaveLength(0);
      expect(
        await getDb().select().from(creditPriceBooks).where(eq(creditPriceBooks.id, terms.id)),
      ).toHaveLength(0);
    } finally {
      await getDb().execute(sql`DROP TRIGGER cpb_fail_admission ON credit_operations`);
      await getDb().execute(sql`DROP FUNCTION cpb_fail_admission()`);
    }
  });
  it('correlates multiple actual adapter generate calls to one admission using only Oxy response IDs', async () => {
    const reservation = await admitted('multiple-responses');
    const model = kaanaLanguageModel({
      target: { kind: 'routingProfile', routingProfile: 'auto' },
      modelId: 'auto',
      surface: 'chat',
      onInferenceRequest: (request) => recordCreditInferenceRequest(reservation, request),
    });
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }];
    await model.doGenerate({ prompt } as never);
    await model.doGenerate({ prompt } as never);
    const links = await getDb()
      .select()
      .from(creditOperationRequests)
      .where(eq(creditOperationRequests.operationId, reservation.operationId ?? ''));
    expect(links).toHaveLength(2);
    expect(
      links.every(
        (link) => link.requestId.startsWith('cpb-generated-') && link.modelReference === 'acme/m@revision',
      ),
    ).toBe(true);
    await finalizeCredits(reservation, usage, 'acme/m');
    expect((await operation(reservation)).promptTokens).toBe(usage.promptTokens);
  });
  it('persists the real adapter start ID before an error/cancel and retains it through refund', async () => {
    const reservation = await admitted('stream-adapter');
    inference.events = [
      { type: 'start', requestId: 'cpb-real-stream-start', resolvedModelReference: 'acme/m@revision' },
      { type: 'delta', channel: 'text', text: 'partial' },
      {
        type: 'error',
        requestId: 'cpb-real-stream-start',
        error: { code: 'provider_timeout', message: 'fixture timeout', retryable: true },
      },
    ];
    const model = kaanaLanguageModel({
      target: { kind: 'routingProfile', routingProfile: 'auto' },
      modelId: 'auto',
      surface: 'chat',
      onInferenceRequest: (request) => recordCreditInferenceRequest(reservation, request),
    });
    const { stream } = await model.doStream({ prompt: [] } as never);
    const reader = stream.getReader();
    let errors = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.type === 'error') errors++;
    }
    expect(errors).toBe(1);
    await refundReservation(reservation);
    expect(
      await getDb()
        .select()
        .from(creditOperationRequests)
        .where(eq(creditOperationRequests.requestId, 'cpb-real-stream-start')),
    ).toHaveLength(1);
    expect(await remaining(reservation)).toBe(100);
  });
  it('locates recovery by a server Alia request id and does not admit/debit it twice', async () => {
    const first = await admitted('request-lookup');
    const other = await admitted('request-other');
    // A new server request with a persisted reference; legacy fixtures have no reference.
    const reservation = await reserveCredits(first.userId, 1, {
      priceBook: book(),
      requestedModel: 'auto',
      aliaRequestId: 'chatcmpl-server-fixture',
    });
    if (reservation === null) throw new Error('Missing referenced reservation');
    await expect(
      reserveCredits(first.userId, 1, {
        priceBook: book(),
        requestedModel: 'auto',
        aliaRequestId: 'chatcmpl-server-fixture',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await remaining(first)).toBe(98);
    const restored = await restoreCreditReservationForRequest(first.userId, 'chatcmpl-server-fixture');
    expect(restored.operationId).toBe(reservation.operationId);
    await expect(restoreCreditReservationForRequest(other.userId, 'chatcmpl-server-fixture')).rejects.toThrow(
      'not found',
    );
  });
  it('retains a persisted start link when the actual adapter stream is aborted before completion', async () => {
    const reservation = await admitted('abort-adapter');
    let release: () => void = () => undefined;
    inference.pauseAfterStart = new Promise<void>((resolve) => {
      release = resolve;
    });
    inference.events = [
      { type: 'start', requestId: 'cpb-aborted-start', resolvedModelReference: 'acme/m@revision' },
    ];
    const abort = new AbortController();
    const model = kaanaLanguageModel({
      target: { kind: 'routingProfile', routingProfile: 'auto' },
      modelId: 'auto',
      surface: 'chat',
      onInferenceRequest: (request) => recordCreditInferenceRequest(reservation, request),
    });
    try {
      const { stream } = await model.doStream({ prompt: [], abortSignal: abort.signal } as never);
      const reader = stream.getReader();
      expect((await reader.read()).value?.type).toBe('stream-start');
      expect((await reader.read()).value?.type).toBe('response-metadata');
      abort.abort();
      release();
      while (!(await reader.read()).done) {
        /* Drain the cancelled adapter. */
      }
      await refundReservation(reservation);
      await refundReservation(reservation);
      expect(await remaining(reservation)).toBe(100);
      expect(
        await getDb()
          .select()
          .from(creditOperationRequests)
          .where(eq(creditOperationRequests.requestId, 'cpb-aborted-start')),
      ).toHaveLength(1);
    } finally {
      release();
      inference.pauseAfterStart = null;
    }
  });
  it('pins Auto pricebook before the model is known; changed/removed catalogue cannot reprice it after restart', async () => {
    const reservation = await admitted('restart');
    const before = await operation(reservation);
    expect(before.status).toBe('admitted');
    expect(before.requestedModel).toBe('auto');
    expect(before.servedModelId).toBeNull();
    catalogue.input = '300';
    catalogue.output = '1500';
    catalogue.reads = 0;
    await closePostgres();
    connectPostgres(process.env.DATABASE_URL);
    const recovered = await restoreCreditReservation(reservation.userId, reservation.operationId ?? '');
    await recordCreditInferenceRequest(recovered, {
      requestId: 'cpb-oxy-parent-restart',
      modelReference: 'acme/m@revision',
    });
    expect(await finalizeCredits(recovered, usage, 'acme/m')).toEqual({
      creditsCharged: 45,
      creditsRemaining: 55,
    });
    expect(catalogue.reads).toBe(0);
    expect(await operation(recovered)).toMatchObject({
      bookId: before.bookId,
      status: 'settled',
      pricingRule: 'catalogue_price',
      creditsRequested: 45,
      creditsCharged: 45,
      servedModelId: 'acme/m',
    });
    const [link] = await getDb()
      .select()
      .from(creditOperationRequests)
      .where(eq(creditOperationRequests.requestId, 'cpb-oxy-parent-restart'));
    expect(link).toMatchObject({ operationId: reservation.operationId, modelReference: 'acme/m@revision' });
  });
  it('settles once under concurrent replay and refuses conflicting usage', async () => {
    const reservation = await admitted('race');
    const results = await Promise.all([
      finalizeCredits(reservation, usage, 'acme/m'),
      finalizeCredits(reservation, usage, 'acme/m'),
    ]);
    expect(results.map((r) => r.creditsCharged)).toEqual([45, 45]);
    expect(await remaining(reservation)).toBe(55);
    await expect(finalizeCredits(reservation, { ...usage, completionTokens: 2 }, 'acme/m')).rejects.toThrow(
      'Conflicting',
    );
    expect(await remaining(reservation)).toBe(55);
  });
  it('rolls back the balance when terminal metadata fails, then recovers exactly once', async () => {
    const reservation = await admitted('rollback');
    await getDb().execute(
      sql`CREATE FUNCTION cpb_fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = 'cpb-rollback' THEN RAISE EXCEPTION 'injected metadata failure'; END IF; RETURN NEW; END $$`,
    );
    await getDb().execute(
      sql`CREATE TRIGGER cpb_fail_terminal BEFORE UPDATE ON credit_operations FOR EACH ROW EXECUTE FUNCTION cpb_fail_terminal()`,
    );
    try {
      await expect(finalizeCredits(reservation, usage, 'acme/m')).rejects.toMatchObject({
        cause: { message: 'injected metadata failure' },
      });
      expect(await remaining(reservation)).toBe(99);
      expect((await operation(reservation)).status).toBe('admitted');
    } finally {
      await getDb().execute(sql`DROP TRIGGER cpb_fail_terminal ON credit_operations`);
      await getDb().execute(sql`DROP FUNCTION cpb_fail_terminal()`);
    }
    const recovered = await restoreCreditReservation(reservation.userId, reservation.operationId ?? '');
    await finalizeCredits(recovered, usage, 'acme/m');
    await finalizeCredits(recovered, usage, 'acme/m');
    expect(await remaining(reservation)).toBe(55);
  });
  it('preserves the existing base fallback for a later unknown/unpriced model without consulting a changed catalogue', async () => {
    for (const model of ['acme/unpriced', 'new/model']) {
      const reservation = await admitted(`fallback-${model.replace('/', '-')}`);
      const result = await finalizeCredits(reservation, usage, model);
      expect(result.creditsCharged).toBe(11);
      expect((await operation(reservation)).pricingRule).toBe('base_rate');
    }
  });
  it('retains Oxy correlation on streaming failure/cancel and refunds once, without reopening settlement', async () => {
    const reservation = await admitted('cancel');
    await recordCreditInferenceRequest(reservation, {
      requestId: 'cpb-oxy-cancel',
      modelReference: 'acme/m@revision',
    });
    await Promise.all([refundReservation(reservation), refundReservation(reservation)]);
    expect(await remaining(reservation)).toBe(100);
    expect((await operation(reservation)).status).toBe('refunded');
    expect(
      await getDb()
        .select()
        .from(creditOperationRequests)
        .where(eq(creditOperationRequests.requestId, 'cpb-oxy-cancel')),
    ).toHaveLength(1);
    await expect(finalizeCredits(reservation, usage, 'acme/m')).rejects.toThrow('refunded');
  });
  it('does not refund a settled operation, and distinguishes capped actual debit from the existing requested-charge response', async () => {
    const reservation = await admitted('capped', 10);
    expect((await finalizeCredits(reservation, usage, 'acme/m')).creditsCharged).toBe(45);
    expect(await operation(reservation)).toMatchObject({ creditsRequested: 45, creditsCharged: 10 });
    await refundReservation(reservation);
    expect(await remaining(reservation)).toBe(0);
  });
  it('does not allow account/operation or Oxy request correlations to be reassigned', async () => {
    const first = await admitted('binding-one');
    const other = await admitted('binding-two');
    await expect(restoreCreditReservation(other.userId, first.operationId ?? '')).rejects.toThrow(
      'not found',
    );
    await expect(finalizeCredits({ ...first, userId: other.userId }, usage, 'acme/m')).rejects.toThrow(
      'does not match',
    );
    await recordCreditInferenceRequest(first, { requestId: 'cpb-single-oxy', modelReference: null });
    await expect(
      recordCreditInferenceRequest(other, { requestId: 'cpb-single-oxy', modelReference: null }),
    ).rejects.toThrow('does not match');
  });
  it('rejects pricebook/entry mutation, late appended models, operation term changes and terminal overwrite in PostgreSQL', async () => {
    const reservation = await admitted('immutable');
    const id = reservation.priceBook?.id ?? '';
    await expect(
      getDb()
        .delete(creditOperations)
        .where(eq(creditOperations.id, reservation.operationId ?? '')),
    ).rejects.toMatchObject({ cause: { message: 'credit operation is retained' } });
    await expect(
      getDb().update(creditPriceBooks).set({ usdPerCredit: '0.01' }).where(eq(creditPriceBooks.id, id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('immutable') } });
    await expect(
      getDb()
        .update(creditPriceBookModels)
        .set({ inputPerMTok: '999' })
        .where(eq(creditPriceBookModels.bookId, id)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('immutable') } });
    await expect(
      getDb()
        .insert(creditPriceBookModels)
        .values({ bookId: id, modelId: 'injected/model', inputPerMTok: '1', outputPerMTok: '1' }),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('cannot extend') } });
    await expect(
      getDb()
        .update(creditOperations)
        .set({ requestedModel: 'high' })
        .where(eq(creditOperations.id, reservation.operationId ?? '')),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('immutable') } });
    await finalizeCredits(reservation, usage, 'acme/m');
    await expect(
      getDb()
        .update(creditOperations)
        .set({ status: 'admitted' })
        .where(eq(creditOperations.id, reservation.operationId ?? '')),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('terminal') } });
  });
});


it('rejects an unknown persisted funding source instead of inventing refund authority', async () => {
  const reservation = await admitted('unknown-funding');
  await expect(getDb().execute(sql`INSERT INTO credit_operations
    (id, user_id, book_id, requested_model, captured_at, status, grant_kind, initial_free_credits, initial_paid_credits, credits_reserved)
    VALUES ('cpb-illegal-funding', ${reservation.userId}, ${reservation.priceBook?.id ?? ''}, 'auto', now(), 'admitted', 'invented_funding', 0, 0, 1)`)).rejects.toMatchObject({ cause: { code: '23514' } });
});
