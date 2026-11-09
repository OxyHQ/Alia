/**
 * The agents of group conversations, on Postgres.
 *
 * A group is a `conversations` row with no `agent_id` plus one `conversation_members` row per
 * agent, in the order they answer (`db/schema/chat.ts`). Everything is addressed by
 * `(oxy_user_id, conversation_id)` like the rest of the chat tables.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../index';
import { conversationMembers } from '../schema/chat';
import {
  type ConversationRow,
  type NewConversation,
  createConversation,
} from './conversationRepository';

/** The fields `POST /conversations/new` sets for a group: an ordinary conversation, minus the lead. */
export interface NewGroupConversation extends Omit<NewConversation, 'agentId' | 'agentThreadId'> {
  /** In the order they answer. The caller has already checked the count and that each is reachable. */
  readonly agentIds: readonly string[];
}

/**
 * Create a group: the conversation and its members in ONE transaction, so a group never exists
 * without its members (nothing else writes a member row).
 */
export async function createGroupConversation(
  db: Executor,
  input: NewGroupConversation,
): Promise<{ conversation: ConversationRow; memberAgentIds: string[] }> {
  const { agentIds, ...conversationFields } = input;
  const write = async (tx: Executor) => {
    const conversation = await createConversation(tx, conversationFields);
    await tx.insert(conversationMembers).values(
      agentIds.map((agentId, position) => ({
        oxyUserId: input.oxyUserId,
        conversationId: input.conversationId,
        agentId,
        position,
      })),
    );
    return { conversation, memberAgentIds: [...agentIds] };
  };
  // From inside a caller's transaction this is a savepoint; from the root it opens the transaction.
  return db.transaction((tx) => write(tx));
}

/** A group's agents in the order they answer; empty for a conversation that is not a group. */
export async function listGroupMembers(
  db: Executor,
  oxyUserId: string,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ agentId: conversationMembers.agentId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.oxyUserId, oxyUserId),
        eq(conversationMembers.conversationId, conversationId),
      ),
    )
    .orderBy(asc(conversationMembers.position));
  return rows.map((row) => row.agentId);
}

/**
 * The members of several conversations in one query, for a listing: only the groups appear in the
 * map, each with its agents in answering order.
 */
export async function listGroupMembersFor(
  db: Executor,
  oxyUserId: string,
  conversationIds: readonly string[],
): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>();
  if (conversationIds.length === 0) return members;
  const rows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      agentId: conversationMembers.agentId,
    })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.oxyUserId, oxyUserId),
        inArray(conversationMembers.conversationId, [...conversationIds]),
      ),
    )
    .orderBy(asc(conversationMembers.conversationId), asc(conversationMembers.position));
  for (const row of rows) {
    const list = members.get(row.conversationId);
    if (list === undefined) members.set(row.conversationId, [row.agentId]);
    else list.push(row.agentId);
  }
  return members;
}

/** Remove a conversation's members; part of deleting the conversation. */
export async function deleteGroupMembers(
  db: Executor,
  oxyUserId: string,
  conversationId: string,
): Promise<void> {
  await db
    .delete(conversationMembers)
    .where(
      and(
        eq(conversationMembers.oxyUserId, oxyUserId),
        eq(conversationMembers.conversationId, conversationId),
      ),
    );
}
