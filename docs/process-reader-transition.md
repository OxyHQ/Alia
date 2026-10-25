# Alia API and integrations: reader-first deployment

This is the finite preparation for ADR0022 and SDK22. Both processes must accept
new workloads before either producer stops sending its existing secret. This
commit publishes only the additive `@alia.onl/server`1.2 package; it does not
publish SDK22, switch producers or remove deployment secrets.

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
2. Deploy the producer transition while retaining these dual readers and both
   secrets. Verify new workload emission in both directions, linked account
   ownership and old-task drain. Do not remove a reader while the other process
   can still emit the old protocol. Durable user-task reconciliation belongs to
   the runtime migration; local channel context is never a substitute for it.
3. Deploy22's final removal of legacy readers and both inherited secrets only
   after both producers use workloads. Confirm no old producers or tasks remain,
   then remove the infra secret wiring.

The new server package is built before either consumer in CI and Docker, and the
integrations image carries its compiled workspace target. Backend reader packages
use the published core7.1/contracts6. Existing frontend and CLI dependencies remain
on their current versions until SDK22; removing root force-overrides permits that
intentional independent rollout.

Evidence: `process-readers-http.test.ts` in each process uses real HTTP, real
Ed25519 signatures/JWKS and the installed Oxy middleware, with a controlled live
introspection endpoint. Cases cover both protocols, refusal without downgrade,
canonical socket audience, removed links, missing context and another account's
row. The tool-pipeline regression ensures local channel context cannot introduce
private Oxy/MCP/provider tools.
