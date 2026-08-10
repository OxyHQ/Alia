# The backfill audit

`db/schema/CONVENTIONS.md` ends with an audit list: every tightening the
Postgres port introduced, in one place, because each is a way the copy can fail.
It is prose. This document is how it becomes something that RUNS, and what is
left to build.

**Shipped:** the skeleton, the harness, the preconditions, and exactly ONE
check — the `23503` dangling-reference count, which is the finding with teeth
and the shape every other blocking check copies. `src/db/backfill-audit/`.

**Not shipped, and specified below:** the remaining checks, which span batches 3,
4, 6, 8 and 9. They were deliberately left to somebody with full attention on the
queries, because the decisions are the expensive part and the queries are the
careful part, and those want different conditions.

---

## Running it

```
bun src/db/backfill-audit/run.ts \
  --uri="$MONGODB_URI" \
  --expect-populated=agents
```

It reads and never writes. Exit `0` means every check ran and no BLOCKING
finding was non-zero; exit `1` means a blocking finding, a failed precondition,
or a check that scanned nothing.

---

## The four decisions the shipped code encodes

Read these before adding a check; each exists because the opposite is what an
audit naturally does wrong.

### 1. The source database is a LITERAL, and the runner refuses to derive it

`SOURCE_DATABASE = 'alia-production'` in `source.ts`, asserted against
`db.databaseName` before a byte is read.

`alia-development` sits on the **same Mongo host** as `alia-production`, with 654
documents in it, and `integrations-production` is beside them. An audit that
derives its source from `NODE_ENV`, a service name, or any pattern can therefore
point at a seeded development copy and report a clean, successful run — and
nothing in the output would look wrong. `--uri` is likewise required rather than
read from the environment, for the same reason: an audit that picks up whatever
connection happens to be configured has made the same class of mistake one step
earlier.

### 2. A successful connection is not evidence there is anything to audit

Every count in an empty or wrong database is zero, and zero is what a clean audit
looks like. So the caller must NAME a collection it has confirmed holds rows
(`--expect-populated=`, repeatable), and the runner refuses when that collection
is empty or absent. Required rather than defaulted, because a positive control
somebody can omit is one nobody runs.

It is deliberately **not** a hardcoded list. The only per-collection figures
available come from a whole-host census dated 2026-08-09, and a constant built
from numbers that may have moved would fail — or pass — for the wrong reason.
Whoever runs the audit has just looked at the database; they are the one who can
supply a fact with today's date on it. **If somebody re-runs that census and can
state dated counts, a hardcoded list is the stronger form and should replace
this** — it cannot be set to something trivially true.

### 3. Collection names are LITERALS, and a missing one is a FAILURE

A Mongoose collection name is an arbitrary third argument, so a derivation over
a model name is a check that cannot fail. Every check declares the collections it
reads; `openAuditSource` asserts each EXISTS before running anything.

That assertion is the load-bearing part: **a query against a misspelled
collection returns zero documents rather than an error**, which is
indistinguishable from a clean result. None of the batch-9 models declares a
`collection:` option, so Mongoose's default pluralisation currently applies — but
that is a fact about today, not a rule to compute from.

### 4. `blocking` and `informational` are different instructions, and are in the TYPE

- **`blocking`** — Postgres will REFUSE these rows. The number is a work item.
- **`informational`** — the copy will succeed; the number is a fact somebody
  needs in order to decide something.

The runner exits non-zero on the first and zero on the second, because "here is a
number you need" and "the backfill will fail" are opposite instructions and one
amber state collapses them. `AuditCheckResult.documentsScanned` is the vacuity
floor and lives on the result rather than in a log line: a check that scanned
nothing returns no findings, which is byte-identical to a check that scanned
everything and found nothing.

---

## The shipped check: dangling foreign-key references

`checks/dangling-references.ts`. **Blocking.** Executes CONVENTIONS.md §"Foreign
keys a legacy row will not satisfy — the EXPECTED failure of batch 9b".

