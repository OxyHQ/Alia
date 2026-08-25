import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closePostgres, connectPostgres } from '../../db/index';
import {
  addCredits,
  getOrCreateUserCredits,
  findUserCredits,
  refreshFreeCreditsIfDue,
  spendCreditsFreeFirst,
} from '../../db/billing/userCreditsRepository';
import { getDb } from '../../db/index';
import {
  reserveCredits,
  finalizeCredits,
  finalizeVoiceCredits,
  refundReservation,
  safeRefund,
  calculateCreditsFromTokens,
  calculateCreditsFromMinutes,
  getUserCredits,
  CREDITS_CONFIG,
  UnpricedModelError,
  type CreditReservation,
} from '../credits-manager.js';

/**
 * `credits-manager`, against a REAL Postgres server.
 *
 * This suite used to mock the Mongoose UserCredits model and assert which
 * calls were made with which arguments. It could not survive the port and should
 * not have: the whole of it — "spend free before paid", "refuse when the balance
 * will not cover it", "zero out when it will not" — is now ONE SQL statement per
 * operation, and a mocked repository accepts any statement, including one the
 * server would reject. Asserting the arithmetic against real rows is the only
 * version of these tests that means anything.
 *
 * `chat-core` used to be stubbed here, because the credit multiplier came from
 * the model catalogue over HTTP. It does not any more: `getCreditMultiplier`
 * reads `lib/routing/presets.ts`, a static table, so the multiplier in these
 * assertions is the REAL price of the profile named — `alia-v1-voice` bills at
 * 2×, and the voice figures below are that 2× rather than the stub's 1×.
 * Nothing in the billing path fetches anything now, which is why the stub is
 * gone rather than repointed.
 *
 * Account ids are namespaced `cm-` — the pgdb suite shares one database per run
 * and `user_credits.id` is the account id, so an unqualified `'user-1'` would
 * collide with any other file that ever touches this table.
 */

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
});

afterAll(async () => {
  await closePostgres();
});

/** An account with an exact opening balance. */
async function account(id: string, free: number, paid: number): Promise<string> {
  await getOrCreateUserCredits(getDb(), id);
  // Set the balance exactly rather than adding to the 300 default, so every
  // assertion below is about the operation and not about the default.
  const db = getDb();
  const { userCredits } = await import('../../db/schema/billing');
  const { eq } = await import('drizzle-orm');
  await db
    .update(userCredits)
    .set({ creditsFree: free, creditsPaid: paid })
    .where(eq(userCredits.id, id));
  return id;
}

