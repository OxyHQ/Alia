import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { conversations, messages } from '../schema/chat';
import {
  conversationExists,
  countConversationsPerDayForAgent,
  createConversation,
  deleteConversation,
  findConversation,
  listConversations,
  updateConversationTitle,
  upsertConversation,
} from '../chat/conversationRepository';
import {
  countMessages,
  countMessagesInConversation,
  deleteMessages,
  findLastMessage,
  findMessageAudioUrl,
  insertMessages,
  listMessages,
  listRecentTurns,
  listRecentUserText,
  messageExistsInConversation,
  replaceMessages,
  setMessageAudioUrl,
  toStoredMessage,
  voteMessage,
} from '../chat/messageRepository';

/**
 * The chat repositories, against a REAL server.
 *
 * `db/__tests__/chat.pgdb.test.ts` covers the SCHEMA — that the constraints and
 * the partial unique reached the database, for all three of its tables — and
 * `canvasSessionRepository.pgdb.test.ts` covers the third one's queries. This
 * file covers the conversation and message queries, and
 * almost every case here exists because the Mongo original and the obvious
 * Postgres translation return different rows without either one erroring:
 * NULL ordering flips in both directions, `$set: { x: undefined }` stops being a
 * no-op, `findOneAndUpdate` stops meaning one row, `to_char` stops meaning UTC,
 * and `count(*)` stops being a number.
 *
 * Every account and conversation id is unique to its test: the pgdb suite shares
 * one database across every file in it.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/** A message row written straight to the table, so `seq` can be NULL on purpose. */
const rawMessage = (
  id: string,
  oxyUserId: string,
  conversationId: string,
  seq: number | null,
  content: unknown = 'hello',
  role = 'user',
) =>
  db.execute(sql`
    insert into ${messages} (id, conversation_id, oxy_user_id, role, content, seq)
    values (${id}, ${conversationId}, ${oxyUserId}, ${role}, ${JSON.stringify(content)}::jsonb, ${seq})
  `);

