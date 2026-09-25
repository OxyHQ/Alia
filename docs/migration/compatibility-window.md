# Compatibility window and sunset criteria

**Status:** Accepted

**Date:** 2026-08-15. **Amended 2026-08-18** — path (a) has a removal date; see
*The alias removal date* below. **Amended 2026-09-10** — path (b) is no longer a
compatibility path: `api.alia.onl/v1/*` is Alia's permanent product API under
[ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md);
see section (b) below. **Amended 2026-09-23** — path (c) is **closed**: the owner
retired the `alia_sk_*` credentials outright, with no removal gate and no rollback
window; see section (c) below.

**Applies to:** epic #139, workstream 0. Referenced by ADR 0002, ADR 0003 and ADR 0004.

> **Historical compatibility decision, superseded for alias path (a).** The
> clean Kaana identity cut removed the `alia-*` resolver, deprecation middleware
> and provider runtime. Current requests using those aliases are refused as
> unregistered; `GET /v1/models` remains empty and `/catalogue` publishes the
> supported `kaana-*` product profiles. Statements below that aliases “still
> resolve” describe the bounded window before that cut and are not current
> operating behaviour. Path (b) is governed by its own section; path (c) is
> closed (see its section).

Three things were placed under a bounded window by the migration to Oxy and Kaana, because removing them the day the new path lands would break callers who have not been given a way to move:

- **(a)** the `alia-*` model aliases;
- **(b)** the `api.alia.onl/v1/*` HTTP surface — **withdrawn from the window on 2026-09-10**: it is Alia's permanent product API (ADR 0010), and section (b) below is the record of that rather than a gate;
- **(c)** the `alia_sk_*` developer credentials — **closed on 2026-09-23** by the owner's clean cut: the API refuses them and their tables are dropped.

This document defined, for (a) and (c): what still works, what deprecation signal is emitted, what measurable gate must be satisfied before removal, and who owns the clock.

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
- ~~`cost_entries.alias_model_id`~~ — the column went in 0063 and the table in 0070.
- `api_key_usage` — `packages/api/src/db/schema/telemetry.ts:257`. Records `endpoint`, `method`, `status_code`, `auth_type` (one of `api_key`, `session`, `internal` — `packages/api/src/domain/api-key-usage.ts:11`), `api_key_id` and `app_id` per request.
- ~~`developer_api_keys.last_used_at`~~ — the table was dropped by migration 0070 (path (c) closed).

### Retention, which bounds every window

`api_key_usage` is swept at 90 days from `timestamp` (`packages/api/src/db/expiryTargets.ts:107`). Any measurement window over it must be shorter than 90 days, or the zero is partly a sweep artefact.

`chat_analytics` appears in no entry of `packages/api/src/db/expiryTargets.ts`, so no sweep deletes them today and their windows are not bounded by retention. That is a property of the current registry, not a guarantee: re-check the registry when taking a measurement rather than trusting this sentence.

## Deprecation signal

Every compatibility path emits the same two signals while it is inside the window.

**HTTP response headers.** `Deprecation` per RFC 9745 and `Sunset` per RFC 8594, on every response served by a deprecated path, accompanied by a `Link` header carrying the `deprecation` relation and pointing at the migration documentation. RFC 9745 specifies `Deprecation` as a structured-field Date and RFC 8594 specifies `Sunset` as an HTTP-date; the RFCs are authoritative for the exact serialization, and the implementation follows them rather than this paragraph.

A `Sunset` value is emitted only once a removal date has been set. A removal date is set when the gate is satisfied or is credibly close, never as a placeholder — an announced date that then moves teaches callers to ignore the header, which destroys the signal for every future deprecation.

A third case turned out to exist and is now written down, because path (a) hit it: **a gate that nobody can satisfy**. This document already says what to do — "a gate that cannot be satisfied is escalated on #139 and re-decided; it is not left open by default" — and re-deciding it is not the same act as setting a placeholder. A placeholder is a date nobody chose; what path (a) has is a date somebody chose, with their name on it. The prohibition stands for every path whose gate is merely *unsatisfied*, which is both of the others.

**A product stream event.** `alia.deprecation`, following the existing `alia.*` SSE convention with `eventVersion: 1`, carrying the deprecated identifier, its replacement, and the sunset date where one is set. Naming it was a decision taken by this document; it is implemented for path (a), as recorded below.

