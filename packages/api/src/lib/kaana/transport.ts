/** Own voice and dictation share Kaana's canonical Oxy workload transport. */
import { kaanaForOxyService } from '@kaana.ai/sdk/server';
import { oxyServiceClient } from '../oxy-service-client.js';
import type { KaanaClient } from './port.js';

let testClient: KaanaClient | null | undefined;

/** One immutable inference attribution per call; it grants no user-data authority. */
export function getKaanaClient(accountId: string): KaanaClient | null {
  if (testClient !== undefined) return testClient;
  const oxy = oxyServiceClient();
  return oxy ? kaanaForOxyService(oxy, { attribution: { accountId } }) : null;
}

/** Test seam: install the Kaana test client, or restore the production factory. */
export function setKaanaClientForTests(client: KaanaClient | null | undefined): void {
  testClient = client;
}
