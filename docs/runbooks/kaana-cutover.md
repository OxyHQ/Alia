# Runbook: Alia to Kaana cutover

Alia consumes hosted inference through `@oxyhq/core`'s
`OxyInferenceClient`: `Alia -> Oxy -> Kaana`. Alia authenticates to Oxy with a
short-lived service token. Oxy resolves the application identity, account,
routing policy and exact authorised routes before it signs and forwards the
request to Kaana.

Alia must never hold an upstream-provider credential, a Kaana edge-signing
private key or a direct Kaana URL.

## Configuration contract

The Alia task requires exactly this inference configuration:

```text
OXY_API_URL
OXY_SERVICE_API_KEY
OXY_SERVICE_API_SECRET
```

The values are an Oxy ApplicationCredential, not Kaana or provider credentials.
Oxy derives account, application and credential IDs from the exchanged token;
do not copy those IDs into Alia configuration or introduce legacy aliases.

Oxy provisions the two credential values from its ApplicationCredential record
into exact SSM parameters. Alia's deploy validates their names and
`SecureString` types without reading or overwriting them, then binds them to each
new task definition. A value in SSM without a live task binding is not delivered.

## Preconditions

Do not enable production traffic until all of these pass:

1. Alia's manifest and frozen lock resolve a published `@oxyhq/core` release
   with the reviewed `OxyInferenceClient` and public-JWKS service-token support.
   Hosted paths call that client, never a bespoke transport. The repository
   build and inference-boundary tests are the source gate; a version cited by an
   older rollout note is not evidence about the current lock.
2. Alia sends only the reviewed opaque `routingProfileId`; Oxy authenticates
   the Alia service credential, validates that exact profile row and resolves it
   into a non-empty ordered route set before calling Kaana. There is no
   name/slug/list-order lookup or fallback.
3. Kaana validates each route against its published inventory and refuses
   anything outside the Oxy-authorised list.
4. Alia has no provider key, provider endpoint, Kaana signing key or direct
   Kaana URL in source, environment, SSM bindings or active database rows.
5. Text, tools and structured output have focused coverage; unsupported hosted
   modalities fail with the typed product error.
6. The Oxy account behind the ApplicationCredential is allowed to spend and a
   non-production canary returns usage with the expected attribution.
7. Every product agent has an Oxy-authoritative `owner_oxy_account_id` and fixed
   `application_id` written by internal bootstrap, is not publicly mutable, and
   a human bearer plus the known id is refused.
8. Each product ingress uses its own Oxy service credential and delegated
   `X-Oxy-User-Id`; its token and acting-as grant both carry
   `inference:invoke`. A canary receipt must name that product application's
   owner/credential, never Alia's credential and never the delegated user as
   payer.

## Rollout

1. Keep ambient Oxy `INFERENCE_KAANA_EXECUTION=disabled`. From Oxy `main`, run
   the signed deployment readback against the exact live Oxy task-definition
   ARN and immutable image digest. Record its exact `snapshotId`; this step
   makes zero provider requests and zero Oxy ledger writes.
2. Run the signed Oxy production canary with one exact `deploymentId` from that
   projection and the same `snapshotId`. It makes the two explicitly confirmed
   one-token provider requests while ambient execution remains disabled; it
   must not select by provider/model name, row order or first match.
3. Only after both runs pass, land and deploy the separate Oxy change that
   enables `INFERENCE_KAANA_EXECUTION`, then verify the live readout and a real
   attributed Oxy-to-Kaana request. The authoritative procedure is Oxy's
   [`kaana-request-v2-cutover.md`](https://github.com/OxyHQ/oxy/blob/main/docs/runbooks/kaana-request-v2-cutover.md).
4. Inspect the candidate Alia task definition without printing secret values.
5. Deploy one immutable revision containing the Oxy URL and both service
   credential bindings. The boot guard fails closed; there is no provider
   fallback.
6. Verify `runningCount == desiredCount`, `pendingCount == 0`, rollout state
   `COMPLETED` and the exact task-definition revision.
7. Run a concrete-model canary and a routing-profile canary through Alia and
   Oxy. The latter must prove policy resolution without logging routes or
   credentials.
8. Verify `/health` reports its canonical `kaana` field and a real request
   returns expected Oxy attribution and Kaana usage.

## Rollback

Repoint Alia only to a revision that uses the same Oxy SDK boundary and contains
no provider or direct-Kaana path. If none exists, fix forward or stop hosted
inference visibly. Never restore Alia-owned provider keys for availability.
