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
 * `RelayClientConfig` wants a `credential`, and Kaana never reads one. It
 * authenticates the Ed25519 signature over the body (`kaana-transport.ts`) and
 * takes attribution from the envelope, so a bearer token would be a credential
 * handed to a party with no use for it. The credential here therefore mints
 * nothing: it answers a constant that the transport drops on the floor, and
 * `createRelayServiceCredential` — which exchanges an Oxy service token — is
 * deliberately NOT used. That exchange belongs to a different transport for a
 * different hop, and requiring its three variables to reach Kaana would be
 * requiring a credential to satisfy a type.
 *
 * ## What it refuses to do
 *
 * Return a client to a process that was never given one's parts. A missing
 * endpoint, key or principal yields `null` rather than a client that fails at
 * the first request — and `null` is a state the callers already handle, because
 * the in-process path still exists behind them.
 */

import {
  createRelayInferenceClient,
  type RelayClientConfig,
  type RelayInferenceClient,
} from './kaana-client.js';
import { RELAY_PRINCIPAL_ENV } from './kaana-boot-check.js';
import { resolveRelayEndpoint } from './kaana-endpoint.js';
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

function principalFrom(env: NodeJS.ProcessEnv): RelayClientConfig['principal'] | null {
  const read = (name: string): string => (env[name] ?? '').trim();
  // Validated rather than asserted. A cast here would build an envelope Kaana
  // refuses, and it would refuse it in production on the first real request.
  const environment = readEnvironment(read(RELAY_PRINCIPAL_ENV.environment));
  if (environment === null) return null;
  const inferenceScopes = readScopes(read(RELAY_PRINCIPAL_ENV.inferenceScopes));
  if (inferenceScopes === null) return null;

  return {
    billing: { accountId: read(RELAY_PRINCIPAL_ENV.billing) },
    applicationId: read(RELAY_PRINCIPAL_ENV.applicationId),
    credentialId: read(RELAY_PRINCIPAL_ENV.credentialId),
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
 * The refusal reached production as `RelayInferenceError: relay inference
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
 * `null` rather than a throwing stub: a caller holding it decides whether to
 * fall back, and that decision belongs at the call site while both paths exist.
 * Built once and memoised — the transport holds a parsed private key, and
 * re-reading it per request is work with no answer that can differ.
 */
let cached: RelayInferenceClient | null | undefined;

export function getKaanaClient(env: NodeJS.ProcessEnv = process.env): RelayInferenceClient | null {
  if (cached !== undefined) return cached;
  cached = buildKaanaClient(env);
  return cached;
}

/** For tests, which need a client per environment rather than per process. */
/**
 * There is no flag here, deliberately.
 *
 * Kaana IS the inference provider; using it is not a feature to opt into. What
 * decides whether this process reaches it is whether it has been GIVEN what it
 * needs to — an endpoint, a signing key, a principal — and a deployment that
 * has all three has said everything there is to say.
 *
 * `ALIA_RELAY_CLIENT_ENABLED` is a different question and is left alone: that
 * one declares the cutover DONE, which arms the boot refusal and installs the
 * egress block that makes every direct provider host unreachable. It belongs to
 * the day the in-process tree is deleted, not to the day Kaana starts serving.
 */
export function buildKaanaClient(env: NodeJS.ProcessEnv): RelayInferenceClient | null {
  if (unsetKaanaVariables(env).length > 0) return null;

  const principal = principalFrom(env);
  if (principal === null) return null;
  // The endpoint is checked against the ALLOWED origins for this deployment, so
  // a misconfigured base URL is refused here rather than discovered by a request
  // arriving somewhere unexpected.
  const endpoint = resolveRelayEndpoint(env, principal.environment);
  if (endpoint.kind === 'refused') return null;

  const transport = createKaanaTransport({
    keyId: (env[KAANA_EDGE_KEY_ID_ENV] ?? '').trim(),
    privateKey: readEdgePrivateKey(env[KAANA_EDGE_PRIVATE_KEY_ENV] ?? ''),
  });

  return createRelayInferenceClient({
    enabled: true,
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
