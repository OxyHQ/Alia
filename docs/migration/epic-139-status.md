# Epic #139 status audit

A measurement, not a plan. For every one of the 246 checkboxes that were unticked in
[issue #139](https://github.com/OxyHQ/Alia/issues/139) when this was taken, it records a verdict and
one line of evidence — a path, a command output, or the named external artefact that is missing. The
machine-readable form, one object per box with the exact checkbox text and its workstream heading, is
[`epic-139-status.json`](./epic-139-status.json).

**Measured against `origin/main` at `975955c4`; corrected against `78da61cf`, both on 2026-08-17.**
Several agents were landing PRs concurrently throughout, so the verdicts are dated rather than
standing: 35 rows were earned within the day and carry `resolvedSince`, and five carried a claim that
was wrong or became wrong and are corrected under [Corrections](#corrections).

## Totals

416 checkboxes: **219 ticked, 197 unticked** as of 2026-08-17 against `1f7ee01b`. At the audit
(`975955c4`) it was 170 and 246; **49 of the audited rows have since been earned**, and each carries
`resolvedSince` in the JSON. **One was re-opened** — L243, *"Stop treating system prompts, reasoning
levels, Codea presets or quality modes as model identities"* — and the flags are synced from the
issue body in **both** directions, because a record that can only say "done" reports an epic as
further along than it is.

| verdict | at audit | still open | meaning |
| --- | ---: | ---: | --- |
| `BLOCKED_RELAY` | 94 | 92 | needs the Relay data plane **deployed and reachable** — see [the blocker, named](#the-relay-blocker-named) |
| `ACTIONABLE_NOW` | 42 | 14 | can be earned in this repository today; the row carries a deliverable and the guard that would go red |
| `DUPLICATE_OF` | 41 | 29 | restates another box; the row names it |
| `BLOCKED_OXY_972` | 27 | 26 | needs [OxyHQ/oxy#972](https://github.com/OxyHQ/oxy/issues/972) |
| `BLOCKED_ALIAMODELS` | 26 | 26 | needs the separate AliaModels repository with real trained artifacts |
| `PRODUCT_DECISION` | 11 | 9 | a human product or commercial call, not engineering |
| `ALREADY_TRUE` | 5 | 1 | a landed guard already makes it hold; the row carries the mutation that turns it red |

**41 of the 246 were duplicates, 29 of them still open**, so the epic's real remaining surface is
**168 distinct properties**. Two clusters accounted for most of them: the thirteen `alia-*`
identifiers served as `object: "model"` with `owned_by: "alia"` were one line in
`packages/api/src/routes/v1/models.ts` restated across five rows (L99, L241, L242, L262, L768) —
four of those five are now ticked — and the sixteen definition-of-done rows are almost entirely
restatements of the non-negotiable invariants and the workstream rollups.

Four rows duplicated an **already-ticked** box: L265 ↔ L100, L266 ↔ L509, L576 ↔ L271,
L578 ↔ L117. **Three were ticked on that basis; L576 was deliberately held.** "Same subject as a
ticked box" is weaker than "proven true", and L576 — *"Publish actual models as `alia/<model>`"* — is
a naming convention for a publication that has not happened: Alia publishes nothing, and
`lib/reserved-namespace.ts` refuses every `alia/*` identifier at the serving chokepoint
(`gateway-client.ts:320`) precisely so that stays true. Its ticked partner L271 is the *prohibition*,
satisfied vacuously. A `DUPLICATE_OF` verdict is not on its own a reason to tick.

## Corrections

Eight rows carried a stale or wrong claim. Each is corrected in place in the JSON and says so.

**The rule they cost, stated first because it is the general one: a mechanism can be green and
inert.** Evidence that names a function, a config table or a module is not evidence that the
property holds unless the **entrypoint calls it**. Row 266 failed exactly that way.

| row | what was wrong | corrected to |
| --- | --- | --- |
| **L266** *"Make cross-model fallback an explicit product/user policy"* | Classified `DUPLICATE_OF` a ticked box on evidence that was half inert. The REQUEST half was live (`fallbackPolicy` crossing the seam), but the PRODUCT half was not: `presets.ts` claimed each preset's policy was enforced on every request that selects it, and **`getRoutingPreset` had no caller outside tests**. | #163 wired it — `fallback-engine.ts:168` now reads `options.fallbackPolicy ?? getRoutingPreset(aliasModelId)?.fallbackPolicy ?? DEFAULT_FALLBACK_POLICY`. The box is earned by #163 and was not before it. Found by the workstream 4 agent, not by this audit. |
| **L454** *"never expose stored hashes as replacement secrets"* | The `mutation` named a guard that does not cover it: gate 4's response census (`architectureGates.test.ts:1342`) matches the identifier `keyConfig`, **not** `keyHash`. Putting `keyHash` in a `res.json` argument would not fire it. | There is **no guard for this direction**. The property holds by absence, and the row now says that instead of naming a gate. |
| **L522** *"Remove provider API keys from Alia deployment environments"* | Unchanged in substance, but #164 added `direct-provider-guard.ts` with a `PROVIDER_CREDENTIAL_ENV` list, which reads like a guard. | It is **green and inert**: `directProviderModeFailure` returns `null` immediately unless `ALIA_RELAY_CLIENT_ENABLED` is exactly `true`, and no deployment sets it. The property still holds by absence. |
| **L459** *"Remove duplicate app/key/usage frontend stores and screens"* | The deliverable said to keep "rotate and revoke". **Rotation has never existed on `/developer`** — its `PATCH` covers name, scopes, the active flag and rate limits only, and the one path that ever replaced a secret was `POST /auth/token`, closed by #160. | Keep **revoke** only. #160 corrected the identical false claim at `compatibility-window.md:111`. |
| **L212** *"Support tools, structured output, vision, …"* | Line references went stale when #164 moved `violatedCapability`, and the row did not name an entrypoint. | `relay-request.ts:340`, and **`relay-client.ts:931` calls it** — wired within the client, though the client itself is still frozen out of the product graph. |
| **L475** *"free/promotional usage is still cost-attributed internally"* | Said free usage *"does write a `cost_entries` row, so cost attribution exists"*. **It does not.** `recordCost` (`cost-tracker.ts:141`) is the only wrapper of `insertCostEntry` and has **zero non-test callers**, so nothing is cost-attributed on the token-metered paths at all — free or paid — and `cost_entries` is empty in production. Measured by the workstream 12 agent, not by this audit | #175 landed `grant_kind` on `cost_entries` and `voice_call_usage` and wired the **voice** settlement; the token paths remain unattributed, held by a standing assertion in `billingSeparation.test.ts` that goes red the day `recordCost` gains a caller |
| **L618** *"land shared contracts"* | Residual called the `0.29.0` bump additive | **It is breaking.** `0.29.0` widens `INFERENCE_ERROR_CODES` and the finish reasons, and `packages/api` holds exhaustive `Record`s over both — `tsc` failed in three places and two exact-count floors moved 26 → 28. Landed in #175 |
| **L468** *"audit every plan, credit, subscription and transaction path"* | Said no path audit existed | `inventories/billing-paths.json` — 26 writers over 7 tables, every caller, three-way ADR-0005 classification, set-equality-asserted by `billingSeparation.test.ts:511` |

## The Relay blocker, named

**The audit's blanket "no Relay exists" is stale.** [`OxyHQ/Relay`](https://github.com/OxyHQ/Relay)
was created on 2026-08-16 — the day after the gap analysis was written — and is public, Go, 82
files, tracked as **workstream 13 of [OxyHQ/oxy#972](https://github.com/OxyHQ/oxy/issues/972)**. It
implements `internal/provider/anthropic` and `internal/provider/openaicompat`,
`internal/provider/conformance` (the suite every adapter must pass), `internal/relay/executor` with
failover, `internal/rotation`, `internal/providercost`, `internal/sse`, `internal/edgeauth` and
`internal/httpapi`. So most workstream-7 rows now have a real destination path rather than a
hypothesis.

**What is missing is a deployment.** The repository carries no Dockerfile, no deploy workflow and no
infrastructure; its only workflow is `ci.yml`. And Alia has no endpoint to name:
`packages/api/src/lib/inference/__tests__/relay-egress.test.ts:522` asserts exactly that, and no
`RELAY_*_URL` exists anywhere in `packages/api/src`.

**`OxyHQ/oxy#981` is not this blocker, and it is CLOSED** (2026-08-15). Its subject is an unmetered
public inference exposure on Oxy's proxy *into* Alia, not "Oxy API → Relay is not mounted".
[`relay-client-gap.md`](./relay-client-gap.md) cites it as OPEN, which was already stale when
written; anyone reasoning from that citation should re-read the issue.

## The five `ALREADY_TRUE` rows

Each names the file and line that makes it hold, the entrypoint that calls it, and the edit that
turns it red — or says plainly that there is no guard. Two have since been ticked.

| box | guard, and the entrypoint that calls it | mutation that turns it red |
| --- | --- | --- |
| L212 tools/structured output/vision/… **(ticked since)** | `relay-request.ts:340` (moved by #164), called by `relay-client.ts:931` | replacing the tools condition with `false` failed `relay-request.test.ts:357` — measured, 1 failed / 25 passed |
| L454 never expose stored hashes as replacement secrets | **no guard.** Holds by absence: no route returns the column, and `routes/developer.ts:224` shows the plaintext once at creation | **none.** The audit named gate 4's response census; that census matches `keyConfig`, **not** `keyHash`, so it would not fire. Corrected above |
| L522 no provider API key in a deployment environment | **no guard.** Holds by absence — see premise (d). #164's `direct-provider-guard.ts` names provider credentials but is armed only by `ALIA_RELAY_CLIENT_ENABLED`, which no deployment sets | none. Adding `process.env.OPENAI_API_KEY` to any source file still fails nothing |
| L618 land shared contracts | `packages/api/package.json:34` plus **eleven** importing modules | remove the dependency → `bun run --filter @alia/api typecheck` fails on eleven files |
| L668 fail when a product mode is serialized as `object: model` **(ticked since)** | gate 5 of `architectureGates.test.ts:1484-1632`, a census that runs in CI | serve `object: "model"` for a multi-model entry from `GET /catalogue` → two assertions fire, at `:1553` and `:1599` — measured |

**Two of the five hold by ABSENCE with no guard at all** — L454 and L522 — and both now say so in
place of naming a gate that does not cover them. They are the two worth acting on: the durable form
of L522 is a census over `process.env.*` naming the permitted variables exactly, in the shape gate 2
uses for hostnames; the durable form of L454 is gate 4's census widened from `keyConfig` to the
developer-key columns, written alongside the re-issue endpoint that would need it.

**The two load-bearing rows above were mutation-tested, not asserted.** Baseline: both suites green,
70 tests. Replacing `payload.tools.length > 0 && !capabilities.tools` with `false` in
`relay-request.ts:219` failed `relay-request.test.ts:357` (1 failed, 25 passed). Replacing
`entry.kind === 'model'` with `true` in `routes/catalogue.ts:122` failed two gate 5 assertions —
`architectureGates.test.ts:1553` (the fan-out biconditional) and `:1599` (disagreement with
`alias-migration-map.json`, naming all thirteen aliases). Both files were then restored in place and
verified against the markers from those edits; `git status` shows no tracked file changed by this PR.

---

## The four premises, re-measured

The epic states four things about the current repository. **Two hold, one holds with a caveat, and
one is false.**

### (a) "the provider admin surface is unmounted dead code" — **FALSE, and stronger than stated**

It is not unmounted; it does not exist. `git ls-files packages/api/src/internal/providers/routes*`
returns **0 files** and `packages/api/src/internal/providers/index.ts` is absent — #141 deleted the
router and all twelve routes. Gate 1 of `architectureGates.test.ts:456` asserts this against the tree
itself rather than against imports of it, with a vacuity floor (`tree.length >= 40`, and
`lib/providers/openai.ts` must be present) so a renamed directory cannot satisfy it.

*Positive control:* the enumeration finds **48 files** under `internal/providers/`, so the empty
`routes/` result is absence and not a mis-scoped pathspec.

*Consequence for the epic:* rows that assume an admin surface still exists to be secured or moved
(L406, L407) are about a destination, not a source.

### (b) "the nineteen hand-written adapters listed for extraction are dead" — **TRUE, with a caveat that matters more than the premise**

Repo-wide, `.proxy(` — the only text method on the `Provider` interface
(`internal/providers/lib/types.ts:58-67`) — has **exactly one call site**, and it is a test:
`internal/providers/lib/__tests__/credential-redaction.test.ts:150`.

But the files are **loaded**, not merely dead: `lib/providers/index.ts` constructs all 21 adapter
objects at module load and is imported by `voice-session-manager.ts:30`, which is live behind
`routes/v1/voice.ts`. It reads only `.voice`, and only `openai` and `xai` have one
(`:148`, `:229`, `:695`). So deleting an adapter file means editing a live registry —
`ownership-matrix.json` records every one as `reachable: "loaded-not-invoked"`.

**The caveat: the live provider code is somewhere else entirely, and the epic does not list it.**
Provider base URLs live in four places, two of them squarely in product code
(`architectureGates.test.ts` `PROVIDER_HOST_ALLOWLIST`, `:543-640`):

- `internal/providers/lib/providers/*.ts` — the nineteen dead adapters.
- `lib/chat-core.ts` — `getAIModel()` builds an AI SDK provider against a hardcoded base URL for
  **fifteen** providers. This is the live text path.
- `lib/provider-warmup.ts` — pre-warms TLS to **seven** provider hosts at boot, from `src/index.ts`.
  Egress before a single request is served.
- `packages/integrations/src/shared/model-resolver.ts` — a **second service** with its own copy of
  five provider base URLs.

Extracting the nineteen dead files removes no egress. That was row L353
(*"Any additional adapter discovered by the inventory"*), **earned by #166**, which refiled
`provider-warmup.ts` from workstream 8 to 7, added the row that states the finding, and added the
gate-2 assertion that every file permitted to name a provider hostname is filed for extraction.

### (c) "the product runs on `/v1/chat/completions`, not `/alia/chat`" — **TRUE**

Every shipped client posts to `/v1/chat/completions`: `packages/app/lib/hooks/use-chat-conversation.ts:44`,
`packages/alia-chat/src/hooks/useAliaChat.ts:217`, `packages/alia-codea/src/chatParticipant.ts:177`
and `inlineCompletionProvider.ts:93`, `packages/integrations/src/shared/api-client.ts:198`/`:260`.
`/alia/chat` has **zero in-repo callers**. Measured: 23 occurrences in `.ts`/`.tsx` across
`packages/`, of which 9 are outside `__tests__` and only **5 are not comments** —
`src/index.ts:233` and `:253` (its own two mounts), `src/index.ts:299` (the root route's endpoint
list), `routes/chat.ts:29` (the string in its own `GET` status body), and
`packages/app/lib/api/routes.ts:53`, which declares `API_ROUTES.chat.alia` and is **never read**
(grepping the app for a use of it returns only an unrelated Play Store URL). The stale "13
references" figure in [`ownership.md`](./ownership.md) predates several PRs; the conclusion it drew
is unchanged.

The two are the **same handler object**, not a copy: `routes/chat.ts:23` dispatches
`POST /alia/chat` to `handleChatCompletions`, asserted by
`routes/__tests__/unified-product-runtime.test.ts:65`. They differ only in the middleware in front:
`/alia/chat` mounts `optionalAuth` and admits an anonymous caller straight to inference with no
credit reservation, recorded at `inference-boundary.test.ts:354`.

*Scope limit, stated rather than implied:* this is a source measurement. Whether an EXTERNAL client
calls `/alia/chat` cannot be answered from this repository — it needs ALB/CloudWatch access logs, and
`api.alia.onl/health` returned **HTTP 503** on 2026-08-17, so the service is parked and no such logs
are accruing now.

### (d) "provider credentials are database rows, not env vars" — **TRUE in substance, with one dead line**

Credentials come from the `provider_keys` table through `db/providers/providerKeyRepository.ts`;
`internal/providers/lib/key-manager.ts` contains **zero** `process.env` reads, and so does
`lib/chat-core.ts`.

A repo-wide case-insensitive grep for
`(OPENAI|ANTHROPIC|GOOGLE|GROQ|MISTRAL|DEEPSEEK|TOGETHER|REPLICATE|CEREBRAS|CLOUDFLARE|OPENROUTER|COHERE|FIREWORKS|PERPLEXITY|XAI|SAMBANOVA|HYPERBOLIC|NOVITA|DIGITALOCEAN|GEMINI)_API_KEY`
returns hits in exactly two places:

- `lib/agent/secret-scanner.ts` — twelve **detection patterns**. These are the grep's positive
  control: the pattern does match when the string is present, so the zero elsewhere is absence.
- `internal/providers/lib/providers/grok-voice.ts:52` — `!!process.env.GROK_API_KEY || true`, which
  returns `true` regardless. A vestigial read that decides nothing. Deleting it is a one-line task.

`packages/api/.env.example` documents no provider key, and `.github/workflows/deploy-aws.yml:65-76`
syncs exactly ten named secrets to SSM, none of them a provider credential.

---

## Task 2 — data migrations and rows before schema removal

This is the one inventory box this document earns:
*"Inventory data migrations and production rows before schema removal."*

### Migrations

22 drizzle migrations, `packages/api/drizzle/0000_mature_marauders.sql` through
`0021_overrated_killraven.sql`. Every one carries an `oxy:deploy-phase` marker; **21 are `pre`
(additive) and one is `post`** — `0016_jazzy_justin_hammer.sql`, the only migration in the chain that
drops anything, and what it drops is `cache_entries` and `cache_stats`, neither of which is in this
epic's scope.

**No migration in the tree drops a table any of workstreams 10, 11 or 12 names.** Those drops are
unwritten.

Because the chain interleaves phases, a from-zero run needs `--phase=all`; an incremental deploy runs
`pre` then `post` (`packages/api/src/db/migrate.ts:5-24`).

### The 21 tables in scope

From `docs/migration/ownership-matrix.json`, filtered to `kind: "table"` and workstream 10, 11 or 12.
"Created by" is the migration whose `CREATE TABLE` statement introduces it.

| table | ws | matrix owner | created by | fresh-schema rows | production rows |
| --- | ---: | --- | --- | ---: | --- |
| `alia_model_provider_mappings` | 10 | relay | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `alia_models` | 10 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `api_usage` | 10 | relay | `0000_mature_marauders.sql` | 0 | `UNMEASURED` |
| `chat_analytics` | 10 | alia | `0001_natural_vulture.sql` | 0 | `UNMEASURED` |
| `cost_entries` | 10 | relay | `0001_natural_vulture.sql` | 0 | `UNMEASURED` |
| `external_models` | 10 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `fallback_events` | 10 | relay | `0000_mature_marauders.sql` | 0 | `UNMEASURED` |
| `model_configs` | 10 | relay | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `provider_health` | 10 | relay | `0000_mature_marauders.sql` | 0 | `UNMEASURED` |
| `provider_keys` | 10 | relay | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `voice_call_usage` | 10 | alia | `0008_late_forge.sql` | 0 | `UNMEASURED` |
| `api_key_usage` | 11 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `developer_api_keys` | 11 | alia | `0004_ambitious_payback.sql` | 0 | `UNMEASURED` |
| `developer_apps` | 11 | alia | `0004_ambitious_payback.sql` | 0 | `UNMEASURED` |
| `credit_packages` | 12 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `features` | 12 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `plan_features` | 12 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `plans` | 12 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `subscriptions` | 12 | oxy | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `transactions` | 12 | oxy | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |
| `user_credits` | 12 | alia | `0003_closed_black_queen.sql` | 0 | `UNMEASURED` |

**No Mongo collection is in scope.** 17 Mongoose models survive in `packages/api/src/models/`
(agents, conversations, messages, organizations, skills and friends) and four more in
`packages/integrations/src/`, and none of them backs any of the 21 tables above. The routing
catalogue, developer identity and billing domains are Postgres-only.

### The fresh-schema column is a measurement, and it has a positive control

All 22 migrations were applied from zero to a throwaway `postgis/postgis:17-3.5` container on
2026-08-17 (`psql -v ON_ERROR_STOP=1`, all 22 clean, 83 relations in `public`). All 21 tables then
held **0 rows**, which establishes that **no migration seeds any of them** — seeding is a runtime act
(`internal/providers/lib/seed-model-configs.ts`, `seed-plans.ts`, `seed-features.ts`,
`seed-credit-packages.ts`, and `routing-config-audit.test.ts` records that the plan seeder has no
caller).

The counting statement was mutation-tested on that same database: inserting one `external_models` row
inside a transaction moved the count from 0 to 1, and the rollback moved it back. A zero from this
query therefore means an empty table, not a query that reads nothing.

### Production is UNREACHABLE from this audit

`~/.config/oxy/tokens/` holds no Alia database credential (it carries Cloudflare tokens, keystore
passphrases and three unrelated app secrets). No production count was taken, and **none is guessed**.
Separately, `api.alia.onl/health` returns HTTP 503, so the service is parked — historical rows are
still in the database, but nothing new is accruing.

**The exact command an operator must run.** It never prints the credential.

```bash
# The connection string lives in SSM, not in a repo or a dotfile.
export DATABASE_URL="$(aws ssm get-parameter \
  --name /oxy/alia/DATABASE_URL --with-decryption \
  --profile oxy --region us-west-2 \
  --query Parameter.Value --output text)"

psql "$DATABASE_URL" -tA -F'|' -c "
select t,
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from public.%I', t),
                           false, true, '')))[1]::text::bigint as rows
from unnest(array[
  'alia_model_provider_mappings','alia_models','api_key_usage','api_usage',
  'chat_analytics','cost_entries','credit_packages','developer_api_keys',
  'developer_apps','external_models','fallback_events','features',
  'model_configs','plan_features','plans','provider_health','provider_keys',
  'subscriptions','transactions','user_credits','voice_call_usage'
]) as t
order by t;"

# The positive controls, both required, in the SAME session.
#
# A — the statement executed at all. It must print exactly 21 lines. A broken
#     `unnest` or a `query_to_xml` that failed silently prints fewer, and a
#     short list of zeros reads exactly like a short list of empty tables.
#
# B — the database is not empty. If EVERY table in it is empty then the twenty-one
#     zeros above are a statement about the connection, not about the schema.
#     `n_live_tup` is an estimate and that is fine here: this control only has to
#     distinguish "some data exists" from "none".
#
#     Do NOT use `public.conversations` for this. It is a Postgres table with no
#     repository and no writer — the product still persists conversations through
#     the Mongoose model at `packages/api/src/routes/conversations.ts:4` — so it
#     is legitimately empty and would make the control blind.
psql "$DATABASE_URL" -tA -F'|' -c "
select relname, n_live_tup
from pg_stat_user_tables
order by n_live_tup desc
limit 10;"
```

Record the result and its date on #139. Per
[`compatibility-window.md`](./compatibility-window.md), an absence claim expires on its own: a count
taken today is re-taken before a drop lands.

### Two things the counts alone will not answer

- **After a port, the ABSENCE of a table stops being a signal.** Every inference in this inventory is
  therefore a row count, never "the table isn't there". Both halves of every dual-store domain were
  checked by listing the Mongoose models, not by assuming.
- **`chat_analytics` and `cost_entries` are the two instruments the alias removal gate depends on**
  (`compatibility-window.md`, removal gate (a).1), and neither appears in
  `packages/api/src/db/expiryTargets.ts`, so nothing sweeps them today. `api_key_usage` IS swept at
  90 days (`expiryTargets.ts:107`), so any measurement window over it must be shorter than that or
  the zero is partly a sweep artefact.

---

## Three findings that change the epic's blocked set

Recorded here because each contradicts something written down elsewhere in this repository, and a
stale blocker costs more than an open one.

**1. `@oxyhq/contracts` now ships the inference module, and Alia already depends on it.**
[`relay-client-gap.md`](./relay-client-gap.md) §0 recorded (2026-08-16, against `0.26.0`) that the
inference module was unpublished and that *"Alia adds no `@oxyhq/contracts` dependency in this
workstream"*. Both halves have changed. `packages/api/package.json:34` depends on `^0.27.0`; the
installed `0.27.0` ships twelve inference modules under `dist/types/inference/`; and **eleven Alia
modules import them** — the five under `lib/inference/` (`relay-client.ts:64`, `relay-request.ts:35`,
`relay-error.ts:30`, `relay-openai-adapter.ts:32`, `relay-boot-check.ts:54`) and six of their test
suites. A twelfth file matches the grep and is not an importer: `product-seam.test.ts:166` quotes the
specifier inside a string, testing that its own scanner ignores a commented-out import. That makes
L618 (*"Land shared contracts"*) `ALREADY_TRUE`.

**2. `0.29.0` adds `entitlement` and `accountBilling`, which workstream 12 has been waiting for.**
Measured from the published tarball: 129 files, 42 matching `inference` (positive control: 6 match
`session`), 78 `export` lines in `dist/types/index.d.ts`. The new modules export
`productEntitlementSchema`, `productPlanSchema`, `planAllowanceSchema`, `payAsYouGoEntitlementSchema`,
`costCenterSchema`, `accountBillingStateSchema`, `billingInvoiceSchema`, `reconciliationReportSchema`.
The `^0.27.0` range does **not** reach them. Bumping it is the first move on L469
(*"Define the final entitlement API between Oxy and Alia"*), which this audit classifies
`ACTIONABLE_NOW` on that basis.

**3. `availabilityScopeSchema` already carries exactly the five scopes workstream 17 names.**
`node_modules/@oxyhq/contracts/dist/cjs/inference/catalogue.js:144` defines them as
`internal_alia`, `public_payg`, `enterprise`, `byok_only`, `oxy_hosted` — installed today, at
`0.27.0`, imported by nothing in Alia. L604 is `ACTIONABLE_NOW` for the type and the refusal; only
the DATA (which route carries which scope) waits on Relay.

## What this audit does not measure

- **Runtime behaviour.** Every claim above is source, schema or a published tarball. No production
  request was made beyond one unauthenticated `GET /health`.
- **External consumers.** Whether anything outside this repository calls `/alia/chat`,
  `/v1/responses` or an `alia_sk_` credential is an access-log question, and the service is parked.
- **Relay's own repository, beyond its file tree and README.** Whether its adapters pass their
  conformance suite, and whether anything deploys it, were not run.

**This file goes stale in one direction: the repository moves and the verdicts do not.** 35 of the
246 rows were earned within a day of the audit, and five carried a claim that was wrong or became
wrong. Before acting on a row, check its `resolvedSince` and re-read the file:line it cites — a
verdict is a measurement with a date on it, not a standing fact.
