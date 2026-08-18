/**
 * Agent reviews, and the rating they aggregate into.
 *
 * The aggregate lives HERE and not beside the reviews' callers, because three
 * call sites recompute it — writing a review, deleting one, and hiding or
 * restoring one through a moderation decision — and `lib/agent-rating.ts` existed
 * for exactly that reason before it was retired with the models it read. What
 * moved is the storage; the argument for one definition is unchanged.
 *
 * ## `hidden_by_moderation` is a PREDICATE, not an absence
 *
 * A withheld review is still a row: moderation has to be reversible, so an
 * appeal that succeeds can put it back. Every public read and the rating
 * aggregate carry {@link VISIBLE_REVIEW}, and the author's own read deliberately
 * does not — somebody's own words must not vanish without trace from their side.
 *
 * ## The upsert is `ON CONFLICT`, not find-then-write
 *
 * `POST /agents/:id/reviews` was `findOneAndUpdate(..., {upsert: true})` against
 * a unique `(agentId, userId)` index. `agent_reviews_agent_user_key` is that
 * index, so the conflict target is named rather than left to Postgres to pick —
 * an unnamed `ON CONFLICT DO UPDATE` would start answering for any future unique
 * index on the table.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../index';
import { agentReviews } from '../schema/agent-sessions';
import { agents } from '../schema/agents';

type AgentReviewRow = typeof agentReviews.$inferSelect;

/** A review in the shape `res.json({ review })` has always answered. */
export interface AgentReviewRecord {
  _id: string;
  id: string;
  agentId: string;
  /** The Oxy account that wrote it. Hydrated to a profile by the route. */
  userId: string;
  rating: number;
  comment: string;
  hiddenByModeration: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRatingStats {
  avg: number;
  count: number;
}

/**
 * Reviews the public listing shows, which are the ones the rating counts.
 *
 * `= false`, where Mongo said `$ne: true`. The two are the same set only because
 * the column is `notNull` with a default: in Mongo a review written before the
 * field existed had no value at all and `$ne: true` matched it, and here that
 * row cannot exist. Stated because `<> true` would ALSO have been written and is
 * NULL — therefore not TRUE, therefore excluded — for a nullable column.
 */
const VISIBLE_REVIEW = eq(agentReviews.hiddenByModeration, false);

function toAgentReviewRecord(row: AgentReviewRow): AgentReviewRecord {
  return {
    _id: row.id,
    id: row.id,
    agentId: row.agentId,
    userId: row.oxyUserId,
    rating: row.rating,
    comment: row.comment,
    hiddenByModeration: row.hiddenByModeration,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findAgentReviewById(
  db: Executor,
  id: string,
): Promise<AgentReviewRecord | null> {
  const [row] = await db.select().from(agentReviews).where(eq(agentReviews.id, id)).limit(1);
  return row ? toAgentReviewRecord(row) : null;
}

/** One page of an agent's VISIBLE reviews, newest first, plus the total. */
export async function listVisibleAgentReviews(
  db: Executor,
  agentId: string,
  page: { limit: number; offset: number },
): Promise<{ reviews: AgentReviewRecord[]; total: number }> {
  const where = and(eq(agentReviews.agentId, agentId), VISIBLE_REVIEW);
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(agentReviews)
      .where(where)
      .orderBy(desc(agentReviews.createdAt))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(agentReviews).where(where),
  ]);
  return { reviews: rows.map(toAgentReviewRecord), total: counted?.total ?? 0 };
}

/**
 * One account's own review of an agent, hidden or not.
 *
 * Deliberately without {@link VISIBLE_REVIEW}: see the file comment.
 */
export async function findOwnAgentReview(
  db: Executor,
  agentId: string,
  oxyUserId: string,
): Promise<AgentReviewRecord | null> {
  const [row] = await db
    .select()
    .from(agentReviews)
    .where(and(eq(agentReviews.agentId, agentId), eq(agentReviews.oxyUserId, oxyUserId)))
    .limit(1);
  return row ? toAgentReviewRecord(row) : null;
}

/** Create or replace one account's review of one agent. */
export async function upsertAgentReview(
  db: Executor,
  input: { agentId: string; oxyUserId: string; rating: number; comment: string },
): Promise<AgentReviewRecord> {
  const [row] = await db
    .insert(agentReviews)
    .values({
      agentId: input.agentId,
      oxyUserId: input.oxyUserId,
      rating: input.rating,
      comment: input.comment,
    })
    .onConflictDoUpdate({
      target: [agentReviews.agentId, agentReviews.oxyUserId],
      /**
       * The INPUT values, not `excluded.*`: this statement is the only writer
       * and it already holds them, so reaching back through `excluded` would
       * add a spelling of each column name that `DATABASE_CASING` could get
       * wrong. `updated_at` is set explicitly because `$onUpdate` fires on
       * `db.update()`, not on the DO UPDATE branch of an insert.
       */
      set: { rating: input.rating, comment: input.comment, updatedAt: new Date() },
    })
    .returning();
  return toAgentReviewRecord(row);
}

/**
 * Delete one account's own review. Returns the review it removed, or null.
 *
 * The row comes back because the caller recomputes the rating for the agent the
 * review actually belonged to rather than for whatever the URL claimed — the
 * same reason the Mongo version read `result.agentId`.
 */
export async function deleteOwnAgentReview(
  db: Executor,
  agentId: string,
  oxyUserId: string,
): Promise<AgentReviewRecord | null> {
  const [row] = await db
    .delete(agentReviews)
    .where(and(eq(agentReviews.agentId, agentId), eq(agentReviews.oxyUserId, oxyUserId)))
    .returning();
  return row ? toAgentReviewRecord(row) : null;
}

/** Withhold a review, or put it back. Returns whether a row matched. */
export async function setAgentReviewHidden(
  db: Executor,
  id: string,
  hidden: boolean,
): Promise<boolean> {
  const updated = await db
    .update(agentReviews)
    .set({ hiddenByModeration: hidden })
    .where(eq(agentReviews.id, id))
    .returning({ id: agentReviews.id });
  return updated.length > 0;
}

/**
 * Recompute and persist an agent's `rating` and `review_count`.
 *
 * Returns null when the agent no longer exists — a caller removing a review for
 * an agent that was deleted underneath it is ordinary, not an error.
 *
 * ## `avg()` comes back as a STRING, and the TYPE is the whole defence
 *
 * `avg` over an `integer` column is `numeric`, and postgres.js decodes `numeric`
 * as a string to preserve arbitrary precision — the same trap `bigint` carries
 * one type over.
 *
 * Be precise about how that bites, because the obvious story is wrong:
 * `'4.333' * 10` is 43.33, not `NaN`, so today's `Math.round(avg * 10) / 10`
 * would survive a `sql<number>` annotation. What does NOT survive is `+`, which
 * concatenates — and a weighted average, a running total, or anything else the
 * next person adds here reaches for `+` first. Mutating `Number(...)` away
 * therefore breaks NO test, and that is the honest state of it: the annotation
 * is `string | null` because that is what the driver returns, and the single
 * explicit conversion is what makes the next arithmetic safe rather than what
 * makes this one work. {@link recalculateAgentRating}'s test pins the driver's
 * behaviour directly instead of pretending an assertion here covers it.
 *
 * The rounding stays in JavaScript, exactly as `Math.round(avg * 10) / 10` did:
 * `agents.rating` is `double precision` for this value and carries a `0..5`
 * CHECK, so a mistake is a refused write rather than a wrong number on a card.
 */
export async function recalculateAgentRating(
  db: Executor,
  agentId: string,
): Promise<AgentRatingStats | null> {
  const [stats] = await db
    .select({
      avg: sql<string | null>`avg(${agentReviews.rating})`,
      count: sql<number>`count(*)::int`,
    })
    .from(agentReviews)
    .where(and(eq(agentReviews.agentId, agentId), VISIBLE_REVIEW));

  // `avg` over zero rows is NULL, not 0 — an agent whose last visible review was
  // removed goes back to 0, which is what `agents.rating` defaults to.
  const average = stats?.avg === null || stats?.avg === undefined ? 0 : Number(stats.avg);
  const rating = Math.round(average * 10) / 10;
  const count = stats?.count ?? 0;

  const updated = await db
    .update(agents)
    .set({ rating, reviewCount: count })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  if (updated.length === 0) return null;
  return { avg: rating, count };
}
