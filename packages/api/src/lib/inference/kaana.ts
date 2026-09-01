/**
 * The Kaana client this process actually uses, assembled from the environment.
 *
 * `kaana-client.ts` is the client and takes every collaborator as a parameter;
 * this is the one place that decides what those collaborators ARE here. Keeping
 * the two apart is what let the client be written and tested before a wire
 * existed — and it is why wiring the wire is this file rather than an edit
 * spread through the client.
 *
 * ## Why there is no service token
 *
 * `KaanaClientConfig` wants a `credential`, and Kaana never reads one. It
 * authenticates the Ed25519 signature over the body (`kaana-transport.ts`) and
 * takes attribution from the envelope, so a bearer token would be a credential
 * handed to a party with no use for it. The credential here therefore mints
 * nothing: it answers a constant that the transport drops on the floor, and
 * `createKaanaServiceCredential` — which exchanges an Oxy service token — is
 * deliberately NOT used. That exchange belongs to a different transport for a
 * different hop, and requiring its three variables to reach Kaana would be
 * requiring a credential to satisfy a type.
 *
 * ## What it refuses to do
 *
 * Return a client to a process that was never given one's parts. Boot refuses
 * that configuration before listening; `null` remains only as a defensive
 * construction result for isolated module use.
 */

import {
  createKaanaInferenceClient,
  type KaanaClientConfig,
  type KaanaInferenceClient,
} from './kaana-client.js';
import { KAANA_PRINCIPAL_ENV } from './kaana-boot-check.js';
import { resolveKaanaEndpoint } from './kaana-endpoint.js';
import {
  KAANA_EDGE_KEY_ID_ENV,
  KAANA_EDGE_PRIVATE_KEY_ENV,
  createKaanaTransport,
  readEdgePrivateKey,
} from './kaana-transport.js';

/**
 * Every variable this file needs beyond the principal the boot check already
 * requires. Exported so a boot-time report can name what is missing rather than
 * failing at the first request.
 */
export const KAANA_REQUIRED_ENV: readonly string[] = [
  KAANA_EDGE_KEY_ID_ENV,
  KAANA_EDGE_PRIVATE_KEY_ENV,
];

/** The variables above that this environment does not carry. */
export function unsetKaanaVariables(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return KAANA_REQUIRED_ENV.filter((name) => (env[name] ?? '').trim() === '');
}

/**
 * The principal, read from the five variables the boot check pins.
 *
 * `inferenceScopes` is a comma-separated list because an environment variable
 * carries one string; every other field is an opaque Oxy id this process copies
 * and never parses.
 */
/**
 * The closed sets the contract defines, restated as the narrow types the client
 * config wants.
 *
 * Restated rather than imported because `@oxyhq/contracts` publishes no
 * inference module yet — the gap analysis measured zero inference files in the
 * published tarball — and a value read from an environment variable is a
 * `string` until something narrows it. The narrowing is a REFUSAL, never a
 * cast: an unrecognised scope or deployment yields no client, rather than an
 * envelope Kaana rejects on the first real request.
 */
const PRINCIPAL_ENVIRONMENTS = ['production', 'staging', 'development'] as const;
type PrincipalEnvironment = (typeof PRINCIPAL_ENVIRONMENTS)[number];

const INFERENCE_SCOPES = [
  'inference:invoke',
  'inference:models:read',
  'inference:usage:read',
  'inference:routing:read',
  'inference:routing:write',
  'inference:providers:read',
  'inference:providers:write',
] as const;
type InferenceScope = (typeof INFERENCE_SCOPES)[number];

function readEnvironment(value: string): PrincipalEnvironment | null {
  return (PRINCIPAL_ENVIRONMENTS as readonly string[]).includes(value)
    ? (value as PrincipalEnvironment)
    : null;
}

/** `null` when ANY scope is unrecognised: a silently dropped scope is a request
 * that fails later for a reason nobody configured. */
function readScopes(value: string): readonly InferenceScope[] | null {
  const declared = value.split(',').map((scope) => scope.trim()).filter(Boolean);
  if (declared.length === 0) return null;
  const known = (INFERENCE_SCOPES as readonly string[]);
  return declared.every((scope) => known.includes(scope))
    ? (declared as InferenceScope[])
    : null;
}

