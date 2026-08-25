import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

/**
 * The conversation lifecycle — epic #139 workstream 6, *"`/alia/chat` or its
 * successor remains responsible for … conversation lifecycle"* — driven through
 * the REAL Express handlers against a REAL Postgres server.
 *
 * ## Why the handlers, and why a real database
 *
 * This file replaces a version that ran against a hand-written in-memory store
 * implementing the subset of Mongo query syntax the route happened to build. It
 * also replaces `routes/__tests__/conversations.test.ts`, which called
 * `Conversation.create(...)` itself and asserted the mock was called with what
 * it had just passed — every assertion in it held with `routes/conversations.ts`
 * deleted, which is why it is gone rather than ported.
 *
 * The store is now the database, because the properties this route depends on
 * are the ones only a server has: `ON CONFLICT` deciding insert-versus-update,
 * NULL ordering deciding what order a conversation renders in, a partial unique
 * deciding whether a concurrent save collides, and a CHECK deciding whether a
 * `source` is storable at all. A mocked `insert` accepts every statement,
 * including ones Postgres rejects outright, which is the class of bug a port
 * introduces.
 *
 * OWNERSHIP is what most of this is for: a route that dropped `oxyUserId` from a
 * filter passes any "was the mock called" test, and here it returns — or
 * destroys — somebody else's conversation.
 */

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateTokenOrApiKey: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
}));

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { conversations, messages } from '../../db/schema/chat.js';
import conversationsRouter from '../conversations.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  Driving the real router                                                    */
/* -------------------------------------------------------------------------- */

type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;

interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: Handler }>;
  };
}

/** The LAST handler on a route layer is the route's own, after its middleware. */
function handlerFor(method: string, routePath: string): Handler {
  const stack = (conversationsRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods?.[method] === true,
  );
  expect(layer?.route, `${method.toUpperCase()} ${routePath} is not mounted`).toBeDefined();
  const handlers = layer?.route?.stack ?? [];
  expect(handlers.length, `${method.toUpperCase()} ${routePath} has no handler`).toBeGreaterThan(0);
  return handlers[handlers.length - 1].handle;
}

