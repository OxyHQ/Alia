import {oxyAccountIdSchema} from '@oxy.so/contracts';
/** Unconfigured by default. Uses only the current validated user request. */
import { oxyClient } from '../middleware/auth';
import { configuredProductCreditAdapter, type ProductCreditSnapshot } from './product-credit-allocations';
export async function readConfiguredProductCreditSnapshot(userId: string, accessToken?: string): Promise<ProductCreditSnapshot | undefined> {
  const adapter = configuredProductCreditAdapter();
  if (!adapter) return undefined;
  if (!accessToken) throw new Error('Product allowance needs a current user session');
  const snapshot = await oxyClient.productGrantSnapshotForUser({schemaVersion:1,subjectAccountId:oxyAccountIdSchema.parse(userId),productId:adapter.productId},accessToken);
  return {adapter,snapshot};
}
