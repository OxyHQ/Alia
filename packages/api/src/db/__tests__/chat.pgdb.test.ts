import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { conversations, messages } from '../schema/chat';

/**
 * Chat, against a REAL server.
 *
 * The append-ordering unique is the load-bearing one: `conversation-saver.ts`
 * inserts optimistically and reads a duplicate-key error as "a concurrent
 * append claimed this seq", so the index is not a tidiness constraint, it is
 * the signal a real code path branches on. A mocked `insert` cannot raise it.
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

/** `seq` omitted entirely reproduces a legacy, pre-ordering message. */
const insertMessage = (
  id: string,
  conversationId: string,
  seq: number | null,
  oxyUserId = 'chat-user',
  content: unknown = 'hello',
) => db.execute(sql`
  insert into ${messages} (id, conversation_id, oxy_user_id, role, content, seq)
  values (${id}, ${conversationId}, ${oxyUserId}, 'user', ${JSON.stringify(content)}::jsonb, ${seq})
`);

describe('the append-ordering unique, which a real code path branches on', () => {
  it('refuses two messages claiming the same seq in one conversation', async () => {
    await insertMessage('chat-m-1', 'conv-seq', 0);

    await expect(insertMessage('chat-m-2', 'conv-seq', 0)).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('messages_oxy_user_conversation_seq_key');
      return true;
    });
  });

  it('scopes it to the user, so two people can hold seq 0 in the same conversation id', async () => {
    await insertMessage('chat-m-u1', 'conv-shared', 0, 'chat-user-one');
    await insertMessage('chat-m-u2', 'conv-shared', 0, 'chat-user-two');

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${messages} where conversation_id = 'conv-shared'`,
    );
    // `conversation_id` is client-supplied and unique only within a user, so a
    // unique missing `oxy_user_id` would reject a legitimate second account.
    expect(rows[0]?.n).toBe('2');
  });

  it('lets legacy seq-less messages coexist, which is what the partial predicate documents', async () => {
    /**
     * The fixture that exercises the decision: TWO rows with no `seq` in one
     * `(user, conversation)`. Mongo needed `partialFilterExpression` to permit
     * this; Postgres treats NULLs as distinct and would permit it with or
     * without the `WHERE`, which is exactly why the schema comment says the
     * predicate documents intent rather than enforcing anything. The test is
     * still worth having — it fails if somebody makes `seq` NOT NULL, or
     * replaces the predicate with a `coalesce(seq, -1)` expression that would
     * collapse legacy rows onto one another.
     */
    await insertMessage('chat-legacy-1', 'conv-legacy', null);
    await insertMessage('chat-legacy-2', 'conv-legacy', null);

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${messages} where conversation_id = 'conv-legacy'`,
    );
    expect(rows[0]?.n).toBe('2');
  });
});

describe('content is genuinely polymorphic, which is why it is jsonb', () => {
  it('stores a bare string and a parts array in the same column', async () => {
    await insertMessage('chat-c-string', 'conv-content', 0, 'chat-content-user', 'plain text');
    await insertMessage('chat-c-parts', 'conv-content', 1, 'chat-content-user', [
      { type: 'text', text: 'hi' },
      { type: 'image', url: 'https://example.test/i.png' },
    ]);

    const rows = await db.execute<{ id: string; kind: string }>(sql`
      select id, jsonb_typeof(content) as kind from ${messages}
      where conversation_id = 'conv-content' order by seq
    `);

    /**
     * Mongoose `Mixed`: `routes/conversations.ts` forwards whatever the AI SDK
     * client sent. Asserting the two JSON TYPES is what distinguishes a column
     * that really holds both from one that quietly stringified the array.
     */
    expect(rows.map((r) => r.kind)).toEqual(['string', 'array']);
  });
});

describe('the closed value sets reached the server', () => {
  it('refuses a role outside the tuple', async () => {
    await expect(db.execute(sql`
      insert into ${messages} (id, conversation_id, oxy_user_id, role, content)
      values ('chat-badrole', 'c', 'u', 'moderator', '"x"'::jsonb)
    `)).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('messages_role_check');
      return true;
    });
  });

  it('accepts an ABSENT vote, because a CHECK rejects only FALSE', async () => {
    // `null in (…)` is NULL, not FALSE. Most messages are never voted on, so
    // this is the ordinary case rather than an edge one.
    await insertMessage('chat-novote', 'conv-vote', 0, 'chat-vote-user');
    const rows = await db.execute<{ vote: string | null }>(
      sql`select vote from ${messages} where id = 'chat-novote'`,
    );
    expect(rows[0]?.vote).toBeNull();
  });

  it('refuses a conversation source outside the tuple', async () => {
    await expect(db.execute(sql`
      insert into ${conversations} (id, oxy_user_id, conversation_id, source)
      values ('chat-badsource', 'u', 'c', 'carrier-pigeon')
    `)).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('conversations_source_check');
      return true;
    });
  });
});

describe('a conversation id is unique per user, not globally', () => {
  it('refuses a second conversation with one id for one user', async () => {
    await db.execute(sql`
      insert into ${conversations} (id, oxy_user_id, conversation_id)
      values ('chat-conv-1', 'chat-dup-user', 'same-conv')
    `);

    await expect(db.execute(sql`
      insert into ${conversations} (id, oxy_user_id, conversation_id)
      values ('chat-conv-2', 'chat-dup-user', 'same-conv')
    `)).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('conversations_oxy_user_conversation_id_key');
      return true;
    });
  });

  it('has no foreign key, so a message can be written before its conversation', async () => {
    /**
     * Not an accident being pinned as behaviour — it is the reason the
     * constraint was refused. `routes/conversations.ts:187-188` creates the
     * conversation and inserts the messages inside one `Promise.all`, so this
     * ordering really occurs in production. Adding the foreign key that looks
     * obviously correct turns that request into a race-dependent 23503, and
     * this test is what would go red.
     */
    await insertMessage('chat-orphan', 'conv-not-created-yet', 0, 'chat-orphan-user');

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${messages} where id = 'chat-orphan'`,
    );
    expect(rows[0]?.n).toBe('1');
  });
});
