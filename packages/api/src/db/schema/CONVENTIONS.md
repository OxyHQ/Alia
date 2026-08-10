# Postgres schema conventions — @alia/api

Binding for every table in this schema. Decision and reason, nothing else.

`packages/integrations/src/db/schema/CONVENTIONS.md` established the toolchain on
the smallest service. This file does NOT repeat it — read that one first. What
follows is only where `packages/api` differs, and it differs in the two ways that
matter most: **it has live production data**, and **its ids are already on the
wire**.

The mechanics ship in **`@oxyhq/db`**: column builders, the casing authority, the
migration ledger and deploy phases, the driver-error helpers, the expiry sweep,
the throwaway test harness. A local copy of anything that package owns is a
second thing to keep in lockstep.

---

## Mongo `_id` is PRESERVED, verbatim

This is the sharpest difference from integrations, which was a genuine greenfield
and kept nothing.

`packages/app` and `packages/alia-chat` read `._id` in **137 places**. It is a
wire contract with shipped mobile builds that cannot be recalled. So every ported
row keeps its 24-character hex `_id` as a `text` primary key — **not** a uuid v7,
however much the rest of the ecosystem prefers one.

New rows minted after the port use `generatedId()` (uuid v7) in the same column.
The two coexist because nothing parses the value; it is an opaque identifier on
both sides. Do not add a CHECK constraining its shape — that would forbid exactly
the mixture the port produces.

**A consequence worth stating: id order is not creation order.** A Mongo
`ObjectId` embeds a timestamp and a per-process counter, so it sorted by creation
within a second; uuid v7 is monotonic only to the millisecond and this
implementation uses no counter, so two ids minted in the same millisecond order
arbitrarily. Anything needing creation order must sort by an explicit timestamp
column with the id only as a tiebreaker. Keyset pagination is unaffected — it
needs a total order, not a meaningful one.

## Postgres is OPTIONAL until cutover, and `tryGetDb()` is why

The live task definition carries `MONGODB_URI` and no `DATABASE_URL`, so
`connectPostgres()` returns `null` when unconfigured and `db/index.ts` exposes
`tryGetDb()` beside the throwing `getDb()`. Integrations has only the throwing
one because Postgres is its only store.

At cutover this becomes required at boot, exactly as in every other Oxy backend.
Until then a `null` must mean **"not configured"** and never **"not connected
yet"** — a read that silently fell back to Mongo after its domain had been ported
would be indistinguishable from success.

## Closed value sets, and the ones deliberately left open

`text` + an explicit CHECK rendered from the same `as const` tuple, per the
integrations file. `text({ enum })` emits no DDL.

**The tuple is IMPORTED from the Mongoose model, never retyped.** Both stores
exist until cutover, so a CHECK written from a second copy can disagree with the
validator that has been guarding the same column for years — and the disagreement
is invisible until a write hits one and not the other. Where a model declared its
values inline, export them from the model and import them here rather than
copying (`MODEL_PRICING_TIERS`, `PROVIDER_KEY_TIERS`, `TRANSACTION_TYPES`, …).

`ALIA_TIERS` is the case that forced the rule: `AliaModel.tier` and
`ModelConfig.aliaTier` are one vocabulary and were two identical thirteen-value
literals in two files, so there was no single tuple to render a CHECK from. It
now lives in `internal/providers/lib/alia-tiers.ts` beside `provider-names.ts`,
and both models read it.

**`auth_health_metrics.method` has NO CHECK, on purpose.** The Mongoose field is
a bare `String` with no `enum`, so production may already hold values outside
`AUTH_METHODS` — and Mongoose never validated enums on `updateOne` or
`findOneAndUpdate` anyway, so even an enum'd field can hold anything. A CHECK
here would fail on the first write of an unexpected value, in the authentication
path. The tuple stays a TypeScript narrowing; widening it to a CHECK is a
decision for **after** the backfill has audited what is actually stored.

The columns that have taken this answer, so the reasoning is not re-argued per
column: `auth_health_metrics.method`, `chat_analytics.platform`, and
`voice_call_usage.provider` / `.audio_format` / `.disconnect_reason` /
`.client_type`. **`voice_call_usage.provider` is the one worth reading twice**,
because `PROVIDER_NAMES` exists and renders CHECKs on three columns in
`providers.ts` — so the tempting move is to reuse it. Its Mongoose field is a
bare `String` with no `enum`, and the write happens during session teardown,
where the alternative to storing the row is losing the billing record for a call
that already happened.

**Every enum in this schema is subject to that same doubt.** The backfill must
re-audit each one **in the same invocation as the copy** — an audit whose result
can expire between running it and using it is not a gate.

### A vocabulary somebody else owns never gets a CHECK

The Mongoose doubt is about what THIS service may have written. There is a
second, sharper case: a column whose value set is defined by a third party.

**`subscriptions.status` is the worked example and has no CHECK.** Mongoose lists
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

### Which Mongoose validations became CHECKs, and which did not

Three classes, decided once so each column does not get re-argued:

- **A declared `enum`** → a CHECK, rendered from the tuple, subject to the
  backfill audit above. Unless a third party owns the vocabulary.
- **A declared `min`/`max` on a number** → a CHECK. These are domain invariants:
  a `quality_score` outside 0..100 silently corrupts the ordering
  `getNextProvider` depends on, and a negative `spent_usd` would defeat a spend
  limit. `provider_keys.current_priority` is bounded 1..1000 while
  `original_priority` is 1..100 — not a typo, and not to be unified: the first
  absorbs the displacement `recordFailure` applies by setting it past the current
  maximum, and one shared bound would make the demotion itself a violation.
- **A declared `maxlength` on a string** → NOT ported. These shape INPUT at the
  write path, where the request validators already sit; as CHECKs they would
  enforce nothing anybody relies on and would fail a backfill on a legacy long
  string. `text` throughout, as everywhere else in Oxy.

