import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';

/**
 * Deciding WHO pays for an agent's turn, against a REAL Postgres server.
 *
 * An agent is its own Oxy account with its own balance. When that balance will
 * not cover a turn, it falls to the owner's — but only if the owner authorised
 * it. Otherwise the turn is refused.
 *
 * ## Every case asserts BOTH balances
 *
 * The bug this shape is guarding against does not look like a crash: it looks
 * like the right answer with a second debit beside it. A test that read only
 * the agent's balance would pass just as well against an implementation that
 * charged the agent AND the owner, and a test that read only the owner's would
 * pass against one that charged nobody. So each case names both numbers, and
 * each says which one must NOT have moved.
 *
 * ## The credits are real
 *
 * `reserveCredits`, `finalizeCredits` and `refundReservation` run against the
 * real table. Only the model catalogue is stubbed — the credit multiplier comes
 * from it over HTTP and has nothing to do with which account is charged.
 */

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { credits: child, agents: child, general: child, chat: child, v1: child, providers: child } };
});
vi.mock('../../chat-core.js', () => ({
  getAliaModel: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { userCredits } from '../../../db/schema/billing.js';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository.js';
import { finalizeCredits, refundReservation } from '../../credits-manager.js';
import { reserveAgentTurn } from '../turn-funding.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/**
 * Ids namespaced by pid. The pgdb suite shares ONE database and its files run
 * in parallel, so a fixed account id would collide with a sibling's — and
 * nothing here deletes rows, for the same reason.
 */
const SUITE = `funding-${process.pid}`;
let seq = 0;

/** An account with an exact opening balance. Returns its id. */
async function account(free: number, paid = 0): Promise<string> {
  const id = `${SUITE}-${seq++}`;
  await getOrCreateUserCredits(db, id);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: paid }).where(eq(userCredits.id, id));
  return id;
}

/** An account id that has NO `user_credits` row at all. */
const unprovisioned = (): string => `${SUITE}-absent-${seq++}`;

async function balanceOf(id: string): Promise<{ free: number; paid: number }> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return { free: row.creditsFree, paid: row.creditsPaid };
}

async function rowExists(id: string): Promise<boolean> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  return row !== undefined;
}

