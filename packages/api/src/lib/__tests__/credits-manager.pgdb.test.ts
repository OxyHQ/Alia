import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePostgres, connectPostgres } from '../../db/index';
import {
  getOrCreateUserCredits,
  findUserCredits,
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
 * `chat-core` is still stubbed: the credit MULTIPLIER comes from the model
 * catalogue over HTTP and has nothing to do with the balance.
 *
 * Account ids are namespaced `cm-` — the pgdb suite shares one database per run
 * and `user_credits.id` is the account id, so an unqualified `'user-1'` would
 * collide with any other file that ever touches this table.
 */

vi.mock('../chat-core.js', () => ({
  getAliaModel: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));

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

  it('calculates credits from minutes', async () => {
    // 2 min * $0.05/min * 1000 = 100 credits
    expect(await calculateCreditsFromMinutes(2, 'alia-v1-voice', 0.05)).toBe(100);
  });

  it('rounds up partial credits', async () => {
    expect(await calculateCreditsFromMinutes(0.5, 'alia-v1-voice', 0.05)).toBe(25);
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
    // free 3 -> 0, paid absorbs the remaining 2.
    expect(await balanceOf(id)).toEqual({ free: 0, paid: 8 });
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
    // reserved 100, actual: 0.5 min * $0.05/min * 1000 = 25 → refund 75
    const id = await account('cm-voice-refund', 400, 500);

    const result = await finalizeVoiceCredits(
      { userId: id, creditsReserved: 100, initialFreeCredits: 500, initialPaidCredits: 500 },
      0.5,
      'alia-v1-voice',
      0.05,
    );

    expect(result.creditsCharged).toBe(25);
    expect(result.creditsRemaining).toBe(975);
    expect(await balanceOf(id)).toEqual({ free: 475, paid: 500 });
  });
});

describe('refundReservation', () => {
  it('returns the reserved credits to FREE', async () => {
    const id = await account('cm-refund', 10, 10);

    await refundReservation({
      userId: id,
      creditsReserved: 5,
      initialFreeCredits: 10,
      initialPaidCredits: 10,
    });

    // Always to `free`, never to `paid` — a refund of a reservation is not a
    // purchase, and crediting `paid` would hand out a real entitlement.
    expect(await balanceOf(id)).toEqual({ free: 15, paid: 10 });
  });

  it('does not throw for an account that does not exist', async () => {
    // Swallowed and logged, because the caller is an error path that must not
    // throw. The row simply is not there to update.
    await refundReservation({
      userId: 'cm-refund-nobody',
      creditsReserved: 5,
      initialFreeCredits: 10,
      initialPaidCredits: 10,
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
      { userId: id, creditsReserved: 5, initialFreeCredits: 10, initialPaidCredits: 10 },
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

describe('concurrency', () => {
  it('two simultaneous reservations cannot overdraw the balance', async () => {
    const id = await account('cm-race', 10, 0);

    // Both ask for 6 of a balance of 10. Exactly one can win, because the guard
    // and the deduction are the same statement. A read-then-write would let both
    // through and leave -2.
    const [a, b] = await Promise.all([reserveCredits(id, 6), reserveCredits(id, 6)]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(await balanceOf(id)).toEqual({ free: 4, paid: 0 });
  });

  it('the balance never goes negative under a spend larger than it holds', async () => {
    const id = await account('cm-negative', 5, 5);
    expect(await spendCreditsFreeFirst(getDb(), id, 11)).toBeNull();
    expect(await balanceOf(id)).toEqual({ free: 5, paid: 5 });
  });
});
