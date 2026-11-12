import { oxyAccountIdSchema } from '@oxy.so/contracts';
import { OxyApiError } from '@oxy.so/core';
/** Unconfigured by default. Uses only the current validated user request. */
import { oxy } from './oxy.js';
import {
  configuredProductCreditAdapter,
  type ProductCreditSnapshot,
} from './product-credit-allocations';

/**
 * Oxy could not say whether this account holds a product grant: an outage, a
 * timeout, a 5xx or an unreadable answer. It is NOT "no grant" — that is Oxy
 * answering 403/404, after which legacy free and purchased funding applies —
 * so it is never folded into the legacy path. Callers answer it 503.
 */
export class ProductCreditAuthorityUnavailableError extends Error {
  readonly code = 'product_credit_authority_unavailable';
  constructor(cause: unknown) {
    super('Product credit authority is temporarily unavailable', { cause });
    this.name = 'ProductCreditAuthorityUnavailableError';
  }
}

/**
 * A grant read whose definitive refusal (Oxy answered 403/404: no grant, no
 * offline consent for this exact account) is `undefined`, and whose every
 * other failure is {@link ProductCreditAuthorityUnavailableError}.
 */
export async function productCreditSnapshotOrNone(
  read: () => Promise<ProductCreditSnapshot | undefined>,
): Promise<ProductCreditSnapshot | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof OxyApiError && (error.status === 403 || error.status === 404)) {
      return undefined;
    }
    throw new ProductCreditAuthorityUnavailableError(error);
  }
}

export async function readConfiguredProductCreditSnapshot(
  userId: string,
  accessToken?: string,
): Promise<ProductCreditSnapshot | undefined> {
  const adapter = configuredProductCreditAdapter();
  if (!adapter) return undefined;
  if (!accessToken) throw new Error('Product allowance needs a current user session');
  const snapshot = await oxy.productGrantSnapshotForUser(
    {
      schemaVersion: 1,
      subjectAccountId: oxyAccountIdSchema.parse(userId),
      productId: adapter.productId,
    },
    accessToken,
  );
  return { adapter, snapshot };
}

/** User-present fixed jobs share the same immutable operation and period ledger as chat.
 * An account Oxy says holds no grant keeps legacy free/purchased funding; an Oxy
 * that cannot answer refuses the job (ProductCreditAuthorityUnavailableError).
 * Access tokens remain request-local and are never persisted with queued work. */
export async function reserveUserProductCredits(
  userId: string,
  amount: number,
  accessToken?: string,
) {
  const { reserveCredits } = await import('./credits-manager');
  const { createCreditPriceBook } = await import('./credit-price-snapshot');
  // No session of this account on the request: there is no user-present grant
  // to read, which is not an outage — legacy funding applies.
  const productCreditSnapshot = accessToken
    ? await productCreditSnapshotOrNone(() =>
        readConfiguredProductCreditSnapshot(userId, accessToken),
      )
    : undefined;
  const reservation = await reserveCredits(userId, amount, {
    priceBook: createCreditPriceBook([], 'catalogue_unavailable_base_rate'),
    requestedModel: 'fixed-product-work',
    productCreditSnapshot,
  });
  if (reservation?.productAllocationId) {
    reservation.refreshProductCreditSnapshot = () =>
      readConfiguredProductCreditSnapshot(userId, accessToken);
  }
  return reservation;
}

/** Requires the existing app credential's offline consent for this exact account.
 * No user token is impersonated, minted, or retained by a background job. */
export async function readConfiguredProductCreditSnapshotForService(
  userId: string,
): Promise<ProductCreditSnapshot | undefined> {
  const adapter = configuredProductCreditAdapter();
  if (!adapter) return undefined;
  const snapshot = await oxy.productGrantSnapshotForService({
    schemaVersion: 1,
    subjectAccountId: oxyAccountIdSchema.parse(userId),
    productId: adapter.productId,
  });
  return { adapter, snapshot };
}

/** Background work: an account without offline consent (403/404) keeps legacy
 * funding; an Oxy outage is ProductCreditAuthorityUnavailableError, never that. */
export async function reserveBackgroundProductCredits(userId: string, amount?: number) {
  const { reserveCredits } = await import('./credits-manager');
  if (!configuredProductCreditAdapter())
    return amount === undefined ? reserveCredits(userId) : reserveCredits(userId, amount);
  const snapshot = await productCreditSnapshotOrNone(() =>
    readConfiguredProductCreditSnapshotForService(userId),
  );
  const { captureCreditPriceBook } = await import('./credit-price-snapshot');
  const reservation = await reserveCredits(userId, amount, {
    priceBook: await captureCreditPriceBook(),
    requestedModel: 'background-product-work',
    productCreditSnapshot: snapshot,
  });
  if (reservation?.productAllocationId)
    reservation.refreshProductCreditSnapshot = () =>
      readConfiguredProductCreditSnapshotForService(userId);
  return reservation;
}

/** Resolve remote policy before taking database locks, then reserve with the job atomically. */
export async function prepareBackgroundCreditReservation(userId: string, amount: number) {
  const { reserveCredits } = await import('./credits-manager');
  const { captureCreditPriceBook } = await import('./credit-price-snapshot');
  const snapshot = configuredProductCreditAdapter()
    ? await productCreditSnapshotOrNone(() => readConfiguredProductCreditSnapshotForService(userId))
    : undefined;
  const priceBook = await captureCreditPriceBook();
  return (executor: import('../db/index').Executor) =>
    reserveCredits(userId, amount, {
      priceBook,
      requestedModel: 'background-product-work',
      productCreditSnapshot: snapshot,
      executor,
    });
}
