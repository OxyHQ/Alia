import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The conversation lifecycle — epic #139 workstream 6, *"`/alia/chat` or its
 * successor remains responsible for … conversation lifecycle"*.
 *
 * ## Why this file drives the real handlers
 *
 * `routes/__tests__/conversations.test.ts` is a test of the MOCKS: it calls
 * `Conversation.create(...)` itself and asserts the mock was called with what it
 * just passed, and its list case re-implements the query chain the route builds
 * (`.select().sort().limit()`) rather than running the route's. Every assertion
 * in it holds with `routes/conversations.ts` deleted. That is left in place and
 * named here rather than quietly rewritten, because it is the reason this
 * checkbox could not be ticked on existing coverage.
 *
 * So the handlers are pulled off the real Express router and invoked, against an
 * in-memory store that applies whatever filter the handler passes. The
 * difference matters most for OWNERSHIP: a route that dropped `oxyUserId` from
 * its filter still passes a "was the mock called" test, and here it returns
 * somebody else's conversation, which is what it would do in production.
 *
 * The lifecycle asserted is the whole arc a chat turn walks:
 * create → the runtime persists a turn → read back → vote → delete, plus the
 * second user who must see none of it.
 */

interface Doc {
  [key: string]: unknown;
}

const H = vi.hoisted(() => ({
  conversations: [] as Doc[],
  messages: [] as Doc[],
  /** Monotonic, so `updatedAt` ordering is deterministic instead of clock-dependent. */
  tick: 0,
}));

/**
 * The subset of Mongo query syntax `routes/conversations.ts` actually builds.
 *
 * Deliberately narrow, and it THROWS on an operator it does not implement: a
 * silent "no match" for an unknown operator is how a store like this starts
 * answering the comfortable empty array to a query it never understood.
 */
