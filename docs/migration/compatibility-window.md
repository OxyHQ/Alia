# Compatibility window and sunset criteria

**Status:** Accepted

**Date:** 2026-08-15. **Amended 2026-08-18** — path (a) has a removal date; see
*The alias removal date* below.

**Applies to:** epic #139, workstream 0. Referenced by ADR 0002, ADR 0003 and ADR 0004.

Three things survive the migration to Oxy and Kaana for a bounded period, because removing them the day the new path lands would break callers who have not been given a way to move:

- **(a)** the `alia-*` model aliases;
- **(b)** the `api.alia.onl/v1/*` HTTP surface;
- **(c)** the `alia_sk_*` developer credentials.

This document defines, for each: what still works, what deprecation signal is emitted, what measurable gate must be satisfied before removal, and who owns the clock.

## Two binding rules

**No compatibility path is deleted until its usage has been measured.** Not estimated, not reasoned about, not inferred from the absence of complaints. A measurement is a query against a named instrument over a named window, with a positive control proving the instrument could have seen usage if usage existed. A zero from a broken query, an unswept table nobody writes to any more, or a window that starts after the traffic stopped all look identical to a real zero, and only the control distinguishes them.

**The window is bounded.** The old abstraction is not preserved indefinitely. Each path below has a removal gate, an owner, and a review cadence. A gate that cannot be satisfied is escalated on #139 and re-decided; it is not left open by default. Preserving a compatibility path forever is the failure mode this document exists to prevent, and it is reached by never deciding rather than by deciding wrongly.

Those two rules pull against each other on purpose. The first prevents removal on a guess; the second prevents indefinite postponement. Neither is satisfied by elapsed time: **a date passing is not a gate.**

That rule is unchanged by the removal date set for path (a) on 2026-08-18, and it is the reason that date was set by a **decision** rather than by a clock. When 2026-10-01 arrives, nothing is removed by the arrival itself; what happens is that `packages/api/src/middleware/__tests__/alias-deprecation.test.ts` goes red and the choice comes back to #139. A date passing is not a gate — it is an alarm.

## What counts as a measurement

A measurement names four things:

1. **The instrument** — the table and columns queried, cited by path and line.
2. **The window** — a start and end time, strictly shorter than the instrument's retention where a sweep exists, because a zero from a swept table is indistinguishable from a zero from no traffic.
3. **The positive control** — the same query, over the same window, against something known to be in use. If the control returns zero, the measurement is blind and its zero means nothing.
4. **The result and its date** — recorded on #139. An absence claim expires on its own; "no usage in the last 30 days" was true when taken and may be false an hour later, so the measurement is stamped and re-taken before removal lands.

### Instruments available today

- `chat_analytics.alia_model_id` — `packages/api/src/db/schema/usage.ts:113`. Records the Alia alias resolved for each completion, alongside `platform` (`:119`) which distinguishes surfaces.
- `cost_entries.alias_model_id` — `packages/api/src/db/schema/usage.ts:50`. Per-request record carrying the alias.
- `api_key_usage` — `packages/api/src/db/schema/telemetry.ts:257`. Records `endpoint`, `method`, `status_code`, `auth_type` (one of `api_key`, `session`, `internal` — `packages/api/src/domain/api-key-usage.ts:11`), `api_key_id` and `app_id` per request.
- `developer_api_keys.last_used_at` — `packages/api/src/db/schema/developers.ts:98`, alongside `is_active`.

### Retention, which bounds every window

`api_key_usage` is swept at 90 days from `timestamp` (`packages/api/src/db/expiryTargets.ts:107`). Any measurement window over it must be shorter than 90 days, or the zero is partly a sweep artefact.

`chat_analytics` and `cost_entries` appear in no entry of `packages/api/src/db/expiryTargets.ts`, so no sweep deletes them today and their windows are not bounded by retention. That is a property of the current registry, not a guarantee: re-check the registry when taking a measurement rather than trusting this sentence.

## Deprecation signal

Every compatibility path emits the same two signals while it is inside the window.

**HTTP response headers.** `Deprecation` per RFC 9745 and `Sunset` per RFC 8594, on every response served by a deprecated path, accompanied by a `Link` header carrying the `deprecation` relation and pointing at the migration documentation. RFC 9745 specifies `Deprecation` as a structured-field Date and RFC 8594 specifies `Sunset` as an HTTP-date; the RFCs are authoritative for the exact serialization, and the implementation follows them rather than this paragraph.

