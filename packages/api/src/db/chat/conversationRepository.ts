/**
 * Chat threads, on Postgres.
 *
 * A conversation is addressed by `(oxy_user_id, conversation_id)` — a
 * client-supplied business key, never the row's `id` — so every function here
 * takes both. `db/schema/chat.ts` states why that pair, and not an id, is the
 * identity; this file is the only place the package reaches the table.
 *
 * ## Ordering is the thing this port could get wrong silently
 *
 * Mongo's natural order approximates insertion order, so `sort({ updatedAt: -1 })`
 * had a de-facto tiebreak Postgres does not. Where the source relied on it, the
 * order is made explicit rather than left to the planner — an arbitrary but
 * stable-looking order is exactly the "plausible, not wrong-looking" failure a
 * port produces.
 *
 * ## NULL ordering differs from Mongo in BOTH directions
 *
 * Mongo sorts `null`/missing BELOW every number, in both directions. Postgres
 * defaults to `NULLS LAST` for ASC and `NULLS FIRST` for DESC — the opposite of
 * Mongo on both. Every `seq` ordering in this package therefore spells its NULL
 * placement out; see `messageRepository.ts`, which is where `seq` actually lives.
 */

import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { ConversationSource } from '../../domain/conversation.js';
import type { ApiDatabase, Executor } from '../index';
import { conversations } from '../schema/chat';

/** A stored conversation, as this repository reads it. */
export interface ConversationRow {
  readonly id: string;
  readonly oxyUserId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly isManualTitle: boolean;
  readonly lastMessage: string | null;
  readonly source: string;
  readonly folderId: string | null;
  readonly icon: string | null;
  readonly iconColor: string | null;
  readonly isFavorite: boolean;
  readonly isPublic: boolean;
  readonly agentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The fields `POST /conversations/new` is allowed to set. */
export interface NewConversation {
  readonly oxyUserId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly source: ConversationSource;
  readonly agentId?: string;
}

/**
 * Create a thread.
 *
 * Every field is named. The route builds this object from a whitelist rather
 * than from `req.body`, so a client cannot set `is_public`, `folder_id` or
 * somebody else's `oxy_user_id` by sending them.
 */
export async function createConversation(
  db: ApiDatabase,
  input: NewConversation,
): Promise<ConversationRow> {
  const [row] = await db
    .insert(conversations)
    .values({
      oxyUserId: input.oxyUserId,
      conversationId: input.conversationId,
      title: input.title,
      source: input.source,
      agentId: input.agentId ?? null,
    })
    .returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

/**
 * One user's threads, most recent first, one page at a time.
 *
 * `before` is the cursor: the `updated_at` of the last row of the previous page,
 * applied as a strict `<` exactly as the source's `$lt` was. `limit` is passed
 * through unchanged — the route asks for one more row than it will return and
 * reads the extra as `hasMore`, so clamping here would silently break that.
 *
 * Served by `conversations_oxy_user_updated_at_idx`.
 */
export async function listConversations(
  db: ApiDatabase,
  oxyUserId: string,
  limit: number,
  before?: Date,
): Promise<ConversationRow[]> {
  return db
    .select()
    .from(conversations)
    .where(
      before
        ? and(eq(conversations.oxyUserId, oxyUserId), lt(conversations.updatedAt, before))
        : eq(conversations.oxyUserId, oxyUserId),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

/**
 * One thread, scoped to its owner.
 *
 * The owner is part of the WHERE rather than checked afterwards, so another
 * account's conversation is indistinguishable from a missing one and the route
 * answers 404 to both.
 */
export async function findConversation(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, oxyUserId),
        eq(conversations.conversationId, conversationId),
      ),
    );
  return row;
}


/** Whether this user holds a thread with this id. */
export async function conversationExists(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, oxyUserId),
        eq(conversations.conversationId, conversationId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The fields an upsert may write.
 *
 * Split the way Mongo's `$set` and `$setOnInsert` were, because the two branches
 * genuinely differ: `title` and `source` are decided when the thread is created
 * and must survive every later save, while `last_message` tracks the newest turn.
 */
export interface ConversationUpsert {
  readonly oxyUserId: string;
  readonly conversationId: string;
  /** Written on both branches. Omit — do not pass `undefined` — to leave it. */
  readonly lastMessage?: string;
  /** Written on both branches when present; on insert only when absent. */
  readonly title?: string;
  /** The insert branch only. An existing thread keeps the title it has. */
  readonly titleOnInsert: string;
  /** The insert branch only. `undefined` takes the column default, `app`. */
  readonly source?: ConversationSource;
  /** The insert branch only. */
  readonly agentId?: string;
}

/**
 * Create the thread or refresh it, returning the row either way.
 *
 * ## `undefined` must not reach the SET clause
 *
 * `$set: { lastMessage: undefined }` is a NO-OP in Mongo. The same statement in
 * Postgres writes NULL, and `POST /conversations` really does produce it: a save
 * whose `messages` array is empty leaves `lastMessage` undefined, and a
 * translation that passed it through would erase the last message of a thread
 * every time the client sent an empty history. So the SET clause is built from
 * the keys that are actually present.
 *
 * ## `updated_at` is written explicitly, and the reason is NOT `$onUpdate`
 *
 * Drizzle's `buildUpdateSet` includes every column carrying an `onUpdateFn`
 * whether or not the caller named it, and `onConflictDoUpdate` goes through that
 * same builder — so `updated_at` would move here on its own. Verified by
 * mutation: removing this line leaves the "MOVES updated_at" case green.
 *
 * It stays because `mapUpdateSet` THROWS `No values to set` on an empty object,
 * and `changed` really is empty on a live path — `POST /conversations` with no
 * message to preview and no explicit title sends neither key. One always-present
 * value is what keeps that request from failing at statement-build time, and
 * naming the timestamp is the honest one to pick.
 *
 * The column matters more than it looks: `GET /conversations` both ORDERS and
 * PAGINATES on it, so a frozen `updated_at` stops every reply moving its thread
 * up the list, with correct data in every row.
 */
export async function upsertConversation(
  db: ApiDatabase,
  input: ConversationUpsert,
): Promise<ConversationRow> {
  const changed = {
    ...(input.lastMessage === undefined ? {} : { lastMessage: input.lastMessage }),
    ...(input.title === undefined ? {} : { title: input.title }),
  };

  const [row] = await db
    .insert(conversations)
    .values({
      oxyUserId: input.oxyUserId,
      conversationId: input.conversationId,
      title: input.title ?? input.titleOnInsert,
      ...(input.source === undefined ? {} : { source: input.source }),
      agentId: input.agentId ?? null,
      ...changed,
    })
    .onConflictDoUpdate({
      target: [conversations.oxyUserId, conversations.conversationId],
      set: { ...changed, updatedAt: new Date() },
    })
    .returning();

  if (!row) throw new Error('conversation upsert returned no row');
  return row;
}

/**
 * Rename a thread, reporting whether one was renamed.
 *
 * `db.update()` here rather than the upsert above, so `updatedAt`'s `$onUpdate`
 * applies — the source was `Conversation.updateOne` on a `timestamps: true`
 * schema, which moved `updatedAt` too. The count is read off `count`, which is
 * Mongo's `matchedCount`: for an UPDATE the returned row set is empty whether or
 * not anything matched, so `rows.length` would be a plausible, always-zero
 * answer.
 */
export async function updateConversationTitle(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
  title: string,
): Promise<number> {
  const result = await db
    .update(conversations)
    .set({ title })
    .where(
      and(
        eq(conversations.oxyUserId, oxyUserId),
        eq(conversations.conversationId, conversationId),
      ),
    );
  return result.count;
}

/**
 * Remove one thread, scoped to its owner.
 *
 * Its messages are NOT removed by this — there is no foreign key to cascade
 * through, deliberately (`db/schema/chat.ts` records why), so the caller deletes
 * them itself exactly as the Mongo version did.
 */
export async function deleteConversation(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<number> {
  const result = await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.oxyUserId, oxyUserId),
        eq(conversations.conversationId, conversationId),
      ),
    );
  return result.count;
}

