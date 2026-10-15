import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getSyncState,
  recordSyncFailure,
  recordSyncSuccess,
} from '../agents/skillRegistrySyncRepository';
import { type ApiDatabase, closePostgres, connectPostgres } from '../index';
import { skillRegistrySyncState } from '../schema/skills';

/**
 * What the registry sync remembers between runs, against a real server.
 *
 * The rule that matters is the asymmetry: a success moves the ETag and commit,
 * a failure must leave them alone, because they are what the next run sends to
 * GitHub and what stops a rate-limited day from costing the catalogue anything.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await db.delete(skillRegistrySyncState).where(like(skillRegistrySyncState.sourceId, 'sst-%'));
  await closePostgres();
});

describe('skill registry sync state', () => {
  it('knows nothing about a source it has never synced', async () => {
    expect(await getSyncState(db, 'sst-never')).toBeNull();
  });

  it('remembers the validator after a complete sync', async () => {
    await recordSyncSuccess(db, 'sst-ok', {
      etag: '"v1"',
      commit: 'a'.repeat(40),
      rejectedDigest: 'd1',
    });
    expect(await getSyncState(db, 'sst-ok')).toEqual({
      sourceId: 'sst-ok',
      etag: '"v1"',
      commit: 'a'.repeat(40),
      rejectedDigest: 'd1',
      retryAfter: null,
    });
  });

  it('keeps the last good validator through a failure, and records when to come back', async () => {
    await recordSyncSuccess(db, 'sst-keep', {
      etag: '"v1"',
      commit: 'b'.repeat(40),
      rejectedDigest: null,
    });
    const retryAfter = new Date(Date.now() + 3_600_000);

    await recordSyncFailure(db, 'sst-keep', { error: 'rate limited', retryAfter });

    const state = await getSyncState(db, 'sst-keep');
    expect(state).toMatchObject({ etag: '"v1"', commit: 'b'.repeat(40) });
    expect(state?.retryAfter?.getTime()).toBe(retryAfter.getTime());
    const [row] = await db
      .select({ lastError: skillRegistrySyncState.lastError })
      .from(skillRegistrySyncState)
      .where(eq(skillRegistrySyncState.sourceId, 'sst-keep'));
    expect(row?.lastError).toBe('rate limited');
  });

  it('clears the backoff and the error on the next success', async () => {
    await recordSyncFailure(db, 'sst-clear', {
      error: 'boom',
      retryAfter: new Date(Date.now() + 60_000),
    });
    expect((await getSyncState(db, 'sst-clear'))?.etag).toBeNull();

    await recordSyncSuccess(db, 'sst-clear', {
      etag: '"v2"',
      commit: 'c'.repeat(40),
      rejectedDigest: null,
    });

    const state = await getSyncState(db, 'sst-clear');
    expect(state).toMatchObject({ etag: '"v2"', retryAfter: null });
  });
});
