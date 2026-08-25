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
import { conversations, messages } from '../schema/chat';

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
 * Reading a THREAD, which spans many conversations.
 *
 * `/a/:username` shows one continuous history with an agent, and underneath it
 * is many ordinary conversations sharing an `agent_id` — so every read here
 * JOINS `conversations` rather than taking a `conversation_id`. That join is
 * the one place this file reaches a table it does not own, and it is
 * deliberate: a thread-scoped query cannot be expressed without it, and putting
 * it in `conversationRepository.ts` instead would put a `messages` query there.
 *
 * ## The cursor is OPAQUE and is not `seq`
 *
 * `seq` is out twice over. It is ABSENT on legacy messages — `routes/webhooks.ts`
 * appends bot turns without one — so paging by it skips old rows silently, which
 * is the worst failure a history that claims to be permanent can have. And it is
 * unique only WITHIN a conversation, so it does not even order a thread.
 *
 * The cursor is `(created_at, id)`, base64 of a JSON pair, and it is opaque so
 * the implementation can change without touching a client. `id` is what makes
 * the order total: two turns of one exchange land in the same millisecond
 * routinely.
 */

/** The anchor a client holds: a point in a thread, ordered and total. */
export interface ThreadCursor {
  readonly at: Date;
  readonly id: string;
}

export function encodeThreadCursor(cursor: ThreadCursor): string {
  return Buffer.from(JSON.stringify({ at: cursor.at.toISOString(), id: cursor.id })).toString(
    'base64url',
  );
}

/**
 * Read a cursor a client sent back, or nothing.
 *
 * Every malformed shape answers `null` rather than throwing: a cursor is
 * client input, and the route turns `null` into a 400 that says so. A cursor
 * whose `at` does not parse is as malformed as one that is not base64.
 */
export function decodeThreadCursor(encoded: string): ThreadCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { at, id } = parsed as { at?: unknown; id?: unknown };
    if (typeof at !== 'string' || typeof id !== 'string' || id === '') return null;
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? null : { at: date, id };
  } catch {
    return null;
  }
}

/** One message of a thread, with the conversation it belongs to. */
export interface ThreadMessageRow extends MessageRow {
  /** The stretch this message is in. A client draws a seam where it changes. */
  readonly threadConversationId: string;
}

/**
 * A row-value comparison against a cursor, with the instant bound as TEXT.
 *
 * `postgres.js` will not serialise a `Date` inside a raw `sql` template — it
 * throws `ERR_INVALID_ARG_TYPE` at bind time, which is a runtime error the
 * types do not see. The ISO string plus an explicit `::timestamptz` is what
 * makes the comparison a `timestamptz` one rather than a lexical string
 * comparison that would be right by luck and wrong across a timezone.
 */
function cursorTuple(cursor: ThreadCursor) {
  return sql`(${cursor.at.toISOString()}::timestamptz, ${cursor.id})`;
}

function olderThan(cursor: ThreadCursor) {
  return sql`(${messages.createdAt}, ${messages.id}) < ${cursorTuple(cursor)}`;
}

/** Every message of one (person, agent) pair, whichever conversation it is in. */
function threadScope(oxyUserId: string, agentId: string) {
  return and(
    eq(conversations.oxyUserId, oxyUserId),
    eq(conversations.agentId, agentId),
    eq(messages.oxyUserId, conversations.oxyUserId),
    eq(messages.conversationId, conversations.conversationId),
  );
}

/**
 * A page of a thread, newest-last, crossing conversation boundaries.
 *
 * `before` is EXCLUSIVE: it is the cursor of the oldest row the caller already
 * has, so a page never repeats one. Absent, the newest page is served.
 *
 * `hasMore` is decided by asking for one row more than will be returned, not by
 * `rows.length < limit` — that inference is wrong at the exact boundary where
 * the thread's length is a multiple of the page size, which is the one case a
 * reader will hit by scrolling.
 */
export async function listThreadPage(
  db: ApiDatabase,
  params: {
    oxyUserId: string;
    agentId: string;
    limit: number;
    before?: ThreadCursor;
  },
): Promise<{ messages: ThreadMessageRow[]; hasMore: boolean }> {
  const rows = await db
    .select({
      message: messages,
      threadConversationId: conversations.conversationId,
    })
    .from(messages)
    .innerJoin(conversations, threadScope(params.oxyUserId, params.agentId))
    .where(params.before === undefined ? undefined : olderThan(params.before))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const page = (hasMore ? rows.slice(0, params.limit) : rows).map((row) => ({
    ...row.message,
    threadConversationId: row.threadConversationId,
  }));
  // Read oldest-first, which is how a transcript renders.
  return { messages: page.reverse(), hasMore };
}

/**
 * The window CONTAINING one message, with context on both sides.
 *
 * What a search result is for: a hit carries a cursor, and this is what that
 * cursor opens. `before` cannot serve it — `before` is exclusive, so the hit
 * itself would be the one message missing from the window it was supposed to
 * reveal.
 *
 * Half the budget above and half below, and the anchor is returned whether or
 * not anything surrounds it. A window that silently omitted its own anchor
 * because the thread ended is the failure this shape exists to prevent.
 */
