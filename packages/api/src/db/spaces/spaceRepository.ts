/**
 * Spaces on Postgres (ADR 0028).
 *
 * A space is a row here, its members are the agents whose `agents.space_id` points at it, and its room is
 * an ordinary group conversation whose `conversation_members` this file keeps equal to those agents. The
 * room is therefore written in ONE place: {@link syncSpaceRoom}, called inside the same transaction as
 * every change of membership, so the two never disagree.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { MAX_SPACE_MEMBERS } from '../../domain/spaces';
import { createConversation, deleteConversation } from '../chat/conversationRepository';
import { deleteMessages } from '../chat/messageRepository';
import type { Executor } from '../index';
import { agents } from '../schema/agents';
import { conversationMembers, conversations } from '../schema/chat';
import { spaces } from '../schema/spaces';

export interface SpaceRecord {
  id: string;
  oxyUserId: string;
  name: string;
  instructions: string;
  /** The space's room: a group conversation of the same person. */
  conversationId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SpaceWithMembers extends SpaceRecord {
  /** The agents in the space, in the order they answer in its room. */
  memberAgentIds: string[];
}

const toRecord = (row: typeof spaces.$inferSelect): SpaceRecord => ({
  id: row.id,
  oxyUserId: row.oxyUserId,
  name: row.name,
  instructions: row.instructions,
  conversationId: row.conversationId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The agents of a space, in the order they answer: oldest first, ties by id. */
async function memberIdsOf(db: Executor, spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.spaceId, spaceId))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  return rows.map((row) => row.id);
}

/**
 * Make the room's members equal the space's agents. The ONLY writer of a space room's
 * `conversation_members`. Positions are rewritten whole: a member leaving must not leave a gap, because
 * the table is unique on `(user, conversation, position)` and bounded below the group maximum.
 */
async function syncSpaceRoom(tx: Executor, space: SpaceRecord): Promise<string[]> {
  const memberIds = await memberIdsOf(tx, space.id);
  await tx
    .delete(conversationMembers)
    .where(
      and(
        eq(conversationMembers.oxyUserId, space.oxyUserId),
        eq(conversationMembers.conversationId, space.conversationId),
      ),
    );
  if (memberIds.length > 0) {
    await tx.insert(conversationMembers).values(
      memberIds.map((agentId, position) => ({
        oxyUserId: space.oxyUserId,
        conversationId: space.conversationId,
        agentId,
        position,
      })),
    );
  }
  return memberIds;
}

/** Create a space and its (empty) room in one transaction. */
export async function createSpace(
  db: Executor,
  input: { oxyUserId: string; name: string; instructions: string },
): Promise<SpaceWithMembers> {
  return db.transaction(async (tx) => {
    const conversationId = randomUUID();
    await createConversation(tx, {
      oxyUserId: input.oxyUserId,
      conversationId,
      title: input.name,
      source: 'app',
    });
    const [row] = await tx
      .insert(spaces)
      .values({
        oxyUserId: input.oxyUserId,
        name: input.name,
        instructions: input.instructions,
        conversationId,
      })
      .returning();
    if (!row) throw new Error('space was not stored');
    return { ...toRecord(row), memberAgentIds: [] };
  });
}

/** The person's spaces, oldest first, each with its agents. */
export async function listSpaces(db: Executor, oxyUserId: string): Promise<SpaceWithMembers[]> {
  const rows = await db
    .select()
    .from(spaces)
    .where(eq(spaces.oxyUserId, oxyUserId))
    .orderBy(asc(spaces.createdAt), asc(spaces.id));
  if (rows.length === 0) return [];
  const members = await db
    .select({ id: agents.id, spaceId: agents.spaceId })
    .from(agents)
    .where(
      inArray(
        agents.spaceId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(agents.createdAt), asc(agents.id));
  const bySpace = new Map<string, string[]>();
  for (const member of members) {
    if (member.spaceId === null) continue;
    bySpace.set(member.spaceId, [...(bySpace.get(member.spaceId) ?? []), member.id]);
  }
  return rows.map((row) => ({ ...toRecord(row), memberAgentIds: bySpace.get(row.id) ?? [] }));
}

/** One space of this person, or null (another person's is indistinguishable from a missing one). */
export async function findSpace(
  db: Executor,
  oxyUserId: string,
  spaceId: string,
): Promise<SpaceWithMembers | null> {
  const [row] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.oxyUserId, oxyUserId), eq(spaces.id, spaceId)))
    .limit(1);
  if (!row) return null;
  return { ...toRecord(row), memberAgentIds: await memberIdsOf(db, row.id) };
}

