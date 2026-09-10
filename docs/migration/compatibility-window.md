# Compatibility window and sunset criteria

**Status:** Accepted

**Date:** 2026-08-15. **Amended 2026-08-18** — path (a) has a removal date; see
*The alias removal date* below. **Amended 2026-09-10** — path (b) is no longer a
compatibility path: `api.alia.onl/v1/*` is Alia's permanent product API under
[ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md);
see section (b) below.

**Applies to:** epic #139, workstream 0. Referenced by ADR 0002, ADR 0003 and ADR 0004.

> **Historical compatibility decision, superseded for alias path (a).** The
> clean Kaana identity cut removed the `alia-*` resolver, deprecation middleware
> and provider runtime. Current requests using those aliases are refused as
> unregistered; `GET /v1/models` remains empty and `/catalogue` publishes the
> supported `kaana-*` product profiles. Statements below that aliases “still
> resolve” describe the bounded window before that cut and are not current
> operating behaviour. Paths (b) and (c) remain governed by their own sections.

Three things were placed under a bounded window by the migration to Oxy and Kaana, because removing them the day the new path lands would break callers who have not been given a way to move:

- **(a)** the `alia-*` model aliases;
- **(b)** the `api.alia.onl/v1/*` HTTP surface — **withdrawn from the window on 2026-09-10**: it is Alia's permanent product API (ADR 0010), and section (b) below is the record of that rather than a gate;
- **(c)** the `alia_sk_*` developer credentials.

This document defines, for (a) and (c): what still works, what deprecation signal is emitted, what measurable gate must be satisfied before removal, and who owns the clock.

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

**Path (b) emits nothing, and since ADR 0010 that is correct rather than pending: the surface is not deprecated.** **Path (c) has no stream event.** Emitting one is a prerequisite for starting that clock, not an optional extra — a window that runs without a signal is a window that surprises its callers at the end.

### The alias removal date

**Path (a) has a removal date: `2026-10-01T00:00:00Z`. Path (c) has none. Path (b) will never have one.**

| | decided by | on | recorded in |
| --- | --- | --- | --- |
| **(a)** the thirteen `alia-*` aliases | the product owner of Alia | 2026-08-18 | `ALIAS_SUNSET` (`packages/api/src/middleware/alias-deprecation.ts`), `alias-migration-map.json` `sunsetAt`, [`epic-139-decisions.md`](./epic-139-decisions.md) D1 |
| **(b)** `api.alia.onl/v1/*` | the repository owner: **permanent, not deprecated** | 2026-09-10 | [ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md); no signal is emitted and none will be |
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

**That proves nobody is served TODAY. It does not prove nobody uses these identifiers.** Two published npm packages hardcode them — `@alia.onl/sdk` (which ships raw source, so every consumer compiles `src/` directly and sends `model: 'route:auto'` or `'route:voice'`) and `@alia-codea/cli` (`route:code`), plus the VS Code extension's own default. Editing this repository cannot migrate an installed copy, and those copies resume sending aliases the moment the service scales up. Stored per-conversation selections are not measurable from here at all, and the two usage instruments named above were unreachable with the database down. **Anyone reading "production was 503" as "there were no users" is reading it wrong.**

De-advertising needs none of that evidence, which is why it could happen now: it breaks no caller. Removal needs all of it.

**Deprecation signal.** `Deprecation` and `Sunset` headers on responses to requests naming a deprecated alias, plus `alia.deprecation` on the stream, carrying the alias and its mapped replacement. **All three are delivered** — see *Status of each signal* above for where each is emitted. `Sunset` and the event's `sunsetAt` both carry `2026-10-01T00:00:00Z` as of the 2026-08-18 amendment, from one constant, so the header and the stream cannot tell a caller different things.

**Removal gate — unchanged, and still not satisfied.** Setting a date did not satisfy it and does not replace it; the date is the deadline the removal decision now has, and this is still the evidence that removal itself requires. Per alias, both of:

