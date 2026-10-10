import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentMemoryJournal, emailAlertPreferences, emailOutreachDecisions } from '../schema';
import { createAgent, deleteAgent, listAgentsOwnedBy } from '../agents/agentRepository';
import {
  deleteAgentMemory,
  listAgentMemory,
  listAgentsRememberingPerson,
  readAgentMemory,
  writeAgentMemory,
} from '../agents/agentMemoryRepository';
import {
  claimEmailOutreach,
  findEmailOutreach,
  isEmailAlertEnabled,
  listEmailAlertPreferences,
  setEmailAlertPreference,
  settleEmailOutreach,
} from '../proactive/emailOutreachRepository';
import { hasAnyConversation, upsertConversation } from '../chat/conversationRepository';
import { countOutreachInConversationSince, insertMessages } from '../chat/messageRepository';
import { hashAgentMemory } from '../../lib/agent/memory-contract.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

async function agent(owner = `owner-${randomUUID()}`) {
  return createAgent(db, {
    oxyAccountId: `bot-${randomUUID()}`,
    ownerOxyAccountId: owner,
    tagline: 'reads its own mail',
    description: 'an agent with a mailbox',
    authorOxyUserId: owner,
    category: 'assistant',
  });
}

describe('email_alert_preferences (migration 0084)', () => {
  it('is on until switched off, per actor, with Alia as the NULL agent', async () => {
    const person = `person-${randomUUID()}`;
    const mine = await agent(person);
    expect(await isEmailAlertEnabled(db, person, null)).toBe(true);
    expect(await isEmailAlertEnabled(db, person, mine._id)).toBe(true);

    await setEmailAlertPreference(db, { oxyUserId: person, agentId: null, enabled: false });
    await setEmailAlertPreference(db, { oxyUserId: person, agentId: null, enabled: false });
    await setEmailAlertPreference(db, { oxyUserId: person, agentId: mine._id, enabled: false });
    await setEmailAlertPreference(db, { oxyUserId: person, agentId: mine._id, enabled: true });

    expect(await isEmailAlertEnabled(db, person, null)).toBe(false);
    expect(await isEmailAlertEnabled(db, person, mine._id)).toBe(true);
    expect(await listEmailAlertPreferences(db, person)).toEqual(
      new Map<string | null, boolean>([
        [null, false],
        [mine._id, true],
      ]),
    );
    // NULLS NOT DISTINCT: the upsert replaced Alia's row instead of adding one.
    const rows = await db
      .select()
      .from(emailAlertPreferences)
      .where(eq(emailAlertPreferences.oxyUserId, person));
    expect(rows).toHaveLength(2);
  });

  it('goes with its agent', async () => {
    const person = `person-${randomUUID()}`;
    const mine = await agent(person);
    await setEmailAlertPreference(db, { oxyUserId: person, agentId: mine._id, enabled: false });
    await deleteAgent(db, mine._id);
    expect(await listEmailAlertPreferences(db, person)).toEqual(new Map());
  });

  it('lists the agents a person owns', async () => {
    const person = `person-${randomUUID()}`;
    const first = await agent(person);
    const second = await agent(person);
    await agent();
    expect((await listAgentsOwnedBy(db, person)).map((row) => row._id).sort()).toEqual(
      [first._id, second._id].sort(),
    );
  });
});

