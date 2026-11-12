import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { conversationMembers, conversations, messages } from '../schema/chat';
import {
  agentReactionTurns,
  conversationActivities,
  messageReactionStates,
  reactionEvents,
} from '../schema/message-reactions';
import {
  MAX_REACTIONS_PER_MESSAGE,
  toggleReaction,
  attributedReactions,
  type MessageReactionEntry,
  type AgentReactionEntry,
} from '../../domain/message-reactions';
import { agents } from '../schema/agents';
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

async function targetRow(
  db: Executor,
  userId: string,
  conversationId: string,
  messageId: string,
  forUpdate = false,
) {
  const query = db
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
  const [row] = forUpdate ? await query.for('update') : await query;
  if (!row) return undefined;
  return (await hydrateReactionRows(db, userId, conversationId, [row]))[0];
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
    .select({
      id: messages.id,
      clientMessageId: messages.clientMessageId,
      content: messages.content,
    })
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
  reactionEntries: MessageReactionEntry[];
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
  return mutateReaction(db, userId, conversationId, messageId, input);
}

export type ReactionUserSnapshot = { id: string; content: unknown } | null;

export interface AgentReactionMutation {
  /** Bound by the authorized actor runtime; never parsed from public reaction input. */
  actor: { id: string; name: string };
  turnId: string;
  expectedLatestUserMessage: ReactionUserSnapshot;
  expectedTarget: { content: unknown; role: string; actorId: string | null };
  mutationId: string;
  emoji: string;
  active: boolean;
}

export async function mutateAgentMessageReaction(
  db: ApiDatabase,
  userId: string,
  conversationId: string,
  messageId: string,
  input: AgentReactionMutation,
): Promise<ReactionMutationResult | undefined> {
  return mutateReaction(db, userId, conversationId, messageId, input, input);
}

async function memberExists(db: Executor, userId: string, conversationId: string, actorId: string) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, actorId))
    .limit(1)
    .for('share');
  if (!agent) return false;
  const [conversation] = await db
    .select({ agentId: conversations.agentId })
    .from(conversations)
    .where(
      and(eq(conversations.oxyUserId, userId), eq(conversations.conversationId, conversationId)),
    )
    .limit(1)
    .for('share');
  if (!conversation) return false;
  if (conversation.agentId) return conversation.agentId === actorId;
  const [member] = await db
    .select({ id: conversationMembers.id })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.oxyUserId, userId),
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.agentId, actorId),
      ),
    )
    .limit(1)
    .for('share');
  return !!member;
}

async function latestMatches(
  db: Executor,
  userId: string,
  conversationId: string,
  expected: ReactionUserSnapshot,
) {
  const current = await latestUser(db, userId, conversationId);
  return current
    ? expected !== null &&
        stableId(current) === expected.id &&
        isDeepStrictEqual(current.content, expected.content)
    : expected === null;
}

