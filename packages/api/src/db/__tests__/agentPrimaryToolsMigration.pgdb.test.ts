import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_CHARACTER } from './support/agent-character';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { MAX_AGENT_PRIMARY_TOOLS, parsePrimaryToolKey } from '../../domain/agent-primary-tools';

/**
 * Migration 0103 gives agents primary tools and gives Sindi hers — Homiio's
 * search and saved-home tools — with a prompt that puts Homiio's tools before
 * the web. Its column ran when this database was built; its UPDATE is replayed
 * here over a row shaped like production's, by id, and read back.
 */

const SINDI = '01a0646a-078f-7514-9800-9f43ceed7df8';
const OTHER = '01a0646a-0103-7000-8000-000000000103';
const MIGRATION = fileURLToPath(
  new URL('../../../drizzle/0103_agent_primary_tools.sql', import.meta.url),
);

let db: ApiDatabase;

beforeAll(async () => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
  await db.delete(agents).where(inArray(agents.id, [SINDI, OTHER]));
  for (const [id, account] of [
    [SINDI, 'sindi-bot-0103'],
    [OTHER, 'other-bot-0103'],
  ] as const) {
    await db.insert(agents).values({
      id,
      oxyAccountId: account,
      ownerOxyAccountId: 'project-0103',
      character: TEST_CHARACTER,
      tagline: 'an agent',
      description: 'before 0103',
      authorOxyUserId: 'project-0103',
      category: 'assistant',
      systemPrompt: 'before 0103',
    });
  }
  const statements = readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint');
  // The first statement is the column, which this database already has.
  expect(statements[0]).toMatch(/ADD COLUMN "primary_tools"/);
  for (const statement of statements.slice(1)) await db.execute(sql.raw(statement));
});

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.id, [SINDI, OTHER]));
  await closePostgres();
});

async function row(id: string) {
  const [found] = await db
    .select()
    .from(agents)
    .where(inArray(agents.id, [id]));
  if (!found) throw new Error(`no agent ${id}`);
  return found;
}

describe("0103: Sindi's primary tools are Homiio's", () => {
  it('names well-formed Homiio tools, within the limit', async () => {
    const { primaryTools } = await row(SINDI);
    expect(primaryTools).toEqual([
      'homiio:resolvePlace',
      'homiio:searchListings',
      'homiio:findNearbyListings',
      'homiio:getListing',
      'homiio:listSavedHomes',
      'homiio:saveHome',
    ]);
    expect(primaryTools.length).toBeLessThanOrEqual(MAX_AGENT_PRIMARY_TOOLS);
    for (const key of primaryTools) expect(parsePrimaryToolKey(key)?.appId).toBe('homiio');
  });

  it("puts Homiio's tools before the web in her prompt", async () => {
    const { systemPrompt } = await row(SINDI);
    expect(systemPrompt).toMatch(/^You are Sindi/);
    expect(systemPrompt).toContain('Never use web search to find homes, prices or listings.');
    expect(systemPrompt).toContain('resolvePlace');
  });

  it('leaves every other agent with none', async () => {
    const other = await row(OTHER);
    expect(other.primaryTools).toEqual([]);
    expect(other.systemPrompt).toBe('before 0103');
  });
});
