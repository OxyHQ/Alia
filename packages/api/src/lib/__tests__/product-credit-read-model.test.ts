import {it,expect,vi} from 'vitest';
vi.mock('../product-credit-access',()=>({readConfiguredProductCreditSnapshot:vi.fn()}));
import {productAllowanceReadModel,effectiveCreditPlan} from '../product-credit-read-model';
import type {ProductCreditSnapshot} from '../product-credit-contract';
import {oxyAccountIdSchema} from '@oxy.so/contracts';
const now=new Date(),account=oxyAccountIdSchema.parse('synthetic-read-model');
function fixture():ProductCreditSnapshot {
 const adapter={productId:'synthetic-alia',quotaKey:'credits',unit:'alia_credit' as const,combination:'maximum' as const,planId:'pro' as const};
 return {adapter,snapshot:{schemaVersion:1,access:{schemaVersion:1,subjectAccountId:account,productId:adapter.productId,evaluatedAt:now.toISOString(),capabilities:[],conflicts:[],quotas:[{key:'credits',unit:'alia_credit',included:10000,combination:'maximum',grantIds:['grant']}]},grants:[{schemaVersion:1,id:'grant',sourceSegmentId:'segment',beneficiaryAccountId:account,offerId:'synthetic',offerVersion:1,origin:'bundle',benefit:{kind:'quota',productId:adapter.productId,key:'credits',unit:'alia_credit',included:10000,combination:'maximum'},period:{start:new Date(+now-1000).toISOString(),end:new Date(+now+60000).toISOString()},revokedAt:null}]}};
}
it('shows allowance without changing individual/free plans',()=>{
 expect(productAllowanceReadModel(account,fixture(),undefined,now)).toMatchObject({included:10000,remaining:10000});
 expect(effectiveCreditPlan('ultra','pro')).toBe('ultra');expect(effectiveCreditPlan('free','pro')).toBe('pro');expect(effectiveCreditPlan('custom','pro')).toBe('custom');
});
it('refuses cancellation, expiry, stale authority, overlap and account switch',()=>{
 const canceled=fixture();canceled.snapshot.grants=[];canceled.snapshot.access.quotas=[];
 expect(productAllowanceReadModel(account,canceled,undefined,now)).toBeNull();
 expect(productAllowanceReadModel('other',fixture(),undefined,now)).toBeNull();
 expect(productAllowanceReadModel(account,fixture(),undefined,new Date(+now+60000))).toBeNull();
 expect(productAllowanceReadModel(account,fixture(),undefined,new Date(+now+10001))).toBeNull();
 const overlap=fixture();overlap.snapshot.grants.push({...overlap.snapshot.grants[0],id:'second'});overlap.snapshot.access.quotas[0].grantIds.push('second');
 expect(productAllowanceReadModel(account,overlap,undefined,now)).toBeNull();
});
it('subtracts consumption and holds only for immutable eligible source',()=>{
 const held={id:'grant',userId:account,productId:'synthetic-alia',segmentId:'segment',offerId:'synthetic',offerVersion:1,quotaKey:'credits',unit:'alia_credit',periodStart:new Date(+now-1000),periodEnd:new Date(+now+60000),included:10000,consumed:100,reserved:20,active:true};
 expect(productAllowanceReadModel(account,fixture(),held,now)).toMatchObject({remaining:9880,consumed:100,reserved:20});
 expect(productAllowanceReadModel(account,fixture(),{...held,active:false},now)).toBeNull();
 expect(productAllowanceReadModel(account,fixture(),{...held,offerVersion:2},now)).toBeNull();
});
