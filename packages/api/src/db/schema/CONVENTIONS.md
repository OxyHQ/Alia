# Postgres schema conventions — @alia/api

Binding for every table in this schema. Decision and reason, nothing else.

> Post-cutover note: many sections below reason from tables that no longer
> exist, and those references document immutable decisions only. Migration
> `0061_remove_alia_provider_credentials.sql` dropped `provider_keys` (Kaana is
> the sole credential custodian). Migration `0070_clean_cut_dormant_tables.sql`
> — the owner's clean cut, with no rollback window — dropped `provider_health`,
> `api_usage`, `fallback_events`, `auth_health_metrics`, `routing_logs`,
> `cost_entries`, `canvas_sessions`, `triggers`, `trigger_executions`,
> `external_models`, `model_configs`, `routing_profiles`,
> `routing_profile_provider_mappings`, `developer_apps` and
> `developer_api_keys`, plus `agents.allowed_models` and
> `automation_definitions.legacy_trigger_id`. Migration
> `0073_drop_sandbox_containers.sql` dropped the agent sandbox's persistence —
> the sandbox never ran in production: `containers`, `container_templates`,
> `agent_session_resources` and `agents.preferred_image`. Where a rule below is
> argued from one of them, the rule stands and the example is historical.

`packages/integrations/src/db/schema/CONVENTIONS.md` established the toolchain on
the smallest service. This file does NOT repeat it — read that one first. What
follows is only where `packages/api` differs, and it differs in the two ways that
matter most: **it has live production data**, and **its ids are already on the
wire**.

The mechanics ship in **`@oxy.so/db`**: column builders, the casing authority, the
migration ledger and deploy phases, the driver-error helpers, the expiry sweep,
the throwaway test harness. A local copy of anything that package owns is a
second thing to keep in lockstep.

---

## Legacy 24-character hex ids are PRESERVED, verbatim

This is the sharpest difference from integrations, which was a genuine greenfield
and kept nothing.

`packages/app` and `packages/alia-chat` read `._id` in **137 places**. It is a
wire contract with shipped mobile builds that cannot be recalled. So older rows
keep their 24-character hex `_id` as a `text` primary key — **not** a uuid v7,
however much the rest of the ecosystem prefers one.

New rows use `generatedId()` (uuid v7) in the same column. The two coexist
because nothing parses the value; it is an opaque identifier on both sides. Do
not add a CHECK constraining its shape — that would forbid exactly the mixture
the table holds.

**A consequence worth stating: id order is not creation order.** The hex ids
embed a timestamp and a per-process counter, so they sorted by creation within a
second; uuid v7 is monotonic only to the millisecond and this implementation uses
no counter, so two ids minted in the same millisecond order arbitrarily. Anything needing creation order must sort by an explicit timestamp
column with the id only as a tiebreaker. Keyset pagination is unaffected — it
needs a total order, not a meaningful one.

## Postgres is REQUIRED at boot, and there is no `tryGetDb()`

Cutover happened. `runBootGuards()` refuses to start the process without
`DATABASE_URL`, before the socket opens, and `getDb()` is the only accessor —
it throws rather than returning `null`. `tryGetDb()` is deleted: its single
caller answered the null by returning early, which turned "the database is
missing" into "there was nothing to do".

`connectPostgres()` still answers `null` for an unconfigured URL rather than
throwing, because the decision "this is fatal" belongs to boot rather than to
the module that opens a pool. What is gone is any code path that CARRIES that
null.

Postgres is this service's only store. `integrations` is a separate process with
its own schema and migration ledger.

## Closed value sets, and the ones deliberately left open

`text` + an explicit CHECK rendered from the same `as const` tuple, per the
integrations file. `text({ enum })` emits no DDL.

**The tuple is IMPORTED from `src/domain/`, never retyped.** A CHECK written from
a second copy can disagree with the request validator guarding the same column —
and the disagreement is invisible until a write hits one and not the other. The
validator and this schema's CHECK both read the one tuple
(`MODEL_PRICING_TIERS`, `PROVIDER_KEY_TIERS`, `TRANSACTION_TYPES`, …).

**They live in `src/domain/`, and each module there is a LEAF: it imports
nothing.** The schema imports these tuples as RUNTIME values, so anything a
tuple module imported would become a dependency of `db/schema/index.ts` — and
when the schema fails to load, **`drizzle-kit` reports that failure by
generating NOTHING while exiting 0.**

`db/__tests__/schemaModelIndependence.test.ts` asserts that no `domain` module
imports anything. The regression it guards is one `import` line that typechecks
and leaves every suite green; it bites on the day the imported module moves, in
a different PR, naming the mover rather than the author.