Where Mongoose declared NOTHING, neither does this schema — `user_credits` has no
non-negativity CHECK even though a negative balance is obviously wrong, because
`addCredits` accepts a negative amount and production may already hold one. A
CHECK there would fail in the deduction path. That is an audit item, not a
constraint to add on the way past.

## Nested Mongoose sub-documents become COLUMNS, not `jsonb`

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

`alia_models.providerMappings` was a Mongoose sub-document array and is now
`alia_model_provider_mappings`. It looked identical in Mongo to
`fallback_events.attempts` and is not the same thing: each element carries a
REFERENCE to `model_configs` and a per-element `is_active` toggle, so `jsonb`
would hide a foreign key inside an opaque value and leave "does this mapping
point at a model that still exists" unanswerable in SQL.

The test is not "is it an array" but **does an element have an identity of its
own** — a reference, a toggle, an ordering that something filters on. Mongo could
not express a unique index over a sub-document array at all, so
`UNIQUE(alia_model_id, model_config_id)` is new: what kept it true before was
only that the seed replaced the whole array with `$set`.

**`retrieval_strategies.source_steps` is the counter-case, and it is `jsonb`
despite passing that test on paper.** Its elements carry an `order`, a
`required` toggle and a `source_key` naming a `context_sources` row — three
identity signals, the `alia_model_provider_mappings` shape almost exactly. It is
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
`alia_model_provider_mappings` argument unchanged. And `routes/agent-teams.ts:161,184`
mutates the member list with `$addToSet`/`$pull`, which is set semantics that
`UNIQUE(parent, child)` expresses exactly and an array does not.

Two things a child table must then carry that the array gave for free:

- **`position`**, because a Mongo array is ordered and the write path replaces it
  whole. Without it the round trip is a set and the rendered order is arbitrary.
- **the CASCADE decision, stated.** Mongo left a deleted skill's id in the array
  and `populate` silently dropped it on read, so an agent's skill list shrank
  with nothing recording why. `ON DELETE CASCADE` is a deliberate behaviour
  CHANGE, the same one `alia_model_provider_mappings.model_config_id` made — and
  it is what turns those dangling ids into a backfill item rather than a
  permanent silent discrepancy. See the audit list.

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
PARTIALLY written group, the second because Mongoose enforced no cross-field rule
and a "all six or none" CHECK would reject rows production may already hold.

## Foreign keys: per reference, and say why

`oxy_user_id` and every other Oxy account id carry no foreign key anywhere: Oxy
owns identity, this service reaches it over HTTP, and a shadow users table would
be a cache that can disagree. See `lib/oxy-user-hydration.ts` for how one is
resolved.

**`api_usage.key_id` stays without one, and the providers batch is what settled
it.** `provider_keys` now exists, so the question is no longer "is the target
ported" but "what should a key's deletion do to the record that it was used" —
and keys really are hard-deleted (`DELETE /keys/:id` →
`ProviderKey.findByIdAndDelete`, `routes/keys.ts`). Every available answer is
worse than none:

- a cascade deletes the audit, which is the one thing the row exists for;
- `ON DELETE SET NULL` is unrepresentable — the column is `notNull`, and making
  it nullable to accommodate a delete erases the attribution that IS the content;
- `RESTRICT` makes a key undeletable for 48 hours after any use, turning a
  working admin operation into an error.

So a dangling id, deliberately, bounded by the 48-hour sweep. Write the reason
down rather than the absence: "no FK" and "nobody decided" look identical later.

**Within a batch, a genuine relation gets a real constraint.** Both references on
`plan_features` and both on `alia_model_provider_mappings` are foreign keys with
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
on `_id`, and there is no constraint — because `routes/conversations.ts:187-188`
creates the conversation and inserts the messages inside ONE `Promise.all`.
Parent and child are written concurrently, so a foreign key would convert a
working write into a race-dependent `23503` on whichever statement lost. The
`api_usage.key_id` reasoning applied to an ordering rather than to a deletion:
every available answer is worse than none, so write down which one was chosen.
`alia_model_provider_mappings.model_config_id` is a deliberate behaviour CHANGE:
Mongo left the sub-document behind when its `ModelConfig` was deleted, and
`getNextProvider` would then hand the router a provider whose configuration no
longer existed.

### One parent, four children, four DIFFERENT deletion rules

`routes/agents/crud.ts:323` deletes an agent with a bare `Agent.deleteOne` and
touches nothing else, so its sessions, reviews, templates and team memberships
all orphan in Mongo today. That does not settle the foreign keys — it means each
child is a separate decision, and batch 9c's four answers are all different.
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

## TTL indexes do not survive the port — the registry is not optional

Postgres has no TTL index. `db/expiryTargets.ts` is the registry, **and
`db/expirySweeper.ts` is its caller** — the two land in the same change, always.
A registry with no caller makes the omission visible and does nothing to the
rows; that is how a sibling service carried ghost rows in production for weeks.

`db/__tests__/ttlRegistryCoverage.test.ts` walks the Mongoose schemas for
`expireAfterSeconds` and fails when a ported model has no entry. It is scoped to
PORTED tables, so it tightens by itself as batches land and needs no allow-list
anybody has to remember to prune.

**A deadline COLUMN is not a TTL, and `rollback_records` is the case.**
`RollbackRecord.expiresAt` is `required, index: true` with no `expireAfterSeconds`
behind it: it bounds the rollback WINDOW, not the row's life, so these records
accumulate in Mongo today and the registry gets no entry. The gate below cannot
catch a WRONG addition here — it walks the Mongoose schemas for TTLs and finds
none, so it is silent either way — which is why
`agentsSupport.pgdb.test.ts` asserts an ancient row SURVIVES a full-registry
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
by a CHECK), which is also more correct than the original: Mongo measured from
`createdAt`, so a notification dismissed on day 89 vanished the next day while
one dismissed on day 1 survived another 89. Mercaria's
`packages/backend/src/db/expiryTargets.ts` is the reference implementation.

