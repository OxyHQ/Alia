import { reserveProductCreditAllocation, settleProductCreditAllocation, type ProductCreditSnapshot } from './product-credit-allocations';
import { and, eq } from 'drizzle-orm';
import {
  creditOperations,
  creditOperationRequests,
  creditPriceBooks,
  creditPriceBookModels,
} from '../db/schema/credit-operations.js';
import { CREDITS_CONFIG, CREDIT_FORMULA_VERSION, type CreditPriceBook } from './credit-price-snapshot.js';
export { CREDITS_CONFIG } from './credit-price-snapshot.js';
import { getDb, type Executor } from '../db/index.js';
import {
  addCredits as addCreditsToBalance,
  findUserCredits,
  spendCreditsFreeFirst,
  zeroCredits,
  type UserCreditsRow,
} from '../db/billing/userCreditsRepository.js';
import { log } from './logger.js';
import { findCatalogueModel } from './models/catalogue.js';
import { fundingSourceOf, type CreditFundingSource } from '../domain/credit-funding.js';

/**
 * Credits Manager
 *
 * A turn is charged by what it COST (ADR 0012): the metered token units times
 * the model's unit prices from Oxy's catalogue — the same price list Oxy
 * settles against — converted at {@link CREDITS_CONFIG.USD_PER_CREDIT}. Plans
 * differ only by how many credits they grant; no model is priced by a
 * multiplier Alia invented.
 */

export interface CreditUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  systemPromptTokens?: number; // Tokens from our system prompt (not charged to user)
  /**
   * The output tokens the model spent THINKING, as the provider reported them.
   *
   * Already inside {@link completionTokens} — a breakdown, not extra volume —
   * and priced at the model's output price with the rest of the output. Kept
   * for the usage log.
   */
  reasoningTokens?: number;
}

export interface CreditReservation {
  userId: string;
  creditsReserved: number;
  initialFreeCredits: number;
  initialPaidCredits: number;
  /**
   * Which balance funded this reservation, carried to whatever cost record the
   * request produces. ADR 0005: free and promotional usage is still
   * cost-attributed internally, so a settlement must be able to say the customer
   * was not billed WITHOUT that meaning nobody measured the cost.
   *
   * `domain/credit-funding.ts` states exactly what each value asserts and the
   * two things it deliberately does not.
   */
  grantKind: CreditFundingSource;
  /** Server-created admission identity and immutable pricing, absent for legacy callers. */
  operationId?: string;
  productAllocationId?: string;
  refreshProductCreditSnapshot?: () => Promise<ProductCreditSnapshot | undefined>;
  priceBook?: CreditPriceBook;
}

/** Credits for a USD cost, rounded up and floored at the per-request minimum. */
export function creditsForCost(usd: number, book?: CreditPriceBook): number {
  const config = book?.config ?? CREDITS_CONFIG;
  if (!Number.isFinite(usd) || usd <= 0) return config.MIN_CREDITS_PER_REQUEST;
  // Rounded to 1e-9 first so float noise (0.1 + 0.2) never adds a credit.
  const exact =
    Math.round((usd / config.USD_PER_CREDIT) * (book?.roundingScale ?? 1e9)) / (book?.roundingScale ?? 1e9);
  return Math.max(Math.ceil(exact), config.MIN_CREDITS_PER_REQUEST);
}

/** The base-rate charge for a token count nothing prices. */
function baseRateCredits(tokens: number, book?: CreditPriceBook): number {
  const config = book?.config ?? CREDITS_CONFIG;
  return Math.max(Math.ceil(tokens / config.TOKENS_PER_CREDIT), config.MIN_CREDITS_PER_REQUEST);
}

/**
 * What a turn costs in credits.
 *
 * - `modelId` absent: the caller priced its own work — base rate.
 * - a catalogue model with token prices: input × input price + output × output
 *   price, in USD, converted to credits. The system prompt Alia adds is Alia's
 *   cost, not the person's, so it is taken off the input first. Reasoning
 *   tokens are output tokens and are already inside `completionTokens`.
 * - a model the catalogue no longer prices: base rate, logged. The model was
 *   validated when the turn started; a price that vanished mid-turn is not a
 *   reason to leave the turn unbilled or to refuse it after the fact.
 */