describe('reserveAgentTurn — who pays', () => {
  it('charges the AGENT when its own balance covers the turn', async () => {
    const agentAccountId = await account(50);
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({
      agentAccountId,
      ownerUserId,
      ownerFallbackAllowed: true,
      amount: 10,
    });

    expect(funding.ok).toBe(true);
    if (!funding.ok) throw new Error('unreachable');
    expect(funding.payer).toBe('agent');
    expect(await balanceOf(agentAccountId)).toEqual({ free: 40, paid: 0 });
    // The half that catches a double debit. Fallback was ALLOWED here, so an
    // implementation that charged both would still report `payer: 'agent'`.
    expect(await balanceOf(ownerUserId)).toEqual({ free: 100, paid: 0 });
  });

  it('falls to the OWNER when the agent cannot cover it and the owner allows it', async () => {
    const agentAccountId = await account(3);
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({
      agentAccountId,
      ownerUserId,
      ownerFallbackAllowed: true,
      amount: 10,
    });

    expect(funding.ok).toBe(true);
    if (!funding.ok) throw new Error('unreachable');
    expect(funding.payer).toBe('owner');
    expect(await balanceOf(ownerUserId)).toEqual({ free: 90, paid: 0 });
    // The agent's three credits are still there: a reservation that will not
    // fit takes NOTHING, so the fallback is not a partial charge plus a
    // top-up.
    expect(await balanceOf(agentAccountId)).toEqual({ free: 3, paid: 0 });
  });

  it('refuses, moving NOTHING, when the agent is short and the owner has not allowed the fallback', async () => {
    const agentAccountId = await account(3);
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({
      agentAccountId,
      ownerUserId,
      ownerFallbackAllowed: false,
      amount: 10,
    });

    expect(funding).toEqual({ ok: false, reason: 'owner_fallback_not_authorised' });
    expect(await balanceOf(agentAccountId)).toEqual({ free: 3, paid: 0 });
    expect(await balanceOf(ownerUserId)).toEqual({ free: 100, paid: 0 });
  });

  it('refuses, moving NOTHING, when neither can cover it', async () => {
    const agentAccountId = await account(3);
    const ownerUserId = await account(4);

    const funding = await reserveAgentTurn({
      agentAccountId,
      ownerUserId,
      ownerFallbackAllowed: true,
      amount: 10,
    });

    expect(funding).toEqual({ ok: false, reason: 'both_out_of_credits' });
    expect(await balanceOf(agentAccountId)).toEqual({ free: 3, paid: 0 });
    expect(await balanceOf(ownerUserId)).toEqual({ free: 4, paid: 0 });
  });

  /**
   * An agent whose Oxy account has no balance row yet falls to the owner, and
   * this module does NOT create one.
   *
   * `getOrCreateUserCredits` seeds `DEFAULT_FREE_CREDITS` — 300 — and sets
   * `credits_daily_refresh`, so an agent account acquiring its row the ordinary
   * way would collect a standing allowance that refills daily. Agent accounts
   * are cheap to create and `user_credits` records no account kind, so the
   * arithmetic is N agents to 300N free credits a day — a free-credit farm, not
   * a pricing detail.
   *
   * The decision: an agent's balance arrives ONLY by an explicit transfer from
   * its owner. This asserts the ABSENCE of the row, which is the only form the
   * property can take here — a test that merely checked the owner paid would
   * pass while three hundred credits appeared beside it.
   */
  it('does not provision the agent a balance row by asking it to pay', async () => {
    const agentAccountId = unprovisioned();
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({
      agentAccountId,
      ownerUserId,
      ownerFallbackAllowed: true,
      amount: 10,
    });

    expect(funding.ok).toBe(true);
    if (!funding.ok) throw new Error('unreachable');
    expect(funding.payer).toBe('owner');
    expect(await rowExists(agentAccountId)).toBe(false);
    expect(await balanceOf(ownerUserId)).toEqual({ free: 90, paid: 0 });
  });
});

