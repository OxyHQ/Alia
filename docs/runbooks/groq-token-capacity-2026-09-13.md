# Long-context refusal recovered on 2026-09-13

The reference `chatcmpl-ab7ad115-e273-4bdb-899a-13dd28cd7a74` failed at
2026-09-12 23:29:45 UTC (2026-09-13 locally). Its Oxy/Kaana request was
`5a5fccb0-71cb-4556-8b1c-cf26ce1f7237`. Groq returned HTTP 413; Kaana reported
`request_too_large`, made zero route switches, and Alia surfaced `INVALID_REQUEST`.

A synthetic long-context request through the published Oxy SDK reproduced the
provider's diagnostic: the platform account had an 8,000-token-per-minute
ceiling and the request required 11,305 tokens. This was an account capacity
limit, not a malformed user message or the model's context-window limit.
A short Alia chat succeeded; the long Alia control reproduced the product error.
No original user prompt was exported or replayed. The previous incident's
small-prompt canaries had not covered this larger request.

## Fix and release

[Kaana #97](https://github.com/OxyHQ/Kaana/pull/97), merged as
`41acf1526c5293da18b032ae20e38a7701251186`, recognizes only Groq's HTTP 413 with
`type: tokens` and `code: rate_limit_exceeded` as a rate limit. Kaana can then
use the next Oxy-authorized deployment. Genuine oversized payloads, context
errors, malformed requests, other providers and message-only lookalikes keep
their terminal behavior. No Alia provider transport or credential was added.

The new credential runtime on Kaana main still has its separate release gate.
This fix was also backported onto the exact previously serving source
`df1fa39728b9377f1e00be038d0c4769f6bcb446`. The immutable backport changes only
one adapter file and two regression-test files; it changes no schema, binding,
provider key, signing configuration, publisher or routing policy. Its build
workflow pins the patch hash, verifies the exact changed paths and runs checks
on that reconstructed source before publishing an image.

Production now serves `oxy-kaana:41` with image digest
`sha256:7672df2b0f2f39b2c2baa16019c9078313de847c8530eaf526ebdb4ca2e7ce4a`.
The registry's ARM64 image labels matched the reviewed source, patch and tree.
An isolated task passed an HTTP 200 liveness probe using the existing network
and roles. The production task-definition comparison allowed only the Kaana
image change; the rollout reached one healthy task and `COMPLETED`.
Alia remains `oxy-alia:334`, Oxy `oxy-oxy-api:420`, and the publisher
`oxy-kaana-publisher:46`; all services were read back stable.

## Validation

- The new classification regression failed before the fix and passed afterward.
  Eight classification controls distinguish the observed capacity shape from
  terminal refusals. Three real HTTP adapter/executor cases prove authorized
  fallback, no unauthorized fallback and no fallback for a genuine oversized
  payload.
- Full Go race suites, build, vet and golangci-lint passed locally on both main
  and the exact serving backport. Optional database integration tests retain
  their existing environment requirements; no database behavior changed.
- Original PR CI passed, and build run `34726178398` independently checked the
  reconstructed serving source before publishing the image.
- All eight real Alia cases passed in production: short Instant and Auto, long
  Instant and Auto, a long multi-turn conversation, real web search with long
  context, an unknown-profile HTTP 400 refusal, and successful recovery.
- The identical long SDK probe then emitted `route_switch` with reason
  `rate_limited` to the exact authorized OpenRouter deployment, followed by
  `done`: request `88bb1294-beed-4ae8-a037-d2fba9838cb6`. Its diagnostic output
  budget was deliberately 32 tokens; that bounded probe ended with `length`.
  The full Alia cases separately verified their requested output marker.

[Structured evidence](evidence/groq-token-capacity-2026-09-13.json) retains
per-case results, artifact identities, route completion metadata and service
readback without credentials or original conversation content.

## Cleanup and remaining gates

All five temporary ECS tasks were stopped and the auxiliary task definitions
were deregistered. The normal `test` QA identity was reused without changing
its plan, and all QA sessions were revoked. Its private identity remains in the
operator's vault. Task-owned local worktrees, downloaded tools, caches, scripts,
session material and synthetic transcripts are removed after retaining this
safe evidence; pre-existing user work is preserved.

The separate Oxy service-token signing and Kaana credential-runtime promotion
gates documented in the [earlier incident](provider-unavailable-2026-09-12.md)
remain unchanged. This verified serving backport does not certify those cutovers.