## The three unmodelled collections: one is ported, two are RETIRED

A Mongoose-model census cannot see a collection reached through
`mongoose.connection.collection(...)`. There are three, and they do not get the
same answer — stating that here rather than at batch 10, because the decision is
cheap now and expensive once sixty tables have landed around it.

| Collection | Reached from | Decision |
|---|---|---|
| `leases` | `lib/leader-election.ts` | **PORTED** (batch 0) |
| `_migrations` | `lib/migrations/runner.ts` | **RETIRED** |
| `_migration_lock` | `lib/migrations/runner.ts` | **RETIRED** |

### And a MODEL census cannot see a model declared outside `src/models/`

`MemoryEmbedding` is `mongoose.model(...)` at `lib/memory/vector-search.ts:27`,
beside the functions that use it. A census listing `src/models/` returns ten
files for batch 8 and the batch has eleven models — and finding LESS looks
exactly like there BEING less, so nothing about that result says it is short.
It was caught only because the batch's table list was written from the feature
rather than from the directory.

`models/__tests__/foreign-ref-populate.test.ts` already names a second directory
(`src/internal/providers/models/`) in its affirmative filter for the same
reason, and would not have found this one either. Enumerate `mongoose.model(`
across the whole package when deciding what is left to port; a directory listing
is a starting point, not an inventory.

`leases` is live coordination state: the trigger engine elects one leader across
several ECS tasks, and losing it means two tasks running every schedule.

### Two migration ledgers must not both survive the cutover

`_migrations` and `_migration_lock` belong to this service's own **Mongo data**
migration runner (`runPendingMigrations()`, called fire-and-forget from
`index.ts`). `@oxyhq/db` brings a **Postgres DDL** ledger with `pre`/`post`
phases. They are different things that would look like the same thing:

- Alia's runner records which one-off **document restructurings** were applied to
  Mongo. Its whole subject matter is a store that ceases to exist.
- `@oxyhq/db`'s ledger records which **SQL files** were applied to Postgres.

Porting `_migrations` would carry a ledger asserting that migrations ran against
a database they were never applied to — worse than dropping it, because it reads
as history. So at cutover the runner, its migration directory, and the
`runPendingMigrations()` call in `index.ts` are all **deleted**, and Postgres has
exactly one ledger.

**The consequence that must not be lost with them.** There is exactly one
registered migration, `001-restructure-memories-title-summary-type`, and
`_migrations` holds exactly one document in production — so **001 has been
applied**. It rewrote `UserMemory.memories` from `key`/`value`/`category` to
`title`/`summary`/`type` and gave every user document a `settings` object.

So the ported `user_memories` schema (batch 8) is written to the POST-001 shape
and to that shape ONLY — there is no `key` or `category` column, and none should
be added for compatibility. But "001 has been applied" is a fact with a date on
it, and the backfill must **assert** it rather than inherit this sentence: check
for the `_migrations` record, and refuse any source row still carrying the legacy
keys. Same rule as the enum audit — an audit whose result can expire between
running it and using it is not a gate.

## A Mongo collection springs into existence; a Postgres table does not

`leases` does not appear in the production collection listing at all, because
leader election has never acquired and Mongo creates a collection on first write.
After the port the table exists from migration 0000 onward and is simply empty.

Any code reading "no lease row" as "no leader has ever run" keeps working, but
the two states are no longer distinguishable by the container's existence — only
by its contents. This generalises to every ported collection: **absence of a
table stops being a signal.** Anything that inferred something from a collection
not existing has to infer it from a row count instead — and it fails in the
PERMISSIVE direction, because the code takes the branch for "it exists" against a
table holding nothing.

### The scan was run, and `packages/api` is clean

Whole-repo, over `git ls-files`, before batch 3:

- `listCollections`, `collectionNames`, `db.collections()`, `.collectionName` — **none**
- `createCollection`, create-on-demand bootstrap — **none** (the two `.init()`
  hits are Stagehand browser sessions)
- `NamespaceNotFound` / error code 26 handling — **none**
- `countDocuments()` — three, and none is an existence inference:
  `intelligent-cache.ts:289,345` size a cache for eviction, and
  `trigger-engine.ts:615` is `.countDocuments().catch(() => 0)` on the legacy
  `automations` collection — inside `migrateLegacyAutomations()`, which is
  retired at cutover along with the collection.

`leader-election.ts` reads `doc?.holderId === instanceId`, which is row CONTENT,
not container existence — so the one table whose collection genuinely does not
exist in production needs no change.

Re-run this scan per domain rather than trusting this paragraph: it is a fact
about the code as of batch 2, and a new reader can be added at any time.

## Name the source database as a LITERAL, never derive it

`alia-development` (41 collections, 654 documents) lives on the **same Mongo
host** as `alia-production`, and `integrations-production` beside them. So a
backfill that derives its source from `NODE_ENV`, a service name, or any pattern
can point at a seeded development copy and report a successful run.

State the database name as a literal, and assert `db.databaseName` matches it
before reading a byte. The same applies on the Postgres side, which is what
`--target-database` already enforces for migrations — this is the read half of
the same rule.

### The same rule for COLUMN names, and `library_files` is the instance

Every table in this schema names the account `oxy_user_id`. `LibraryFile` calls
the identical thing **`owner`** — so a backfill that pairs source and
destination fields by matching names, or by a rule like "the account column is
the one called `oxy_user_id`", copies every other column correctly and leaves
this one NULL. The copy reports success and every file in the library becomes
unreachable.

Batch 9's full rename list, so the backfill states each mapping rather than
pairing by name: `Agent.author` → `author_oxy_user_id`, `AgentTeam.creator` →
`creator_oxy_user_id`, and `AgentSession.userId` / `AgentReview.userId` /
`Container.userId` / `ContainerTemplate.userId` /
`AgentSession.creditReservation.userId` → `oxy_user_id` (the last as
`credit_reservation_oxy_user_id`). `Skill.author` is the one that does NOT map to
an account — see below.