A `Sunset` value is emitted only once a removal date has been set. A removal date is set when the gate is satisfied or is credibly close, never as a placeholder — an announced date that then moves teaches callers to ignore the header, which destroys the signal for every future deprecation.

A third case turned out to exist and is now written down, because path (a) hit it: **a gate that nobody can satisfy**. This document already says what to do — "a gate that cannot be satisfied is escalated on #139 and re-decided; it is not left open by default" — and re-deciding it is not the same act as setting a placeholder. A placeholder is a date nobody chose; what path (a) has is a date somebody chose, with their name on it. The prohibition stands for every path whose gate is merely *unsatisfied*, which is both of the others.

**A product stream event.** `alia.deprecation`, following the existing `alia.*` SSE convention with `eventVersion: 1`, carrying the deprecated identifier, its replacement, and the sunset date where one is set. Naming it was a decision taken by this document; it is implemented for path (a), as recorded below.

**Status of each signal.** Path (a) emits both, as of workstream 4.

The headers exist for path (a) as of workstream 4: `packages/api/src/middleware/alias-deprecation.ts`, mounted app-wide in `src/index.ts` and set on any response to a request naming one of the thirteen aliases. **`Sunset` now carries a value** — `ALIAS_SUNSET`, `Thu, 01 Oct 2026 00:00:00 GMT` — as of the amendment of 2026-08-18. Its scope is the ALIAS rather than the URI that returned it, which RFC 8594 §3 permits provided the resource documents the wider scope; this sentence is that documentation.

The stream event exists for path (a) as of workstream 4 as well: built by `aliasDeprecationEvent` in that same module and written at `packages/api/src/routes/v1/chat-completions.ts:97`, ahead of every other frame on a streaming request, so the deep-research branch carries it too. Its `replacement` is read from `getRoutingPreset` — the preset table `lib/routing/__tests__/routing-policy.test.ts` asserts equal to [`alias-migration-map.json`](./alias-migration-map.json) — rather than copied here, so a routing change moves it instead of leaving a stale instruction. A non-streaming caller has no stream to carry an event and is served by the headers, which every response gets either way.

The headers exist for path (c) as of workstream 11: `packages/api/src/middleware/credential-deprecation.ts`, mounted app-wide beside the alias signal, emitted on any response to a request that PRESENTS an `alia_sk_*` credential, and emitted again by `refuseIssuance` on every closed creation path. Presentation rather than successful authentication, because the middleware runs ahead of auth and a caller whose key has lapsed is exactly the caller who needs the notice. **`Sunset` is implemented and still withheld**, and since 2026-08-18 that is a disagreement with path (a) rather than agreement with it — deliberately, for the reasons in section (c) below. Both modules serialize through the same two functions and point at the same document, so the two signals cannot disagree about the FORMAT of a date or about the link; they can and now do carry different dates, because they answer to different gates.

**Path (b) emits nothing, and path (c) has no stream event.** Emitting them is a prerequisite for starting those clocks, not an optional extra — a window that runs without a signal is a window that surprises its callers at the end.

### The alias removal date

**Path (a) has a removal date: `2026-10-01T00:00:00Z`. Paths (b) and (c) have none.**

| | decided by | on | recorded in |
| --- | --- | --- | --- |
| **(a)** the thirteen `alia-*` aliases | the product owner of Alia | 2026-08-18 | `ALIAS_SUNSET` (`packages/api/src/middleware/alias-deprecation.ts`), `alias-migration-map.json` `sunsetAt`, [`epic-139-decisions.md`](./epic-139-decisions.md) D1 |
| **(b)** `api.alia.onl/v1/*` | — | — | no signal is emitted at all, so no clock has started |
| **(c)** `alia_sk_*` credentials | — | — | `CREDENTIAL_SUNSET` is `null`; see section (c) |

**Why a date exists for (a) when its gate is not satisfied.** It is not satisfiable. The gate is a production usage measurement, and production is parked at desired count 0 with no database credential reachable from outside it; the enumeration alternative fails on two published packages this repository cannot edit. Under the rule two sections above, an unsatisfiable gate is escalated and re-decided rather than left open, and the product owner re-decided it. That is the condition this document set for a date to be a decision instead of a placeholder, and it is met.