function principalFrom(env: NodeJS.ProcessEnv): KaanaClientConfig['principal'] | null {
  const read = (name: string): string => (env[name] ?? '').trim();
  // Validated rather than asserted. A cast here would build an envelope Kaana
  // refuses, and it would refuse it in production on the first real request.
  const environment = readEnvironment(read(KAANA_PRINCIPAL_ENV.environment));
  if (environment === null) return null;
  const inferenceScopes = readScopes(read(KAANA_PRINCIPAL_ENV.inferenceScopes));
  if (inferenceScopes === null) return null;

  return {
    billing: { accountId: read(KAANA_PRINCIPAL_ENV.billing) },
    applicationId: read(KAANA_PRINCIPAL_ENV.applicationId),
    credentialId: read(KAANA_PRINCIPAL_ENV.credentialId),
    environment,
    inferenceScopes: [...inferenceScopes],
  };
}

/**
 * What a call that names no model is routed to.
 *
 * A ROUTING PROFILE is the right expression of this — "Kaana, choose" is the
 * whole point of an inference plane that owns provider selection — and it is
 * what this was. Measured against production on 2026-08-24, Kaana refuses it:
 *
 *     invalid_request: this build serves concrete model targets only: the
 *     envelope carries a routing policy reference, not the snapshot a profile
 *     would have to be resolved against
 *
 * The refusal reached production as `KaanaInferenceError: Kaana inference
 * failed: invalid_request` on every background derivation, so the default is a
 * concrete reference until Kaana resolves profiles, at which point this goes
 * back to being `{ kind: 'routing_profile', routingProfile: 'auto' }` and
 * nothing else here changes.
 *
 * `openai/gpt-oss-120b` and not something larger: this default only ever serves
 * work the platform pays for and nobody is waiting on — a suggestion, a title.
 * It is also the reference with the most deployments behind it in the live
 * snapshot (cerebras, groq and openrouter), so Kaana still has somewhere to go
 * when one provider is exhausted, which is the failover a single-provider
 * default would not have.
 *
 * UNPINNED on purpose: the pinned form names a revision, and pinning here would
 * outlive the revision it names. Kaana resolves the unpinned name to whatever is
 * current, which is its decision to make and not this file's.
 */
const KAANA_DEFAULT_TARGET = { kind: 'model', modelReference: 'openai/gpt-oss-120b' } as const;

/**
 * The client, or `null` when this process is not configured to reach Kaana.
 *
 * `null` rather than a throwing stub so isolated construction can report an
 * incomplete configuration without opening a transport.
 * Built once and memoised — the transport holds a parsed private key, and
 * re-reading it per request is work with no answer that can differ.
 */
let cached: KaanaInferenceClient | null | undefined;

export function getKaanaClient(env: NodeJS.ProcessEnv = process.env): KaanaInferenceClient | null {
  if (cached !== undefined) return cached;
  cached = buildKaanaClient(env);
  return cached;
}

/** For tests, which need a client per environment rather than per process. */
/**
 * There is no flag here: Kaana is the inference provider, not an optional
 * feature. The endpoint, signing key and principal are the complete decision.
 */
export function buildKaanaClient(env: NodeJS.ProcessEnv): KaanaInferenceClient | null {
  if (unsetKaanaVariables(env).length > 0) return null;

  const principal = principalFrom(env);
  if (principal === null) return null;
  // The endpoint is checked against the ALLOWED origins for this deployment, so
  // a misconfigured base URL is refused here rather than discovered by a request
  // arriving somewhere unexpected.
  const endpoint = resolveKaanaEndpoint(env, principal.environment);
  if (endpoint.kind === 'refused') return null;

  const transport = createKaanaTransport({
    keyId: (env[KAANA_EDGE_KEY_ID_ENV] ?? '').trim(),
    privateKey: readEdgePrivateKey(env[KAANA_EDGE_PRIVATE_KEY_ENV] ?? ''),
  });

  return createKaanaInferenceClient({
    transport,
    // Kaana reads no bearer token; see the file comment.
    credential: {
      getServiceToken: async () => 'unused',
      invalidateServiceToken: () => {},
    },
    endpoint: endpoint.endpoint,
    principal,
    defaultTarget: KAANA_DEFAULT_TARGET,
    routingPolicies: {},
    // The policy Kaana is sent, and the only one this deployment declares. A
    // richer table is a product decision that has not been made; naming a
    // policy nobody defined would be worse than naming the default.
    defaultRoutingPolicy: { routingPolicyId: 'default', policyVersion: 1 },
    maxAttempts: 3,
    circuit: { failureThreshold: 5, cooldownMs: 30_000 },
    env,
  });
}

/** Test seam: forget the memoised client so the next call rebuilds it. */
export function resetKaanaClient(): void {
  cached = undefined;
}