1. A measurement over `chat_analytics.alia_model_id` and `cost_entries.alias_model_id` showing zero requests naming that alias across a window covering at least one full monthly billing cycle, with a positive control on a still-live identifier over the same window; **or** an enumeration showing every known consumer of that alias — app, Codea, Cowork, CLI, SDK, triggers, agents, bots and stored per-conversation model selections — has been migrated to its replacement.
2. The migration map entry for that alias exists and is published. It does, for all thirteen: [`alias-migration-map.json`](./alias-migration-map.json), which records what each alias becomes under ADR 0003 — every one of them a routing profile, none a concrete model reference — with the fan-out measurement behind the classification. The counts in it are recomputed from the live routing table by `packages/api/src/__tests__/aliasMigrationMap.test.ts`, so the map cannot drift away from the routing it describes.

Stored selections deserve their own attention: a per-conversation or per-agent model choice persisted months ago is a consumer that generates no traffic until the conversation is resumed, so a traffic measurement alone can report zero for an alias that is still referenced in stored rows. Enumerate the stored references as well as the traffic.

**Who owns the clock.** The owner of workstream 4 of #139 (model semantics), recorded on the epic.

---

## (b) `api.alia.onl/v1/*` — resolved: permanent, not a compatibility path

The routes mounted at `packages/api/src/index.ts:249` — `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/voice`, `/v1/audio` and `/v1/images` (`packages/api/src/routes/v1.ts`), fifteen routes frozen by name in `packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts`.

**Until 2026-09-10 this section carried a removal gate.** ADR 0004 §3 had decided the surface *"remains as a bounded compatibility surface that authenticates through Oxy, does not reintroduce Alia-owned API keys, does not reintroduce provider billing in Alia, and then sunsets"*, and this section specified a per-route gate over `api_key_usage`, a `Deprecation`/`Sunset`/`Link` signal, an `alia.deprecation` stream event, and a clock owned by workstream 6. None of the signal was ever built — *"Path (b) emits nothing"* above was true throughout — and the gate was never measured. ADR 0006 recorded that four derived notes said the opposite.

**The repository owner resolved it on 2026-09-10** — [ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md): `api.alia.onl/v1/*`, and `/alia/chat` with it, is **Alia's permanent product API**, called by Alia's own surfaces (the app, Codea, Cowork and the CLI, on `/alia/chat`), by other applications in the Oxy ecosystem and by third parties through `@alia.onl/sdk` — all authorized by Oxy. It is not generic inference under another name; generic inference is Kaana, through Oxy, at `api.oxy.so/v1`. What holds now:

