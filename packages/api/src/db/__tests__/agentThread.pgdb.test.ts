/**
 * `/a/:username` is ONE thread per (person, agent), against a real server.
 *
 * Two properties, and the second is the one that would hurt:
 *
 *  - **Opening the thread twice answers the SAME conversation.** Without it,
 *    `/a/pepe` is an ordinary "new chat" button wearing a permanent URL, and
 *    every visit buries the previous one in the sidebar.
 *  - **Two people talking to one agent see two histories.** A lookup keyed on
 *    `agent_id` alone passes every single-user test ever written and shows one
 *    person another person's conversation. It is the worst thing in this
 *    feature and it is one missing `AND` away at all times.
 *
 * The unique index is asserted through the DATABASE rather than through the
 * repository, because the repository's resolve-first shape means it would never
 * attempt the duplicate — so a test that only went through it would be green
 * with no index at all.
 *
 * Every account, agent and conversation id is unique to its test: the pgdb suite
 * shares one database across every file in it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isUniqueViolation, constraintNameOf } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { conversations } from '../schema/chat';
import {
  createConversation,
  deleteConversation,
  findAgentThread,
  findDuplicateAgentThreads,
  resolveAgentThread,
} from '../chat/conversationRepository';
import {
  deleteConversationBreaks,
  insertConversationBreak,
  listConversationBreaks,
} from '../chat/conversationBreakRepository';
import { deleteMessages, insertMessages, listMessages } from '../chat/messageRepository';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/** Open a thread the way the route does: a fresh id it may or may not use. */
function open(oxyUserId: string, agentId: string, titleOnCreate = 'The Researcher') {
  return resolveAgentThread(db, {
    oxyUserId,
    agentId,
    conversationId: `thread-${Math.random().toString(36).slice(2)}`,
    titleOnCreate,
  });
}

describe('one thread per (person, agent)', () => {
  it('answers the same conversation when the same person opens it twice', async () => {
    const first = await open('thread-owner-a', 'agent-a');
    const second = await open('thread-owner-a', 'agent-a');

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.id).toBe(first.id);

    // And there really is one row, not two the reader is picking between.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(sql`oxy_user_id = 'thread-owner-a' and agent_id = 'agent-a'`);
    expect(n).toBe(1);
  });

  it('gives two people two threads, with two histories', async () => {
    const mine = await open('thread-owner-b', 'agent-shared');
    const theirs = await open('thread-stranger-b', 'agent-shared');

    expect(theirs.conversationId).not.toBe(mine.conversationId);

    await insertMessages(db, [
      {
        conversationId: mine.conversationId,
        oxyUserId: 'thread-owner-b',
        role: 'user',
        content: 'my secret',
        seq: 0,
      },
      {
        conversationId: theirs.conversationId,
        oxyUserId: 'thread-stranger-b',
        role: 'user',
        content: 'their secret',
        seq: 0,
      },
    ]);

    const mineRead = await listMessages(db, 'thread-owner-b', mine.conversationId);
    const theirsRead = await listMessages(db, 'thread-stranger-b', theirs.conversationId);

    expect(mineRead.map((m) => m.content)).toEqual(['my secret']);
    expect(theirsRead.map((m) => m.content)).toEqual(['their secret']);

    // The lookup is scoped by BOTH columns, so my open never reaches theirs.
    const resolved = await findAgentThread(db, 'thread-owner-b', 'agent-shared');
    expect(resolved?.conversationId).toBe(mine.conversationId);

    await deleteMessages(db, 'thread-owner-b', mine.conversationId);
    await deleteMessages(db, 'thread-stranger-b', theirs.conversationId);
  });

  it('titles a new thread with the agent, and marks it manually titled', async () => {
    // A permanent thread is not "New chat", and the auto-titler must not rename
    // it to whatever the first exchange happened to be about.
    const thread = await open('thread-owner-c', 'agent-c', 'Deep Reader');

    expect(thread.title).toBe('Deep Reader');
    expect(thread.isManualTitle).toBe(true);
    expect(thread.agentId).toBe('agent-c');
  });

  it('keeps a thread apart from the same person’s other agents', async () => {
    const one = await open('thread-owner-d', 'agent-d1');
    const two = await open('thread-owner-d', 'agent-d2');

    expect(two.conversationId).not.toBe(one.conversationId);
  });

  it('does not treat an ordinary conversation as a thread', async () => {
    // Every conversation that is not an agent thread carries a NULL `agent_id`,
    // and there are far more of those than of these. The partial index must not
    // collect them, and the lookup must not answer one.
    await createConversation(db, {
      oxyUserId: 'thread-owner-e',
      conversationId: 'plain-conv-e',
      title: 'New chat',
      source: 'app',
    });

    expect(await findAgentThread(db, 'thread-owner-e', 'agent-e')).toBeUndefined();
    await deleteConversation(db, 'thread-owner-e', 'plain-conv-e');
  });
});