`ROUTING_TIERS` is the case that forced the rule: the routing-profile tier and
the former model-config tier were one vocabulary written as two identical
thirteen-value literals in two files, so there was no single tuple to render a
CHECK from. It now lives in `internal/providers/lib/routing-tiers.ts` beside
`provider-names.ts`. `model_configs.alia_tier` has since been dropped
(`0049_the_tier_column_cannot_be_correct`) — one column could not record a
many-to-many mapping — so the tuple renders exactly one CHECK today,
`routing_profiles_tier_check`.

**`auth_health_metrics.method` has NO CHECK, on purpose.** The source field was
a bare string with no enum, so production may already hold values outside
`AUTH_METHODS`. A CHECK here would fail on the first write of an unexpected
value, in the authentication path. The tuple stays a TypeScript narrowing;
widening it to a CHECK is a decision for **after** an audit of what is actually
stored.

The columns that have taken this answer, so the reasoning is not re-argued per
column: `auth_health_metrics.method`, `chat_analytics.platform`, and
`voice_call_usage.provider` / `.audio_format` / `.disconnect_reason` /
`.client_type` (that table was dropped by 0072, and the reasoning is kept for
the next column like it). **`voice_call_usage.provider` is the one worth reading twice**,
because `PROVIDER_NAMES` exists and renders CHECKs on three columns in
`providers.ts` — so the tempting move is to reuse it. Its source field was a
bare string with no enum, and the write happens during session teardown,
where the alternative to storing the row is losing the billing record for a call
that already happened.

**Every enum in this schema is subject to that same doubt.** Audit stored values
before closing an open set — and in the same invocation as the migration that
closes it, because an audit whose result can expire between running it and using
it is not a gate.

### A vocabulary somebody else owns never gets a CHECK

That doubt is about what THIS service may have written. There is a
second, sharper case: a column whose value set is defined by a third party.

**`subscriptions.status` is the worked example and has no CHECK.** The tuple lists
seven Stripe subscription statuses; Stripe also has `paused`, which is not among
them. A CHECK rendered from that tuple would reject a billing webhook the first
time a customer pauses, for a value Stripe considers ordinary — and no audit can
fix that, because the offending value has not been invented yet. `plans.currency`
is the same call for the same reason.

This is the `jsonb` test applied to a scalar: if the FORMAT belongs to somebody
else, this schema does not get to close it. Alia's own vocabularies —
`transactions.type`, `transactions.status`, `billing_period`, `product`,
`feature_type`, the Alia tiers — all do carry CHECKs.

`billing.pgdb.test.ts` inserts a `paused` subscription, so adding that CHECK
later fails there rather than in production.

### Adding a value to a closed set is a MIGRATION, in the same commit

`PROVIDER_NAMES` renders a CHECK on three columns. Appending to it therefore
changes the database and not just TypeScript: ship the additive (`pre`) migration
widening the CHECK in the SAME commit as the tuple, or the first write naming the
new provider fails in the routing path. Mercaria's `ALL_CURRENCY_CODES` rule,
arrived at independently and for the same reason.

### Which source validations become CHECKs, and which do not

Three classes, decided once so each column does not get re-argued:

- **A declared `enum`** → a CHECK, rendered from the tuple, subject to the
  audit above. Unless a third party owns the vocabulary.
- **A declared `min`/`max` on a number** → a CHECK. These are domain invariants:
  a `quality_score` outside 0..100 silently corrupts the ordering
  `getNextProvider` depends on, and a negative `spent_usd` would defeat a spend
  limit. `provider_keys.current_priority` is bounded 1..1000 while
  `original_priority` is 1..100 — not a typo, and not to be unified: the first
  absorbs the displacement `recordFailure` applies by setting it past the current
  maximum, and one shared bound would make the demotion itself a violation.
- **A declared `maxlength` on a string** → NOT ported. These shape INPUT at the
  write path, where the request validators already sit; as CHECKs they would
  enforce nothing anybody relies on and would fail on a legacy long string. `text` throughout, as everywhere else in Oxy.

Where the source declared NOTHING, neither does this schema — `user_credits` has no
non-negativity CHECK even though a negative balance is obviously wrong, because
`addCredits` accepts a negative amount and production may already hold one. A
CHECK there would fail in the deduction path. That is an audit item, not a
constraint to add on the way past.

## Nested sub-documents become COLUMNS, not `jsonb`

`routing_logs` is the worked example: `classification` and `routedTo` were
sub-documents and are now `classification_*` and `routed_to_*` columns. Both have
a fixed, known shape this service owns, so `jsonb` would only hide them from a
CHECK and from the planner.

`jsonb` is reserved for values whose FORMAT belongs to somebody else, or which
have no queryable identity. The register, kept current as batches land:

