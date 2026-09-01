import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * The two inbound chat handlers in `routes/webhooks.ts`, against a REAL
 * Postgres server, for one property: **the reservation is charged or given
 * back, never neither.**
 *
 * ## What was wrong, and why nothing reported it
 *
 * Both handlers reserve a credit before they do anything, then walk a series of
 * exits that answer a problem by messaging the user and returning — no model
 * available, an exception anywhere — and none of them gave the credit back. A
 * Telegram user whose message arrived while every model was down was charged
 * for the apology.
 *
 * These handlers are fire-and-forget from the route: it acks the platform and
 * drops the promise. So there is no status code to assert and no caller to
 * observe. The balance is the only thing that records what happened, which is
 * both why the leak survived and why every case here reads it.
 *
 * ## The model layer is stubbed; the credits are not
 *
 * `resolveModel` and `generateText` stand for the outside world and are the two
 * things being made to fail. `reserveCredits`, `finalizeCredits` and
 * `refundReservation` run for real against the real table.
 */

vi.mock('@oxyhq/core/server', () => ({ verifySecret: vi.fn(() => false) }));
vi.mock('ai', () => ({
  generateText: vi.fn(async () => ({ text: 'an answer', usage: { inputTokens: 10, outputTokens: 10 } })),
  stepCountIs: vi.fn(() => 5),
}));
vi.mock('../../lib/channels/registry.js', () => ({ getChannel: vi.fn(() => null) }));
// The ONE assembler stands in for what `buildChatTools` used to: this file is
// about credit reservation on an inbound bot message, not about which tools a
// bot turn gets, and the real pipeline imports every tool module behind it.
vi.mock('../../lib/tool-pipeline.js', () => ({
  ToolPipeline: { forUser: vi.fn(async () => ({ tools: {}, toolNameMapping: new Map() })) },
}));
vi.mock('../../lib/agent-identity.js', () => ({
  attachAgentIdentity: vi.fn(async (agent: unknown) => agent),
}));
vi.mock('../../lib/channels/outbound.js', () => ({ sendChannelMessage: vi.fn(async () => undefined) }));
vi.mock('../../lib/prompt-loader.js', () => ({ loadPrompt: vi.fn(async () => 'be helpful') }));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { webhook: child, general: child, agents: child, chat: child, credits: child, v1: child, providers: child } };
});
vi.mock('../../lib/chat-core.js', () => ({
  resolveModel: vi.fn(async () => ({
    provider: 'stub',
    modelId: 'stub-1',
    keyConfig: { keyId: 'key-1' },
  })),
  getAIModel: vi.fn(() => ({})),
  reportModelUsage: vi.fn(async () => undefined),
  getDefaultRoutingProfile: vi.fn(() => 'kaana-lite'),
  // `credits-manager` reads the credit multiplier from this same module.
  getRoutingProfile: vi.fn(async () => ({ creditMultiplier: 1 })),
}));

import { generateText } from 'ai';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { userCredits } from '../../db/schema/billing.js';
import { getOrCreateUserCredits } from '../../db/billing/userCreditsRepository.js';
import { resolveModel } from '../../lib/chat-core.js';
import type { BotUserRow, InboundUserBotRow } from '../../db/integrations/botRepository.js';
import type { ChannelInboundMessage } from '../../lib/channels/types.js';
import { processAgentBotMessage, processChannelMessage } from '../webhooks.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Namespaced by pid — several `*.pgdb.test.ts` files share ONE database. */
const SUITE = `webhook-${process.pid}`;
let seq = 0;

async function account(free: number, paid: number): Promise<string> {
  const id = `${SUITE}-${seq++}`;
  await getOrCreateUserCredits(db, id);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: paid }).where(eq(userCredits.id, id));
  return id;
}

async function balanceOf(id: string): Promise<{ free: number; paid: number }> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
}

const message: ChannelInboundMessage = {
  platformUserId: 'tg-1',
  chatId: 'chat-1',
  text: 'hello there',
};

function linkedBotUser(oxyUserId: string): BotUserRow {
  return {
    id: `${SUITE}-botuser-${seq++}`,
    botId: `${SUITE}-bot`,
    platform: 'telegram',
    platformUserId: 'tg-1',
    chatId: 'chat-1',
    oxyUserId,
    isLinked: true,
    linkedAt: new Date(),
    username: null,
    displayName: null,
    authTokenExpiry: null,
    authTokenMode: null,
    // Set, so nothing has to write one to a row this fixture never inserted.
    conversationId: `${SUITE}-conv-${seq++}`,
    preferredModel: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function userOwnedBot(ownerUserId: string): InboundUserBotRow {
  return {
    _id: `${SUITE}-bot-${seq++}`,
    id: `${SUITE}-bot-${seq++}`,
    platform: 'telegram',
    botId: 'tg-bot',
    name: 'Helper',
    username: null,
    avatarUrl: null,
    status: 'active',
    userId: ownerUserId,
    agentId: null,
    defaultModel: null,
    totalUsers: 0,
    totalMessages: 0,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    botToken: 'token',
  };
}

describe('processChannelMessage — the system bot', () => {
  it('charges the turn when it answers', async () => {
    const userId = await account(100, 0);

    await processChannelMessage('telegram', linkedBotUser(userId), message);

    // The positive control. 20 tokens settles at the 1-credit minimum, which is
    // exactly what was reserved — so a handler that refunded unconditionally
    // would fail here and pass everything below.
    expect(await balanceOf(userId)).toEqual({ free: 99, paid: 0 });
  });

  it('gives the credit back when NO MODEL can be resolved', async () => {
    const userId = await account(100, 0);
    vi.mocked(resolveModel).mockResolvedValueOnce(null);

    await processChannelMessage('telegram', linkedBotUser(userId), message);

    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  it('gives the credit back when the model call THROWS', async () => {
    const userId = await account(100, 0);
    vi.mocked(generateText).mockRejectedValueOnce(new Error('every provider is down'));

    await processChannelMessage('telegram', linkedBotUser(userId), message);

    expect(await balanceOf(userId)).toEqual({ free: 100, paid: 0 });
  });

  it('gives a paid-funded credit back to the PAID balance', async () => {
    const userId = await account(0, 100);
    vi.mocked(resolveModel).mockResolvedValueOnce(null);

    await processChannelMessage('telegram', linkedBotUser(userId), message);

    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });
});

describe('processAgentBotMessage — a user-registered bot', () => {
  it("charges the OWNER's turn when it answers", async () => {
    const ownerId = await account(100, 0);

    await processAgentBotMessage(userOwnedBot(ownerId), linkedBotUser(ownerId), message, 'telegram');

    expect(await balanceOf(ownerId)).toEqual({ free: 99, paid: 0 });
  });

  it("gives the OWNER's credit back when NO MODEL can be resolved", async () => {
    const ownerId = await account(100, 0);
    vi.mocked(resolveModel).mockResolvedValueOnce(null);

    await processAgentBotMessage(userOwnedBot(ownerId), linkedBotUser(ownerId), message, 'telegram');

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });

  it("gives the OWNER's credit back when the model call THROWS", async () => {
    const ownerId = await account(100, 0);
    vi.mocked(generateText).mockRejectedValueOnce(new Error('every provider is down'));

    await processAgentBotMessage(userOwnedBot(ownerId), linkedBotUser(ownerId), message, 'telegram');

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });
});