describe('the database refuses a second thread for one pair', () => {
  it('rejects a duplicate `(oxy_user_id, agent_id)` insert', async () => {
    await open('thread-owner-f', 'agent-f');

    // Straight to the table, bypassing the resolve-first repository — which is
    // the only way to ask the INDEX the question. The repository would answer
    // the existing row and never attempt the insert, so a green test through it
    // would say nothing about whether the index exists.
    const duplicate = createConversation(db, {
      oxyUserId: 'thread-owner-f',
      conversationId: 'second-thread-f',
      title: 'a second thread',
      source: 'app',
      agentId: 'agent-f',
    });

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      return isUniqueViolation(error) && constraintNameOf(error) === 'conversations_oxy_user_agent_id_key';
    });
  });

  it('admits many NULL `agent_id` rows for one person', async () => {
    // The other half, and the reason the index is PARTIAL: without the
    // predicate this assertion would still pass — Postgres treats NULLs as
    // distinct — so what it really pins is that the predicate did not
    // accidentally become `agent_id IS NULL`, which would forbid a person from
    // holding two ordinary conversations.
    for (const id of ['plain-g1', 'plain-g2', 'plain-g3']) {
      await createConversation(db, {
        oxyUserId: 'thread-owner-g',
        conversationId: id,
        title: 'New chat',
        source: 'app',
      });
    }

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(sql`oxy_user_id = 'thread-owner-g'`);
    expect(n).toBe(3);

    for (const id of ['plain-g1', 'plain-g2', 'plain-g3']) {
      await deleteConversation(db, 'thread-owner-g', id);
    }
  });

  it('makes the duplicate state unreachable, and says so by trying', async () => {
    /**
     * The shape of the check run against production before 0046 was written,
     * turned into an assertion with its own control built in.
     *
     * The planted pair is what makes it mean something: `findDuplicateAgentThreads`
     * answering `[]` over a table nobody tried to corrupt is the same reading as
     * a query that matches nothing. Here the statement below REALLY attempts two
     * rows for one pair, and the index is what turns them into one — measured by
     * mutation: drop `UNIQUE` from the migration and both assertions go red.
     */
    expect(await findDuplicateAgentThreads(db)).toEqual([]);

    await db.execute(sql`
      insert into ${conversations} (id, oxy_user_id, conversation_id, title, agent_id)
      values ('dup-h-1', 'thread-owner-h', 'dup-h-1', 'one', 'agent-h'),
             ('dup-h-2', 'thread-owner-h', 'dup-h-2', 'two', 'agent-h')
      on conflict do nothing
    `);

    expect(await findDuplicateAgentThreads(db)).toEqual([]);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(sql`oxy_user_id = 'thread-owner-h'`);
    expect(n).toBeLessThanOrEqual(1);
  });
});

describe('breaks cut a permanent thread into conversations', () => {
  it('records marks in order and reads them back', async () => {
    const thread = await open('break-owner-a', 'agent-break-a');

    const first = await insertConversationBreak(db, 'break-owner-a', thread.conversationId);
    const second = await insertConversationBreak(db, 'break-owner-a', thread.conversationId);

    const marks = await listConversationBreaks(db, 'break-owner-a', thread.conversationId);
    expect(marks).toHaveLength(2);
    expect(marks.map((d) => d.getTime())).toEqual(
      [first, second].map((d) => d.getTime()).sort((a, b) => a - b),
    );
  });

  it('does not leak a mark into another person’s thread of the same name', async () => {
    // `conversation_id` is unique only WITHIN a person, so the owner is part of
    // every read — the same rule the messages table lives by.
    await db.execute(sql`
      insert into ${conversations} (id, oxy_user_id, conversation_id, title)
      values ('shared-name-1', 'break-owner-b', 'shared-name', 'mine'),
             ('shared-name-2', 'break-owner-c', 'shared-name', 'theirs')
    `);

    await insertConversationBreak(db, 'break-owner-b', 'shared-name');

    expect(await listConversationBreaks(db, 'break-owner-b', 'shared-name')).toHaveLength(1);
    expect(await listConversationBreaks(db, 'break-owner-c', 'shared-name')).toHaveLength(0);

    await deleteConversationBreaks(db, 'break-owner-b', 'shared-name');
    await deleteConversation(db, 'break-owner-b', 'shared-name');
    await deleteConversation(db, 'break-owner-c', 'shared-name');
  });

  it('clears every mark when a thread is deleted', async () => {
    const thread = await open('break-owner-d', 'agent-break-d');
    await insertConversationBreak(db, 'break-owner-d', thread.conversationId);

    const removed = await deleteConversationBreaks(db, 'break-owner-d', thread.conversationId);

    expect(removed).toBe(1);
    expect(await listConversationBreaks(db, 'break-owner-d', thread.conversationId)).toEqual([]);
  });
});