| Column | Why it earned `jsonb` |
|---|---|
| `fallback_events.attempts` | An ordered list read whole for display, addressed nowhere. |
| `transactions.metadata` | Shaped by whichever call site wrote it, different per transaction type. |
| `messages.content` | Genuinely polymorphic — a bare string OR an ordered parts array, and the shape is the AI SDK's. |
| `messages.tool_invocations` | An ordered list read whole; its `args`/`result` are `Mixed`, so a child table would hold two opaque values anyway. |
| `canvas_sessions.components` | Returned verbatim as a response body; each element's `data` is `Mixed`. |
| `context_nodes.metadata`, `context_edges.metadata`, `context_sources.metadata` | `Record<string, unknown>` composed by whichever ingestion path wrote the row. |
| `retrieval_strategies.source_steps` | See the counter-case below — structured, but nothing reads it. |

`provider_health.latency_samples` is `double precision[]` rather than `jsonb` for
the same reason inverted — a bounded window of plain numbers, and an array stays
summable in SQL.

**`external_models`' eighteen benchmarks are COLUMNS, and the read path is the
argument.** They looked like the strongest `jsonb` candidate in the batch: a
sub-document of optional scores, published by a third party who will add a
nineteenth. But `routes/external-models.ts` filters on four of them being
non-null and sorts by two, so they have exactly the queryable identity `jsonb` is
reserved for lacking. The cost is stated rather than hidden: a new upstream
benchmark is an additive migration.

### An ARRAY of sub-documents is a CHILD TABLE, not either of those

`routing_profiles.providerMappings` was a sub-document array and is now
`routing_profile_provider_mappings`. It looked identical to
`fallback_events.attempts` and is not the same thing: each element carries a
REFERENCE to `model_configs` and a per-element `is_active` toggle, so `jsonb`
would hide a foreign key inside an opaque value and leave "does this mapping
point at a model that still exists" unanswerable in SQL.

The test is not "is it an array" but **does an element have an identity of its
own** — a reference, a toggle, an ordering that something filters on. A child
table is also what makes `UNIQUE(routing_profile_id, model_config_id)`
expressible at all.

**`retrieval_strategies.source_steps` is the counter-case, and it is `jsonb`
despite passing that test on paper.** Its elements carry an `order`, a
`required` toggle and a `source_key` naming a `context_sources` row — three
identity signals, the `routing_profile_provider_mappings` shape almost exactly. It is
`jsonb` because **nothing reads it**: the whole-package grep returns two sites
and both are writes, each building the array from a hardcoded constant, while
the one loader tests only that a strategy row EXISTS. A child table would add
rows, a foreign key and an index to model a copy of a compile-time constant that
no query touches.

So the test has a second half: an element needs an identity **that something
exercises**. Reading the shape alone gets this one wrong. And because "nothing
reads it" is a fact with a date on it, the file names the trigger for
revisiting — the moment retrieval actually follows a strategy, the elements
acquire readers and it becomes a child table.

### An array of BARE REFERENCES is a child table too, and `populate` is the test

Batch 9 adds the case the rule did not cover: an ObjectId array whose elements
are not sub-documents at all — `Agent.skills`, `Agent.knowledge`,
`AgentTeam.agents`/`.skills`/`.knowledge`. There is no per-element data to
inspect, so "does an element have an identity" cannot be answered by reading the
shape. What answers it is `.populate()`: `routes/agents/crud.ts:166` and
`routes/agent-teams.ts:19-21` both do it, and a populate IS a join.

`text[]` was the alternative and it loses two things. It cannot carry a foreign
key, so "does this agent's skill still exist" stays unanswerable in SQL — the
`routing_profile_provider_mappings` argument unchanged. And `routes/agent-teams.ts:161,184`
mutates the member list with `$addToSet`/`$pull`, which is set semantics that
`UNIQUE(parent, child)` expresses exactly and an array does not.

Two things a child table must then carry that the array gave for free:

- **`position`**, because the array was ordered and the write path replaces it
  whole. Without it the round trip is a set and the rendered order is arbitrary.
- **the CASCADE decision, stated.** An array leaves a deleted skill's id behind
  and `populate` silently drops it on read, so an agent's skill list shrinks
  with nothing recording why. `ON DELETE CASCADE` removes the link with the
  skill, the same call `routing_profile_provider_mappings.model_config_id` made.

### A sub-document GROUP that is `default: undefined` is nullable COLUMNS, and the absence can be load-bearing

`Agent.permissions` and `Agent.soul` are both declared `default: undefined`, so
the group is present or wholly absent. Flattened, that is a run of NULLABLE
columns — and for `permissions` the NULL is not merely "unset", it is a VALUE:
the model's own comment reads "undefined = all allowed (backward compatible)",
and `lib/agent/actions.ts:272` tests `perms.delegation === false`, so only a
stored `false` denies anything.

`notNull().default(false)` is the shape that looks tidier and it would revoke
filesystem, network, shell, communications, MCP and delegation from every agent
written before the group existed — silently, because an agent being refused a
capability raises nothing. `agents.pgdb.test.ts` pins both the all-NULL row and a
PARTIALLY written group, the second because no cross-field rule was ever
enforced and a "all six or none" CHECK would reject rows production may already
hold.

