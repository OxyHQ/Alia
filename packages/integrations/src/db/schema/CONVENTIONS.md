# Postgres schema conventions — @alia/integrations

Binding for every table in this schema. Decision and reason, nothing else.

This is the FIRST Alia service on Postgres, and it is deliberately the smallest:
it owns its own database, held 2 documents in Mongo, and has no deploy. It exists
to establish the toolchain — `@oxyhq/db`, the migration ledger, deploy phases and
the throwaway-database harness — somewhere a mistake costs nothing, so that
`packages/api` inherits a working pattern instead of inventing one under
cutover pressure.

The mechanics ship in **`@oxyhq/db`**: the column builders, the casing authority,
the migration ledger and deploy phases, the driver-error helpers, the throwaway
test harness. Read it before hand-rolling any of them — a local copy of something
that package owns is a second thing to keep in lockstep.

---

## The database is dev/test-only, and provisioning it is a PREREQUISITE of deploying

There is no `alia_integrations` database on the shared `oxy-postgres` instance,
and creating one now would be a mistake rather than preparation. This service has
no ECS service, no task definition, and the API carries no `INTEGRATIONS_URL`, so
nothing would connect to it — and **an unused credential is one nobody notices
being used**. A `DATABASE_URL` sitting in SSM for a process that does not exist is
the same shape as the stale `MONGODB_URI` parameters that had to be swept out of
this account.

So the database is created locally (`docker-compose.postgres.yml`) and in CI, per
run, and thrown away.

**Whoever gives this service a deploy owns provisioning it**: a role and database
on the shared instance per `oxy-infra` runbook 30, `DATABASE_URL` into
`/oxy/<service>/DATABASE_URL`, that parameter added to the deploy's secret
allowlist in the SAME change, and a migrate step wired into the deploy. Shipping
the image without those means a service that boots and cannot store anything.

## No extensions

This schema uses no PostGIS, no pgvector and no `pg_trgm`, and
`migrate.ts` passes `extensions: []`.

If one is ever needed it is a **privileged prerequisite of the database**, not
something a migration installs. `CREATE EXTENSION` is refused to the owning role
however much it owns the database, and a `CREATE EXTENSION IF NOT EXISTS` guard is
actively harmful: the existence check short-circuits BEFORE the privilege check,
so it is a silent no-op where the extension is already installed and a hard
failure where it is not. It looks like protection and provides none.

## Naming

**Tables: explicit snake_case, plural.** `whatsapp_sessions`, not Mongoose's
derived `whatsappsessions`. The derived name is a `pluralize()` artifact, not a
design, and nothing reads a collection name — call sites are being rewritten,
not shimmed.

**Columns: camelCase in TypeScript, snake_case in SQL**, derived by drizzle from
`DATABASE_CASING` in `@oxyhq/db`. That one setting is read by `createDatabase()`
(what queries reference) and by `drizzle.config.ts` (what the DDL creates), so the
two cannot disagree.

> **Trap:** `column.name` is the TypeScript PROPERTY name (`sessionId`), never the
> SQL name (`session_id`). In hand-written SQL it throws; in a catalogue query or
> an `endsWith('_id')` filter it silently matches nothing and the check passes
> vacuously. Use `sqlColumnName(column)` or interpolate the Column itself and let
> drizzle render it — and `qualified(column)` inside a correlated subquery, where
> a bare render resolves against the wrong table and returns `[]` with no error.

## Primary keys

**`session_id` is the primary key of each session table**, not a surrogate id
beside a unique index on it. Every call site already addresses sessions by
`sessionId`, it is what the adapters pass around, and it is what chats and
messages reference. A surrogate would have been an indirection nothing uses.

Child tables (`*_chats`, `*_messages`) take a `text` id from `generatedId()` —
uuid v7, generated in the application because Postgres 17 has no native
`uuidv7()`. The time component keeps the primary-key btree append-mostly.

**No Mongo `_id` is preserved anywhere.** This service is a genuine greenfield:
its Mongo database held one WhatsApp session and one Telegram session, both dead
sign-in artifacts, and nothing outside it holds a reference to either. That is
NOT the case for `packages/api`, which must preserve `_id` hex verbatim.

## Foreign keys, which Mongo could not express

Chats and messages carry a real `references(() => …sessions.sessionId,
{ onDelete: 'cascade' })`. Under Mongo, deleting a session orphaned every chat and
message that named it and nothing ever collected them. A session's messages are
meaningless without the session, so CASCADE is right here — unlike a commerce
record, which must survive the deletion of what it points at.

`oxy_user_id` carries NO foreign key anywhere: Oxy owns identity, this service
reaches it over HTTP, and a shadow users table would be a cache that can disagree.

## Closed value sets — `text` + CHECK, never a pg `enum`

> **`text({ enum })` EMITS NO DDL.** It is a TypeScript narrowing and nothing
> else — drizzle-kit generates a plain `text` column. A closed value set written
> without `checkOneOf(...)` beside it therefore looks constrained in the editor
> and accepts anything in the database, which is the worst combination available.

Both halves are rendered from the SAME `as const` tuple, so they cannot drift.
`schema.realdb.test.ts` pins this against a real server, and that test was
mutation-tested: asserting a different constraint name turns it red.

A CHECK is `DROP CONSTRAINT` / `ADD CONSTRAINT`; removing or renaming a pg enum
value is not possible.

