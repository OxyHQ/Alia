import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { conversations, messages } from '../schema/chat';
import {
  conversationActivities,
  messageReactionStates,
  reactionEvents,
} from '../schema/message-reactions';
import { MAX_REACTIONS_PER_MESSAGE, toggleReaction } from '../../domain/message-reactions';
import { lockMessageThread } from './messageLock';

type EventRow = typeof reactionEvents.$inferSelect;
export type ReactionEvent = Omit<EventRow, 'oxyUserId'> & { userId: string };
const eventOf = ({ oxyUserId, ...row }: EventRow): ReactionEvent => ({ ...row, userId: oxyUserId });
const scope = (userId: string, conversationId: string) =>
  and(eq(messages.oxyUserId, userId), eq(messages.conversationId, conversationId));
const stableId = (row: { clientMessageId: string | null; id: string }) =>
  row.clientMessageId ?? row.id;

export class ReactionMutationConflict extends Error {
  constructor() {
    super('Reaction mutation id already names a different operation');
  }
}

async function targetRow(db: Executor, userId: string, conversationId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        scope(userId, conversationId),
        or(eq(messages.clientMessageId, messageId), eq(messages.id, messageId)),
      ),
    )
    .orderBy(sql`${messages.seq} asc nulls first`, asc(messages.createdAt))
    .limit(1);
  return row;
}

async function actorOf(
  db: Executor,
  userId: string,
  conversationId: string,
  row: { agentInfoId: string | null; role: string },
) {
  if (row.role !== 'assistant') return null;
  if (row.agentInfoId) return row.agentInfoId;
  const [conversation] = await db
    .select({ agentId: conversations.agentId })
    .from(conversations)
    .where(
      and(eq(conversations.oxyUserId, userId), eq(conversations.conversationId, conversationId)),
    )
    .limit(1);
  return conversation?.agentId ?? null;
}

export async function findReactionTarget(
  db: Executor,
  userId: string,
  conversationId: string,
  messageId: string,
) {
  const row = await targetRow(db, userId, conversationId, messageId);
  return row
    ? {
        messageId: stableId(row),
        targetActorId: await actorOf(db, userId, conversationId, row),
        content: row.content,
        role: row.role,
      }
    : undefined;
}

async function latestUser(db: Executor, userId: string, conversationId: string) {
  const [row] = await db
    .select({ id: messages.id, clientMessageId: messages.clientMessageId })
    .from(messages)
    .where(and(scope(userId, conversationId), eq(messages.role, 'user')))
    .orderBy(sql`${messages.seq} desc nulls last`, desc(messages.createdAt))
    .limit(1);
  return row;
}

export interface ReactionMutation {
  emoji: string;
  active?: boolean;
  mutationId?: string;
  surfaceApplicationId?: string | null;
  /** Edge-verified actor; omission never authorizes a response, including for Alia. */
  authorizedActorId?: string | null;
}
export interface ReactionMutationResult {
  messageId: string;
  reactions: string[];
  revision: number;
  mutationId: string;
  changed: boolean;
  event?: ReactionEvent;
}