## Foreign keys: per reference, and say why

`oxy_user_id` and every other Oxy account id carry no foreign key anywhere: Oxy
owns identity, this service reaches it over HTTP, and a shadow users table would
be a cache that can disagree. See `lib/oxy-user-hydration.ts` for how one is
resolved.

**`api_usage.key_id` stays without one, and the providers batch is what settled
it.** `provider_keys` now exists, so the question is no longer "is the target
ported" but "what should a key's deletion do to the record that it was used" —
and keys really are hard-deleted (`deleteProviderKey`,
`db/providers/providerKeyRepository.ts`). Every available answer is worse than
none:

- a cascade deletes the audit, which is the one thing the row exists for;
- `ON DELETE SET NULL` is unrepresentable — the column is `notNull`, and making
  it nullable to accommodate a delete erases the attribution that IS the content;
- `RESTRICT` makes a key undeletable for 48 hours after any use, turning a
  working operation into an error.

`deleteProviderKey` has no HTTP caller today — the admin route that called it
went with the rest of the never-mounted `/internal/gateway` surface — so the
delete is reachable only from code and its own test. The decision above does not
change with that: the function is live, tested, and the next surface to expose
key management inherits exactly this trade-off.

So a dangling id, deliberately, bounded by the 48-hour sweep. Write the reason
down rather than the absence: "no FK" and "nobody decided" look identical later.

**Within a batch, a genuine relation gets a real constraint.** Both references on
`plan_features` and both on `routing_profile_provider_mappings` are foreign keys with
`ON DELETE CASCADE`, because each child is meaningless without its parent and a
survivor would be silently re-adopted by a re-created row of the same name.
Both endpoints of `context_edges` are the same call for a sharper reason: an
edge IS a pair of node references plus a type, so nothing survives losing one.
The invariant is already maintained by hand (`context-graph.ts:272` writes the
edge only inside `if (userNode && assistantNode)`) and nothing in the package
deletes a node, so the CASCADE constrains no behaviour that exists today and
decides what happens when a retention policy eventually does.

**A relation is NOT always a foreign key, and `messages` is where this batch says
no.** Its `conversation_id` names a real parent, on the business key rather than
on `_id`, and there is no constraint — because `POST /conversations` in
`routes/conversations.ts` creates the conversation and inserts the messages
inside ONE `Promise.all`.
Parent and child are written concurrently, so a foreign key would convert a
working write into a race-dependent `23503` on whichever statement lost. The
`api_usage.key_id` reasoning applied to an ordering rather than to a deletion:
every available answer is worse than none, so write down which one was chosen.
`routing_profile_provider_mappings.model_config_id` CASCADES: a mapping left
behind when its `ModelConfig` was deleted would have `getNextProvider` hand the
router a provider whose configuration no longer existed.

### One parent, four children, four DIFFERENT deletion rules

Deleting an agent touches only the `agents` row, so what happens to its
sessions, reviews, templates and team memberships is decided by their foreign
keys. Each child is a separate decision, and the four answers are all
different.
Worth keeping together, because the temptation is to apply one rule to a whole
batch:

| Child | Rule | Why |
|---|---|---|
| `agent_sessions.agent_id` | **no FK** | A session is the record of work a PERSON asked for and spent credits on — their `task`, `result` and event stream. CASCADE deletes their history; `SET NULL` is unrepresentable on a `notNull` column; `RESTRICT` makes an agent permanently undeletable once anybody has run it. `trigger_executions.trigger_id`. |
| `agent_reviews.agent_id` | `CASCADE` | The row's entire content is an opinion of one agent, and `lib/agent-rating.ts` already returns `null` rather than recomputing once it is gone. `plan_features`. |
| `agent_session_resources.session_id` | `CASCADE` | These rows WERE the session document — an embedded array — so they cannot outlive it by construction. The least arguable in the batch. |
| `container_templates.agent_id` | `SET NULL` | The **one** place that answer is available, and the contrast with `api_usage.key_id` is why: there the column was `notNull` and the id WAS the row's content, so nulling it erased the record. Here the row is a snapshot tag that stands on its own and the association is an optional convenience. |

`agent_sessions.parent_session_id` is a fifth, self-referencing: `SET NULL`, so a
delegated run survives its parent's deletion and merely stops claiming one.

**And batch 9d puts two references to the SAME parent on opposite sides**, which
is the clearest statement of what the question actually is. Both name
`agent_sessions`:

- `event_stream_entries.session_id` **CASCADES**. It is the session's own log,
  unreadable once the session is gone, and it is the largest table in the domain
  by row count — the one place orphans would accumulate without bound.
