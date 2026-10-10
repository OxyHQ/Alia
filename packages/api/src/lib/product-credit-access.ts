import { oxyAccountIdSchema } from '@oxy.so/contracts';
/** Unconfigured by default. Uses only the current validated user request. */
import { oxyClient } from '../middleware/auth';
import {
  configuredProductCreditAdapter,
  type ProductCreditSnapshot,
} from './product-credit-allocations';
export async function readConfiguredProductCreditSnapshot(
  userId: string,
  accessToken?: string,
): Promise<ProductCreditSnapshot | undefined> {
  const adapter = configuredProductCreditAdapter();
  if (!adapter) return undefined;
  if (!accessToken) throw new Error('Product allowance needs a current user session');
  const snapshot = await oxyClient.productGrantSnapshotForUser(
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
 * Without current central authority legacy free/purchased funding remains available.
 * Access tokens remain request-local and are never persisted with queued work. */
export async function reserveUserProductCredits(
  userId: string,
  amount: number,
  accessToken?: string,
) {
  const { reserveCredits } = await import('./credits-manager');
  const { createCreditPriceBook } = await import('./credit-price-snapshot');
  const productCreditSnapshot = await readConfiguredProductCreditSnapshot(
    userId,
    accessToken,
  ).catch(() => undefined);
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
  const snapshot = await oxyClient.productGrantSnapshotForService({
    schemaVersion: 1,
    subjectAccountId: oxyAccountIdSchema.parse(userId),
    productId: adapter.productId,
  });
  return { adapter, snapshot };
}
export async function reserveBackgroundProductCredits(userId: string, amount?: number) {
  const { reserveCredits } = await import('./credits-manager');
  if (!configuredProductCreditAdapter())
    return amount === undefined ? reserveCredits(userId) : reserveCredits(userId, amount);
  const snapshot = await readConfiguredProductCreditSnapshotForService(userId).catch(
    () => undefined,
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
