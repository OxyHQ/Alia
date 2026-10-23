/** Hosted inference authenticates Alia's workload through the shared Oxy SDK. */
import type { OxyInferenceCredential } from '@oxy.so/core/inference';
import { OxyServer, canAttestWorkloadIdentity } from '@oxy.so/core/server';

export const OXY_API_URL_ENV = 'OXY_API_URL';
export const OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV: readonly string[] = [OXY_API_URL_ENV];

/** Presence only; Oxy validates the workload and its environment when minting. */
export function unsetOxyInferenceCredentialVariables(env: NodeJS.ProcessEnv): readonly string[] {
  return [
    ...((env[OXY_API_URL_ENV] ?? '').trim() ? [] : [OXY_API_URL_ENV]),
    ...(canAttestWorkloadIdentity(env) ? [] : ['Oxy workload identity']),
  ];
}

export function createOxyInferenceCredential(
  env: NodeJS.ProcessEnv = process.env,
): OxyInferenceCredential {
  const missing = unsetOxyInferenceCredentialVariables(env);
  if (missing.length) throw new Error(`Oxy inference requires ${[...missing].sort().join(', ')}`);
  const oxy = new OxyServer({ baseURL: env[OXY_API_URL_ENV]!.trim() });
  return () => oxy.serviceToken();
}
