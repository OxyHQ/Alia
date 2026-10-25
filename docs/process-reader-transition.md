# Alia API and integrations: reader-first deployment

This is the finite preparation for ADR0022 and SDK22. Both processes must accept
new workloads before either producer stops sending its existing secret. This
phase publishes additive `@alia.onl/server` 1.2 and CLI 3.0.1 (its Oxy runtime
dependency alignment). It does not publish SDK 22, switch producers or remove
deployment secrets.

The API and integrations readers validate the signed Oxy workload with the
shared core7.1 middleware, canonical Alia audience and exact caller workload
registration. Oxy revalidates the live application, account, binding and expiry.
An `Authorization` header selects this protocol unconditionally. A bad signature,
revoked identity, wrong audience, wrong workload or external credential fails even
when accompanied by a valid legacy secret. Only an absent `Authorization` can
reach the original secret reader, on the same endpoints as before.

API→integrations carries local account context after the API has authenticated
its caller. The gateway replaces body owners and checks session-row ownership.
Integrations→API carries a provider user or connection session identity; the API
resolves its live database link. Neither an owner header nor the incoming workload
bearer becomes a foreground Oxy session. This preparation creates no task roots:
a local channel account alone cannot authorize private Oxy tools or another
connected provider. SDK22's API supplies durable roots from verified sessions and
its migration reconciles existing links. Existing secret producers retain their
previous behavior until the final cutover.

Deployment order:

1. Deploy these readers to **both** API and integrations; keep both old secrets.
   Wait for every old task to drain. Verify HTTP and socket health in each direction.
2. Deploy the additive provider metadata preparation (A2) to integrations and
   the API selector. It still emits the existing secret and account header, plus
   the actual platform user ID or connected-session ID captured by the adapter.
   An absent Authorization keeps these calls on the old reader; the added metadata
   never becomes workload or user authority. Drain every pre-A2 integrations task
   before B. A conversation ID is not a substitute: it is not unique in bot links,
   and history-list/audio requests do not carry one.
3. Deploy the producer transition while retaining these dual readers and both
   secrets. Verify new workload emission in both directions, linked account
   ownership and old-task drain. Do not remove a reader while the other process
   can still emit the old protocol. Durable user-task reconciliation belongs to
   the runtime migration; local channel context is never a substitute for it.
4. Deploy22's final removal of legacy readers and both inherited secrets only
   after both producers use workloads. Confirm no old producers or tasks remain,
   then remove the infra secret wiring.

The new server package is built before either consumer in CI and Docker, and the
integrations image carries its compiled workspace target. Backend reader packages
use the published core7.1/contracts6. The whole workspace uses one aligned Oxy dependency set, as required by the
repository doctor. Existing frontend source remains on21.5.4 until SDK22; CLI3.0.1
records its runtime dependency change without switching the process producers.

Evidence: `process-readers-http.test.ts` in each process uses real HTTP, real
Ed25519 signatures/JWKS and the installed Oxy middleware, with a controlled live
introspection endpoint. Cases cover both protocols, refusal without downgrade,
canonical socket audience, removed links, missing context and another account's
row. The tool-pipeline regression ensures local channel context cannot introduce
private Oxy/MCP/provider tools.

B must resolve A2 legacy provider metadata through the same live link as the
workload lane, after validating that channel’s existing secret. It may reuse only
the reconciled task stored on that link, never create authority from the account
header. The A2 metadata is temporary rollout compatibility and disappears with
the remaining secret reader in C.