The column is therefore named `owner_oxy_user_id`: the fact travels in the name
rather than in a comment, and the backfill states the `owner` → `owner_oxy_user_id`
mapping explicitly. **A Mongoose field name is as arbitrary as a Mongoose
collection name**, and neither is evidence of anything — a derivation over one
is a check that cannot fail. Grep each model for what it actually calls the
account before porting it; **five** spellings are now in use across this service
(`oxyUserId`, `userId`, `owner`, and — from batch 9 — `author` and `creator`).

#### And the same NAME means opposite things one model apart

`library_files.owner` shows that a name can hide an account. Batch 9 supplies the
mirror image, which is worse because the two sit one file apart and a census over
either name alone reads as complete:

- **`Agent.author` IS an Oxy account** — `routes/agents/crud.ts:245` writes
  `req.user.id` into it. Ported as `agents.author_oxy_user_id`.
- **`Skill.author` is a DISPLAY STRING** — `lib/seed-skills.ts` writes `'Alia'`
  and `'Community'`. Ported as `skills.author`, deliberately WITHOUT the suffix,
  because adding one would assert something false.

A backfill pairing fields by matching names maps both the same way and is wrong
about both — in opposite directions, so neither error looks like the other. The
rule the pair sharpens: **a field name is not evidence in either direction, so
read the WRITER**. `agents.author_oxy_user_id` carries the fact in the column
name precisely because `skills.author` proves the name alone cannot be trusted.

### A field declared in the INTERFACE and absent from the SCHEMA was never stored

`ISkill` declared `coverImage: string | null` and `SkillSchema` had no such path,
with no other reference anywhere in the package — so Mongoose's `strict` dropped
it on every write and no document has ever carried one. `skills` has no column,
and the interface field was removed in the same change rather than left to invite
one. Recorded because a missing column reads as an oversight and this is a
measurement; check the SCHEMA, not the interface, when deciding what to port.

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

**A bare Mongoose `Number` holding an EPOCH MILLISECOND needs `bigint`, and the
column type is the only place that says so.** `event_stream_entries.timestamp`
is written from `Date.now()` (`lib/agent/event-stream.ts:89`) — around 1.76e12,
some 800 times past the `integer` maximum — while Mongoose types it a plain
`Number` with nothing naming the unit. `integer` would reject the very first
write. `agent_sessions.stats_total_tokens` is the same call for a different
reason: it accumulates across every step of a session rather than being large to
begin with. `event_stream_entries.seq` stays `integer` deliberately, because it
counts events within ONE session and `config_max_steps` bounds it.

The read trap above applies to all three, and `containers.pgdb.test.ts` and
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

## A Mongoose SETTER has no Postgres counterpart, and two of them mattered

Mongoose field-level `set`/`get` and `lowercase`/`trim` run on every `save()`
whatever the call site, so what they enforce is true by construction. drizzle has
nothing equivalent. Porting such a column faithfully means asking what the setter
GUARANTEED and re-establishing it structurally — not copying the column type.

Two in this schema, with opposite answers:

- **`integrations` / `connected_accounts` OAuth tokens** were `set: encrypt,
  get: decrypt`. Plain `text` would demote "encrypted on every write" to
  "encrypted wherever somebody remembers", and the failure is SILENT — the app
  keeps working and third-party tokens sit in plaintext until a dump leaks. They
  use the `encryptedText` custom type (`columns.ts`), which is the only available
  shape where drizzle applies the transform to every write it builds — the
  difference between "a plaintext token CANNOT be stored" and "must remember not
  to", which is the whole decision for a column holding somebody else's
  credential. A write chokepoint would have downgraded a guarantee that held on
  every write to one that holds on every write *through that function*, defended
  by a test rather than by the type.

  **The backfill copies ciphertext VERBATIM and bypasses the codec.** The
  algorithm, format and key are unchanged from Mongo, so the stored value is
  portable as-is: read through the RAW driver, write through a raw statement, no
  plaintext in flight and a byte-for-byte comparison as the verification. Handing
  ciphertext to the codec instead produces ciphertext-of-ciphertext, which looks
  like a successful copy and fails at the first read — so the backfill must
  assert what it wrote still matches `iv:authTag:ciphertext`. `columns.ts` holds
  the full reasoning, including why `pgcrypto` is rejected rather than deferred.

  **Before porting ANY model, grep its schema for field-level `get`/`set` and for
  `getters: true`.** The backfill's choice of driver silently decides whether it
  stores plaintext or ciphertext, and both readings look correct at the time.
- **`organizations.slug`** was `lowercase: true, unique: true`. Here the setter
  was upholding a UNIQUE, so the answer is a FUNCTIONAL unique index on
  `lower(slug)` rather than a transform: a plain unique on the stored text lets
  `Acme` and `acme` coexist where Mongo folded them into one, silently widening
  the namespace organizations are addressed by. A CHECK asserting the column is
  already lowercase was rejected — it would fail the backfill on any row a
  non-validating write path stored differently, where the functional index simply
  works whatever case is stored.

**A fixture for either MUST be in the un-normalised form.** Two already-lowercase
slugs behave identically under a plain unique and a functional one, so a test
seeded that way passes while measuring nothing — the same fixture law as
everywhere else in this migration.

**A rule enforced in APPLICATION code, not by a setter, gets the same
treatment.** `user_memory_entries` is the case: nothing normalised the title,
but `lib/tools/user-memory.ts:60` matches an existing memory with
`m.title.trim().toLowerCase() === normalized` and `:174` refuses a rename that
would collide the same way — so `lower(trim(title))` IS the application's
identity for a memory, stated twice in one file. Mongo could not index inside a
sub-document array at all, so `UNIQUE(user_memory_id, lower(trim(title)))` is
new, and it is a real backfill risk rather than a formality: two memories
differing only in case or whitespace collide, which is precisely the pair the
application already believed was one. The fixture that proves it is
`'Coffee Preferences'` against `'  coffee preferences  '`; the column keeps what
was written, so nothing rewrites a user's own words — and the embedding, which
stores that RAW title as its key, still matches.

