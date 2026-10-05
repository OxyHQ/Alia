# Oxy One allowance funding

This draft adds central product periods as a separate allowance source. Existing daily free refill and individual purchased balances remain intact and are attempted first. No adapter is configured by default.

Show cover art uses the current authenticated account session. Existing webhook, agent, automation and show background admissions use `OxyServer.productGrantSnapshotForService` for the exact payer/product. Oxy requires registered product/application identity, a current production credential, existing `user:read` and `acting-as:offline` authorization and exact subject consent. No consent, scope or credential is created here. Missing authority admits no bundle credits while preserving existing free/purchased funding.

Operation/allocation identity survives agent-session queues through additive migration 0084. Pricing comes from the immutable stored operation. Metered and fixed settlement retain the admitted source/period and need freshly authorized matching grants to consume more than the reserved amount. Cancellation and expiry report no eligible remainder. Tokens and refresh callbacks are never persisted.

## Voice blocker

`packages/api/src/routes/v1/audio.ts` invokes speech without an Alia credit operation. `packages/api/src/lib/synthesize-speech.ts` exposes audio, format and request ID only. A published Oxy-recorded usage/customer-price contract is needed to admit and settle that lane accurately. This draft does not invent a per-character tariff or generic minimum charge, and does not claim voice allowance parity. Episode speech remains inside the existing show fixed-cost pipeline.

## Adoption and validation

Local validation uses ignored copies of the new Oxy Core/Contracts build. Publish/adopt the compatible SDK through the normal release workflow before deployment; manifests contain no private workspace paths. Migration 0084 was applied only by throwaway PostgreSQL test harnesses. No runtime configuration, live grants, paid calls or payment activation were created.

Local validation: 144 PostgreSQL tests across allocation/credits, queue persistence, owner fallback, handoff and show pipeline; 50 unit tests across the service helper, automation, deferred approval and show cover; API typecheck. Full dependency installation/build verification remains blocked by the libsignal GitHub tarball HTTP 403, which was not bypassed.