describe('email_outreach_decisions (migration 0084)', () => {
  it('claims one email once, and only a pending claim settles', async () => {
    const mailbox = `person-${randomUUID()}`;
    const input = {
      mailboxAccountId: mailbox,
      messageId: 'msg-1',
      oxyUserId: mailbox,
      agentId: null,
    };
    const claim = await claimEmailOutreach(db, input);
    expect(claim).toEqual(expect.any(String));
    expect(await claimEmailOutreach(db, input)).toBeNull();

    await settleEmailOutreach(db, claim!, {
      verdict: 'important',
      reason: 'needs_reply',
      postedMessageId: 'agent-push-1',
    });
    await settleEmailOutreach(db, claim!, { verdict: 'failed', reason: 'error' });
    expect(await findEmailOutreach(db, mailbox, 'msg-1')).toMatchObject({
      verdict: 'important',
      reason: 'needs_reply',
      postedMessageId: 'agent-push-1',
    });
  });

  it('refuses a verdict outside the vocabulary', async () => {
    await expect(
      db.execute(sql`
      insert into email_outreach_decisions (id, mailbox_account_id, message_id, oxy_user_id, verdict)
      values (${randomUUID()}, 'm', ${randomUUID()}, 'u', 'maybe')
    `),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('goes with the agent whose mailbox it was', async () => {
    const owner = `owner-${randomUUID()}`;
    const mine = await agent(owner);
    await claimEmailOutreach(db, {
      mailboxAccountId: mine.oxyAccountId,
      messageId: 'msg-2',
      oxyUserId: owner,
      agentId: mine._id,
    });
    await deleteAgent(db, mine._id);
    expect(
      await db
        .select()
        .from(emailOutreachDecisions)
        .where(eq(emailOutreachDecisions.mailboxAccountId, mine.oxyAccountId)),
    ).toEqual([]);
  });
});

describe("an agent's memory is per person (migrations 0084 + 0085)", () => {
  it('lets two people each keep a MEMORY.md with the same agent', async () => {
    const shared = await agent();
    const empty = hashAgentMemory('');
    for (const person of ['alice', 'bob'].map((name) => `${name}-${randomUUID()}`)) {
      await writeAgentMemory(db, {
        oxyUserId: person,
        agentId: shared._id,
        actorOxyAccountId: shared._id,
        path: 'MEMORY.md',
        content: `- about ${person}\n`,
        expectedHash: empty,
        origin: 'agent',
      });
      expect((await readAgentMemory(db, person, shared._id, 'MEMORY.md'))?.content).toBe(
        `- about ${person}\n`,
      );
    }
  });

  it('forgets a file or everything, journal included, and only for that person', async () => {
    const shared = await agent();
    const person = `person-${randomUUID()}`;
    const other = `other-${randomUUID()}`;
    const empty = hashAgentMemory('');
    const write = (oxyUserId: string, path: string, content: string, expectedHash = empty) =>
      writeAgentMemory(db, {
        oxyUserId,
        agentId: shared._id,
        actorOxyAccountId: shared._id,
        path,
        content,
        expectedHash,
        origin: 'agent',
      });
    const index = await write(person, 'MEMORY.md', '- likes tea\n');
    await write(person, 'MEMORY.md', '- likes coffee\n', index.contentHash);
    await write(person, 'memory/health.md', 'allergic to nuts\n');
    await write(other, 'MEMORY.md', '- someone else\n');

    expect(await listAgentsRememberingPerson(db, person)).toEqual([
      expect.objectContaining({ agentId: shared._id, files: 2 }),
    ]);

    expect(
      await deleteAgentMemory(db, {
        oxyUserId: person,
        agentId: shared._id,
        path: 'memory/health.md',
      }),
    ).toBe(1);
    expect((await listAgentMemory(db, person, shared._id)).map((file) => file.path)).toEqual([
      'MEMORY.md',
    ]);

    expect(await deleteAgentMemory(db, { oxyUserId: person, agentId: shared._id })).toBe(1);
    expect(await listAgentMemory(db, person, shared._id)).toEqual([]);
    const journal = await db
      .select()
      .from(agentMemoryJournal)
      .where(
        and(eq(agentMemoryJournal.agentId, shared._id), eq(agentMemoryJournal.oxyUserId, person)),
      );
    expect(journal).toEqual([]);
    // Somebody else's memory with the same agent is untouched.
    expect((await readAgentMemory(db, other, shared._id, 'MEMORY.md'))?.content).toBe(
      '- someone else\n',
    );
  });
});

describe('what the proactive path reads from chat', () => {
  it("knows whether somebody ever used Alia, and counts Alia's outreach in one conversation", async () => {
    const person = `person-${randomUUID()}`;
    expect(await hasAnyConversation(db, person)).toBe(false);
    const conversationId = randomUUID();
    await upsertConversation(db, {
      oxyUserId: person,
      conversationId,
      titleOnInsert: 'Alia',
      source: 'app',
    });
    expect(await hasAnyConversation(db, person)).toBe(true);
    await insertMessages(db, [
      {
        conversationId,
        oxyUserId: person,
        clientMessageId: `agent-push-${randomUUID()}`,
        role: 'assistant',
        content: 'one',
        seq: 0,
        createdAt: new Date(),
      },
      {
        conversationId,
        oxyUserId: person,
        clientMessageId: `msg-${randomUUID()}`,
        role: 'user',
        content: 'thanks',
        seq: 1,
        createdAt: new Date(),
      },
      {
        conversationId,
        oxyUserId: person,
        clientMessageId: `agent-push-${randomUUID()}`,
        role: 'assistant',
        content: 'two',
        seq: 2,
        createdAt: new Date(),
      },
    ]);
    expect(
      await countOutreachInConversationSince(
        db,
        person,
        conversationId,
        new Date(Date.now() - 60_000),
      ),
    ).toBe(2);
    expect(await countOutreachInConversationSince(db, person, randomUUID(), new Date(0))).toBe(0);
  });
});
