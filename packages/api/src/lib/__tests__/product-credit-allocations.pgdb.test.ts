import {oxyAccountIdSchema} from '@oxy.so/contracts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {connectPostgres,closePostgres,getDb} from '../../db/index';
import {productCreditAllocations} from '../../db/schema/product-credit-allocations';
import {userCredits} from '../../db/schema/billing';
import {getOrCreateUserCredits} from '../../db/billing/userCreditsRepository';
import {reserveCredits,finalizeCredits,refundReservation,restoreCreditReservation} from '../credits-manager';
import {createCreditPriceBook} from '../credit-price-snapshot';
import {reserveProductCreditAllocation, type ProductCreditSnapshot} from '../product-credit-allocations';
vi.mock('../models/catalogue',()=>({findCatalogueModel:async()=>null,listCatalogueModels:async()=>[]}));
beforeAll(()=>{if(!connectPostgres(process.env.DATABASE_URL))throw new Error('Test DB required')});
afterAll(closePostgres);
async function fixture(included=5) {
 const userId=oxyAccountIdSchema.parse(`synthetic-product-${randomUUID()}`);await getOrCreateUserCredits(getDb(),userId);
 await getDb().update(userCredits).set({creditsFree:0,creditsPaid:0}).where(eq(userCredits.id,userId));
 const now=new Date(),start=new Date(+now-1000).toISOString(),end=new Date(+now+60000).toISOString(),id=randomUUID();
 const adapter={productId:'synthetic-alia',quotaKey:'monthly_credits',unit:'alia_credit' as const,combination:'maximum' as const,planId:'pro' as const};
 const snapshot:ProductCreditSnapshot={adapter,snapshot:{schemaVersion:1,
  access:{schemaVersion:1,subjectAccountId:userId,productId:adapter.productId,evaluatedAt:now.toISOString(),capabilities:[],conflicts:[],
   quotas:[{key:adapter.quotaKey,unit:adapter.unit,combination:adapter.combination,included,grantIds:[id]}]},
  grants:[{schemaVersion:1,id,sourceSegmentId:randomUUID(),beneficiaryAccountId:userId,offerId:'synthetic-only',offerVersion:1,origin:'bundle',
    benefit:{kind:'quota',productId:adapter.productId,key:adapter.quotaKey,unit:adapter.unit,included,combination:adapter.combination},period:{start,end},revokedAt:null}]}};
 const admission={priceBook:createCreditPriceBook([],'catalogue_unavailable_base_rate'),requestedModel:'synthetic/model',aliaRequestId:randomUUID(),productCreditSnapshot:snapshot};
 return {userId,id,snapshot,admission};
}
it('funds actual credit operations once per immutable period and settlement/refund replay conserve quantity',async()=>{
 const f=await fixture();const held=await reserveCredits(f.userId,2,f.admission);expect(held?.grantKind).toBe('product_allowance');
 if(!held?.operationId)throw new Error('Expected admission');
 const restored=await restoreCreditReservation(f.userId,held.operationId);restored.refreshProductCreditSnapshot=async()=>f.snapshot;expect(restored.productAllocationId).toBe(f.id);
 const usage={promptTokens:1000,completionTokens:1000,totalTokens:2000};
 expect(await finalizeCredits(restored,usage)).toEqual({creditsCharged:2,creditsRemaining:3});
 expect(await finalizeCredits(restored,usage)).toEqual({creditsCharged:2,creditsRemaining:3});
 await expect(finalizeCredits(restored,{...usage,totalTokens:3000})).rejects.toThrow('replay');
 const second=await reserveCredits(f.userId,2,{...f.admission,aliaRequestId:randomUUID()});if(!second)throw new Error('Expected');
 await refundReservation(second);await refundReservation(second);
 const [allocation]=await getDb().select().from(productCreditAllocations).where(eq(productCreditAllocations.id,f.id));
 expect(allocation).toMatchObject({included:5,consumed:2,reserved:0});
 const [balance]=await getDb().select().from(userCredits).where(eq(userCredits.id,f.userId));expect(balance).toMatchObject({creditsFree:0,creditsPaid:0});
});
it('serializes concurrent reservations, refuses account mismatch and never refills replayed grants',async()=>{
 const f=await fixture(3);const results=await Promise.all([reserveCredits(f.userId,2,f.admission),reserveCredits(f.userId,2,{...f.admission,aliaRequestId:randomUUID()})]);
 expect(results.filter(Boolean)).toHaveLength(1);
 await expect(getDb().transaction(tx=>reserveProductCreditAllocation(tx,'another-account',f.snapshot,1))).rejects.toThrow('authority');
 expect(await reserveCredits(f.userId,2,{...f.admission,aliaRequestId:randomUUID()})).toBeNull();
});
it('stops new reservations on cancellation/expiry and gives renewal a distinct period',async()=>{
 const f=await fixture();const held=await reserveCredits(f.userId,1,f.admission);if(!held)throw new Error('Expected');
 const canceled=structuredClone(f.snapshot);canceled.snapshot.grants=[];canceled.snapshot.access.quotas=[];
 expect(await reserveCredits(f.userId,1,{...f.admission,aliaRequestId:randomUUID(),productCreditSnapshot:canceled})).toBeNull();
 await refundReservation(held);
 const renewal=structuredClone(f.snapshot);renewal.snapshot.grants[0].id=randomUUID();renewal.snapshot.grants[0].sourceSegmentId=randomUUID();
 renewal.snapshot.access.quotas[0].grantIds=[renewal.snapshot.grants[0].id];
 expect(await reserveCredits(f.userId,5,{...f.admission,aliaRequestId:randomUUID(),productCreditSnapshot:renewal})).not.toBeNull();
 const expired=structuredClone(renewal);expired.snapshot.access.evaluatedAt=new Date(Date.now()+120000).toISOString();
 await expect(getDb().transaction(tx=>reserveProductCreditAllocation(tx,f.userId,expired,1))).rejects.toThrow();
});
it('keeps individual paid/free sources unchanged and needs no adapter for legacy credits',async()=>{
 const f=await fixture();await getDb().update(userCredits).set({creditsFree:2,creditsPaid:7}).where(eq(userCredits.id,f.userId));
 const held=await reserveCredits(f.userId,1,f.admission);expect(held?.productAllocationId).toBeUndefined();
 expect(await getDb().select().from(productCreditAllocations).where(eq(productCreditAllocations.userId,f.userId))).toHaveLength(0);
 if(held)await refundReservation(held);
 const [balance]=await getDb().select().from(userCredits).where(eq(userCredits.id,f.userId));expect(balance).toMatchObject({creditsFree:2,creditsPaid:7});
});

