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

1. The JWKS-capable `@oxyhq/core` from Oxy
   [PR #1167](https://github.com/OxyHQ/oxy/pull/1167) is published, and Alia's
   manifest plus frozen lock resolve that released version. The currently
   locked `23.2.0` does not verify public-JWKS service tokens. Hosted paths call
   `OxyInferenceClient`, never a bespoke transport.
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

1. Verify the Oxy inference edge and its live Oxy-to-Kaana route first.
2. Inspect the candidate Alia task definition without printing secret values.
3. Deploy one immutable revision containing the Oxy URL and both service
   credential bindings. The boot guard fails closed; there is no provider
   fallback.
4. Verify `runningCount == desiredCount`, `pendingCount == 0`, rollout state
   `COMPLETED` and the exact task-definition revision.
5. Run a concrete-model canary and a routing-profile canary through Oxy. The
   latter must prove policy resolution without logging routes or credentials.
6. Verify `/health` retains its `kaana` compatibility field and a real request
   returns expected Oxy attribution and Kaana usage.
7. Run one Sindi/Clarity canary per bound application and prove four outcomes:
   exact app + delegation succeeds; human bearer, wrong app and missing
   `inference:invoke` all fail before inference. Do not enable product traffic
   while any bot parent or application binding is null.

## Rollback

Repoint Alia only to a revision that uses the same Oxy SDK boundary and contains
no provider or direct-Kaana path. If none exists, fix forward or stop hosted
inference visibly. Never restore Alia-owned provider keys for availability.
