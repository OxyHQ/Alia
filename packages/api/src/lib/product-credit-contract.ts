import { z } from 'zod';
import {
  subjectProductGrantSnapshotSchema,
  type SubjectProductGrantSnapshot,
} from '@oxy.so/contracts';
export const productCreditAdapterSchema = z
  .object({
    productId: z.string().min(1).max(160),
    quotaKey: z.string().min(1).max(160),
    unit: z.literal('alia_credit'),
    combination: z.enum(['maximum', 'exclusive']),
    planId: z.enum(['go', 'pro', 'max', 'ultra']),
    individualOffers: z
      .array(
        z
          .object({
            offerId: z.string().min(1).max(160),
            offerVersion: z.number().int().positive().safe(),
            planId: z.enum(['go', 'pro', 'max', 'ultra']),
            billingPeriod: z.enum(['monthly', 'annual']).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set((value.individualOffers ?? []).map((o) => `${o.offerId}@${o.offerVersion}`)).size ===
      (value.individualOffers ?? []).length,
    'Individual offer mappings must be unique',
  );
export type ProductCreditAdapter = z.infer<typeof productCreditAdapterSchema>;
export function configuredProductCreditAdapter(): ProductCreditAdapter | null {
  const value = process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER;
  return value ? productCreditAdapterSchema.parse(JSON.parse(value)) : null;
}
export interface ProductCreditSnapshot {
  adapter: ProductCreditAdapter;
  snapshot: SubjectProductGrantSnapshot;
}
export function selectProductCreditGrant(
  input: ProductCreditSnapshot | undefined,
  userId: string,
  now = new Date(),
) {
  if (!input) return null;
  const adapter = productCreditAdapterSchema.parse(input.adapter);
  const snapshot = subjectProductGrantSnapshotSchema.parse(input.snapshot);
  const access = snapshot.access;
  if (
    access.subjectAccountId !== userId ||
    access.productId !== adapter.productId ||
    +now - Date.parse(access.evaluatedAt) > 10000 ||
    Date.parse(access.evaluatedAt) > +now + 1000 ||
    access.conflicts.some((value) => value.key === adapter.quotaKey)
  )
    return null;
  const quota = access.quotas.find((value) => value.key === adapter.quotaKey);
  if (!quota || quota.unit !== adapter.unit || quota.combination !== adapter.combination)
    return null;
  const grants = snapshot.grants.filter(
    (g) =>
      g.beneficiaryAccountId === userId &&
      (g.revokedAt === null || Date.parse(g.revokedAt) > +now) &&
      quota.grantIds.includes(g.id) &&
      g.benefit.productId === adapter.productId &&
      (g.origin === 'bundle' ||
        adapter.individualOffers?.some(
          (o) => o.offerId === g.offerId && o.offerVersion === g.offerVersion,
        )) &&
      g.benefit.kind === 'quota' &&
      g.benefit.key === adapter.quotaKey &&
      g.benefit.unit === adapter.unit &&
      g.benefit.included > 0 &&
      Date.parse(g.period.start) <= +now &&
      Date.parse(g.period.end) > +now,
  );
  if (
    !grants.length ||
    (adapter.combination === 'exclusive' && grants.length !== 1) ||
    new Set(grants.map((grant) => grant.origin)).size !== grants.length
  )
    return null;
  const grant = [...grants].sort(
    (a, b) =>
      (b.benefit.kind === 'quota' ? b.benefit.included : 0) -
        (a.benefit.kind === 'quota' ? a.benefit.included : 0) || a.id.localeCompare(b.id),
  )[0];
  const planId =
    grant.origin === 'bundle'
      ? adapter.planId
      : adapter.individualOffers?.find(
          (o) => o.offerId === grant.offerId && o.offerVersion === grant.offerVersion,
        )?.planId;
  return planId ? { grant, planId } : null;
}

export function productCreditPlanId(
  input: ProductCreditSnapshot | undefined,
  userId: string,
  now = new Date(),
): string | null {
  return selectProductCreditGrant(input, userId, now)?.planId ?? null;
}

/** Discovery exposes only reviewed offer references; Oxy supplies every price and checkout. */
export function configuredProductCheckout() {
  const adapter = configuredProductCreditAdapter();
  return {
    productId: adapter?.productId ?? null,
    plans: (adapter?.individualOffers ?? []).map((offer) => ({
      ...offer,
      billingPeriod: offer.billingPeriod ?? 'monthly',
    })),
  };
}
