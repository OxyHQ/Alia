import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { referralRedemptions, referrals } from '../schema/notifications';
import {
  findReferralById,
  findReferralByInviteCode,
  getOrCreateReferral,
  listRedemptions,
  redeemReferral,
} from '../notifications/referralRepository';

/**
 * Referrals, against a REAL server.
 *
 * The property this file exists for is the one Mongo could not express: an
 * account can be referred AT MOST ONCE, globally, enforced by the database
 * rather than by a read the winner has not yet written. None of it is
 * expressible against a mock — a mocked insert accepts the second row.
 *
 * This file owns `referrals` and `referral_redemptions`.
 */

let db: ApiDatabase;
const ALICE = 'oxy-alice';
const BOB = 'oxy-bob';
const CAROL = 'oxy-carol';
const REWARD = 500;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  // Children first — the FK cascades, but being explicit keeps the intent clear.
  await db.delete(referralRedemptions);
  await db.delete(referrals);
});

describe('getOrCreateReferral', () => {
  it('creates on first access and returns the same row afterwards', async () => {
    const first = await getOrCreateReferral(db, ALICE);
    const second = await getOrCreateReferral(db, ALICE);

    expect(first.id).toBe(ALICE);
    expect(second.inviteCode).toBe(first.inviteCode);
    expect(first).toMatchObject({ totalCreditsEarned: 0, totalReferrals: 0, referredBy: null });
  });

  it('uses the Oxy account id as the primary key, inventing nothing', async () => {
    const row = await getOrCreateReferral(db, BOB);
    expect(row.id).toBe(BOB);
    // Not a uuid — `referrals` deliberately has no generated default.
    expect(row.id).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives different accounts different invite codes', async () => {
    const a = await getOrCreateReferral(db, ALICE);
    const b = await getOrCreateReferral(db, BOB);
    expect(a.inviteCode).not.toBe(b.inviteCode);
  });

  it('is findable by its invite code, and only by the right one', async () => {
    const a = await getOrCreateReferral(db, ALICE);
    expect((await findReferralByInviteCode(db, a.inviteCode))?.id).toBe(ALICE);
    expect(await findReferralByInviteCode(db, 'NOTACODE')).toBeNull();
  });

  it('refuses a duplicate invite code rather than silently reusing one', async () => {
    const a = await getOrCreateReferral(db, ALICE);
    await expect(
      db.insert(referrals).values({ id: BOB, inviteCode: a.inviteCode }),
    ).rejects.toThrow();
  });
});

