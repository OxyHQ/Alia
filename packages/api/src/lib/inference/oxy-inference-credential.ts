/** Hosted inference authenticates Alia's workload through the shared Oxy SDK. */
import type { OxyInferenceCredential } from '@oxy.so/core/inference';
import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

export const OXY_API_URL_ENV = 'OXY_API_URL';
export const OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV: readonly string[] = [OXY_API_URL_ENV];

/** Presence only; Oxy validates the workload and its environment when minting. */
export function unsetOxyInferenceCredentialVariables(env: NodeJS.ProcessEnv): readonly string[] {
  return [...((env[OXY_API_URL_ENV] ?? '').trim() ? [] : [OXY_API_URL_ENV])];
}

export function createOxyInferenceCredential(
  env: NodeJS.ProcessEnv = process.env,
): OxyInferenceCredential {
  const missing = unsetOxyInferenceCredentialVariables(env);
  if (missing.length) throw new Error(`Oxy inference requires ${[...missing].sort().join(', ')}`);
  const oxy = new OxyServer({
    baseURL: env[OXY_API_URL_ENV]!.trim(),
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  });
  return () => oxy.serviceToken();
}