- **No signal, no gate, no clock.** Nothing in this document deprecates a `/v1` route, and nothing will. The gate text above is withdrawn, not merely unsatisfied; `410 Gone` remains the shape of a route that is *deliberately* removed by a later product decision (`POST /v1/resolve-model` and `POST /v1/report-usage` already answer that way, `packages/api/src/routes/v1.ts`), but no route is scheduled for it.
- **ADR 0004's other three conditions are permanent properties.** The surface authenticates through Oxy, issues no new `alia_sk_*` (path (c) below is unchanged and still sunsets), and settles no provider billing in Alia (ADR 0005).
- **The route list stays frozen.** Adding a route to `/v1` is a deliberate edit of the list in `v1-compatibility-surface.test.ts`, not a consequence of permanence; ADR 0010 does not decide where new product routes are mounted.
- **Credentials for it come from Oxy Console.** ADR 0010 § 2 states precisely which credentials Alia accepts today — Oxy user session and service tokens, and existing `alia_sk_*` keys, deprecated — and that an Oxy Console application key (`oxy_sk_*`) is **not yet accepted** by `packages/api/src/middleware/auth.ts` or by `@oxy.so/core` 1.0.1. That path is built in Oxy first (OxyHQ/oxy#972), then in `@oxy.so/core/server`, then adopted here.

**`/v1/shows` left this surface in #327**, before the resolution, and the record stands as a fact about the routes rather than about the window: all five rows in `docs/migration/inventories/product-api.json` carry `"proposedOwner": "alia"` and `"targetPath": "keep-alia-product"`, they are mounted at `/shows` beside `/conversations`, `/skills`, `/agents` and `/library`, and `packages/app/lib/stores/show-store.ts` — the only consumer — was rewritten against the new mount in the same change. Twenty routes became fifteen, which `v1-compatibility-surface.test.ts` freezes.

### `@alia.onl/sdk` on this surface — the answer to #244

`@alia.onl/sdk` (`packages/alia-chat`) is a **product** client — `useAliaChat` switches on `alia.reasoning`, `alia.tool_result`, `alia.research_progress` and `alia.plan_preview` — and it still defaults to `POST /v1/chat/completions`, so its consumers sit on this surface rather than on the product route. The reason is a CORS difference between two mounts of one handler, measured on production on 2026-08-19 and pinned by `packages/api/src/middleware/__tests__/chat-origin-policy.test.ts`: `/alia/chat` answers a preflight only for the exact origins in `packages/api/src/lib/cors-origins.ts` (plus `WEB_URL`), while `/v1` answers `*` (`packages/api/src/index.ts`, the `cors({ origin: '*' })` mount and the `/v1` bypass in front of `createInternalCors`). The SDK ships raw source, so it compiles into consumer apps on origins Alia does not enumerate; pointing it at `/alia/chat` would fail every consumer's web preflight. Widening the allowlist is not the repair — the narrow policy is one of the recorded differences that makes `/alia/chat` a product surface rather than a second generic one.

[#244](https://github.com/OxyHQ/Alia/issues/244) lays out three shapes, and this document records where each stands:

- **(a) A CORS policy on `/alia/chat` for registered consumer origins — not Alia's to build.** It needs an origin registry, and the only per-consumer registry Alia ever had, `developer_apps`, is closed under (c) below. The registry that carries consumer origins is the application's record in Oxy Console, so this shape is blocked on `OxyHQ/oxy#972`. ADR 0010 § 3 fixes what happens when it lands: the per-application origin list replaces the `/v1` wildcard on both mounts, by changing `chat-origin-policy.test.ts` on purpose and never by widening `lib/cors-origins.ts`.
- **(b) The SDK default moves to `/alia/chat` in a semver-major — an adoption window, not a switch.** A raw-source package changes endpoint only for consumers who upgrade **and** rebuild, exactly as recorded for the aliases under (a) above. `/v1/chat/completions` keeps serving installed copies afterwards — permanently, under ADR 0010 — so this shape is no longer needed to escape a sunset and is taken only if the per-application origin policy makes it worthwhile.
- **(c) The consumer-backend path — supported today, no registry, nothing from Oxy.** `useAliaChat({ apiUrl })` points the SDK at the consumer's own backend; that backend calls `POST /alia/chat` server-to-server, where there is no `Origin` header and the route answers on its credential alone, forwards the user's Oxy session token the SDK already attached, and streams the SSE body back unchanged. **Its cost is an extra hop** — one more process in the path of every stream — which some consumers will not accept, so it is documented as the path that works rather than chosen as the only one. `packages/alia-chat/README.md` carries the relay.

**The contradiction this sat on is resolved.** Until 2026-09-10 this section said the surface was bounded and sunsets, per ADR 0004, while `docs/migration/ownership.md` § *Product API* and `ownership-matrix.json#v1-chat-completions-post.removalGate` said all of `/v1` was permanent, and ADR 0006 held both without deciding. ADR 0010 decides for permanence: the notes were right, ADR 0004 §3 is amended, and #244 reads as the cosmetic case — the SDK's consumers are on a permanent surface, and what they wait on is oxy#972's origin registry, not a reprieve.

---

## (c) `alia_sk_*` developer credentials

Alia-issued API keys, prefix at `packages/api/src/lib/api-key-crypto.ts:21`, stored in `developer_api_keys` (`packages/api/src/db/schema/developers.ts:80`) under `developer_apps` (`:37`), managed through `packages/api/src/routes/developer.ts`. Under ADR 0001 and ADR 0004, developer identity and credentials belong to Oxy.

**What still works during the window.** Existing active keys continue to authenticate against Alia's product API — the `/v1/*` routes of section (b), permanent since ADR 0010 — with their existing scopes and rate limits. Owners can list, inspect, rename, re-scope, re-limit and revoke their existing keys, because taking away revocation during a migration would be a security regression.

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
- ~~**Whether `Deprecation` and `Sunset` are emitted per-route or per-surface for (b).**~~ Moot since 2026-09-10: (b) is not deprecated (ADR 0010).
- **The notification channel for (c).** Whether key-owner notification goes through Alia notifications, Oxy account email, or both. *Owner: workstream 11 owner.*
- ~~**Whether (b) is permanent or sunsets.**~~ **Decided 2026-09-10 by the repository owner: permanent.** [ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md) amends ADR 0004 §3 and supersedes ADR 0006; #244 closes on it, with the SDK's per-application origin policy waiting on `OxyHQ/oxy#972`.
