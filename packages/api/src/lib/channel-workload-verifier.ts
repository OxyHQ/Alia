import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

// Reader-only identity: existing producers keep their current protocol until both
// processes have these readers. Never reinterpret a configured external key.
let verifier: OxyServer | undefined;
export function channelWorkloadVerifier(): OxyServer {
  return (verifier ??= new OxyServer({
    baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  }));
}
