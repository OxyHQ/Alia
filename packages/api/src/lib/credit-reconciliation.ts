/** Interrupted turns reconcile the existing ledger from Oxy, never from lost stream bytes. */
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { OXY_ALIA_RESOURCE_APPLICATION_ID } from '@oxy.so/core/server';
import type { OxyInferenceClient } from '@oxy.so/core/inference';
import { getDb } from '../db';
import {
  creditOperationAttempts,
  creditOperations,
  creditReconciliations,
} from '../db/schema/credit-operations';
import {
  finalizeCredits,
  refundReservation,
  restoreCreditReservation,
  type CreditReservation,
  type CreditUsage,
} from './credits-manager';
import { getOxyInferenceClient, resolveOxyDeploymentEnvironment } from './inference/oxy-inference';
import { tokenUsageFromUnits } from './inference/token-usage';
import { servedModelId } from './models/power-levels';
import { log } from './logger';

const MAX_RECONCILIATION_ATTEMPTS = 32;

export async function recordChatInferenceAttempt(
  reservation: CreditReservation | null,
  key: string,
  phase: 'prepared' | 'not_sent',
  systemPromptTokens: number,
): Promise<void> {
  if (!reservation?.operationId) return;
  const operationId = reservation.operationId;
  await getDb().transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(creditOperations)
      .where(
        and(eq(creditOperations.id, operationId), eq(creditOperations.userId, reservation.userId)),
      )
      .for('update');
    if (operation?.status !== 'admitted') throw new Error('Credit admission is no longer active');
    if (phase === 'not_sent') {
      await tx
        .delete(creditOperationAttempts)
        .where(
          and(
            eq(creditOperationAttempts.idempotencyKey, key),
            eq(creditOperationAttempts.operationId, operation.id),
          ),
        );
      return;
    }
    await tx
      .insert(creditOperationAttempts)
      .values({ idempotencyKey: key, operationId: operation.id });
    // This survives owner loss. The HTTP turn's hard limit is 80 s: reconciliation
    // cannot race a healthy active owner even if its process dies before finally.
    await tx
      .insert(creditReconciliations)
      .values({
        operationId: operation.id,
        systemPromptTokens,
        nextAttemptAt: sql`now() + interval '2 minutes'`,
      })
      .onConflictDoUpdate({
        target: creditReconciliations.operationId,
        set: { nextAttemptAt: sql`now() + interval '2 minutes'` },
      });
  });
}

export async function requestCreditReconciliation(reservation: CreditReservation): Promise<void> {
  if (!reservation.operationId)
    throw new Error('Controlled inference requires a durable credit operation');
  await getDb()
    .update(creditReconciliations)
    .set({ nextAttemptAt: sql`now()` })
    .where(eq(creditReconciliations.operationId, reservation.operationId));
}

/** Retire scheduling metadata only; financial records and dispatch intents remain auditable. */
export async function retireTerminalCreditReconciliation(operationId: string): Promise<void> {
  await getDb()
    .update(creditReconciliations)
    .set({ nextAttemptAt: null })
    .where(
      and(
        eq(creditReconciliations.operationId, operationId),
        sql`EXISTS (SELECT 1 FROM ${creditOperations} WHERE ${creditOperations.id} = ${creditReconciliations.operationId} AND ${creditOperations.status} <> 'admitted')`,
      ),
    );
}

type ReceiptReader = Pick<OxyInferenceClient, 'getGenerationRecordByIdempotencyKey'>;

