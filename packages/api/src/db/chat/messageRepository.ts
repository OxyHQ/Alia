/**
 * The messages in a chat thread, on Postgres.
 *
 * Keyed by `(oxy_user_id, conversation_id)` like the thread itself, never by a
 * foreign key — `db/schema/chat.ts` records why the obvious constraint is wrong
 * here, and the consequence is that a thread delete removes its messages by
 * hand.
 *
 * ## `seq` decides the order, and NULL placement is where a port loses it
 *
 * Mongo sorts a missing or null field BELOW every number in ASC and ABOVE none
 * in DESC. Postgres defaults to the opposite on both counts — `NULLS LAST` for
 * ASC, `NULLS FIRST` for DESC — so every ordering here spells its NULL placement
 * out. Getting it wrong reorders somebody's conversation and raises no error.
 *
 * Legacy rows with no `seq` are real: `routes/webhooks.ts` appends bot turns
 * without one. They sort first, ahead of every numbered message, which is what
 * Mongo did.
 *
 * ## `agent_info` is four columns, and `content` is `jsonb`
 *
 * The projection back onto the sub-document the wire carries happens once, in
 * {@link toStoredMessage}. `content` is genuinely polymorphic — a bare string or
 * the AI SDK's ordered parts array — so it is read back as `MessageContent`
 * rather than narrowed to a string anywhere it is merely being moved.
 */

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type {
  AgentInfo,
  MessageContent,
  MessageRole,
  MessageVote,
  ToolInvocation,
} from '../../domain/conversation.js';
import type { ApiDatabase } from '../index';
import { messages } from '../schema/chat';

/** A stored message, as this repository reads it. */
export interface MessageRow {
  readonly id: string;
  readonly conversationId: string;
  readonly oxyUserId: string;
  readonly clientMessageId: string | null;
  readonly role: string;
  readonly content: unknown;
  readonly vote: string | null;
  readonly toolInvocations: unknown;
  readonly agentInfoId: string | null;
  readonly agentInfoName: string | null;
  readonly agentInfoColor: string | null;
  readonly agentInfoHandle: string | null;
  readonly audioUrl: string | null;
  readonly seq: number | null;
  readonly createdAt: Date;
}

/**
 * What `GET /conversations/:id` puts on the wire.
 *
 * ## The field the client reads is `id`, and it is the CLIENT's id
 *
 * Mongoose stored the AI SDK's client-assigned id in a field literally called
 * `id`, beside `_id`. `packages/app/lib/hooks/use-conversations.ts` declares
 * `Message.id` and `components/chat-interface.tsx:605` puts that value in the
 * vote URL, so `id` on the wire has to keep meaning the client's id — not the
 * row's primary key, which is what a naive `_id -> id` rename would have made
 * it. The column is `client_message_id` precisely so the two cannot be confused
 * in the schema; here is where the wire name is restored.
 *
 * Optional fields are OMITTED rather than sent as `null`, because `.lean()` left
 * an unset optional off the document entirely and a client distinguishing
 * "absent" from "null" would see a change that is invisible from the server.
 */
export interface StoredMessage {
  readonly id?: string;
  readonly role: string;
  readonly content: MessageContent;
  readonly vote?: MessageVote;
  readonly toolInvocations?: ToolInvocation[];
  readonly agentInfo?: AgentInfo;
  readonly audioUrl?: string;
  readonly seq?: number;
  readonly createdAt: Date;
}

/**
 * Project a row onto the wire shape, reassembling `agent_info`.
 *
 * The sub-document is reconstructed only when the row actually carries one.
 * `agent_info_id` is the discriminator: every other member is either a name
 * this service wrote or `color`, which is null whenever the agent's Oxy account
 * has none — so a row with an id has the rest and a row without has none of it.
 */
