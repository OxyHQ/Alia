/** Oxy product periods are an independent funding source. No default product/quota. */
import { and, eq, sql } from 'drizzle-orm';
import { subjectProductGrantSnapshotSchema } from '@oxy.so/contracts';
import { productCreditAllocations } from '../db/schema/product-credit-allocations';
import type { Executor } from '../db/index';

import { productCreditAdapterSchema, productCreditPlanId, type ProductCreditSnapshot } from './product-credit-contract';
export {configuredProductCreditAdapter, type ProductCreditSnapshot} from './product-credit-contract';
function count(n: number) { if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new Error('Unsupported product credit quantity'); }
export async function reserveProductCreditAllocation(tx: Executor, userId: string, input: ProductCreditSnapshot,
  amount: number, now = new Date()) {
  count(amount); if (amount === 0) throw new Error('Reservation must be positive');
  const adapter = productCreditAdapterSchema.parse(input.adapter);
  const snapshot = subjectProductGrantSnapshotSchema.parse(input.snapshot);
  const access = snapshot.access;
  if (access.subjectAccountId !== userId || access.productId !== adapter.productId
    || now.getTime() - Date.parse(access.evaluatedAt) > 10000 || Date.parse(access.evaluatedAt) > now.getTime() + 1000
    || access.conflicts.some(value => value.key === adapter.quotaKey)) throw new Error('Product credit authority unavailable');
  const quota = access.quotas.find(value => value.key === adapter.quotaKey);
  if (quota && (quota.unit !== adapter.unit || quota.combination !== adapter.combination)) throw new Error('Product credit units differ');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`alia:product-credit:${userId}`},0))`);
  // Lock contention must not preserve a pre-wait freshness or period decision.
  now = new Date(Math.max(+now, Date.now()));
  if (+now - Date.parse(access.evaluatedAt) > 10000 || Date.parse(access.evaluatedAt) > +now + 1000)
    throw new Error('Product credit authority unavailable');
  const grants = snapshot.grants.filter(g => g.origin === 'bundle' && g.benefit.kind === 'quota'
    && g.benefit.key === adapter.quotaKey && g.benefit.unit === adapter.unit);
  if(grants.length>1) throw new Error('Overlapping product allocation policy is unconfigured');
  // Missing/revoked/canceled sources cannot admit another turn. Retain history and reservations.
  await tx.update(productCreditAllocations).set({active:false}).where(and(eq(productCreditAllocations.userId,userId),eq(productCreditAllocations.productId,adapter.productId)));
  for(const grant of grants) {
    if(grant.benefit.kind !== 'quota') continue;
    count(grant.benefit.included);
    const terms = {id:grant.id,userId,productId:adapter.productId,segmentId:grant.sourceSegmentId,
      offerId:grant.offerId,offerVersion:grant.offerVersion,quotaKey:adapter.quotaKey,unit:adapter.unit,
      periodStart:new Date(grant.period.start),periodEnd:new Date(grant.period.end),included:grant.benefit.included};
    await tx.insert(productCreditAllocations).values(terms).onConflictDoNothing();
    const [held] = await tx.select().from(productCreditAllocations).where(eq(productCreditAllocations.id,grant.id)).for('update');
    if(!held || Object.entries(terms).some(([key,value]) => {
      const prior = held[key as keyof typeof held];
      return value instanceof Date ? !(prior instanceof Date) || +prior !== +value : prior !== value;
    })) throw new Error('Immutable product allocation attribution differs');
    await tx.update(productCreditAllocations).set({active:true}).where(eq(productCreditAllocations.id,grant.id));
  }
  // Maximum means one source, never the sum of overlapping included quantities.
  const ordered = [...grants].sort((a,b) => (b.benefit.kind === 'quota' ? b.benefit.included : 0)
    - (a.benefit.kind === 'quota' ? a.benefit.included : 0) || a.id.localeCompare(b.id));
  const selected = ordered[0];
  if(!selected) return null;
  const [allocation] = await tx.update(productCreditAllocations).set({reserved:sql`${productCreditAllocations.reserved}+${amount}`})
    .where(and(eq(productCreditAllocations.id,selected.id),eq(productCreditAllocations.userId,userId),
      sql`${productCreditAllocations.active} AND ${productCreditAllocations.periodStart} <= ${now.toISOString()} AND ${productCreditAllocations.periodEnd} > ${now.toISOString()}
      AND ${productCreditAllocations.included}-${productCreditAllocations.consumed}-${productCreditAllocations.reserved} >= ${amount}`)).returning();
  return allocation ?? null;
}
export function isProductAllocationAuthorized(held: typeof productCreditAllocations.$inferSelect, userId: string, refreshed: ProductCreditSnapshot | undefined, now = new Date()) {
  const freshGrant = refreshed && productCreditPlanId(refreshed,userId,now) ? refreshed.snapshot.grants.find(g=>g.id===held.id) : undefined;
  return freshGrant?.benefit.kind==='quota' && freshGrant.benefit.included===held.included
    && freshGrant.sourceSegmentId===held.segmentId && freshGrant.offerId===held.offerId && freshGrant.offerVersion===held.offerVersion
    && freshGrant.benefit.key===held.quotaKey && freshGrant.benefit.productId===held.productId && freshGrant.benefit.unit===held.unit
    && Date.parse(freshGrant.period.start)===+held.periodStart && Date.parse(freshGrant.period.end)===+held.periodEnd;
}
export async function settleProductCreditAllocation(tx: Executor, userId: string, allocationId: string, reserved: number,
  requested: number, now = new Date(), refreshed?: ProductCreditSnapshot) {
  count(reserved); count(requested);
  const [held] = await tx.select().from(productCreditAllocations).where(and(eq(productCreditAllocations.id,allocationId),eq(productCreditAllocations.userId,userId))).for('update');
  if(!held || held.reserved < reserved) throw new Error('Product reservation attribution differs');
  // Existing admitted execution can settle after expiry; additional admission cannot.
  const stillAuthorized = isProductAllocationAuthorized(held,userId,refreshed,now);
  const available = stillAuthorized && held.active && +held.periodEnd > +now && +held.periodStart <= +now
    ? held.included-held.consumed-held.reserved : 0;
  const charged = Math.min(requested,reserved+available);
  const [updated] = await tx.update(productCreditAllocations).set({reserved:held.reserved-reserved,consumed:held.consumed+charged})
    .where(eq(productCreditAllocations.id,allocationId)).returning();
  return {creditsCharged:charged, creditsRemaining:stillAuthorized && updated.active && +updated.periodEnd > +now
    ? updated.included-updated.consumed-updated.reserved : 0};
}