export async function mutateMessageReaction(
  db: ApiDatabase,
  userId: string,
  conversationId: string,
  messageId: string,
  input: ReactionMutation,
): Promise<ReactionMutationResult | undefined> {
  return db.transaction(async (tx) => {
    await lockMessageThread(tx, userId, conversationId);
    const row = await targetRow(tx, userId, conversationId, messageId);
    if (!row) return undefined;
    const targetId = stableId(row);
    if (row.clientMessageId === null)
      await tx.update(messages).set({ clientMessageId: targetId }).where(eq(messages.id, row.id));
    const mutationId = input.mutationId ?? randomUUID();
    const [receipt] = await tx
      .select()
      .from(reactionEvents)
      .where(
        and(
          eq(reactionEvents.oxyUserId, userId),
          eq(reactionEvents.conversationId, conversationId),
          eq(reactionEvents.mutationId, mutationId),
        ),
      )
      .limit(1);
    if (receipt) {
      if (
        receipt.messageId !== targetId ||
        receipt.emoji !== input.emoji ||
        receipt.requestedActive !== (input.active ?? null)
      )
        throw new ReactionMutationConflict();
      return {
        messageId: targetId,
        reactions: Array.isArray(row.reactions) ? (row.reactions as string[]) : [],
        revision: row.reactionRevision,
        mutationId,
        changed: false,
      };
    }
    const held = Array.isArray(row.reactions) ? (row.reactions as string[]) : [];
    const next =
      input.active === undefined
        ? toggleReaction(held, input.emoji)
        : input.active
          ? held.includes(input.emoji) || held.length >= MAX_REACTIONS_PER_MESSAGE
            ? held
            : [...held, input.emoji]
          : held.filter((emoji) => emoji !== input.emoji);
    const changed = JSON.stringify(held) !== JSON.stringify(next);
    const revision = row.reactionRevision + Number(changed);
    const actor = await actorOf(tx, userId, conversationId, row);
    const baseline = await latestUser(tx, userId, conversationId);
    if (baseline?.clientMessageId === null)
      await tx
        .update(messages)
        .set({ clientMessageId: baseline.id })
        .where(eq(messages.id, baseline.id));
    const active = next.includes(input.emoji);
    const responseEligible =
      changed &&
      active &&
      row.role === 'assistant' &&
      input.authorizedActorId !== undefined &&
      input.authorizedActorId === actor;
    await tx
      .insert(messageReactionStates)
      .values({
        oxyUserId: userId,
        conversationId,
        messageId: targetId,
        targetActorId: actor,
        reactions: next,
        revision,
      })
      .onConflictDoUpdate({
        target: [
          messageReactionStates.oxyUserId,
          messageReactionStates.conversationId,
          messageReactionStates.messageId,
        ],
        set: { targetActorId: actor, reactions: next, revision, updatedAt: new Date() },
      });
    await tx
      .update(messages)
      .set({ reactions: next.length ? next : null, reactionRevision: revision })
      .where(and(scope(userId, conversationId), eq(messages.clientMessageId, targetId)));
    const [saved] = await tx
      .insert(reactionEvents)
      .values({
        oxyUserId: userId,
        conversationId,
        messageId: targetId,
        targetActorId: actor,
        surfaceApplicationId: input.surfaceApplicationId ?? null,
        mutationId,
        emoji: input.emoji,
        requestedActive: input.active ?? null,
        active,
        changed,
        responseEligible,
        reactions: next,
        revision,
        baselineUserMessageId: baseline ? stableId(baseline) : null,
        status: responseEligible ? 'pending' : 'completed',
      })
      .returning();
    return {
      messageId: targetId,
      reactions: next,
      revision,
      mutationId,
      changed,
      ...(changed ? { event: eventOf(saved) } : {}),
    };
  });
}

export async function findReactionEvent(
  db: Executor,
  id: string,
): Promise<ReactionEvent | undefined> {
  const [row] = await db.select().from(reactionEvents).where(eq(reactionEvents.id, id)).limit(1);
  return row ? eventOf(row) : undefined;
}

export async function isReactionEventCurrent(db: Executor, event: ReactionEvent): Promise<boolean> {
  const current = await findReactionEvent(db, event.id);
  if (!current || !['pending', 'processing'].includes(current.status)) return false;
  const row = await targetRow(db, event.userId, event.conversationId, event.messageId);
  if (
    !row ||
    !event.responseEligible ||
    !event.active ||
    row.reactionRevision !== event.revision ||
    !Array.isArray(row.reactions) ||
    !row.reactions.includes(event.emoji)
  )
    return false;
  if ((await actorOf(db, event.userId, event.conversationId, row)) !== event.targetActorId)
    return false;
  const latest = await latestUser(db, event.userId, event.conversationId);
  return (latest ? stableId(latest) : null) === event.baselineUserMessageId;
}

export async function listReactionContext(
  db: Executor,
  userId: string,
  conversationId: string,
  limit = 100,
) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(scope(userId, conversationId), sql`${messages.reactions} is not null`))
    .orderBy(sql`${messages.seq} desc nulls last`, desc(messages.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)));
  return Promise.all(
    rows
      .filter((row) => Array.isArray(row.reactions) && row.reactions.length > 0)
      .map(async (row) => ({
        messageId: stableId(row),
        senderId: userId,
        reactions: row.reactions as string[],
        revision: row.reactionRevision,
        targetActorId: await actorOf(db, userId, conversationId, row),
      })),
  );
}