function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      const branches = expected as Doc[];
      if (!branches.some((branch) => matches(doc, branch))) return false;
      continue;
    }
    const actual = doc[key];
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      for (const [op, operand] of Object.entries(expected as Doc)) {
        switch (op) {
          case '$lt':
            if (!(Number(actual) < Number(operand))) return false;
            break;
          case '$in':
            if (!(operand as unknown[]).includes(actual)) return false;
            break;
          case '$nin':
            if ((operand as unknown[]).includes(actual)) return false;
            break;
          default:
            throw new Error(`in-memory store does not implement ${op}`);
        }
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

/** A chainable find(), resolving to the filtered rows when awaited. */
function query(rows: Doc[]): Record<string, unknown> {
  let current = rows;
  const chain: Record<string, unknown> = {
    select: () => chain,
    lean: () => chain,
    sort: (spec: Record<string, number>) => {
      const [field, direction] = Object.entries(spec)[0] ?? ['_id', 1];
      current = [...current].sort(
        (a, b) => (Number(a[field] ?? 0) - Number(b[field] ?? 0)) * (direction < 0 ? -1 : 1),
      );
      return chain;
    },
    limit: (n: number) => {
      current = current.slice(0, n);
      return chain;
    },
    then: (resolve: (value: Doc[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(current).then(resolve, reject),
  };
  return chain;
}

vi.mock('mongoose', () => ({
  default: {
    isValidObjectId: (value: string) => /^[0-9a-f]{24}$/.test(value),
    Types: { ObjectId: class { constructor(readonly id: string) {} } },
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateTokenOrApiKey: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
}));

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

vi.mock('../../models/conversation.js', () => ({
  Conversation: {
    create: vi.fn(async (values: Doc) => {
      H.tick += 1;
      const doc = { ...values, createdAt: H.tick, updatedAt: H.tick };
      H.conversations.push(doc);
      return doc;
    }),
    find: vi.fn((filter: Doc) => query(H.conversations.filter((doc) => matches(doc, filter)))),
    findOne: vi.fn(async (filter: Doc) => H.conversations.find((doc) => matches(doc, filter)) ?? null),
    findOneAndUpdate: vi.fn(
      async (filter: Doc, update: { $set?: Doc; $setOnInsert?: Doc }, options?: { upsert?: boolean }) => {
        H.tick += 1;
        let doc = H.conversations.find((candidate) => matches(candidate, filter));
        if (!doc) {
          if (!options?.upsert) return null;
          doc = { ...filter, ...update.$setOnInsert, createdAt: H.tick };
          H.conversations.push(doc);
        }
        for (const [key, value] of Object.entries(update.$set ?? {})) {
          if (value !== undefined) doc[key] = value;
        }
        doc.updatedAt = H.tick;
        return doc;
      },
    ),
    deleteOne: vi.fn(async (filter: Doc) => {
      const before = H.conversations.length;
      H.conversations = H.conversations.filter((doc) => !matches(doc, filter));
      return { deletedCount: before - H.conversations.length };
    }),
  },
}));

vi.mock('../../models/message.js', () => ({
  Message: {
    find: vi.fn((filter: Doc) => query(H.messages.filter((doc) => matches(doc, filter)))),
    findOneAndUpdate: vi.fn(async (filter: Doc, update: { $set?: Doc; $unset?: Doc }) => {
      const doc = H.messages.find((candidate) => matches(candidate, filter));
      if (!doc) return null;
      Object.assign(doc, update.$set ?? {});
      for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
      return doc;
    }),
    insertMany: vi.fn(async (docs: Doc[]) => {
      H.messages.push(...docs);
      return docs;
    }),
    deleteMany: vi.fn(async (filter: Doc) => {
      const before = H.messages.length;
      H.messages = H.messages.filter((doc) => !matches(doc, filter));
      return { deletedCount: before - H.messages.length };
    }),
  },
}));

import conversationsRouter from '../conversations.js';

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
  req: { user?: { id: string }; params?: Record<string, string>; query?: Record<string, string>; body?: Doc },
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

const ALICE = { id: 'user-alice' };
const BOB = { id: 'user-bob' };

beforeEach(() => {
  H.conversations.length = 0;
  H.messages.length = 0;
  H.tick = 0;
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
    expect((read.body as { messages: Doc[] }).messages.map((m) => m.content)).toEqual([
      'what day is it',
      'It is Tuesday.',
    ]);

    const listed = await call('get', '/', { user: ALICE });
    expect((listed.body as { conversations: Doc[] }).conversations.map((c) => c.id)).toEqual([conversationId]);

    const removed = await call('delete', '/:id', { user: ALICE, params: { id: conversationId } });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ success: true });
    // Both collections. A delete that dropped only the conversation leaves the
    // messages orphaned — there is no foreign key to cascade
    // (`db/__tests__/chat.pgdb.test.ts`, "has no foreign key"), so the route is
    // the only thing that removes them, and orphaned message rows are the user's
    // own text surviving a delete they asked for.
    expect(H.conversations).toEqual([]);
    expect(H.messages).toEqual([]);
  });

  it('404s a delete of something that is not there, rather than reporting success', async () => {
    const removed = await call('delete', '/:id', { user: ALICE, params: { id: 'never-existed' } });
    expect(removed.status).toBe(404);
    expect(removed.body).toEqual({ error: 'Conversation not found' });
  });

  it('a save replaces the stored messages rather than appending to them', async () => {
    // `POST /` is the client's full-history upsert, and the app resends the whole
    // conversation. Appending here would double every message on a retry.
    const body = (messages: Doc[]): Doc => ({ conversationId: 'conv-replace', messages });
    await call('post', '/', { user: ALICE, body: body([{ role: 'user', content: 'first' }]) });
    await call('post', '/', {
      user: ALICE,
      body: body([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ]),
    });

    expect(H.messages.map((m) => m.content)).toEqual(['first', 'second']);
    // The floor: rows were really written, so the equality is not comparing two
    // empty arrays.
    expect(H.messages.length).toBe(2);
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
    expect(H.conversations).toHaveLength(1);
    expect(H.messages).toHaveLength(1);
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
    expect(H.messages[0].vote).toBe('up');
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
    // is what an unscoped `Message.deleteMany({ conversationId })` would do.
    expect(H.messages.filter((m) => m.oxyUserId === ALICE.id).map((m) => m.content)).toEqual([
      'a private answer',
    ]);
    expect(H.messages.filter((m) => m.oxyUserId === BOB.id).map((m) => m.content)).toEqual(['injected']);
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