Seven references gained real foreign keys in batch 9, and Mongo enforced none of
them: deleting a `Skill` or a `LibraryFile` never touched the agents referencing
it, `routes/agents/crud.ts:323` deletes an agent with a bare `deleteOne` that
touches nothing, and `populate()` silently dropped every unresolvable entry on
read. That silence is why nobody has seen one — an agent's skill list simply got
shorter.

| Reference | Refused by |
|---|---|
| `agents.skills[]` → `skills` | `agent_skills_skill_id_fk` |
| `agents.knowledge[]` → `libraryfiles` | `agent_knowledge_library_file_id_fk` |
| `agentteams.agents[]` → `agents` | `agent_team_agents_agent_id_fk` |
| `agentteams.skills[]` → `skills` | `agent_team_skills_skill_id_fk` |
| `agentteams.knowledge[]` → `libraryfiles` | `agent_team_knowledge_library_file_id_fk` |
| `agentreviews.agentId` → `agents` | `agent_reviews_agent_id_fk` |
| `eventstreamentries.sessionId` → `agentsessions` | `event_stream_entries_session_id_fk` |

**The remedy is COUNT and DISCARD — do not drop the constraint.** Each dangling
id is an entry the agent's owner already watched disappear from their list, so
discarding it restores nothing and loses nothing, and keeping the constraint is
what makes the same silent shrinkage impossible afterwards. **`agentreviews` is
the one to READ rather than skim**: a large number means agents are being deleted
with reviews attached, and `lib/agent-rating.ts` has been recomputing ratings
against them.

Three things about the implementation that a copied check must preserve:

- **It counts refused ROWS, not dead targets.** Two agents referencing the same
  dead skill are two rows in `agent_skills`, and a per-target count under-reports
  the work by exactly the amount that matters. The SAMPLE is of dead targets,
  which is the right unit for investigating.
- **It offers both the ObjectId and the string form of every id**, and each half
  does different work. The ObjectId form is the PRIMARY match, because the
  internal map is keyed by `String(id)`; without it every reference reads as
  dangling. The string form covers a raw write around Mongoose leaving a 24-hex
  string where the schema declares an ObjectId.
- **It is two passes, not a `$lookup`.** The question is "which ids do not
  resolve", and a join answers "which documents pair up" — the difference shows
  on the empty side, where a `$lookup` yields an empty array that is easy to read
  as a match. Collecting the referenced ids and then asking which exist keeps the
  residual explicit: whatever is left is, by construction, what nothing accounted
  for.

**References deliberately ABSENT, so a reader comparing this against the schema
does not think they were forgotten:** `agent_session_resources.session_id` cannot
dangle (those rows were an embedded array inside the session document), and
`agent_sessions.agent_id`, `containers.session_id` and
`rollback_records.session_id` carry NO foreign key by decision — a dangling id
there is permitted, not a finding.

### How it is proved

`__tests__/dangling-references-real-db.test.ts`, against a real MongoDB. Every
case is PAIRED: seed the violating document and assert non-zero, seed only clean
documents and assert zero. **An audit is the one kind of code whose failure mode
is being reassuring**, so a one-sided test would pass while measuring nothing.

Four mutations, all killed: counting dead targets instead of rows; deleting the
ObjectId candidate line; emptying the declaration list; and removing the
empty-positive-control refusal. Any new check owes the same two-sided fixture
and the same mutation.

---

## The checks still to write

Each is an audit item already argued in `CONVENTIONS.md`; the work is the query
and the two-sided fixture, not the decision. Grouped **by how each fails**,
because a flat list buries the ones that do not announce themselves.

### Blocking — the copy will refuse these rows