**Why 2026-10-01 and not the instant of the decision.** "Now" is when the announcement happens — the header ships from the deploy that carries this amendment. It is not the value. RFC 8594 §3 says the timestamp "SHOULD be a timestamp in the future" and says a past one is to be read as *"the resource is expected to become unavailable at any time"*, which is false here on purpose: every alias still resolves, and a caller who read a past `Sunset` would stop retrying a path that works. The value is therefore the close of the first full calendar month after the announcement — the unit this document already uses for path (a), whose removal gate measures "at least one full monthly billing cycle" and whose review cadence reports "at the close of each monthly billing cycle" — rather than a round number invented for the occasion.

**What the date does not mean.** It does not mean the aliases stop resolving on 2026-10-01. Nothing removes them; removal is a separate breaking change with its own costs, recorded as D2. The date is the deadline that decision now has, and the alarm in `middleware/__tests__/alias-deprecation.test.ts` is what stops it from passing unremarked.

---

## (a) The `alia-*` model aliases

Thirteen identifiers, defined in `packages/api/src/internal/providers/lib/alia-models.ts` and still serialized with `object: 'model'` on `GET /v1/models`. ADR 0003 establishes that each is either a concrete model reference or a routing profile, and is not a model owned by Alia; the migration map measured all thirteen and found them all routing profiles.

`owned_by` no longer says `alia` (workstream 4): it is `undisclosed`, because the publisher is not recoverable from this repository's data and the serving provider is not an answer to "who owns this" — ADR 0003 makes the provider a property of the deployment rather than of the model. Route concealment is not the constraint here; `lib/errors/sanitize.ts` rule 2 exempts the model catalogue outright. `object` is unchanged, because it is the value external callers switch on and this section exists to keep their responses working; the truthful type split is served by `GET /catalogue` instead.

**What still works during the window.** Every existing alias continues to resolve and serve requests. Requests naming an alias are answered. `GET /v1/models` continues to list them for as long as the surface serving that listing exists. A migration map from each old alias to either a concrete model or a routing profile is published and applied, so a caller can translate mechanically rather than by guesswork.

**What does not.** No new alias is created — the set is frozen as of ADR 0002. An alias is not extended to cover a new capability, a new surface or a new tier; those get a routing profile or a concrete model reference from the start.

**CLOSED FOR ADVERTISEMENT — 2026-08-17.** The thirteen aliases are advertised by nothing. `GET /v1/models` serves an empty list, `GET /catalogue` is keyed by routing profile, the picker and the `switchModel` tool offer `profile:*` ids, and no response from any surface contains an `alia-*` identifier. They **still resolve**: `internal/providers/lib/alia-models.ts` is untouched, so a request naming one is answered exactly as before.

That distinction is the whole shape of this closure. Removal — a request naming an alias being refused — has **not** happened, because the removal gate below is not satisfied. It now has an announced date (`2026-10-01T00:00:00Z`, decided 2026-08-18, above) and still has no implementation behind it: no code refuses an alias on that date, and none is scheduled to. The date is a deadline on the decision, not a switch.

**The evidence, and what it does not prove.** `https://api.alia.onl/v1/models` and `/health` both returned HTTP 503 from the ALB when this was taken (2026-08-17): the service is parked at desired count 0, so no external caller is being served and nothing breaks at the moment of the cut.

**That proves nobody is served TODAY. It does not prove nobody uses these identifiers.** Two published npm packages hardcode them — `@alia.onl/sdk` (which ships raw source, so every consumer compiles `src/` directly and sends `model: 'kaana-v1'` or `'kaana-v1-voice'`) and `@alia-codea/cli` (`kaana-v1-codea`), plus the VS Code extension's own default. Editing this repository cannot migrate an installed copy, and those copies resume sending aliases the moment the service scales up. Stored per-conversation selections are not measurable from here at all, and the two usage instruments named above were unreachable with the database down. **Anyone reading "production was 503" as "there were no users" is reading it wrong.**

De-advertising needs none of that evidence, which is why it could happen now: it breaks no caller. Removal needs all of it.

**Deprecation signal.** `Deprecation` and `Sunset` headers on responses to requests naming a deprecated alias, plus `alia.deprecation` on the stream, carrying the alias and its mapped replacement. **All three are delivered** — see *Status of each signal* above for where each is emitted. `Sunset` and the event's `sunsetAt` both carry `2026-10-01T00:00:00Z` as of the 2026-08-18 amendment, from one constant, so the header and the stream cannot tell a caller different things.

**Removal gate — unchanged, and still not satisfied.** Setting a date did not satisfy it and does not replace it; the date is the deadline the removal decision now has, and this is still the evidence that removal itself requires. Per alias, both of:

