/**
 * What Alia's voice needs of `@kaana.ai/sdk`, as a narrow port.
 *
 * Every shape is the SDK's and `@kaana.ai/contracts`' own: nothing is restated
 * here, so a field Kaana adds or removes is a dependency bump that typechecks
 * or fails, never a silent mismatch. The real `Kaana` client — the one
 * `kaana/transport.ts` constructs, and the one `@kaana.ai/sdk/testing` wires to
 * its in-memory server — is the only implementation. The members are function
 * PROPERTIES, not methods, so a client that does not match the SDK's
 * signatures fails to typecheck instead of slipping through method
 * bivariance.
 *
 * Nothing here names a provider, a deployment or a key: Kaana's API is one
 * canonical contract (Kaana ADR 0003) and Alia never learns which operator
 * served a call.
 */

import type { Kaana } from '@kaana.ai/sdk';

export interface KaanaClient {
  readonly models: { readonly list: Kaana['models']['list'] };
  readonly realtime: { readonly connect: Kaana['realtime']['connect'] };
  readonly audio: {
    readonly transcriptions: { readonly create: Kaana['audio']['transcriptions']['create'] };
  };
}
