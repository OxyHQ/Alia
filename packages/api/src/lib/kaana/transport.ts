/** Own voice and dictation share Kaana's canonical Oxy workload transport. */
import { kaanaForOxyService } from '@kaana.ai/sdk/server';
import { oxy } from '../oxy.js';
import type { KaanaClient } from './port.js';

let testClient: KaanaClient | null | undefined;

/** One immutable inference attribution per call; it grants no user-data authority. */
export function getKaanaClient(accountId: string): KaanaClient | null {
  if (testClient !== undefined) return testClient;
  return kaanaForOxyService(oxy, { attribution: { accountId } });
}

/** Test seam: install the Kaana test client, or restore the production factory. */
export function setKaanaClientForTests(client: KaanaClient | null | undefined): void {
  testClient = client;
}
