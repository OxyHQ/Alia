/**
 * What the registry sync remembers about each upstream source between runs.
 * The reasoning is on the table, `skill_registry_sync_state`.
 */

import { eq, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { skillRegistrySyncState } from '../schema/skills';

export interface SkillSyncState {
  readonly sourceId: string;
  readonly etag: string | null;
  readonly commit: string | null;
  readonly rejectedDigest: string | null;
  readonly retryAfter: Date | null;
}

export async function getSyncState(
  db: ApiDatabase,
  sourceId: string,
): Promise<SkillSyncState | null> {
  const [row] = await db
    .select({
      sourceId: skillRegistrySyncState.sourceId,
      etag: skillRegistrySyncState.etag,
      commit: skillRegistrySyncState.commit,
      rejectedDigest: skillRegistrySyncState.rejectedDigest,
      retryAfter: skillRegistrySyncState.retryAfter,
    })
    .from(skillRegistrySyncState)
    .where(eq(skillRegistrySyncState.sourceId, sourceId));
  return row ?? null;
}

/** A source that synced completely: the validator moves, and any backoff or error clears. */
export async function recordSyncSuccess(
  db: ApiDatabase,
  sourceId: string,
  result: { etag: string | null; commit: string | null; rejectedDigest: string | null },
): Promise<void> {
  const values = {
    etag: result.etag,
    commit: result.commit,
    rejectedDigest: result.rejectedDigest,
    lastSuccessAt: sql`now()`,
    lastAttemptAt: sql`now()`,
    retryAfter: null,
    lastError: null,
  };
  await db
    .insert(skillRegistrySyncState)
    .values({ sourceId, ...values })
    .onConflictDoUpdate({ target: skillRegistrySyncState.sourceId, set: values });
}

/** A source that could not be read: the last good validator and commit stay as they were. */
export async function recordSyncFailure(
  db: ApiDatabase,
  sourceId: string,
  failure: { error: string; retryAfter: Date | null },
): Promise<void> {
  const values = {
    lastAttemptAt: sql`now()`,
    retryAfter: failure.retryAfter,
    lastError: failure.error.slice(0, 500),
  };
  await db
    .insert(skillRegistrySyncState)
    .values({ sourceId, ...values })
    .onConflictDoUpdate({ target: skillRegistrySyncState.sourceId, set: values });
}