export async function listThreadWindow(
  db: ApiDatabase,
  params: { oxyUserId: string; agentId: string; limit: number; at: ThreadCursor },
): Promise<{ messages: ThreadMessageRow[]; hasMore: boolean }> {
  const half = Math.max(1, Math.floor(params.limit / 2));

  const select = () =>
    db
      .select({ message: messages, threadConversationId: conversations.conversationId })
      .from(messages)
      .innerJoin(conversations, threadScope(params.oxyUserId, params.agentId));

  const project = (rows: { message: MessageRow; threadConversationId: string }[]) =>
    rows.map((row) => ({ ...row.message, threadConversationId: row.threadConversationId }));

  const newer = await select()
    .where(sql`(${messages.createdAt}, ${messages.id}) > ${cursorTuple(params.at)}`)
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(half);

  /**
   * `<=`, so the anchor itself is the newest row of this half.
   *
   * The alternative — reusing `listThreadPage` with the cursor nudged one
   * millisecond forward — reads as clever and is wrong: two turns of one
   * exchange land in the same millisecond routinely, so the nudge would drag in
   * whatever else shared that instant and put it on the wrong side of the
   * anchor.
   */
  const olderRows = await select()
    .where(sql`(${messages.createdAt}, ${messages.id}) <= ${cursorTuple(params.at)}`)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(half + 1);

  const hasMore = olderRows.length > half;
  const older = project(hasMore ? olderRows.slice(0, half) : olderRows).reverse();

  return { messages: [...older, ...project(newer)], hasMore };
}

/** One search hit: the message, the text that matched, and where to jump. */
export interface ThreadSearchHit {
  readonly id: string;
  readonly clientMessageId: string | null;
  readonly conversationId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: Date;
}

/**
 * Search what was SAID across a whole thread.
 *
 * Serves both consumers deliberately: the person searching their own history,
 * and the AGENT recalling something from earlier. One index, one query, one
 * definition of what counts as text — and it spans every conversation of the
 * pair, because a thread does.
 *
 * ## Text, not embeddings, and that is a decision with a cost attached
 *
 * The obvious alternative is an embedding per message and a vector search. It
 * was refused for two measured reasons rather than on taste:
 *
 *  - It costs an embedding call **per turn**, forever, on a path that already
 *    reserves credits.
 *  - It is a second store that grows without bound. `db/schema/context-graph.ts`
 *    already records that the autonomy graph mints a node per chat turn and that
 *    **nothing reaps them** — a problem ported from Mongo rather than
 *    introduced. Adding message embeddings would make that two, and the
 *    retention answer would still not exist.
 *
 * A `tsvector` index adds no new store: it indexes a column that is already
 * there. If the text search turns out to be too blunt — a person searching for
 * a concept they never wrote the word for — embeddings are the answer, and the
 * evidence for adding them is a measurement of THIS failing, not the absence of
 * one.
 *
 * ## `websearch_to_tsquery`, and what it does and does not buy
 *
 * `to_tsquery` takes operator syntax and THROWS on a stray `&` or an unbalanced
 * bracket — which a person types, so it is a 500 on an apostrophe.
 * `websearch_to_tsquery` never raises, and it adds quoted phrases and `-`
 * exclusion.
 *
 * **It does NOT loosen the conjunction**, which was measured rather than
 * assumed: unquoted terms are ANDed exactly as `plainto_tsquery` ANDs them, so
 * a natural-language question finds nothing unless every one of its words is in
 * the message. That is what a search box does — Google, Slack and GitHub all
 * AND — so it is kept rather than worked around, and it is stated where the two
 * consumers can see it: `lib/tools/thread-search.ts` tells the model in its
 * description AND in the answer it gives for an empty result, because a bare
 * `[]` reads to a model as a broken tool rather than as an answer.
 *
 * Both bind parameters, so nothing here is a concatenation.
 */
export async function searchThread(
  db: ApiDatabase,
  params: { oxyUserId: string; agentId: string; query: string; limit: number },
): Promise<ThreadSearchHit[]> {
  return db
    .select({
      id: messages.id,
      clientMessageId: messages.clientMessageId,
      conversationId: conversations.conversationId,
      role: messages.role,
      text: sql<string>`alia_message_text(${messages.content})`,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, threadScope(params.oxyUserId, params.agentId))
    .where(
      and(
        /**
         * Spelled exactly as `messages_search_idx`'s predicate is, so the
         * partial index is usable for this query at all. A different spelling
         * of the same set — `role != 'system'`, say — cannot be proved to imply
         * the predicate, and the planner would silently stop using the index.
         */
        sql`${messages.role} in ('user', 'assistant')`,
        sql`to_tsvector('simple', alia_message_text(${messages.content})) @@ websearch_to_tsquery('simple', ${params.query})`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(params.limit);
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
