/**
 * The record of an R1 (reversible-write) tool call and the window it could have
 * been undone in.
 *
 * ## One writer, NO reader, and both halves are deliberate
 *
 * `lib/agent/governance.ts` inserts a row for every R1 action taken while
 * `AUTONOMY_ROLLBACK_ENABLED` is on — which it is by default — and nothing in
 * the package ever selects one. There is no rollback endpoint, no sweeper and no
 * expiry job; `db/expiryTargets.ts` has no entry for this table because Mongoose
 * declared `expiresAt` `required, index: true` and NOT `expireAfterSeconds`, so
 * the rows accumulated there too.
 *
 * So this file has exactly one function. A `findOpenRollbacks` written now
 * against a shape nothing exercises would be the least reviewed query in the
 * package, and the audit trail is the point: what an agent DID is worth
 * recording whether or not anything currently reads it back.
 */

import type { RollbackRiskLevel, RollbackStatus } from '../../domain/rollback-record.js';
import type { ApiDatabase } from '../index';
import { rollbackRecords } from '../schema/agents-support';

export interface NewRollbackRecord {
  readonly oxyUserId: string;
  /** An `agent_sessions` row, as a bare id. No foreign key — see the schema. */
  readonly sessionId: string;
  readonly toolName: string;
  readonly riskLevel: RollbackRiskLevel;
  readonly args: Record<string, unknown>;
  readonly beforeState?: Record<string, unknown>;
  readonly afterState?: Record<string, unknown>;
  readonly diff?: string;
  readonly rollbackAction?: Record<string, unknown>;
  readonly status: RollbackStatus;
  readonly expiresAt: Date;
  readonly executedAt: Date;
}

/**
 * Record one reversible action.
 *
 * Named `insert…` rather than `create…` because `lib/agent/governance.ts`
 * already exports `createRollbackRecord` — the domain operation that decides
 * whether the flag is on and how long the window is. Two functions doing
 * different amounts of work must not share a name.
 *
 * The four optional keys are spread in only when defined. Every one of them is a
 * NULLABLE column, so an explicit `undefined` and an omission would both land as
 * NULL here — but `beforeState`/`afterState` are the row's evidence, and the
 * moment one of them becomes NOT NULL the difference between "the caller had
 * nothing" and "the caller passed undefined" stops being cosmetic. Built from
 * defined keys for the same reason every other write in this schema is.
 */
export async function insertRollbackRecord(
  db: ApiDatabase,
  input: NewRollbackRecord,
): Promise<void> {
  await db.insert(rollbackRecords).values({
    oxyUserId: input.oxyUserId,
    sessionId: input.sessionId,
    toolName: input.toolName,
    riskLevel: input.riskLevel,
    args: input.args,
    ...(input.beforeState === undefined ? {} : { beforeState: input.beforeState }),
    ...(input.afterState === undefined ? {} : { afterState: input.afterState }),
    ...(input.diff === undefined ? {} : { diff: input.diff }),
    ...(input.rollbackAction === undefined ? {} : { rollbackAction: input.rollbackAction }),
    status: input.status,
    expiresAt: input.expiresAt,
    executedAt: input.executedAt,
  });
}
