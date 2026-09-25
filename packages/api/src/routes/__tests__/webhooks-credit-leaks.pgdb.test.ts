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
 * `resolveStoredModel` and `generateText` stand for the outside world and are the two
 * things being made to fail. `reserveCredits`, `finalizeCredits` and
 * `refundReservation` run for real against the real table.
 */

vi.mock('@oxy.so/core/server', () => ({ verifySecret: vi.fn(() => false) }));
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
  agentPromptName: vi.fn(() => 'Agent'),
}));
vi.mock('../../lib/channels/outbound.js', () => ({ sendChannelMessage: vi.fn(async () => undefined) }));
vi.mock('../../lib/prompt-loader.js', () => ({ loadPrompt: vi.fn(async () => 'be helpful') }));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { webhook: child, general: child, agents: child, chat: child, credits: child, v1: child, providers: child } };
});
vi.mock('../../lib/chat-core.js', () => ({
  resolveStoredModel: vi.fn(async () => ({
    provider: 'kaana',
    modelId: 'acme/stub-1',
    oxyInferenceTarget: { kind: 'model', model: 'acme/stub-1' },
  })),
  getAIModel: vi.fn(() => ({})),
}));

import { generateText } from 'ai';
import { sendChannelMessage } from '../../lib/channels/outbound.js';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../db/index.js';
import { agents } from '../../db/schema/agents.js';
import { userCredits } from '../../db/schema/billing.js';
import { getOrCreateUserCredits } from '../../db/billing/userCreditsRepository.js';
import { resolveStoredModel } from '../../lib/chat-core.js';
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
    preferredModel: 'acme/stub-1',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * A user-registered bot bound to a fresh agent.
 *
 * `ownerPaysAgentTurns` defaults to true — the value migration 0071 gave every
 * bot that was already bound — so the pre-existing cases below keep asserting
 * what they always did: the owner pays. `agentAccountId` defaults to an account
 * with NO balance row, which is what every agent has unless its owner funded it.
 */
async function userOwnedBot(
  ownerUserId: string,
  opts: { ownerPaysAgentTurns?: boolean; agentAccountId?: string } = {},
): Promise<InboundUserBotRow> {
  const agentId = `${SUITE}-agent-${seq++}`;
  await db.insert(agents).values({
    id: agentId,
    oxyAccountId: opts.agentAccountId ?? `${SUITE}-agent-account-${seq++}`,
    tagline: 'a webhook fixture agent',
    description: 'seeded for the webhook credit suite',
    authorOxyUserId: ownerUserId,
    category: 'general',
    status: 'active',
    systemPrompt: 'Be helpful.',
  });
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
    agentId,
    ownerPaysAgentTurns: opts.ownerPaysAgentTurns ?? true,
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
    vi.mocked(resolveStoredModel).mockRejectedValueOnce(new Error('no model'));

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
    vi.mocked(resolveStoredModel).mockRejectedValueOnce(new Error('no model'));

    await processChannelMessage('telegram', linkedBotUser(userId), message);

    expect(await balanceOf(userId)).toEqual({ free: 0, paid: 100 });
  });
});

describe('processAgentBotMessage — a user-registered bot', () => {
  it("charges the OWNER's turn when it answers", async () => {
    const ownerId = await account(100, 0);

    await processAgentBotMessage(await userOwnedBot(ownerId), linkedBotUser(ownerId), message, 'telegram');

    expect(await balanceOf(ownerId)).toEqual({ free: 99, paid: 0 });
  });

  it("gives the OWNER's credit back when NO MODEL can be resolved", async () => {
    const ownerId = await account(100, 0);
    vi.mocked(resolveStoredModel).mockRejectedValueOnce(new Error('no model'));

    await processAgentBotMessage(await userOwnedBot(ownerId), linkedBotUser(ownerId), message, 'telegram');

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });

  it("gives the OWNER's credit back when the model call THROWS", async () => {
    const ownerId = await account(100, 0);
    vi.mocked(generateText).mockRejectedValueOnce(new Error('every provider is down'));

    await processAgentBotMessage(await userOwnedBot(ownerId), linkedBotUser(ownerId), message, 'telegram');

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });
});

/**
 * Who pays for an agent-bot turn: `reserveAgentTurn`, wired.
 *
 * Every case reads BOTH balances — the agent's and the owner's — and names the
 * one that must not have moved, for the reason `turn-funding.pgdb.test.ts`
 * gives: a double debit looks exactly like the right answer from either side
 * alone.
 */
describe('processAgentBotMessage — who pays for the agent\'s turn', () => {
  async function rowExists(id: string): Promise<boolean> {
    const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
    return row !== undefined;
  }

  it('charges the AGENT when its own (owner-funded) balance covers it, and leaves the owner alone', async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = await account(0, 20);

    await processAgentBotMessage(
      await userOwnedBot(ownerId, { agentAccountId }),
      linkedBotUser(ownerId),
      message,
      'telegram',
    );

    expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 19 });
    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });

  it("gives the AGENT's credit back, not the owner's, when the model call throws", async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = await account(0, 20);
    vi.mocked(generateText).mockRejectedValueOnce(new Error('every provider is down'));

    await processAgentBotMessage(
      await userOwnedBot(ownerId, { agentAccountId }),
      linkedBotUser(ownerId),
      message,
      'telegram',
    );

    expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 20 });
    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
  });

  it('falls to the OWNER when the agent has no balance and the owner consented — and never provisions the agent', async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = `${SUITE}-unfunded-agent-${seq++}`;

    await processAgentBotMessage(
      await userOwnedBot(ownerId, { agentAccountId, ownerPaysAgentTurns: true }),
      linkedBotUser(ownerId),
      message,
      'telegram',
    );

    expect(await balanceOf(ownerId)).toEqual({ free: 99, paid: 0 });
    // The free-credit farm stays shut: running a turn gave the agent no row.
    expect(await rowExists(agentAccountId)).toBe(false);
  });

  it('refuses, charging NOBODY and calling no model, when the owner has not consented', async () => {
    const ownerId = await account(100, 0);
    const agentAccountId = await account(0, 0);
    vi.mocked(generateText).mockClear();
    vi.mocked(sendChannelMessage).mockClear();

    await processAgentBotMessage(
      await userOwnedBot(ownerId, { agentAccountId, ownerPaysAgentTurns: false }),
      linkedBotUser(ownerId),
      message,
      'telegram',
    );

    expect(await balanceOf(ownerId)).toEqual({ free: 100, paid: 0 });
    expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 0 });
    expect(generateText).not.toHaveBeenCalled();
    // The stranger is told it is a PERMISSION, not a balance.
    const text = vi.mocked(sendChannelMessage).mock.calls.at(-1)?.[2];
    expect(text).toContain('has not allowed it to use their credits');
    expect(text).not.toContain('out of credits');
  });

  it('refuses with the out-of-credits message when neither balance covers it', async () => {
    const ownerId = await account(0, 0);
    vi.mocked(generateText).mockClear();
    vi.mocked(sendChannelMessage).mockClear();

    await processAgentBotMessage(
      await userOwnedBot(ownerId, { ownerPaysAgentTurns: true }),
      linkedBotUser(ownerId),
      message,
      'telegram',
    );

    expect(await balanceOf(ownerId)).toEqual({ free: 0, paid: 0 });
    expect(generateText).not.toHaveBeenCalled();
    const text = vi.mocked(sendChannelMessage).mock.calls.at(-1)?.[2];
    expect(text).toContain('out of credits');
  });
});