export function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    ...(row.clientMessageId === null ? {} : { id: row.clientMessageId }),
    role: row.role,
    content: row.content as MessageContent,
    ...(row.vote === null ? {} : { vote: row.vote as MessageVote }),
    ...(row.toolInvocations === null
      ? {}
      : { toolInvocations: row.toolInvocations as ToolInvocation[] }),
    ...(row.agentInfoId === null
      ? {}
      : {
          agentInfo: {
            id: row.agentInfoId,
            name: row.agentInfoName ?? '',
            color: row.agentInfoColor,
            handle: row.agentInfoHandle ?? '',
          },
        }),
    ...(row.audioUrl === null ? {} : { audioUrl: row.audioUrl }),
    ...(row.seq === null ? {} : { seq: row.seq }),
    createdAt: row.createdAt,
  };
}

/** The fields a writer may set on a message. Never `req.body` itself. */
export interface NewMessage {
  readonly conversationId: string;
  readonly oxyUserId: string;
  readonly clientMessageId?: string;
  readonly role: MessageRole;
  readonly content: MessageContent;
  readonly toolInvocations?: ToolInvocation[];
  readonly agentInfo?: AgentInfo;
  readonly seq?: number;
  readonly createdAt?: Date;
}

/** One insertable row, with `agent_info` flattened onto its four columns. */
function toInsert(message: NewMessage): typeof messages.$inferInsert {
  return {
    conversationId: message.conversationId,
    oxyUserId: message.oxyUserId,
    clientMessageId: message.clientMessageId ?? null,
    role: message.role,
    content: message.content,
    toolInvocations: message.toolInvocations ?? null,
    agentInfoId: message.agentInfo?.id ?? null,
    agentInfoName: message.agentInfo?.name ?? null,
    agentInfoColor: message.agentInfo?.color ?? null,
    agentInfoHandle: message.agentInfo?.handle ?? null,
    seq: message.seq ?? null,
    ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
  };
}

/**
 * Every message in a thread, in the order the client should render them.
 *
 * `seq ASC NULLS FIRST` is Mongo's `sort({ seq: 1 })`, which put missing values
 * below every number; Postgres would put them last. `created_at` breaks ties
 * among the legacy rows that have no `seq` at all.
 */
export async function listMessages(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(eq(messages.oxyUserId, oxyUserId), eq(messages.conversationId, conversationId)),
    )
    .orderBy(sql`${messages.seq} asc nulls first`, asc(messages.createdAt));
}

/**
 * The newest `limit` turns of a thread, oldest first, text only.
 *
 * Serves the bot webhooks, which feed the history straight to a model as
 * `{ role, content: string }`. The string narrowing is done by the DATABASE —
 * `jsonb_typeof(content) = 'string'` — for the same reason
 * `lib/style/style-refiner.ts` did it in Mongo with `{ $type: 'string' }`: a
 * parts array cannot be rendered as a chat line, and picking one up here would
 * put `[object Object]` in a model's context. Bot threads are written only by
 * the webhook path, which stores strings, so this filter removes nothing that
 * exists today.
 *
 * The `desc` + reverse is the source's own shape. `created_at DESC` alone is not
 * a total order — two turns of one exchange can land in the same millisecond —
 * so `seq DESC NULLS LAST` breaks the tie ahead of it, matching Mongo's natural
 * order, and the webhook writers give their two turns distinct timestamps.
 *
 * `#>> '{}'` unwraps the jsonb string to `text`. Measured: selecting the column
 * bare returns the same JS string, because postgres.js `JSON.parse`s `jsonb` and
 * a JSON string parses to a string — so this is not what makes the assertions
 * pass, and no test here can distinguish the two. It stays because it makes the
 * declared `string` true of the SQL EXPRESSION rather than a consequence of the
 * `WHERE` clause above it: without the cast, deleting that clause would hand
 * back objects typed as strings.
 */
