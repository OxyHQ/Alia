import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

/**
 * `saveConversation`'s append-only storage, against a REAL Postgres server.
 *
 * ## Why this stopped being a mocked test
 *
 * The function's whole shape is a branch on a DUPLICATE-KEY ERROR: it appends
 * optimistically and reads `23505` on `messages_oxy_user_conversation_seq_key`
 * as "a concurrent append claimed this seq", converging with a full rewrite.
 * The mocked version asserted that with `mockRejectedValueOnce({ code: 11000 })`
 * — which is not the error Postgres raises, is not where drizzle puts the code
 * (`cause`, never `error.code`), and would keep passing against a predicate
 * that matches nothing.
 *
 * So the race is produced rather than described: a row is planted at the seq the
 * append is about to claim, and the index refuses it.
 *
 * The counterpart matters as much. A failure that is NOT a duplicate must
 * propagate and must NOT reach the destructive rewrite — Mongo's
 * read-back-after-duplicate-key recovery does not port, and answering "already
 * done" to an infrastructure failure is how a thread gets deleted and not
 * rewritten. That case is a real CHECK violation, not a fabricated one.
 */

/**
 * The hook that turns the append race from a description into an event.
 *
 * `saveConversation` reads the stored count and the stored tail, decides it can
 * append, and inserts. A concurrent writer claims the seq BETWEEN those two
 * steps, and there is no other window in which it can — plant the row before the
 * read and the count changes, so the fast path is never taken and the duplicate
 * branch is never reached. (Measured: an earlier version of this file planted
 * the row up front, took the slow path, and passed with the branch's constraint
 * name mutated to a completely different index.)
 *
 * So the mock wraps the REAL `findLastMessage` — the second of the two reads —
 * and runs the hook after it returns.
 */
const H = vi.hoisted(() => ({ afterTailRead: null as null | (() => Promise<void>) }));

vi.mock('../../db/chat/messageRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/chat/messageRepository.js')>();
  return {
    ...actual,
    findLastMessage: async (...args: Parameters<typeof actual.findLastMessage>) => {
      const row = await actual.findLastMessage(...args);
      await H.afterTailRead?.();
      return row;
    },
  };
});

vi.mock('../chat-core.js', () => ({
  resolveModel: vi.fn(),
  getAIModel: vi.fn(),
}));

vi.mock('ai', () => ({ generateText: vi.fn() }));

