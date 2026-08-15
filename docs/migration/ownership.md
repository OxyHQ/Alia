# Migration ownership: Alia / Oxy / Relay

The human half of the deliverable for [issue #139](https://github.com/OxyHQ/Alia/issues/139)
workstreams 0 and 1. The machine-readable half is
[`ownership-matrix.json`](./ownership-matrix.json) beside it: **356 rows**, one per
package, module, route, table, column, environment variable, screen, stream event,
dependency or behaviour in the epic's scope, each with an owner, a target, its
dependencies and the condition that must hold before it leaves Alia.

|                          | rows |
| ------------------------ | ---- |
| stay in **Alia**         | 195  |
| move to **Relay**        | 87   |
| **deleted**              | 57   |
| move to **Oxy**          | 17   |

|                        | rows |
| ---------------------- | ---- |
| `live`                 | 265  |
| `dead`                 | 52   |
| `unverified`           | 20   |
| `loaded-not-invoked`   | 19   |

Seven rows carry an `UNDECIDED` gate; they are listed under
[Open questions](#open-questions).

---

## Read this first

A reader who starts from the issue text will plan against a provider stack that is
dead code, an endpoint split that is the wrong way round, and provider credentials in
environment variables that do not exist. Four corrections, each established with a
positive control, and then three more found while assembling this matrix.

### 1. `internal/providers/index.ts` and its twelve admin sub-routers are NOT MOUNTED

`packages/api/src/index.ts` makes 46 `app.use(` calls; none mounts `/internal/providers`
or `/internal/gateway` (`packages/api/src/index.ts:221-257`). Nothing outside
`packages/api/src/internal/providers/` imports that module. Everything reachable only
through it is dead code, not a migration target — 21 files, listed in the matrix with
`reachable: "dead"`.

The only repo reference to the path is a Vite dev-proxy rewrite in
`packages/alia-gateway-admin/vite.config.ts:53`, and
`packages/alia-gateway-admin/src/lib/api/client.ts:6` targets `/internal/gateway`, a
path the API does not serve either. The single occurrence of the string
`internal/gateway` under `packages/api` is a diagram in
`packages/api/src/internal/README.md:24`.

### 2. The live inference path is `lib/chat-core.ts`, not the hand-written adapters

`packages/api/src/lib/chat-core.ts:104-198` constructs Vercel AI SDK clients directly
(`createOpenAI`, `createAnthropic`, `createGoogleGenerativeAI`) with keys and base URLs
resolved through `packages/api/src/lib/gateway-client.ts` in LOCAL mode, which reads
`internal/providers/lib/{model-resolver,key-manager,provider-health,fallback-engine}.ts`
and the `provider_keys` Postgres table. The extraction target for Relay is chat-core's
provider construction plus those four modules — **not** the 19 adapter files under
`internal/providers/lib/providers/`.

### 3. The product runs on `/v1/chat/completions`, not on `/alia/chat`

Measured here: 42 references to `/v1/chat/completions` outside `packages/api`, across 29
files including every shipped client. `/alia/chat` has 13 references repo-wide and **not
one is a call**: three in `packages/api/src/index.ts` (the mount, the SSE middleware and
the public endpoint directory), one banner in `packages/api/src/routes/chat.ts`, a dead
route constant at `packages/app/lib/api/routes.ts:53`, a docstring example at
`packages/app/lib/generate-api-url.ts:9`, and five documentation mentions.

So workstream 6 is not only "move generic inference to Oxy". The Alia product itself
must move OFF the compatibility endpoint onto the product runtime, which inverts the
naive reading. `/v1` is also the only surface with `origin: '*'` CORS
(`packages/api/src/index.ts:125-136`), so a route that leaves `/v1` loses wildcard CORS
and breaks every browser client the same day.

### 4. Provider credentials live in Postgres in PLAINTEXT, not in environment variables

`provider_keys.key` is a plain `text()` column (`packages/api/src/db/schema/providers.ts:315`).
Exactly one provider environment variable exists in the repo, `GROK_API_KEY`, and it is
inert twice over (see correction 7). The deploy workflow syncs ten secrets and none is a
provider key (`.github/workflows/deploy-aws.yml:66-97`). Workstream 15's "remove provider
API keys from Alia deployment environments" is therefore a DATABASE problem.

### 5. The 19 text adapters are LOADED in production; it is their `proxy()` that has no caller

This corrects correction 2 in one respect, and it matters for anyone planning a deletion.
`lib/providers/index.ts` — which imports all 22 adapter files — is reachable from a
runtime entrypoint:

```
src/index.ts → routes/v1.ts → routes/v1/voice.ts
             → internal/providers/lib/voice-session-manager.ts
             → internal/providers/lib/providers/index.ts → every adapter
```

The registry object is read at `voice-session-manager.ts:148` and `:676`, but only its
`.voice` member is ever used. Repo-wide, `.proxy(` returns **exactly one** hit —
`internal/providers/routes/providers.ts:138`, inside the unmounted router. So the text
adapters are `loaded-not-invoked`: no request reaches their code, but deleting a file
means editing a registry that a live module imports. That is not a free removal, and
"dead code" would have said it was.

### 6. There are THREE live provider surfaces, not one

| surface | entry | what it serves |
| --- | --- | --- |
| `lib/chat-core.ts` | AI SDK clients | streaming chat, agents, tools |
| `internal/providers/lib/provider-api.ts` | its own `PROVIDER_BASES` + `fetch` | images, TTS, transcription, embeddings, audio generation, show SFX, avatars, canvas |
| `internal/providers/lib/voice-session-manager.ts` + the 2 realtime adapters | provider WebSocket | realtime voice |

`callProviderAPI` has eight live call sites (`lib/memory/embeddings.ts:20`,
`lib/show/show-pipeline.ts:371`, `lib/synthesize-speech.ts:45`,
`routes/agents-avatar.ts:143`, `routes/canvas/execute.ts:260`, `routes/v1/audio.ts:249`,
`routes/v1/images.ts:69`, `routes/v1/voice.ts:311`). A plan that repoints chat-core alone
leaves two thirds of Alia's provider egress where it is.

### 7. Three things the inventories treated as live are already dead

Each measured with a positive control on the same scan.

- **`lib/cost-calculator.ts` has zero importers.** The "what Alia's routing saved you"
  feature does not ship. It is also one of only three product files that reach into
  `internal/providers` without going through `gateway-client` — so it looked like a
  migration blocker and is actually a deletion candidate.
- **`lib/chat-events.ts` has zero importers, and `AliaChatEventName` occurs exactly once
  repo-wide, at its own definition.** The declared SSE event union constrains nothing.
  "Reconcile the union before the port" reads as if it were load-bearing; it is not, and
  the port would have inherited an unenforced type describing neither emitter nor
  consumer.
- **`Provider.isEnabled` has 24 definitions and zero call sites.** Which is why
  `GROK_API_KEY` never gets read at all: its only reference is inside one of those 24.

Two more from the boot path, confirmed against the file's own comment
(`packages/api/src/index.ts:435-446`): `startBackgroundServices()` runs only from
`connectWithRetry()`'s success branch, MongoDB no longer exists, so
**`warmupGatewayClient()` and `syncZeroEval()` never run in production**.
`warmupProviders()` sits outside that gate at `:449` and does run — nine unauthenticated
outbound requests to provider hosts on every boot.

---

## What the epic assumes that is not true of this repo

| Issue text | Reality here |
| --- | --- |
| WS7: "Move, reimplement or retire the current provider stack" — an adapter list of 19 | Those adapters serve no request. The stack to extract is chat-core + `provider-api.ts` + the resolver/key/health/fallback modules + the 2 realtime voice adapters. |
| WS6: "`/alia/chat` or its successor remains responsible for Alia-specific behavior" | `/alia/chat` has no callers; the product runs on `/v1/chat/completions`. Both paths are the SAME handler (`routes/chat.ts:8`), differing only in auth and CORS. |
| WS15: "Remove provider API keys from Alia deployment environments" | There are none. They are rows in `provider_keys`, in plaintext. |
| WS10: "Stop writing new rows to `model_configs`, `alia_models`, provider mappings and provider keys" | Nothing writes them today: the admin router is unmounted and `runStartupSeed()` has zero callers. The routing catalogue is CODE (`generate-model-mappings.ts`); the tables mirror it and are read for one flag (`alia_models.isLegacy`). |
| WS9: "Remove any screen that exposes plaintext provider secrets" | Every gateway-admin screen already fails: its whole API surface is unmounted. The screens are dead UI, so the epic is not removing a working admin — it is deciding where a capability that currently has NO home should live. |
| WS9: "`packages/alia-gateway-admin/**` administers the current Alia-specific gateway" | The gateway service was deleted in `bfb2bc18`. The admin outlived it. |
| WS8: "Delete `GATEWAY_API_ENABLED` dual-mode behavior" | Accurate, with a nuance: it is not an environment variable but a derived constant, `!!(SERVICE_SECRET && GATEWAY_API_URL)` (`lib/gateway-client.ts:32`), guarding seven `if` branches. |
| "Alia owns plans, credits, subscriptions… that overlap the Oxy boundary" | True, and the ADMIN side of plans/features/credit packages lives in the dead gateway admin. Retiring it without an Alia-side editor freezes entitlements at whatever the database holds. |
| WS4: `alia-lite` … are "public model IDs backed by hidden third-party models" | True. Also two documented ids, `alia-v1-tts` and `alia-v1-image`, are NOT servable, and the real `alia-v1-thinking` is missing from two of the three published tables. |

---

## How to read a row

```jsonc
{
  "id": "provider-health",              // stable slug; rows are sorted by it
  "workstream": "7",                    // the ONE #139 workstream that owns the decision
  "domain": "provider-runtime",         // which inventory the row came from
  "kind": "module",                     // package|module|route|table|column|env|screen|doc|dependency|stream-event|behaviour
  "currentPath": "packages/api/src/internal/providers/lib/provider-health.ts",
  "reachable": "live",                  // see below
  "owner": "relay",                     // alia|oxy|relay|delete
  "targetPath": "relay:health/circuit-breaker.ts",
  "dependsOn": ["table-provider-health"],
  "removalGate": "BLOCKS ON THE LOAD BALANCER: …",
  "provenance": "re-derived",           // measured-by-lead|inventory-<domain>|re-derived
  "evidence": "…:176-212, …:298-323; readiness dependency routes/health.ts:144-147"
}
```

**`reachable`** is the field most likely to be wrong in a source-only reading, so its
vocabulary is exact:

- **`live`** — executes today. For a test artefact it means the CI suite runs it.
- **`dead`** — cannot execute: no runtime entrypoint reaches it (measured import graph),
  or the API surface it depends on is not mounted.
- **`loaded-not-invoked`** — the module IS loaded by the running service, but the code in
  question has no live caller. Nineteen rows, all text adapters. This value is not in the
  epic's schema; it exists because both alternatives are false, and a matrix that says
  "dead" about a file whose deletion edits a live module is the kind of plausible wrong
  answer that gets believed.
- **`unverified`** — not answerable from this repository: prose, external clients,
  infrastructure outside the repo. Twenty rows: 15 prose artefacts (docs, READMEs, the
  console's documentation pages, `AGENTS.md`), 4 deployment specs and environment
  templates, and 1 committed build artefact. No row is `unverified` because nobody looked.

**`removalGate`** is never a date. It is a measurable condition: a usage measurement with
a positive control, a replacement being live, a row count audited. Where a gate cannot be
stated honestly it says `UNDECIDED —` followed by the open question, and the row appears
under [Open questions](#open-questions).

**`provenance`** is per row: `re-derived` means the reachability verdict, and any gate
marked as such, were measured in this pass; the descriptive text still originates from the
domain inventory named by `domain`.

---

## Method, and how it could be wrong

**The import graph.** Reachability for `packages/api` is a static graph over all 541
tracked `.ts` files under `packages/api/src`, seeded from the three entrypoints the build
actually produces (`packages/api/build.ts`): `src/index.ts`, `src/db/migrate.ts` and
`src/scripts/purge-ip-fields.ts`. Edges are static imports, `export … from`, dynamic
`import()` and `require()`, with comments stripped so a commented-out import cannot
manufacture a live edge.

Result, partitioning all 541: **406 runtime-reachable, 103 reachable only from tests
(the 97 test files themselves plus 6 modules only they import), 32 orphans, and 0
unresolved relative specifiers** — that last number matters, because an unresolved
specifier is a silently missing edge, and there are none.

Controls, all five passing: `lib/chat-core.ts`, `routes/v1/chat-completions.ts` and
`lib/gateway-client.ts` are reachable (a graph that found nothing would say otherwise);
`internal/providers/index.ts` and `internal/providers/routes/providers.ts` are NOT (a
graph that marked everything reachable would say otherwise).

**How it could be wrong.** It is static: a module loaded by a name built at runtime would
be invisible. None was found in `packages/api/src`. It answers "can this execute", not
"does this execute on a real request" — which is why the three-way distinction above
exists, and why the adapters needed a separate call-site census rather than a graph
lookup. For everything outside `packages/api`, reachability comes from the inventories or
from a decision taken here and stated in the row's own gate, never from the graph.

**Everything else is a claim from one of four inventories**, produced by four agents
reading this repo at `b909147d` (HEAD when this matrix was written is `d1b26478`; the only
change between them adds `db/agents/agentRepository.ts` and its test, so no row's
`currentPath` moved). They are archived verbatim in
[`inventories/`](./inventories/) — `provider-runtime.json` (126 items),
`product-api.json` (92), `data-billing.json` (57), `frontend-admin.json` (61) — each with
its own `method` block recording that agent's controls, limitations and residual. They are
archived rather than cited from a chat log because a `provenance` of
`inventory-product-api` has to resolve to something. Load-bearing claims — anything a
deletion hangs on — were re-derived here with a positive control; the rest are marked
`inventory-<domain>` and should be read as claims.

**The matrix was generated once** from those four files plus the measurements recorded
above, and is HAND-MAINTAINED from here. The generator is deliberately not committed: the
matrix's whole future is hand edits as rows reach their destinations, and a regenerator
sitting beside it would silently revert them. What guards it instead is the coverage gate
below.

**What was NOT measured.** No production database was queried, so no row count is known
for any table; every "row count audited" gate is therefore unmet by construction. No
access log was read, so "zero consumers" is always scoped to this repository. No build was
run and no browser was opened, so every frontend row is a claim about JSX. Whether the
live ECS task definition sets `GATEWAY_API_URL` is outside the repo — the deploy workflow
does not sync it, and if it were set alongside `SERVICE_SECRET` the service would be
calling a gateway that no longer exists.

---

## Provider runtime — 150 rows

62 to Relay, 53 stay in Alia, 35 deleted. 101 live, 26 dead, 19 loaded-not-invoked.

**What leaves.** The whole inference mechanism: `chat-core.ts`'s provider construction,
`provider-api.ts` and its non-streaming multi-modal path, `model-resolver.ts`,
`fallback-engine.ts`, `key-manager.ts`, `provider-health.ts`, `generate-model-mappings.ts`
(the tier→provider routing table), `model-capabilities-data.ts` (682 lines of provider
pricing), `tts-providers.ts`, `digitalocean-async.ts`, the provider half of
`voice-session-manager.ts`, the two realtime voice adapters, the three `@ai-sdk/*`
packages, and the per-modality timeout/retry/fallback behaviours.

**What stays.** `ALIA_MODELS` — the branded catalogue is the product, and it is the one
vocabulary that must never leak into Relay's. `sanitize.ts` and its 16 call sites.
`PROVIDER_NAMES`, because the sanitizer builds its scrub list from that array and deleting
it silently reduces the scrubber to five hardcoded patterns. `ALIA_TIERS`, because it
renders live CHECK constraints. `gateway-client.ts` itself: it is the seam that made
deleting the gateway service safe, and Relay replaces the target of its remote branch, not
the module. LiveKit transport. Credits.

**What is simply deleted.** The 15 thin OpenAI-compatible adapters (37-42 lines each,
byte-identical modulo name and URL, knowledge already duplicated twice in live code); the
unmounted admin module and its 12 route files, WebSocket server, service-auth middleware,
broadcast helpers and second `mongoose.connect()`; `lib/auth-health.ts`, which sits
OUTSIDE `internal/providers` and will be stranded by a directory-scoped cleanup;
`provider-warmup.ts`; the orphaned `packages/integrations/src/shared/model-resolver.ts`,
which is the last in-repo artefact of the provider-key-handout model and names nine
providers in shipped source; the `gatewayAdmin` AI tool, which HMAC-signs requests to a
deleted service and today fetches the literal string `undefined/gateway/v1/keys`.

**Order, and what blocks what.**

1. **The readiness probe blocks everything else.** `routes/health.ts:144` returns 503
   `no_healthy_providers` from `/health/ready`, and the ALB reads that route. A
   replacement readiness definition must be LIVE IN PRODUCTION before `provider-health.ts`
   is removed, or the removal is a rolling outage that reports success. This is the
   highest-risk gate in the matrix.
2. Delete the dead subtree first (rows with `reachable: "dead"`). It is free, it removes
   4 396 lines across 25 files under `packages/api/src` (measured over the distinct
   `currentPath`s of the dead rows), and it shrinks every later diff.
3. `chat-core.ts` is the central gate: 32 non-test files import it (measured), and every
   one must accept a model object it did not construct.
4. Repoint the eight `callProviderAPI` sites together. Three of them (`v1/images.ts`,
   `agents-avatar.ts`, `canvas/execute.ts`) are three copies of one image loop with
   different error mapping; `agents-avatar.ts` maps `content_filter` to a 400 that Relay
   must keep distinguishable.
5. `voice-session-manager.ts` splits rather than moves: LiveKit lifecycle, credit
   reservation and tool execution are product logic; only the provider socket is Relay's.

---

## Product API — 89 rows

78 stay in Alia, 8 deleted, 3 have a Relay implementation behind an Alia facade. 70 live,
14 unverified, 5 dead.

**What stays.** All of `/v1`. It is the public product contract: the OpenAI-compatible
shape, the `alia_usage` / `alia_meta` extensions, `system_fingerprint: 'fp_alia'`, and the
named SSE events. Seven packages call it, three of them (`@alia.onl/sdk`, the Codea VS
Code extension, the Codea CLI) published outside this repo where no Alia deploy can fix
them.

**What is deleted.** The four 410 tombstones, once access logs show a billing period with
no hits — the 410 body is itself the public deprecation notice, so removing it turns a
clear error into a 404. The dead `API_ROUTES.chat` constants. The published SDK's legacy
in-data event parsing, in its next major.

**Where inference moves but the path does not.** `/v1/voice/transcribe`,
`/v1/audio/speech` and `/v1/images/generations` are Alia-branded routes whose bodies are
pure inference. The PATHs are frozen by the published SDK; only what is underneath them
moves.

**What blocks what.**

- `sse-openai-chunk-frame` is the strictest constraint in the contract: three clients use
  the `openai` npm package, so the default `data:` frames must stay parseable by
  `openai-node` while named events are interleaved. Verify with a real client, not a
  hand-rolled parser.
- `alia.agent` is emitted, consumed by the app, and absent from the type and from every
  document. Any contract derived from the type or the docs drops it.
- `alia.approval_request` / `alia.approval_result` are Socket.IO-only and documented as
  SSE. The app carries dead SSE branches for both. R2 approvals therefore require a live
  socket — a pure-HTTP client cannot approve anything, which is a product constraint the
  docs currently hide.
- `POST /v1/responses` has zero in-repo consumers and exists only for external clients.
  Gate it on access logs; a source-only review concludes "safe to delete" and may be
  wrong.

---

## Data and billing — 62 rows

37 stay in Alia, 14 to Relay, 6 to Oxy, 5 deleted. 56 live, 6 dead.

**To Relay.** `provider_keys` (and its `key` / `key_hash` columns), `model_configs`,
`alia_model_provider_mappings`, `api_usage` (the per-provider-key rate-limit windows),
`provider_health`, `cost_entries`, and the tuples that render their CHECK constraints.

**To Oxy.** `subscriptions` and `transactions` — customer money records, moved by
copy-and-verify, never dropped — plus Stripe checkout, the webhook and price
provisioning, and the transaction vocabulary tuples.

**Stays in Alia.** `plans`, `features`, `plan_features`, `credit_packages`,
`user_credits`, `voice_call_usage`, `chat_analytics`, `developer_apps`,
`developer_api_keys`, `api_key_usage`: the entitlement and product-usage layer. A credit
is the product unit — Relay bills Alia in dollars, Alia bills the user in credits.

**The failures to plan for are all silent and all permissive.**

- An empty `plans` leaves `plan-access.ts` defaulting every paying user to
  `FREE_MODEL_IDS`. No error.
- An empty `api_key_usage` makes every rate-limit window read zero, so every developer key
  becomes unlimited. Same for `api_usage` and provider keys.
- An empty `voice_call_usage` reads as "zero minutes used", removing the only enforcement
  of a plan's voice-minute entitlement.
- Losing `chat_analytics.alia_model_id` empties `GET /analytics/models` for every user,
  because unresolvable entries are SKIPPED by the model-abstraction rule — it looks
  exactly like "no usage yet".
- `transactions.dedup_key` is a STORED generated column with a unique index, and it is the
  double-credit guard: the webhook writes the transaction FIRST as a lock and treats the
  duplicate-key error as "already credited". A destination without that index
  double-credits on redelivery.

**The binding constraint on every "row count audited" gate**: the Mongo source database is
gone (`packages/api/src/db/schema/CONVENTIONS.md:960`) and the backfill-audit runner was
deleted with it. There is nothing to audit against. The only remaining verification is to
establish correctness in TESTS before each switch, with rows seeded by the migrator so
that zero means filtering rather than emptiness.

**Delete.** `spendCreditsPaidFirst` and `credits-manager.getUserCredits`, both test-only.
`scripts/purge-ip-fields.ts`, whose target Mongo database no longer exists — a safety net
that cannot run is worse than none, because it survives greps and reads as protection. The
`X-Key-Used` response header, which echoes the first 8 characters of a plaintext provider
key: unreachable today only because its router is unmounted, which is a reachability
accident and not a control.

---

## Frontends and admin — 55 rows

27 stay in Alia, 11 to Oxy, 9 deleted, 8 to a Relay operations surface. 38 live, 15 dead,
2 unverified.

**`packages/alia-gateway-admin` is dead UI.** Twenty rows name a path inside that
package; **18 are `dead`** and the other two are its DigitalOcean specs, which are
`unverified` because no repo read can say what a live DO app is running. Every endpoint
the client calls is unmounted. That changes the shape of workstream 9 — nothing
is being migrated, because nothing works. What the epic is really deciding is where four
capabilities should live, none of which has a home today:

| capability | current state | proposed owner |
| --- | --- | --- |
| provider key create/rotate/deactivate | done by hand against the table | Relay ops |
| alias→provider routing editor | the code table is authoritative; the editor is dead | Relay ops |
| plan / feature / credit-pack editing | dead; the catalogue has no writer at all | Alia |
| customer billing browser | dead | Alia or Oxy |

Two hazards to record before it goes: authorization is a client-side
`user?.username?.toLowerCase() === 'nate'` (`src/App.tsx:81`) — not an access boundary at
all — and the realtime client puts the bearer token in the WebSocket URL query string
(`src/lib/websocket/client.ts:60`), where it lands in access logs. Neither pattern may be
carried into a replacement.

Five further rows sit OUTSIDE the package and are the ones a directory-scoped deletion
misses: the two root scripts, the workspace entry, the deploy job and the root DO spec.
Retiring the package touches more than a directory: two root scripts, the workspace entry
plus `bun.lock` in the same commit, four separate edits in
`.github/workflows/deploy-frontends.yml`, two DigitalOcean specs that CONFLICT with each
other about the backend URL, and seven documentation references — three of which hold this
package up as the canonical reference for bundling React Native under Vite
(`docs/oxyhq-auth.md:9,38,71`) and must be repointed at `packages/alia-console` first.
The Cloudflare Pages project must be deleted out of band; deleting the workflow only stops
future deploys and leaves the last build served forever.

**`packages/alia-console` splits cleanly.** The developer-platform screens (apps, keys,
usage, dashboard, workspace settings, the API client) go to Oxy Console; the model
catalogue, playground and documentation pages stay as Alia product surfaces.
`console-screen-models` is the pattern the whole epic should copy: an Alia-branded catalog
with health metrics and no provider column, driven entirely by `GET /models/stats`. Its
DTO having no `provider` field is a load-bearing invariant that nothing currently enforces.

**The app, SDK, Codea, Cowork and Canvas all stay** — and they are where alias retirement
actually hurts. `alia-v1` and `alia-v1-voice` are compiled into a published npm package
that ships as raw source; `alia-v1-codea` is the default of a VS Code SETTING that
persists in users' `settings.json` after an update; `alia-v1-cowork` is an electron-store
default on disk; `alia-lite` is pinned in saved Canvas workflow node data; and
`packages/app`'s model store persists the selected id to AsyncStorage with no validation
against the catalogue. **No alias may be retired by deletion — only behind the
`is_legacy` flag `GET /v1/models` already exposes.**

Four copies of the free-tier allow-list exist (`use-billing.ts:327`,
`model-selector.tsx:104`, `plan-access.ts:12`, `seed-plans.ts:33`). They agree today and
nothing enforces that they keep agreeing.

---

## Order of operations

1. **Land a provider-independent readiness probe in production.** Everything in
   workstream 7 is downstream of `/health/ready` no longer asking about providers.
2. **Delete the dead subtree** (52 `dead` rows). No gate but the coverage test in this
   directory, and it removes the fork between the gateway admin's hand-maintained provider
   list and `PROVIDER_NAMES`.
3. **Settle the seven open questions**, at least the two that block workstream 4
   (`shared-types-duplicate-registry`) and workstream 10 (`table-external-models`).
4. **Fix the documented model table before touching model semantics.** Three documents
   publish three different model lists and two of them advertise ids that 404.
5. **Extract the provider runtime** behind `gateway-client.ts`'s remote branch: chat-core
   first, then the eight `callProviderAPI` sites, then voice.
6. **Then, and only then, the data.** Provider credentials are rotated at the upstream
   provider rather than copied; a deleted row is not a revoked key.
7. **Retire the gateway admin** once the four capabilities above have homes — or
   deliberately record that they do not, since today they do not either.

Workstreams 11 and 12 (developer identity, financial records) are independent of the
provider extraction and can run in parallel; they share no rows with workstream 7.

---

## Open questions

Seven rows carry `UNDECIDED` gates. Each is a question the matrix cannot settle because it
is a product or architecture decision, not a measurement.

1. **`table-external-models`** — the two inventories disagree (delete with the routing
   tables vs keep as an Alia feature), and issue #139 workstream 10 poses it as an open
   decision. It is not routing data and its public route is live.
2. **`shared-types-duplicate-registry`** — `packages/shared-types/src/models.ts` calls
   itself "the canonical superset" and has no dependents anywhere in the repo. Delete it,
   or make it authoritative and have the API import it. Both inventories are certain and
   they disagree. This blocks workstream 4.
3. **`telemetry-provider-columns-elsewhere`** — after the switch, does Relay report the
   chosen route back so `chat_analytics.provider`, `cost_entries.actual_provider` and
   `voice_call_usage.provider` keep meaning something, or do they go permanently null while
   every query grouping on them silently returns nothing?
4. **`table-fallback-events`** — does Alia want routing telemetry at all once Relay routes?
   The table is write-only today; its only reader is unmounted.
5. **`concept-tier-rate-limits`** — `TIER_RATE_LIMITS` is a code constant duplicating what
   `plan_features` expresses. Both are live. Name the authority before either moves.
6. **`cost-calculator`** — build the savings feature (it needs per-tier pricing from
   Relay) or delete the file. It has no importers today.
7. **`sse-named-event-contract`** — wire `AliaChatEventName` into the emitters and the app,
   or delete it. It currently constrains nothing.

Three further questions have no `UNDECIDED` row because the gate IS statable, but they
need someone outside this repo to answer them before the gate can be met:

- **Does anything still call `POST /v1/responses`, `/alia/chat`, or the four 410
  tombstones?** Only ALB/CloudWatch access logs can say. A grep says "no consumer" for all
  of them and would be wrong about at least `/v1/responses`, which exists solely for
  external clients.
- **Do published Codea extension versions in the wild still call `/codea/user` and
  `/codea/token`?** Marketplace telemetry, not the repo.
- **Is the `alia-gateway-admin` Cloudflare Pages site still served, and does any live
  DigitalOcean app still read `.do/app.yaml`?** The repo has three conflicting deploy
  definitions for one site and its own header says it is documentation only.

---

## Limitations and residual

Inherited from the four inventories, and stated per row where it bites:

- Provider-runtime: hostnames were found by grep, so a URL split across a template-literal
  newline would be missed — not observed, not proven absent. Credential VALUES were never
  read.
- Product/API: static only. Every "zero consumers" claim is scoped to this repo. The
  `alia-*` id census counts matches, not lines.
- Data/billing: nothing was executed; no production row count is known for any table.
  Frontend readers were enumerated by endpoint-string grep, which is weaker than the
  backend import census.
- Frontend/admin: static read of JSX. No build, no browser. A screen recorded as
  "displays keyPrefix" is a claim about source, not about a rendered pixel.

Added by this matrix:

- **Domains were enumerated, not sampled**, with one exception: `packages/alia-canvas`,
  `packages/alia-docker-host` and `packages/alia-codea/webview-ui` were covered only where
  another inventory reached into them. Canvas has six alias sites and its own `/v1/models`
  client, both recorded; docker-host was checked for `/v1`, `/alia/chat` and `alia-*` ids
  and has none.
- **The coverage gate binds only `packages/api/src/internal/providers/**`.** Nothing
  enforces completeness for `packages/app`, the console, the SDK or the docs — for those,
  absence from the matrix means nobody wrote a row, not that no row is owed.
- **`git ls-files` sees TRACKED files.** A brand-new file under the governed subtree is
  invisible to the gate until it is staged. Verified by mutation: the probe only turned the
  gate red after `git add -f`.
- **One workstream per row.** Several rows legitimately belong to two — `field-provider-keys-key`
  is workstream 15 and workstream 10; `voice-session-manager` is 7 and 13. The matrix
  records the workstream that owns the DECISION, and the gate text names the other.
- **The 32 orphans the import graph found include 11 outside the epic's scope**
  (`lib/agent/index.ts`, `lib/agent/tool-router.ts`, `lib/daily-briefing.ts`,
  `lib/query-classifier.ts`, `lib/style/index.ts`, `lib/tools/descriptions/tool-specs.ts`,
  `lib/types.ts`, `scripts/seed-oxy-services.ts` among them). They are dead code but not
  migration items, so they have no rows.
- **Twenty duplicate descriptions were folded into their canonical row** (the table
  below): the four inventories overlap, and two rows for one subject is two answers to one
  question. Where they disagreed on an OWNER rather than on detail, the row carries an
  `UNDECIDED` gate instead of a verdict rather than picking a side.

---

## The coverage gate

`packages/api/src/db/__tests__/ownershipMatrixCoverage.test.ts`, in the `@alia/api` suite,
asserts that:

- every `currentPath` in the matrix still exists — this is what catches drift as the
  epic's deletions land;
- every tracked file under `packages/api/src/internal/providers/**` is either mapped by a
  row or listed in an explicit `NOT_APPLICABLE` map with a reason; being in neither fails;
- `NOT_APPLICABLE` has an EXACT count (2 — the two test files under that subtree), so it
  cannot grow one defensible line at a time;
- rows are unique, sorted by id, and depend only on ids that exist;
- every row carries a legal `owner` and `reachable` value.

Both halves are floored against vacuity (≥ 300 rows, ≥ 50 governed files, ≥ 150 distinct
paths) and the file enumeration carries a positive control naming a file known to be in
the subtree. Every assertion was mutation-tested: each violation confirmed RED, each
restore from a pristine copy confirmed GREEN.

---

## Inventory id → matrix row

Twenty inventory ids were folded into another row because they described the same
subject. A reader arriving from an inventory file finds them here:

| inventory id | matrix row |
| --- | --- |
| `internal-providers-unmounted` (product-api), `dead-internal-providers-router` (data-billing) | `dead-internal-providers-router` |
| `gateway-client-seam` | `gateway-client` |
| `alia-models-registry`, `code-catalogue-alia-models` | `alia-models` |
| `schema-provider-keys` | `table-provider-keys` |
| `schema-model-configs` | `table-model-configs` |
| `schema-external-models` | `table-external-models` |
| `telemetry-provider-health-table` | `table-provider-health` |
| `telemetry-api-usage` | `table-api-usage` |
| `telemetry-fallback-events` | `table-fallback-events` |
| `provider-names` | `tuple-provider-names` |
| `alia-tiers` | `tuple-alia-tiers` |
| `dead-run-startup-seed` | `dead-startup-seed` |
| `migration-sync-zeroeval` | `script-sync-zeroeval` |
| `integrations-model-resolver-dead-client` | `integrations-model-resolver` |
| `env-vite-gateway-api-url` | `ga-env-vite-gateway-api-url` |
| `leak-gateway-admin-ui` | `ga-types-providers` |
| `gateway-admin-dead-client` | `ga-api-client` |
| `doc-gateway-admin-readme` | `ga-docs-references` |
| `shared-types-alia-tier` | `shared-types-duplicate-registry` |
| `app-model-selector-consumer` | `app-model-selector` |

Six grouped items were SPLIT so that every row names one path: the 15 thin adapters
(`adapter-thin-openai-compatible-x15` → `adapter-openai` … `adapter-digitalocean`), the
`db/providers/` repositories (→ `db-repo-*`), and the multi-package dependency rows
(`sdk-ai`, `sdk-livekit`, `sdk-openai-clients`). Nineteen rows were added that no
inventory carried: the 11 dead admin route files, `broadcast-helpers.ts`, the three
billing seeds, `packages/api/src/internal/README.md`, `AGENTS.md`, the committed Cowork
bundle, and this gate.