1. A measurement over `chat_analytics.alia_model_id` and `cost_entries.alias_model_id` showing zero requests naming that alias across a window covering at least one full monthly billing cycle, with a positive control on a still-live identifier over the same window; **or** an enumeration showing every known consumer of that alias — app, Codea, Cowork, CLI, SDK, triggers, agents, bots and stored per-conversation model selections — has been migrated to its replacement.
2. The migration map entry for that alias exists and is published. It does, for all thirteen: [`alias-migration-map.json`](./alias-migration-map.json), which records what each alias becomes under ADR 0003 — every one of them a routing profile, none a concrete model reference — with the fan-out measurement behind the classification. The counts in it are recomputed from the live routing table by `packages/api/src/__tests__/aliasMigrationMap.test.ts`, so the map cannot drift away from the routing it describes.

Stored selections deserve their own attention: a per-conversation or per-agent model choice persisted months ago is a consumer that generates no traffic until the conversation is resumed, so a traffic measurement alone can report zero for an alias that is still referenced in stored rows. Enumerate the stored references as well as the traffic.

**Who owns the clock.** The owner of workstream 4 of #139 (model semantics), recorded on the epic.

---

## (b) `api.alia.onl/v1/*`

The routes mounted at `packages/api/src/index.ts` — `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/voice`, `/v1/audio` and `/v1/images` (`packages/api/src/routes/v1.ts`). ADR 0004 decides this surface remains as a bounded compatibility surface that authenticates through Oxy, does not reintroduce Alia-owned API keys, does not reintroduce provider billing in Alia, and then sunsets.

**`/v1/shows` has LEFT this window, in #327.** It was listed here with an open question against it — whether it belonged at all, given that it was `optionalAuth` and was not obviously generic inference. The workstream 1 inventory had already answered: all five rows in `docs/migration/inventories/product-api.json` carry `"proposedOwner": "alia"` and `"targetPath": "keep-alia-product"`. They are now mounted at `/shows`, beside `/conversations`, `/skills`, `/agents` and `/library`, and this surface is fifteen routes rather than twenty.

Their per-route removal gate is satisfied rather than waived. Each of the five rows records its gate as a line in `packages/app/lib/stores/show-store.ts`, and that file was rewritten against the new surface in the same change — the only consumer moved with the route. Nothing external is affected: the routes returned one account's own generated audio and could not be reached without an Oxy session. `packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts` holds the measurement and now freezes fifteen.

**What still works during the window.** Requests to these routes continue to be served, with their existing request and response shapes, for callers authenticated through Oxy. Product SSE events may still appear on this surface, because it is the old product runtime under an old name — which is a reason the window is bounded rather than a feature of it.

**What does not.** The surface gains no new capability, no new route and no new model. It is not the place a new feature ships. Generic inference development happens on `api.oxy.so/v1`.

**Deprecation signal.** `Deprecation` and `Sunset` headers on every response from every route on this surface, with a `Link` to the migration documentation, plus `alia.deprecation` on streaming responses.

**Removal gate.** Per route, both of:

1. A measurement over `api_key_usage` filtered to that `endpoint`, across a window shorter than the 90-day retention and covering at least one full monthly billing cycle, showing zero external requests — where external means `auth_type` is not `internal` and the caller is not a first-party Alia surface; with a positive control showing non-zero traffic on a route known to be live over the same window. **Or** an enumeration showing every known consumer has migrated.
2. A replacement exists and is documented: either the equivalent `api.oxy.so/v1` route is live, or the route's capability is explicitly recorded as not carried forward.

Route-by-route is deliberate. These routes have different consumers and will empty at different times, and gating the whole surface on its least-migrated route means the rest survives for no reason.

**Who owns the clock.** The owner of workstream 6 of #139 (product versus generic API split), recorded on the epic.

**On removal**, a route returns `410 Gone` with a message naming the replacement. This repository already uses that pattern for removed endpoints (`POST /v1/resolve-model` and `POST /v1/report-usage`, `packages/api/src/routes/v1.ts`); compatibility removals end the same way rather than by deleting the route and returning a bare `404`.

---

## (c) `alia_sk_*` developer credentials

Alia-issued API keys, prefix at `packages/api/src/lib/api-key-crypto.ts:21`, stored in `developer_api_keys` (`packages/api/src/db/schema/developers.ts:80`) under `developer_apps` (`:37`), managed through `packages/api/src/routes/developer.ts`. Under ADR 0001 and ADR 0004, developer identity and credentials belong to Oxy.