| Check | Source | Notes |
|---|---|---|
| Values outside a closed tuple | every `text` + CHECK column | The expected class: Mongoose never validated enums on `updateOne`/`findOneAndUpdate`. Widen the tuple or fix the row; do not drop the CHECK. Needs the tuple imported from the model, never retyped. |
| Numbers outside a Mongoose `min`/`max` | `model_configs.*`, `provider_keys.*`, `alia_models.credit_multiplier`, `credit_packages.*`, `agents.rating` (0..5), `agent_reviews.rating` (**1..5, deliberately different** — do not unify to make an audit pass) | Domain invariants; a violation means a non-validating write path produced it. |
| Duplicates under a new unique | `agent_skills`, `agent_knowledge`, `agent_session_resources`, `agent_team_*`, `user_memory_entries_memory_title_lower_key`, `organizations_slug_lower_key`, `referral_redemptions`, `voice_call_usage_session_id_key` | Several are NEW: Mongo cannot index inside a sub-document array. `agent_team_*` is not new — `$addToSet` was emulating it. |
| `notNull` a legacy row may not satisfy | `subscriptions.plan_snapshot_*`, `voice_call_usage.cost_per_minute`, `library_files.size/url/type`, `skills.system_prompt/author/icon/color/category`, `learning_rules.title/rule_text`, `rollback_records.args/expires_at/executed_at` | `required` binds only writes made after it was added. `skills.icon`/`.color` are likeliest to bite: presentation fields added by a later seed revision. |
| Half-written paired columns | `agent_sessions.plan_objective`/`.plan_items`, `notifications.dismissed_at` vs `status` | New CHECKs. Every writer sets and clears the plan as a unit, so a half plan means a raw write. |

### Informational — a number somebody needs in order to decide

| Check | Why the number matters |
|---|---|
| `learning_rules.priority` / `.hit_count` range | Both invite an obvious CHECK that Mongoose never declared. Know the range before anybody proposes one. |
| `user_credits.credits_free` / `.credits_paid` negative balances | `addCredits` accepts a negative amount, so production may hold one. |
| `context_nodes.*_score`, `context_edges.weight`, `retrieval_strategies.*_weight` outside 0..1 | Every writer sets 0.2–0.95, but Mongoose declares no bound and the write path runs on every chat turn. |
| More than one `retrieval_strategies` row `active` per (user, intent) | Both writers filter on it, so a second active row makes which one they find arbitrary. |
| `triggers.schedule` present with `type NOT IN ('schedule','agent_heartbeat')` | The correct-but-unvalidated tightening deliberately left out. |
| `containers.container_id` duplicates | Two independent creation paths; a partial unique `WHERE status <> 'destroyed'` is the candidate tightening. |
| `agent_sessions.messages` non-empty | Written by nothing and read by nothing package-wide. A non-empty row means the shape assumption behind porting it as inert `jsonb` needs re-reading. |
| `agent_sessions.event_stream` vs `event_stream_entries` disagreement | Measures the fallback's remaining purpose. See CONVENTIONS §"TWO LIVE STORES FOR ONE FACT" — the count is the retirement condition. |
| `provider_keys.organization_id` entirely NULL | A precondition for its CASCADE foreign key. |
| `voice_call_usage.average_latency_ms` / `.client_type` entirely absent | Ported for shape faithfulness; confirm nothing reads one as meaningful. |

### The two that fail LATER rather than during the copy — read these first

1. **The encrypted OAuth columns.** `integrations.oauth_*`,
   `connected_accounts.*`, `bots.bot_token`. The copy must read through the RAW
   driver and write a raw statement, because Mongoose's getters DECRYPT and
   drizzle's `encryptedText` would encrypt a second time. Both readings look
   correct at the time; a double-encrypted row looks like a successful copy and
   fails at the first READ, in production. **The audit is a shape assertion:
   every copied value still matches `iv:authTag:ciphertext`.** That assertion is
   the only thing between "copied" and "copied correctly".
2. **Migration `001-restructure-memories-title-summary-type` must be recorded as
   applied** before `user_memories` is copied, and any source row still carrying
   the legacy `key`/`category` keys refused. The ported schema is written to the
   POST-001 shape and to that shape only.

**Audit in the SAME invocation as the copy.** An audit whose result can expire
between running it and using it is not a gate — the rule CONVENTIONS states about
enums, applied to all of them.

---

## Handover: what the agents-domain SWITCH needs, from the batch-9 census

The schema is complete at 82 tables and everything so far is INERT by
construction — nothing routed, nothing removed. The switch is a different kind of
risk, and CONVENTIONS names it exactly: *a read that silently fell back to Mongo
after its domain had been ported would be indistinguishable from success.*