describe('the payer is decided ONCE, and the settlement follows it', () => {
  /**
   * The invariant the whole shape rests on.
   *
   * `finalizeCredits` and `refundReservation` address `reservation.userId` and
   * no other account id — so carrying the payer there is what makes it
   * impossible for a turn to be reserved against one account and settled
   * against another. That is a property of the value this module returns, not
   * of anything the caller remembers to do.
   */
  it('finalizes against the AGENT when the agent paid', async () => {
    const agentAccountId = await account(50);
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({ agentAccountId, ownerUserId, ownerFallbackAllowed: true, amount: 10 });
    if (!funding.ok) throw new Error('the agent balance covers 10');
    expect(funding.reservation.userId).toBe(agentAccountId);

    // Reserved 10, actually used 2000 tokens = 2 credits → 8 back to the AGENT.
    await finalizeCredits(funding.reservation, { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 });

    expect(await balanceOf(agentAccountId)).toEqual({ free: 48, paid: 0 });
    expect(await balanceOf(ownerUserId)).toEqual({ free: 100, paid: 0 });
  });

  it('finalizes against the OWNER when the owner paid', async () => {
    const agentAccountId = await account(3);
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({ agentAccountId, ownerUserId, ownerFallbackAllowed: true, amount: 10 });
    if (!funding.ok) throw new Error('the owner balance covers 10');
    expect(funding.reservation.userId).toBe(ownerUserId);

    await finalizeCredits(funding.reservation, { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 });

    expect(await balanceOf(ownerUserId)).toEqual({ free: 98, paid: 0 });
    expect(await balanceOf(agentAccountId)).toEqual({ free: 3, paid: 0 });
  });

  it('refunds to the AGENT when the agent paid', async () => {
    const agentAccountId = await account(50);
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({ agentAccountId, ownerUserId, ownerFallbackAllowed: true, amount: 10 });
    if (!funding.ok) throw new Error('the agent balance covers 10');

    await refundReservation(funding.reservation);

    expect(await balanceOf(agentAccountId)).toEqual({ free: 50, paid: 0 });
    expect(await balanceOf(ownerUserId)).toEqual({ free: 100, paid: 0 });
  });

  it('refunds to the OWNER when the owner paid', async () => {
    const agentAccountId = await account(3);
    const ownerUserId = await account(100);

    const funding = await reserveAgentTurn({ agentAccountId, ownerUserId, ownerFallbackAllowed: true, amount: 10 });
    if (!funding.ok) throw new Error('the owner balance covers 10');

    await refundReservation(funding.reservation);

    expect(await balanceOf(ownerUserId)).toEqual({ free: 100, paid: 0 });
    expect(await balanceOf(agentAccountId)).toEqual({ free: 3, paid: 0 });
  });

  /**
   * The payer's funding source is the PAYER's, not the agent's.
   *
   * `refundReservation` picks the balance to refund to from `grantKind`, which
   * `reserveCredits` derives from the account it actually spent against. An
   * owner paying out of purchased credit gets purchased credit back even though
   * the turn was the agent's.
   */
  it('returns a paid-funded fallback to the OWNER paid balance', async () => {
    const agentAccountId = await account(0);
    const ownerUserId = await account(0, 100);

    const funding = await reserveAgentTurn({ agentAccountId, ownerUserId, ownerFallbackAllowed: true, amount: 10 });
    if (!funding.ok) throw new Error('the owner paid balance covers 10');
    expect(funding.reservation.grantKind).toBe('paid_balance');

    await refundReservation(funding.reservation);

    expect(await balanceOf(ownerUserId)).toEqual({ free: 0, paid: 100 });
  });
});

describe('a store failure is not "out of credits"', () => {
  /**
   * An outage must not silently move the bill to the owner.
   *
   * `reserveCredits` RETHROWS when the statement itself fails — credits are
   * money and a spend that may or may not have happened cannot be reported as a
   * refusal. Treating that throw as "the agent cannot pay" would charge the
   * owner for a database problem, and the owner would have no way to tell.
   *
   * The failure is REAL: `credits_free` is `integer`, so an amount past int4
   * makes the server raise `22003 numeric value out of range` inside the same
   * statement the production path issues.
   */
  it('propagates, leaving the owner untouched', async () => {
    const agentAccountId = await account(2_000_000_000);
    const ownerUserId = await account(100);

    await expect(
      reserveAgentTurn({
        agentAccountId,
        ownerUserId,
        ownerFallbackAllowed: true,
        amount: 9_999_999_999,
      }),
    ).rejects.toThrow();

    expect(await balanceOf(ownerUserId)).toEqual({ free: 100, paid: 0 });
    expect(await balanceOf(agentAccountId)).toEqual({ free: 2_000_000_000, paid: 0 });
  });
});