export async function listRecentTurns(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
  limit: number,
): Promise<{ role: string; content: string }[]> {
  const rows = await db
    .select({ role: messages.role, content: sql<string>`${messages.content} #>> '{}'` })
    .from(messages)
    .where(
      and(
        eq(messages.oxyUserId, oxyUserId),
        eq(messages.conversationId, conversationId),
        sql`jsonb_typeof(${messages.content}) = 'string'`,
      ),
    )
    .orderBy(desc(messages.createdAt), sql`${messages.seq} desc nulls last`)
    .limit(limit);
  return rows.reverse();
}

/**
 * This user's most recent messages in a role, text only, oldest first.
 *
 * The writing-style refiner's sample. Unscoped by conversation, exactly as the
 * source was, and `jsonb_typeof` is the direct port of its `{ $type: 'string' }`.
 */
export async function listRecentUserText(
  db: ApiDatabase,
  oxyUserId: string,
  role: MessageRole,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ content: sql<string>`${messages.content} #>> '{}'` })
    .from(messages)
    .where(
      and(
        eq(messages.oxyUserId, oxyUserId),
        eq(messages.role, role),
        sql`jsonb_typeof(${messages.content}) = 'string'`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.map((row) => row.content).reverse();
}

/**
 * The last message of a thread, as the append fast path reads it.
 *
 * `seq DESC NULLS LAST` is Mongo's `sort({ seq: -1 })`: descending, a number
 * outranks a null. Postgres's default for DESC is `NULLS FIRST`, so the naive
 * translation would hand back a legacy seq-less row as "the last one" and take
 * the append path against it.
 */
export async function findLastMessage(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<{ seq: number | null; role: string; content: unknown } | undefined> {
  const [row] = await db
    .select({ seq: messages.seq, role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(eq(messages.oxyUserId, oxyUserId), eq(messages.conversationId, conversationId)),
    )
    .orderBy(sql`${messages.seq} desc nulls last`, desc(messages.createdAt))
    .limit(1);
  return row;
}

/** How many messages this user holds in a thread. */
export async function countMessages(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(eq(messages.oxyUserId, oxyUserId), eq(messages.conversationId, conversationId)),
    );
  return row?.count ?? 0;
}

/**
 * How many messages exist under a conversation id, across every account.
 *
 * Unscoped by user, faithfully: `generateConversationTitle` counted
 * `{ conversationId }` alone. A conversation id is a `randomUUID()`, so the
 * cross-account reading is theoretical — but it is what decides whether a title
 * is generated, and quietly tightening it would change when titles appear.
 */
export async function countMessagesInConversation(
  db: ApiDatabase,
  conversationId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row?.count ?? 0;
}

/** Whether any message exists under a conversation id, across every account. */
export async function messageExistsInConversation(
  db: ApiDatabase,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .limit(1);
  return row !== undefined;
}

/**
 * Insert messages, letting a duplicate `seq` propagate.
 *
 * The unique on `(oxy_user_id, conversation_id, seq)` is what
 * `lib/conversation-saver.ts` branches on: it appends optimistically and reads
 * `23505` as "a concurrent append claimed this seq", falling back to a full
 * rewrite. So the error must NOT be swallowed here.
 *
 * One statement rather than a loop, which is also a behaviour change worth
 * naming: Mongo's `insertMany(…, { ordered: false })` kept the rows that did not
 * collide, while a multi-row INSERT is all-or-nothing. Nothing partial is what
 * the caller wants — it rewrites the whole thread on the error path — and a
 * half-written history was never a state anything could use.
 */
export async function insertMessages(
  db: ApiDatabase,
  rows: readonly NewMessage[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(messages).values(rows.map(toInsert));
}

/** Remove every message this user holds in a thread. */
export async function deleteMessages(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<number> {
  const result = await db
    .delete(messages)
    .where(
      and(eq(messages.oxyUserId, oxyUserId), eq(messages.conversationId, conversationId)),
    );
  return result.count;
}

/**
 * Replace a thread's messages with exactly this list.
 *
 * ## `seq` is assigned here, and the source assigned none
 *
 * `POST /conversations` wrote its messages with no `seq` at all and then read
 * them back ordered by it. That worked on Mongo only because natural order
 * approximates insertion order; on Postgres a set of rows that tie on every
 * ORDER BY key comes back in whatever order the plan produces, so a saved
 * conversation could render scrambled with nothing to see in the data.
 *
 * The index within the list IS what `seq` means — `lib/conversation-saver.ts`
 * assigns exactly this on its own full-rewrite path — so the ordering the route
 * already assumed is made real rather than left to the planner. It also means a
 * concurrent second save collides on the unique instead of silently doubling
 * every message, which is what Mongo did here.
 *
 * Delete and insert are one transaction: the source's `deleteMany().then(insertMany)`
 * could leave a thread empty if the insert failed, and there is no reason to keep
 * that.
 */
export async function replaceMessages(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
  rows: readonly Omit<NewMessage, 'conversationId' | 'oxyUserId' | 'seq'>[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(messages)
      .where(
        and(eq(messages.oxyUserId, oxyUserId), eq(messages.conversationId, conversationId)),
      );
    if (rows.length === 0) return;
    await tx
      .insert(messages)
      .values(rows.map((row, seq) => toInsert({ ...row, conversationId, oxyUserId, seq })));
  });
}

/**
 * Record or clear a vote on one message, returning the message's vote after.
 *
 * ## Exactly one row, chosen deterministically
 *
 * The source was `findOneAndUpdate`, which picks ONE document; a bare `UPDATE …
 * WHERE` would write to every match. `client_message_id` carries no uniqueness —
 * `lib/conversation-saver.ts` falls back to `msg-<seq>`, which is unique within a
 * thread but nothing enforces it — so the subquery names the row by the same
 * order the thread renders in, and a second matching row is left alone rather
 * than silently voted on too.
 *
 * ## Both spellings of "message id", and no ObjectId check
 *
 * The source matched `{ id }` OR `{ _id }`, guarding the second with
 * `mongoose.isValidObjectId` because a non-ObjectId string threw a CastError.
 * `id` is `text` here, so the comparison is simply a comparison and the guard
 * has nothing left to prevent — which is what removes the last `mongoose` import
 * from `routes/conversations.ts`.
 *
 * Clearing is `vote = null`, the port of `$unset: { vote: 1 }`.
 */
export async function voteMessage(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
  messageId: string,
  vote: MessageVote | null,
): Promise<{ vote: string | null } | undefined> {
  const target = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.oxyUserId, oxyUserId),
        eq(messages.conversationId, conversationId),
        or(eq(messages.clientMessageId, messageId), eq(messages.id, messageId)),
      ),
    )
    .orderBy(sql`${messages.seq} asc nulls first`, asc(messages.createdAt))
    .limit(1);

  const [row] = await db
    .update(messages)
    .set({ vote })
    .where(inArray(messages.id, target))
    .returning({ vote: messages.vote });

  return row;
}

/** The cached audio for one client-identified message, if it has any. */
export async function findMessageAudioUrl(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
  clientMessageId: string,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ audioUrl: messages.audioUrl })
    .from(messages)
    .where(
      and(
        eq(messages.oxyUserId, oxyUserId),
        eq(messages.conversationId, conversationId),
        eq(messages.clientMessageId, clientMessageId),
      ),
    );
  return row?.audioUrl;
}

/**
 * Attach a generated audio URL to one client-identified message.
 *
 * `updateOne` in the source, so at most one row: same deterministic pick as
 * {@link voteMessage}, for the same reason.
 */
export async function setMessageAudioUrl(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
  clientMessageId: string,
  audioUrl: string,
): Promise<number> {
  const target = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.oxyUserId, oxyUserId),
        eq(messages.conversationId, conversationId),
        eq(messages.clientMessageId, clientMessageId),
      ),
    )
    .orderBy(sql`${messages.seq} asc nulls first`, asc(messages.createdAt))
    .limit(1);

  const result = await db.update(messages).set({ audioUrl }).where(inArray(messages.id, target));
  return result.count;
}
