/**
 * Realtime voice sessions: how long each ran and what it charged.
 *
 * Written by `internal/providers/lib/voice-session-manager.ts` at two moments —
 * once when the session starts and once when it ends — and read by
 * `lib/voice-usage.ts` to enforce a plan's voice-minute entitlement.
 *
 * ## The two writes are deliberately different statements
 *
 * The FINAL record upserts on `session_id`; the interim one plainly inserts.
 * That asymmetry is the source's, and `session_id`'s unique index is what makes
 * it safe: a second interim write for the same session raises rather than
 * accumulating a duplicate row, and the caller logs it. Turning the interim
 * insert into an upsert would silently let a session be re-opened.
 *
 * ## `sum(duration)` is the safe side of the int8 trap, by the column's type
 *
 * The durations are `double precision`, so `sum()` returns `double precision`
 * and postgres.js decodes it as a JS number. The same sum over
 * `credits_charged` would NOT — `sum(integer)` is `bigint`, which arrives as a
 * string — so nothing here sums credits, and whoever adds the obvious "credits
 * spent this period" figure has to cast at that boundary.
 */

import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { voiceCallUsage } from '../schema/usage';
import type { CreditFundingSource } from '../../domain/credit-funding.js';

/** One session's record. Mirrors what the voice manager assembles. */
export interface VoiceCallUsageRecord {
  readonly sessionId: string;
  readonly oxyUserId: string;
  readonly routingProfileId: string;
  readonly provider: string;
  readonly providerModel: string;
  readonly startTime: Date;
  readonly endTime: Date | null;
  readonly durationMinutes: number;
  readonly creditsCharged: number;
  /** Which balance funded `creditsCharged`. `null` when no reservation backed the session. */
  readonly grantKind: CreditFundingSource | null;
  readonly costPerMinute: number;
  readonly disconnectReason: string | null;
  readonly audioFormat: string;
  readonly sampleRate: number;
  readonly cohostEnabled: boolean;
  readonly cohostProvider: string | null;
  readonly cohostProviderModel: string | null;
  readonly cohostDurationMinutes: number;
  readonly cohostCreditsCharged: number;
}

/** The interim write: a session that has just started has no row yet. */
export async function insertVoiceCallUsage(
  db: ApiDatabase,
  record: VoiceCallUsageRecord,
): Promise<void> {
  await db.insert(voiceCallUsage).values({ ...record });
}

/** The final write: replace the interim row for this session, or create it. */
export async function upsertVoiceCallUsage(
  db: ApiDatabase,
  record: VoiceCallUsageRecord,
): Promise<void> {
  const { sessionId, ...rest } = record;
  await db
    .insert(voiceCallUsage)
    .values({ sessionId, ...rest })
    .onConflictDoUpdate({
      target: voiceCallUsage.sessionId,
      set: { ...rest, updatedAt: sql`date_trunc('milliseconds', now())` },
    });
}

/**
 * Total voice minutes an account consumed since `since`, own plus co-host.
 *
 * Only COMPLETED sessions count: `end_time is not null` is the source's
 * `$ne: null`, and it is what keeps a session still in progress out of the
 * entitlement figure. Returns 0 when there is nothing to sum, because
 * `sum()` over no rows is NULL rather than zero.
 */
export async function sumVoiceMinutesUsed(
  db: ApiDatabase,
  oxyUserId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({
      totalMinutes: sql<number>`coalesce(sum(
        ${voiceCallUsage.durationMinutes} + ${voiceCallUsage.cohostDurationMinutes}
      ), 0)`,
    })
    .from(voiceCallUsage)
    .where(
      and(
        eq(voiceCallUsage.oxyUserId, oxyUserId),
        gte(voiceCallUsage.startTime, since),
        isNotNull(voiceCallUsage.endTime),
      ),
    );
  return row?.totalMinutes ?? 0;
}
