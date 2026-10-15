/**
 * A call's credits, per minute at the real cost (ADR 0017 §5).
 *
 * The rate is what a minute costs on the model that serves the call — its
 * catalogue price applied to the units Kaana measures — converted with
 * `creditsForCost`, so it is never a constant of Alia (ADR 0012). Credits are
 * held in BLOCKS of {@link BLOCK_MINUTES}: one is reserved at open, the next
 * one minute before the running cost reaches what is held, and a refused
 * reservation ends the call with `credits-exhausted` after the item being
 * spoken. At the end the call is settled from Kaana's measured units — the
 * session's total when `session.closed` reports one — at the price of the
 * revision that served.
 */

import { CREDITS_CONFIG } from '../credit-price-snapshot.js';
import {
  creditsForCost,
  finalizeFixedCredits,
  refundReservation,
  reserveCredits,
  type CreditReservation,
} from '../credits-manager.js';
import { log } from '../logger.js';

/** How many minutes one reservation holds. */
export const BLOCK_MINUTES = 5;

export interface VoiceCreditDeps {
  reserve(userId: string, credits: number): Promise<CreditReservation | null>;
  finalize(reservation: CreditReservation, credits: number): Promise<unknown>;
  refund(reservation: CreditReservation): Promise<void>;
}

const DEFAULT_DEPS: VoiceCreditDeps = {
  reserve: (userId, credits) => reserveCredits(userId, credits),
  finalize: (reservation, credits) => finalizeFixedCredits(reservation, credits, 'voice'),
  refund: (reservation) => refundReservation(reservation),
};

export class VoiceCreditMeter {
  private readonly blocks: CreditReservation[] = [];
  private heldUsd = 0;
  private settled = false;
  private usdPerMinute: number | null = null;

  constructor(
    private readonly userId: string,
    private readonly deps: VoiceCreditDeps = DEFAULT_DEPS,
  ) {}

  /** Credits currently held, for tests and logs. */
  get creditsHeld(): number {
    return this.blocks.reduce((sum, block) => sum + block.creditsReserved, 0);
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  /**
   * Hold the first block at the candidate's estimated minute. `false` when the
   * balance does not cover it. A model the catalogue does not price is held at
   * the per-request initial reservation, and settled at the minimum, logged —
   * the `calculateCredits` rule for a price that vanished.
   */
  async open(usdPerMinute: number | null): Promise<boolean> {
    this.usdPerMinute = usdPerMinute;
    return this.reserveBlock();
  }

  /** The model that actually serves the call is known: its price sizes later blocks. */
  reprice(usdPerMinute: number | null): void {
    this.usdPerMinute = usdPerMinute;
  }

  private blockCredits(): number {
    if (this.usdPerMinute === null) return CREDITS_CONFIG.INITIAL_RESERVATION;
    return creditsForCost(this.usdPerMinute * BLOCK_MINUTES);
  }

  private async reserveBlock(): Promise<boolean> {
    const credits = this.blockCredits();
    const reservation = await this.deps.reserve(this.userId, credits).catch((err: unknown) => {
      log.credits.error({ err }, 'Voice credit block not reserved');
      return null;
    });
    if (!reservation) return false;
    if (this.settled) {
      // The call ended while this block was being held: give it straight back.
      await this.deps.refund(reservation).catch((err: unknown) => {
        log.credits.error({ err }, 'Voice credit block not refunded');
      });
      return false;
    }
    this.blocks.push(reservation);
    this.heldUsd += this.usdPerMinute === null ? 0 : this.usdPerMinute * BLOCK_MINUTES;
    return true;
  }

  /**
   * Called as the running cost grows. Reserves the next block once less than a
   * minute of what is held remains. `false` means the balance cannot cover the
   * call any further.
   */
  async cover(runningUsd: number): Promise<boolean> {
    if (this.settled) return true;
    if (this.usdPerMinute === null || this.usdPerMinute === 0) return true;
    if (runningUsd + this.usdPerMinute < this.heldUsd) return true;
    return this.reserveBlock();
  }

  /**
   * Charge the call's real cost once. Blocks are consumed in order; a block the
   * cost never reached is refunded, and the last one absorbs the remainder.
   */
  async settle(actualUsd: number | null): Promise<number> {
    if (this.settled) return 0;
    this.settled = true;
    if (this.blocks.length === 0) return 0;
    if (actualUsd === null)
      log.credits.warn(
        { userId: this.userId },
        'Voice call has no priced usage; charging the minimum',
      );
    let remaining = creditsForCost(actualUsd ?? 0);
    const total = remaining;
    for (const [index, block] of this.blocks.entries()) {
      const last = index === this.blocks.length - 1;
      try {
        if (remaining <= 0) {
          await this.deps.refund(block);
          continue;
        }
        const charge = last ? remaining : Math.min(block.creditsReserved, remaining);
        await this.deps.finalize(block, charge);
        remaining -= charge;
      } catch (err) {
        log.credits.error({ err, block: index }, 'Voice credit block not settled');
      }
    }
    return total;
  }

  /** Give everything back: the call never served a second. */
  async release(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    for (const block of this.blocks) {
      await this.deps.refund(block).catch((err: unknown) => {
        log.credits.error({ err }, 'Voice credit block not refunded');
      });
    }
  }
}