**What still works during the window.** Existing active keys continue to authenticate against the compatibility surface described in (b), with their existing scopes and rate limits. Owners can list, inspect, rename, re-scope, re-limit and revoke their existing keys, because taking away revocation during a migration would be a security regression.

Not *rotate*, and this document said otherwise until workstream 11 measured it: no rotation endpoint has ever existed on `/developer`, whose `PATCH` covers name, scopes, active flag and rate limits and nothing else. The only path that ever replaced a key's secret was `POST /auth/token`, which did it as a side effect of desktop re-authorization and is now closed. Rotation is not restored, because minting a replacement secret is issuance under another name; an owner who needs a new credential obtains an Oxy one.

**What does not.** No new `alia_sk_*` key is issued, and no new Alia developer application is created. Every creation path refuses with `410 Gone` and a body naming Oxy Console — `POST /developer/apps`, `POST /developer/apps/:appId/keys`, and the three `/auth` routes that were the undocumented second minting path (`/authorize/codea`, `/authorize/cowork`, `/token`).

The refusal is not the only thing holding this. `generateDeveloperApiKey`, `insertApp` and `insertApiKey` are deleted rather than left unused behind a refusing route, and `DeveloperApiKeyUpdate` cannot name `keyHash` — so a reintroduced mint has to write the cryptography again, and a reintroduced rotation fails to compile. `packages/api/src/middleware/__tests__/credential-deprecation.test.ts` censuses the tree for all three shapes.

**Deprecation signal.** `Deprecation` and `Sunset` headers on responses to requests authenticated with an `alia_sk_*` credential, plus a direct notification to each key owner — an owner who never calls the API in the window never sees a response header, so headers alone cannot be the only notice for a credential deprecation. Migration instructions accompany the notification.

**No removal date, and the alias date of 2026-08-18 is not an argument for one.** `CREDENTIAL_SUNSET` stays `null`, for three reasons that are properties of this path rather than of that decision. The two deprecations **fail differently**: an alias past its sunset still resolves, so a caller who ignored the notice keeps working, while a credential past its sunset authenticates nothing and locks that caller out. Gate 1 below opens with *every key owner has been notified*, and the **channel for that notification is still an open question** at the foot of this document — zero owners have been notified, and a deadline is not a notice. And **there is nowhere to migrate to**: no rotation path has ever existed on `/developer`, so migrating means obtaining an Oxy credential, which OxyHQ/oxy#972 has not yet issued. A date set before the replacement exists is a deadline holders cannot meet, whatever the date is.

**Removal gate.** All of:

1. Every key owner has been notified, with the notification recorded.
2. A measurement over `api_key_usage` filtered to `auth_type = 'api_key'`, across a window shorter than the 90-day retention, showing zero authenticated requests; with a positive control on `auth_type = 'session'` traffic over the same window. **Or** an enumeration showing every active key has either been revoked by its owner or mapped to an Oxy ApplicationCredential.
3. No active row remains in `developer_api_keys` that is not accounted for by (2) — checked against `is_active` and `last_used_at` (`packages/api/src/db/schema/developers.ts:98`), not against traffic alone, because an unused key is still a live credential.

A stored key hash is never handed back as a replacement secret. Migration means the owner obtains a new Oxy credential; it never means re-exposing what Alia stored.

**Who owns the clock.** The owner of workstream 11 of #139 (developer identity and credentials), recorded on the epic.

---

## Review cadence

Each clock owner reports on #139 at the close of each monthly billing cycle for the path they own: the measurement taken, its date, its positive control, and whether the gate is satisfied. Three consecutive reports with no movement toward the gate escalate to a decision on the epic — extend with a stated reason, or remove with a stated risk. Silence is not an extension.

## Open questions

- **Named individual owners.** This document assigns each clock to a workstream owner. The individual assignees are not recorded on #139 yet — except path (a)'s removal date, which the product owner decided directly on 2026-08-18. *Owner: the #139 epic owner.*
- **Whether `Deprecation` and `Sunset` are emitted per-route or per-surface for (b).** Per-route measurement is decided above; whether the headers are also per-route or blanket across `/v1/*` affects how a caller reading only headers perceives the timeline. *Owner: workstream 6 owner.*
- **The notification channel for (c).** Whether key-owner notification goes through Alia notifications, Oxy account email, or both. *Owner: workstream 11 owner.*