/** Safe to repeat, including from two workers: the original ledger locks its terminal transition. */
export async function reconcileChatCreditOperation(
  operationId: string,
  client: ReceiptReader,
  signal: AbortSignal,
): Promise<void> {
  const db = getDb();
  const [operation] = await db
    .select()
    .from(creditOperations)
    .where(eq(creditOperations.id, operationId));
  if (operation?.status !== 'admitted') {
    await retireTerminalCreditReconciliation(operationId);
    return;
  }
  const [recovery] = await db
    .select()
    .from(creditReconciliations)
    .where(eq(creditReconciliations.operationId, operationId));
  if (!recovery) throw new Error('Missing durable reconciliation request');
  const attempts = await db
    .select()
    .from(creditOperationAttempts)
    .where(eq(creditOperationAttempts.operationId, operationId))
    .orderBy(asc(creditOperationAttempts.createdAt), asc(creditOperationAttempts.idempotencyKey));
  // No intent means no dispatch in this opt-in path. Only a known pre-dispatch
  // abort deletes an intent; unknown network outcomes retain theirs.
  const reservation = await restoreCreditReservation(operation.userId, operationId);
  if (!attempts.length) {
    await refundReservation(reservation);
    await retireTerminalCreditReconciliation(operationId);
    return;
  }
  const usage: CreditUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    systemPromptTokens: recovery.systemPromptTokens,
  };
  const seen = new Set<string>();
  let model = operation.requestedModel;
  for (const attempt of attempts) {
    signal.throwIfAborted();
    const record = await client.getGenerationRecordByIdempotencyKey(attempt.idempotencyKey, {
      delegatedUserId: operation.userId,
      signal,
    });
    if (
      record.schemaVersion !== 2 ||
      record.applicationId !== OXY_ALIA_RESOURCE_APPLICATION_ID ||
      record.delegatedUserId !== operation.userId ||
      record.environment !== resolveOxyDeploymentEnvironment() ||
      !record.requestId ||
      !record.settledAt ||
      !Array.isArray(record.units)
    ) {
      throw new Error('Usage record does not match the interrupted Alia turn');
    }
    if (record.usageSource === 'estimated') throw new Error('Token usage remains unresolved');
    if (seen.has(record.requestId)) continue;
    seen.add(record.requestId);
    // The canonical usage contract permits an empty provider report for a
    // failed/cancelled/partial request. An estimated empty report instead means
    // unmeasured usage: keep it pending rather than treating absence as zero.
    if (
      record.units.length === 0 &&
      record.outcome !== 'completed' &&
      record.usageSource === 'provider_reported'
    )
      continue;
    const tokenUnits = [
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'reasoning_tokens',
    ] as const;
    const quantities = tokenUnits.map(
      (name) => record.units.find((unit) => unit.unit === name)?.quantity,
    );
    if (
      quantities.some(
        (quantity) => quantity === undefined || !Number.isSafeInteger(quantity) || quantity < 0,
      ) ||
      record.units.some(
        (unit) =>
          !Number.isSafeInteger(unit.quantity) ||
          unit.quantity < 0 ||
          (unit.unit !== 'requests' &&
            !tokenUnits.some((name) => name === unit.unit) &&
            unit.quantity > 0),
      )
    ) {
      throw new Error('Token usage remains unresolved');
    }
    const projected = tokenUsageFromUnits(record.units);
    const input = projected.inputTokens.total,
      output = projected.outputTokens.total;
    if (input === undefined || output === undefined)
      throw new Error('Token usage remains unresolved');
    usage.promptTokens += input;
    usage.completionTokens += output;
    usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (projected.outputTokens.reasoning ?? 0);
    usage.totalTokens += input + output;
    model = servedModelId(operation.requestedModel, record.resolvedModelReference);
  }
  if (!Number.isSafeInteger(usage.totalTokens))
    throw new Error('Token usage exceeds the supported range');
  // Preserve the existing turn pricing rule: aggregate tokens, its captured
  // immutable price book, and the final served model (not a power-level alias).
  if (usage.totalTokens === 0) await refundReservation(reservation);
  else await finalizeCredits(reservation, usage, model);
  await retireTerminalCreditReconciliation(operationId);
}

let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<void> | undefined;

export async function runCreditReconciliation(): Promise<void> {
  // Recover a process exit between terminal financial CAS and queue cleanup.
  // Only scheduled rows are candidates; work per tick stays bounded.
  const terminal = await getDb()
    .select({ id: creditReconciliations.operationId })
    .from(creditReconciliations)
    .innerJoin(creditOperations, eq(creditOperations.id, creditReconciliations.operationId))
    .where(
      and(
        isNotNull(creditReconciliations.nextAttemptAt),
        sql`${creditOperations.status} <> 'admitted'`,
      ),
    )
    .limit(100);
  for (const row of terminal) await retireTerminalCreditReconciliation(row.id);
  const client = getOxyInferenceClient();
  if (!client) return;
  const rows = await getDb()
    .select({ id: creditReconciliations.operationId, attempts: creditReconciliations.attempts })
    .from(creditReconciliations)
    .innerJoin(creditOperations, eq(creditOperations.id, creditReconciliations.operationId))
    .where(
      and(
        eq(creditOperations.status, 'admitted'),
        isNotNull(creditReconciliations.nextAttemptAt),
        lte(creditReconciliations.nextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(creditReconciliations.nextAttemptAt))
    .limit(5);
  for (const row of rows) {
    try {
      await reconcileChatCreditOperation(row.id, client, AbortSignal.timeout(5_000));
    } catch {
      const attempts = row.attempts + 1;
      await getDb()
        .update(creditReconciliations)
        .set({
          attempts,
          nextAttemptAt:
            attempts >= MAX_RECONCILIATION_ATTEMPTS
              ? null
              : new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6))),
        })
        .where(
          and(
            eq(creditReconciliations.operationId, row.id),
            eq(creditReconciliations.attempts, row.attempts),
          ),
        );
      // No prompts, bearer, opaque key or receipt payload in diagnostics.
      log.credits.warn(
        { operationId: row.id, attempts, needsReview: attempts >= MAX_RECONCILIATION_ATTEMPTS },
        'Interrupted credit operation awaits authoritative usage',
      );
    }
  }
}

export function startCreditReconciliation(isLeader: () => boolean): void {
  if (timer) return;
  timer = setInterval(() => {
    if (!isLeader() || running) return;
    running = runCreditReconciliation()
      .catch(() => log.credits.warn('Credit reconciliation unavailable'))
      .finally(() => {
        running = undefined;
      });
  }, 30_000);
  timer.unref?.();
}

export async function stopCreditReconciliation(): Promise<void> {
  clearInterval(timer);
  timer = undefined;
  await running;
}