export async function claimReactionEvents(
  db: ApiDatabase,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<ReactionEvent[]> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx
      .select()
      .from(reactionEvents)
      .where(
        and(
          eq(reactionEvents.responseEligible, true),
          or(
            and(eq(reactionEvents.status, 'pending'), lte(reactionEvents.nextAttemptAt, now)),
            and(eq(reactionEvents.status, 'processing'), lte(reactionEvents.leaseExpiresAt, now)),
          ),
        ),
      )
      .orderBy(asc(reactionEvents.createdAt))
      .limit(Math.max(1, Math.min(options.limit ?? 10, 100)))
      .for('update', { skipLocked: true });
    const claimed: ReactionEvent[] = [];
    for (const row of rows) {
      const [updated] = await tx
        .update(reactionEvents)
        .set({
          status: 'processing',
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + Math.max(100, options.leaseMs ?? 60_000)),
          attempts: row.attempts + 1,
        })
        .where(eq(reactionEvents.id, row.id))
        .returning();
      claimed.push(eventOf(updated));
    }
    return claimed;
  });
}

const lease = (id: string, token: string) =>
  and(
    eq(reactionEvents.id, id),
    eq(reactionEvents.leaseToken, token),
    eq(reactionEvents.status, 'processing'),
    sql`${reactionEvents.leaseExpiresAt} > now()`,
  );

export async function renewReactionEventLease(
  db: Executor,
  id: string,
  token: string,
  leaseMs = 60_000,
): Promise<boolean> {
  const rows = await db
    .update(reactionEvents)
    .set({ leaseExpiresAt: new Date(Date.now() + Math.max(100, leaseMs)) })
    .where(lease(id, token))
    .returning({ id: reactionEvents.id });
  return rows.length === 1;
}
export async function saveReactionEventDecision(
  db: Executor,
  id: string,
  token: string,
  decision: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .update(reactionEvents)
    .set({ decision, phase: 'speak' })
    .where(and(lease(id, token), isNull(reactionEvents.decision)))
    .returning({ id: reactionEvents.id });
  return rows.length === 1;
}
export async function finishReactionEvent(
  db: Executor,
  id: string,
  token: string,
  status: 'completed' | 'cancelled' | 'failed',
): Promise<boolean> {
  const rows = await db
    .update(reactionEvents)
    .set({ status, leaseToken: null, leaseExpiresAt: null })
    .where(lease(id, token))
    .returning({ id: reactionEvents.id });
  return rows.length === 1;
}
export async function retryReactionEvent(
  db: Executor,
  id: string,
  token: string,
  delayMs: number,
): Promise<boolean> {
  const rows = await db
    .update(reactionEvents)
    .set({
      status: 'pending',
      nextAttemptAt: new Date(Date.now() + Math.max(0, delayMs)),
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(lease(id, token))
    .returning({ id: reactionEvents.id });
  return rows.length === 1;
}

export async function markConversationActivity(
  db: Executor,
  userId: string,
  conversationId: string,
  activityId: string,
  ttlMs = 900_000,
): Promise<void> {
  const expiresAt = new Date(Date.now() + Math.max(100, ttlMs));
  await db
    .insert(conversationActivities)
    .values({ oxyUserId: userId, conversationId, activityId, expiresAt })
    .onConflictDoUpdate({
      target: [
        conversationActivities.oxyUserId,
        conversationActivities.conversationId,
        conversationActivities.activityId,
      ],
      set: { expiresAt },
    });
}
export async function clearConversationActivity(
  db: Executor,
  userId: string,
  conversationId: string,
  activityId: string,
): Promise<void> {
  await db
    .delete(conversationActivities)
    .where(
      and(
        eq(conversationActivities.oxyUserId, userId),
        eq(conversationActivities.conversationId, conversationId),
        eq(conversationActivities.activityId, activityId),
      ),
    );
}
export async function isConversationActive(
  db: Executor,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationActivities.id })
    .from(conversationActivities)
    .where(
      and(
        eq(conversationActivities.oxyUserId, userId),
        eq(conversationActivities.conversationId, conversationId),
        sql`${conversationActivities.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
export async function expireConversationActivities(db: Executor): Promise<void> {
  await db.delete(conversationActivities).where(lte(conversationActivities.expiresAt, new Date()));
}