export async function calculateCredits(
  usage: CreditUsage,
  modelId?: string,
  book?: CreditPriceBook,
): Promise<number> {
  const systemTokens = Math.max(0, usage.systemPromptTokens || 0);
  const totalTokens = Math.max(0, usage.totalTokens || usage.promptTokens + usage.completionTokens);
  if (totalTokens === 0) return (book?.config ?? CREDITS_CONFIG).MIN_CREDITS_PER_REQUEST;

  if (modelId === undefined) return baseRateCredits(Math.max(0, totalTokens - systemTokens), book);

  const model =
    book === undefined
      ? await findCatalogueModel(modelId).catch((err: unknown) => {
          log.credits.warn(
            { err, modelId },
            'Catalogue unavailable while pricing a turn; charging the base rate',
          );
          return null;
        })
      : { pricing: book.models[modelId] ?? null };
  if (model?.pricing == null) {
    log.credits.warn({ modelId }, 'No catalogue price for this model; charging the base rate');
    return baseRateCredits(Math.max(0, totalTokens - systemTokens), book);
  }

  const inputTokens = Math.max(0, (usage.promptTokens || 0) - systemTokens);
  const outputTokens = Math.max(0, usage.completionTokens || 0);
  const usd =
    (inputTokens * Number(model.pricing.inputPerMTok)) / 1_000_000 +
    (outputTokens * Number(model.pricing.outputPerMTok)) / 1_000_000;
  const credits = creditsForCost(usd, book);
  log.credits.info({ modelId, inputTokens, outputTokens, systemTokens, usd, credits }, 'Priced turn');
  return credits;
}

/**
 * Reserve initial credits for a request
 * Returns null if insufficient credits
 */
