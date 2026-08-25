/**
 * A thread with an agent is MANY conversations, read as one — against a real
 * server, because every property here is the database's.
 *
 * ## The property this file exists for, and the one it replaced
 *
 * An earlier version of this feature made `(oxy_user_id, agent_id)` UNIQUE and
 * this file asserted that opening the thread twice answered the same row. That
 * was the wrong model, and the reason is worth stating where the test is:
 * **what the model is given as context is the ACTIVE conversation, not the
 * whole thread**, so starting a new stretch is what keeps that context bounded.
 * One row forever grows it without limit and makes "start a new conversation" a
 * line that draws and changes nothing.
 *
 * So the first assertion below is the exact inverse of the old one: a person may
 * hold MANY conversations with one agent, and the thread is all of them in
 * order. It goes red against 0046's unique index, which is what 0048 removes.
 *
 * ## What has not changed, and must not
 *
 * **Two people talking to one agent see two histories.** A read keyed on
 * `agent_id` alone passes every single-user test ever written and shows one
 * person another person's conversation. It is one missing `AND` away at all
 * times, and it is now three reads rather than one, so it is asserted on each.
 *
 * Every account, agent and conversation id is unique to its test: the pgdb suite
 * shares one database across every file in it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { conversations } from '../schema/chat';
import {
  createConversation,
  findActiveThreadConversation,
  latestMessagePerAgent,
  listThreadConversations,
} from '../chat/conversationRepository';
import {
  decodeThreadCursor,
  encodeThreadCursor,
  insertMessages,
  listThreadPage,
  listThreadWindow,
  searchThread,
} from '../chat/messageRepository';

let db: ApiDatabase;

const SUITE = `thread-${process.pid}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/** A stretch of a thread: an ordinary conversation carrying the agent. */
async function stretch(oxyUserId: string, agentId: string, id: string, createdAt: string) {
  await db.execute(sql`
    insert into ${conversations} (id, oxy_user_id, conversation_id, title, agent_id, created_at)
    values (${`${id}-row`}, ${oxyUserId}, ${id}, 'New chat', ${agentId}, ${createdAt})
  `);
  return id;
}

/** One turn, at a stated instant, so ordering is a fact rather than a race. */
async function say(
  oxyUserId: string,
  conversationId: string,
  seq: number,
  content: string,
  at: string,
  role: 'user' | 'assistant' = 'user',
) {
  await insertMessages(db, [
    { conversationId, oxyUserId, role, content, seq, createdAt: new Date(at) },
  ]);
}

describe('a person may hold many conversations with one agent', () => {
  it('accepts a second conversation for the same pair', async () => {
    // The inverse of what the unique index enforced. Red against 0046, which is
    // exactly what 0048 exists to take back out.
    const user = `${SUITE}-many`;
    await stretch(user, 'agent-many', `${SUITE}-m1`, '2026-08-01T10:00:00Z');
    await stretch(user, 'agent-many', `${SUITE}-m2`, '2026-08-01T11:00:00Z');
    await stretch(user, 'agent-many', `${SUITE}-m3`, '2026-08-01T12:00:00Z');

    const spine = await listThreadConversations(db, user, 'agent-many');

    expect(spine.map((c) => c.conversationId)).toEqual([
      `${SUITE}-m1`,
      `${SUITE}-m2`,
      `${SUITE}-m3`,
    ]);
  });

  it('answers the NEWEST conversation as the active one', async () => {
    // What `/a/:username` sends to. Not the oldest, and not "the" one — a
    // thread has no single row.
    const user = `${SUITE}-active`;
    await stretch(user, 'agent-active', `${SUITE}-a1`, '2026-08-01T10:00:00Z');
    await stretch(user, 'agent-active', `${SUITE}-a2`, '2026-08-01T12:00:00Z');
    await stretch(user, 'agent-active', `${SUITE}-a3`, '2026-08-01T11:00:00Z');

    const active = await findActiveThreadConversation(db, user, 'agent-active');

    expect(active?.conversationId).toBe(`${SUITE}-a2`);
  });

  it('answers nothing when the two have never spoken', async () => {
    expect(await findActiveThreadConversation(db, `${SUITE}-never`, 'agent-never')).toBeUndefined();
  });

  it('does not treat an ordinary conversation as part of any thread', async () => {
    // Every conversation that is not an agent's carries a NULL `agent_id`, and
    // there are far more of those than of these.
    const user = `${SUITE}-plain`;
    await createConversation(db, {
      oxyUserId: user,
      conversationId: `${SUITE}-plain-1`,
      title: 'New chat',
      source: 'app',
    });

    expect(await listThreadConversations(db, user, 'agent-plain')).toEqual([]);
    expect(await findActiveThreadConversation(db, user, 'agent-plain')).toBeUndefined();
  });
});

