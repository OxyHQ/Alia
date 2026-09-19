# Speech recovery — 2026-09-13

Status: implementation candidate, **not deployed**. Production speech remains
unavailable. Chat incident fixes and Clarity status have separate runbooks.

## Failure and implementation

The read-aloud request reached a route that unconditionally returned 503
`KAANA_CAPABILITY_UNAVAILABLE`. It could not reach any provider regardless of
available credit. The Oxy client lacked a speech operation, the signed request
lost voice/format/speed, and Kaana lacked binary audio events and an adapter.

The candidate keeps `Alia -> @oxy.so/core -> Oxy -> Kaana`. It adds typed speech
parameters and bounded audio events, validates MP3 transport, propagates
cancellation, preserves measured character units and returns a private signed
playback link. Alia uses delegated user identity and an exact speech profile;
agent routing IDs and database constraints remain unchanged. Failed persistence
removes the new object. Product errors conceal upstream names. The client aborts
pending synthesis on stop, message switch and unmount, ignores late responses
and does not retry 429 responses. Removing cancellation makes the new lifecycle
regressions fail.

The reserved speech profile ID is `cc2471c8-807e-46ec-b5da-b6f3b39d2db5`.
It has **not** been provisioned in Oxy. The deployment readiness check requires
its exact visibility before Alia can roll out.

## Evidence and limits

- A real xAI request for a short Spanish sentence returned HTTP 200,
  `audio/mpeg`, 57,216 bytes. FFmpeg decoded the whole MP3 successfully.
  No OpenAI inference was invoked. This was a provider probe, not a product canary.
- Initial candidate contracts: 661 tests; core: 1,828 tests; Oxy API: 6,754
  tests across all three serial shards. Signed Oxy edge audio
  tests include binary reconstruction, seven UTF-16 character units, settlement,
  invalid metadata and a mutation control that fails when folding audio is removed.
- Alia API: 2,135 tests passed, one existing skip; app: 645; chat SDK: 60.
  A separate PostgreSQL suite passes all 1,213 tests.
  API, app and chat SDK type checks pass with the locally built candidate API SDK.
- The API build and full Expo web export pass.
- The API lint command passes with existing warnings; it is not warning-free.
- Kaana race tests, build, vet and lint pass; real executor audio tests preserve
  framing, binary bytes and character units. Candidate wire validation accepts
  29 produced fixtures and rejects 18 controls.

The local API package resolution initially used freshly built contract/core
1.0.2 tarballs inside the task worktree, then the completed rebased build
(contracts 1.2.0/core 1.0.2). This is candidate validation, not
proof that a clean registry install can obtain those versions. Production pins
must be updated together with the lockfile after publication.

## Remaining release gates

1. Publish reviewed `@oxy.so/contracts` and `@oxy.so/core` releases. The supplied
   npm credential currently returns HTTP 401. GitHub release job 103660761068
   independently failed npm authentication with 401 on 2026-09-13. No token
   is included in this record. Concurrent main changes reserve contracts 1.1.0;
   the speech proposal preserves it and reserves contracts 1.2.0.
2. Update Kaana's published contract pin and regenerate the descriptor using a
   frozen install; verify the exact scoped serving artifact and publisher.
   Do not promote the broader credential-runtime cutover merely to enable speech.
3. Read fresh exact inventory identity, review/provision the Oxy speech catalogue,
   price, policy and credential binding through the normal authorized workflow.
   The xAI `/tts` capability is not listed in `/models`; successful authenticated
   `/tts/voices` discovery is technical evidence, never routing authorization.
4. Pin and deploy Alia after Oxy/Kaana are ready. Run the authorized `test` user's
   full product canary, decode playback, verify cancellation and settlement, and
   remove only the canary's audio/message/session artifacts.

No successful read-aloud production canary has been recorded yet. Shows retain
their Syra one-use ingestion tickets; custom historical show voice IDs are not
asserted compatible by these read-aloud tests. Voice sessions are a separate
capability and remain unavailable.
