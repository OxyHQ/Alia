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

## Nested Mongoose sub-documents become COLUMNS, not `jsonb`

`routing_logs` is the worked example: `classification` and `routedTo` were
sub-documents and are now `classification_*` and `routed_to_*` columns. Both have
a fixed, known shape this service owns, so `jsonb` would only hide them from a
CHECK and from the planner.

`jsonb` is reserved for values whose FORMAT belongs to somebody else, or which
have no queryable identity. In this batch that is exactly one column:
`fallback_events.attempts`, an ordered list read whole for display and never
addressed independently. `provider_health.latency_samples` is `double
precision[]` rather than `jsonb` for the same reason inverted — it is a bounded
window of plain numbers, and an array stays summable in SQL.

## Foreign keys: not yet, and say why

`api_usage.key_id` names a `provider_keys` row and carries **no** foreign key.
That table lands in batch 3, and more importantly usage is an append-only audit
of what a key DID — deleting a key must not delete the record that it was used,
so the eventual constraint is `ON DELETE SET NULL` at most, never a cascade.
Decide it when the providers batch lands, deliberately rather than by default.

`oxy_user_id` and every other Oxy account id carry no foreign key anywhere: Oxy
owns identity, this service reaches it over HTTP, and a shadow users table would
be a cache that can disagree. See `lib/oxy-user-hydration.ts` for how one is
resolved.

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
