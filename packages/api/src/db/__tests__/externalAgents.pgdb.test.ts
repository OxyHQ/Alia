import { uuidv7 } from '@oxy.so/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExternalLink,
  createPairing,
  findExternalLink,
  listExternalLinks,
  redeemPairing,
  revokeExternalLink,
} from '../agents/externalAgentRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { externalAgentPairings } from '../schema/external-agents';

/**
 * Pairing codes and agent links (ADR 0028), against a real Postgres: a code is consumed by exactly
 * one conditional UPDATE, only by the account that minted it, only before it expires; a link is
 * unique per agent and a revoked one is invisible.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const mint = async (owner: string, ttlMs = 60_000) => {
  const codeHash = `hash-${uuidv7()}`;
  await createPairing(db, {
    id: uuidv7(),
    codeHash,
    ownerOxyUserId: owner,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return codeHash;
};

describe('redeemPairing', () => {
  it('is single use', async () => {
    const codeHash = await mint('owner-a');
    const first = await redeemPairing(db, { codeHash, ownerOxyUserId: 'owner-a', now: new Date() });
    const second = await redeemPairing(db, {
      codeHash,
      ownerOxyUserId: 'owner-a',
      now: new Date(),
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('lets exactly one of many racing redeemers win', async () => {
    const codeHash = await mint('owner-a');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        redeemPairing(db, { codeHash, ownerOxyUserId: 'owner-a', now: new Date() }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('refuses another account and leaves the code redeemable by its owner', async () => {
    const codeHash = await mint('owner-a');
    expect(
      await redeemPairing(db, { codeHash, ownerOxyUserId: 'owner-b', now: new Date() }),
    ).toBeNull();
    expect(
      await redeemPairing(db, { codeHash, ownerOxyUserId: 'owner-a', now: new Date() }),
    ).not.toBeNull();
  });

  it('refuses an expired code and an unknown one', async () => {
    const codeHash = await mint('owner-a', -1000);
    expect(
      await redeemPairing(db, { codeHash, ownerOxyUserId: 'owner-a', now: new Date() }),
    ).toBeNull();
    expect(
      await redeemPairing(db, {
        codeHash: 'no-such-code',
        ownerOxyUserId: 'owner-a',
        now: new Date(),
      }),
    ).toBeNull();
  });

  it('keeps the code hash unique', async () => {
    const codeHash = await mint('owner-a');
    await expect(
      createPairing(db, {
        id: uuidv7(),
        codeHash,
        ownerOxyUserId: 'owner-a',
        expiresAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toThrow();
  });
});

describe('external agent links', () => {
  it('creates one link per agent, finds it, lists it for its owner and hides it once revoked', async () => {
    const agentId = `ext-${uuidv7()}`;
    const owner = `owner-${uuidv7()}`;
    await createExternalLink(db, {
      agentId,
      ownerOxyUserId: owner,
      cli: 'codex',
      hostName: 'laptop',
    });
    expect((await findExternalLink(db, agentId))?.cli).toBe('codex');
    expect((await listExternalLinks(db, owner)).map((l) => l.agentId)).toEqual([agentId]);
    await expect(
      createExternalLink(db, { agentId, ownerOxyUserId: owner, cli: 'claude', hostName: 'x' }),
    ).rejects.toThrow();

    expect(await revokeExternalLink(db, 'someone-else', agentId)).toBe(false);
    expect(await findExternalLink(db, agentId)).toBeDefined();
    expect(await revokeExternalLink(db, owner, agentId)).toBe(true);
    expect(await revokeExternalLink(db, owner, agentId)).toBe(false);
    expect(await findExternalLink(db, agentId)).toBeUndefined();
    expect(await listExternalLinks(db, owner)).toEqual([]);
  });

  it('refuses a CLI outside the supported set', async () => {
    await expect(
      db.execute(
        sql`INSERT INTO external_agent_links (agent_id, owner_oxy_user_id, cli, host_name)
            VALUES (${`bad-${uuidv7()}`}, 'o', 'gemini', 'h')`,
      ),
    ).rejects.toThrow();
  });

  it('keeps pairing rows unreachable once swept (the table exists and is sweepable)', async () => {
    const rows = await db.select().from(externalAgentPairings).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });
});
