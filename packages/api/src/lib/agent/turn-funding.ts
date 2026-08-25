/**
 * Which account pays for an agent's turn.
 *
 * An agent is its own Oxy account with its own credit balance. When that
 * balance will not cover a turn, the bill falls to its owner — but only if the
 * owner authorised it. Otherwise the turn is refused rather than quietly
 * charged to somebody who did not agree to pay for it.
 *
 * ## The payer is decided ONCE, before anything is reserved
 *
 * There is exactly one reservation and one subject on it. The fallback is a
 * choice made before the debit, not a second debit and not a second subject:
 * `CreditReservation` carries one `userId`, and `finalizeCredits` and
 * `refundReservation` address that field and no other account id — verified,
 * every balance statement in `_adjustReservation` and `refundReservation` reads
 * `reservation.userId`. So a turn cannot be reserved against one account and
 * settled against another, and it cannot change payer halfway through.
 *
 * ## Resolved by ATTEMPT, not by reading the balance first
 *
 * The obvious shape is "read the agent's balance, decide, then spend". Between
 * the read and the spend sits another turn of the same agent. Two concurrent
 * turns both read one credit, both conclude the agent pays, and the second
 * spends against credit that is already gone — leaving it a refusal for an
 * owner who was willing and able to pay.
 *
 * `spendCreditsFreeFirst` is ONE statement whose `WHERE` carries the
 * `credits_free + credits_paid >= amount` guard, and it returns nothing when the
 * balance will not cover it. So the spend already answers the question the read
 * was trying to answer, without a window in between, and it already reports
 * failure. Attempting the agent and reading `null` as "fall through" is
 * therefore both simpler and correct where the read is not.
 *
 * A refused attempt debits NOTHING — the guard and the arithmetic are the same
 * statement — so the fallback is never a partial charge topped up from the
 * owner. That is what keeps "one decision, one subject" true even though two
 * accounts were asked.
 *
 * ## What this module deliberately does not do
 *
 * It does not read the agent's row, its owner or its fallback permission: those
 * arrive as parameters. The column that will carry them does not exist yet, and
 * a module that reached for it could not be built or tested until it did.
 *
 * It does not CREATE the agent's balance row, and the missing row is DELIBERATE
 * rather than an oversight — which is worth saying here, because the next reader
 * to notice its absence will reasonably assume somebody forgot.
 *
 * `getOrCreateUserCredits` seeds `DEFAULT_FREE_CREDITS` (300) and sets
 * `credits_daily_refresh`, so an agent account acquiring its row the ordinary
 * way would collect a standing free allowance that refills every day. Creating
 * agent accounts is cheap, and `user_credits.id` records no account kind — so
 * nothing in the balance table can tell a bot from a person, and the arithmetic
 * is not a pricing detail: **N agents is 300N free credits a day**, for as long
 * as somebody keeps making them. A free-credit farm, one account at a time.
 *
 * So, decided rather than assumed: **an agent's balance arrives ONLY by an
 * explicit transfer from its owner.** No automatic allowance, no daily refresh
 * of its own. An agent whose owner has neither funded it nor authorised the
 * fallback does not run. An agent with no row simply cannot pay, and falls
 * through to exactly that decision.
 *
 * It does not swallow a store failure. `reserveCredits` rethrows when the
 * statement itself fails, and that is not the same event as "the agent cannot
 * pay": treating it as one would move the bill to the owner because of an
 * outage, with nothing to tell them apart afterwards.
 */

import {
  CREDITS_CONFIG,
  reserveCredits,
  type CreditReservation,
} from '../credits-manager.js';
import { log } from '../logger.js';

/** Whose balance a turn was actually taken from. */
export type CreditPayer = 'agent' | 'owner';

export type AgentTurnFunding =
  | { readonly ok: true; readonly payer: CreditPayer; readonly reservation: CreditReservation }
  /**
   * The two refusals are kept apart because they ask the reader for different
   * things: one is a permission the owner can GRANT, the other is credit
   * somebody has to BUY. Collapsing them into "insufficient credits" would tell
   * an owner to top up an account that is not the problem, and the owner has no
   * way to discover that from the message.
   *
   * DO NOT collapse them when wiring this up. The 402 body is the only place
   * either answer reaches the person who can act on it, so a caller that maps
   * both to one string throws away the whole distinction at the last step.
   */
  | { readonly ok: false; readonly reason: 'owner_fallback_not_authorised' | 'both_out_of_credits' };

/**
 * Take the turn's credits from the agent, or from its owner, or from neither.
 *
 * @param agentAccountId The agent's OWN Oxy account id. `user_credits.id` is an
 *   Oxy account id with no `kind` and no foreign key, so a bot account holds a
 *   balance row exactly as a person's does.
 * @param ownerUserId The account the bill falls to. Assumed distinct from
 *   `agentAccountId`; nothing here can check it, because `user_credits` records
 *   no account kind.
 * @param ownerFallbackAllowed Whether the owner authorised paying for this
 *   agent. A parameter rather than a lookup — see the module comment.
 */
export async function reserveAgentTurn(input: {
  readonly agentAccountId: string;
  readonly ownerUserId: string;
  readonly ownerFallbackAllowed: boolean;
  readonly amount?: number;
}): Promise<AgentTurnFunding> {
  const { agentAccountId, ownerUserId, ownerFallbackAllowed } = input;
  const amount = input.amount ?? CREDITS_CONFIG.INITIAL_RESERVATION;

  const fromAgent = await reserveCredits(agentAccountId, amount);
  if (fromAgent) {
    return { ok: true, payer: 'agent', reservation: fromAgent };
  }

  if (!ownerFallbackAllowed) {
    log.credits.info(
      { agentAccountId, amount },
      'Agent turn refused: the agent cannot cover it and its owner has not authorised the fallback',
    );
    return { ok: false, reason: 'owner_fallback_not_authorised' };
  }

  const fromOwner = await reserveCredits(ownerUserId, amount);
  if (fromOwner) {
    log.credits.info({ agentAccountId, ownerUserId, amount }, 'Agent turn billed to the owner');
    return { ok: true, payer: 'owner', reservation: fromOwner };
  }

  log.credits.info({ agentAccountId, ownerUserId, amount }, 'Agent turn refused: neither balance covers it');
  return { ok: false, reason: 'both_out_of_credits' };
}
