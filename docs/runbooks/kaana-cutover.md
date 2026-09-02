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
ALIA_KAANA_CREDENTIAL_KEY
ALIA_KAANA_CREDENTIAL_SECRET
```

The credential names are retained for deployment compatibility, but the values
are an Oxy ApplicationCredential, not Kaana or provider credentials. Oxy derives
account, application and credential IDs from the exchanged token; do not copy
those IDs into Alia configuration.

The deploy workflow syncs the two credential values into exact SSM parameters
and binds them to each new task definition. A value in SSM without a live task
binding is not delivered.

## Preconditions

Do not enable production traffic until all of these pass:

1. `@oxyhq/core@23.1.0` or later is installed and Alia's hosted paths call
   `OxyInferenceClient`, never a bespoke transport.
2. Oxy authenticates the Alia service credential and resolves routing-profile
   requests into a non-empty ordered route set before calling Kaana.
3. Kaana validates each route against its published inventory and refuses
   anything outside the Oxy-authorised list.
4. Alia has no provider key, provider endpoint, Kaana signing key or direct
   Kaana URL in source, environment, SSM bindings or active database rows.
5. Text, tools and structured output have focused coverage; unsupported hosted
   modalities fail with the typed product error.
6. The Oxy account behind the ApplicationCredential is allowed to spend and a
   non-production canary returns usage with the expected attribution.

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

## Rollback

Repoint Alia only to a revision that uses the same Oxy SDK boundary and contains
no provider or direct-Kaana path. If none exists, fix forward or stop hosted
inference visibly. Never restore Alia-owned provider keys for availability.