**Status of each signal.** Neither path (a) nor path (c) emits anything, because both were closed by removal — (a) on 2026-09-03, (c) on 2026-09-23.

**Path (a) was closed by removal, not by a window.** #477 (`697c3f9`, 2026-09-03) deleted the thirteen `alia-*` aliases outright, and with them `packages/api/src/middleware/alias-deprecation.ts`, `ALIAS_SUNSET`, the `alia.deprecation` stream event and `alias-migration-map.json` — none is in the tree. A request naming one is refused by `packages/api/src/lib/chat/request-context.ts` before any credit is reserved: HTTP `400` with `{ type: "invalid_request_error", code: "unknown_routing_profile", param: "model" }` and the message `"<id>" is not a routing profile. List them at GET /catalogue.` — the `unknown-profile` branch of `resolveRequestedModel` in `lib/routing/model-selection.ts`, which admits `mode:*` and `route:*` only. The two paragraphs that stood here describing live headers and a live stream event are withdrawn.

Path (c) had headers from workstream 11 (`credential-deprecation.ts`, mounted app-wide, with `Sunset` withheld). The module was deleted with the credentials on 2026-09-23; a request presenting an `alia_sk_*` key is now refused `401 credential_retired`.

**Path (b) emits nothing, and since ADR 0010 that is correct rather than pending: the surface is not deprecated.**

### The alias removal date

