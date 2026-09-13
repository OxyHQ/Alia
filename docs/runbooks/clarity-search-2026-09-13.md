# Clarity search outage observed on 2026-09-13

Status: **production search remains unavailable**. The canary correction below
prevents false success reports; it does not restore Clarity's missing data or
complete its production cutover.

The reported `webSearch` query returned `Clarity request failed with 503` with
an empty result array. Alia uses `@clarity.surf/sdk` against
`https://api.clarity.surf`; the error comes from that dependency.

## Production observations

Read-only observations in AWS account `237343248947`, region `us-west-2`:

- `/health/live` and `/health/ready` returned load-balancer HTML with HTTP 503.
- ECS `clarity-api` and `clarity-worker` each had desired/running counts `0/0`.
  Their selected task definitions were `oxy-clarity-api:1` and
  `oxy-clarity-worker:1`, referencing a mutable `latest` image.
- Clarity main `18419cdbcf048b509b513a58f6a26d518f9aafff` passed CI. Backend
  deployment run `34526130360` built an image but failed before rollout:
  `clarity-api must have a task definition and positive desiredCount.`
  The built image digest is
  `sha256:d33b40d0a4af36bb4fd8a3c599c79ea395c19c8dcb38a57a250597a31e796782`.
- All required SSM parameter references existed with non-placeholder values.
  This checks presence, not a successful service-token exchange.
- Two isolated tasks using that immutable image and the existing Clarity
  network/roles successfully opened a read-only PostgreSQL transaction.
  `clarity_runtime_state` had no rows. Counts were zero for
  `clarity_search_documents`, `clarity_search_chunks`, `clarity_conversations`,
  `clarity_messages`, and `clarity_backfill_receipts`.
  Diagnostic task IDs: `5e92629464914c548d459f942a2ea9ee` and
  `da1643132b1a4a11a7e307251ce2d4c7`; logs are under `/oxy/ecs` with
  `clarity-api/clarity-api/<task-id>` streams.
- A third isolated task, `3e3e4695a92d476dbc013e8afca124c7`, timed out connecting
  to the historical Mongo endpoint from the vault. This is a reachability
  observation, not proof that every historical source has been deleted.
- No cutover manifest or Clarity export was found in the examined vault/repo
  paths. The S3 bucket `oxy-mongo-backups-usw2-237343248947` had 31 objects;
  both final 2026-08-10 source inventories omitted a Clarity database. These
  inventories are not sufficient to declare Clarity an empty-source migration.

Clarity's documented readiness gate requires an exact reconciled source
manifest, canonical identity and dated runtime/billing receipts. A capacity
increase would not satisfy those conditions. Its hybrid search already falls
back to lexical search when embeddings are unavailable, but there is currently
no indexed corpus to search. Do not fabricate an attestation or seed one query
and describe the resulting service as general web search.

## Canary correction and validation

`production-chat-canary.ts` now requires the correlated `webSearch` tool result
to contain no error, a nonempty result array, a matching count, and usable
HTTP(S) source URLs with titles. A model's final marker cannot hide tool failure.
The safe evidence output retains its existing `toolEvent` field; for newly run
canaries it now means a successful, usable correlated search result.

The 14 canary tests pass locally. Eight negative controls fail against the old
implementation, including the exact reported 503 with a successful final
marker. The API suite passed 2,123 tests with one existing skipped test across
189 passing files: the first Node run needed the temporary toolchain's missing
`bunx` symlink for two migration-integrity tests, and that complete 11-test file
passed after the toolchain correction. API typecheck and changed-file ESLint
also passed. No database behavior changed in Alia.

The earlier incident reports are corrected in place: their historical search
checks proved invocation and final-answer completion, not successful results.
The original recorded evidence is retained without relabeling it as stronger
verification.

## Recovery still required

Obtain the authoritative Clarity source/export (or reviewed evidence of its
actual original deployment state), reconcile it with the documented migrator,
verify the exact Clarity agent and billing receipts, and attest the cutover.
Restore/index the public corpus through Clarity's ingestion contracts. Then
roll out an immutable tested image to both services and verify authenticated
search with real result payloads, followed by Alia's corrected canary. Until
those steps pass, the production search incident is open.