This section exists because these facts are cheap to write down now and expensive
for anyone to re-derive later. Re-verify anything load-bearing rather than
inheriting it — that rule is why the census that produced them exists.

### The work list is 33 production dependents, not 29 runtime ones

36 files reference `models/agent.ts`: **29 runtime, 4 type-only, 3 test.**

**The undecided part is the loud one.** The four type-only importers —
`lib/agent/actions.ts`, `lib/agent/archetype-prompts.ts`, `lib/agent/tools.ts`,
`lib/system-prompt-builder.ts` — consume `IAgent`'s interfaces and query nothing.
No reader census sees them, and they break the BUILD the moment the model file is
deleted. **Nobody has yet decided, per file, whether each type dies with the
model or needs a permanent home in the new schema.** That decision is owed before
any deletion and is invisible to anyone counting query sites, which is precisely
how it gets skipped.

(`routes/v1/chat-completions.ts` is RUNTIME despite also importing a type:
`import type { IAgent }` at :21, and `await import('../../models/agent.js')` at
:121 with `Agent.findById` at :125 and `Agent.updateOne` at :160.)

### Three test files break on a MOVE without importing anything

`lib/__tests__/trigger-engine.test.ts`,
`lib/crowdsource/__tests__/subjects.test.ts`,
`routes/__tests__/webhooks-perbot.test.ts` — each `vi.mock`s the module PATH.

### `RollbackRecord` has no reader anywhere

`lib/agent/governance.ts` writes it and nothing in the package consults it, so
its switch is a **write-path-only** change. Unusual enough that stating it saves
somebody hunting for the read.

### `agent_sessions.event_stream` versus `event_stream_entries` is a choice the switch must make

Both stores are live: `lib/agent/event-stream.ts` writes only the collection,
`lib/agent/runner.ts` also writes the embedded array on every save (`:424`,
`:678`, `:772`, `:809`), and `getRecentActivity` reads the collection then falls
back to the array. CONVENTIONS §"TWO LIVE STORES FOR ONE FACT" already names the
winner (the collection), the count that measures the fallback's remaining
purpose, and the condition under which the column is dropped in a `post`
migration with the four `runner.ts` writes. **The switch must choose
deliberately, not inherit both.**

### Two schema facts a repository author would otherwise learn the hard way

- **`agents.permissions` is six NULLABLE booleans and NULL means ALL ALLOWED.**
  The model says so outright and `lib/agent/actions.ts:272` tests
  `perms.delegation === false`. A repository that normalises those to `false`
  silently revokes filesystem, network, shell, communications, MCP and delegation
  from every agent predating the group — silently, because a refused capability
  raises nothing.
- **Deleting an agent now cascades.** Mongo's `routes/agents/crud.ts:323` cleaned
  up nothing; the Postgres schema has six separately-argued FK rules, so a
  repository that deletes an agent will remove its reviews and team memberships.
  See CONVENTIONS §"One parent, four children" and §"two references to ONE
  parent, opposite answers".

### And the census METHOD, because two instruments failed producing these numbers

- **Use a `src/` DIRECTORY pathspec.** `git ls-files 'src/**/*.ts'` returns 473
  files and silently DROPS the top-level `src/index.ts` and `src/socket.ts` — and
  `src/socket.ts:8` is a real `Agent` reader. A 473-file vacuity floor looks
  healthy, and 35-instead-of-36 looks like a more careful answer than the loose
  one. Only a residual against a raw grep separates them. Use `src/socket.ts` as
  an explicit positive control.
- **RESOLVE specifiers, do not pattern-match paths.** Strip `.js`, try
  `.ts`/`.tsx`/`index`, accept an import with no extension, and treat
  `await import()`, `require()` and `vi.mock()` as first-class rather than as
  text that happens to contain a path. A classifier testing
  `^\s*import\s+(?!type\b)` cannot distinguish "no runtime import" from "a
  runtime import in a form I did not pattern for", and fails in the direction
  that reports success.
