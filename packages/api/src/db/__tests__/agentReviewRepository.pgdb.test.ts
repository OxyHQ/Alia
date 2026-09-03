import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentReviews } from '../schema/agent-sessions';
import { createAgent, deleteAgent, findAgentById } from '../agents/agentRepository';
import {
  deleteOwnAgentReview,
  findAgentReviewById,
  findOwnAgentReview,
  listVisibleAgentReviews,
  recalculateAgentRating,
  setAgentReviewHidden,
  upsertAgentReview,
} from '../agents/agentReviewRepository';

/**
 * `agentReviewRepository`, against a REAL server.
 *
 * The rating is an AGGREGATE over a filtered set, and three call sites recompute
 * it. What a mock cannot express here: the unique that makes the upsert an
 * upsert, the `avg()` that comes back as a STRING, and the cascade that takes
 * the reviews with the agent.
 */

/**
 * `hydrateOxyUsers` reads through the module-level `oxyClient`, which talks to a
 * real Oxy. Stubbed so the last block of this file measures the HYDRATION and
 * not the network.
 */
const getUsersByIds = vi.fn();
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { getUsersByIds: (ids: string[]) => getUsersByIds(ids) },
}));

const { hydrateOxyUsers } = await import('../../lib/oxy-user-hydration.js');

