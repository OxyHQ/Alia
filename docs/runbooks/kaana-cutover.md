# Runbook: Alia to Kaana cutover

Alia consumes hosted inference through `@oxy.so/core`'s
`OxyInferenceClient`: `Alia -> Oxy -> Kaana`. Alia authenticates to Oxy with a
short-lived service token. Oxy resolves the application identity, account,
routing policy and exact authorised routes before it signs and forwards the
request to Kaana.

Alia must never hold an upstream-provider credential or a Kaana edge-signing
private key. Text inference uses Oxy; voice uses the canonical `https://kaana.ai`
SDK transport under ADR0017.

## Configuration contract

The Alia task requires exactly this inference configuration:

```text
OXY_API_URL
```

Own callers use the registered task role through the shared Oxy workload
transport. Attestation binds the application, workload and environment, and the
recipient audience is selected by the shared product SDK. No own API key pair
or app scopes are configured. `OXY_API_URL` selects the platform endpoint; it is
not an identity assertion.

For local development use the server-only AWS credential provider with temporary
IAM credentials for an administratively registered development role, for example
AWS SSO. A local checkout does not fall back to customer API keys. The same live
binding and recipient checks apply.

Both deployment workflows explicitly remove inherited retired credentials with
`TASK_SECRET_REMOVALS_JSON`. Removing a binding does not delete an SSM parameter;
parameter cleanup follows verified workload-only runtime and drain receipts.

## Preconditions

Do not enable production traffic until all of these pass:

1. Alia's manifest and frozen lock resolve a published `@oxy.so/core` release
   with the reviewed `OxyInferenceClient` and public-JWKS service-token support.
   Hosted paths call that client, never a bespoke transport. The repository
   build and inference-boundary tests are the source gate; a version cited by an
   older rollout note is not evidence about the current lock.
2. Alia sends the selected power level or exact published model under ADR0012.
   Oxy verifies workload authority and resolves a non-empty ordered route set
   before calling Kaana. Alia does not resolve provider deployments itself.
3. Kaana validates each route against its published inventory and refuses
   anything outside the Oxy-authorised list.
4. Alia has no provider key, provider endpoint, Kaana signing key or direct
   Kaana deployment URL outside the canonical voice SDK boundary in source,
   environment, SSM bindings or active database rows.
5. Text, tools and structured output have focused coverage; unsupported hosted
   modalities fail with the typed product error.
6. The verified billing account is allowed to spend and a
   non-production canary returns usage with the expected attribution.
7. Every agent turn, an app's agent included, is paid by the person using it
   (ADR 0020 §4); no product application pays for an agent. A canary receipt
   for an agent turn names that person, never Alia's credential.

## Rollout

1. From Oxy `main`, run the signed deployment readback against the exact live
   Oxy task-definition ARN and immutable image digest. Record its exact
   `snapshotId`; this step makes zero provider requests and zero ledger writes.
2. Run the signed Oxy production canary with one exact `deploymentId` from
   that projection and the same `snapshotId`. It must not select by
   provider/model name, row order or first match.
3. Verify the live readout and a real attributed Oxy-to-Kaana request. Hosted
   execution is the normal Oxy path and has no feature-flag environment
   variable. The authoritative procedure is Oxy's
   [`kaana-request-v2-cutover.md`](https://github.com/OxyHQ/oxy/blob/main/docs/runbooks/kaana-request-v2-cutover.md).
4. Inspect the candidate Alia task definition without printing secret values.
5. Deploy one immutable revision containing the Oxy URL and registered workload
   identity. The boot guard fails closed; there is no provider
   fallback.
6. Verify `runningCount == desiredCount`, `pendingCount == 0`, rollout state
   `COMPLETED` and the exact task-definition revision.
7. Run a concrete-model canary through Alia and Oxy, without logging routes or
   credentials. (Routing-profile canaries were retired with ADR 0012.)
8. Verify `/health` reports its canonical `kaana` field and a real request
   returns expected Oxy attribution and Kaana usage.

For the model/tool acceptance run, use the manual **Alia production chat
canary** workflow. It runs only the exact live image as a private ECS one-shot,
starts that image's API and enters its loopback HTTP endpoint with Alia's
shared Alia SDK workload transport and a live QA automation task. The ordinary
Oxy middleware validates the exact workload, requester account and task before
chat runs; there is no canary-only authentication exception.
The protected production environment holds `ALIA_CANARY_OXY_USER_ID` for the
dedicated QA account and `ALIA_CANARY_OXY_TASK_ID` for its revocable automation
root. Create that root through Oxy using the QA account's real signed-in session;
never persist that bearer or fabricate a grant in SQL. These protected values
are not workflow inputs, so an operator cannot substitute an arbitrary customer.
A missing, expired or revoked task must fail instead of using the workload owner.
The runner supplies no conversation id, so it creates no durable thread or
retryable tool side effects. Its result contains only model ids,
Alia correlation references, allowlisted classified product error codes and
booleans; it never emits the QA identity, prompts, answers, credentials,
provider names or deployments.

The workflow intentionally proves two consecutive turns in Auto, Instant,
Thinking and Research, one web-search turn, a controlled unknown-profile
refusal and a final recovery turn. A synthetic HTTP-200 stream fails the run.
The refusal is not a provider outage simulation and must not be cited as one;
it proves only that a failed turn does not poison the following invocation.

## Rollback

Repoint Alia only to a revision that uses the same Oxy SDK boundary and contains
no provider or direct-Kaana path. If none exists, fix forward or stop hosted
inference visibly. Never restore Alia-owned provider keys for availability.