**The three session-status tuples are deliberately NOT one shared union**, even
though WhatsApp's and Telegram's are identical today. Signal's is genuinely
different (`linking`/`unlinked` rather than `qr-pending`/`logged-out`) because it
links a device rather than scanning into a web session. Two protocols agreeing is
not a shared contract, and one tuple would let a change to either silently widen
the other.

**Adding a value is a code change PLUS a migration.** Under Mongo the enum was
read at runtime and the next write validated against it. Here the constraint is
DDL that has already been applied: the tuple changes the TypeScript union
immediately and changes nothing in the database, so the first write of the new
value fails its CHECK. Both must land in the same PR.

> Note Mongoose never validated enums on `updateOne`/`findOneAndUpdate` at all, so
> a live collection can hold values the schema forbids. This service's data was
> audited before the port; `packages/api` must re-audit **inside its backfill
> script, in the same invocation as the copy**, because an audit whose result can
> expire between running it and using it is not a gate.

## Timestamps

`created_at` / `updated_at` are `timestamptz` via `createdAt()` / `updatedAt()`
from `@oxyhq/db`, matching Mongoose's `timestamps: true`. `updated_at` is
maintained by the application (`$onUpdate`), not a trigger — a trigger is
invisible in the schema file and would overwrite historical values during a
backfill.

**Protocol timestamps stay integers.** `timestamp`, `conversation_timestamp` and
`last_message_timestamp` are epoch values WhatsApp, Telegram and signal-cli
produce, and the adapters echo them back verbatim. They are `bigint({ mode:
'number' })`, not `timestamptz`: converting them would assert a unit (seconds vs
milliseconds) that the protocols do not agree on, change what the value means,
and not be reversible if the assumption is wrong. They are a foreign system's
field, not a date this service owns.

`signal_messages.message_timestamp` is `text` despite the name — it is Signal's
send-timestamp used AS a message id. Renaming it would break the adapter's own
vocabulary for no gain.

## `jsonb`, and what did not earn it

Only `whatsapp_sessions.auth_state` and `.auth_keys`. Baileys owns that format and
changes it across versions, so projecting it into columns would silently drop
whatever a newer Baileys added — the same argument that makes a moderation payload
legitimately shape-less.

Everything else is real columns. Mongoose's `Map<string, unknown>` for `authKeys`
is a plain object in JSON either way, so it needs no special handling.

## Protected columns — the `select: false` replacement

`db.select().from(table)` returns EVERY column. The first naive port of a query is
the first time a Telegram `sessionString` — a full account credential — can be
serialized into a response nobody audited.

`../protectedColumns.ts` holds the registry; read through
`publicColumns(table, PROTECTED_COLUMNS)` from `@oxyhq/db/assert`. The exclusion is
at the TYPE level, so a serializer touching one fails `tsc` — **provided the
registry stays `as const` and is never re-annotated**, which would widen the
literals away and delete the compile-time half while still looking fail-closed.

The MCP columns hold ciphertext, not plaintext, and are still protected:
ciphertext plus a leaked `TOKEN_ENCRYPTION_KEY` is a token, and in an incident the
two travel together.

## Mongoose behaviour with no schema counterpart

`trim`, `lowercase` and setter-style defaults are Mongoose APPLICATION behaviour
and do not survive. None of this schema's unique constraints depended on one, so
nothing needed re-applying at a call site here — but that must be checked per
column in `packages/api`, where a lowercased key backing a UNIQUE index would stop
being unique case-insensitively.

## Migrations

`bun run db:generate` writes the SQL; **`src/db/migrate.ts` is the only thing that
applies it.** Never `drizzle-kit migrate` — a devDependency cannot be reached from
a production image.

Every `.sql` carries exactly one `-- oxy:deploy-phase=pre` (additive) or `post`
(drops, renames, narrows). There is no default and the migrator refuses a file
that does not say.

`--phase` is REQUIRED here, with no fallback. A sibling service defaults to `all`
for local convenience; this one has no legacy invocation to protect, and `all` is
the single value that is wrong against a live database, so it must be typed on
purpose rather than inherited from a forgotten flag. `--phase=all` is for a
from-zero genesis run ONLY: when a chain interleaves phases, neither `pre` nor
`post` alone can apply it against an empty ledger.

`--target-database` is required too. `@oxyhq/db` leaves the guard optional so a
service can adopt the runner without rewriting every invocation; this one adopts it
from day one, so a `DATABASE_URL` pointing somewhere unexpected fails loudly
instead of migrating another tenant on a shared instance.

## Tests run against a REAL Postgres

`vitest.pg.globalSetup.ts` creates one throwaway, fully-migrated database per run
and drops it. The harness SHELLS OUT to `src/db/migrate.ts` rather than composing
`runMigrations` in-process: a second composition is a second set of options free to
drift, and the drift is invisible in the direction that matters — the suite keeps
passing while the script an operator runs is broken.

A mocked `insert` accepts any statement, including one the server rejects outright.
CHECK constraints, partial unique indexes, `ON DELETE CASCADE` and `ON CONFLICT`
have no mocked counterpart, and they are precisely what a port gets wrong.

**Assert driver errors through `@oxyhq/db`'s helpers, never a message regex.**
Drizzle wraps the driver failure: `code` and `constraint_name` live on `cause`, and
the wrapper's message is only `Failed query: …`. This suite failed on exactly that
the first time it ran. Name the CONSTRAINT too — `isUniqueViolation` alone cannot
tell the index under test from any other index on the table.
