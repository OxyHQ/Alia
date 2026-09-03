/**
 * Alia's one hosted-inference client.
 *
 * Alia authenticates to Oxy with its own application credential. Oxy resolves
 * the application, account, credential, routing policy and authorised Kaana
 * routes before it forwards anything to the data plane. This process therefore
 * owns no Kaana signing key, principal envelope or direct Kaana URL.
 */

import { OxyInferenceClient } from '@oxyhq/core';

import {
  createOxyInferenceCredential,
  OXY_API_URL_ENV,
  OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV,
} from './oxy-inference-credential.js';

/** The only Oxy origin a deployed Alia task may send inference credentials to. */
export const OXY_INFERENCE_ALLOWED_ORIGINS: readonly string[] = ['https://api.oxy.so'];

/** Every variable needed to build the SDK client. */
export const OXY_INFERENCE_REQUIRED_ENV: readonly string[] = [
  ...OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV,
];

export type OxyDeploymentEnvironment = 'development' | 'staging' | 'production';

export function resolveOxyDeploymentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): OxyDeploymentEnvironment {
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'staging') return 'staging';
  return 'development';
}

/** Variables absent from an otherwise required SDK configuration. */
export function unsetOxyInferenceVariables(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return OXY_INFERENCE_REQUIRED_ENV.filter(
    (variable) => (env[variable] ?? '').trim().length === 0,
  );
}

/** Why an Oxy base URL is unsafe, or `null` when it is approved. */
export function oxyInferenceEndpointRefusal(
  value: string,
  deployment: OxyDeploymentEnvironment,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${OXY_API_URL_ENV} is not an absolute URL`;
  }

  if (url.username !== '' || url.password !== '') {
    return `${OXY_API_URL_ENV} carries credentials in the URL`;
  }
  if (url.search !== '' || url.hash !== '') {
    return `${OXY_API_URL_ENV} carries a query string or fragment`;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return `${OXY_API_URL_ENV} must name the Oxy API origin, not a path`;
  }
  if (OXY_INFERENCE_ALLOWED_ORIGINS.includes(url.origin)) return null;

  const loopback =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]');
  if (deployment === 'development' && loopback) return null;

  return (
    `${OXY_API_URL_ENV} points at ${url.origin}, which is not an approved Oxy inference origin ` +
    `(${OXY_INFERENCE_ALLOWED_ORIGINS.join(', ')})`
  );
}

/** Build the published Oxy inference SDK client, or fail closed as `null`. */
export function buildOxyInferenceClient(
  env: NodeJS.ProcessEnv,
): OxyInferenceClient | null {
  if (unsetOxyInferenceVariables(env).length > 0) return null;

  const baseURL = (env[OXY_API_URL_ENV] ?? '').trim();
  const refusal = oxyInferenceEndpointRefusal(
    baseURL,
    resolveOxyDeploymentEnvironment(env),
  );
  if (refusal !== null) return null;

  return new OxyInferenceClient({
    baseURL,
    credential: createOxyInferenceCredential(env),
  });
}

/**
 * Build a request-scoped client from an already VERIFIED inbound Oxy service
 * token. Product-agent turns use this lane so Oxy charges the calling product
 * application's owner/cost centre, never Alia's process credential and never
 * an `agentId`. The caller decides whether the token is eligible only after
 * matching the agent's application binding and effective inference scope.
 */
export function buildOxyInferenceClientForServiceToken(
  serviceToken: string,
  env: NodeJS.ProcessEnv = process.env,
): OxyInferenceClient | null {
  const bearer = serviceToken.trim();
  if (bearer.length === 0) return null;

  const baseURL = (env[OXY_API_URL_ENV] ?? '').trim();
  const refusal = oxyInferenceEndpointRefusal(
    baseURL,
    resolveOxyDeploymentEnvironment(env),
  );
  if (refusal !== null) return null;

  return new OxyInferenceClient({ baseURL, credential: bearer });
}

let cached: OxyInferenceClient | null | undefined;

/** The one process-wide SDK client, preserving the service-token cache. */
export function getOxyInferenceClient(
  env: NodeJS.ProcessEnv = process.env,
): OxyInferenceClient | null {
  if (cached === undefined) cached = buildOxyInferenceClient(env);
  return cached;
}

/** Test seam for a process-global credential cache. */
export function resetOxyInferenceClient(): void {
  cached = undefined;
}
