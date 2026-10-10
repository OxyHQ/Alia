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
  })
  .strict();
export type ProductCreditAdapter = z.infer<typeof productCreditAdapterSchema>;
export function configuredProductCreditAdapter(): ProductCreditAdapter | null {
  const value = process.env.ALIA_OXY_PRODUCT_CREDIT_ADAPTER;
  return value ? productCreditAdapterSchema.parse(JSON.parse(value)) : null;
}
export interface ProductCreditSnapshot {
  adapter: ProductCreditAdapter;
  snapshot: SubjectProductGrantSnapshot;
}
export function productCreditPlanId(
  input: ProductCreditSnapshot | undefined,
  userId: string,
  now = new Date(),
): string | null {
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
      g.origin === 'bundle' &&
      g.benefit.kind === 'quota' &&
      g.benefit.key === adapter.quotaKey &&
      g.benefit.unit === adapter.unit &&
      g.benefit.included > 0 &&
      Date.parse(g.period.start) <= +now &&
      Date.parse(g.period.end) > +now,
  );
  return grants.length === 1 ? adapter.planId : null;
}