- `containers.session_id` **has no foreign key at all**. It is the AUTHORITY for
  a live Docker sandbox, with its own lifecycle columns and its own lookup key
  (`lib/agent/terminal-session.ts:250` and `lib/agent/tools.ts:386` find a row by
  `container_id` alone, never through its session). Deleting the row does not
  stop the container, so a cascade would destroy the only record of a sandbox
  that is still running and still costing money.

So the question is never "does this point at the parent" — it is **what is this
row, and what is lost when it goes**. A log, a copy of the parent's own state,
somebody's history, and a live resource's only record all point at the same
table and want four different answers.

### Two bounds on one word, and they must not be unified

`AgentReview.rating` is `min: 1` and `Agent.rating` is `min: 0`, and both are
ported as declared. That is not an inconsistency: a review is somebody's 1-to-5
score, while the agent's is an AVERAGE that is legitimately 0 when nobody has
reviewed it. Collapsing them either admits a nonexistent 0-star review or refuses
every agent that has none. `agentSessions.pgdb.test.ts` asserts both halves in
one case so the pair cannot be tidied apart.

**A foreign key must target `unique()`, never `uniqueIndex()`.** drizzle-kit
emits every `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` BEFORE every
`CREATE UNIQUE INDEX`, whatever the source order — measured in `0003`, where the
four FK statements are lines 339-342 and the first `CREATE UNIQUE INDEX` is 343,
and again in `0009`, where they are lines 72-73 against a first
`CREATE UNIQUE INDEX` on 74. A FK pointing at a unique INDEX therefore generates
cleanly and fails at APPLY time with `42830: there is no unique constraint
matching given keys`. `unique()` is emitted inline inside `CREATE TABLE`, so it
already exists. This is why `plans.plan_id` and `features.feature_id` — both FK
targets, both business keys rather than surrogate ids — are the only two
`unique()` declarations in the schema while everything else uses
`uniqueIndex()`.

### A SELF-reference is emitted; a CIRCULAR one between two tables is DROPPED

drizzle-kit silently drops a circular foreign key — the declaration typechecks,
no `ADD CONSTRAINT` is emitted, nothing reaches the snapshot, and the column
enforces nothing while reading as correct. Measured in Mercaria on
`awin_advertisers.activating_sample_id`, which had to be reverted to a plain
column with the reason recorded.

**`agent_sessions.parent_session_id` is a self-reference and it is NOT affected**,
verified in all three artefacts: the `ALTER TABLE … ADD CONSTRAINT` is in
migration `0014`, the constraint is in `0014_snapshot.json`, and
`agentSessions.pgdb.test.ts` reads it back out of `pg_constraint` by name with
its `confdeltype`. Two things appear to make the difference and both are easy to
lose in a refactor: it is declared through the table-level `foreignKey()` helper
rather than a column-level `references((): AnyPgColumn => …)`, and it is one
table pointing at itself rather than a cycle between two.

**Verify any self- or circular FK against the GENERATED SQL, never the
declaration** — and against the live catalogue if it is load-bearing, which is
what the `pg_constraint` case is for. The behavioural test beside it also
detects a dropped constraint (confirmed by deleting the `ADD CONSTRAINT`
statement outright and watching it go red), but it fails as a puzzling
difference in deletion behaviour rather than by naming the thing that is
missing.

**A PRIMARY KEY target is exempt, and `context_edges` is the case.** Both its
endpoints reference `context_nodes.id`, which is emitted inline in
`CREATE TABLE` exactly as `unique()` is, so the ordering above cannot bite. It
is written down because the rule as stated invites a redundant `unique()` on a
column that already has a primary key — and because the exemption is about the
target being emitted INLINE, not about it being a key, so it does not extend to
any other column.

Deferred, with the reason rather than by omission: `provider_keys.organization_id`
(the `organizations` table is not ported), and `api_key_usage.api_key_id` /
`app_id` (`developer_api_keys` and `developer_apps` are not ported, and both are
genuinely optional — a session-authenticated call has neither, which is what
`auth_type` records).

## There is no TTL index — the registry is not optional

Postgres has no TTL index. `db/expiryTargets.ts` is the registry, **and
`db/expirySweeper.ts` is its caller** — the two land in the same change, always.
A registry with no caller makes the omission visible and does nothing to the
rows; that is how a sibling service carried ghost rows in production for weeks.

`db/__tests__/ttlRegistryCoverage.test.ts` holds the closed record of declared
TTL rules and fails when one has no matching registry entry.

**A deadline COLUMN is not a TTL, and `rollback_records` is the case.**
`rollback_records.expires_at` bounds the rollback WINDOW, not the row's life, so
these records accumulate and the registry gets no entry. The TTL record cannot
catch a WRONG addition here — the table declares no TTL, so it is silent either
way — which is why `agentsSupport.pgdb.test.ts` asserts an ancient row SURVIVES a full-registry
sweep. Mutation-tested by registering the table with `retentionSeconds: 0`.
The asymmetry that decides it is the one this section already states, pointed at
an audit trail: a missing entry grows a table, a wrong one deletes the record of
every destructive action an agent took.