Not every setter earns this. `organization_invites.email` is `lowercase, trim`
too, and no unique index depends on it, so it is a lookup-normalisation concern
for the repository rather than a constraint, and no functional index was added.

### `Workflow`'s `pre('save')` hook was DEAD, and the port changes nothing

Enumerated per the hooks rule, and recorded because the wrong reading of it is
attractive. `WorkflowSchema.pre('save')` set `updatedAt`, and a `pre('save')`
hook does not run on `findOneAndUpdate` — which looks exactly like a bug the port
silently fixes, worth telling users about.

It is not. There are only two `Workflow` write paths and NEITHER calls `.save()`:
`routes/canvas/workflows.ts:79` creates, and `:112` updates with
`findOneAndUpdate`, whose payload sets `updatedAt: new Date()` explicitly at
`:118`. So the hook has never run on an update, the timestamp has always been
correct, and it was the CALL SITE maintaining it rather than the hook.

Verdict: case 3 — the hook enforced nothing, because the one thing it would have
enforced was already done by hand. `updatedAt()` from `@oxyhq/db` now carries it
via `$onUpdate`, which is the same value written in the same circumstances. **No
observable behaviour changes and no stored timestamp moves**, so there is nothing
to announce. Check the call sites before believing a hook is load-bearing — a
dead hook and a live one look identical in the schema file.

## A credential at rest, and the projection rule that goes with it

**`provider_keys.key` holds a PLAINTEXT provider API key.** Not a hash —
`key_hash` is that, and `lib/key-manager.ts` reads the plaintext to sign the
upstream call. It was at rest in Mongo and it is at rest here; the port neither
introduced nor fixed that.

Until a repository exists there is no mechanism to enforce, so the rule is
written in the two places somebody will look — the column's own comment and here:

- never `select()` this table whole. Name columns, and leave `key` out of every
  projection but the one call that must sign a request;
- it must never reach a log line, an error, a metric label or an admin response.
  `key_prefix` exists for display and is the only identifier safe to show;
- `key_hash` is NOT a safer alias. A hash of a credential is an exact-match
  oracle, so it is equally protected.

## `generatedId()` is wrong exactly once

`user_credits.id` is an OXY ACCOUNT ID — Mongo declared `_id: { type: String }`
and wrote the account id into it, so the table is keyed by the account rather
than by a row identity. It is `text().primaryKey()` with **no default**: a uuid v7
would quietly mint a row no lookup could ever find, and the failure would present
as a missing balance rather than as a bad insert.

Everywhere else `generatedId()` is right, because the backfill supplies the Mongo
`_id` and the app mints uuid v7 for new rows in the same column.

## A recover-after-duplicate-key pattern does NOT port, and chat has one

**In Postgres one failed statement aborts the ENTIRE transaction** (`25P02`):
every later statement fails, including a plain read, until it rolls back. Mongo
has no equivalent — a duplicate-key error leaves the session usable, so "insert
optimistically, catch the duplicate, recover" degrades cleanly there.

`lib/conversation-saver.ts:177-185` is exactly that shape and it is deliberate,
not sloppy: it appends messages with `insertMany`, reads a duplicate key on
`messages_oxy_user_conversation_seq_key` as "a concurrent append claimed this
seq", and converges with a `deleteMany` + full re-insert. It works today because
that sequence is NOT inside a transaction.

This is a DESTINATION note — no call site moved in this batch. Whoever ports it
has two options and needs to pick deliberately: wrap the optimistic insert in a
`SAVEPOINT` so the failure rolls back only to it and the recovery can still run,
or keep the sequence outside a transaction as it is now. What must not happen is
the natural-looking refactor that puts the whole function in a
`db.transaction(...)` and leaves the `catch` in place — the recovery then fails
with `25P02` and the message history is left deleted.

## Mongo's three write counts do not survive the port — decide per call site

This is a DESTINATION note: no call site moved in the schema batches, and each
one is a decision rather than a mechanical substitution. Mongo reports
`matchedCount`, `modifiedCount` and `upsertedCount`; Postgres reports `rowCount`.

**Fourteen sites in the providers/billing domain needed FOUR different answers.**
That number is the argument: any rule simple enough to apply mechanically is
wrong on most of them.

- **`matchedCount` → `rowCount`.** Direct. A no-op update still reports
  `UPDATE 1`, which is what `matchedCount` meant.
- **`modifiedCount`** counts rows that actually CHANGED. It equals `rowCount`
  only when the statement's own filter already excludes rows that would not
  change — true of `resetAllKeyCooldowns` and `routes/keys.ts /reload`
  (`cooldownUntil is not null OR consecutiveFailures > 0`, and every matched row
  changes both) and of `resetAllCircuitBreakers`. It is NOT true of
  `routes/providers.ts /health/reset-all`, whose filter is `{}`: an
  already-healthy row is matched and not modified, so `rowCount` over-reports to
  the admin panel and that one needs an `IS DISTINCT FROM` predicate. Adding such
  a predicate where it is not needed is its own bug — it can turn a successful
  repeat into a 404.
- **`upsertedCount` is not recoverable from `rowCount`**, because
  `INSERT … ON CONFLICT DO UPDATE` reports one row affected on both the creating
  and the updating call. It needs `RETURNING (xmax = 0) AS inserted`.

  **But most of this service's upserts do not need that.** Every `seed-*.ts`
  upsert is `$setOnInsert`-only, which on an existing row is a genuine no-op, so
  the port is `ON CONFLICT DO NOTHING` — where the empty `RETURNING` set IS the
  answer and `rowCount` distinguishes created from skipped exactly. Only the
  `$set` upserts need `xmax`: `scripts/sync-zeroeval.ts` and
  `POST /plan-features/bulk`, which report both counts on one response.