export async function reserveCredits(
  userId: string,
  amount: number = CREDITS_CONFIG.INITIAL_RESERVATION,
  admission?: { priceBook: CreditPriceBook; requestedModel: string; aliaRequestId?: string; productCreditSnapshot?: ProductCreditSnapshot },
): Promise<CreditReservation | null> {
  try {
    /**
     * Deduct from free credits first, then paid — one guarded statement, as the
     * `$cond` pipeline was. A null result means the balance will not cover it,
     * or the account does not exist.
     *
     * The source also `$set` a `credits.lastUsed`. That path is not in the
     * Mongoose schema, so `strict` dropped it on every write and it has never
     * been stored; there is no column for it and none is added.
     */
    let operationId: string | undefined;
    let productAllocationId: string | undefined;
    const reserveResult =
      admission === undefined
        ? await spendCreditsFreeFirst(getDb(), userId, amount)
        : await getDb().transaction(async (tx) => {
            let balance = await spendCreditsFreeFirst(tx, userId, amount);
            if (balance === null && admission.productCreditSnapshot) {
              const allocation = await reserveProductCreditAllocation(tx,userId,admission.productCreditSnapshot,amount);
              if (allocation) { productAllocationId = allocation.id; balance = await findUserCredits(tx,userId);
                if(!balance) throw new Error('Product credit account is unavailable'); }
            }
            if (balance === null) return null;
            const book = admission.priceBook;
            const insertedBook = await tx
              .insert(creditPriceBooks)
              .values({
                id: book.id,
                source: book.source,
                formulaVersion: book.formulaVersion,
                fallbackRule: book.fallbackRule,
                roundingScale: book.roundingScale,
                usdPerCredit: String(book.config.USD_PER_CREDIT),
                tokensPerCredit: book.config.TOKENS_PER_CREDIT,
                minimumCredits: book.config.MIN_CREDITS_PER_REQUEST,
                initialReservation: book.config.INITIAL_RESERVATION,
                capturedAt: new Date(book.capturedAt),
              })
              .onConflictDoNothing()
              .returning({ id: creditPriceBooks.id });
            const entries = Object.entries(book.models).map(([modelId, pricing]) => ({
              bookId: book.id,
              modelId,
              inputPerMTok: pricing?.inputPerMTok ?? null,
              outputPerMTok: pricing?.outputPerMTok ?? null,
              priceVersionId: pricing?.priceVersionId ?? null,
            }));
            if (insertedBook.length && entries.length)
              await tx.insert(creditPriceBookModels).values(entries).onConflictDoNothing();
            if (balance !== null) {
              const [operation] = await tx
                .insert(creditOperations)
                .values({
                  userId,
                  bookId: book.id,
                  aliaRequestId: admission.aliaRequestId ?? null,
                  requestedModel: admission.requestedModel,
                  capturedAt: new Date(book.capturedAt),
                  status: 'admitted',
                  creditsReserved: amount,
                  grantKind: productAllocationId ? 'product_allowance' : fundingSourceOf(balance.creditsFree),
                  productAllocationId,
                  initialFreeCredits: balance.creditsFree,
                  initialPaidCredits: balance.creditsPaid,
                })
                .returning({ id: creditOperations.id });
              if (operation === undefined) throw new Error('Missing server admission identity');
              operationId = operation.id;
            }
            return balance;
          });

    if (!reserveResult) {
      log.credits.info({ userId }, 'Insufficient credits for user');
      return null;
    }

    /**
     * The funding source, decided by the one value the statement can report.
     *
     * `spendCreditsFreeFirst` takes the free allowance first, so a NON-ZERO
     * remainder proves the whole reservation came out of it and the paid bucket
     * was untouched. Zero does not prove the opposite — the allowance may have
     * been emptied by exactly this reservation — and that is the documented
     * imprecision in `domain/credit-funding.ts`, which errs toward not claiming
     * a turn was free.
     *
     * Derived here rather than in the repository because it is an ATTRIBUTION
     * decision, not a balance one, and the repository's whole contract is that
     * each balance change is one statement returning the row it wrote.
     */
    const grantKind: CreditFundingSource = productAllocationId ? 'product_allowance' : fundingSourceOf(reserveResult.creditsFree);

    log.credits.info({ amount, userId, grantKind }, 'Reserved credits for user');
    log.credits.info(
      { free: reserveResult.creditsFree, paid: reserveResult.creditsPaid },
      'Remaining credits',
    );

    return {
      userId,
      creditsReserved: amount,
      initialFreeCredits: reserveResult.creditsFree,
      initialPaidCredits: reserveResult.creditsPaid,
      grantKind,
      ...(admission === undefined ? {} : { operationId, priceBook: admission.priceBook }),
      ...(productAllocationId ? {productAllocationId} : {}),
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error reserving credits');
    throw error;
  }
}

/**
 * Shared credit adjustment logic used by both finalizeCredits and finalizeFixedCredits.
 * Handles refund-if-over or charge-if-under relative to the initial reservation.
 */
async function _adjustReservation(
  reservation: CreditReservation,
  actualCreditsNeeded: number,
  label: string,
  executor: Executor = getDb(),
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  const creditAdjustment = reservation.creditsReserved - actualCreditsNeeded;
  log.credits.info(
    {
      userId: reservation.userId,
      reserved: reservation.creditsReserved,
      actualNeeded: actualCreditsNeeded,
      creditAdjustment,
    },
    `Finalizing ${label}`,
  );

  // Each branch resolves the up-to-date doc in a single round trip; a null result
  // is the not-found signal (no separate existence read needed).
  let updatedCredits: UserCreditsRow | null;

  if (creditAdjustment > 0) {
    // To the bucket that funded the reservation — see `refundBucket`.
    const bucket = refundBucket(reservation);
    updatedCredits = await addCreditsToBalance(executor, reservation.userId, creditAdjustment, bucket);
    if (updatedCredits) {
      log.credits.info({ refunded: creditAdjustment, bucket }, `Refunded ${label} credits`);
    }
  } else if (creditAdjustment < 0) {
    const additionalCredits = Math.abs(creditAdjustment);

    updatedCredits = await spendCreditsFreeFirst(executor, reservation.userId, additionalCredits);

    if (!updatedCredits) {
      // Guard matched nothing: either insufficient balance (user exists) or the
      // user is gone. Zero-out succeeds for the former, returns null for the latter.
      updatedCredits = await zeroCredits(executor, reservation.userId);
      if (updatedCredits) {
        log.credits.warn(`Insufficient credits for additional ${label} charge, set to 0`);
      }
    } else {
      log.credits.info({ additionalCredits }, `Charged additional ${label} credits`);
    }
  } else {
    // No adjustment needed: read current balance to report remaining credits.
    updatedCredits = await findUserCredits(executor, reservation.userId);
  }

  if (!updatedCredits) {
    throw new Error('User credits not found');
  }

  const totalRemaining = updatedCredits.creditsFree + updatedCredits.creditsPaid;
  log.credits.info(
    { free: updatedCredits.creditsFree, paid: updatedCredits.creditsPaid, total: totalRemaining },
    `Final ${label} credits`,
  );

  return {
    creditsCharged: actualCreditsNeeded,
    creditsRemaining: totalRemaining,
  };
}

/**
 * Settle a reservation against what the turn actually cost.
 * If actual usage > reserved: deduct more
 * If actual usage < reserved: refund difference
 *
 * @param modelId - the `publisher/model` the turn ran on; omitted by callers
 *   that settle at the base rate on purpose.
 */
export async function finalizeCredits(
  reservation: CreditReservation,
  usage: CreditUsage,
  modelId?: string,
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    if (reservation.operationId !== undefined)
      return await settleTrackedReservation(reservation, usage, modelId);
    const actualCreditsNeeded = await calculateCredits(usage, modelId);
    log.credits.info(
      {
        totalTokens: usage.totalTokens,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        systemTokens: usage.systemPromptTokens || 0,
        reasoningTokens: usage.reasoningTokens || 0,
      },
      'Token usage',
    );
    return await _adjustReservation(reservation, actualCreditsNeeded, 'chat');
  } catch (error) {
    log.credits.error({ err: error }, 'Error finalizing credits');
    throw error;
  }
}

