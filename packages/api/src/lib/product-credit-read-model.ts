/** Current Oxy period allowance; independent of purchased and daily free credits. */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/index';
import { productCreditAllocations } from '../db/schema/product-credit-allocations';
import { isProductAllocationAuthorized } from './product-credit-allocations';
import {
  productCreditPlanId,
  selectProductCreditGrant,
  type ProductCreditSnapshot,
} from './product-credit-contract';
import { readConfiguredProductCreditSnapshot } from './product-credit-access';
import { USAGE_WINDOW_CREDITS } from './usage-window';

export function effectiveCreditPlan(
  legacy: string | null | undefined,
  bundle: string | null,
): string | null {
  if (!bundle) return legacy ?? null;
  return (USAGE_WINDOW_CREDITS.get(bundle) ?? 0) >
    (USAGE_WINDOW_CREDITS.get(legacy ?? 'free') ?? Infinity)
    ? bundle
    : (legacy ?? 'free');
}
export function productAllowanceReadModel(
  userId: string,
  input: ProductCreditSnapshot | undefined,
  held?: typeof productCreditAllocations.$inferSelect,
  now = new Date(),
) {
  const planId = productCreditPlanId(input, userId, now);
  if (!planId || !input) return null;
  const grant = selectProductCreditGrant(input, userId, now)?.grant;
  if (
    grant?.benefit.kind !== 'quota' ||
    (held &&
      (held.userId !== userId ||
        !held.active ||
        !isProductAllocationAuthorized(held, userId, input, now)))
  )
    return null;
  const consumed = held?.consumed ?? 0,
    reserved = held?.reserved ?? 0;
  return {
    source: grant.origin === 'bundle' ? ('oxy_one' as const) : ('oxy_product' as const),
    planId,
    offerId: grant.offerId,
    offerVersion: grant.offerVersion,
    periodStart: grant.period.start,
    periodEnd: grant.period.end,
    included: grant.benefit.included,
    consumed,
    reserved,
    remaining: Math.max(0, grant.benefit.included - consumed - reserved),
  };
}
export async function readCurrentProductAllowance(userId: string, accessToken?: string) {
  const input = await readConfiguredProductCreditSnapshot(userId, accessToken).catch(
    () => undefined,
  );
  if (!input || !productCreditPlanId(input, userId)) return null;
  const selected = selectProductCreditGrant(input, userId);
  if (!selected) return null;
  const [held] = await getDb()
    .select()
    .from(productCreditAllocations)
    .where(
      and(
        eq(productCreditAllocations.id, selected.grant.id),
        eq(productCreditAllocations.userId, userId),
      ),
    );
  return productAllowanceReadModel(userId, input, held);
}