describe('the thread reads as one history across the seams', () => {
  const user = `${SUITE}-read`;
  const agent = 'agent-read';

  beforeAll(async () => {
    // Two stretches. The seam is between turn 2 and turn 3, and nothing records
    // it — it is deduced from which conversation each message is in.
    await stretch(user, agent, `${SUITE}-r1`, '2026-08-01T10:00:00Z');
    await stretch(user, agent, `${SUITE}-r2`, '2026-08-01T12:00:00Z');
    await say(user, `${SUITE}-r1`, 0, 'one', '2026-08-01T10:00:00Z');
    await say(user, `${SUITE}-r1`, 1, 'two', '2026-08-01T10:00:01Z', 'assistant');
    await say(user, `${SUITE}-r2`, 0, 'three', '2026-08-01T12:00:00Z');
    await say(user, `${SUITE}-r2`, 1, 'four', '2026-08-01T12:00:01Z', 'assistant');
  });

  it('serves every message of every stretch, oldest first', async () => {
    const page = await listThreadPage(db, { oxyUserId: user, agentId: agent, limit: 10 });

    expect(page.messages.map((m) => m.content)).toEqual(['one', 'two', 'three', 'four']);
    expect(page.hasMore).toBe(false);
  });

  it('says which stretch each message is in, which IS the seam', async () => {
    const page = await listThreadPage(db, { oxyUserId: user, agentId: agent, limit: 10 });

    expect(page.messages.map((m) => m.threadConversationId)).toEqual([
      `${SUITE}-r1`,
      `${SUITE}-r1`,
      `${SUITE}-r2`,
      `${SUITE}-r2`,
    ]);
  });

  it('pages backwards across a seam without repeating or skipping', async () => {
    const newest = await listThreadPage(db, { oxyUserId: user, agentId: agent, limit: 2 });
    expect(newest.messages.map((m) => m.content)).toEqual(['three', 'four']);
    expect(newest.hasMore).toBe(true);

    const oldest = newest.messages[0];
    const older = await listThreadPage(db, {
      oxyUserId: user,
      agentId: agent,
      limit: 2,
      before: { at: oldest.createdAt, id: oldest.id },
    });

    // The page BEFORE the seam. Not one of these was in the page above, and
    // nothing between them was dropped.
    expect(older.messages.map((m) => m.content)).toEqual(['one', 'two']);
    expect(older.hasMore).toBe(false);
  });

  it('reports hasMore from a fetched row, not from the page being full', async () => {
    // The boundary `messages.length < limit` gets wrong: a thread whose length
    // is an exact multiple of the page size. Four messages, page of four.
    const exact = await listThreadPage(db, { oxyUserId: user, agentId: agent, limit: 4 });

    expect(exact.messages).toHaveLength(4);
    expect(exact.hasMore).toBe(false);
  });

  it('does not read another person’s thread with the same agent', async () => {
    await stretch(`${SUITE}-other`, agent, `${SUITE}-o1`, '2026-08-01T10:00:00Z');
    await say(`${SUITE}-other`, `${SUITE}-o1`, 0, 'not yours', '2026-08-01T10:00:00Z');

    const mine = await listThreadPage(db, { oxyUserId: user, agentId: agent, limit: 50 });
    expect(mine.messages.map((m) => m.content)).not.toContain('not yours');

    // The control: it really is there, under the same agent.
    const theirs = await listThreadPage(db, {
      oxyUserId: `${SUITE}-other`,
      agentId: agent,
      limit: 50,
    });
    expect(theirs.messages.map((m) => m.content)).toEqual(['not yours']);
  });
});

