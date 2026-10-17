/**
 * The app a conversation started in (`domain/conversation.ts` `ORIGIN_APP_PATTERN`),
 * through the REAL handlers against a REAL Postgres: an embedding app labels the
 * conversation it starts, once, and lists only its own (`GET /conversations?app=`),
 * while a list without `app` is all of them — the Alia app's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
  authenticateTokenOrApiKey: vi.fn((_r: unknown, _s: unknown, next: () => void) => next()),
}));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: { agents: child, chat: child, general: child, v1: child, rateLimit: child },
  };
});
vi.mock('../../lib/s3.js', () => ({ uploadToS3: vi.fn(), deleteS3Objects: vi.fn(async () => 0) }));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { conversations, messages } from '../../db/schema/chat.js';
import { createConversation, findConversation } from '../../db/chat/conversationRepository.js';
import { saveConversation } from '../../lib/conversation-saver.js';
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

type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;
interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: Handler }> };
}
interface Recorded {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  routePath: string,
  req: { user: { id: string }; query?: Record<string, string>; body?: unknown },
): Promise<Recorded> {
  const layer = (conversationsRouter as unknown as { stack: RouteLayer[] }).stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods?.[method] === true,
  );
  const handlers = layer?.route?.stack ?? [];
  if (handlers.length === 0) throw new Error(`${method} ${routePath} is not mounted`);
  const recorded: Recorded = { status: 200, body: {} };
  const res = {
    status(code: number) {
      recorded.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      recorded.body = payload;
      return res;
    },
  };
  await handlers[handlers.length - 1].handle({ params: {}, query: {}, body: {}, ...req }, res);
  return recorded;
}

const SUITE = `origin-app-${process.pid}`;
const ALICE = { id: `${SUITE}-alice` };

async function list(query: Record<string, string> = {}) {
  const response = await call('get', '/', { user: ALICE, query });
  const rows = (response.body.conversations ?? []) as Array<{ id: string; app: string | null }>;
  return { status: response.status, ids: rows.map((row) => row.id).sort(), rows };
}

beforeEach(async () => {
  for (const table of [messages, conversations]) {
    await db.delete(table).where(sql`${table.oxyUserId} = ${ALICE.id}`);
  }
  await createConversation(db, {
    oxyUserId: ALICE.id,
    conversationId: 'in-alia',
    title: 'Alia',
    source: 'app',
  });
  await createConversation(db, {
    oxyUserId: ALICE.id,
    conversationId: 'in-homiio',
    title: 'Flats',
    source: 'app',
    agentId: `${SUITE}-sindi`,
    originApp: 'homiio',
  });
  await createConversation(db, {
    oxyUserId: ALICE.id,
    conversationId: 'in-mercaria',
    title: 'Shoes',
    source: 'app',
    originApp: 'mercaria',
  });
});

describe('GET /conversations?app=', () => {
  it("lists only the conversations started in that app, and says each one's app", async () => {
    const shopping = await list({ app: 'mercaria' });
    expect(shopping.ids).toEqual(['in-mercaria']);
    expect(shopping.rows[0]?.app).toBe('mercaria');
  });

  it('is every conversation without it — the Alia app', async () => {
    const all = await list();
    expect(all.ids).toEqual(['in-alia', 'in-homiio', 'in-mercaria']);
    expect(all.rows.find((row) => row.id === 'in-alia')?.app).toBeNull();
  });

  it('composes with agentId', async () => {
    expect((await list({ app: 'homiio', agentId: `${SUITE}-sindi` })).ids).toEqual(['in-homiio']);
    expect((await list({ app: 'mercaria', agentId: `${SUITE}-sindi` })).ids).toEqual([]);
  });

  it('refuses something that is not an app slug rather than ignoring it', async () => {
    expect((await list({ app: 'Mercaria' })).status).toBe(400);
    expect((await list({ app: '' })).status).toBe(400);
  });
});

describe('an app labels the conversation it starts, once', () => {
  it('POST /new stores the app it names', async () => {
    const created = await call('post', '/new', { user: ALICE, body: { app: 'mercaria' } });
    expect(created.status).toBe(200);
    expect(created.body.app).toBe('mercaria');
    expect((await list({ app: 'mercaria' })).ids).toContain(created.body.id);
  });

  it('POST / labels a conversation it creates and never relabels one that exists', async () => {
    const save = (conversationId: string, app: string) =>
      call('post', '/', {
        user: ALICE,
        body: { conversationId, app, messages: [{ role: 'user', content: 'hola' }] },
      });
    expect((await save('fresh', 'homiio')).body.app).toBe('homiio');
    expect((await save('in-mercaria', 'homiio')).body.app).toBe('mercaria');
    expect((await save('in-alia', 'homiio')).body.app).toBeNull();
  });

  it('a turn labels the conversation it creates from host.app, and only then', async () => {
    const turn = (conversationId: string) =>
      saveConversation({
        userId: ALICE.id,
        conversationId,
        messages: [{ role: 'user', content: 'zapatos' }],
        assistantResponse: 'Aquí tienes.',
        originApp: 'mercaria',
      });
    await turn('from-a-turn');
    await turn('in-homiio');
    expect((await findConversation(db, ALICE.id, 'from-a-turn'))?.originApp).toBe('mercaria');
    expect((await findConversation(db, ALICE.id, 'in-homiio'))?.originApp).toBe('homiio');
  });

  it('refuses an app that is not a slug, and stores nothing', async () => {
    const refused = await call('post', '/new', { user: ALICE, body: { app: 'not a slug' } });
    expect(refused.status).toBe(400);
    expect((await list()).ids).toHaveLength(3);
  });

  it('the database refuses one too, whoever writes it', async () => {
    await expect(
      createConversation(db, {
        oxyUserId: ALICE.id,
        conversationId: 'bad',
        title: 'x',
        source: 'app',
        originApp: 'Not_A_Slug',
      }),
    ).rejects.toThrow();
  });
});
