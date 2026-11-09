import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@oxy.so/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent } from '../agents/agentRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentMemoryJournal } from '../schema/agent-runtime';
import { TEST_CHARACTER } from './support/agent-character';

/**
 * Migration 0119 repairs the memory journal's `actor_oxy_account_id` where it holds the agent's row id
 * instead of its bot account. Its UPDATE is replayed here over rows shaped like production's.
 */

const MIGRATION = fileURLToPath(
  new URL('../../../drizzle/0119_agent_memory_journal_actor.sql', import.meta.url),
);

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

async function entry(agentId: string, actor: string) {
  const [row] = await db
    .insert(agentMemoryJournal)
    .values({
      documentId: uuidv7(),
      agentId,
      oxyUserId: 'journal-person',
      actorOxyAccountId: actor,
      origin: 'agent',
      afterHash: 'h',
      afterContent: 'x',
    })
    .returning({ id: agentMemoryJournal.id });
  return row?.id ?? '';
}

const actorOf = async (id: string) =>
  (
    await db
      .select({ actor: agentMemoryJournal.actorOxyAccountId })
      .from(agentMemoryJournal)
      .where(eq(agentMemoryJournal.id, id))
  )[0]?.actor;

describe('0119: the journal names the writer by account', () => {
  it('repairs a row written under the agent’s row id, and only that', async () => {
    const created = await createAgent(db, {
      oxyAccountId: `journal-bot-${uuidv7()}`,
      ownerOxyAccountId: 'journal-owner',
      character: TEST_CHARACTER,
      tagline: 't',
      description: 'd',
      authorOxyUserId: 'journal-owner',
      category: 'research',
    });
    const wrong = await entry(created._id, created._id);
    const byPerson = await entry(created._id, 'journal-person');
    const alreadyRight = await entry(created._id, created.oxyAccountId);
    const orphan = await entry(uuidv7(), 'some-deleted-agent-row');

    await db.execute(sql.raw(readFileSync(MIGRATION, 'utf8').replace(/^--.*$/gm, '')));

    expect(await actorOf(wrong)).toBe(created.oxyAccountId);
    expect(await actorOf(byPerson)).toBe('journal-person');
    expect(await actorOf(alreadyRight)).toBe(created.oxyAccountId);
    expect(await actorOf(orphan)).toBe('some-deleted-agent-row');
  });
});