const balanceOf = async (id: string) => {
  const row = await findUserCredits(getDb(), id);
  if (!row) throw new Error(`no balance row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
};

describe('calculateCreditsFromTokens', () => {
  it('returns minimum credits for 0 tokens', async () => {
    expect(await calculateCreditsFromTokens(0)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
  });

  it('calculates credits from token count', async () => {
    // 5000 tokens / 1000 tokens per credit = 5 credits
    expect(await calculateCreditsFromTokens(5000)).toBe(5);
  });

  it('rounds up partial credits', async () => {
    // 1500 tokens / 1000 = 1.5 → ceil = 2
    expect(await calculateCreditsFromTokens(1500)).toBe(2);
  });

  it('subtracts system prompt tokens', async () => {
    // 5000 total - 3000 system = 2000 billable / 1000 = 2
    expect(await calculateCreditsFromTokens(5000, undefined, 3000)).toBe(2);
  });

  it('floors billable tokens at 0 when system > total', async () => {
    expect(await calculateCreditsFromTokens(1000, undefined, 5000)).toBe(
      CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST,
    );
  });

  it('enforces minimum credits', async () => {
    expect(await calculateCreditsFromTokens(1)).toBe(1);
  });
});

describe('calculateCreditsFromMinutes', () => {
  it('returns minimum credits for 0 minutes', async () => {
    expect(await calculateCreditsFromMinutes(0, 'alia-v1-voice', 0.05)).toBe(
      CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST,
    );
  });

  it('calculates credits from minutes, at the profile’s own multiplier', async () => {
    // 2 min * $0.05/min * 1000 = 100 base credits, x2 for `profile:v1-voice`.
    expect(await calculateCreditsFromMinutes(2, 'alia-v1-voice', 0.05)).toBe(200);
    // The multiplier is doing the work, not the arithmetic: the same call on a
    // 1x profile is the base figure. Without this pair, a table that lost every
    // multiplier would still pass the line above.
    expect(await calculateCreditsFromMinutes(2, 'alia-v1', 0.05)).toBe(100);
  });

  it('rounds up partial credits', async () => {
    expect(await calculateCreditsFromMinutes(0.5, 'alia-v1-voice', 0.05)).toBe(50);
  });
});

describe('reserveCredits', () => {
  it('reserves from FREE first and leaves paid untouched', async () => {
    const id = await account('cm-reserve-free', 10, 10);

    const result = await reserveCredits(id, 1);

    expect(result).toEqual({
      userId: id,
      creditsReserved: 1,
      initialFreeCredits: 9,
      initialPaidCredits: 10,
      // The allowance still had room afterwards, so nothing came from the paid
      // bucket and the cost record can say the customer was not billed for it
      // (ADR 0005, `domain/credit-funding.ts`).
      grantKind: 'free_allowance',
    });
    // The ordering is the assertion. Spending paid-first here would leave
    // {free: 10, paid: 9} and every figure above would still look plausible.
    expect(await balanceOf(id)).toEqual({ free: 9, paid: 10 });
  });

  it('spills into PAID only for the part free cannot cover', async () => {
    const id = await account('cm-reserve-spill', 3, 10);

    const result = await reserveCredits(id, 5);

    expect(result?.initialFreeCredits).toBe(0);
    expect(result?.initialPaidCredits).toBe(8);
    // The other branch of the funding source, against a real balance rather
    // than a fixture: a value hardcoded either way fails one of these two.
    expect(result?.grantKind).toBe('paid_balance');
    // free 3 -> 0, paid absorbs the remaining 2.
    expect(await balanceOf(id)).toEqual({ free: 0, paid: 8 });
  });

  it('classifies the request that exhausts the allowance as paid, which is the documented imprecision', async () => {
    // free 4 -> 0 with nothing taken from paid. The statement returns only
    // post-spend values, so this is indistinguishable from finding the
    // allowance already empty, and `domain/credit-funding.ts` says so. Pinned
    // as the behaviour it is: one request per account per refresh, erring
    // toward NOT claiming a turn was free.
    const id = await account('cm-reserve-boundary', 4, 6);

    const result = await reserveCredits(id, 4);

    expect(result?.grantKind).toBe('paid_balance');
    expect(await balanceOf(id)).toEqual({ free: 0, paid: 6 });
  });

  it('returns null for insufficient credits and changes NOTHING', async () => {
    const id = await account('cm-reserve-poor', 2, 3);

    expect(await reserveCredits(id, 100)).toBeNull();
    // The guard is in the same statement as the arithmetic, so a refusal cannot
    // leave a partial deduction behind.
    expect(await balanceOf(id)).toEqual({ free: 2, paid: 3 });
  });

  it('spends exactly to zero when the balance covers it precisely', async () => {
    const id = await account('cm-reserve-exact', 4, 6);
    const result = await reserveCredits(id, 10);
    expect(result).not.toBeNull();
    expect(await balanceOf(id)).toEqual({ free: 0, paid: 0 });
  });

  it('returns null for an account that does not exist', async () => {
    expect(await reserveCredits('cm-reserve-nobody', 1)).toBeNull();
  });
});

describe('finalizeCredits', () => {
  const reservationFor = (userId: string): CreditReservation => ({
    userId,
    creditsReserved: 5,
    initialFreeCredits: 10,
    initialPaidCredits: 10,
    grantKind: 'free_allowance',
  });

  it('refunds the excess to FREE when actual < reserved', async () => {
    // reserved 5, actual 2 → refund 3
    const id = await account('cm-final-refund', 5, 10);

    const result = await finalizeCredits(reservationFor(id), {
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      systemPromptTokens: 0,
    });

    expect(result.creditsCharged).toBe(2);
    expect(result.creditsRemaining).toBe(18);
    expect(await balanceOf(id)).toEqual({ free: 8, paid: 10 });
  });

  it('charges the difference when actual > reserved', async () => {
    // reserved 5, actual 10 → charge 5 more, free-first
    const id = await account('cm-final-charge', 5, 10);

    const result = await finalizeCredits(reservationFor(id), {
      promptTokens: 5000,
      completionTokens: 5000,
      totalTokens: 10000,
      systemPromptTokens: 0,
    });

    expect(result.creditsCharged).toBe(10);
    expect(result.creditsRemaining).toBe(10);
    expect(await balanceOf(id)).toEqual({ free: 0, paid: 10 });
  });

  it('zeroes the balance when it cannot cover the additional charge', async () => {
    const id = await account('cm-final-zero', 0, 2);

    const result = await finalizeCredits(reservationFor(id), {
      promptTokens: 50000,
      completionTokens: 50000,
      totalTokens: 100000,
      systemPromptTokens: 0,
    });

    expect(result.creditsCharged).toBe(100);
    expect(result.creditsRemaining).toBe(0);
    expect(await balanceOf(id)).toEqual({ free: 0, paid: 0 });
  });

  it('reads the balance without writing when the adjustment is zero', async () => {
    // reserved 5, actual 5 → no adjustment
    const id = await account('cm-final-noop', 7, 8);

    const result = await finalizeCredits(reservationFor(id), {
      promptTokens: 2500,
      completionTokens: 2500,
      totalTokens: 5000,
      systemPromptTokens: 0,
    });

    expect(result).toEqual({ creditsCharged: 5, creditsRemaining: 15 });
    expect(await balanceOf(id)).toEqual({ free: 7, paid: 8 });
  });

  it('throws when the account does not exist on the zero-adjustment read path', async () => {
    await expect(
      finalizeCredits(reservationFor('cm-final-ghost-a'), {
        promptTokens: 2500,
        completionTokens: 2500,
        totalTokens: 5000,
        systemPromptTokens: 0,
      }),
    ).rejects.toThrow('User credits not found');
  });

  /**
   * A `finalizeCredits` that THROWS has moved no credits, which is the
   * assumption every release path in the product rests on.
   *
   * `routes/v1/chat-completions.ts`, `lib/chat-lifecycle.ts`, `routes/webhooks.ts`
   * and `routes/v1/voice.ts` all mark the reservation settled only AFTER
   * `finalizeCredits` returns, and refund it in a `finally` when it did not. If a
   * throw could leave a partial charge behind, that refund would pay the account
   * twice for one turn.
   *
   * It cannot, and the reason is structural rather than lucky: every branch of
   * `_adjustReservation` issues exactly one statement and throws only when that
   * statement matched no row. The realistic throw is earlier still — an
   * identifier no routing preset prices — and that is what is driven here, with
   * a real identifier rather than a stub, since the multiplier is now a static
   * read that cannot be made to fail any other way.
   */
  it('moves nothing when the model resolves to no price at all', async () => {
    const id = await account('cm-final-unpriced', 40, 60);

    await expect(
      finalizeCredits(
        { userId: id, creditsReserved: 5, initialFreeCredits: 40, initialPaidCredits: 60, grantKind: 'free_allowance' },
        { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
        'alia-not-a-registered-model',
      ),
    ).rejects.toThrow(UnpricedModelError);

    expect(await balanceOf(id)).toEqual({ free: 40, paid: 60 });

    // The positive control the assertion above needs: the SAME call on a priced
    // identifier settles and does move the balance, so "nothing moved" is a
    // property of the refusal and not of the call shape.
    const priced = await account('cm-final-priced', 40, 60);
    await finalizeCredits(
      { userId: priced, creditsReserved: 5, initialFreeCredits: 40, initialPaidCredits: 60, grantKind: 'free_allowance' },
      { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
      'alia-v1',
    );
    expect(await balanceOf(priced)).toEqual({ free: 43, paid: 60 });
  });

  it('throws when the account vanished before the refund', async () => {
    // The refund path: the update matches no row, which is how "gone" is known.
    await expect(
      finalizeCredits(reservationFor('cm-final-ghost-b'), {
        promptTokens: 1000,
        completionTokens: 1000,
        totalTokens: 2000,
        systemPromptTokens: 0,
      }),
    ).rejects.toThrow('User credits not found');
  });
});

describe('finalizeVoiceCredits', () => {
  it('refunds the excess when the call was shorter than reserved', async () => {
    // reserved 100; actual 0.5 min * $0.05/min * 1000 = 25 base, x2 for
    // `profile:v1-voice` = 50 → refund 50.
    const id = await account('cm-voice-refund', 400, 500);

    const result = await finalizeVoiceCredits(
      { userId: id, creditsReserved: 100, initialFreeCredits: 500, initialPaidCredits: 500, grantKind: 'free_allowance' },
      0.5,
      'alia-v1-voice',
      0.05,
    );

    expect(result.creditsCharged).toBe(50);
    expect(result.creditsRemaining).toBe(950);
    expect(await balanceOf(id)).toEqual({ free: 450, paid: 500 });
  });
});

describe('refundReservation', () => {
  it('returns a FREE-funded reservation to free', async () => {
    const id = await account('cm-refund', 10, 10);

    await refundReservation({
      userId: id,
      creditsReserved: 5,
      initialFreeCredits: 10,
      initialPaidCredits: 10,
      grantKind: 'free_allowance',
    });

    // `free_allowance` is the decisive half of the classification: the allowance
    // still held credits after the spend, so nothing came out of `paid` and
    // crediting `paid` here would hand out a real entitlement.
    expect(await balanceOf(id)).toEqual({ free: 15, paid: 10 });
  });

  /**
   * A PAID-funded reservation comes back to `paid`, and the reason is
   * `refreshFreeCreditsIfDue`.
   *
   * The refund used to go to `free` unconditionally. That is not a cosmetic
   * mislabelling of one column as another: `refreshFreeCreditsIfDue` runs
   * `SET credits_free = credits_free_limit` — an assignment, not an increment —
   * on the first balance read more than 24 hours after the last refresh, and
   * `GET /credits` calls it on every page load. So a credit taken out of the
   * purchased bucket and handed back to the free one is DESTROYED by the next
   * refresh, silently, while the balance the customer was shown in between
   * looked right.
   *
   * The case below is the one that matters commercially and the one the old
   * behaviour always got wrong: an account whose allowance is already spent, so
   * every reservation is funded from money.
   */
  it('returns a PAID-funded reservation to paid', async () => {
    const id = await account('cm-refund-paid', 0, 100);

    // What `reserveCredits` would have produced: free was already empty, so the
    // whole reservation came out of `paid`.
    const reservation = await reserveCredits(id, 50);
    if (!reservation) throw new Error('the balance covers 50; reserveCredits must not refuse');
    expect(reservation.grantKind).toBe('paid_balance');
    expect(await balanceOf(id)).toEqual({ free: 0, paid: 50 });

    await refundReservation(reservation);

    expect(await balanceOf(id)).toEqual({ free: 0, paid: 100 });
  });

  /**
   * The same refund, followed by the refresh that is what makes the wrong
   * bucket cost real money.
   *
   * Without this case, "returns to paid" is a claim about which of two integers
   * moved and a reader may reasonably ask why it matters. Here the account ends
   * the day with the balance it started with; under a refund to `free` it ends
   * it 50 credits poorer, and nothing anywhere reports the loss.
   */
  it('survives the daily free-allowance refresh, which a refund to free does not', async () => {
    const id = await account('cm-refund-refresh', 0, 100);
    // The refresh is due: 25 hours since the last one, and an allowance of 300.
    const db = getDb();
    const { userCredits } = await import('../../db/schema/billing');
    const { eq } = await import('drizzle-orm');
    await db
      .update(userCredits)
      .set({
        creditsFreeLimit: 300,
        creditsLastRefresh: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })
      .where(eq(userCredits.id, id));

    const reservation = await reserveCredits(id, 50);
    if (!reservation) throw new Error('the balance covers 50; reserveCredits must not refuse');
    await refundReservation(reservation);

    const refreshed = await refreshFreeCreditsIfDue(db, id);

    // The allowance is topped back up to its limit, and the 50 purchased credits
    // are still there. A refund to `free` would have left {free: 300, paid: 50}:
    // the same total the customer had BEFORE buying the last 50.
    expect({ free: refreshed?.creditsFree, paid: refreshed?.creditsPaid }).toEqual({
      free: 300,
      paid: 100,
    });
  });

  it('does not throw for an account that does not exist', async () => {
    // Swallowed and logged, because the caller is an error path that must not
    // throw. The row simply is not there to update.
    await refundReservation({
      userId: 'cm-refund-nobody',
      creditsReserved: 5,
      initialFreeCredits: 10,
      initialPaidCredits: 10,
      grantKind: 'free_allowance',
    });
  });
});

describe('safeRefund', () => {
  it('does nothing for a null reservation', async () => {
    const id = await account('cm-saferefund-null', 10, 10);
    await safeRefund(null);
    expect(await balanceOf(id)).toEqual({ free: 10, paid: 10 });
  });

  it('refunds a real reservation', async () => {
    const id = await account('cm-saferefund', 10, 10);
    await safeRefund(
      { userId: id, creditsReserved: 5, initialFreeCredits: 10, initialPaidCredits: 10, grantKind: 'free_allowance' },
      'test reason',
    );
    expect(await balanceOf(id)).toEqual({ free: 15, paid: 10 });
  });
});

describe('getUserCredits', () => {
  it('returns the balance for an existing account, as numbers', async () => {
    const id = await account('cm-get', 10, 20);
    const result = await getUserCredits(id);
    expect(result).toEqual({ free: 10, paid: 20, total: 30 });
    expect(typeof result?.total).toBe('number');
  });

  it('returns null for an account that does not exist', async () => {
    expect(await getUserCredits('cm-get-nobody')).toBeNull();
  });
});

/**
 * What each entry point does when the STORE itself fails.
 *
 * The pre-port suite covered all three by making a mocked Mongoose model throw.
 * That technique does not survive the port and the cases nearly went with it —
 * they are three different deliberate answers to the same event, and each is a
 * decision somebody made:
 *
 *   - `reserveCredits` RETHROWS. Credits are money; a spend that may or may not
 *     have happened must not be reported as success.
 *   - `refundReservation`/`safeRefund` SWALLOW. They already run on the error
 *     path, and a throw here would replace the caller's real error with this one.
 *   - `getUserCredits` returns NULL, which its callers render as "unknown".
 *
 * The failure is REAL, not a stub: `credits_free` is `integer`, so an amount
 * past int4 makes the server raise `22003 numeric value out of range` inside the
 * same statement the production path issues. A mocked rejection would prove the
 * `catch` runs; this proves it runs for something the database can actually do.
 */
describe('when the store itself fails', () => {
  /** Beyond int4, so the ARITHMETIC — not a validation — is what fails. */
  const OVERFLOW = 9_999_999_999;
  /** `22003 numeric_value_out_of_range`. */
  const OUT_OF_RANGE = '22003';

  /**
   * The SQLSTATE, which is NOT on the error.
   *
   * Drizzle rethrows as `Failed query: update "user_credits" …` and hangs the
   * driver's error off `cause`, so matching the message for "out of range" finds
   * nothing — the same trap that makes a ported `err.code === '23505'` collapse
   * silently. Walking the chain is the only reading that works.
   */
  function sqlstateOf(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth++) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
      current = (current as { cause?: unknown }).cause;
    }
    return undefined;
  }

  async function sqlstateOfRejection(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
    } catch (error) {
      return sqlstateOf(error);
    }
    return undefined; // resolved — the caller's assertion will say so
  }

  /**
   * The positive control, and the reason the two "swallows" below mean anything.
   *
   * `resolves.toBeUndefined()` is exactly what a call that never errored also
   * reports, so on its own it cannot tell a swallowed failure from a quiet
   * success. This asserts that the identical statement, issued directly, really
   * does fail — and names WHY, so the suite cannot start passing on some other
   * error that happens to be thrown from the same line.
   */
  it('the overflow used below is a genuine server error', async () => {
    const id = await account('cm-err-control', 2_000_000_000, 0);
    expect(await sqlstateOfRejection(() => addCredits(getDb(), id, OVERFLOW, 'free'))).toBe(
      OUT_OF_RANGE,
    );
    // ...and the balance is untouched, so nothing was half-applied.
    expect(await balanceOf(id)).toEqual({ free: 2_000_000_000, paid: 0 });
  });

  it('reserveCredits rethrows rather than reporting a spend that may not have happened', async () => {
    const id = await account('cm-err-reserve', 2_000_000_000, 2_000_000_000);
    expect(await sqlstateOfRejection(() => reserveCredits(id, OVERFLOW))).toBe(OUT_OF_RANGE);
  });

  it('refundReservation swallows, because it is already on the error path', async () => {
    const id = await account('cm-err-refund', 2_000_000_000, 0);
    await expect(
      refundReservation({
        userId: id,
        creditsReserved: OVERFLOW,
        initialFreeCredits: 0,
        initialPaidCredits: 0,
        grantKind: 'paid_balance',
      }),
    ).resolves.toBeUndefined();
    expect(await balanceOf(id)).toEqual({ free: 2_000_000_000, paid: 0 });
  });

  it('safeRefund swallows too', async () => {
    const id = await account('cm-err-safe', 2_000_000_000, 0);
    await expect(
      safeRefund(
        {
          userId: id,
          creditsReserved: OVERFLOW,
          initialFreeCredits: 0,
          initialPaidCredits: 0,
          grantKind: 'paid_balance',
        },
        'test',
      ),
    ).resolves.toBeUndefined();
    expect(await balanceOf(id)).toEqual({ free: 2_000_000_000, paid: 0 });
  });
});

describe('concurrency', () => {
  it('two simultaneous reservations cannot overdraw the balance', async () => {
    const id = await account('cm-race', 10, 0);

    // Both ask for 6 of a balance of 10. Exactly one can win, because the guard
    // and the deduction are the same statement. A read-then-write would let both
    // through and leave -2.
    //
    // This case does NOT on its own prove the statement is atomic — see the one
    // below, which forces the overlap and refuses to pass without it.
    const [a, b] = await Promise.all([reserveCredits(id, 6), reserveCredits(id, 6)]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(await balanceOf(id)).toEqual({ free: 4, paid: 0 });
  });

  /**
   * The same claim, but with the overlap FORCED and verified.
   *
   * `Promise.all` does not make two statements interleave. It issues them
   * without awaiting between, and whether the two backends are ever inside the
   * row at once is up to the pool and the scheduler — so a read-then-write
   * implementation that happened to serialise would produce exactly one winner
   * and a balance of 4, which is what the case above asserts. That case can
   * therefore pass while measuring nothing.
   *
   * It is worse than theoretical. Measured on this schema against a real server:
   * with the row pinned by another transaction, `pg_stat_activity` shows the
   * pool's connection IDLE and neither spend at the server. postgres.js
   * PIPELINES onto one connection, so issuing two queries — in the same tick or
   * staggered, both were tried — never produces two contending backends; the
   * second waits in the first's connection and they run in order once the lock
   * clears. One winner, balance 4, and no concurrency whatsoever.
   *
   * So the competitor is the holder's OWN transaction, which needs no second
   * pooled connection. The holder spends 6 of 10 and does not commit; the real
   * `spendCreditsFreeFirst` is then issued through `getDb()` and OBSERVED
   * blocked on that uncommitted row — `pg_blocking_pids` scoped to the holder's
   * backend pid, so nothing another test file is doing can be mistaken for it —
   * and only then does the holder commit.
   *
   * That is the whole property, and the discriminator is sharp. Under one
   * statement the blocked spender re-evaluates `free + paid >= 6` against the
   * COMMITTED row (free is now 4) and returns null. Under a read-then-write it
   * had already read 10 and decided it could afford the spend before it blocked,
   * so it would write and leave the balance at -2.
   *
   * The wait THROWS rather than falling through on timeout. A polling loop that
   * gives up quietly reports "no contention observed" in exactly the same way as
   * a harness that never armed, and the second is the likelier of the two.
   */
  it('a spender blocked mid-flight re-checks the balance and refuses', async () => {
    const id = await account('cm-race-forced', 10, 0);

    // TWO connections, not one: the holder's transaction occupies its connection
    // for as long as it holds the lock, so a poller sharing that pool would
    // simply queue behind it and the timeout would look like "no contention".
    const holder = postgres(process.env.DATABASE_URL as string, { max: 1 });
    const observer = postgres(process.env.DATABASE_URL as string, { max: 1 });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      /** How many backends are blocked specifically BY the holder's backend. */
      const blockedByHolder = async (holderPid: number): Promise<number> => {
        const [row] = await observer<{ n: number }[]>`
          select count(*)::int as n
            from pg_stat_activity
           where datname = current_database()
             and ${holderPid}::int = any(pg_blocking_pids(pid))
        `;
        return row?.n ?? 0;
      };

      const waitForBlocked = async (holderPid: number, want: number): Promise<void> => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const n = await blockedByHolder(holderPid);
          if (n >= want) return;
          if (Date.now() > deadline) {
            throw new Error(
              `only ${n} of ${want} backends were blocked by pid ${holderPid} after 10s — the ` +
                `contention this test exists to create did not happen, so nothing was measured`,
            );
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      // The competing spend, uncommitted, holding the row's write lock. The pid
      // is read INSIDE the transaction so it names the backend actually holding
      // it.
      let announcePid!: (pid: number) => void;
      const holderPidReady = new Promise<number>((resolve) => {
        announcePid = resolve;
      });
      const held = holder.begin(async (tx) => {
        await tx`
          update user_credits set credits_free = credits_free - 6
           where id = ${id} and credits_free + credits_paid >= 6`;
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        announcePid(pid);
        await released;
      });
      const holderPid = await holderPidReady;

      // Issued through the REAL pool and the REAL repository function, then
      // proved to be sitting in the holder's lock queue.
      const blocked = spendCreditsFreeFirst(getDb(), id, 6);
      await waitForBlocked(holderPid, 1);

      release();
      await held;

      // It woke up, re-read the row the holder committed (free = 4) and refused.
      expect(await blocked).toBeNull();
      expect(await balanceOf(id)).toEqual({ free: 4, paid: 0 });
    } finally {
      release();
      await holder.end({ timeout: 5 });
      await observer.end({ timeout: 5 });
    }
  });

  it('the balance never goes negative under a spend larger than it holds', async () => {
    const id = await account('cm-negative', 5, 5);
    expect(await spendCreditsFreeFirst(getDb(), id, 11)).toBeNull();
    expect(await balanceOf(id)).toEqual({ free: 5, paid: 5 });
  });
});