it('requires fresh central authority for charges above the admitted amount',async()=>{
 const f=await fixture();const held=await reserveCredits(f.userId,1,f.admission);if(!held)throw new Error('Expected');
 const usage={promptTokens:2000,completionTokens:1000,totalTokens:3000};
 expect((await finalizeCredits(held,usage)).creditsCharged).toBe(1);
 const next=await reserveCredits(f.userId,1,{...f.admission,aliaRequestId:randomUUID()});if(!next)throw new Error('Expected');
 next.refreshProductCreditSnapshot=async()=>{const fresh=structuredClone(f.snapshot);fresh.snapshot.access.evaluatedAt=new Date().toISOString();return fresh};
 expect((await finalizeCredits(next,usage)).creditsCharged).toBe(3);
});

for (const change of ['cancellation','overlap','changed terms'] as const) {
 it(`caps additional settlement and reports no eligible remainder after ${change}, including replay`,async()=>{
  const f=await fixture(10000);const held=await reserveCredits(f.userId,1,f.admission);if(!held)throw new Error('Expected');
  const fresh=structuredClone(f.snapshot);
  if(change==='cancellation'){fresh.snapshot.grants=[];fresh.snapshot.access.quotas=[];}
  if(change==='overlap'){
   const additional=structuredClone(fresh.snapshot.grants[0]);additional.id=randomUUID();additional.sourceSegmentId=randomUUID();
   fresh.snapshot.grants.push(additional);fresh.snapshot.access.quotas[0].grantIds.push(additional.id);
   await expect(getDb().transaction(tx=>reserveProductCreditAllocation(tx,f.userId,fresh,1))).rejects.toThrow('Overlapping');
  }
  if(change==='changed terms'){fresh.snapshot.grants[0].offerVersion=2;}
  held.refreshProductCreditSnapshot=async()=>fresh;
  const usage={promptTokens:2000,completionTokens:1000,totalTokens:3000};
  expect(await finalizeCredits(held,usage)).toEqual({creditsCharged:1,creditsRemaining:0});
  expect(await finalizeCredits(held,usage)).toEqual({creditsCharged:1,creditsRemaining:0});
  const [allocation]=await getDb().select().from(productCreditAllocations).where(eq(productCreditAllocations.id,f.id));
  expect(allocation).toMatchObject({included:10000,consumed:1,reserved:0,offerVersion:1});
 });
}

it('does not admit a reservation queued across its grant expiry',async()=>{
 const f=await fixture();const expiredAt=Date.now()+250;
 f.snapshot.snapshot.grants[0].period.end=new Date(expiredAt).toISOString();
 let release!:()=>void;let locked!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve});
 const acquired=new Promise<void>(resolve=>{locked=resolve});
 const lock=getDb().transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`alia:product-credit:${f.userId}`},0))`);
  locked();await barrier;
 });
 await acquired;
 const queued=getDb().transaction(tx=>reserveProductCreditAllocation(tx,f.userId,f.snapshot,1));
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiredAt-Date.now()+50)));
 release();await lock;
 expect(await queued).toBeNull();
 const [allocation]=await getDb().select().from(productCreditAllocations).where(eq(productCreditAllocations.id,f.id));
 expect(allocation.reserved).toBe(0);
});