/**
 * Settle a reservation against a credit count the caller ALREADY computed.
 *
 * ## Why this exists, rather than another conversion
 *
 * `finalizeCredits` takes tokens, because that is the unit a chat turn is
 * measured in. A generated show is not: it is priced from the DURATION of the
 * audio it produced, by a formula that belongs to the show module.
 *
 * Before this existed, the show pipeline bridged the gap by inventing a token
 * count — `finalizeCredits(reservation, { totalTokens: credits * 50 })` — which
 * is not a conversion but a coincidence. `calculateCredits` divides by
 * `TOKENS_PER_CREDIT`, which is 1000, so `credits * 50` tokens settles as
 * `ceil(credits / 20)`: a show intending to charge 8 credits charged 1. The
 * factor and the divisor were never related, so nothing about the
 * expression looked wrong, and no test could catch it — both sides typecheck
 * and both are integers.
 *
 * A caller that knows its own price should say the price. That is all this is:
 * the same refund-if-over, charge-if-under adjustment every other finalizer
 * runs, with no unit in the middle to get wrong.
 *
 * ## The token round trip is not merely ugly, it is CONDITIONALLY correct
 *
 * The obvious repair for the laundering above is to keep going through
 * `finalizeCredits` and pass `credits * TOKENS_PER_CREDIT` instead. That does
 * round-trip at the base rate — but only while `modelId` is omitted, so a
 * caller adding one later silently reprices its own work at that model's
 * token prices. The identity holds by accident of an argument nobody
 * passed, which is the same shape as the bug it would be fixing.
 *
 * ## What the CALLER must do with the return value
 *
 * `creditsCharged` is what was SETTLED, after the floor and the rounding below.
 * A caller that records a cost must record THIS, not the number it asked for.
 * The show pipeline stored its intended figure while the ledger moved a
 * different one, and the two disagreed for as long as that code existed because
 * nothing ever compared them.
 *
 * `label` names the domain in the ledger logs, exactly as `'chat'` does.
 */