async function mutateReaction(
  db: ApiDatabase,
  userId: string,
  conversationId: string,
  messageId: string,
  input: ReactionMutation,
  agentInput?: AgentReactionMutation,
): Promise<ReactionMutationResult | undefined> {
  return db.transaction(async (tx) => {
    await lockMessageThread(tx, userId, conversationId);
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.oxyUserId, userId), eq(conversations.conversationId, conversationId)),
      )
      .limit(1);
    if (!conversation) return undefined;
    if (agentInput && !(await memberExists(tx, userId, conversationId, agentInput.actor.id)))
      return undefined;
    if (
      agentInput &&
      !(await latestMatches(tx, userId, conversationId, agentInput.expectedLatestUserMessage))
    )
      return undefined;
    const row = await targetRow(tx, userId, conversationId, messageId, true);
    if (!row) return undefined;
    const actor = await actorOf(tx, userId, conversationId, row);
    if (
      agentInput &&
      (!isDeepStrictEqual(row.content, agentInput.expectedTarget.content) ||
        row.role !== agentInput.expectedTarget.role ||
        actor !== agentInput.expectedTarget.actorId)
    )
      return undefined;
    if (agentInput && (!['user', 'assistant'].includes(row.role) || actor === agentInput.actor.id))
      return undefined;
    const targetId = stableId(row);
    if (row.clientMessageId === null)
      await tx.update(messages).set({ clientMessageId: targetId }).where(eq(messages.id, row.id));
    const mutationId = agentInput
      ? `agent:${JSON.stringify([agentInput.actor.id, agentInput.turnId, agentInput.mutationId])}`
      : (input.mutationId ?? randomUUID());
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
        receipt.reactorAgentId !== (agentInput?.actor.id ?? null) ||
        receipt.reactionTurnId !== (agentInput?.turnId ?? null) ||
        receipt.messageId !== targetId ||
        receipt.emoji !== input.emoji ||
        receipt.requestedActive !== (input.active ?? null)
      )
        throw new ReactionMutationConflict();
      return {
        messageId: targetId,
        reactions: Array.isArray(row.reactions) ? (row.reactions as string[]) : [],
        reactionEntries: row.reactionEntries,
        revision: row.reactionRevision,
        mutationId,
        changed: false,
      };
    }
    const human = Array.isArray(row.reactions) ? (row.reactions as string[]) : [];
    const previousAgents = row.reactionEntries.filter(
      (entry): entry is AgentReactionEntry => entry.author.kind === 'agent',
    );
    const held = agentInput
      ? previousAgents
          .filter((entry) => entry.author.id === agentInput.actor.id)
          .map((entry) => entry.emoji)
      : human;
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
    const nextHuman = agentInput ? human : next;
    const nextAgents: AgentReactionEntry[] =
      agentInput && changed
        ? [
            ...previousAgents.filter((entry) => entry.author.id !== agentInput.actor.id),
            ...next.map((emoji) => ({
              emoji,
              author: { kind: 'agent' as const, ...agentInput.actor },
            })),
          ]
        : previousAgents;
    const entries = attributedReactions(userId, nextHuman, nextAgents);
    const baseline = await latestUser(tx, userId, conversationId);
    if (baseline?.clientMessageId === null)
      await tx
        .update(messages)
        .set({ clientMessageId: baseline.id })
        .where(eq(messages.id, baseline.id));
    const active = next.includes(input.emoji);
    const responseEligible =
      !agentInput &&
      changed &&
      active &&
      actor !== null &&
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
        reactions: nextHuman,
        agentReactions: nextAgents,
        revision,
      })
      .onConflictDoUpdate({
        target: [
          messageReactionStates.oxyUserId,
          messageReactionStates.conversationId,
          messageReactionStates.messageId,
        ],
        set: {
          targetActorId: actor,
          reactions: nextHuman,
          agentReactions: nextAgents,
          revision,
          updatedAt: new Date(),
        },
      });
    await tx
      .update(messages)
      .set({ reactions: nextHuman.length ? nextHuman : null, reactionRevision: revision })
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
        reactorAgentId: agentInput?.actor.id ?? null,
        reactionTurnId: agentInput?.turnId ?? null,
        emoji: input.emoji,
        requestedActive: input.active ?? null,
        active,
        changed,
        responseEligible,
        reactions: next,
        revision,
        baselineUserMessageId: baseline ? stableId(baseline) : null,
        status: responseEligible ? 'pending' : 'completed',
        nextAttemptAt: new Date(Date.now() + 2000),
      })
      .returning();
    return {
      messageId: targetId,
      reactions: nextHuman,
      reactionEntries: entries,
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

/** Canonical state survives old-version writers replacing message-row caches during a rollout. */
export async function hydrateReactionRows<
  T extends {
    id: string;
    clientMessageId: string | null;
    reactions: unknown;
    reactionRevision?: number;
  },
>(
  db: Executor,
  userId: string,
  conversationId: string,
  rows: readonly T[],
): Promise<Array<T & { reactionEntries: MessageReactionEntry[] }>> {
  if (!rows.length) return [];
  const states = await db
    .select()
    .from(messageReactionStates)
    .where(
      and(
        eq(messageReactionStates.oxyUserId, userId),
        eq(messageReactionStates.conversationId, conversationId),
        inArray(messageReactionStates.messageId, rows.map(stableId)),
      ),
    );
  const byId = new Map(states.map((state) => [state.messageId, state]));
  return rows.map((row) => {
    const state = byId.get(stableId(row));
    return state
      ? {
          ...row,
          reactions: state.reactions.length ? state.reactions : null,
          reactionRevision: state.revision,
          reactionEntries: attributedReactions(userId, state.reactions, state.agentReactions),
        }
      : {
          ...row,
          reactionEntries: attributedReactions(
            userId,
            Array.isArray(row.reactions) ? row.reactions : [],
          ),
        };
  });
}

export async function listReactionContext(
  db: Executor,
  userId: string,
  conversationId: string,
  limit = 100,
) {
  const rows = await db
    .select(getTableColumns(messages))
    .from(messages)
    .leftJoin(
      messageReactionStates,
      and(
        eq(messageReactionStates.oxyUserId, messages.oxyUserId),
        eq(messageReactionStates.conversationId, messages.conversationId),
        sql`${messageReactionStates.messageId} = coalesce(${messages.clientMessageId}, ${messages.id})`,
      ),
    )
    .where(
      and(
        scope(userId, conversationId),
        sql`(${messageReactionStates.revision} > 0 or ${messages.reactionRevision} > 0 or ${messages.reactions} is not null)`,
      ),
    )
    .orderBy(sql`${messages.seq} desc nulls last`, desc(messages.createdAt))
    .limit(Math.max(1, Math.min(limit, 200)));
  const current = await hydrateReactionRows(db, userId, conversationId, rows);
  return Promise.all(
    current.map(async (row) => ({
      messageId: stableId(row),
      senderId: userId,
      reactions: Array.isArray(row.reactions) ? (row.reactions as string[]) : [],
      revision: row.reactionRevision,
      reactionEntries: row.reactionEntries,
      targetActorId: await actorOf(db, userId, conversationId, row),
      targetContent: row.content,
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
  options: { deferred?: boolean } = {},
): Promise<boolean> {
  const rows = await db
    .update(reactionEvents)
    .set({
      status: 'pending',
      ...(options.deferred ? { attempts: sql`greatest(${reactionEvents.attempts} - 1, 0)` } : {}),
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
  await db.transaction(async (tx) => {
    await lockMessageThread(tx, userId, conversationId);
    const expiresAt = new Date(Date.now() + Math.max(100, ttlMs));
    await tx
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

/** Only database reads/writes belong in these callbacks, never inference or tool calls. */
export async function withCurrentReaction<T>(
  db: ApiDatabase,
  event: ReactionEvent,
  leaseToken: string,
  commit: (tx: Executor) => Promise<T>,
  recover?: (tx: Executor) => Promise<T | undefined>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    await lockMessageThread(tx, event.userId, event.conversationId);
    await targetRow(tx, event.userId, event.conversationId, event.messageId, true);
    const [held] = await tx
      .select()
      .from(reactionEvents)
      .where(lease(event.id, leaseToken))
      .for('update');
    if (!held || held.oxyUserId !== event.userId || held.conversationId !== event.conversationId)
      return null;
    const recovered = await recover?.(tx);
    if (recovered !== undefined) return recovered;
    if (
      !(await isReactionEventCurrent(tx, eventOf(held))) ||
      (await isConversationActive(tx, event.userId, event.conversationId))
    )
      return null;
    return commit(tx);
  });
}

/** Historical completion, unlike a mutation receipt, proves the runtime finished cleanly. */
export async function findAgentReactionTurnComplete(
  db: Executor,
  userId: string,
  conversationId: string,
  actorId: string,
  turnId: string,
) {
  const [row] = await db
    .select()
    .from(agentReactionTurns)
    .where(
      and(
        eq(agentReactionTurns.oxyUserId, userId),
        eq(agentReactionTurns.conversationId, conversationId),
        eq(agentReactionTurns.actorId, actorId),
        eq(agentReactionTurns.turnId, turnId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Runtime only: call after clean completion, not after a tool call or failed inference. */
export async function markAgentReactionTurnComplete(
  db: ApiDatabase,
  userId: string,
  conversationId: string,
  actorId: string,
  turnId: string,
  expectedLatestUserMessage: ReactionUserSnapshot,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockMessageThread(tx, userId, conversationId);
    if (!(await latestMatches(tx, userId, conversationId, expectedLatestUserMessage))) return false;
    if (!(await memberExists(tx, userId, conversationId, actorId))) return false;
    const [receipt] = await tx
      .select({ id: reactionEvents.id })
      .from(reactionEvents)
      .where(
        and(
          eq(reactionEvents.oxyUserId, userId),
          eq(reactionEvents.conversationId, conversationId),
          eq(reactionEvents.reactorAgentId, actorId),
          eq(reactionEvents.reactionTurnId, turnId),
          eq(reactionEvents.status, 'completed'),
          eq(reactionEvents.responseEligible, false),
        ),
      )
      .limit(1);
    if (!receipt) return false;
    await tx
      .insert(agentReactionTurns)
      .values({ oxyUserId: userId, conversationId, actorId, turnId })
      .onConflictDoNothing();
    return true;
  });
}

/** Server-only bounded tool target snapshots; never infer a target from client display metadata. */
export async function listAgentReactionTargets(
  db: Executor,
  userId: string,
  conversationId: string,
  limit = 24,
) {
  const [conversation] = await db
    .select({ agentId: conversations.agentId })
    .from(conversations)
    .where(
      and(eq(conversations.oxyUserId, userId), eq(conversations.conversationId, conversationId)),
    )
    .limit(1);
  if (!conversation) return [];
  const rows = await db
    .select()
    .from(messages)
    .where(and(scope(userId, conversationId), inArray(messages.role, ['user', 'assistant'])))
    .orderBy(sql`${messages.seq} desc nulls last`, desc(messages.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  return (await hydrateReactionRows(db, userId, conversationId, rows)).map((row) => ({
    id: stableId(row),
    role: row.role,
    content: row.content,
    agentInfoId: row.role === 'assistant' ? (row.agentInfoId ?? conversation.agentId) : null,
    agentInfoName: row.agentInfoName,
    reactionEntries: row.reactionEntries,
    revision: row.reactionRevision,
  }));
}