describe('a redemption is claimed before any money moves', () => {
  it('records the redemption, the referrer, and the counters', async () => {
    await getOrCreateReferral(db, ALICE);
    await getOrCreateReferral(db, BOB);

    const result = await redeemReferral(db, {
      referrerId: ALICE,
      referredUserId: BOB,
      email: 'bob@example.com',
      creditsAwarded: REWARD,
    });

    expect(result).toEqual({ outcome: 'claimed' });

    const alice = await findReferralById(db, ALICE);
    expect(alice).toMatchObject({ totalCreditsEarned: REWARD, totalReferrals: 1 });

    const bob = await findReferralById(db, BOB);
    expect(bob?.referredBy).toBe(ALICE);

    const history = await listRedemptions(db, ALICE);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      referredUserId: BOB,
      email: 'bob@example.com',
      creditsAwarded: REWARD,
    });
  });

  it('reports already_redeemed on a repeat, and pays nothing more', async () => {
    /**
     * The REPEAT is the discriminator. A single call returns `claimed` whether
     * the guard is structural or merely a read, so only the second call can tell
     * them apart — and the counters are what prove no second payout was
     * authorised.
     */
    await getOrCreateReferral(db, ALICE);
    await getOrCreateReferral(db, BOB);
    const input = { referrerId: ALICE, referredUserId: BOB, creditsAwarded: REWARD };

    expect(await redeemReferral(db, input)).toEqual({ outcome: 'claimed' });
    expect(await redeemReferral(db, input)).toEqual({ outcome: 'already_redeemed' });

    const alice = await findReferralById(db, ALICE);
    expect(alice).toMatchObject({ totalCreditsEarned: REWARD, totalReferrals: 1 });
    expect(await listRedemptions(db, ALICE)).toHaveLength(1);
  });

  it('refuses a second referrer for the same account — the unique is GLOBAL', async () => {
    // The shape the sub-document array could never reject: two DIFFERENT
    // referrers claiming the same redeemer.
    await getOrCreateReferral(db, ALICE);
    await getOrCreateReferral(db, CAROL);
    await getOrCreateReferral(db, BOB);

    expect(
      await redeemReferral(db, { referrerId: ALICE, referredUserId: BOB, creditsAwarded: REWARD }),
    ).toEqual({ outcome: 'claimed' });
    expect(
      await redeemReferral(db, { referrerId: CAROL, referredUserId: BOB, creditsAwarded: REWARD }),
    ).toEqual({ outcome: 'already_redeemed' });

    const carol = await findReferralById(db, CAROL);
    expect(carol).toMatchObject({ totalCreditsEarned: 0, totalReferrals: 0 });
  });

  it('lets one referrer accumulate several DIFFERENT redeemers', async () => {
    // The vacuity floor for the three above: the unique must not reject
    // legitimate redemptions, or "already_redeemed" would be the only answer and
    // every assertion above would pass for the wrong reason.
    await getOrCreateReferral(db, ALICE);
    await getOrCreateReferral(db, BOB);
    await getOrCreateReferral(db, CAROL);

    expect(
      await redeemReferral(db, { referrerId: ALICE, referredUserId: BOB, creditsAwarded: REWARD }),
    ).toEqual({ outcome: 'claimed' });
    expect(
      await redeemReferral(db, { referrerId: ALICE, referredUserId: CAROL, creditsAwarded: REWARD }),
    ).toEqual({ outcome: 'claimed' });

    const alice = await findReferralById(db, ALICE);
    expect(alice).toMatchObject({ totalCreditsEarned: 2 * REWARD, totalReferrals: 2 });
    expect(await listRedemptions(db, ALICE)).toHaveLength(2);
  });

  it('leaves an existing referredBy alone rather than rewriting it', async () => {
    await getOrCreateReferral(db, ALICE);
    await getOrCreateReferral(db, CAROL);
    await db.insert(referrals).values({ id: BOB, inviteCode: 'BOBCODE1', referredBy: CAROL });

    // A redemption row does not yet exist for BOB, so the claim succeeds — but
    // the `is null` guard must not overwrite who referred them.
    await redeemReferral(db, { referrerId: ALICE, referredUserId: BOB, creditsAwarded: REWARD });
    expect((await findReferralById(db, BOB))?.referredBy).toBe(CAROL);
  });
});