**Path (a) was removed on 2026-09-03 (#477), ahead of its announced `2026-10-01` sunset. Path (c) was removed on 2026-09-23, without a date ever being announced. Path (b) will never have one.**

| | decided by | on | recorded in |
| --- | --- | --- | --- |
| **(a)** the thirteen `alia-*` aliases | **removed** in #477 (`697c3f9`), overtaking D1's date | 2026-09-03 | `packages/api/src/lib/chat/request-context.ts` refuses them with `400 unknown_routing_profile`; [`epic-139-decisions.md`](./epic-139-decisions.md) D1 and D2, both marked overtaken |
| **(b)** `api.alia.onl/v1/*` | the repository owner: **permanent, not deprecated** | 2026-09-10 | [ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md); no signal is emitted and none will be |
| **(c)** `alia_sk_*` credentials | the repository owner: **removed**, clean cut, no rollback window | 2026-09-23 | `packages/api/src/middleware/auth.ts` refuses the prefix `401 credential_retired`; migration `0070_clean_cut_dormant_tables` drops `developer_apps` and `developer_api_keys`; see section (c) |

**The `2026-10-01` date is history.** The three paragraphs that stood here — why a date was set for an unsatisfiable gate, why it was not the instant of the decision, and what the date did not mean — were overtaken when #477 removed the aliases four weeks before it; the alarm test they named (`middleware/__tests__/alias-deprecation.test.ts`) went with the module. The reasoning stays on record in [`epic-139-decisions.md`](./epic-139-decisions.md) D1, marked overtaken.

---

## (a) The `alia-*` model aliases

**REMOVED — 2026-09-03, #477 (`697c3f9`).** Nothing below this line is live. The thirteen identifiers, their resolver, the deprecation headers, the stream event and the migration map were all deleted in the cutover to `Alia -> Oxy -> Kaana`; a request naming one gets `400 unknown_routing_profile` from `lib/chat/request-context.ts` (see *Status of each signal*). The removal gate below was never satisfied and was not what closed the path — the cutover was. The section is kept as the record of the window as it stood on 2026-08-18.

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

The routes mounted at `packages/api/src/index.ts:249` — `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/audio` and `/v1/images` (`packages/api/src/routes/v1.ts`), thirteen routes frozen by name in `packages/api/src/routes/__tests__/v1-compatibility-surface.test.ts`. (`/v1/voice/token` and `/v1/voice/transcribe` refused every call from #477 on and were removed when voice moved onto the device; see [Voice](../voice.mdx).)

**Until 2026-09-10 this section carried a removal gate.** ADR 0004 §3 had decided the surface *"remains as a bounded compatibility surface that authenticates through Oxy, does not reintroduce Alia-owned API keys, does not reintroduce provider billing in Alia, and then sunsets"*, and this section specified a per-route gate over `api_key_usage`, a `Deprecation`/`Sunset`/`Link` signal, an `alia.deprecation` stream event, and a clock owned by workstream 6. None of the signal was ever built — *"Path (b) emits nothing"* above was true throughout — and the gate was never measured. ADR 0006 recorded that four derived notes said the opposite.

**The repository owner resolved it on 2026-09-10** — [ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md): `api.alia.onl/v1/*`, and `/alia/chat` with it, is **Alia's permanent product API**, called by Alia's own surfaces (the app, Codea, Cowork and the CLI, on `/alia/chat`), by other applications in the Oxy ecosystem and by third parties through `@alia.onl/sdk` — all authorized by Oxy. It is not generic inference under another name; generic inference is Kaana, through Oxy, at `api.oxy.so/v1`. What holds now:

- **No signal, no gate, no clock.** Nothing in this document deprecates a `/v1` route, and nothing will. The gate text above is withdrawn, not merely unsatisfied; `410 Gone` remains the shape of a route that is *deliberately* removed by a later product decision (`POST /v1/resolve-model` and `POST /v1/report-usage` already answer that way, `packages/api/src/routes/v1.ts`), but no route is scheduled for it.
- **ADR 0004's other three conditions are permanent properties.** The surface authenticates through Oxy, issues no `alia_sk_*` (and, since path (c) closed, accepts none), and settles no provider billing in Alia (ADR 0005).
- **The route list stays frozen.** Adding a route to `/v1` is a deliberate edit of the list in `v1-compatibility-surface.test.ts`, not a consequence of permanence; ADR 0010 does not decide where new product routes are mounted.
- **Credentials for it come from Oxy Console.** ADR 0010 § 2 stated which credentials Alia accepted then — Oxy user session and service tokens, and existing `alia_sk_*` keys, deprecated; the keys are now refused (section (c)) — and that an Oxy Console application key (`oxy_sk_*`) is **not yet accepted** by `packages/api/src/middleware/auth.ts` or by `@oxy.so/core` 1.0.1. That path is built in Oxy first (OxyHQ/oxy#972), then in `@oxy.so/core/server`, then adopted here.

**`/v1/shows` left this surface in #327**, before the resolution, and the record stands as a fact about the routes rather than about the window: all five rows in `docs/migration/inventories/product-api.json` carry `"proposedOwner": "alia"` and `"targetPath": "keep-alia-product"`, they are mounted at `/shows` beside `/conversations`, `/skills`, `/agents` and `/library`, and `packages/app/src/features/shows/runtime/show-store.ts` — the only consumer — was rewritten against the new mount in the same change. Twenty routes became fifteen, which `v1-compatibility-surface.test.ts` freezes.

### `@alia.onl/sdk` on this surface — the answer to #244

`@alia.onl/sdk` (`packages/alia-chat`) is a **product** client — `useAliaChat` switches on `alia.reasoning`, `alia.tool_result`, `alia.research_progress` and `alia.plan_preview` — and it still defaults to `POST /v1/chat/completions`, so its consumers sit on this surface rather than on the product route. The reason is a CORS difference between two mounts of one handler, measured on production on 2026-08-19 and pinned by `packages/api/src/middleware/__tests__/chat-origin-policy.test.ts`: `/alia/chat` answers a preflight only for the exact origins in `packages/api/src/lib/cors-origins.ts` (plus `WEB_URL`), while `/v1` answers `*` (`packages/api/src/index.ts`, the `cors({ origin: '*' })` mount and the `/v1` bypass in front of `createInternalCors`). The SDK ships raw source, so it compiles into consumer apps on origins Alia does not enumerate; pointing it at `/alia/chat` would fail every consumer's web preflight. Widening the allowlist is not the repair — the narrow policy is one of the recorded differences that makes `/alia/chat` a product surface rather than a second generic one.

[#244](https://github.com/OxyHQ/Alia/issues/244) lays out three shapes, and this document records where each stands:

- **(a) A CORS policy on `/alia/chat` for registered consumer origins — not Alia's to build.** It needs an origin registry, and the only per-consumer registry Alia ever had, `developer_apps`, was dropped when (c) closed. The registry that carries consumer origins is the application's record in Oxy Console, so this shape is blocked on `OxyHQ/oxy#972`. ADR 0010 § 3 fixes what happens when it lands: the per-application origin list replaces the `/v1` wildcard on both mounts, by changing `chat-origin-policy.test.ts` on purpose and never by widening `lib/cors-origins.ts`.
- **(b) The SDK default moves to `/alia/chat` in a semver-major — an adoption window, not a switch.** A raw-source package changes endpoint only for consumers who upgrade **and** rebuild, exactly as recorded for the aliases under (a) above. `/v1/chat/completions` keeps serving installed copies afterwards — permanently, under ADR 0010 — so this shape is no longer needed to escape a sunset and is taken only if the per-application origin policy makes it worthwhile.
- **(c) The consumer-backend path — supported today, no registry, nothing from Oxy.** `useAliaChat({ apiUrl })` points the SDK at the consumer's own backend; that backend calls `POST /alia/chat` server-to-server, where there is no `Origin` header and the route answers on its credential alone, forwards the user's Oxy session token the SDK already attached, and streams the SSE body back unchanged. **Its cost is an extra hop** — one more process in the path of every stream — which some consumers will not accept, so it is documented as the path that works rather than chosen as the only one. `packages/alia-chat/README.md` carries the relay.

**The contradiction this sat on is resolved.** Until 2026-09-10 this section said the surface was bounded and sunsets, per ADR 0004, while `docs/migration/ownership.md` § *Product API* and `ownership-matrix.json#v1-chat-completions-post.removalGate` said all of `/v1` was permanent, and ADR 0006 held both without deciding. ADR 0010 decides for permanence: the notes were right, ADR 0004 §3 is amended, and #244 reads as the cosmetic case — the SDK's consumers are on a permanent surface, and what they wait on is oxy#972's origin registry, not a reprieve.

---

## (c) `alia_sk_*` developer credentials — closed

**Closed on 2026-09-23 by the repository owner: a clean cut, with no removal gate and no rollback window, accepting that anyone still presenting a key stops working.**

What that removed, all in one change:

- **Acceptance.** `authenticateTokenOrApiKey` (`packages/api/src/middleware/auth.ts`) refuses any `alia_sk_` bearer with `401` and `"error": "credential_retired"`, before the Oxy SDK sees it. `authenticateApiKey`, `requireScope`, `req.apiKey` and the per-key rate limiter are gone; the MCP relay has no key lane.
- **The routes.** Every `/developer/*` route, every `/codea/*` route, and the `POST /auth/authorize/codea`, `POST /auth/authorize/cowork` and `POST /auth/token` refusals — deleted, not refused, so they answer `404`.
- **The signal.** `credential-deprecation.ts`, `http-deprecation.ts` and `CREDENTIAL_SUNSET`.
- **The data.** Migration `0070_clean_cut_dormant_tables` drops `developer_apps` and `developer_api_keys`. `api_key_usage` keeps its historical `auth_type = 'api_key'` rows with their key and app ids; it records only session and internal traffic from now on.
- **The clients.** The `packages/alia-console` developer portal is deleted; the Codea extension lost its "Enter API key" sign-in and `codea.apiKey` setting. The CLI and Cowork already signed in with Oxy.

The gate this section used to carry — notify every owner, measure zero `auth_type = 'api_key'` traffic, account for every active row — was **waived by that decision, not satisfied**. That is recorded here so nobody reads the closure as a measurement.

What replaces the credential is unchanged: an application credential issued in Oxy Console, once Oxy (OxyHQ/oxy#972) and `@oxy.so/core/server` provide the lane — ADR 0010 § 2. Until then a third party calls Alia's API with the signed-in user's Oxy session.

---

## Review cadence

Each clock owner reports on #139 at the close of each monthly billing cycle for the path they own: the measurement taken, its date, its positive control, and whether the gate is satisfied. Three consecutive reports with no movement toward the gate escalate to a decision on the epic — extend with a stated reason, or remove with a stated risk. Silence is not an extension.

## Open questions

- **Named individual owners.** This document assigns each clock to a workstream owner. The individual assignees are not recorded on #139 yet — except path (a)'s removal date, which the product owner decided directly on 2026-08-18. *Owner: the #139 epic owner.*
- ~~**Whether `Deprecation` and `Sunset` are emitted per-route or per-surface for (b).**~~ Moot since 2026-09-10: (b) is not deprecated (ADR 0010).
- ~~**The notification channel for (c).**~~ Moot since 2026-09-23: (c) was closed without a notification round, by the owner's decision.
- ~~**Whether (b) is permanent or sunsets.**~~ **Decided 2026-09-10 by the repository owner: permanent.** [ADR 0010](../adr/0010-alia-keeps-a-product-api-credentials-come-from-oxy-console.md) amends ADR 0004 §3 and supersedes ADR 0006; #244 closes on it, with the SDK's per-application origin policy waiting on `OxyHQ/oxy#972`.
