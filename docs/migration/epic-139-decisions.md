# Epic #139: the decisions only a person can make

Fourteen sections covering fifteen items from [issue #139](https://github.com/OxyHQ/Alia/issues/139)
that no agent can land, because each is a product, commercial, legal or operational call rather than
an engineering one.

**Eleven are the `PRODUCT_DECISION` verdicts** in [`epic-139-status.json`](./epic-139-status.json),
across ten sections — O1 covers two rows, because they are the two rejected options of one decision.
**Four more are the same shape** and were found beside them: the alias sunset date (D1), the full
request-path cut it implies (D2), extended thinking (D3), and the `/v1/responses` default (D6).

Six are already decided and are recorded for their reasoning; eight are open.

**Measured 2026-08-17 against `origin/main` at `7a5911e1`.** Every fact below is cited by path and
line so it can be re-read rather than trusted. Where a claim in a handoff turned out to be wrong, the
measured value is used and the discrepancy is stated — those are marked **measured**.

## How to read a section

Each open decision gives: the **exact checkbox text**, what is **blocked** until it is answered, the
realistic **options**, and what each costs in three currencies that trade against each other —
**engineering** (work to build), **user-visible** (what a person notices), and **irreversibility**
(what cannot be undone afterwards). No recommendation is offered unless one option is plainly
dominated, in which case the reason is given.

Decided items record **why**, because the reasoning is the part that is expensive to reconstruct.

---

# Part 1 — Decided

## D1. The alias sunset date

> `Add deprecation headers/events and a sunset date for external clients still using old aliases.`
> (workstream 4)

**Decided: no date. The thirteen `alia-*` identifiers come off every advertised surface now, and keep
resolving unadvertised.**

The user's answer was *"simplemente deja todo limpio ya"* — leave it clean now. That resolves the
deadlock the compatibility window creates on purpose: `compatibility-window.md:23` says *"a date
passing is not a gate"* and `:53` says a removal date is set *"when the gate is satisfied or is
credibly close, never as a placeholder"*, and the gate for path (a) is a production usage measurement
that cannot be taken — `~/.config/oxy/tokens/` holds no Alia database credential and
`api.alia.onl/health` returns 503. Waiting for a gate nobody can satisfy is how a compatibility
window becomes permanent.

Unadvertising sidesteps the gate rather than guessing at it: a caller who already knows an alias
keeps working, and no new caller can learn one.

**What ships:** the aliases leave `GET /v1/models`, `GET /catalogue`, the app picker and the
`switch-model` tool. They keep resolving through `alias-migration-map.json`, which is already
enforced against the routing table by `packages/api/src/__tests__/aliasMigrationMap.test.ts`.

**Still to implement as of `7a5911e1`** — the decision has landed, the code has not:
`routes/v1/models.ts:66` still serves all thirteen, and `compatibility-window.md` still records path
(a) at *"emits both, as of workstream 4"* (`:57`) rather than closed for advertisement.

**Irreversible:** nothing. Re-advertising is a serializer change. This is why it is the cheap half.

### The three compatibility paths, and what each is actually waiting on

Measured on `7a5911e1`, because "which gate" is the question this decision turns on and the three
answers are different.

| path | signal today | gate it is waiting on | evidence that would satisfy it |
| --- | --- | --- | --- |
| **(a)** the thirteen `alia-*` aliases | `Deprecation` + `Link` (`middleware/alias-deprecation.ts`, mounted `index.ts:233`), `alia.deprecation` on the stream (`chat-completions.ts:105`). No `Sunset` | a usage measurement over `chat_analytics.alia_model_id` and `cost_entries.alias_model_id` across a full billing cycle, with a positive control — **or** an enumeration showing every known consumer migrated | **neither is obtainable today**: the counts are `UNMEASURED` for want of a credential, and two consumers are published packages this repo cannot migrate (D2). **This is why D1 unadvertises instead of dating.** |
| **(b)** the `api.alia.onl/v1/*` surface | **none.** Only (a) and (c) are mounted | its own gate cannot start until a signal exists — `compatibility-window.md` is explicit that emitting is a prerequisite, not an optional extra | a mounted deprecation signal on the `/v1` surface, then the same usage measurement. Nobody has built the first half |
| **(c)** the `alia_sk_*` credentials | `Deprecation` + `Link` (`middleware/credential-deprecation.ts`, mounted `index.ts:240`), issuance closed (`refuseIssuance`). No `Sunset` | a replacement credential existing in Oxy, plus an active-key count | **OxyHQ/oxy#972 must issue the replacement first.** A date set before that is a deadline holders cannot meet — see O6 |

Read together: **only path (a) is closable by a decision alone**, which is what makes D1 the one that
could be answered now. (b) is blocked on work nobody has started, and (c) is blocked on Oxy.

## D2. Why not a full cut, and what a full cut would cost

**Decided: the aliases stay on the request path. A full cut remains available as an explicit,
separately-decided breaking change — recorded here so the option is not lost.**

Removing them from resolution too would brick the product today. Three costs, each measured:

1. **Nothing else resolves.** `internal/providers/lib/fallback-engine.ts:187` throws
   `UnregisteredModelError` for any identifier not in `ALIA_MODELS` (**measured** at `:187`; a
   handoff said `:185`).
2. **Nothing maps a `profile:*` id to a tier on the live path.**
   `lib/routing/alias-translation.ts:133` translates an alias to a contract `RoutingTarget` for the
   *Relay* wire and returns `not_an_alias` for anything else — and its only consumer,
   `lib/inference/relay-request.ts`, is the client that is frozen out of the product graph. So a
   caller sending `profile:v1-pro` today reaches nothing.
3. **The alias is what bills the request.** `lib/credits-manager.ts:52` reads
   `model?.creditMultiplier || 1` off the alias entry. Remove the alias and every request bills at
   1× regardless of tier.

And two consumers this repository cannot migrate by editing itself: **`@alia.onl/sdk` (latest
published `5.1.0`, 2026-08-02)** ships as raw source, so consumers compile the aliases into their own
bundles; **`@alia-codea/cli` (latest published `2.0.1`)** hardcodes `alia-v1-codea`. *(**Measured**
from npm: a handoff said `6.0.0` and `2.0.2`; neither exists — the SDK's published versions end at
`5.1.0` and the CLI's at `2.0.1`.)* An installed copy keeps sending the old identifier until its
owner upgrades, which is exactly what "keeps resolving unadvertised" protects.

**If a full cut is later chosen**, the three costs above are the work: a resolver that accepts
`profile:*`, a billing multiplier that hangs off the profile rather than the alias, and a published
SDK/CLI major with a migration note. **Irreversible:** every installed SDK and CLI copy older than
that major stops working, and no repository change reaches them.

## D3. "Extended thinking" is a runtime parameter

**Decided: a selectable runtime parameter, ChatGPT-style — not a seventh product mode and not a
model.** `packages/api/prompts/alia-v1-thinking.md` becomes what the parameter selects.

This is ADR 0002's own rule applied to the sharpest case in the catalogue: `alia-v1-thinking` and
`alia-v1-pro-max` share the tier `v1-pro-max`, so they are two names for one policy — a reasoning
setting wearing a model's name. `PRODUCT_MODES` (`lib/product-modes.ts:111`) has exactly six entries
— `mode:automatic`, `mode:fast`, `mode:balanced`, `mode:maximum-quality`, `mode:coding`,
`mode:deep-research` — and adding a seventh for a prompt would re-commit the error the epic exists to
correct.

**Irreversible:** nothing, while the aliases still resolve.

## D4. `owned_by` on the compatibility surface

> `Stop returning `owned_by: alia` for provider aliases.` (workstream 4) — **ticked**

**Decided: `owned_by: 'undisclosed'`** (`routes/v1/models.ts:59`).

Neither of the two obvious answers was right. `alia` asserted ownership of weights Alia does not own;
the true publisher is not recoverable from this repository's data at all, because an alias fans out
to several upstream models. `undisclosed` is the only value that is true. `object: 'model'` was
deliberately **not** changed alongside it — that is the field an existing caller switches on, and
`GET /catalogue` is where the truthful answer lives.

## D5. Which Alia product API survives

> `Preserve an Alia product API only if it provides product-specific assistant functionality and
> still authenticates through Oxy.` (workstream 11) — **ticked**

**Decided on a measurement rather than a preference:** `/alia/chat` and `/v1/chat/completions` are the
*same handler object* (`routes/chat.ts:23`, asserted at
`routes/__tests__/unified-product-runtime.test.ts:65`), and `/alia/chat` has **zero in-repo callers**.
So "an Alia product API distinct from the generic one" did not exist to preserve. What survives is
the one runtime; the split is workstream 6's to build, not a thing to protect.

## D6. The `/v1/responses` default model — decided and **implemented** (#178)

**Decided by the team lead rather than asked; recorded here so the user can overrule it.**

`POST /v1/chat/completions` and `POST /v1/responses` defaulted differently, so an identical
model-less request was billed at a **2× different credit multiplier depending only on which endpoint
it hit** — `alia-lite` has multiplier 0.5, `alia-v1` has 1.

The decision was that both resolve to the single owner, `getDefaultAliaModel()`, which answers
`'alia-lite'`.

**Implemented, and the shape is worth recording, because it is not the one this section originally
described.** The obvious fix — make `responses.ts` restate `getDefaultAliaModel()` too — would have
left TWO sites that each know what the default is, which is the condition that produced the
divergence in the first place. What landed instead removes the adapter's opinion entirely:
`routes/v1/responses.ts` now forwards `model: body.model` **unresolved**, and the default is applied
once, downstream, at `lib/chat/request-context.ts:182`. There is nothing left to keep in step.

The census in `packages/api/src/lib/__tests__/defaultChatModel.test.ts` that had frozen the
divergence lost its `routes/v1/responses.ts` entry in the same change, and now asserts the absence at
the source — that the file contains `model: body.model,` and matches no `model: body.model ||` at
all.

**Rationale for resolving toward `alia-lite`:** the alternative — making both default to `alia-v1` —
doubles the bill on the main path used by the app and every SDK consumer. Production is at
`desiredCount: 0` and `api.alia.onl` returns 503, so nothing regresses live either way, which is what
makes this a cheap moment to fix it.

**Irreversible:** nothing forward. Backward, no: requests already billed at the old multiplier were
billed, and no reconciliation is proposed.

---

# Part 2 — Open

## O1. The two rejected options still sitting unticked

> `returns a documented redirect/proxy during migration,`
> `is removed with a fixed sunset.`
> (workstream 6, both indented under a ticked parent)

**These are not open questions.** The decision was made: the parent (`Decide whether
api.alia.onl/v1/*:`) is ticked and the chosen option — *"remains a product-specific compatibility
endpoint for a bounded period"* — is ticked, recorded in `compatibility-window.md` section (b) and
ADR 0004. These two rows are the alternatives that were **not** chosen, so ticking either would
contradict the ticked sibling.

**Blocked:** nothing. They will never be earned as written.

**Options:** (a) strike both rows from the epic body, which is the honest end state; (b) leave them
open forever, which costs two rows of permanent noise in every progress count.

*(a) dominates.* The only cost is an edit to the issue body, and leaving them makes the epic
un-completable by construction. This audit does not edit the body.

## O2. Which historical model ids to preserve

> `Preserve historical IDs only where required for old analytics/receipts.` (workstream 10)

**Blocked:** dropping the routing catalogue tables (`alia_models`, `alia_model_provider_mappings`,
`model_configs`). Their ids are foreign to `cost_entries.alias_model_id` and
`chat_analytics.alia_model_id` by value, not by constraint, so a drop silently orphans history rather
than failing.

**The measurable inputs exist and the row counts do not.** Neither instrument appears in
`packages/api/src/db/expiryTargets.ts`, so nothing sweeps them today; but all 21 production row
counts are `UNMEASURED` for want of a database credential
([`epic-139-status.md`](./epic-139-status.md), Task 2, which carries the exact operator command).

| option | engineering | user-visible | irreversible |
| --- | --- | --- | --- |
| **Keep every historical id** | none now; the tables stay and every "drop" gate stays open | none | no |
| **Keep only ids referenced by a surviving row** | a reconciliation query per table, plus a migration that preserves the referenced subset | none | **yes** — the unreferenced ids are gone |
| **Drop all, keep only aggregates** | one migration; analytics rewritten to aggregate-only | historical per-model breakdowns disappear from any usage screen | **yes, completely** |

**This one cannot be answered before the counts are taken.** Option 2 and 3 differ by exactly the
number of rows nobody has measured.

## O3. What becomes of the external-models leaderboard

> `Decide whether it remains an Alia research/catalogue feature, moves to Oxy's model discovery
> surface or is retired.` (workstream 10)

**Blocked:** removing `external_models` and its route, and the duplicate-catalogue question in
workstream 10.

**Already proven, so the decision is purely product:** it is a read-only mirror of a third-party
leaderboard (`api.zeroeval.com`) and is not the routing catalogue.
`routes/__tests__/external-models-boundary.test.ts` asserts it is referenced by exactly five
mirroring and serving files, that no module between a model id and a provider names it, that its
table has **no foreign key out of it**, and that its route is read-only and mounted outside the
catalogue. Nothing routes on it, so nothing breaks whichever way this goes.

| option | engineering | user-visible | irreversible |
| --- | --- | --- | --- |
| **Keep as an Alia research feature** | none | unchanged | no |
| **Move to Oxy model discovery** | an export plus a consumer on the Oxy side; blocked on OxyHQ/oxy#972 | the surface moves | no — it is a mirror; re-sync rebuilds it |
| **Retire** | delete the table, the route, the five files and `scripts/sync-zeroeval.ts` | the leaderboard disappears | **no**, and this is the point: the data is a mirror of a public source and can be re-synced |

*No option is dominated, but note the asymmetry:* retiring is unusually cheap to reverse, because
nothing here is original data.

## O4. Which analytics survive as product analytics

> `Decide which Alia analytics remain useful as product analytics.` (workstream 10)

**Blocked:** the duplicate-usage-hook removal, and every "drop obsolete tables" gate that names an
analytics table.

**The classification framework is already ticked** (workstream 1's four-way split) and
`inventories/data-billing.json` holds the per-table analysis. What is missing is the choice over six
tables: `chat_analytics`, `voice_call_usage`, `api_usage`, `api_key_usage`, `fallback_events`,
`routing_logs`.

Two of them are load-bearing beyond analytics and should be decided separately from the rest:
`chat_analytics` and `cost_entries` are the two instruments the alias removal gate depends on
(`compatibility-window.md`, removal gate (a).1), so discarding them removes the only way to measure
alias usage.

| option | engineering | user-visible | irreversible |
| --- | --- | --- | --- |
| **Keep all six** | none | none | no |
| **Keep the two instruments, discard four** | four table drops plus their writers | internal dashboards lose fallback and routing detail | **yes** for the four |
| **Discard all; rely on Relay's metering** | drops plus a Relay-side consumer | product analytics stop until Relay serves | **yes**, and it strands the alias gate |

*Option 3 is dominated while the aliases still resolve*, because it destroys the instrument the
sunset gate needs.

## O5. Historical data retention

> `Migrate or retain historical data according to legal/product requirements.` (workstream 10)

**Blocked:** the retention review that gates dropping the financial tables.

**This is a legal call, not an engineering one**, and the engineering inputs are stated:
`packages/api/src/db/expiryTargets.ts` is the sweep registry; `api_key_usage` is swept at 90 days
(`:107`); `chat_analytics` and `cost_entries` appear in no entry, so nothing deletes them today. That
last fact is a property of the current registry, not a guarantee — re-check it when the decision is
taken.

The question to answer is not "how long" in the abstract but: **what is the retention obligation for
customer financial records (`transactions`, `subscriptions`), and does it differ from the obligation
for inference telemetry?** Those two have been treated as one class and are not.

**Irreversible:** any deletion, entirely. This is the one decision on this page where a wrong answer
cannot be corrected by a later PR.

## O6. Notifying developer-key holders

> `Notify users and provide a bounded credential migration period.` (workstream 11)

**Blocked:** removing the `alia_sk_*` auth middleware, and therefore the developer-identity half of
workstream 11.

**The signal already ships — only the date is missing.** *(This corrects an earlier draft of this
brief, which said paths (b) and (c) emit nothing; that was true at the audit and is not true now.)*
Measured on `7a5911e1`: `middleware/credential-deprecation.ts` is mounted app-wide at
`src/index.ts:240` and sets `Deprecation` and `Link` per RFC 9745 on every response to a request
carrying an `alia_sk_` credential; `alia.deprecation` is emitted on the stream at
`routes/v1/chat-completions.ts:105`; and `src/index.ts:138` adds all three headers to
`exposedHeaders`, without which a browser client could not read them. **`Sunset` is implemented and
emits nothing**, because `CREDENTIAL_SUNSET` is `null` — deliberately, under the same rule as D1.
Issuance is closed: `POST /developer/apps` (`:85`) and `POST /developer/apps/:appId/keys` (`:186`)
both call `refuseIssuance`.

**Path (b)** — the `api.alia.onl/v1/*` surface itself — has no signal of any kind. Only (a) and (c)
are mounted.

And a measured constraint that changes the shape of the answer: **rotation has never existed on
`/developer`** — its `PATCH` covers name, scopes, the active flag and rate limits only, and the sole
path that ever replaced a secret was `POST /auth/token`, now closed. So "migration period" cannot
mean "rotate to a new Alia key"; it can only mean "obtain an Oxy credential", which is
OxyHQ/oxy#972's to provide. **A window cannot be closed before that credential exists**, whatever
date is chosen.

| option | engineering | user-visible | irreversible |
| --- | --- | --- | --- |
| **Signal only, no end date** *(current state)* | none — it ships | holders see a deprecation signal with no deadline | no |
| **Set a `Sunset` date** | one constant, `CREDENTIAL_SUNSET` | holders get a deadline they can plan against | **the date itself**, per `compatibility-window.md:53` — an announced date that then moves teaches callers to ignore the header, destroying the signal for every future deprecation |
| **Revoke without further notice** | delete the `alia_sk_` branches in `middleware/auth.ts` | every integration using a key breaks, with only the header as warning | **yes** |

*Option 3 is dominated* unless a count shows zero active keys — and that count is `UNMEASURED`
(`developer_api_keys`, `developer_apps`). **Take the count before deciding**; the exact command is in
[`epic-139-status.md`](./epic-139-status.md).

*Option 2 has a precondition, not just a cost:* a date announced before Oxy can issue the
replacement credential is a deadline holders cannot meet, which is the same failure as a date that
moves.

## O7. Public resale rights, per provider

> `Do not assume that an API key obtained from a provider authorizes public resale.` (workstream 17)

**Blocked:** every "which routes may Alia expose to external callers" question in workstream 17, and
the `internal_alia` scope filter that workstream 17's other rows build.

**This is a contracts question about agreements Alia holds**, and no engineering measurement can
answer it. What engineering supplies is a place to record the answer:
`commercialPermissionSchema` (`@oxyhq/contracts`, installed) carries `public_resale_approved`,
`wholesale_contract`, `customer_byok`, `open_weight_hosting`, `standard_application_use` and
`provider_default`. **Nothing in Alia records a value per provider today.**

The question is per-provider, nineteen times: **for each upstream provider Alia holds credentials
with, does the agreement permit reselling that capacity to Alia's own customers, or only using it to
serve Alia's own product?**

| option | engineering | user-visible | irreversible |
| --- | --- | --- | --- |
| **Assume internal-only for all nineteen until reviewed** | one default value | nothing external can use those routes | no — a later review widens it |
| **Review each agreement and record the permission** | reading nineteen contracts; then one data change | routes open per the finding | no |
| **Assume resale is permitted** | none | external callers reach every route | **yes, contractually** — a breach is not undone by a later code change |

*Option 3 is dominated.* It is the only option whose failure mode is a contract breach rather than a
feature gap, and its cheapest green is the dangerous action.

## O8. Product dashboards

> `Add product dashboards separate from Relay operational/provider dashboards.` (workstream 19)

**Blocked:** nothing in this repository. It is the last observability row and it gates only itself.

**Nothing in `packages/` defines a dashboard**; the API is instrumented toward `api.zeroeval.com`
(an allowlisted egress host). So this is a choice of tool and owner, not a code change here.

| option | engineering | user-visible | irreversible |
| --- | --- | --- | --- |
| **Reuse the existing instrumentation vendor** | dashboard definitions, no code | operators get product views | no |
| **Build in-app** | a real feature: queries, screens, access control | a product surface | no, but the maintenance is permanent |
| **Defer until Relay serves** | none | operators keep querying the database by hand | no |

*No option is dominated.* Note only that option 3 is the current state by default rather than by
choice, and that the epic's own separation requirement — product dashboards **separate from** Relay's
— cannot be satisfied until Relay has dashboards to be separate from.

---

## What this brief does not decide

- **Anything with a row count in it.** O2, O4 and O6 all turn on numbers that are `UNMEASURED`
  because no Alia database credential exists under `~/.config/oxy/tokens/`. The operator command is
  in [`epic-139-status.md`](./epic-139-status.md) and carries two positive controls.
- **The nine remaining `BLOCKED_OXY_972` and 92 `BLOCKED_RELAY` rows.** Those wait on external work,
  not on an answer.
- **Anything already ticked.** D4 and D5 are recorded for their reasoning only; both boxes are
  closed.