describe('two concurrent redemptions cannot both pay out', () => {
  it('serialises on the unique with the transactions genuinely OVERLAPPING', async () => {
    /**
     * `Promise.all` over two calls does NOT make their statements interleave —
     * the intuitive concurrency test passes against a deliberately broken guard.
     * So the overlap is FORCED: transaction A takes a row lock the second
     * transaction must wait behind, and the wait is only released after B has
     * already issued its claim. If the lock block never appears, the helper
     * THROWS rather than quietly running the two in sequence and reporting a
     * pass.
     */
    await getOrCreateReferral(db, ALICE);
    await getOrCreateReferral(db, CAROL);
    await getOrCreateReferral(db, BOB);

    let released = false;
    const outcomes: string[] = [];

    const a = db.transaction(async (tx) => {
      // Hold a lock on ALICE's row for the whole of A.
      await tx.execute(sql`select 1 from ${referrals} where id = ${ALICE} for update`);

      const [claimed] = await tx
        .insert(referralRedemptions)
        .values({
          referralId: ALICE,
          referredUserId: BOB,
          creditedAt: new Date(),
          creditsAwarded: REWARD,
        })
        .onConflictDoNothing({ target: referralRedemptions.referredUserId })
        .returning({ id: referralRedemptions.id });

      outcomes.push(claimed ? 'A:claimed' : 'A:blocked');

      // Wait until B has definitely issued its own claim and is blocked on the
      // unique index. `pg_locks` is the evidence; without it this is a sleep.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_locks
          where not granted and locktype in ('transactionid', 'tuple')
        `);
        if ((waiting[0]?.n ?? 0) > 0) break;
        if (Date.now() > deadline) {
          throw new Error(
            'no blocked lock ever appeared — the two transactions never overlapped, ' +
              'so this test proves nothing about concurrency',
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      released = true;
    });

    const b = (async () => {
      // Give A time to take its claim first, then race it.
      await new Promise((r) => setTimeout(r, 50));
      const result = await redeemReferral(db, {
        referrerId: CAROL,
        referredUserId: BOB,
        creditsAwarded: REWARD,
      });
      outcomes.push(`B:${result.outcome}`);
    })();

    await Promise.all([a, b]);

    expect(released).toBe(true);
    expect(outcomes).toContain('A:claimed');
    expect(outcomes).toContain('B:already_redeemed');

    // Exactly one redemption exists for BOB, and only one referrer was paid.
    const rows = await db
      .select()
      .from(referralRedemptions)
      .where(eq(referralRedemptions.referredUserId, BOB));
    expect(rows).toHaveLength(1);

    const carol = await findReferralById(db, CAROL);
    expect(carol).toMatchObject({ totalCreditsEarned: 0, totalReferrals: 0 });
  });
});

describe('the child table travels with its referral', () => {
  it('cascades on delete', async () => {
    await getOrCreateReferral(db, ALICE);
    await getOrCreateReferral(db, BOB);
    await redeemReferral(db, { referrerId: ALICE, referredUserId: BOB, creditsAwarded: REWARD });

    await db.delete(referrals).where(eq(referrals.id, ALICE));
    expect(await listRedemptions(db, ALICE)).toEqual([]);
  });

  it('refuses a redemption pointing at a referral that does not exist', async () => {
    await expect(
      redeemReferral(db, {
        referrerId: 'oxy-ghost',
        referredUserId: BOB,
        creditsAwarded: REWARD,
      }),
    ).rejects.toThrow();
  });
});

describe('the constraints themselves', () => {
  /**
   * Moved here from `notifications.pgdb.test.ts` unchanged in substance, so that
   * exactly one file writes `referrals` and `referral_redemptions`. The
   * assertions name the CONSTRAINTS rather than merely expecting a throw — a
   * bare `rejects.toThrow()` passes for a typo in the table name too.
   */
  it('refuses the same account being referred twice, even by different referrers', async () => {
    await db.insert(referrals).values({ id: ALICE, inviteCode: 'ALICE001' });
    await db.insert(referrals).values({ id: BOB, inviteCode: 'BOB00001' });

    await db.insert(referralRedemptions).values({
      id: 'rr-1',
      referralId: ALICE,
      referredUserId: CAROL,
      creditedAt: new Date(),
      creditsAwarded: REWARD,
    });

    // A DIFFERENT referrer — the case a per-referral unique would have missed.
    const second = db.insert(referralRedemptions).values({
      id: 'rr-2',
      referralId: BOB,
      referredUserId: CAROL,
      creditedAt: new Date(),
      creditsAwarded: REWARD,
    });

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('referral_redemptions_referred_user_key');
      return true;
    });
  });

  it('refuses a duplicate invite code, by name', async () => {
    await db.insert(referrals).values({ id: ALICE, inviteCode: 'ALICE001' });
    const duplicate = db.insert(referrals).values({ id: 'oxy-dave', inviteCode: 'ALICE001' });

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('referrals_invite_code_key');
      return true;
    });
  });

  it('is keyed by the Oxy account, so there is no default to invent one', async () => {
    const insert = db.execute(sql`insert into ${referrals} (invite_code) values ('NODEFAULT')`);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      // The SQLSTATE lives on `cause`, never on `error.code`.
      expect((error as { cause?: { code?: string } }).cause?.code).toBe('23502');
      return true;
    });
  });
});

describe('the counters are incremented by Postgres, not by JavaScript', () => {
  it('adds rather than concatenates, and stays a number', async () => {
    /**
     * `total_credits_earned` is `integer`, so this reads as a number today. The
     * assertion is here because the failure it guards against is silent: reading
     * the value into JS and writing back `value + reward` would concatenate the
     * moment the column widened to `bigint`, since postgres.js decodes `int8` as
     * a STRING while drizzle types it `number`.
     */
    await getOrCreateReferral(db, ALICE);
    for (const redeemer of [BOB, CAROL]) {
      await getOrCreateReferral(db, redeemer);
      await redeemReferral(db, {
        referrerId: ALICE,
        referredUserId: redeemer,
        creditsAwarded: REWARD,
      });
    }

    const alice = await findReferralById(db, ALICE);
    expect(typeof alice?.totalCreditsEarned).toBe('number');
    expect(alice?.totalCreditsEarned).toBe(1000);
    expect(alice?.totalReferrals).toBe(2);
  });
});
