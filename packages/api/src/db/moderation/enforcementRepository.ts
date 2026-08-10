/**
 * Enforcement records, on Postgres.
 *
 * ## Why this table ports separately from the rest of moderation
 *
 * The other three moderation tables are welded together by two transactions
 * sharing one outbox writer. This one holds **no transaction at all** — measured,
 * not assumed — and its "exactly once" guarantee is a UNIQUE CONSTRAINT claimed
 * before acting, not an atomic pair of writes. Different mechanism, different
 * tests, so it moves on its own.
 *
 * ## The claim is a race, and the constraint is what decides it
 *
 * `UNIQUE(decision_id, decision_revision, action)` IS Appendix D's idempotency
 * key. Every action claims its row BEFORE doing anything, so a redelivered
 * webhook, a reclaimed outbox lease or a manual replay loses the insert and does
 * nothing. Reading "have I done this?" and then acting would leave the gap
 * between the two statements, which is exactly when a redelivery arrives.
 *
 * `decision_revision` being IN the key is load-bearing: drop it and a
 * correction's `restore` becomes the same row as the `restrict` it supersedes,
 * so an accepted appeal could never relist the item.
 *
 * ## `ON CONFLICT DO NOTHING … RETURNING`, not a caught duplicate-key error
 *
 * Mongo caught code 11000 and read it as "somebody else has this". That does not
 * port, for the same two reasons the inbound dedupe claim does not: in Postgres a
 * failed statement aborts the surrounding transaction, and an exception cannot
 * distinguish a duplicate from a dropped connection or an exhausted pool.
 * Treating either of the latter as "already enforced" would silently drop a
 * decision nobody carried out. The EMPTY result set is the answer, and a real
 * failure still propagates.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { getDb } from '../index';
import { moderationEnforcements, MODERATION_ENFORCEMENT_MODES } from '../schema/moderation';
import type { ModerationEnforcementAction } from '../../domain/moderation-enforcement.js';

/**
 * The fields an action replaced, so a reversal can put them back.
 *
 * Flat and explicit rather than an opaque blob: a reversal READS these, and a
 * shape nobody can typecheck is a shape that silently stops being restored.
 * Nullable in the column because `observe` mode records the plan without touching
 * anything, so there is genuinely nothing to remember.
 */
export interface ModerationPreviousState {
  isPublished?: boolean;
  isFeatured?: boolean;
  isTrending?: boolean;
  hiddenByModeration?: boolean;
}

export type StoredEnforcement = typeof moderationEnforcements.$inferSelect;

/**
 * Taken from the tuple the column's CHECK is rendered from, so the type and the
 * constraint cannot drift. `config.ts` narrows the same three values from the
 * environment; this is the storage side of that one set.
 */
export type ModerationEnforcementMode = (typeof MODERATION_ENFORCEMENT_MODES)[number];

export interface NewEnforcement {
  readonly decisionId: string;
  readonly decisionRevision: number;
  readonly action: ModerationEnforcementAction;
  readonly caseId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
  readonly recommendedAction?: string;
  readonly reason: string;
  readonly mode: ModerationEnforcementMode;
}

/**
 * Claim this decision revision's action, or report that somebody already has it.
 *
 * Returns the claimed row's id, or `null` when the unique constraint refused it
 * — which is a normal answer ("another delivery handled this"), not a failure.
 *
 * The id is minted here because `moderation_enforcements.id` has no database
 * default, the same as `reports`. Mongo's was a client-generated ObjectId.
 */
export async function claimEnforcement(input: NewEnforcement): Promise<string | null> {
  const [claimed] = await getDb()
    .insert(moderationEnforcements)
    .values({
      id: uuidv7(),
      decisionId: input.decisionId,
      decisionRevision: input.decisionRevision,
      action: input.action,
      caseId: input.caseId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      recommendedAction: input.recommendedAction,
      reason: input.reason,
      mode: input.mode,
      applied: false,
    })
    .onConflictDoNothing({
      target: [
        moderationEnforcements.decisionId,
        moderationEnforcements.decisionRevision,
        moderationEnforcements.action,
      ],
    })
    .returning({ id: moderationEnforcements.id });
  return claimed?.id ?? null;
}

/** Record that a claimed action was deliberately NOT carried out, and why. */
export async function recordEnforcementSkipped(id: string, reason: string): Promise<void> {
  await getDb()
    .update(moderationEnforcements)
    .set({ skippedReason: reason, updatedAt: sql`now()` })
    .where(eq(moderationEnforcements.id, id));
}

/**
 * Record that the effect happened, with the state it replaced.
 *
 * `previousState` is what makes a reversal put back the real previous value
 * rather than a guess at one — a draft agent that was somehow restricted must not
 * be published by a correction.
 */
export async function recordEnforcementApplied(
  id: string,
  previousState: ModerationPreviousState,
): Promise<void> {
  await getDb()
    .update(moderationEnforcements)
    .set({ applied: true, appliedAt: sql`now()`, previousState, updatedAt: sql`now()` })
    .where(eq(moderationEnforcements.id, id));
}

/**
 * Give the claim back so a retry can try again.
 *
 * Keeping it would make a transient failure permanent: the action would be
 * deduplicated away forever and the decision would silently never be carried out.
 */
export async function releaseEnforcementClaim(id: string): Promise<void> {
  await getDb().delete(moderationEnforcements).where(eq(moderationEnforcements.id, id));
}

/**
 * The most recent APPLIED action of a kind against this subject.
 *
 * A reversal reads the row that made the change rather than assuming a default,
 * which is what makes "restore" mean "put back what was there" instead of "set it
 * to whatever we think normal looks like". `moderation_enforcements_subject_applied_idx`
 * is this query's index.
 */
export async function findLastAppliedEnforcement(
  subjectType: string,
  subjectId: string,
  action: ModerationEnforcementAction,
): Promise<{ previousState: ModerationPreviousState | null } | null> {
  const [row] = await getDb()
    .select({ previousState: moderationEnforcements.previousState })
    .from(moderationEnforcements)
    .where(
      and(
        eq(moderationEnforcements.subjectType, subjectType),
        eq(moderationEnforcements.subjectId, subjectId),
        eq(moderationEnforcements.action, action),
        eq(moderationEnforcements.applied, true),
      ),
    )
    /**
     * `id` breaks a tie within a millisecond. `created_at` alone cannot, and
     * "the most recent" has to be a total order or a reversal can read the wrong
     * row's `previousState` — which is a wrong RESTORED VALUE, not an error.
     */
    .orderBy(desc(moderationEnforcements.createdAt), desc(moderationEnforcements.id))
    .limit(1);
  if (!row) return null;
  /**
   * The row and its `previousState` stay TWO levels, exactly as Mongo returned
   * them, because the callers distinguish them: `restore` treats "there was an
   * applied restriction whose previous state we did not record" as "republish"
   * (`?? true`) and "there was no restriction at all" as "do nothing". Flattening
   * a missing `previousState` into `null` would silently merge those.
   *
   * `jsonb`, so drizzle types it `unknown`; the shape is this module's own.
   */
  return { previousState: row.previousState as ModerationPreviousState | null };
}
