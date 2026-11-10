import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@oxy.so/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, findAgentById, updateAgent } from '../agents/agentRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { TEST_CHARACTER } from './support/agent-character';

/**
 * `agents.computer_source`: the default, the CHECK, the update path, and migration 0120's UPDATE that
 * leaves agents which already hold the `computer` capability on the machine they were using.
 */

const MIGRATION = fileURLToPath(
  new URL('../../../drizzle/0120_agent_computer_source.sql', import.meta.url),
);

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const newAgent = (capabilityGrants?: string[]) =>
  createAgent(db, {
    oxyAccountId: `cs-bot-${uuidv7()}`,
    ownerOxyAccountId: 'cs-owner',
    character: TEST_CHARACTER,
    tagline: 't',
    description: 'd',
    authorOxyUserId: 'cs-owner',
    category: 'research',
    ...(capabilityGrants ? { capabilityGrants } : {}),
  });

describe('agents.computer_source', () => {
  it('starts on the shared workspace (alia) and is served on the record', async () => {
    const created = await newAgent();
    expect(created.computerSource).toBe('alia');
    expect((await findAgentById(db, created._id))?.computerSource).toBe('alia');
  });

  it('can be moved to the agent’s own machine and back through updateAgent', async () => {
    const created = await newAgent();
    expect((await updateAgent(db, created._id, { computerSource: 'own' }))?.computerSource).toBe(
      'own',
    );
    expect((await updateAgent(db, created._id, { computerSource: 'alia' }))?.computerSource).toBe(
      'alia',
    );
  });

  it('refuses a value outside the two sources', async () => {
    const created = await newAgent();
    await expect(
      db.execute(sql`update agents set computer_source = 'shared' where id = ${created._id}`),
    ).rejects.toThrow();
  });
});

describe('migration 0120: agents that already have a computer keep it', () => {
  it('moves only the agents holding the computer capability to their own machine', async () => {
    const withComputer = await newAgent(['web', 'computer']);
    const withoutComputer = await newAgent(['web']);
    const none = await newAgent([]);
    // Shaped like production before the migration: everyone on the column's default.
    await db.update(agents).set({ computerSource: 'alia' }).where(eq(agents.id, withComputer._id));

    const statements = readFileSync(MIGRATION, 'utf8')
      .replace(/^--.*$/gm, '')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => /^UPDATE/i.test(statement));
    expect(statements).toHaveLength(1);
    for (const statement of statements) await db.execute(sql.raw(statement));

    expect((await findAgentById(db, withComputer._id))?.computerSource).toBe('own');
    expect((await findAgentById(db, withoutComputer._id))?.computerSource).toBe('alia');
    expect((await findAgentById(db, none._id))?.computerSource).toBe('alia');
  });
});
