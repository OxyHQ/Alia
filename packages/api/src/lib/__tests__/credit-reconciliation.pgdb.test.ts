import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { OxyInferenceClient } from '@oxy.so/core/inference';
import { OXY_ALIA_RESOURCE_APPLICATION_ID } from '@oxy.so/core/server';
import { connectPostgres, closePostgres, getDb } from '../../db';
import { creditOperations, creditReconciliations } from '../../db/schema/credit-operations';
import { userCredits } from '../../db/schema/billing';
import { getOrCreateUserCredits, findUserCredits } from '../../db/billing/userCreditsRepository';
import { createCreditPriceBook } from '../credit-price-snapshot';
import * as inferenceAuthority from '../inference/oxy-inference';
import { reserveCredits, refundReservation, type CreditReservation } from '../credits-manager';
import {
  recordChatInferenceAttempt,
  reconcileChatCreditOperation,
  requestCreditReconciliation,
  runCreditReconciliation,
} from '../credit-reconciliation';

let server: Server;
let client: OxyInferenceClient;
const records = new Map<string, object>();
let reads = 0;
beforeAll(async () => {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('Missing fixture DB');
  server = createServer((req, res) => {
    reads++;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/v1/generations/by-idempotency-key');
    const key = req.headers['idempotency-key'];
    const record = typeof key === 'string' ? records.get(key) : undefined;
    res.writeHead(record ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        record
          ? { data: record }
          : {
              error: {
                code: 'model_not_found',
                message: 'Pending',
                requestId: 'readback',
                retryable: false,
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = new OxyInferenceClient({
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    credential: 'synthetic-workload',
  });
  vi.spyOn(inferenceAuthority, 'getOxyInferenceClient').mockReturnValue(client);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await closePostgres();
});

type TrackedReservation = CreditReservation & { operationId: string };

async function admission(): Promise<TrackedReservation> {
  const userId = `cancel-${randomUUID()}`;
  await getOrCreateUserCredits(getDb(), userId);
  await getDb()
    .update(userCredits)
    .set({ creditsFree: 100, creditsPaid: 0 })
    .where(eq(userCredits.id, userId));
  const reservation = await reserveCredits(userId, 1, {
    priceBook: createCreditPriceBook([
      {
        id: 'fixture/model',
        pricing: { inputPerMTok: '3', outputPerMTok: '15', priceVersionId: 'captured-1' },
      },
    ]),
    requestedModel: 'auto',
    aliaRequestId: randomUUID(),
  });
  if (!reservation?.operationId) throw new Error('Missing operation');
  return { ...reservation, operationId: reservation.operationId };
}
async function operation(reservation: TrackedReservation) {
  const [row] = await getDb()
    .select()
    .from(creditOperations)
    .where(eq(creditOperations.id, reservation.operationId));
  return row;
}
function receipt(reservation: CreditReservation, id: string, input: number, output: number) {
  return {
    schemaVersion: 2,
    kind: 'metered_usage',
    requestId: id,
    applicationId: OXY_ALIA_RESOURCE_APPLICATION_ID,
    credentialId: 'synthetic-workload',
    delegatedUserId: reservation.userId,
    environment: 'development',
    economicTreatment: 'internal_metered',
    outcome: 'cancelled',
    usageSource: 'provider_reported',
    units: [
      { unit: 'input_tokens', quantity: input },
      { unit: 'output_tokens', quantity: output },
      { unit: 'cached_input_tokens', quantity: 0 },
      { unit: 'reasoning_tokens', quantity: 0 },
      { unit: 'requests', quantity: 1 },
    ],
    resolvedModelReference: 'fixture/model@immutable',
    settledAt: new Date().toISOString(),
  };
}

describe('interrupted credit reconciliation', () => {
  it('keeps a pre-metadata interruption unresolved until a late real receipt arrives, then settles once after restart', async () => {
    const held = await admission();
    const key = randomUUID();
    await recordChatInferenceAttempt(held, key, 'prepared', 100);
    await requestCreditReconciliation(held);
    await expect(
      reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ status: 404 });
    expect((await operation(held)).status).toBe('admitted');
    expect((await findUserCredits(getDb(), held.userId))?.creditsFree).toBe(99);
    records.set(key, receipt(held, randomUUID(), 5000, 200));
    // No in-memory reservation/controller survives this reconstruction.
    const restarted = new OxyInferenceClient({
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      credential: 'synthetic-workload',
    });
    await Promise.all([
      reconcileChatCreditOperation(held.operationId, restarted, AbortSignal.timeout(2000)),
      reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000)),
    ]);
    const row = await operation(held);
    expect(row.status).toBe('settled');
    const [schedule] = await getDb()
      .select()
      .from(creditReconciliations)
      .where(eq(creditReconciliations.operationId, row.id));
    expect(schedule.nextAttemptAt).toBeNull();
    expect(row.promptTokens).toBe(5000);
    expect(row.completionTokens).toBe(200);
    expect((await findUserCredits(getDb(), held.userId))?.creditsFree).toBe(
      100 - row.creditsCharged!,
    );
    const before = await findUserCredits(getDb(), held.userId);
    await reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000));
    expect(await findUserCredits(getDb(), held.userId)).toEqual(before);
  });
  it('requires every dispatched step receipt before summing multiple attempts and never charges another account', async () => {
    const held = await admission();
    const first = randomUUID(),
      second = randomUUID();
    await recordChatInferenceAttempt(held, first, 'prepared', 100);
    await recordChatInferenceAttempt(held, second, 'prepared', 100);
    records.set(first, receipt(held, randomUUID(), 1000, 20));
    await expect(
      reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ status: 404 });
    records.set(second, {
      ...receipt(held, randomUUID(), 2000, 40),
      delegatedUserId: 'other-account',
    });
    await expect(
      reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000)),
    ).rejects.toThrow('does not match');
    expect((await operation(held)).status).toBe('admitted');
    records.set(second, receipt(held, randomUUID(), 2000, 40));
    await reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000));
    expect(await operation(held)).toMatchObject({
      status: 'settled',
      promptTokens: 3000,
      completionTokens: 60,
      totalTokens: 3060,
      systemPromptTokens: 100,
    });
  });
  it('only refunds known pre-dispatch cancellation or an authoritative explicit zero, not missing units', async () => {
    const held = await admission();
    const key = randomUUID();
    await recordChatInferenceAttempt(held, key, 'prepared', 0);
    await recordChatInferenceAttempt(held, key, 'not_sent', 0);
    await reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000));
    expect((await operation(held)).status).toBe('refunded');
    const zero = await admission(),
      zeroKey = randomUUID();
    await recordChatInferenceAttempt(zero, zeroKey, 'prepared', 0);
    records.set(zeroKey, {
      ...receipt(zero, randomUUID(), 0, 0),
      units: [],
      usageSource: 'estimated',
    });
    await expect(
      reconcileChatCreditOperation(zero.operationId, client, AbortSignal.timeout(2000)),
    ).rejects.toThrow('unresolved');
    records.set(zeroKey, { ...receipt(zero, randomUUID(), 0, 0), units: [] });
    await reconcileChatCreditOperation(zero.operationId, client, AbortSignal.timeout(2000));
    expect((await operation(zero)).status).toBe('refunded');
  });
  it('bounds retries without refunding uncertainty and retires terminal scheduling after a worker restart', async () => {
    const held = await admission(),
      key = randomUUID();
    await recordChatInferenceAttempt(held, key, 'prepared', 0);
    await getDb()
      .update(creditReconciliations)
      .set({ attempts: 31, nextAttemptAt: new Date(0) })
      .where(eq(creditReconciliations.operationId, held.operationId));
    await runCreditReconciliation();
    const [review] = await getDb()
      .select()
      .from(creditReconciliations)
      .where(eq(creditReconciliations.operationId, held.operationId));
    expect(review).toMatchObject({ attempts: 32, nextAttemptAt: null });
    expect((await operation(held)).status).toBe('admitted');
    const readCount = reads;
    await runCreditReconciliation();
    expect(reads).toBe(readCount);

    const terminal = await admission();
    await recordChatInferenceAttempt(terminal, randomUUID(), 'prepared', 0);
    // Simulate a crash after the original ledger committed but before queue cleanup.
    await refundReservation(terminal);
    const financialBefore = await operation(terminal);
    await runCreditReconciliation();
    const [retired] = await getDb()
      .select()
      .from(creditReconciliations)
      .where(eq(creditReconciliations.operationId, terminal.operationId));
    expect(retired.nextAttemptAt).toBeNull();
    expect(await operation(terminal)).toEqual(financialBefore);
    expect(reads).toBe(readCount);
  });
  it('does not refund measured cache/reasoning-only consumption or silently ignore non-token usage', async () => {
    const held = await admission(),
      key = randomUUID();
    await recordChatInferenceAttempt(held, key, 'prepared', 0);
    const measured = receipt(held, randomUUID(), 0, 0);
    measured.units = [
      { unit: 'input_tokens', quantity: 0 },
      { unit: 'output_tokens', quantity: 0 },
      { unit: 'cached_input_tokens', quantity: 3000 },
      { unit: 'reasoning_tokens', quantity: 60 },
      { unit: 'requests', quantity: 1 },
    ];
    records.set(key, measured);
    await reconcileChatCreditOperation(held.operationId, client, AbortSignal.timeout(2000));
    expect(await operation(held)).toMatchObject({
      status: 'settled',
      promptTokens: 3000,
      completionTokens: 60,
      reasoningTokens: 60,
      totalTokens: 3060,
    });
    const unknown = await admission(),
      unknownKey = randomUUID();
    await recordChatInferenceAttempt(unknown, unknownKey, 'prepared', 0);
    const other = receipt(unknown, randomUUID(), 0, 0);
    records.set(unknownKey, { ...other, units: [...other.units, { unit: 'images', quantity: 1 }] });
    await expect(
      reconcileChatCreditOperation(unknown.operationId, client, AbortSignal.timeout(2000)),
    ).rejects.toThrow('unresolved');
    expect((await operation(unknown)).status).toBe('admitted');
  });
});