**It checks the RULE, not the presence of an entry** — the retention seconds, the
column measured from, and whether the source declared a `partialFilterExpression`
the flat registry type cannot express. The asymmetry is the argument: a MISSING
entry grows a table forever, which is eventually loud and recoverable; a WRONG
one deletes live rows, which is silent and is not.

**`Notification` is the conditional case.** Its TTL is 90 days from `createdAt`
*where `status = 'dismissed'`*, and the only registry entry the type permits
would delete every notification older than 90 days including undismissed ones.
The answer is not a predicate field on the shared type — it is to make the
CONDITION a COLUMN (`dismissed_at`, written only on dismissal, bound to `status`
by a CHECK). Measuring from `createdAt` instead would make a notification
dismissed on day 89 vanish the next day while one dismissed on day 1 survived
another 89. Mercaria's
`packages/backend/src/db/expiryTargets.ts` is the reference implementation.

## One migration ledger

`@oxy.so/db` owns the only migration ledger: it records which **SQL files** were
applied to Postgres, with `pre`/`post` phases. There is no second runner and no
`runPendingMigrations()` call in `index.ts`; a second ledger would assert history
the database never saw.

## Account columns are named for what they hold

Every table names the account `oxy_user_id`, or carries the role in a prefix
(`owner_oxy_user_id`, `author_oxy_user_id`, `creator_oxy_user_id`,
`credit_reservation_oxy_user_id`). The fact travels in the column name rather
than in a comment.

**The same word can mean opposite things one table apart.**
`agents.author_oxy_user_id` IS an Oxy account — `routes/agents/crud.ts` writes
`req.user.id` into it. `skills.author` is a DISPLAY STRING — `lib/seed-skills.ts`
writes `'Alia'` and `'Community'` — and deliberately has no suffix, because adding
one would assert something false. A field name is not evidence in either
direction, so read the WRITER.

## The clock in a lease is the SERVER's

`leases` is acquired and renewed by ONE conditional statement comparing against
`now()`, never against a JavaScript `Date`. Two ECS tasks whose clocks disagree by
more than the lease TTL would otherwise both believe they hold it, which is the
single failure that table exists to prevent.

`acquired_at` is preserved across renewals by the same holder and reset only when
leadership changes hands. It is diagnostic and is deliberately not part of the
acquire predicate.

## A `Date` in a raw `sql` template throws in the DRIVER

Interpolating a JS `Date` into a `sql` template fails at SERIALISATION, before
the server sees the statement: `The "string" argument must be of type string …
Received an instance of Date`. Bind an ISO string with an explicit cast instead —
`${iso}::timestamptz`.

This is usually described as a range-constructor problem. It is not limited to
one: it bit a plain parameter in `db.execute` in this package's own suite. `tsc`
cannot see it, so only a real server catches it.

## Money is `bigint` minor units; a RATE is `double precision`

Two different things, and the split is not a judgement call:

- **An amount somebody is charged** → `bigint({ mode: 'number' })`. Every price
  in `billing.ts` is handed to Stripe as `unit_amount` or read back as
  `amount_total`, both integer cents, so the Oxy convention applies unmodified.
- **A derived per-token rate or an accumulated estimate of one** → `double
  precision`, per `cost_entries.cost_usd`. `model_configs.pricing_cost_per_1m_*`
  and `provider_keys.spent_usd` are that: fractions of a cent with no minor unit
  to hold them, where rounding to cents at write time destroys the figure.

`credits` is neither — a count, so `integer`.

**The read side has a trap that `tsc` cannot see.** postgres.js decodes
`bigint`/`int8` as a STRING. `mode: 'number'` escapes that for a COLUMN, but an
AGGREGATE has no column builder to carry the mode, so `sum()`/`max()` come back
as strings while typing as numbers, and `max + 1` is string concatenation.
Coerce explicitly at that boundary.

A test that performs ONE aggregation cannot catch this — `max` over a single row
plus one gives the same answer either way. `billing.pgdb.test.ts` does two
sequential appends, which is what makes `"7" + "1" = "71"` distinguishable
from `8`.

**A bare `number` holding an EPOCH MILLISECOND needs `bigint`, and the
column type is the only place that says so.** `event_stream_entries.timestamp`
is written from `Date.now()` (`lib/agent/event-stream.ts:89`) — around 1.76e12,
some 800 times past the `integer` maximum — while TypeScript types it a plain
`number` with nothing naming the unit. `integer` would reject the very first
write. `agent_sessions.stats_total_tokens` is the same call for a different
reason: it accumulates across every step of a session rather than being large to
begin with. `event_stream_entries.seq` stays `integer` deliberately, because it
counts events within ONE session and `config_max_steps` bounds it.

