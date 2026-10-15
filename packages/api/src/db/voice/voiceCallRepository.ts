/**
 * The statements behind the one-call rule (ADR 0017 §3a). Rules and their
 * reasons are in `db/schema/voice.ts` and `lib/voice/call-registry.ts`.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index.js';
import { voiceCalls, type VoiceCallEndReason } from '../schema/voice.js';

export interface NewVoiceCall {
  readonly id: string;
  readonly oxyUserId: string;
  readonly conversationId: string;
  readonly agentId: string | null;
  readonly holderTask: string;
  readonly leaseMs: number;
}

/** A call this takeover ended, and the task that was holding it. */
export interface ReplacedVoiceCall {
  readonly id: string;
  readonly holderTask: string;
}

/**
 * Make `call` the person's only active call, in one transaction: lock the
 * person, end whatever active row they have (`moved_elsewhere`, whether its
 * lease is live or expired) and insert the new one. Returns what was ended.
 */
export async function takeOverVoiceCall(
  db: ApiDatabase,
  call: NewVoiceCall,
): Promise<ReplacedVoiceCall[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`alia:voice-call:${call.oxyUserId}`}, 0))`,
    );
    const replaced = await tx
      .update(voiceCalls)
      .set({ status: 'ended', endReason: 'moved_elsewhere', endedAt: sql`now()` })
      .where(and(eq(voiceCalls.oxyUserId, call.oxyUserId), eq(voiceCalls.status, 'active')))
      .returning({ id: voiceCalls.id, holderTask: voiceCalls.holderTask });
    await tx.insert(voiceCalls).values({
      id: call.id,
      oxyUserId: call.oxyUserId,
      conversationId: call.conversationId,
      agentId: call.agentId,
      holderTask: call.holderTask,
      status: 'active',
      leaseExpiresAt: sql`now() + (${call.leaseMs} * interval '1 millisecond')`,
    });
    return replaced;
  });
}

/**
 * Extend a call's lease. `false` means the row is no longer active — another
 * device took the call over, or it was ended — and the holder must hang up.
 */
export async function renewVoiceCallLease(
  db: ApiDatabase,
  id: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await db
    .update(voiceCalls)
    .set({ leaseExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')` })
    .where(and(eq(voiceCalls.id, id), eq(voiceCalls.status, 'active')))
    .returning({ id: voiceCalls.id });
  return rows.length === 1;
}

/** End an active call. `false` when it had already ended (taken over). */
export async function endVoiceCall(
  db: ApiDatabase,
  id: string,
  reason: VoiceCallEndReason,
): Promise<boolean> {
  const rows = await db
    .update(voiceCalls)
    .set({ status: 'ended', endReason: reason, endedAt: sql`now()` })
    .where(and(eq(voiceCalls.id, id), eq(voiceCalls.status, 'active')))
    .returning({ id: voiceCalls.id });
  return rows.length === 1;
}

/** The person's active calls (at most one, by the index). For tests and diagnostics. */
export async function findActiveVoiceCalls(db: ApiDatabase, oxyUserId: string) {
  return db
    .select()
    .from(voiceCalls)
    .where(and(eq(voiceCalls.oxyUserId, oxyUserId), eq(voiceCalls.status, 'active')));
}