describe('a search hit can be jumped to, however far back it lives', () => {
  const user = `${SUITE}-jump`;
  const agent = 'agent-jump';

  beforeAll(async () => {
    // Three stretches; the needle is in the FIRST, so reaching it means
    // crossing two seams.
    for (const [n, at] of [
      [1, '2026-08-01T10:00:00Z'],
      [2, '2026-08-02T10:00:00Z'],
      [3, '2026-08-03T10:00:00Z'],
    ] as const) {
      await stretch(user, agent, `${SUITE}-j${n}`, at);
    }
    await say(user, `${SUITE}-j1`, 0, 'the codename is kingfisher', '2026-08-01T10:00:00Z');
    for (let i = 0; i < 40; i++) {
      await say(
        user,
        `${SUITE}-j${i < 20 ? 2 : 3}`,
        i,
        `filler ${i}`,
        new Date(Date.parse('2026-08-02T10:00:00Z') + i * 60_000).toISOString(),
      );
    }
  });

  it('finds it across the whole thread, not just the active stretch', async () => {
    const hits = await searchThread(db, { oxyUserId: user, agentId: agent, query: 'kingfisher', limit: 10 });

    expect(hits).toHaveLength(1);
    expect(hits[0].conversationId).toBe(`${SUITE}-j1`);
  });

  /**
   * The property the lead made non-negotiable, end to end: take a hit's cursor,
   * feed it to the pagination, and the message is IN the answer.
   *
   * It cannot be served by `before`, which is exclusive — the hit would be the
   * one message missing from the window meant to reveal it. That is why `at`
   * exists and why this test would fail against a single-parameter design.
   */
  it('opens the window CONTAINING the hit when its cursor is fed back', async () => {
    const [hit] = await searchThread(db, {
      oxyUserId: user,
      agentId: agent,
      query: 'kingfisher',
      limit: 10,
    });
    const cursor = encodeThreadCursor({ at: hit.createdAt, id: hit.id });

    const decoded = decodeThreadCursor(cursor);
    expect(decoded).not.toBeNull();

    const window = await listThreadWindow(db, {
      oxyUserId: user,
      agentId: agent,
      limit: 10,
      at: decoded!,
    });

    expect(window.messages.map((m) => m.content)).toContain('the codename is kingfisher');
  });

  it('does not find another person’s thread', async () => {
    await stretch(`${SUITE}-jump-other`, agent, `${SUITE}-jo1`, '2026-08-01T10:00:00Z');
    await say(`${SUITE}-jump-other`, `${SUITE}-jo1`, 0, 'kingfisher is mine', '2026-08-01T10:00:00Z');

    const hits = await searchThread(db, { oxyUserId: user, agentId: agent, query: 'kingfisher', limit: 10 });

    expect(hits.map((h) => h.text)).not.toContain('kingfisher is mine');
    expect(hits).toHaveLength(1);
  });
});

describe('the cursor is opaque, and refuses what it cannot read', () => {
  it('round-trips an instant and an id', () => {
    const at = new Date('2026-08-01T10:00:00.123Z');
    const decoded = decodeThreadCursor(encodeThreadCursor({ at, id: 'row-1' }));

    expect(decoded?.at.toISOString()).toBe(at.toISOString());
    expect(decoded?.id).toBe('row-1');
  });

  it('answers null for anything malformed, rather than throwing', () => {
    // Client input. Each of these is a different way a cursor arrives broken,
    // and every one must be a 400 rather than a 500.
    for (const bad of ['', 'not-base64!!', Buffer.from('{}').toString('base64url'), Buffer.from('{"at":"nope","id":"x"}').toString('base64url'), Buffer.from('[]').toString('base64url')]) {
      expect(decodeThreadCursor(bad)).toBeNull();
    }
  });

  it('does not encode `seq`, which is why it can cross a seam', () => {
    // `seq` is absent on legacy rows AND unique only within a conversation, so
    // a cursor carrying it could neither page a legacy thread nor order one
    // that spans stretches. Read the payload to be sure it is not in there.
    const encoded = encodeThreadCursor({ at: new Date('2026-08-01T10:00:00Z'), id: 'row-1' });
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');

    expect(payload).not.toContain('seq');
    expect(JSON.parse(payload)).toEqual({ at: '2026-08-01T10:00:00.000Z', id: 'row-1' });
  });
});