export async function finalizeFixedCredits(
  reservation: CreditReservation,
  credits: number,
  label: string,
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  /**
   * Floored at the minimum and rounded UP, here rather than in the caller.
   *
   * `calculateCredits` ends on
   * `Math.max(Math.ceil(…), MIN_CREDITS_PER_REQUEST)`, so a caller reaching
   * `_adjustReservation` without it would be the one billing path that can
   * charge a fraction of a credit, or zero. Doing it here keeps the two
   * finalizers agreeing about what a settled charge can be.
   */
  const chargeable = Math.max(Math.ceil(credits), CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
  if (!Number.isFinite(credits) || credits < 0) throw new Error('Invalid fixed credit charge');
  if (!reservation.operationId) return _adjustReservation(reservation, chargeable, label);
  const refreshed = reservation.refreshProductCreditSnapshot
    ? await reservation.refreshProductCreditSnapshot().catch(() => undefined)
    : reservation.productAllocationId
      ? await (await import('./product-credit-access')).readConfiguredProductCreditSnapshotForService(reservation.userId).catch(() => undefined)
      : undefined;
  return getDb().transaction(async (tx) => {
    const operation = await lockCreditOperation(tx, reservation);
    if (operation.status === 'refunded') throw new Error('A refunded operation cannot be settled');
    if (operation.status === 'settled') {
      if (operation.creditsRequested !== chargeable || operation.promptTokens !== null
        || operation.servedModelId !== null || operation.pricingRule !== null)
        throw new Error('Conflicting fixed credit settlement replay');
      if (operation.productAllocationId) {
        const { productCreditAllocations } = await import('../db/schema/product-credit-allocations');
        const [allocation] = await tx.select().from(productCreditAllocations)
          .where(eq(productCreditAllocations.id, operation.productAllocationId));
        if (!allocation || operation.creditsCharged === null) throw new Error('Settled product operation is incomplete');
        const { isProductAllocationAuthorized } = await import('./product-credit-allocations');
        return { creditsCharged: operation.creditsCharged, creditsRemaining: allocation.active
          && isProductAllocationAuthorized(allocation, reservation.userId, refreshed)
          ? allocation.included - allocation.consumed - allocation.reserved : 0 };
      }
      const balance = await findUserCredits(tx, reservation.userId);
      if (!balance || operation.creditsCharged === null) throw new Error('Settled credit operation is incomplete');
      return { creditsCharged: operation.creditsCharged, creditsRemaining: balance.creditsFree + balance.creditsPaid };
    }
    const result = operation.productAllocationId
      ? await settleProductCreditAllocation(tx, reservation.userId, operation.productAllocationId,
          operation.creditsReserved, chargeable, new Date(), refreshed)
      : await _adjustReservation(reservation, chargeable, label, tx);
    await tx.update(creditOperations).set({ status: 'settled', creditsRequested: chargeable,
      creditsCharged: result.creditsCharged, settledAt: new Date() }).where(eq(creditOperations.id, operation.id));
    return result;
  });
}

/**
 * Safely refund a credit reservation, swallowing errors.
 * Use this in error-handling paths where you must not throw.
 */
export async function safeRefund(reservation: CreditReservation | null, reason?: string): Promise<void> {
  if (!reservation) return;
  await refundReservation(reservation);
  if (reason) {
    log.credits.info({ reason }, 'Refunded credits');
  }
}

/**
 * Which balance a reservation is given back to.
 *
 * ## Returning everything to `free` DESTROYED purchased credit
 *
 * `refreshFreeCreditsIfDue` runs `SET credits_free = credits_free_limit` — an
 * assignment, not an increment — once a day, and `GET /credits` triggers it on
 * every balance view. So a credit taken out of `credits_paid` and handed back to
 * `credits_free` survives only until the next refresh, and then is gone. The
 * customer sees a correct total in between, which is why nothing ever reported
 * it: the money disappears one refresh after the refund, attributable to
 * nothing.
 *
 * `credits_paid` is the durable bucket — purchases and promotional grants
 * (`routes/referrals.ts`) — and the refresh never touches it.
 *
 * ## The bound on `grantKind`, which is not exact and does not need to be
 *
 * `domain/credit-funding.ts` states the imprecision: a reservation that takes
 * the free allowance to exactly zero reads as `paid_balance` though it may have
 * come wholly out of the allowance. Refunding it to `paid` therefore credits up
 * to `creditsReserved` more purchased balance than was taken.
 *
 * That is at most ONE reservation per account per allowance refresh — the single
 * one that crosses the boundary — and only when it is refunded rather than
 * charged. Against it: every reservation of an account whose allowance is
 * already spent was funded from money and was previously confiscated, every
 * time. The residual error is bounded, rare, and falls on the customer's side;
 * the behaviour it replaces was unbounded, common, and fell on ours.
 *
 * Making it exact would mean `spendCreditsFreeFirst` reporting the split it
 * applied, which its post-spend RETURNING cannot express — that is a change to
 * the one-statement shape of the balance path, not to a refund.
 */
function refundBucket(reservation: CreditReservation): 'free' | 'paid' {
  return reservation.grantKind === 'paid_balance' ? 'paid' : 'free';
}

/**
 * Refund all reserved credits (in case of error before streaming)
 */
export async function refundReservation(reservation: CreditReservation): Promise<void> {
  try {
    if (reservation.operationId !== undefined) {
      await refundTrackedReservation(reservation);
      return;
    }
    const bucket = refundBucket(reservation);
    await addCreditsToBalance(getDb(), reservation.userId, reservation.creditsReserved, bucket);
    log.credits.info(
      { refunded: reservation.creditsReserved, userId: reservation.userId, bucket },
      'Refunded credits to user',
    );
  } catch (error) {
    log.credits.error({ err: error }, 'Error refunding credits');
  }
}

/**
 * Get current credits for a user
 */
export async function getUserCredits(
  userId: string,
): Promise<{ free: number; paid: number; total: number } | null> {
  try {
    const userCredits = await findUserCredits(getDb(), userId);
    if (!userCredits) {
      return null;
    }

    return {
      free: userCredits.creditsFree,
      paid: userCredits.creditsPaid,
      total: userCredits.creditsFree + userCredits.creditsPaid,
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error getting user credits');
    return null;
  }
}

async function lockCreditOperation(tx: Executor, reservation: CreditReservation) {
  const [operation] = await tx
    .select()
    .from(creditOperations)
    .where(
      and(
        eq(creditOperations.id, reservation.operationId ?? ''),
        eq(creditOperations.userId, reservation.userId),
      ),
    )
    .for('update');
  if (
    operation === undefined ||
    (reservation.priceBook !== undefined && operation.bookId !== reservation.priceBook.id) ||
    operation.creditsReserved !== reservation.creditsReserved ||
    operation.grantKind !== reservation.grantKind ||
    (operation.productAllocationId ?? undefined) !== reservation.productAllocationId
  )
    throw new Error('Credit admission does not match its persisted operation');
  return operation;
}

/** Called only with an id reported by Oxy's authenticated SDK response/start. */
export async function recordCreditInferenceRequest(
  reservation: CreditReservation | null,
  request: { requestId: string; modelReference: string | null },
): Promise<void> {
  if (reservation?.operationId === undefined) return;
  await getDb().transaction(async (tx) => {
    const operation = await lockCreditOperation(tx, reservation);
    if (operation.status !== 'admitted') {
      const [existing] = await tx
        .select()
        .from(creditOperationRequests)
        .where(eq(creditOperationRequests.requestId, request.requestId));
      if (existing?.operationId !== operation.id || existing.modelReference !== request.modelReference)
        throw new Error('Terminal operation cannot accept new Oxy requests');
      return;
    }
    await tx
      .insert(creditOperationRequests)
      .values({ operationId: reservation.operationId ?? '', ...request })
      .onConflictDoNothing();
    const [linked] = await tx
      .select()
      .from(creditOperationRequests)
      .where(eq(creditOperationRequests.requestId, request.requestId));
    if (linked?.operationId !== reservation.operationId || linked.modelReference !== request.modelReference)
      throw new Error('Oxy request does not match its credit operation');
  });
}

async function settleTrackedReservation(
  reservation: CreditReservation,
  usage: CreditUsage,
  modelId?: string,
) {
  const refreshedProductSnapshot = reservation.refreshProductCreditSnapshot
    ? await reservation.refreshProductCreditSnapshot().catch(() => undefined)
    : reservation.productAllocationId
      ? await (await import('./product-credit-access')).readConfiguredProductCreditSnapshotForService(reservation.userId).catch(() => undefined)
      : undefined;
  return getDb().transaction(async (tx) => {
    const operation = await lockCreditOperation(tx, reservation);
    if (operation.status === 'refunded') throw new Error('A refunded operation cannot be settled');
    if (operation.status === 'settled') {
      if (
        operation.servedModelId !== (modelId ?? null) ||
        operation.promptTokens !== usage.promptTokens ||
        operation.completionTokens !== usage.completionTokens ||
        operation.totalTokens !== usage.totalTokens ||
        operation.systemPromptTokens !== (usage.systemPromptTokens ?? 0) ||
        operation.reasoningTokens !== (usage.reasoningTokens ?? 0)
      )
        throw new Error('Conflicting credit settlement replay');
      if(operation.productAllocationId) {
        const {productCreditAllocations} = await import('../db/schema/product-credit-allocations');
        const [allocation] = await tx.select().from(productCreditAllocations).where(eq(productCreditAllocations.id,operation.productAllocationId));
        if(!allocation || operation.creditsCharged === null) throw new Error('Settled product operation is incomplete');
        return {creditsCharged:operation.creditsCharged,creditsRemaining:allocation.active && (await import('./product-credit-allocations')).isProductAllocationAuthorized(allocation,reservation.userId,refreshedProductSnapshot) && +allocation.periodEnd>Date.now()
          ? allocation.included-allocation.consumed-allocation.reserved : 0};
      }
      const balance = await findUserCredits(tx, reservation.userId);
      if (balance === null || operation.creditsRequested === null)
        throw new Error('Settled credit operation is incomplete');
      return {
        creditsCharged: operation.creditsRequested,
        creditsRemaining: balance.creditsFree + balance.creditsPaid,
      };
    }
    const book = await loadCreditPriceBook(tx, operation.bookId);
    const needed = await calculateCredits(usage, modelId, book);
    if (operation.productAllocationId) {
      const result = await settleProductCreditAllocation(tx,reservation.userId,operation.productAllocationId,operation.creditsReserved,needed,new Date(),refreshedProductSnapshot);
      await tx.update(creditOperations).set({ status:'settled', creditsRequested:needed, creditsCharged:result.creditsCharged,
        servedModelId:modelId??null, pricingRule:(usage.totalTokens || usage.promptTokens+usage.completionTokens)===0 ? 'minimum' : modelId && book.models[modelId]!=null ? 'catalogue_price' : 'base_rate', promptTokens:usage.promptTokens, completionTokens:usage.completionTokens,
        totalTokens:usage.totalTokens,systemPromptTokens:usage.systemPromptTokens??0,reasoningTokens:usage.reasoningTokens??0,settledAt:new Date() })
        .where(eq(creditOperations.id,operation.id));
      return result;
    }
    const { userCredits } = await import('../db/schema/billing.js');
    const [before] = await tx
      .select()
      .from(userCredits)
      .where(eq(userCredits.id, reservation.userId))
      .for('update');
    if (before === undefined) throw new Error('User credits not found');
    const result = await _adjustReservation(reservation, needed, 'chat', tx);
    const rule =
      (usage.totalTokens || usage.promptTokens + usage.completionTokens) === 0
        ? 'minimum'
        : modelId !== undefined && book.models[modelId] != null
          ? 'catalogue_price'
          : 'base_rate';
    await tx
      .update(creditOperations)
      .set({
        status: 'settled',
        creditsRequested: needed,
        creditsCharged:
          reservation.creditsReserved + before.creditsFree + before.creditsPaid - result.creditsRemaining,
        servedModelId: modelId ?? null,
        pricingRule: rule,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        systemPromptTokens: usage.systemPromptTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        settledAt: new Date(),
      })
      .where(eq(creditOperations.id, operation.id));
    return result;
  });
}

async function refundTrackedReservation(reservation: CreditReservation): Promise<void> {
  await getDb().transaction(async (tx) => {
    const operation = await lockCreditOperation(tx, reservation);
    if (operation.status !== 'admitted') return;
    if(operation.productAllocationId) {
      await settleProductCreditAllocation(tx,reservation.userId,operation.productAllocationId,operation.creditsReserved,0);
      await tx.update(creditOperations).set({status:'refunded',creditsRequested:0,creditsCharged:0,settledAt:new Date()}).where(eq(creditOperations.id,operation.id));
      return;
    }
    const balance = await addCreditsToBalance(
      tx,
      reservation.userId,
      reservation.creditsReserved,
      refundBucket(reservation),
    );
    if (balance === null) throw new Error('User credits not found');
    await tx
      .update(creditOperations)
      .set({ status: 'refunded', creditsRequested: 0, creditsCharged: 0, settledAt: new Date() })
      .where(eq(creditOperations.id, operation.id));
  });
}

async function loadCreditPriceBook(tx: Executor, id: string): Promise<CreditPriceBook> {
  const [book] = await tx.select().from(creditPriceBooks).where(eq(creditPriceBooks.id, id));
  if (
    book === undefined ||
    book.formulaVersion !== CREDIT_FORMULA_VERSION ||
    book.fallbackRule !== 'unpriced-or-unknown-model-base-rate' ||
    (book.source !== 'oxy_catalogue_cache' && book.source !== 'catalogue_unavailable_base_rate')
  )
    throw new Error('Unsupported persisted credit price terms');
  const entries = await tx.select().from(creditPriceBookModels).where(eq(creditPriceBookModels.bookId, id));
  const models: Record<string, import('./models/catalogue.js').ModelPricing | null> = Object.create(null);
  for (const entry of entries)
    models[entry.modelId] =
      entry.inputPerMTok === null || entry.outputPerMTok === null
        ? null
        : Object.freeze({
            inputPerMTok: entry.inputPerMTok,
            outputPerMTok: entry.outputPerMTok,
            ...(entry.priceVersionId === null ? {} : { priceVersionId: entry.priceVersionId }),
          });
  return Object.freeze({
    id,
    capturedAt: book.capturedAt.toISOString(),
    source: book.source,
    formulaVersion: CREDIT_FORMULA_VERSION,
    fallbackRule: book.fallbackRule,
    roundingScale: book.roundingScale,
    config: Object.freeze({
      USD_PER_CREDIT: Number(book.usdPerCredit),
      TOKENS_PER_CREDIT: book.tokensPerCredit,
      MIN_CREDITS_PER_REQUEST: book.minimumCredits,
      INITIAL_RESERVATION: book.initialReservation,
    }),
    models: Object.freeze(models),
  });
}

/** Recovery of a server-created operation, scoped to the authenticated account. */
export async function restoreCreditReservation(
  userId: string,
  operationId: string,
): Promise<CreditReservation> {
  return getDb().transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(creditOperations)
      .where(and(eq(creditOperations.id, operationId), eq(creditOperations.userId, userId)));
    if (operation === undefined) throw new Error('Credit operation not found');
    return {
      operationId,
      userId,
      creditsReserved: operation.creditsReserved,
      initialFreeCredits: operation.initialFreeCredits,
      initialPaidCredits: operation.initialPaidCredits,
      grantKind: operation.grantKind,
      ...(operation.productAllocationId ? {productAllocationId:operation.productAllocationId} : {}),
      priceBook: await loadCreditPriceBook(tx, operation.bookId),
    };
  });
}

/** Locate recovery by the Alia response id minted by the server, never a client replay key. */
export async function restoreCreditReservationForRequest(
  userId: string,
  aliaRequestId: string,
): Promise<CreditReservation> {
  const [operation] = await getDb()
    .select({ id: creditOperations.id })
    .from(creditOperations)
    .where(and(eq(creditOperations.userId, userId), eq(creditOperations.aliaRequestId, aliaRequestId)));
  if (operation === undefined) throw new Error('Credit operation not found');
  return restoreCreditReservation(userId, operation.id);
}
