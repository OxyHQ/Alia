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
`alia_model_provider_mappings.model_config_id` is a deliberate behaviour CHANGE:
Mongo left the sub-document behind when its `ModelConfig` was deleted, and
`getNextProvider` would then hand the router a provider whose configuration no
longer existed.

**A foreign key must target `unique()`, never `uniqueIndex()`.** drizzle-kit
emits every `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` BEFORE every
`CREATE UNIQUE INDEX`, whatever the source order — measured in `0003`, where the
four FK statements are lines 339-342 and the first `CREATE UNIQUE INDEX` is 343.
A FK pointing at a unique INDEX therefore generates cleanly and fails at APPLY
time with `42830: there is no unique constraint matching given keys`. `unique()`
is emitted inline inside `CREATE TABLE`, so it already exists. This is why
`plans.plan_id` and `features.feature_id` — both FK targets, both business keys
rather than surrogate ids — are the only two `unique()` declarations in the
schema while everything else uses `uniqueIndex()`.

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
`bigint`/`int8` as a STRING. drizzle escapes that for a COLUMN via
`mode: 'number'`, but an AGGREGATE has no column builder to carry the mode, so
`sum()`/`max()` come back as strings while typing as numbers, and `max + 1` is
string concatenation. Coerce explicitly at that boundary.

A test that performs ONE aggregation cannot catch this — `max` over a single row
plus one gives the same answer either way. `billing.pgdb.test.ts` does two
sequential appends, which is what makes `"7" + "1" = "71"` distinguishable
from `8`.

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

Not every setter earns this. `organization_invites.email` is `lowercase, trim`
too, and no unique index depends on it, so it is a lookup-normalisation concern
for the repository rather than a constraint, and no functional index was added.

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
