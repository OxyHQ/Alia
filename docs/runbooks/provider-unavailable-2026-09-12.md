# Provider unavailability on 2026-09-12

## Incident and diagnosis

The reported product reference was
`chatcmpl-ece33a9a-1c55-4387-b116-19ee76400730`. At 15:52:39 UTC,
Alia called Oxy, and Kaana attempted Groq followed by Cerebras. The terminal
failure was `provider_billing_refused`: the platform's Cerebras account could
not be billed. This was not an Alia customer's exhausted credit balance.
The corresponding Oxy/Kaana request ID was
`e8d0e7e8-7d0c-4f40-8343-4ffabb098502`.

Occasional successful Groq responses did not establish recovery: a later
series of real user requests again encountered provider refusals and rate
limits. All recovery continues through `Alia -> Oxy -> Kaana`.

## Changes

- [Alia #572](https://github.com/OxyHQ/Alia/pull/572) preserves the typed Oxy
  error, retryability, retry delay and upstream request ID across streaming.
  The failure log pairs the product reference with that upstream identity.
  The product still emits its safe synthetic error and refunds the reservation.
- [Kaana #96](https://github.com/OxyHQ/Kaana/pull/96) loads exact deployment
  bindings through `active_provider_credentials`. The runtime role could not
  read the base `provider_credentials` table used by the previous join; this
  prevented the isolated new credential-runtime candidate from starting.
- [Oxy #1254](https://github.com/OxyHQ/oxy/pull/1254) unblocks the existing,
  reviewed OpenRouter recovery bootstrap. It preserves the live publisher's
  private network configuration and accepts migration 0082's exact historical
  funding-evidence marker for the original two deployments. All other fields
  and the matching immutable event remain checked. It does not rewrite history.

The OpenRouter route was already source-reviewed for internal Alia standard
application use, not API resale. Its exact deployment is
`dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01`. Kaana enforces
`zdr: true`, `data_collection: deny` and `require_parameters: true` on that
adapter. Neither a provider credential nor a Kaana signing key was added to Alia.

## Release and catalogue evidence

Alia `oxy-alia:334` (commit `6aba5b26b7ca24a8f3aa365f3836c211a6be1f6a`)
and Oxy `oxy-oxy-api:419` (commit
`675a7fc536914890b28d62feabf65863edaf20a2`) reached stable two-of-two deployments.
The serving Kaana revision remains `oxy-kaana:40`; its publisher is
`oxy-kaana-publisher:46`, both stable one-of-one. Oxy deployment run
`34707497462` completed successfully.

The dedicated executor `oxy-kaana-catalogue-bootstrap:6` ran Oxy's exact
immutable digest
`sha256:0bd01a9b3b58ac7d0e952cfc917db12a7eb819c6b3baac3570ebbac491894b70`.
It applied four reviewed OpenRouter operations with plan SHA-256
`c92582c29270a55962fe5d75158eb6ccd6481d5768c5160a39662e76c37ccedf`.
The SELECT-only readback passed and the final dry-run planned zero operations.
The inventory snapshot remained `snap_dfd6904a99d6313b`.

The dedicated bootstrap must use the same immutable image as the reviewed
live Oxy API revision. The procedure first rolls back its complete dry-run
transaction, binds apply to its exact plan SHA-256, reads back the exact profile
primary keys, then requires an empty idempotency plan. It never selects a
routing profile by slug, display name, query order or first result.

## Validation

| Local checks | Result |
| --- | --- |
| Alia API unit tests | 2,115 passed; one existing skip |
| Alia PostgreSQL tests | 1,213 passed |
| Alia app tests | 645 passed |
| Other configured Alia workspace suites | 275 passed |
| Oxy API | 6,747 passed across 454 suites |
| Kaana | Full Go race suite, vet, build and golangci-lint passed |
| Builds and types | Alia workspace typechecks and API build; Oxy API build and operational-script typecheck passed |

The Oxy workflow mutation tests exercise its actual jq network projection for
public/private networks and reject invalid values. The 35 focused catalogue,
inventory and bootstrap-plan tests passed with the normal test configuration.
The complete local Oxy run used Node 22.23.2 with `--no-opt --no-maglev` and a
temporary isolated CommonJS ts-jest transform to avoid the V8 crashes already
documented in the repository. No assertions were skipped or changed. The
original CI configuration independently passed all 6,747 tests in run
`34705508634`, split 2,091 / 2,302 / 2,354 across its three coverage shards.
The temporary local runner configuration was removed.

The regression in Kaana was first reproduced as PostgreSQL `SQLSTATE 42501`
with the actual runtime role. The corrected lifecycle test also verifies that
disabling a credential removes its deployment binding. The isolated corrected
candidate started successfully and passed the signed OpenRouter v1/v2 canary:
two bounded provider requests, six checks, zero Oxy ledger writes.

After the catalogue apply, all 11 real chat cases passed locally and all 11
passed against `https://api.alia.onl/alia/chat`: two each of Instant, Auto,
Thinking and Research, a real web-search tool call, an unknown-profile refusal
and successful recovery afterward. Each environment produced ten distinct
successful references, no synthetic errors, and the expected HTTP 400 refusal.
No conversation was persisted by these cases.

Kaana's validation-window logs also recorded 24 completed OpenRouter requests.
For example, `a8550c1e-4ad6-41ce-a487-18bb7ffc9a46` completed on the exact
OpenRouter deployment after two route switches. This verifies real fallback,
not just the presence of a catalogue row. The safe per-case results, image
identities and readback evidence are retained in the
[structured record](evidence/provider-unavailable-2026-09-12.json).

The QA identity is the Oxy user `test`
(`01a0966c-d2bd-7799-93b3-f2dda099cdeb`), created through normal signed registration.
Its Alia consent was granted and read back through OAuth for
`acting-as:offline` and `inference:invoke`. A temporary complimentary Pro
subscription permitted the advanced-mode checks without Stripe calls, revenue
or credit-balance additions. The private identity key is retained in the
operator's credential vault, not this repository.

## Separate rollout gates

The existing private service-token chat canary was also executed, and failed
before inference: production Oxy still minted an HS256 service token, while
Alia's published SDK required the configured public-key verification path.
Alia was not given Oxy's private signing secret to bypass that refusal. The
human-session chat checks exercise the real user authentication and product
route; they do not certify that service-token canary. Its signing transition
still requires coordinated Oxy/consumer/infra verification.

The new Kaana credential runtime remains behind its release gate. Its isolated
OpenRouter canary passed, but the signed Cerebras canary failed. Do not declare
that separate runtime promotion complete, or override its required provider
and key-class checks merely because the Alia chat path recovers. The serving
Kaana revision and the isolated candidate are distinct release evidence.

Optional agency-tool discovery also reported `missing_application_capability`
for `agency:coordinate` during the local run. The built-in web-search case
passed; that does not certify the separately gated agency-tool registry. No
application capability was broadened as part of provider recovery.

## Cleanup

The temporary complimentary subscription was cancelled and a fresh authenticated
read confirmed that it was no longer active. All QA sessions were revoked.
The reusable `test` identity and its consent remain; its private key stays only
in the operator's credential vault.

The local API, test databases and task-created PostgreSQL cluster were stopped
and removed. All 281 packages newly installed for validation were purged;
pre-existing packages were preserved. The intervention's sibling worktrees,
local branches, downloaded toolchains, Go cache, temporary scripts, credentials
and logs were removed after retaining the safe evidence above. Existing user
worktrees, including the unresolved Kaana work, were preserved.