The read trap above applies to all three, and `eventStreamEntries.pgdb.test.ts` and
`agentSessions.pgdb.test.ts` each assert BOTH paths — the builder returning a
number and a raw `db.execute` returning the string — rather than only the one
their own code happens to use.

**`mode: 'number'` is narrower than "for a COLUMN" suggests, and the difference
was MEASURED rather than reasoned about.** The mode is applied by drizzle's
result mapper, which runs only for a query the QUERY BUILDER constructed. A raw
`db.execute(sql\`select size …\`)` returns whatever postgres.js decoded. So one
`bigint` column, in one row, reaches JavaScript as:

| Read | Type |
|---|---|
| `db.select({ size: libraryFiles.size })…` | `number` |
| `db.execute(sql\`select size from …\`)` | `string` |
| `sum(size)`, however issued | `string` |

`tsc` types all three `number`. This matters more than it looks, because **every
`*.pgdb.test.ts` in this package takes the raw path** — so a test asserting a
`bigint` column round-trips is asserting the string, and a repository that mixes
builder queries with raw SQL for what the builder cannot express gets two
JavaScript types for one column. `library.pgdb.test.ts` pins both halves against
a real server; it is what caught the claim this paragraph originally made.

## A write-time transform must be STRUCTURAL, not a call-site convention

drizzle has no field-level setter. A column whose value must always be
transformed — encrypted, case-folded — needs that guarantee re-established
structurally, not remembered at each call site.

Two in this schema, with opposite answers:

- **`integrations` / `connected_accounts` OAuth tokens** are encrypted on every
  write. Plain `text` would demote "encrypted on every write" to
  "encrypted wherever somebody remembers", and the failure is SILENT — the app
  keeps working and third-party tokens sit in plaintext until a dump leaks. They
  use the `encryptedText` custom type (`columns.ts`), which is the only available
  shape where drizzle applies the transform to every write it builds — the
  difference between "a plaintext token CANNOT be stored" and "must remember not
  to", which is the whole decision for a column holding somebody else's
  credential. A write chokepoint would have downgraded a guarantee that held on
  every write to one that holds on every write *through that function*, defended
  by a test rather than by the type.

  `columns.ts` holds the full reasoning, including why `pgcrypto` is rejected
  rather than deferred.
- **`organizations.slug`** is case-insensitively unique, so the answer is a
  FUNCTIONAL unique index on `lower(slug)` rather than a transform: a plain
  unique on the stored text lets `Acme` and `acme` coexist, silently widening
  the namespace organizations are addressed by. A CHECK asserting the column is
  already lowercase was rejected — it would fail on any row a non-validating
  write path stored differently, where the functional index simply works
  whatever case is stored.

**A fixture for either MUST be in the un-normalised form.** Two already-lowercase
slugs behave identically under a plain unique and a functional one, so a test
seeded that way passes while measuring nothing.

**A rule enforced in APPLICATION code, not by a setter, gets the same
treatment.** `user_memory_entries` is the case: nothing normalised the title,
but `lib/tools/user-memory.ts:60` matches an existing memory with
`m.title.trim().toLowerCase() === normalized` and `:174` refuses a rename that
would collide the same way — so `lower(trim(title))` IS the application's
identity for a memory, stated twice in one file. So
`UNIQUE(user_memory_id, lower(trim(title)))` enforces it: two memories
differing only in case or whitespace collide, which is precisely the pair the
application already believed was one. The fixture that proves it is
`'Coffee Preferences'` against `'  coffee preferences  '`; the column keeps what
was written, so nothing rewrites a user's own words — and the embedding, which
stores that RAW title as its key, still matches.

Not every setter earns this. `organization_invites.email` is `lowercase, trim`
too, and no unique index depends on it, so it is a lookup-normalisation concern
for the repository rather than a constraint, and no functional index was added.

## Historical credential-at-rest decision

Before Kaana custody, **`provider_keys.key` held a PLAINTEXT provider API key.**
Not a hash — `key_hash` was that, and the retired `lib/key-manager.ts` read the
plaintext to sign an upstream call. Migration 0061 now drops that whole table
without selecting, exporting or copying its contents. This section is retained
only as the security rule that governed the historical Postgres port.

While the historical table existed, the rule was:

- never `select()` this table whole. Name columns, and leave `key` out of every
  projection but the one call that must sign a request;
- it must never reach a log line, an error, a metric label or an admin response.
  `key_prefix` exists for display and is the only identifier safe to show;
- `key_hash` is NOT a safer alias. A hash of a credential is an exact-match
  oracle, so it is equally protected.

## `generatedId()` is wrong exactly once

`user_credits.id` is an OXY ACCOUNT ID, so the table is keyed by the account
rather than by a row identity. It is `text().primaryKey()` with **no default**: a uuid v7
would quietly mint a row no lookup could ever find, and the failure would present
as a missing balance rather than as a bad insert.

