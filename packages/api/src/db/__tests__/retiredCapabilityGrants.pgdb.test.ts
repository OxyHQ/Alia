import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { createAgent, findAgentById } from '../agents/agentRepository';

/**
 * Migration 0071 and the reader, against a REAL server, for the retired `shell`
 * and `files` capability families.
 *
 * The statement is read out of the migration FILE and run as written, so what
 * is measured is what deploys — not a copy of it typed into a test.
 */

const MIGRATION = path.resolve(__dirname, '../../../drizzle/0071_retire_shell_files_grants.sql');

let db: ApiDatabase;
const OWNER = `oxy-owner-retired-${process.pid}`;
let seq = 0;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

async function agentWith(grants: string[]): Promise<string> {
  const agent = await createAgent(db, {
    oxyAccountId: `oxy-bot-retired-${process.pid}-${seq++}`,
    ownerOxyAccountId: OWNER,
    tagline: 't',
    description: 'd',
    authorOxyUserId: OWNER,
    category: 'research',
    routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
  });
  // Written raw: the wire refuses or strips these now, and a row from before
  // the retirement is exactly what the migration is for.
  await db.update(agents).set({ capabilityGrants: grants }).where(eq(agents.id, agent._id));
  return agent._id;
}

async function stored(ids: string[]): Promise<Record<string, string[]>> {
  const rows = await db.select({ id: agents.id, grants: agents.capabilityGrants })
    .from(agents).where(inArray(agents.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.grants]));
}

describe('migration 0071 removes the retired grants and nothing else', () => {
  it('is a post-phase migration, so no old replica can write them back after it', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text.match(/^-- oxy:deploy-phase=(pre|post)$/gm)).toEqual(['-- oxy:deploy-phase=post']);
  });

  it('strips shell and files, keeps every other grant in order, and leaves clean rows alone', async () => {
    const both = await agentWith(['web', 'shell', 'mcp:conn-1', 'files', 'agent']);
    const onlyRetired = await agentWith(['shell', 'files']);
    const clean = await agentWith(['browser', 'memory']);
    const cleanBefore = await db.select({ updatedAt: agents.updatedAt }).from(agents).where(eq(agents.id, clean));

    await db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));

    expect(await stored([both, onlyRetired, clean])).toEqual({
      [both]: ['web', 'mcp:conn-1', 'agent'],
      [onlyRetired]: [],
      [clean]: ['browser', 'memory'],
    });
    // The WHERE clause is the "nothing else": a row without a retired grant is
    // not rewritten at all.
    const cleanAfter = await db.select({ updatedAt: agents.updatedAt }).from(agents).where(eq(agents.id, clean));
    expect(cleanAfter).toEqual(cleanBefore);
  });

  it('is idempotent', async () => {
    const id = await agentWith(['files', 'web']);
    await db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));
    await db.execute(sql.raw(readFileSync(MIGRATION, 'utf8')));
    expect(await stored([id])).toEqual({ [id]: ['web'] });
  });
});

describe('before the migration has run, the reader already hides them', () => {
  it('serves a row holding a retired grant without it', async () => {
    const id = await agentWith(['web', 'shell', 'files']);
    const agent = await findAgentById(db, id);
    expect(agent?.capabilityGrants).toEqual(['web']);
  });
});