describe('two turns racing for the agent last credit', () => {
  /**
   * The decision cannot be a READ followed by a spend, and this is the case
   * that can tell the two apart.
   *
   * ## `Promise.all` does not make two resolutions overlap
   *
   * The first version of this test issued two `reserveAgentTurn` calls without
   * awaiting between and asserted one payer of each. It passed — and it passed
   * against a read-then-decide implementation too, MEASURED by mutation. The
   * reason is `postgres.js`: it PIPELINES onto one connection, so the second
   * resolution's statements simply queue behind the first's and the two never
   * contend. One agent, one owner, and no concurrency whatsoever.
   *
   * ## So the competitor is an uncommitted transaction on its own connection
   *
   * A holder spends the agent's last credit and does NOT commit. The real
   * `reserveAgentTurn` is then issued through the real pool, and is OBSERVED
   * sitting in that holder's lock queue — `pg_blocking_pids` scoped to the
   * holder's own backend pid, so nothing another test file is doing can be
   * mistaken for it. Only then does the holder commit.
   *
   * That places the window exactly where the bug lives. A read-then-decide
   * implementation performs its SELECT before the holder commits, so it sees a
   * balance that still covers the turn and commits to "the agent pays"; its
   * spend then blocks, wakes against the committed row and finds nothing — and
   * it has nowhere to go but a refusal, with an owner who was willing and able
   * to pay left untouched.
   *
   * Resolving by ATTEMPT has no such window: the spend IS the decision, it
   * re-evaluates its own guard against the committed row, returns null, and
   * falls through to the owner.
   */
  it('falls to the owner when the agent balance vanishes under it mid-decision', async () => {
    const agentAccountId = await account(1);
    const ownerUserId = await account(100);

    // Separate connections: a pooled poller would queue behind the holder and
    // the timeout would read as "no contention".
    const holder = postgres(process.env.DATABASE_URL as string, { max: 1 });
    const observer = postgres(process.env.DATABASE_URL as string, { max: 1 });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const blockedByHolder = async (holderPid: number): Promise<number> => {
        const [row] = await observer<{ n: number }[]>`
          select count(*)::int as n
            from pg_stat_activity
           where datname = current_database()
             and ${holderPid}::int = any(pg_blocking_pids(pid))
        `;
        return row?.n ?? 0;
      };

      const waitForBlocked = async (holderPid: number): Promise<void> => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          if ((await blockedByHolder(holderPid)) >= 1) return;
          if (Date.now() > deadline) {
            throw new Error(
              `nothing was blocked by pid ${holderPid} after 10s — the contention this test ` +
                `exists to create did not happen, so nothing was measured`,
            );
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      // The competing turn, uncommitted, holding the agent row's write lock.
      let announcePid!: (pid: number) => void;
      const holderPidReady = new Promise<number>((resolve) => {
        announcePid = resolve;
      });
      const held = holder.begin(async (tx) => {
        await tx`
          update user_credits set credits_free = credits_free - 1
           where id = ${agentAccountId} and credits_free + credits_paid >= 1`;
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        announcePid(pid);
        await released;
      });
      const holderPid = await holderPidReady;

      const racing = reserveAgentTurn({
        agentAccountId,
        ownerUserId,
        ownerFallbackAllowed: true,
        amount: 1,
      });
      await waitForBlocked(holderPid);

      release();
      await held;

      const funding = await racing;
      expect(funding.ok).toBe(true);
      if (!funding.ok) throw new Error('the owner could pay; this turn must not be refused');
      expect(funding.payer).toBe('owner');
      expect(funding.reservation.userId).toBe(ownerUserId);

      // The holder took the agent's last credit; the racing turn took exactly
      // one of the owner's and nothing more.
      expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 0 });
      expect(await balanceOf(ownerUserId)).toEqual({ free: 99, paid: 0 });
    } finally {
      release();
      await holder.end({ timeout: 5 });
      await observer.end({ timeout: 5 });
    }
  });

  it('both pay from the agent when the agent can afford both', async () => {
    const agentAccountId = await account(2);
    const ownerUserId = await account(100);

    const [a, b] = await Promise.all([
      reserveAgentTurn({ agentAccountId, ownerUserId, ownerFallbackAllowed: true, amount: 1 }),
      reserveAgentTurn({ agentAccountId, ownerUserId, ownerFallbackAllowed: true, amount: 1 }),
    ]);

    const payers = [a, b].map((outcome) => (outcome.ok ? outcome.payer : outcome.reason));
    expect(payers).toEqual(['agent', 'agent']);
    expect(await balanceOf(agentAccountId)).toEqual({ free: 0, paid: 0 });
    expect(await balanceOf(ownerUserId)).toEqual({ free: 100, paid: 0 });
  });
});