vi.mock('../logger.js', () => ({
  log: {
    chat: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    v1: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { conversations, messages } from '../../db/schema/chat.js';
import { saveConversation } from '../conversation-saver.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/** Unique to this file: the pgdb suite shares one database across every file. */
const USER = `saver-${process.pid}`;
const CONV = 'saver-conv';

const stored = () =>
  db
    .select()
    .from(messages)
    .where(eq(messages.oxyUserId, USER))
    .orderBy(sql`${messages.seq} asc nulls first`, messages.createdAt);

beforeEach(async () => {
  await db.delete(messages).where(eq(messages.oxyUserId, USER));
  await db.delete(conversations).where(eq(conversations.oxyUserId, USER));
  H.afterTailRead = null;
  vi.clearAllMocks();
});

/** The client's echoed history for a conversation whose turns are U1/A1/U2. */
const THREE_TURNS = [
  { role: 'user', content: 'U1' },
  { role: 'assistant', content: 'A1' },
  { role: 'user', content: 'U2' },
];

describe('saveConversation (append-only)', () => {
  it('(e) first save on an empty conversation appends without deleting', async () => {
    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1' }],
      assistantResponse: 'A1',
    });

    const rows = await stored();
    expect(rows.map((row) => [row.seq, row.role, row.content])).toEqual([
      [0, 'user', 'U1'],
      [1, 'assistant', 'A1'],
    ]);
    // The conversation row is created by the same call, and its title comes
    // from the first user message rather than from the assistant's answer.
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.oxyUserId, USER));
    expect(conversation).toMatchObject({ conversationId: CONV, title: 'U1', lastMessage: 'A1' });
  });

  it('(a) second save appends only the new turn', async () => {
    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1' }],
      assistantResponse: 'A1',
    });
    const firstIds = (await stored()).map((row) => row.id);

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: THREE_TURNS,
      assistantResponse: 'A2',
    });

    const rows = await stored();
    expect(rows.map((row) => [row.seq, row.content])).toEqual([
      [0, 'U1'],
      [1, 'A1'],
      [2, 'U2'],
      [3, 'A2'],
    ]);
    /**
     * APPENDED, not rewritten — and the row ids are what says so. Comparing
     * contents cannot tell the two apart: a full rewrite produces exactly the
     * same four values.
     */
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual(firstIds);
  });

  it('(b) an edited history diverges from the stored tail and forces a rewrite', async () => {
    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1' }],
      assistantResponse: 'EDITED-DIFFERENT',
    });
    const firstIds = (await stored()).map((row) => row.id);

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: THREE_TURNS,
      assistantResponse: 'A2',
    });

    const rows = await stored();
    expect(rows.map((row) => [row.seq, row.content])).toEqual([
      [0, 'U1'],
      [1, 'A1'],
      [2, 'U2'],
      [3, 'A2'],
    ]);
    // Every row is new: the thread converged on the client's view by being
    // rewritten, which is the whole point of the slow path.
    expect(rows.some((row) => firstIds.includes(row.id))).toBe(false);
  });

  it('(c) a legacy conversation whose tail has no seq forces a rewrite', async () => {
    // Exactly what `routes/webhooks.ts` writes: rows with no ordering at all.
    await db.execute(sql`
      insert into ${messages} (id, conversation_id, oxy_user_id, role, content, seq)
      values ('saver-legacy-0', ${CONV}, ${USER}, 'user', '"U1"'::jsonb, null),
             ('saver-legacy-1', ${CONV}, ${USER}, 'assistant', '"A1"'::jsonb, null)
    `);

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: THREE_TURNS,
      assistantResponse: 'A2',
    });

    const rows = await stored();
    expect(rows.map((row) => [row.seq, row.content])).toEqual([
      [0, 'U1'],
      [1, 'A1'],
      [2, 'U2'],
      [3, 'A2'],
    ]);
    expect(rows.some((row) => row.id.startsWith('saver-legacy'))).toBe(false);
  });

  it('(d) a REAL duplicate seq falls back to a full rewrite and loses nothing', async () => {
    /**
     * The race, produced rather than mocked. Two turns are stored, so the fast
     * path is available; the hook then claims seq 2 — the position the append is
     * about to take — after the reads and before the insert, exactly as a
     * concurrent writer would. `messages_oxy_user_conversation_seq_key` refuses
     * the insert, and the rewrite converges the thread on the client's four
     * turns.
     *
     * Mutation check: naming any other index in the branch's
     * `isUniqueViolation(err, APPEND_SEQ_INDEX)` makes the driver error
     * propagate and this case fails; so does catching every error rather than
     * that one, via the CHECK-violation case below.
     */
    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1' }],
      assistantResponse: 'A1',
    });

    H.afterTailRead = async () => {
      H.afterTailRead = null;
      await db.execute(sql`
        insert into ${messages} (id, conversation_id, oxy_user_id, role, content, seq)
        values ('saver-squatter', ${CONV}, ${USER}, 'user', '"squatter"'::jsonb, 2)
      `);
    };

    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: THREE_TURNS,
      assistantResponse: 'A2',
    });

    const rows = await stored();
    expect(rows.map((row) => [row.seq, row.content])).toEqual([
      [0, 'U1'],
      [1, 'A1'],
      [2, 'U2'],
      [3, 'A2'],
    ]);
    // The squatter is gone rather than sitting at seq 2 beside the rewrite,
    // which is only true because the fallback DELETES before it reinserts.
    expect(rows.some((row) => row.id === 'saver-squatter')).toBe(false);
  });

  it('re-throws a non-duplicate failure instead of destroying the thread', async () => {
    /**
     * A CHECK violation, not a fabricated error: `messages_role_check` refuses a
     * role outside the tuple, and `saveConversation`'s callers are server-side
     * so the role is not validated on the way in.
     *
     * The second assertion is the one that matters. Porting a duplicate-key
     * catch as a general exception handler answers "already done" to an
     * infrastructure failure — and here "already done" means delete the thread
     * and reinsert it, so a broken connection would take the conversation with
     * it. The rows written by the first save must still be there.
     */
    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1' }],
      assistantResponse: 'A1',
    });

    await expect(
      saveConversation({
        userId: USER,
        conversationId: CONV,
        messages: [
          { role: 'user', content: 'U1' },
          { role: 'assistant', content: 'A1' },
          { role: 'moderator', content: 'not a role this schema has' },
        ],
        assistantResponse: 'A2',
      }),
    ).rejects.toThrow();

    expect((await stored()).map((row) => row.content)).toEqual(['U1', 'A1']);
  });

  it('records the agent’s attribution on the turns it produced', async () => {
    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1' }],
      assistantResponse: 'the final answer',
      agentMessages: [
        {
          role: 'assistant',
          content: 'the specialist speaking',
          agentInfo: { id: 'a1', name: 'Scout', color: 'teal', handle: 'scout' },
        },
      ],
    });

    const rows = await stored();
    expect(rows.map((row) => [row.content, row.agentInfoHandle])).toEqual([
      ['U1', null],
      ['the specialist speaking', 'scout'],
      ['the final answer', null],
    ]);
  });

  it('gives every stored message a client id, so a vote can address it', async () => {
    /**
     * Not decoration: `packages/app` puts `Message.id` in the vote URL and
     * `routes/conversations.ts` matches on `client_message_id`, so a message
     * stored without one cannot be voted on.
     *
     * The value is ALWAYS `msg-<seq>` on this path, even when the client sent an
     * id — `saveConversation` rebuilds its history as `{role, content,
     * toolInvocations}` and drops `id` before `buildStoredMessage` sees it.
     * Pre-existing behaviour, pinned here rather than treated as a bug: the ids
     * a client sends survive only through `POST /conversations`, and `seq` is
     * the absolute position, so the two writers agree on the name of any given
     * message either way.
     */
    await saveConversation({
      userId: USER,
      conversationId: CONV,
      messages: [{ role: 'user', content: 'U1', id: 'client-supplied' }],
      assistantResponse: 'A1',
    });

    expect((await stored()).map((row) => row.clientMessageId)).toEqual(['msg-0', 'msg-1']);
  });
});