**A single call cannot tell any of these apart.** The discriminator is a REPEATED
call, so a test that runs once proves nothing about which semantics it got.
`providers.pgdb.test.ts` pins the `xmax` behaviour against a real server.

### How to census these, and what the census misses

The batch-3 census was handed over with thirteen sites and there are fourteen:
`scripts/sync-zeroeval.ts:116` reads BOTH counts off one `bulkWrite` against
`ExternalModel`. It was missed because it sits in `scripts/` rather than beside
the domain, which is exactly the "finding less looks identical to there being
less" failure — so state the method, not just the result.

The method is two halves, and only the first is a grep:

1. **Enumerate** every write-result property name across the WHOLE package, with
   no directory scoping: `matchedCount`, `modifiedCount`, `upsertedCount`,
   `upsertedId(s)`, `insertedCount`, `deletedCount`, `nModified`, `nUpserted`,
   `nInserted`. Scoping to the domain's own directories is what lost the
   fourteenth.
2. **Attribute** each site to the model it writes, and account for the RESIDUAL —
   every site the domain does not claim has to be explained, not ignored.

Both halves were re-run after the batch landed. The wider name list adds nothing:
only `modifiedCount` (20), `deletedCount` (18), `upsertedCount` (8),
`matchedCount` (8) and `acknowledged` (5, not a count) appear at all, so there is
no fifteenth site hiding behind a name the first pass omitted. Attribution
produced three FALSE positives — `lib/notification-service.ts` and
`routes/notifications.ts` import `WebPushSubscription`, not the billing
`Subscription`; `routes/skills.ts` imports `getDefaultAliaModel`, a function, not
`AliaModel` — each resolved by reading the file. False positives are the safe
direction; the residual is what makes a false NEGATIVE visible.

## Tests run against a REAL Postgres, in their own config

`vitest.pg.config.ts` + `*.pgdb.test.ts`, separate from the default config
because the two halves have different PREREQUISITES — the Mongo suite needs only
an in-process replica set, this one needs a real server over TCP. Merging them
would make every `bun run test` fail on a machine without Docker, which is how a
suite gets disabled by whoever hits it next.

`*.pgdb.test.ts` rather than the Mongo suite's `*-real-db.test.ts`: both are
"real database" tests and only the filename says which database.

Assert driver errors through `@oxyhq/db`'s helpers, never a message regex —
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

---

# The backfill audit list

Every tightening this port introduced, in one place, because the alternative is
reading seven schema files to find them. Each is a constraint Postgres will
enforce that Mongo did not — so each is a way the backfill can fail, and failing
there is the DESIGNED outcome rather than a surprise: it surfaces a real
inconsistency at the one moment somebody is watching.

**Audit in the SAME invocation as the copy.** An audit whose result can expire
between running it and using it is not a gate — the rule this file already states
about enums, applied to all of them.

## Values a CHECK will now refuse

| Where | What to audit | If it fires |
|---|---|---|
| every `text` + CHECK column | a stored value outside its tuple | Mongoose never validated enums on `updateOne`/`findOneAndUpdate`, so this is the expected class. Widen the tuple or fix the row — do not drop the CHECK. |
| `model_configs.priority`, `.quality_score`, `alia_model_provider_mappings.*`, `provider_keys.current_priority`, `.original_priority`, `.spent_usd`, `.max_total_failures`, `alia_models.credit_multiplier`, `credit_packages.credits`, `.price` | a number outside the Mongoose `min`/`max` it preserves | These are domain invariants, not input shaping. A violation means a non-validating write path produced it. |
| `notifications.dismissed_at` | `status = 'dismissed'` with no `dismissed_at`, or the reverse | Backfill `dismissed_at` from the row's `updatedAt` (the best available proxy) for dismissed rows, and NULL for every other status. |
| `triggers` | `schedule` present with `type NOT IN ('schedule','agent_heartbeat')` | No CHECK was added — this is the correct-but-unvalidated tightening deliberately left out. Audit it, then decide whether to add the constraint in a later `post` migration. |
| `containers.container_id` | two live rows sharing one Docker id | No unique index. It is the lookup key every writer uses (`terminal-session.ts:250`, `tools.ts:386` find by it alone), so one looks obviously right — but Mongoose declares only `index: true` and TWO independent creation paths write it. Count duplicates first; a partial unique `WHERE status <> 'destroyed'` is the correct tightening and is deliberately left out until audited, exactly like `triggers.schedule`. |
| `user_credits.credits_free`, `.credits_paid` | a NEGATIVE balance | No CHECK was added, because `addCredits` accepts a negative amount. Audit the actual range before anybody adds one. |
| `context_nodes.*_score`, `context_edges.weight`, `context_sources.*_score`, `retrieval_strategies.*_weight` | a value outside 0..1 | Every writer sets 0.2–0.95, so 0..1 is plainly intended — but Mongoose declares no `min`/`max`, so no CHECK was added. Audit the range before anybody adds one; the write path runs on every chat turn. |
| `retrieval_strategies` | more than one row with `active = true` for one `(oxy_user_id, intent)` | No constraint. Mongo's unique is on `(user, intent, name)`, which permits it, yet both writers filter on `{oxyUserId, intent, active: true}` — so a second active row makes which one they find arbitrary. A partial unique `WHERE active` is the correct tightening and is deliberately left out until audited, exactly like `triggers.schedule`. |
| `agent_reviews.rating` | a value outside 1..5 | Mongoose declares `min: 1, max: 5`. Note the bound differs from `agents.rating`'s 0..5 deliberately — see the section above; do not unify them to make an audit pass. |
| `agent_sessions.plan_objective` / `.plan_items` | a document with ONE of the two present | A new CHECK. Every writer sets and clears the plan as a unit (`todoManager.toJSON()` produces both, `runner.ts:803` clears both), so a half-written plan means a raw write around them. Clear both rather than relaxing the constraint — half a plan is not something `loadFromPersisted` can use. |
| `agent_sessions.messages` | any row where it is NON-EMPTY | Written by nothing and read by nothing package-wide, so it should be empty everywhere. A non-empty row means a writer existed once and the shape assumption behind porting it as an inert `jsonb` needs re-reading before the copy. |
| `agent_sessions.event_stream` vs `event_stream_entries` | rows where the two DISAGREE, and **a decision that is owed** | See the section below — this is the one item here that is not just a number to read. |
| `learning_rules.priority`, `.hit_count` | the actual stored range | No CHECK. Mongoose declares no `min`/`max` on either, so the third class applies — but `priority` reads like a 0..100 and `hit_count` like a non-negative, and both invite an obvious constraint. `agentsSupport.pgdb.test.ts` stores `9999` and `-3` so that adding one fails there rather than on somebody's row. Audit the range before anybody proposes it. |
| `skills.triggers`, `.includes`, `.good_at`, `.not_good_at` | a source document MISSING the key entirely | `notNull default '{}'`, because Mongoose hands every reader `[]` for an absent array and every caller does `.map()`/`.length` without a guard. A backfill reading through the RAW driver gets `undefined` for a document written before the field existed and must coerce to `[]` — through Mongoose it would already be `[]`. This is the one place the choice of driver changes the value, the encrypted-column rule pointed at absence instead of ciphertext. |