Everywhere else `generatedId()` is right: the app mints uuid v7 for new rows in
the same column that holds the older hex ids.

## Recover-after-duplicate-key must stay OUTSIDE a transaction, and chat has one

**In Postgres one failed statement aborts the ENTIRE transaction** (`25P02`):
every later statement fails, including a plain read, until it rolls back. So
"insert optimistically, catch the duplicate, recover" works only when the
recovery runs on a clean session.

`saveConversation` in `lib/conversation-saver.ts` is exactly that shape and it is
deliberate, not sloppy: it appends messages optimistically, reads a duplicate key
on `messages_oxy_user_conversation_seq_key` as "a concurrent append claimed this
seq", and converges with a delete + full re-insert.

**The sequence stays OUTSIDE a transaction.** The append, the delete and the re-insert are three separate
statements on the pool, so the refused insert aborts nothing and the recovery
runs on a clean session. `isUniqueViolation(err, APPEND_SEQ_INDEX)` from
`@oxy.so/db` reads the SQLSTATE off `cause` — where drizzle puts it — and names
the index, so a future unique on `messages` cannot start triggering the rewrite
for an unrelated reason. `lib/__tests__/conversation-saver.pgdb.test.ts` produces
the race for real, by claiming the seq between the read and the insert.

What must not happen is the natural-looking refactor that puts the whole function
in a `db.transaction(...)` and leaves the `catch` in place — the recovery then
fails with `25P02` and the message history is left deleted. Note that the delete
and the re-insert INSIDE `replaceMessages` are one transaction, which is a
different statement pair and safe: nothing catches across it.

## `rowCount` is not "rows changed" — decide per call site

Postgres reports one number, `rowCount`, and what it means depends on the
statement. Each call site that reads a write count is a decision rather than a
mechanical rule.

- **Rows matched** — `rowCount` directly. A no-op update still reports
  `UPDATE 1`.
- **Rows actually CHANGED** equals `rowCount` only when the statement's own
  filter already excludes rows that would not change. A reset whose filter is
  empty matches already-healthy rows too, so `rowCount` over-reports and that
  statement needs an `IS DISTINCT FROM` predicate. Adding such a predicate where
  it is not needed is its own bug — it can turn a successful repeat into a 404.
- **Created versus updated** is not recoverable from `rowCount`, because
  `INSERT … ON CONFLICT DO UPDATE` reports one row affected on both. It needs
  `RETURNING (xmax = 0) AS inserted`. An insert-only upsert is
  `ON CONFLICT DO NOTHING`, where the empty `RETURNING` set IS the answer.

**A single call cannot tell any of these apart.** The discriminator is a REPEATED
call, so a test that runs once proves nothing about which semantics it got.

## Tests run against a REAL Postgres, in their own config

`vitest.pg.config.ts` + `*.pgdb.test.ts`, separate from the default config
because this suite needs a real server over TCP. Merging them would make every
`bun run test` fail on a machine without Docker, which is how a suite gets
disabled by whoever hits it next.

Assert driver errors through `@oxy.so/db`'s helpers, never a message regex —
drizzle wraps the failure so `code` and `constraint_name` live on `cause`. Name
the CONSTRAINT too: `isUniqueViolation` alone cannot tell the index under test
from any other index on the table.

### A fixture that is DELIBERATELY EXPIRED must be written in a transaction

One database serves the whole run and vitest runs FILES in parallel, so every
committed row is visible to every other file. Most fixtures are safe because
they are addressed by an id nobody else uses — but a sweep deletes **by age,
not by owner**, and four files call `sweepAllExpiredRows(db, EXPIRY_TARGETS)`
with the FULL registry. So a stale row committed anywhere is fair game to all
of them.

That failed intermittently and reads as a broken commit: `schema.pgdb.test.ts`
inserted a 3-day-old `api_usage` row and asserted its own sweep deleted at
least one, and another file's sweep reaped it in between. **Measured on the
whole suite in parallel: 3 red in 10 before, 0 red in 20 after.** The failure
moves between files and its message says nothing about concurrency, so the
first suspicion falls on whatever changed most recently.

Write such a fixture inside `db.transaction(...)` and pass the `tx` handle to
the sweep. An uncommitted row is invisible to every other connection, so no
other sweep can take it, while the transaction's own sweep still sees it —
`SqlExecutor`'s doc comment says it exists precisely so a sweep can run inside a
caller's transaction. Keep the count assertion at `>= 1` rather than tightening
it to exactly one: the transaction still sees committed expired rows, and
pinning the number trades this flake for a coupling to other files' data.

**And assert the count, not only the survivors.** The `cache_entries` case had
the same exposure with a quieter symptom — it checked only which rows remained,
so another file's sweep doing the work left it green while measuring nothing
about the sweep it called.