/** Rename and/or rewrite the brief. A rename renames the room too. Null: not this person's space. */
export async function updateSpace(
  db: Executor,
  oxyUserId: string,
  spaceId: string,
  patch: { name?: string; instructions?: string },
): Promise<SpaceWithMembers | null> {
  return db.transaction(async (tx) => {
    const set: Partial<typeof spaces.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.instructions !== undefined) set.instructions = patch.instructions;
    const [row] = await tx
      .update(spaces)
      .set(set)
      .where(and(eq(spaces.oxyUserId, oxyUserId), eq(spaces.id, spaceId)))
      .returning();
    if (!row) return null;
    if (patch.name !== undefined) {
      await tx
        .update(conversations)
        .set({ title: patch.name })
        .where(
          and(
            eq(conversations.oxyUserId, oxyUserId),
            eq(conversations.conversationId, row.conversationId),
          ),
        );
    }
    return { ...toRecord(row), memberAgentIds: await memberIdsOf(tx, row.id) };
  });
}

export type SetAgentSpaceResult =
  | { readonly ok: true; readonly space: SpaceWithMembers | null }
  | {
      readonly ok: false;
      readonly reason:
        | 'space_not_found'
        | 'agent_not_found'
        | 'space_full'
        | 'agent_in_other_space';
    };

/**
 * Put an agent in a space, or (with `spaceId: null`) take it out. An agent is in at most one space, so
 * moving it leaves the old one. Both rooms are brought in step in the same transaction.
 *
 * The target space row is locked `FOR UPDATE` while its size is checked, so two requests cannot both
 * take its last seat. The agent must already be this person's: the route checks standing over it
 * (`loadAgentForActor`); this checks it is the owner's row.
 */
export async function setAgentSpace(
  db: Executor,
  input: { oxyUserId: string; agentId: string; spaceId: string | null },
): Promise<SetAgentSpaceResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id, spaceId: agents.spaceId })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (!agent) return { ok: false, reason: 'agent_not_found' } as const;

    let target: SpaceRecord | null = null;
    if (input.spaceId !== null) {
      const [row] = await tx
        .select()
        .from(spaces)
        .where(and(eq(spaces.oxyUserId, input.oxyUserId), eq(spaces.id, input.spaceId)))
        .limit(1)
        .for('update');
      if (!row) return { ok: false, reason: 'space_not_found' } as const;
      target = toRecord(row);
      if (agent.spaceId !== target.id) {
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(agents)
          .where(and(eq(agents.spaceId, target.id), ne(agents.id, agent.id)));
        if (n >= MAX_SPACE_MEMBERS) return { ok: false, reason: 'space_full' } as const;
      }
    }

    // An agent in somebody else's space is not this person's to move: the answer for a person who
    // merely may act as the agent (an operator) is the same whatever the space.
    const previousId = agent.spaceId;
    if (previousId !== null && previousId !== input.spaceId) {
      const [previous] = await tx
        .select({ oxyUserId: spaces.oxyUserId })
        .from(spaces)
        .where(eq(spaces.id, previousId))
        .limit(1);
      if (previous && previous.oxyUserId !== input.oxyUserId) {
        return { ok: false, reason: 'agent_in_other_space' } as const;
      }
    }
    await tx.update(agents).set({ spaceId: input.spaceId }).where(eq(agents.id, agent.id));

    if (previousId !== null && previousId !== input.spaceId) {
      const [previous] = await tx.select().from(spaces).where(eq(spaces.id, previousId)).limit(1);
      if (previous) await syncSpaceRoom(tx, toRecord(previous));
    }
    if (target) await syncSpaceRoom(tx, target);

    return {
      ok: true,
      space: target ? { ...target, memberAgentIds: await memberIdsOf(tx, target.id) } : null,
    } as const;
  });
}

/**
 * Delete a space: its agents are freed (`ON DELETE SET NULL`), and its room goes with its messages and
 * members. Returns whether the person had that space.
 */
export async function deleteSpace(
  db: Executor,
  oxyUserId: string,
  spaceId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(spaces)
      .where(and(eq(spaces.oxyUserId, oxyUserId), eq(spaces.id, spaceId)))
      .limit(1);
    if (!row) return false;
    await deleteMessages(tx, oxyUserId, row.conversationId);
    await deleteConversation(tx, oxyUserId, row.conversationId);
    await tx.delete(spaces).where(eq(spaces.id, row.id));
    return true;
  });
}

/** The space of each given conversation, for the conversations that are a space's room. */
export async function spaceIdsForConversations(
  db: Executor,
  oxyUserId: string,
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (conversationIds.length === 0) return result;
  const rows = await db
    .select({ id: spaces.id, conversationId: spaces.conversationId })
    .from(spaces)
    .where(
      and(eq(spaces.oxyUserId, oxyUserId), inArray(spaces.conversationId, [...conversationIds])),
    );
  for (const row of rows) result.set(row.conversationId, row.id);
  return result;
}

/** The space whose room this conversation is, or null for any other conversation. */
export async function findSpaceByConversation(
  db: Executor,
  oxyUserId: string,
  conversationId: string,
): Promise<SpaceRecord | null> {
  const [row] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.oxyUserId, oxyUserId), eq(spaces.conversationId, conversationId)))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** The other agents in this agent's space; empty when it is in none. */
export async function listSpacePeerIds(
  db: Executor,
  agentId: string,
  spaceId: string | null,
): Promise<string[]> {
  if (spaceId === null) return [];
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.spaceId, spaceId), ne(agents.id, agentId)))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  return rows.map((row) => row.id);
}