## Uniques that will refuse a duplicate

| Where | What to audit | Why it matters |
|---|---|---|
| `referral_redemptions_referred_user_key` | one account appearing under TWO referrers | The double-credit race is real (`routes/referrals.ts` pays before it records). A hit here is a customer who was credited twice. |
| `voice_call_usage_session_id_key` | two rows for one provider `sessionId` | Mongoose declared this unique, so a hit means a row predating it. It matters because `lib/voice-usage.ts` sums minutes per user: a duplicated session double-counts against a plan's voice entitlement. |
| `organizations_slug_lower_key` | two slugs differing only in case | Mongoose's `lowercase` setter folded them; a row written around it did not. |
| `alia_models.alias_model_id` | a value that is not already lowercase | Same setter, no CHECK added — the port stores whatever is there. |
| `user_memory_entries_memory_title_lower_key` | two memories under one profile whose titles differ only in case or surrounding whitespace | Mongo could not index inside a sub-document array, so nothing enforced this; the application already treats such a pair as ONE memory, so a hit is two entries a user sees as duplicates. Merge them rather than relaxing the index. |
| `user_memories_oxy_user_id_key` | two profiles for one account | Mongoose declares `unique: true`, so a hit means a row predating it or a raw write around it. |
| `skills_skill_id_key` | two skills sharing a `skill_id` | Mongoose declares `unique: true`, so a hit means a row predating it. It matters because `lib/seed-skills.ts` upserts on this key: a duplicate makes which row the seed updates arbitrary, and the other one is then a skill nobody can correct. |
| `agents_handle_key` | two agents sharing a `handle` | Mongoose declares `unique: true`, so a hit means a row predating it or a raw write around it. A handle is how one agent delegates to another (`@researcher`), so a duplicate makes which agent is hired arbitrary. |
| `agent_skills_agent_skill_key`, `agent_knowledge_agent_file_key` | one agent's array naming the same skill or file TWICE | New — Mongo cannot index inside a sub-document array, and nothing deduplicated these on write (`routes/agents/crud.ts:252` stores the client's array verbatim, unlike the team routes which use `$addToSet`). A hit is a duplicate the UI already renders twice; drop the repeat rather than relaxing the index. |
| `agent_session_resources_session_resource_key` | one session claiming the same VM or container twice | New. `lib/agent/runner.ts:272` guards it with `resources.some(...)` before pushing — a read-then-write two concurrent tool calls can both pass, so a duplicate is the expected artefact of that race rather than a surprise. Merge, keeping the row whose `status` is `destroyed` last. |
| `agent_team_agents_team_agent_key` and its two siblings | a team naming the same member twice | NOT a new tightening: `routes/agent-teams.ts:161` already uses `$addToSet`, so this index is the constraint that operator was emulating. A hit means a row written before that route existed, or a raw write around it. |
| `agent_reviews_agent_user_key`, `container_templates_snapshot_tag_key` | a duplicate | Both declared `unique: true` in Mongoose, so a hit means a row predating the declaration. |

## Not-null a legacy row may not satisfy

`subscriptions.plan_snapshot_name`, `.plan_snapshot_credits_per_month`,
`.plan_snapshot_price` are `notNull` because Mongoose declares them `required` —
but a `required` added to a schema binds only writes made after it. Audit for
subscriptions predating the snapshot. Relaxing these is a one-line change while
the schema is inert and a `post` migration afterwards.

`voice_call_usage.cost_per_minute` is the same shape: `required` in Mongoose with
no default, so nothing supplies it for a row written before it was added. The
same question applies to `library_files.size`, `.url` and `.type`.

Batch 9a adds the same question for `skills.system_prompt`, `.author`, `.icon`,
`.color` and `.category`, for `learning_rules.title` and `.rule_text`, and for
`rollback_records.args`, `.expires_at` and `.executed_at` — all `required` in
Mongoose, all `notNull` here. `skills.icon` and `.color` are the likeliest to
bite: they are presentation fields, so a seed revision that introduced them
leaves every earlier row without one.

## Foreign keys a legacy row will not satisfy — the EXPECTED failure of batch 9b