describe('upsertConversation', () => {
  it('creates the thread, then refreshes it without creating a second', async () => {
    const created = await upsertConversation(db, {
      oxyUserId: 'up-user',
      conversationId: 'up-conv',
      lastMessage: 'first',
      titleOnInsert: 'From the first message',
      source: 'telegram',
    });
    expect(created.title).toBe('From the first message');
    expect(created.source).toBe('telegram');

    const refreshed = await upsertConversation(db, {
      oxyUserId: 'up-user',
      conversationId: 'up-conv',
      lastMessage: 'second',
      titleOnInsert: 'A title the update branch must ignore',
      source: 'app',
    });

    expect(refreshed.id).toBe(created.id);
    expect(refreshed.lastMessage).toBe('second');
    // `title` and `source` are insert-only: a rename by the second turn of every
    // conversation is what the `$setOnInsert` split existed to prevent.
    expect(refreshed.title).toBe('From the first message');
    expect(refreshed.source).toBe('telegram');
  });

  it('MOVES updated_at on the conflict branch', async () => {
    /**
     * `GET /conversations` both ORDERS and PAGINATES on `updated_at`, so a value
     * that stops moving stops every reply from moving its thread up the list —
     * with correct data in every row and nothing to see.
     *
     * What this actually guards is the COLUMN, not the repository's explicit
     * write: drizzle's `buildUpdateSet` applies `$onUpdate` inside
     * `ON CONFLICT DO UPDATE` too, which was measured rather than assumed (the
     * repository's docblock says so, and says why the explicit write stays
     * anyway). Mutation check: giving `conversations.updatedAt` a plain
     * `timestamptz()` default instead of `updatedAt()` fails this case.
     */
    const first = await upsertConversation(db, {
      oxyUserId: 'up-touch-user',
      conversationId: 'up-touch-conv',
      lastMessage: 'a',
      titleOnInsert: 'T',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await upsertConversation(db, {
      oxyUserId: 'up-touch-user',
      conversationId: 'up-touch-conv',
      lastMessage: 'b',
      titleOnInsert: 'T',
    });

    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    // The floor: `created_at` must NOT have moved, or this is measuring a new row.
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it('leaves last_message alone when the caller supplies none', async () => {
    /**
     * `$set: { lastMessage: undefined }` was a NO-OP in Mongo and writes NULL in
     * Postgres. `POST /conversations` produces exactly that on a save whose
     * `messages` array is empty, so the naive translation erases the sidebar
     * preview of a thread every time a client sends an empty history.
     *
     * Mutation check: passing `lastMessage: input.lastMessage` unconditionally
     * into the `set` turns the second assertion below to `null`.
     */
    await upsertConversation(db, {
      oxyUserId: 'up-keep-user',
      conversationId: 'up-keep-conv',
      lastMessage: 'the preview',
      titleOnInsert: 'T',
    });

    const after = await upsertConversation(db, {
      oxyUserId: 'up-keep-user',
      conversationId: 'up-keep-conv',
      titleOnInsert: 'T',
    });

    expect(after.lastMessage).toBe('the preview');
  });

  it('writes an explicit title on BOTH branches', async () => {
    // The rename path: `POST /conversations` with a `title` must overwrite.
    await upsertConversation(db, {
      oxyUserId: 'up-rename-user',
      conversationId: 'up-rename-conv',
      titleOnInsert: 'Auto',
    });
    const renamed = await upsertConversation(db, {
      oxyUserId: 'up-rename-user',
      conversationId: 'up-rename-conv',
      title: 'Chosen by the user',
      titleOnInsert: 'Auto',
    });
    expect(renamed.title).toBe('Chosen by the user');
  });

  it('scopes the conflict to the user, so two accounts can hold one conversation id', async () => {
    const mine = await upsertConversation(db, {
      oxyUserId: 'up-alice',
      conversationId: 'up-shared',
      titleOnInsert: 'Alice',
    });
    const theirs = await upsertConversation(db, {
      oxyUserId: 'up-bob',
      conversationId: 'up-shared',
      titleOnInsert: 'Bob',
    });

    expect(mine.id).not.toBe(theirs.id);
    expect(mine.title).toBe('Alice');
    expect(theirs.title).toBe('Bob');
  });
});

describe('reads and ownership', () => {
  it('finds a thread only for its owner', async () => {
    await createConversation(db, {
      oxyUserId: 'read-alice',
      conversationId: 'read-conv',
      title: 'Private',
      source: 'app',
    });

    // The positive control sits beside the negative: `undefined` is also what a
    // broken query answers to everybody.
    expect(await findConversation(db, 'read-alice', 'read-conv')).toBeDefined();
    expect(await findConversation(db, 'read-bob', 'read-conv')).toBeUndefined();
    expect(await conversationExists(db, 'read-alice', 'read-conv')).toBe(true);
    expect(await conversationExists(db, 'read-bob', 'read-conv')).toBe(false);
  });

  it('paginates newest first, and the cursor is strict', async () => {
    for (const [id, title] of [
      ['page-a', 'A'],
      ['page-b', 'B'],
      ['page-c', 'C'],
    ]) {
      await createConversation(db, {
        oxyUserId: 'page-user',
        conversationId: id,
        title,
        source: 'app',
      });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    const first = await listConversations(db, 'page-user', 2);
    expect(first.map((row) => row.conversationId)).toEqual(['page-c', 'page-b']);

    const second = await listConversations(db, 'page-user', 2, first[1].updatedAt);
    // STRICTLY older: a `<=` here repeats the cursor row on every page.
    expect(second.map((row) => row.conversationId)).toEqual(['page-a']);
  });

  it('renames through db.update, which is what keeps $onUpdate applying', async () => {
    const before = await createConversation(db, {
      oxyUserId: 'title-user',
      conversationId: 'title-conv',
      title: 'Old',
      source: 'app',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await updateConversationTitle(db, 'title-user', 'title-conv', 'New')).toBe(1);
    // Another account's thread is not renameable, and reports 0 rather than
    // throwing — `count` is `matchedCount`, which is what the source read.
    expect(await updateConversationTitle(db, 'title-other', 'title-conv', 'Hijacked')).toBe(0);

    const after = await findConversation(db, 'title-user', 'title-conv');
    expect(after?.title).toBe('New');
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });


  it('deletes only the owner’s thread, and reports the count off count', async () => {
    await createConversation(db, {
      oxyUserId: 'del-alice',
      conversationId: 'del-conv',
      title: 'T',
      source: 'app',
    });

    expect(await deleteConversation(db, 'del-bob', 'del-conv')).toBe(0);
    expect(await findConversation(db, 'del-alice', 'del-conv')).toBeDefined();
    expect(await deleteConversation(db, 'del-alice', 'del-conv')).toBe(1);
    expect(await findConversation(db, 'del-alice', 'del-conv')).toBeUndefined();
  });
});

describe('the activity heatmap buckets in UTC, whatever the session says', () => {
  it('reports the UTC day and a NUMBER, under a session pinned 14 hours ahead', async () => {
    /**
     * Two failures in one query, both of which look like a working heatmap.
     *
     * `$dateToString` with no `timezone` renders UTC. `to_char` on a
     * `timestamptz` renders in the SESSION's `TimeZone`, so dropping the
     * `at time zone 'UTC'` re-buckets every row by the server's locale. On a
     * server already running UTC — CI, usually — that mutation changes nothing,
     * which is why this runs inside a transaction that pins the session to
     * `Pacific/Kiritimati` (UTC+14): the row below is 2026-03-01T20:00Z, which
     * is 2026-03-02 there.
     *
     * `count(*)` is `bigint`, and postgres.js decodes `bigint` as a STRING while
     * `tsc` types this `number`. The caller does `countMap.get(day) + count`, so
     * without the `::int` the heatmap silently fills with `"01"`-style
     * concatenations. `typeof` is the only thing that separates them.
     *
     * The two rows that share a day are two PEOPLE, not one person twice. They
     * used to be one person's two conversations with one agent, which
     * `conversations_oxy_user_agent_id_key` now forbids — a thread with an agent
     * is permanent and there is one per pair. What this bucket counts is
     * therefore "people who opened a thread with this agent that day" rather
     * than "conversations started", and the day it changed is the day the index
     * landed.
     */
    await db.execute(sql`
      insert into ${conversations} (id, oxy_user_id, conversation_id, agent_id, created_at)
      values ('grid-1', 'grid-user', 'grid-conv-1', 'grid-agent', '2026-03-01T20:00:00Z'),
             ('grid-2', 'grid-user-two', 'grid-conv-2', 'grid-agent', '2026-03-01T23:30:00Z'),
             ('grid-3', 'grid-user', 'grid-conv-3', 'grid-other', '2026-03-01T20:00:00Z')
    `);

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'Pacific/Kiritimati'`);
      // The control: the session really is 14 hours ahead, so the assertion
      // below is measuring the coercion and not a no-op.
      const [local] = await tx.execute<{ day: string }>(
        sql`select to_char(timestamptz '2026-03-01T20:00:00Z', 'YYYY-MM-DD') as day`,
      );
      expect(local?.day).toBe('2026-03-02');
      return countConversationsPerDayForAgent(tx, 'grid-agent', new Date('2026-01-01T00:00:00Z'));
    });

    expect(rows).toEqual([{ day: '2026-03-01', count: 2 }]);
    expect(typeof rows[0].count).toBe('number');
  });
});

describe('message ordering, which is where NULLs flip', () => {
  it('renders seq-less legacy rows FIRST, as Mongo did', async () => {
    /**
     * Mongo sorts a missing field BELOW every number; Postgres's default for ASC
     * is `NULLS LAST`. `routes/webhooks.ts` really does write seq-less rows, so
     * a thread that mixes eras renders with its oldest turns at the bottom under
     * the naive translation — a scrambled conversation and no error anywhere.
     *
     * Mutation check: replacing the ordering with `asc(messages.seq)` yields
     * `['one', 'two', 'legacy']`.
     */
    await rawMessage('ord-legacy', 'ord-user', 'ord-conv', null, 'legacy');
    await rawMessage('ord-0', 'ord-user', 'ord-conv', 0, 'one');
    await rawMessage('ord-1', 'ord-user', 'ord-conv', 1, 'two');

    const rows = await listMessages(db, 'ord-user', 'ord-conv');
    expect(rows.map((row) => row.content)).toEqual(['legacy', 'one', 'two']);
  });

  it('treats a numbered row as the LAST one, not a legacy null', async () => {
    /**
     * The mirror image, and the more dangerous of the two. Mongo's
     * `sort({ seq: -1 })` puts numbers above nulls; Postgres's DESC default is
     * `NULLS FIRST`. `lib/conversation-saver.ts` reads this row's `seq` to decide
     * whether it can append — handed a legacy null it computes `canAppend`
     * against the wrong tail and rewrites the whole thread on every turn.
     *
     * Mutation check: `desc(messages.seq)` returns the `legacy` row here.
     */
    await rawMessage('tail-legacy', 'tail-user', 'tail-conv', null, 'legacy');
    await rawMessage('tail-0', 'tail-user', 'tail-conv', 0, 'one');
    await rawMessage('tail-1', 'tail-user', 'tail-conv', 1, 'two');

    expect(await findLastMessage(db, 'tail-user', 'tail-conv')).toMatchObject({
      seq: 1,
      content: 'two',
    });
  });

  it('replaceMessages numbers the list, so the stored order is the client’s order', async () => {
    /**
     * `POST /conversations` wrote its messages with no `seq` and read them back
     * ordered by it. On Mongo that worked by natural order; on Postgres a set of
     * rows tying on every ORDER BY key comes back however the plan produces
     * them. Asserting the ROUND TRIP rather than the column is what makes this
     * about the user-visible order.
     *
     * Mutation check: dropping `seq` from `replaceMessages`'s insert leaves
     * every row null and the second assertion becomes order-dependent on the
     * planner; the explicit `seq` assertion below fails outright.
     */
    await replaceMessages(db, 'rep-user', 'rep-conv', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);

    const rows = await listMessages(db, 'rep-user', 'rep-conv');
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.content)).toEqual(['first', 'second', 'third']);
  });

  it('replaceMessages replaces rather than appends, and only for the owner', async () => {
    await replaceMessages(db, 'rep2-alice', 'rep2-conv', [{ role: 'user', content: 'mine' }]);
    await replaceMessages(db, 'rep2-bob', 'rep2-conv', [{ role: 'user', content: 'theirs' }]);
    await replaceMessages(db, 'rep2-alice', 'rep2-conv', [
      { role: 'user', content: 'mine' },
      { role: 'assistant', content: 'and the reply' },
    ]);

    expect((await listMessages(db, 'rep2-alice', 'rep2-conv')).map((r) => r.content)).toEqual([
      'mine',
      'and the reply',
    ]);
    // Bob's row survived Alice's rewrite: an unscoped delete is an erasure of
    // somebody else's conversation, and it answers 200.
    expect((await listMessages(db, 'rep2-bob', 'rep2-conv')).map((r) => r.content)).toEqual([
      'theirs',
    ]);
  });
});

describe('the append race the saver branches on', () => {
  it('raises a NAMED unique violation instead of swallowing it', async () => {
    /**
     * `lib/conversation-saver.ts` treats this error as "a concurrent append
     * claimed this seq" and converges with a full rewrite. If `insertMessages`
     * caught it, the second append would silently vanish; if the saver matched
     * any unique rather than this one, a future index on `messages` would start
     * triggering the rewrite for an unrelated reason.
     */
    await insertMessages(db, [
      { conversationId: 'race-conv', oxyUserId: 'race-user', role: 'user', content: 'a', seq: 0 },
    ]);

    await expect(
      insertMessages(db, [
        { conversationId: 'race-conv', oxyUserId: 'race-user', role: 'user', content: 'b', seq: 0 },
      ]),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error, 'messages_oxy_user_conversation_seq_key')).toBe(true);
      expect(constraintNameOf(error)).toBe('messages_oxy_user_conversation_seq_key');
      return true;
    });
  });

  it('counts a thread’s messages as a NUMBER, scoped and unscoped', async () => {
    await insertMessages(db, [
      { conversationId: 'count-conv', oxyUserId: 'count-alice', role: 'user', content: 'a', seq: 0 },
      { conversationId: 'count-conv', oxyUserId: 'count-alice', role: 'user', content: 'b', seq: 1 },
      { conversationId: 'count-conv', oxyUserId: 'count-bob', role: 'user', content: 'c', seq: 0 },
    ]);

    const scoped = await countMessages(db, 'count-alice', 'count-conv');
    expect(scoped).toBe(2);
    // `count(*)` is bigint; without `::int` this is `'2'` and every arithmetic
    // comparison in `conversation-saver.ts` silently changes meaning.
    expect(typeof scoped).toBe('number');
    // Unscoped, faithfully: `generateConversationTitle` counted by id alone.
    expect(await countMessagesInConversation(db, 'count-conv')).toBe(3);
    expect(await messageExistsInConversation(db, 'count-conv')).toBe(true);
    expect(await messageExistsInConversation(db, 'count-conv-absent')).toBe(false);
  });

  it('deletes only the owner’s messages', async () => {
    await insertMessages(db, [
      { conversationId: 'mdel-conv', oxyUserId: 'mdel-alice', role: 'user', content: 'a', seq: 0 },
      { conversationId: 'mdel-conv', oxyUserId: 'mdel-bob', role: 'user', content: 'b', seq: 0 },
    ]);

    expect(await deleteMessages(db, 'mdel-alice', 'mdel-conv')).toBe(1);
    expect(await countMessages(db, 'mdel-bob', 'mdel-conv')).toBe(1);
  });
});

describe('voting picks exactly one row', () => {
  it('matches the CLIENT id, and updates one message even when two share it', async () => {
    /**
     * `findOneAndUpdate` picks one document; a bare `UPDATE … WHERE` writes to
     * every match. Nothing makes `client_message_id` unique — the saver falls
     * back to `msg-<seq>` and the client supplies whatever it likes — so a
     * duplicate is reachable, and voting on it would silently vote on both.
     *
     * Mutation check: replacing the `inArray(id, subquery)` with the same
     * predicate applied directly makes the second assertion `['up', 'up']`.
     */
    await insertMessages(db, [
      { conversationId: 'vote-conv', oxyUserId: 'vote-user', role: 'assistant', content: 'a', seq: 0, clientMessageId: 'msg-dup' },
      { conversationId: 'vote-conv', oxyUserId: 'vote-user', role: 'assistant', content: 'b', seq: 1, clientMessageId: 'msg-dup' },
    ]);

    expect(await voteMessage(db, 'vote-user', 'vote-conv', 'msg-dup', 'up')).toEqual({ vote: 'up' });

    const rows = await listMessages(db, 'vote-user', 'vote-conv');
    expect(rows.map((row) => row.vote)).toEqual(['up', null]);
  });

  it('matches the PRIMARY KEY too, which is the $or the source carried', async () => {
    await db.execute(sql`
      insert into ${messages} (id, conversation_id, oxy_user_id, role, content, seq)
      values ('vote-by-pk', 'votepk-conv', 'votepk-user', 'assistant', '"x"'::jsonb, 0)
    `);

    expect(await voteMessage(db, 'votepk-user', 'votepk-conv', 'vote-by-pk', 'down')).toEqual({
      vote: 'down',
    });
  });

  it('clears a vote with null, the port of $unset', async () => {
    await insertMessages(db, [
      { conversationId: 'unvote-conv', oxyUserId: 'unvote-user', role: 'assistant', content: 'a', seq: 0, clientMessageId: 'm0' },
    ]);
    await voteMessage(db, 'unvote-user', 'unvote-conv', 'm0', 'up');

    expect(await voteMessage(db, 'unvote-user', 'unvote-conv', 'm0', null)).toEqual({ vote: null });
  });

  it('answers nothing for another account, leaving the vote alone', async () => {
    await insertMessages(db, [
      { conversationId: 'voteown-conv', oxyUserId: 'voteown-alice', role: 'assistant', content: 'a', seq: 0, clientMessageId: 'm0' },
    ]);
    await voteMessage(db, 'voteown-alice', 'voteown-conv', 'm0', 'up');

    expect(await voteMessage(db, 'voteown-bob', 'voteown-conv', 'm0', 'down')).toBeUndefined();
    const [row] = await listMessages(db, 'voteown-alice', 'voteown-conv');
    expect(row.vote).toBe('up');
  });
});

describe('the wire shape', () => {
  it('serves the CLIENT’s id as `id`, and reassembles agent_info', async () => {
    /**
     * `packages/app` reads `Message.id` and puts it in the vote URL. The column
     * is `client_message_id` precisely because a `_id -> id` rename would have
     * put the primary key there, and every vote from a shipped build would then
     * 404. `agent_info` is four columns and has to come back as one object.
     */
    await insertMessages(db, [
      {
        conversationId: 'wire-conv',
        oxyUserId: 'wire-user',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        seq: 0,
        clientMessageId: 'client-abc',
        agentInfo: { id: 'a1', name: 'Scout', color: 'teal', handle: 'scout' },
        toolInvocations: [{ toolCallId: 't1', toolName: 'search', state: 'result', result: { ok: true } }],
      },
      { conversationId: 'wire-conv', oxyUserId: 'wire-user', role: 'user', content: 'plain', seq: 1 },
    ]);

    const [withAgent, plain] = (await listMessages(db, 'wire-user', 'wire-conv')).map(toStoredMessage);

    expect(withAgent.id).toBe('client-abc');
    expect(withAgent.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(withAgent.agentInfo).toEqual({ id: 'a1', name: 'Scout', color: 'teal', handle: 'scout' });
    expect(withAgent.toolInvocations).toEqual([
      { toolCallId: 't1', toolName: 'search', state: 'result', result: { ok: true } },
    ]);

    /**
     * Absent, not null. `.lean()` left an unset optional off the document
     * entirely, and a client that distinguishes the two would see a change no
     * server-side assertion on values could detect.
     */
    expect('agentInfo' in plain).toBe(false);
    expect('vote' in plain).toBe(false);
    expect('id' in plain).toBe(false);
    expect(plain.content).toBe('plain');
  });

  it('links and reads back a cached audio url by the client id', async () => {
    await insertMessages(db, [
      { conversationId: 'audio-conv', oxyUserId: 'audio-user', role: 'assistant', content: 'a', seq: 0, clientMessageId: 'am0' },
    ]);

    expect(await findMessageAudioUrl(db, 'audio-user', 'audio-conv', 'am0')).toBeNull();
    expect(await setMessageAudioUrl(db, 'audio-user', 'audio-conv', 'am0', 'https://x/a.mp3')).toBe(1);
    expect(await findMessageAudioUrl(db, 'audio-user', 'audio-conv', 'am0')).toBe('https://x/a.mp3');

    // Another account writes nothing and reads nothing: `undefined` is "no such
    // message", which is what the route turns into a fresh synthesis.
    expect(await setMessageAudioUrl(db, 'audio-other', 'audio-conv', 'am0', 'https://x/b.mp3')).toBe(0);
    expect(await findMessageAudioUrl(db, 'audio-other', 'audio-conv', 'am0')).toBeUndefined();
  });
});

describe('the text-only reads the bots and the style refiner use', () => {
  it('returns turns oldest-first and drops non-string bodies', async () => {
    /**
     * `jsonb_typeof(content) = 'string'` is the port of `{ $type: 'string' }`,
     * which `lib/style/style-refiner.ts` already used in Mongo. A parts array
     * cannot be rendered as a chat line, and picking one up puts
     * `[object Object]` into a model's context.
     *
     * `#>> '{}'` is what unwraps a jsonb string to text — reading the column
     * directly would hand back a QUOTED `"hello"`.
     */
    await rawMessage('turn-0', 'turn-user', 'turn-conv', 0, 'first', 'user');
    await rawMessage('turn-1', 'turn-user', 'turn-conv', 1, 'second', 'assistant');
    await rawMessage('turn-2', 'turn-user', 'turn-conv', 2, [{ type: 'image' }], 'user');

    const turns = await listRecentTurns(db, 'turn-user', 'turn-conv', 20);
    expect(turns).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
  });

  it('takes the NEWEST n and hands them back oldest-first', async () => {
    for (let i = 0; i < 5; i += 1) {
      await rawMessage(`win-${i}`, 'win-user', 'win-conv', i, `m${i}`, 'user');
    }

    expect((await listRecentTurns(db, 'win-user', 'win-conv', 2)).map((t) => t.content)).toEqual([
      'm3',
      'm4',
    ]);
  });

  it('samples one account’s user text, unscoped by conversation', async () => {
    await rawMessage('sty-a', 'sty-user', 'sty-conv-1', 0, 'about cats', 'user');
    await rawMessage('sty-b', 'sty-user', 'sty-conv-2', 0, 'about dogs', 'user');
    await rawMessage('sty-c', 'sty-user', 'sty-conv-2', 1, 'a reply', 'assistant');
    await rawMessage('sty-d', 'sty-other', 'sty-conv-3', 0, 'somebody else', 'user');

    const sample = await listRecentUserText(db, 'sty-user', 'user', 30);
    expect([...sample].sort()).toEqual(['about cats', 'about dogs']);
  });
});