let db: ApiDatabase;
const AUTHOR = `oxy-author-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterEach(() => {
  getUsersByIds.mockReset();
});

afterAll(async () => {
  await closePostgres();
});

const suffix = () => Math.random().toString(36).slice(2, 10);

async function seedAgent(): Promise<string> {
  const agent = await createAgent(db, {
    oxyAccountId: `oxy-bot-reviewed-${suffix()}`,
    ownerOxyAccountId: AUTHOR,
    tagline: 't',
    description: 'd',
    authorOxyUserId: AUTHOR,
    category: 'research',
    routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
  });
  return agent._id;
}

describe('one review per account per agent', () => {
  it('REPLACES rather than adding a second row', async () => {
    const agentId = await seedAgent();
    const reviewer = `oxy-r-${suffix()}`;

    const first = await upsertAgentReview(db, { agentId, oxyUserId: reviewer, rating: 2, comment: 'meh' });
    const second = await upsertAgentReview(db, { agentId, oxyUserId: reviewer, rating: 5, comment: 'better' });

    expect(second._id).toBe(first._id);
    expect(second.rating).toBe(5);
    expect(second.comment).toBe('better');

    const { total } = await listVisibleAgentReviews(db, agentId, { limit: 10, offset: 0 });
    expect(total).toBe(1);
  });

  /**
   * `updated_at` is maintained by `$onUpdate`, which fires on `db.update()` and
   * NOT on the DO UPDATE branch of an insert. Set explicitly, so a replaced
   * review does not keep claiming it was last touched when it was created.
   */
  it('moves updated_at when the review is replaced', async () => {
    const agentId = await seedAgent();
    const reviewer = `oxy-r-${suffix()}`;
    const first = await upsertAgentReview(db, { agentId, oxyUserId: reviewer, rating: 2, comment: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await upsertAgentReview(db, { agentId, oxyUserId: reviewer, rating: 3, comment: 'b' });

    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it('lets two different accounts each review the same agent', async () => {
    const agentId = await seedAgent();
    await upsertAgentReview(db, { agentId, oxyUserId: `oxy-a-${suffix()}`, rating: 4, comment: '' });
    await upsertAgentReview(db, { agentId, oxyUserId: `oxy-b-${suffix()}`, rating: 2, comment: '' });

    const { total } = await listVisibleAgentReviews(db, agentId, { limit: 10, offset: 0 });
    expect(total).toBe(2);
  });
});

describe('a withheld review is hidden, not deleted', () => {
  /**
   * Every moderation effect has to be reversible, so an appeal that succeeds can
   * put the review back. That only works if the row survives — and it only reads
   * as withheld if the LISTING excludes it while the author's own read does not.
   */
  it('leaves the listing but stays readable to its author', async () => {
    const agentId = await seedAgent();
    const reviewer = `oxy-r-${suffix()}`;
    const review = await upsertAgentReview(db, {
      agentId,
      oxyUserId: reviewer,
      rating: 1,
      comment: 'harsh',
    });

    await setAgentReviewHidden(db, review._id, true);

    const { reviews, total } = await listVisibleAgentReviews(db, agentId, { limit: 10, offset: 0 });
    expect(reviews).toEqual([]);
    expect(total).toBe(0);

    const own = await findOwnAgentReview(db, agentId, reviewer);
    expect(own?.comment).toBe('harsh');
    expect(own?.hiddenByModeration).toBe(true);
  });

  it('comes back when the decision is reversed', async () => {
    const agentId = await seedAgent();
    const review = await upsertAgentReview(db, {
      agentId,
      oxyUserId: `oxy-r-${suffix()}`,
      rating: 4,
      comment: 'fine',
    });
    await setAgentReviewHidden(db, review._id, true);
    await setAgentReviewHidden(db, review._id, false);

    const { total } = await listVisibleAgentReviews(db, agentId, { limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect((await findAgentReviewById(db, review._id))?.hiddenByModeration).toBe(false);
  });
});

describe('the rating is the average of the VISIBLE reviews', () => {
  /**
   * The driver's behaviour, pinned directly rather than implied.
   *
   * `avg()` over an `integer` column is `numeric`, and postgres.js decodes that
   * as a STRING. The repository types it `string | null` and converts once —
   * and this case is deliberately about the DECODED value rather than about the
   * repository's arithmetic, because `'4.333' * 10` coerces fine and no
   * assertion on the rating could tell the two apart. What would break is `+`,
   * which the next person to touch that aggregate will reach for.
   */
  it('decodes the average as a string, which is why the repository converts it', async () => {
    const agentId = await seedAgent();
    for (const rating of [5, 4, 4]) {
      await upsertAgentReview(db, { agentId, oxyUserId: `oxy-${suffix()}`, rating, comment: '' });
    }

    const [raw] = await db
      .select({ avg: sql`avg(${agentReviews.rating})` })
      .from(agentReviews)
      .where(eq(agentReviews.agentId, agentId));
    expect(typeof raw.avg).toBe('string');
    // The positive control: an `int`-cast aggregate over the same rows is NOT a
    // string, so this is a fact about `numeric` and not about every aggregate.
    const [counted] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentReviews)
      .where(eq(agentReviews.agentId, agentId));
    expect(typeof counted.total).toBe('number');
  });

  it('rounds to one decimal place', async () => {
    const agentId = await seedAgent();
    for (const rating of [5, 4, 4]) {
      await upsertAgentReview(db, { agentId, oxyUserId: `oxy-${suffix()}`, rating, comment: '' });
    }

    const stats = await recalculateAgentRating(db, agentId);
    // 13/3 = 4.333… → 4.3
    expect(stats).toEqual({ avg: 4.3, count: 3 });
    expect(Number.isNaN(stats?.avg)).toBe(false);

    const agent = await findAgentById(db, agentId);
    expect(agent?.rating).toBe(4.3);
    expect(agent?.reviewCount).toBe(3);
  });

  it('excludes a withheld review from the number it moves', async () => {
    const agentId = await seedAgent();
    await upsertAgentReview(db, { agentId, oxyUserId: `oxy-${suffix()}`, rating: 5, comment: '' });
    const hidden = await upsertAgentReview(db, {
      agentId,
      oxyUserId: `oxy-${suffix()}`,
      rating: 1,
      comment: '',
    });

    await recalculateAgentRating(db, agentId);
    expect((await findAgentById(db, agentId))?.rating).toBe(3);

    await setAgentReviewHidden(db, hidden._id, true);
    const stats = await recalculateAgentRating(db, agentId);
    // A review withheld for being abusive should not keep moving the number it
    // was filed to move.
    expect(stats).toEqual({ avg: 5, count: 1 });
  });

  /**
   * `avg()` over ZERO rows is NULL, not 0. Carried through as NULL it would fail
   * the `notNull` column; coalesced wrongly it would leave the last average in
   * place on an agent with no reviews at all.
   */
  it('goes back to zero when the last visible review is removed', async () => {
    const agentId = await seedAgent();
    const reviewer = `oxy-${suffix()}`;
    await upsertAgentReview(db, { agentId, oxyUserId: reviewer, rating: 5, comment: '' });
    await recalculateAgentRating(db, agentId);
    expect((await findAgentById(db, agentId))?.rating).toBe(5);

    await deleteOwnAgentReview(db, agentId, reviewer);
    expect(await recalculateAgentRating(db, agentId)).toEqual({ avg: 0, count: 0 });
    expect((await findAgentById(db, agentId))?.rating).toBe(0);
  });

  /**
   * A caller removing a review for an agent deleted underneath it is ordinary,
   * not an error — `null` is what `routes/agents/reviews.ts` falls back on.
   */
  it('answers null for an agent that no longer exists', async () => {
    expect(await recalculateAgentRating(db, `missing-${suffix()}`)).toBeNull();
  });
});

describe('deleting a review, and deleting the agent under it', () => {
  it('hands back the row it removed, so the caller recomputes the right agent', async () => {
    const agentId = await seedAgent();
    const reviewer = `oxy-${suffix()}`;
    await upsertAgentReview(db, { agentId, oxyUserId: reviewer, rating: 3, comment: '' });

    const deleted = await deleteOwnAgentReview(db, agentId, reviewer);
    expect(deleted?.agentId).toBe(agentId);
    expect(await deleteOwnAgentReview(db, agentId, reviewer)).toBeNull();
  });

  it('does not let one account delete another’s review', async () => {
    const agentId = await seedAgent();
    const mine = `oxy-mine-${suffix()}`;
    await upsertAgentReview(db, { agentId, oxyUserId: mine, rating: 3, comment: '' });

    expect(await deleteOwnAgentReview(db, agentId, `oxy-not-mine-${suffix()}`)).toBeNull();
    expect(await findOwnAgentReview(db, agentId, mine)).not.toBeNull();
  });

  /**
   * BEHAVIOUR CHANGE, deliberate. Mongo's `deleteOne` on an agent cleaned up
   * nothing, so reviews orphaned; `agent_reviews.agent_id` CASCADES because a
   * review's entire content is an opinion of one agent and there is nothing left
   * to read once it is gone.
   */
  it('takes the reviews with the agent', async () => {
    const agentId = await seedAgent();
    await upsertAgentReview(db, { agentId, oxyUserId: `oxy-${suffix()}`, rating: 5, comment: '' });

    await deleteAgent(db, agentId);

    const [remaining] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentReviews)
      .where(eq(agentReviews.agentId, agentId));
    expect(remaining.total).toBe(0);
  });
});

describe('the bounds the schema enforces', () => {
  /**
   * Mongoose declared `min: 1, max: 5` — and 1, not 0, unlike `agents.rating`,
   * which is an AVERAGE and may legitimately be 0 when there are no reviews at
   * all. The two bounds are different on purpose, and only the server can refuse
   * the write.
   */
  it('refuses a rating outside 1..5', async () => {
    const agentId = await seedAgent();
    await expect(
      upsertAgentReview(db, { agentId, oxyUserId: `oxy-${suffix()}`, rating: 0, comment: '' }),
    ).rejects.toThrow();
    await expect(
      upsertAgentReview(db, { agentId, oxyUserId: `oxy-${suffix()}`, rating: 6, comment: '' }),
    ).rejects.toThrow();
  });

  /**
   * `maxlength: 1000` shaped INPUT at the write path and deliberately did NOT
   * become a CHECK: a constraint would fail the backfill on a legacy long
   * string. So a long comment is STORED, and the route is what clamps it.
   */
  it('stores a comment longer than the route’s clamp, rather than refusing it', async () => {
    const agentId = await seedAgent();
    const long = 'x'.repeat(2000);
    const review = await upsertAgentReview(db, {
      agentId,
      oxyUserId: `oxy-${suffix()}`,
      rating: 3,
      comment: long,
    });
    expect(review.comment).toHaveLength(2000);
  });
});

/**
 * The review half of `lib/__tests__/oxy-user-hydration-real-db.test.ts`, moved
 * here with its data.
 *
 * That file used `AgentReview` against a real MongoDB to prove a bug that
 * reached production: `.populate('userId', …)` on a field declared
 * `ref: 'User'` throws `MissingSchemaError`, but ONLY once there is at least one
 * document to populate — so an unreviewed agent worked and the endpoint failed
 * the moment somebody used the feature. This slice deleted that model, and it
 * was the file's LAST subject, so deleting the cases with it would have retired
 * a regression test on the grounds that its fixture changed database. The
 * organization half moved the same way, one slice earlier.
 *
 * The NON-EMPTY fixture is the whole point: the empty case is the one that
 * always passed.
 */
describe('an Oxy-owned author is read without a join, on a NON-EMPTY agent', () => {
  it('hydrates a page of reviews in one batch call', async () => {
    const agentId = await seedAgent();
    const reviewer = `oxy-${suffix()}`;
    await upsertAgentReview(db, { agentId, oxyUserId: reviewer, rating: 5, comment: 'good' });

    getUsersByIds.mockResolvedValue([
      { id: reviewer, username: 'ada', name: { displayName: 'Ada Lovelace' }, avatar: 'file-1' },
    ]);

    const { reviews } = await listVisibleAgentReviews(db, agentId, { limit: 10, offset: 0 });
    // The vacuity floor, and a bare string is what says nothing joined on the
    // way out — a hydrated object in this field is the shape a reintroduced
    // join would take.
    expect(reviews).toHaveLength(1);
    expect(typeof reviews[0].userId).toBe('string');

    const profiles = await hydrateOxyUsers(reviews.map((r) => r.userId));
    expect(profiles.get(reviewer)).toEqual({
      _id: reviewer,
      username: 'ada',
      displayName: 'Ada Lovelace',
      avatar: 'file-1',
    });
    // One round trip for the page, not one per row.
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
  });

  it('deduplicates ids so one author reviewed twice costs one lookup', async () => {
    const userId = `oxy-dupe-${suffix()}`;
    getUsersByIds.mockResolvedValue([]);

    await hydrateOxyUsers([userId, userId, null, undefined, '']);

    expect(getUsersByIds).toHaveBeenCalledWith([userId]);
  });

  it('makes no request at all when there is nobody to resolve', async () => {
    const resolved = await hydrateOxyUsers([]);

    expect(resolved.size).toBe(0);
    expect(getUsersByIds).not.toHaveBeenCalled();
  });

  it('falls back to the handle when Oxy resolved no display name', async () => {
    const id = `oxy-handle-${suffix()}`;
    getUsersByIds.mockResolvedValue([{ id, username: 'grace', name: {} }]);

    // The sanctioned coalesce — never a name recomposed from first/last/full.
    expect((await hydrateOxyUsers([id])).get(id)?.displayName).toBe('grace');
  });

  it('FAILS OPEN: an Oxy outage leaves the reviews readable', async () => {
    const agentId = await seedAgent();
    await upsertAgentReview(db, { agentId, oxyUserId: `oxy-${suffix()}`, rating: 4, comment: '' });
    getUsersByIds.mockRejectedValue(new Error('oxy is unreachable'));

    const { reviews } = await listVisibleAgentReviews(db, agentId, { limit: 10, offset: 0 });
    const profiles = await hydrateOxyUsers(reviews.map((r) => r.userId));

    // An identity lookup must not decide whether somebody's reviews render.
    expect(reviews).toHaveLength(1);
    expect(profiles.size).toBe(0);
  });
});