/**
 * What the sidebar puts under an agent's name.
 *
 * The row reads like a chat, so it needs the last thing said — and the obvious
 * way to get it, one query per agent, is the N+1 this function exists to
 * replace. So the properties are: one statement for the whole list, the NEWEST
 * line per agent, and the reader's own thread rather than the agent's busiest
 * stranger's.
 */
describe('the last line of each agent thread', () => {
  /** A stretch that has been spoken in: `last_message` is what the row shows. */
  async function spokenStretch(
    oxyUserId: string,
    agentId: string,
    id: string,
    lastMessage: string,
    updatedAt: string,
  ) {
    await db.execute(sql`
      insert into ${conversations}
        (id, oxy_user_id, conversation_id, title, agent_id, last_message, created_at, updated_at)
      values
        (${`${id}-row`}, ${oxyUserId}, ${id}, 'New chat', ${agentId},
         ${lastMessage}, ${updatedAt}, ${updatedAt})
    `);
  }

  it('answers the newest line for each agent, in one statement', async () => {
    const user = `${SUITE}-latest`;
    await spokenStretch(user, `${SUITE}-a`, `${SUITE}-l1`, 'older with A', '2026-08-01T10:00:00Z');
    await spokenStretch(user, `${SUITE}-a`, `${SUITE}-l2`, 'newest with A', '2026-08-01T12:00:00Z');
    await spokenStretch(user, `${SUITE}-b`, `${SUITE}-l3`, 'only line with B', '2026-08-01T11:00:00Z');

    const rows = await latestMessagePerAgent(db, user, [`${SUITE}-a`, `${SUITE}-b`]);

    // One row per agent, not one per conversation — three stretches, two rows.
    expect(rows).toHaveLength(2);
    const byAgent = new Map(rows.map((row) => [row.agentId, row.lastMessage]));
    expect(byAgent.get(`${SUITE}-a`)).toBe('newest with A');
    expect(byAgent.get(`${SUITE}-b`)).toBe('only line with B');
  });

  it('shows each person their OWN last line, not the agent’s latest with anyone', async () => {
    // The missing `AND` that passes every single-user test ever written and
    // shows one person another person's conversation.
    const mine = `${SUITE}-mine`;
    const theirs = `${SUITE}-theirs`;
    const agent = `${SUITE}-shared`;
    await spokenStretch(mine, agent, `${SUITE}-s1`, 'what I said', '2026-08-01T10:00:00Z');
    await spokenStretch(theirs, agent, `${SUITE}-s2`, 'what they said', '2026-08-01T23:00:00Z');

    const rows = await latestMessagePerAgent(db, mine, [agent]);

    // Theirs is newer, so a query keyed on the agent alone would answer it.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastMessage).toBe('what I said');
  });

  it('leaves out an agent nobody has spoken to, rather than inventing a line', async () => {
    // The ordinary case a second after you make one. The row still renders —
    // the client supplies its own empty line — but the database says nothing.
    const user = `${SUITE}-quiet`;
    await spokenStretch(user, `${SUITE}-spoken`, `${SUITE}-q1`, 'hello', '2026-08-01T10:00:00Z');

    const rows = await latestMessagePerAgent(db, user, [`${SUITE}-spoken`, `${SUITE}-never`]);

    expect(rows.map((row) => row.agentId)).toEqual([`${SUITE}-spoken`]);
  });

  it('asks nothing at all when the person owns no agents', async () => {
    // A brand new account, and `IN ()` is not a query.
    expect(await latestMessagePerAgent(db, `${SUITE}-none`, [])).toEqual([]);
  });
});