`agent_skills.skill_id`, `agent_knowledge.library_file_id`, `agent_team_agents`,
`agent_team_skills`, `agent_team_knowledge`, `agent_reviews.agent_id` and
`agent_session_resources.session_id` all have real foreign keys, and **Mongo left
dangling ids behind every one of them**: `routes/agents/crud.ts:323` deletes an
agent with a bare `deleteOne` and touches nothing, and deleting a `Skill` or a
`LibraryFile` never touched the agents referencing it. `populate` silently
dropped the unresolvable entry on read, which is why nobody has ever seen it. So
the backfill WILL hit `23503` here, and it is not a defect — it is the first time
anybody has counted how many of those references are dead.

**`event_stream_entries.session_id` is the largest of these by far**, and its
foreign key cascades — so a dangling one is not merely refused, it names a
session that was deleted while its log survived. Count them before the copy: the
number is how many sessions somebody removed without the entries going with them,
which is exactly the unbounded growth the cascade exists to stop.

**`agent_reviews` is the one to look at rather than discard.** A review of a
deleted agent is unreachable, so dropping it loses nothing a user can see — but
the COUNT is worth reading before it goes, because a large number means agents
are being deleted with reviews attached and `lib/agent-rating.ts` has been
recomputing against them.

Do not "fix" it by dropping the constraint. Count the dangling ids first; each
one is an entry an agent's owner has seen disappear from their skill list
already, so DISCARDING it restores nothing and loses nothing. Discard, record the
count, and keep the constraint — that is what makes the same silent shrinkage
impossible afterwards.

`agents.rating` outside 0..5 is the same class one column over: Mongoose declares
`min: 0, max: 5`, so a violation means a non-validating write path produced it.
`lib/agent-rating.ts` is the only writer and it stores an average of 1..5 review
ratings, so a legacy row outside the range is a real anomaly worth reading rather
than a bound to widen.

## The one that corrupts silently rather than failing

**The encrypted OAuth columns.** `integrations.oauth_access_token`,
`.oauth_refresh_token`, `connected_accounts.*` and `bots.bot_token` are
`encryptedText`. Copy the CIPHERTEXT verbatim through the RAW driver and write it
with a raw statement — never through drizzle, which would encrypt it a second
time. Assert the written value still matches `iv:authTag:ciphertext`; that
assertion is the only thing between "copied" and "copied correctly", because a
double-encrypted row looks like a successful copy and fails at the first READ, in
production. `columns.ts` has the full reasoning.

## TWO LIVE STORES FOR ONE FACT — a decision owed, not a shape ported

`agent_sessions.event_stream` and `event_stream_entries` hold the same events.
`lib/agent/event-stream.ts` persists only to the collection; `lib/agent/runner.ts`
ALSO writes `session.eventStream = eventStream.toJSON()` on every save; and
`getRecentActivity` reads the collection first and falls back to the embedded
array, its own comment calling that "(legacy)".

The port carries both, which is faithful. **But a fallback that reads one store
and then the other is not resilience — it is two sources of truth**, and a port
that carries both without saying so is exactly how the arrangement becomes
permanent. So this is recorded as a decision with an owner rather than as a
modelled shape:

- **The collection WINS.** It is the store the writer maintains, it is the one
  `getRecentActivity` prefers, and it is the only one with indexes.
- **The embedded copy dies when no session needs the fallback** — that is, when
  every session holding a non-empty `event_stream` either has entries in
  `event_stream_entries` or is old enough that nobody reads its activity. Count
  the sessions where the collection is empty AND the array is not; that number
  is the fallback's entire remaining purpose, and when it reaches zero the
  column can be dropped in a `post` migration and the four writes in `runner.ts`
  removed with it.
- **Until then, do not "tidy" either side.** Writing only the collection breaks
  the fallback for old sessions; writing only the array reintroduces the 16MB
  document limit this collection was created to escape.

## Preconditions rather than failures

- `rollback_records.session_id` will contain ids of `agent_sessions` rows that no
  longer exist, BY DESIGN — there is no foreign key, for the `api_usage.key_id`
  reason. Do not "repair" a dangling one during the backfill and do not add the
  constraint in 9c or 9d; `agentsSupport.pgdb.test.ts` stores an unmatched id so
  that adding it fails there rather than in the governance write path.
- `provider_keys.organization_id` must be entirely NULL before its CASCADE
  foreign key applies. It should be — the column is declared and indexed in
  Mongoose and never written, verified package-wide — but confirm rather than
  assume.
- `voice_call_usage.average_latency_ms` and `.client_type` are declared in
  Mongoose and written by nothing in the package, verified whole-package rather
  than around the writer. Confirm they are entirely absent before anybody reads
  one as meaningful; they are ported so the shape is faithful, not because they
  carry anything.
- Migration `001-restructure-memories-title-summary-type` must be recorded as
  applied before `user_memories` (batch 8) is copied, and any source row still
  carrying the legacy `key`/`category` keys refused. Stated in full above.
- `user_memories.preferences` and `.context` are ported as COLUMNS on the
  strength of a measurement: issuing the exact statement `routes/memory.ts`
  uses, with undeclared keys, against a real MongoDB stores only the declared
  ones — Mongoose's `strict` drops the rest, confirmed by a raw driver read.
  The TypeScript interfaces claim `[key: string]: any`, so the column choice
  depends on that measurement holding for STORED data too. Count rows carrying
  any key outside the declared set before the copy: a row written before a key
  was declared, or by a raw write around Mongoose, would lose it silently.

## One measurement taken by somebody else

A whole-host `listDatabases` census of `oxy-mongo`, run as a one-shot ECS task on
**2026-08-09**, reported `alia-production` with 79 collections, 6,113 documents
total, and **`notifications: 0`**.

Recorded with its provenance because it is not a measurement taken here, and
because its weight is entirely in its date: if it still holds at cutover, the
`notifications` CHECKs above carry no backfill risk at all. **Re-verify at
backfill time rather than relying on this line** — a zero-row collection is
exactly the kind of fact that stops being true quietly.