/**
 * The ACTIVE conversation of a thread — the newest stretch, or nothing.
 *
 * A thread with an agent is MANY conversations (`db/schema/chat.ts` argues why),
 * so "open `/a/pepe`" means "continue the most recent one" rather than "resolve
 * the single row". Starting a new stretch is an ordinary
 * `createConversation` with the same `agent_id`; there is no resolve-or-create
 * any more, because there is nothing unique to resolve.
 *
 * Scoped by `oxy_user_id` as well as `agent_id`, and that is THE thing this
 * function must not get wrong: an agent is talked to by many people, so a
 * lookup on `agent_id` alone would hand one person another person's thread. It
 * is in the WHERE rather than checked afterwards, which is how every other read
 * in this file scopes its owner.
 *
 * Ordered by `created_at DESC` with `id` breaking the tie, so two conversations
 * minted in the same millisecond do not make "the active one" depend on the
 * planner.
 */
export async function findActiveThreadConversation(
  db: ApiDatabase,
  oxyUserId: string,
  agentId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.oxyUserId, oxyUserId), eq(conversations.agentId, agentId)))
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(1);
  return row;
}

/**
 * Every conversation of a thread, oldest first.
 *
 * The thread's spine: the seam a client draws between two stretches is exactly
 * the boundary between two of these, which is why there is no table of breaks.
 */
export async function listThreadConversations(
  db: ApiDatabase,
  oxyUserId: string,
  agentId: string,
): Promise<ConversationRow[]> {
  return db
    .select()
    .from(conversations)
    .where(and(eq(conversations.oxyUserId, oxyUserId), eq(conversations.agentId, agentId)))
    .orderBy(asc(conversations.createdAt), asc(conversations.id));
}

/** One day of the activity heatmap: threads this agent started that day. */
export interface ConversationsPerDay {
  readonly day: string;
  readonly count: number;
}

/**
 * Threads per UTC day for one agent, since `since`.
 *
 * ## Two ways to get the same-looking answer wrong
 *
 * `$dateToString` with no `timezone` renders UTC. `to_char(created_at, …)` on a
 * `timestamptz` renders in the SESSION's `TimeZone`, so the obvious translation
 * silently re-buckets every row by the server's locale — a heatmap that is
 * subtly, unfalsifiably wrong. Hence the explicit `at time zone 'UTC'`.
 *
 * `count(*)` is `bigint`, which postgres.js decodes as a STRING while TypeScript
 * would happily call it a `number`; the caller sums these, and string
 * concatenation is what it would get. The `::int` cast is what makes the
 * declared type true.
 *
 * Takes an {@link Executor} rather than the root handle so a caller — in
 * practice the test — can run it inside a transaction that has done
 * `SET LOCAL TIME ZONE`. Without that, the UTC coercion above is unfalsifiable:
 * a server whose session zone is already UTC gives the same answer with and
 * without it, which is the definition of a check that measures nothing.
 */
export async function countConversationsPerDayForAgent(
  db: Executor,
  agentId: string,
  since: Date,
): Promise<ConversationsPerDay[]> {
  const day = sql<string>`to_char(${conversations.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  return db
    .select({ day, count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), gte(conversations.createdAt, since)))
    .groupBy(day);
}
