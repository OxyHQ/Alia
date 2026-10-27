/**
 * Sharing a conversation (`docs/agent-embedding.md` §6), through the REAL
 * handlers against a REAL Postgres: the owner mints a link, anybody holding it
 * reads the words, images, who said them and the canvas artifacts Alia drew —
 * never any other tool's input or output — until it expires or the owner
 * revokes it. And the conversation list narrows
 * to one agent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { sweepAllExpiredRows } from '@oxy.so/db/expiry';
import { TEST_CHARACTER } from '../../db/__tests__/support/agent-character';

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
// Oxy owns the agent's name; the link shows what Oxy would answer.
vi.mock('../../lib/agent-identity.js', () => ({
  attachAgentIdentity: async (agent: Record<string, unknown>) => ({
    ...agent,
    name: 'Sindi',
    handle: 'sindibot',
    color: 'teal',
    authorName: null,
  }),
  agentPromptName: (agent: { name: string | null }) => agent.name ?? 'Agent',
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { EXPIRY_TARGETS } from '../../db/expiryTargets.js';
import { agents } from '../../db/schema/agents.js';
import { conversations, conversationShares, messages } from '../../db/schema/chat.js';
import { createConversation } from '../../db/chat/conversationRepository.js';
import { replaceMessages } from '../../db/chat/messageRepository.js';
import { shareTokenHash } from '../../db/chat/conversationShareRepository.js';
import conversationsRouter from '../conversations.js';
import sharedRouter from '../shared.js';

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
  headers: Record<string, string>;
}

async function call(
  router: unknown,
  method: string,
  routePath: string,
  req: {
    user?: { id: string };
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<Recorded> {
  const layer = (router as { stack: RouteLayer[] }).stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods?.[method] === true,
  );
  const handlers = layer?.route?.stack ?? [];
  if (handlers.length === 0) throw new Error(`${method} ${routePath} is not mounted`);
  const recorded: Recorded = { status: 200, body: {}, headers: {} };
  const res = {
    status(code: number) {
      recorded.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      recorded.body = payload;
      return res;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
    },
  };
  await handlers[handlers.length - 1].handle({ params: {}, query: {}, body: {}, ...req }, res);
  return recorded;
}

const SUITE = `sharing-${process.pid}`;
const ALICE = { id: `${SUITE}-alice` };
const BOB = { id: `${SUITE}-bob` };
const AGENT_ID = `${SUITE}-sindi`;

async function share(user: { id: string }, conversationId: string, ttlHours: unknown = 24) {
  return call(conversationsRouter, 'post', '/:id/share', {
    user,
    params: { id: conversationId },
    body: { ttlHours },
  });
}
const read = (token: string) => call(sharedRouter, 'get', '/:token', { params: { token } });

beforeEach(async () => {
  for (const table of [messages, conversations, conversationShares]) {
    await db.delete(table).where(sql`${table.oxyUserId} in (${ALICE.id}, ${BOB.id})`);
  }
  await db.delete(agents).where(eq(agents.id, AGENT_ID));
  await db.insert(agents).values({
    id: AGENT_ID,
    oxyAccountId: `${SUITE}-sindi-bot`,
    character: TEST_CHARACTER,
    tagline: 'Your housing assistant',
    description: 'Homes',
    authorOxyUserId: 'homiio',
    category: 'housing',
  });
  await createConversation(db, {
    oxyUserId: ALICE.id,
    conversationId: 'c-sindi',
    title: 'Flats in Barcelona',
    source: 'app',
    agentId: AGENT_ID,
  });
  await replaceMessages(db, ALICE.id, 'c-sindi', [
    { role: 'system', content: 'You are Sindi.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Is this lease fair?' },
        { type: 'file', file: { file_id: 'lease', filename: 'lease.pdf' } },
        { type: 'image_url', image_url: { url: 'https://cdn.example/flat.jpg' } },
      ],
    },
    {
      role: 'assistant',
      content: 'I looked at your listings.',
      toolInvocations: [
        {
          toolCallId: 'call-1',
          toolName: 'oxy_homiio__searchListings',
          state: 'result',
          args: { q: 'my saved homes' },
          result: { listings: ['Private address, 3rd floor'] },
        },
        {
          toolCallId: 'call-2',
          toolName: 'canvas',
          state: 'result',
          args: { type: 'dashboard', title: 'Your shortlist', data: { widgets: [] } },
          result: {
            id: 'canvas-1',
            type: 'dashboard',
            title: 'Your shortlist',
            data: { widgets: [{ kind: 'stat', label: 'Average rent', value: '1,250 EUR' }] },
            message: 'Canvas component created',
          },
        },
        {
          toolCallId: 'call-3',
          toolName: 'host_astro__readTab',
          state: 'result',
          result: { status: 'applied', result: 'Tab text: my bank statement' },
        },
      ],
      agentInfo: {
        id: AGENT_ID,
        name: 'Sindi',
        handle: 'sindibot',
        color: 'teal',
        character: null,
      },
    },
  ]);
});

describe('a share link', () => {
  it('is minted for the owner, stored only as a hash, and read by anyone holding it', async () => {
    const minted = await share(ALICE, 'c-sindi', 48);
    expect(minted.status).toBe(201);
    const token = String(minted.body.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expiresIn = new Date(String(minted.body.expiresAt)).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(47 * 3600_000);
    expect(expiresIn).toBeLessThanOrEqual(48 * 3600_000);

    const [stored] = await db
      .select()
      .from(conversationShares)
      .where(eq(conversationShares.oxyUserId, ALICE.id));
    expect(stored.tokenHash).toBe(shareTokenHash(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    const shown = await read(token);
    expect(shown.status).toBe(200);
    expect(shown.headers['X-Robots-Tag']).toBe('noindex');
    expect(shown.body).toEqual({
      title: 'Flats in Barcelona',
      agent: {
        id: AGENT_ID,
        name: 'Sindi',
        handle: 'sindibot',
        color: 'teal',
        character: TEST_CHARACTER,
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Is this lease fair?' },
            { type: 'image_url', image_url: { url: 'https://cdn.example/flat.jpg' } },
          ],
        },
        {
          role: 'assistant',
          content: 'I looked at your listings.',
          agent: {
            id: AGENT_ID,
            name: 'Sindi',
            handle: 'sindibot',
            color: 'teal',
            character: null,
          },
          artifacts: [
            {
              id: 'call-2',
              type: 'dashboard',
              title: 'Your shortlist',
              data: { widgets: [{ kind: 'stat', label: 'Average rent', value: '1,250 EUR' }] },
            },
          ],
        },
      ],
      expiresAt: stored.expiresAt,
    });
    // The canvas artifact, and never another tool's input or output, a document or the system prompt.
    const text = JSON.stringify(shown.body);
    for (const leak of [
      'my saved homes',
      'Private address',
      'my bank statement',
      'lease.pdf',
      'You are Sindi',
      'canvas-1',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('is replaced by sharing again, and the old token opens nothing', async () => {
    const first = String((await share(ALICE, 'c-sindi')).body.token);
    const second = String((await share(ALICE, 'c-sindi')).body.token);
    expect(second).not.toBe(first);
    expect((await read(first)).status).toBe(404);
    expect((await read(second)).status).toBe(200);
  });

  it('stops working when revoked, artifacts included; revoking twice is a 404', async () => {
    const token = String((await share(ALICE, 'c-sindi')).body.token);
    const revoke = () =>
      call(conversationsRouter, 'delete', '/:id/share', { user: ALICE, params: { id: 'c-sindi' } });
    expect((await read(token)).body).toMatchObject({ messages: [{}, { artifacts: [{}] }] });
    expect((await revoke()).status).toBe(200);
    const gone = await read(token);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: 'Shared conversation not found' });
    expect(JSON.stringify(gone.body)).not.toContain('Average rent');
    expect((await revoke()).status).toBe(404);
  });

  it('stops working the moment it expires, and the sweep removes it', async () => {
    const token = String((await share(ALICE, 'c-sindi', 1)).body.token);
    await db
      .update(conversationShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(conversationShares.oxyUserId, ALICE.id));
    expect((await read(token)).status).toBe(404);
    await sweepAllExpiredRows(db, EXPIRY_TARGETS);
    expect(
      await db.select().from(conversationShares).where(eq(conversationShares.oxyUserId, ALICE.id)),
    ).toEqual([]);
  });

  it('goes with its conversation', async () => {
    const token = String((await share(ALICE, 'c-sindi')).body.token);
    await call(conversationsRouter, 'delete', '/:id', { user: ALICE, params: { id: 'c-sindi' } });
    expect((await read(token)).status).toBe(404);
    expect(
      await db.select().from(conversationShares).where(eq(conversationShares.oxyUserId, ALICE.id)),
    ).toEqual([]);
  });

  it("cannot be minted for somebody else's conversation", async () => {
    expect((await share(BOB, 'c-sindi')).status).toBe(404);
  });

  it.each([0, 169, 1.5, '24', null])('refuses ttlHours %s', async (ttlHours) => {
    expect((await share(ALICE, 'c-sindi', ttlHours)).status).toBe(400);
  });

  it('refuses a share without a lifetime', async () => {
    const missing = await call(conversationsRouter, 'post', '/:id/share', {
      user: ALICE,
      params: { id: 'c-sindi' },
      body: {},
    });
    expect(missing.status).toBe(400);
  });

  it('answers the same 404 to a token that was never minted or is not even shaped like one', async () => {
    expect((await read('A'.repeat(43))).status).toBe(404);
    expect((await read('short')).status).toBe(404);
  });
});

describe('GET /conversations?agentId=', () => {
  it("lists only the person's conversations with that agent", async () => {
    await createConversation(db, {
      oxyUserId: ALICE.id,
      conversationId: 'c-alia',
      title: 'Plain Alia',
      source: 'app',
    });
    await createConversation(db, {
      oxyUserId: BOB.id,
      conversationId: 'c-bob-sindi',
      title: "Bob's",
      source: 'app',
      agentId: AGENT_ID,
    });
    const list = (query: Record<string, string>) =>
      call(conversationsRouter, 'get', '/', { user: ALICE, query });

    const withSindi = await list({ agentId: AGENT_ID });
    expect((withSindi.body.conversations as Array<{ id: string }>).map((c) => c.id)).toEqual([
      'c-sindi',
    ]);
    const all = await list({});
    expect((all.body.conversations as Array<{ id: string }>).map((c) => c.id).sort()).toEqual([
      'c-alia',
      'c-sindi',
    ]);
    expect((await list({ agentId: '' })).status).toBe(400);
  });
});