interface Recorded {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function call(
  method: string,
  routePath: string,
  req: {
    user?: { id: string };
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  },
): Promise<Recorded> {
  const recorded: Recorded = { status: 200, body: undefined, headers: {} };
  const res = {
    status(code: number) {
      recorded.status = code;
      return res;
    },
    json(payload: unknown) {
      recorded.body = payload;
      return res;
    },
    send(payload: unknown) {
      recorded.body = payload;
      return res;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
    },
  };
  await handlerFor(method, routePath)({ params: {}, query: {}, body: {}, ...req }, res);
  return recorded;
}

/**
 * The accounts this file owns.
 *
 * Distinct per run, because the pgdb suite shares ONE database across every file
 * in it and `beforeEach` below deletes by these ids — a fixed pair would race a
 * sibling file that happened to pick the same name.
 */
const SUITE = `lifecycle-${process.pid}`;
const ALICE = { id: `${SUITE}-alice` };
const BOB = { id: `${SUITE}-bob` };

/** Every message and conversation belonging to this file's two accounts. */
async function storedMessages(oxyUserId?: string) {
  return db
    .select()
    .from(messages)
    .where(
      oxyUserId === undefined
        ? sql`${messages.oxyUserId} in (${ALICE.id}, ${BOB.id})`
        : eq(messages.oxyUserId, oxyUserId),
    )
    .orderBy(messages.oxyUserId, messages.seq);
}

async function storedConversations() {
  return db
    .select()
    .from(conversations)
    .where(sql`${conversations.oxyUserId} in (${ALICE.id}, ${BOB.id})`);
}

beforeEach(async () => {
  await db.delete(messages).where(sql`${messages.oxyUserId} in (${ALICE.id}, ${BOB.id})`);
  await db.delete(conversations).where(sql`${conversations.oxyUserId} in (${ALICE.id}, ${BOB.id})`);
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  The arc                                                                    */
/* -------------------------------------------------------------------------- */

describe('a conversation is created, filled, read back and destroyed (#139 ws6)', () => {
  it('walks the whole arc through the real handlers', async () => {
    // The body carries a `conversationId` the route must IGNORE. Asserting only
    // the uuid SHAPE of the result is vacuous — measured: a mutation making the
    // route honour `req.body.conversationId` left that version of this test
    // green, because a request that sends no id still gets a uuid back.
    const created = await call('post', '/new', {
      user: ALICE,
      body: { source: 'app', conversationId: 'client-chosen-id' },
    });
    expect(created.status).toBe(200);
    const conversationId = (created.body as { id: string }).id;
    // Minted server-side with `randomUUID()`, so a caller cannot claim an id
    // that is about to be someone else's half of the (user, id) unique pair.
    expect(conversationId).not.toBe('client-chosen-id');
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.body).toMatchObject({ title: 'New chat', source: 'app' });

    const saved = await call('post', '/', {
      user: ALICE,
      body: {
        conversationId,
        messages: [
          { role: 'user', content: 'what day is it' },
          { role: 'assistant', content: 'It is Tuesday.' },
        ],
      },
    });
    expect(saved.status).toBe(200);
    // No explicit title, so the row keeps the one it already had rather than
    // being renamed from the first message on every save.
    expect(saved.body).toMatchObject({ lastMessage: 'It is Tuesday.', title: 'New chat' });

    const read = await call('get', '/:id', { user: ALICE, params: { id: conversationId } });
    expect(read.status).toBe(200);
    expect((read.body as { messages: { content: unknown }[] }).messages.map((m) => m.content)).toEqual([
      'what day is it',
      'It is Tuesday.',
    ]);

    const listed = await call('get', '/', { user: ALICE });
    expect((listed.body as { conversations: { id: string }[] }).conversations.map((c) => c.id)).toEqual([
      conversationId,
    ]);

    const removed = await call('delete', '/:id', { user: ALICE, params: { id: conversationId } });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ success: true });
    // Both tables. A delete that dropped only the conversation leaves the
    // messages orphaned — there is no foreign key to cascade
    // (`db/__tests__/chat.pgdb.test.ts`, "has no foreign key"), so the route is
    // the only thing that removes them, and orphaned message rows are the user's
    // own text surviving a delete they asked for.
    expect(await storedConversations()).toEqual([]);
    expect(await storedMessages()).toEqual([]);
  });

  it('stores the messages in the CLIENT’s order, not the planner’s', async () => {
    /**
     * The port's sharpest edge. The source wrote these rows with no `seq` and
     * read them back ordered by it, which worked only because Mongo's natural
     * order approximates insertion order. Ten rows written in one statement,
     * every ORDER BY key tied, is exactly the shape Postgres is free to return
     * in any order — a conversation that renders scrambled with correct data in
     * every row. `replaceMessages` numbers them, which is what `seq` means.
     */
    const sent = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));

    await call('post', '/', { user: ALICE, body: { conversationId: 'ordered', messages: sent } });
    const read = await call('get', '/:id', { user: ALICE, params: { id: 'ordered' } });

    expect((read.body as { messages: { content: unknown }[] }).messages.map((m) => m.content)).toEqual(
      sent.map((m) => m.content),
    );
    // The floor: ten rows were really written, so the equality is not comparing
    // two empty arrays.
    expect((await storedMessages(ALICE.id)).length).toBe(10);
  });

  it('404s a delete of something that is not there, rather than reporting success', async () => {
    const removed = await call('delete', '/:id', { user: ALICE, params: { id: 'never-existed' } });
    expect(removed.status).toBe(404);
    expect(removed.body).toEqual({ error: 'Conversation not found' });
  });

  it('a save replaces the stored messages rather than appending to them', async () => {
    // `POST /` is the client's full-history upsert, and the app resends the whole
    // conversation. Appending here would double every message on a retry.
    const body = (list: Record<string, unknown>[]) => ({ conversationId: 'conv-replace', messages: list });
    await call('post', '/', { user: ALICE, body: body([{ role: 'user', content: 'first' }]) });
    await call('post', '/', {
      user: ALICE,
      body: body([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ]),
    });

    expect((await storedMessages(ALICE.id)).map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('keeps a user rename and does not overwrite it from the next message', async () => {
    await call('post', '/', {
      user: ALICE,
      body: { conversationId: 'conv-named', title: 'My renamed chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    const after = await call('post', '/', {
      user: ALICE,
      body: { conversationId: 'conv-named', messages: [{ role: 'user', content: 'a completely different topic' }] },
    });

    expect((after.body as { title: string }).title).toBe('My renamed chat');
  });

  it('keeps the sidebar preview when a save carries no messages', async () => {
    /**
     * `$set: { lastMessage: undefined }` was a no-op in Mongo and writes NULL in
     * Postgres, and this request is how a client produces it. The failure is a
     * thread whose preview blanks out with everything else intact.
     */
    await call('post', '/', {
      user: ALICE,
      body: { conversationId: 'conv-empty', messages: [{ role: 'assistant', content: 'the preview' }] },
    });
    const after = await call('post', '/', { user: ALICE, body: { conversationId: 'conv-empty', messages: [] } });

    expect((after.body as { lastMessage: string }).lastMessage).toBe('the preview');
  });

  it('refuses an unparseable cursor instead of failing the whole request', async () => {
    const bad = await call('get', '/', { user: ALICE, query: { cursor: 'not-a-date' } });
    expect(bad.status).toBe(400);
    // The control: the same route with no cursor answers 200, so the 400 is
    // about the cursor rather than about the route being broken.
    expect((await call('get', '/', { user: ALICE })).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  What a client may write                                                    */
/* -------------------------------------------------------------------------- */

describe('POST / takes a whitelist, never the body (#139 ws6)', () => {
  it('ignores ownership, ordering and vote fields a client sends', async () => {
    /**
     * The Mongoose schema WAS the whitelist: unknown keys were stripped and the
     * sub-schemas cast. `content` and `tool_invocations` are `jsonb` now and
     * enforce nothing, so a `{ ...m }` would store `oxyUserId`, `seq` and `vote`
     * straight from the request — respectively somebody else's ownership, the
     * render order, and a feedback signal the product reads.
     *
     * TWO layers hold this and the test asserts the END STATE of both, which is
     * worth saying out loud: `messageFromBody` in the route names the fields it
     * takes, and `toInsert` in the repository names the columns it writes.
     * Measured: mutating EITHER one alone to spread leaves this case green,
     * because the other still filters. The cases below are what catch a bypass
     * of the route's layer on its own — an unrecognised `role`, a partial
     * `agentInfo`, a tool invocation with an invented `state`.
     */
    await call('post', '/', {
      user: ALICE,
      body: {
        conversationId: 'conv-whitelist',
        messages: [
          {
            role: 'user',
            content: 'hello',
            id: 'client-1',
            oxyUserId: BOB.id,
            conversationId: 'somebody-elses',
            seq: 99,
            vote: 'up',
            audioUrl: 'https://attacker.test/a.mp3',
          },
        ],
      },
    });

    const [row] = await storedMessages(ALICE.id);
    expect(row.oxyUserId).toBe(ALICE.id);
    expect(row.conversationId).toBe('conv-whitelist');
    expect(row.seq).toBe(0);
    expect(row.vote).toBeNull();
    expect(row.audioUrl).toBeNull();
    // The one client-supplied identifier that IS taken, so the assertions above
    // are not just describing a message that failed to save.
    expect(row.clientMessageId).toBe('client-1');
  });

  it('drops a message whose role is outside the tuple, rather than 500ing on the CHECK', async () => {
    /**
     * A behaviour change, and the direction is deliberate. The source filtered
     * on `msg.role` being truthy alone, so `role: 'moderator'` reached Mongoose,
     * failed validation and turned the WHOLE save into a 500 — with the valid
     * messages of an `ordered: false` bulk write already stored. Here the
     * unrecognised message is dropped and the rest are saved as one transaction.
     *
     * Without the route's check the CHECK constraint answers instead, and the
     * request is a 500 with nothing written. That is what this catches.
     */
    const saved = await call('post', '/', {
      user: ALICE,
      body: {
        conversationId: 'conv-role',
        messages: [
          { role: 'user', content: 'kept' },
          { role: 'moderator', content: 'not a role this schema has' },
        ],
      },
    });

    expect(saved.status).toBe(200);
    expect((await storedMessages(ALICE.id)).map((m) => m.role)).toEqual(['user']);
  });

  it('drops a half-built agentInfo instead of writing three columns of a four-column shape', async () => {
    /**
     * `agent_info` is four columns, and `toStoredMessage` reassembles the
     * sub-document from `agent_info_id` alone. A row carrying an id and nothing
     * else comes back as `{ id, name: '', color: null, handle: '' }` — an agent
     * attribution with no agent, rendered as a blank name beside a message.
     */
    await call('post', '/', {
      user: ALICE,
      body: {
        conversationId: 'conv-agentinfo',
        messages: [{ role: 'assistant', content: 'x', agentInfo: { id: 'a1' } }],
      },
    });

    const [row] = await storedMessages(ALICE.id);
    expect(row.agentInfoId).toBeNull();
  });

  it('drops a tool invocation whose state is outside the tuple', async () => {
    /**
     * Mongoose validated this sub-schema `enum`, and `insertMany` DOES run
     * validators — so unlike most of the validators this port met, it really
     * fired. `tool_invocations` is `jsonb` and cannot carry a CHECK, so the
     * enforcement moved to the route.
     */
    await call('post', '/', {
      user: ALICE,
      body: {
        conversationId: 'conv-tools',
        messages: [
          {
            role: 'assistant',
            content: 'done',
            toolInvocations: [
              { toolCallId: 't1', toolName: 'search', state: 'result', result: { ok: true } },
              { toolCallId: 't2', toolName: 'search', state: 'exfiltrate' },
              { toolCallId: 't3' },
            ],
          },
        ],
      },
    });

    const [row] = await storedMessages(ALICE.id);
    expect(row.toolInvocations).toEqual([
      { toolCallId: 't1', toolName: 'search', state: 'result', result: { ok: true } },
    ]);
  });

  it('stores a multi-part body, which the source could not save at all', async () => {
    /**
     * A behaviour CHANGE, stated rather than discovered. The source built the
     * preview with `content?.slice(0, 100)`, which on an array is
     * `Array.prototype.slice` — a parts array assigned to a `String` path, which
     * Mongoose refused with a CastError and turned into a 500 for the whole
     * save. So a conversation whose last message had an image could not be
     * persisted. Here the preview is skipped and the message is stored.
     */
    const saved = await call('post', '/', {
      user: ALICE,
      body: {
        conversationId: 'conv-parts',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', url: 'x' }] }],
      },
    });

    expect(saved.status).toBe(200);
    expect((await storedMessages(ALICE.id))[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', url: 'x' },
    ]);
    /**
     * And the preview is SKIPPED rather than filled with whatever slicing an
     * array produces. Without this the source's `content?.slice(0, 100)` ports
     * to something that stores a rendered array in a `text` column and every
     * assertion above still passes.
     */
    expect((await storedConversations())[0].lastMessage).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Ownership                                                                  */
/* -------------------------------------------------------------------------- */

describe('every stage of the lifecycle is scoped to the owner (#139 ws6)', () => {
  /** Alice's conversation with one message, built through the real routes. */
  const seed = async (): Promise<string> => {
    const created = await call('post', '/new', { user: ALICE, body: {} });
    const conversationId = (created.body as { id: string }).id;
    await call('post', '/', {
      user: ALICE,
      body: {
        conversationId,
        messages: [{ id: 'msg-1', role: 'assistant', content: 'a private answer' }],
      },
    });
    return conversationId;
  };

  it('does not let a second user read it', async () => {
    const conversationId = await seed();

    const mine = await call('get', '/:id', { user: ALICE, params: { id: conversationId } });
    const theirs = await call('get', '/:id', { user: BOB, params: { id: conversationId } });

    // The positive control sits beside the negative one on purpose: 404 is also
    // what a broken store answers to everybody, and the pair tells them apart.
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual({ error: 'Conversation not found' });
  });

  it('does not let a second user list it', async () => {
    await seed();

    expect((await call('get', '/', { user: ALICE })).body).toMatchObject({ hasMore: false });
    expect((await call('get', '/', { user: ALICE })).body).toHaveProperty('conversations.0');
    expect((await call('get', '/', { user: BOB })).body).toMatchObject({ conversations: [], hasMore: false });
  });

  it('does not let a second user delete it', async () => {
    const conversationId = await seed();

    const theirs = await call('delete', '/:id', { user: BOB, params: { id: conversationId } });
    expect(theirs.status).toBe(404);
    // And nothing was destroyed on the way to that 404 — the conversation and
    // its message both survive. A route that scoped the conversation delete but
    // not the message delete would still answer 404 here.
    expect(await storedConversations()).toHaveLength(1);
    expect(await storedMessages()).toHaveLength(1);
  });

  it('does not let a second user vote on its messages', async () => {
    const conversationId = await seed();

    const mine = await call('patch', '/:id/messages/:messageId/vote', {
      user: ALICE,
      params: { id: conversationId, messageId: 'msg-1' },
      body: { vote: 'up' },
    });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ success: true, vote: 'up' });

    const theirs = await call('patch', '/:id/messages/:messageId/vote', {
      user: BOB,
      params: { id: conversationId, messageId: 'msg-1' },
      body: { vote: 'down' },
    });
    expect(theirs.status).toBe(404);
    // The vote Alice cast is still hers.
    expect((await storedMessages(ALICE.id))[0].vote).toBe('up');
  });

  it('does not let a second user write into it', async () => {
    const conversationId = await seed();

    await call('post', '/', {
      user: BOB,
      body: { conversationId, messages: [{ role: 'user', content: 'injected' }] },
    });

    // Bob's write created BOB's own row under the same client-chosen id — the
    // (user, id) pair is the identity — and left Alice's untouched. The failure
    // this rules out is the other one: Bob's messages replacing Alice's, which
    // is what an unscoped delete inside `replaceMessages` would do.
    expect((await storedMessages(ALICE.id)).map((m) => m.content)).toEqual(['a private answer']);
    expect((await storedMessages(BOB.id)).map((m) => m.content)).toEqual(['injected']);
  });

  it('refuses an unauthenticated caller on every route it mounts', async () => {
    // The map, and it is exact rather than a sample: a new route added to this
    // router without the `req.user?.id` check fails the equality below before
    // anybody has to remember to write a test for it.
    const stack = (conversationsRouter as unknown as { stack: RouteLayer[] }).stack;
    const mounted = stack
      .filter((entry) => entry.route)
      .flatMap((entry) =>
        Object.keys(entry.route?.methods ?? {}).map((method) => [method, entry.route?.path ?? ''] as const),
      )
      .sort();

    expect(mounted).toEqual(
      [
        ['post', '/new'],
        ['get', '/'],
        ['get', '/:id'],
        ['post', '/'],
        ['patch', '/:id/messages/:messageId/vote'],
        ['delete', '/:id'],
      ].sort(),
    );

    for (const [method, routePath] of mounted) {
      const anonymous = await call(method, routePath, {
        params: { id: 'x', messageId: 'y' },
        body: { conversationId: 'x', messages: [], vote: 'up' },
      });
      expect(anonymous.status, `${method.toUpperCase()} ${routePath} served an anonymous caller`).toBe(401);
    }
  });
});
