/**
 * The durable record of inbound platform messages (`channel_inbound`).
 *
 * Written before the platform is acked, claimed by whichever instance answers
 * it, and re-claimed by the sweep when that instance died. Every transition is
 * one conditional UPDATE, so N instances never answer the same message twice
 * through this path.
 */

import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { ChannelInboundMessage } from '../../lib/channels/types.js';
import type { ApiDatabase } from '../index';
import { channelInbound } from '../schema/bots';

type Executor = Pick<ApiDatabase, 'select' | 'insert' | 'update' | 'delete'>;

export interface ChannelInboundWork {
  id: string;
  kind: 'system' | 'agent_bot';
  channelType: string;
  botId: string;
  botUserId: string;
  message: ChannelInboundMessage;
  attempts: number;
}

export interface AcceptChannelInbound {
  dedupeKey: string;
  kind: 'system' | 'agent_bot';
  channelType: string;
  botId: string;
  botUserId: string;
  message: ChannelInboundMessage;
}

/** The old in-memory window: the same key within it is a platform retry. */
export const CHANNEL_DEDUPE_WINDOW_MS = 60_000;

/**
 * Record a delivered message. Returns its id, or null when the same key was
 * accepted within {@link CHANNEL_DEDUPE_WINDOW_MS} (a platform retry).
 *
 * A key older than the window is TAKEN OVER by the new message, because the
 * same person saying the same thing a minute later is a new message.
 */
export async function acceptChannelInbound(
  db: Executor,
  input: AcceptChannelInbound,
  now: Date = new Date(),
): Promise<string | null> {
  const cutoff = new Date(now.getTime() - CHANNEL_DEDUPE_WINDOW_MS);
  const rows = await db
    .insert(channelInbound)
    .values({ ...input, status: 'received', attempts: 0, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: channelInbound.dedupeKey,
      set: {
        kind: input.kind,
        channelType: input.channelType,
        botId: input.botId,
        botUserId: input.botUserId,
        message: input.message,
        status: 'received',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
      setWhere: lt(channelInbound.createdAt, cutoff),
    })
    .returning({ id: channelInbound.id });
  return rows[0]?.id ?? null;
}

function toWork(row: typeof channelInbound.$inferSelect): ChannelInboundWork | null {
  if (!row.message) return null;
  return {
    id: row.id,
    kind: row.kind as ChannelInboundWork['kind'],
    channelType: row.channelType,
    botId: row.botId,
    botUserId: row.botUserId,
    message: row.message,
    attempts: row.attempts,
  };
}

/** Take a freshly accepted message for processing. Null when someone else has it. */
export async function claimChannelInbound(
  db: Executor,
  id: string,
  now: Date = new Date(),
): Promise<ChannelInboundWork | null> {
  const [row] = await db
    .update(channelInbound)
    .set({ status: 'processing', attempts: sql`${channelInbound.attempts} + 1`, updatedAt: now })
    .where(and(eq(channelInbound.id, id), eq(channelInbound.status, 'received')))
    .returning();
  return row ? toWork(row) : null;
}

/** Finish a row. The person's text is dropped with it. */
export async function settleChannelInbound(
  db: Executor,
  id: string,
  status: 'done' | 'failed',
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(channelInbound)
    .set({ status, message: null, updatedAt: now })
    .where(eq(channelInbound.id, id));
}

/**
 * Unfinished rows whose worker went quiet. Each is claimed by a conditional
 * UPDATE on the `updated_at` that was read, so one sweeper gets each row.
 *
 * Rows already attempted `maxAttempts` times are failed instead of retried: a
 * message that keeps killing its worker is not worth a third try, and a second
 * reply is a worse outcome than a quiet failure.
 */
export async function claimStalledChannelInbound(
  db: Executor,
  options: { now: Date; staleMs: number; maxAgeMs: number; maxAttempts: number; limit: number },
): Promise<ChannelInboundWork[]> {
  const staleBefore = new Date(options.now.getTime() - options.staleMs);
  const createdAfter = new Date(options.now.getTime() - options.maxAgeMs);
  const candidates = await db
    .select()
    .from(channelInbound)
    .where(
      and(
        inArray(channelInbound.status, ['received', 'processing']),
        lt(channelInbound.updatedAt, staleBefore),
        gt(channelInbound.createdAt, createdAfter),
      ),
    )
    .orderBy(asc(channelInbound.createdAt))
    .limit(options.limit);
  const claimed: ChannelInboundWork[] = [];
  for (const row of candidates) {
    if (row.attempts >= options.maxAttempts) {
      await db
        .update(channelInbound)
        .set({ status: 'failed', message: null, updatedAt: options.now })
        .where(and(eq(channelInbound.id, row.id), eq(channelInbound.updatedAt, row.updatedAt)));
      continue;
    }
    const [won] = await db
      .update(channelInbound)
      .set({
        status: 'processing',
        attempts: sql`${channelInbound.attempts} + 1`,
        updatedAt: options.now,
      })
      .where(
        and(
          eq(channelInbound.id, row.id),
          inArray(channelInbound.status, ['received', 'processing']),
          eq(channelInbound.updatedAt, row.updatedAt),
        ),
      )
      .returning();
    const work = won ? toWork(won) : null;
    if (work) claimed.push(work);
  }
  return claimed;
}

/** Rows that were abandoned too long ago to answer, and settled rows past their use. */
export async function purgeChannelInbound(
  db: Executor,
  options: { now: Date; settledMs: number; abandonedMs: number },
): Promise<void> {
  const settledBefore = new Date(options.now.getTime() - options.settledMs);
  const abandonedBefore = new Date(options.now.getTime() - options.abandonedMs);
  await db
    .delete(channelInbound)
    .where(
      and(
        inArray(channelInbound.status, ['done', 'failed']),
        lt(channelInbound.updatedAt, settledBefore),
      ),
    );
  await db
    .delete(channelInbound)
    .where(
      and(
        inArray(channelInbound.status, ['received', 'processing']),
        lt(channelInbound.updatedAt, abandonedBefore),
      ),
    );
}
