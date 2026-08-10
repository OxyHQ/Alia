/**
 * The autonomy context graph: what Alia has noticed about a user, where it can
 * look, and in what order.
 *
 * Four tables written by one subsystem (`lib/autonomy/`, plus one node update
 * from `routes/oxy-service-events.ts`). They land together because they are one
 * feature and because `context_edges` references `context_nodes` — the first
 * genuine intra-batch relation since `plan_features`.
 *
 * None declared a TTL index, so none appears in `db/expiryTargets.ts`. That is
 * worth a sentence rather than silence: every one of these tables is written by
 * an ingestion path that mints a node per chat turn
 * (`context-graph.ts:234` keys a node on a base64 slice of the message text),
 * so they grow without bound and nothing reaps them. Mongo did not reap them
 * either — this is a faithful port of an existing problem, not one the port
 * introduces, and it is the kind of growth a retention decision should be made
 * about deliberately rather than by adding a sweep here on the way past.
 *
 * ## Everything in this domain is behind a flag that is not on
 *
 * `autonomyFlags.contextGraphEnabled` gates every read and write
 * (`context-graph.ts:125,171`). So production row counts may be zero regardless
 * of age, and a backfill audit reporting "no rows" here is evidence about the
 * flag rather than about the schema.
 *
 * ## `last_seen_at` is `notNull` with NO default, unlike Mongoose's `Date.now`
 *
 * Every writer supplies it — all three node upserts and the edge upsert set it
 * in `$set` (`context-graph.ts:248,264,288`, `oxy-service-events.ts:127`), so
 * the Mongoose default never fires in practice. Reproducing it would mean
 * copying `@oxyhq/db`'s private millisecond-truncated `now()` expression, and a
 * local copy of something that package owns is a second thing to keep in
 * lockstep — the rule this schema's conventions open with. Without a default a
 * caller that forgets gets a NOT NULL violation rather than a silently
 * plausible timestamp, which is the better failure for a column whose whole
 * purpose is freshness.
 */

import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { CONTEXT_NODE_TYPES } from '../../models/context-node.js';
import { CONTEXT_EDGE_TYPES } from '../../models/context-edge.js';
import { CONTEXT_SOURCE_AVAILABILITIES, CONTEXT_SOURCE_KINDS } from '../../models/context-source.js';
import { AUTONOMY_INTENTS } from '../../models/retrieval-strategy.js';
import { checkOneOf } from './columns';

/**
 * A thing the graph knows about, addressed by `node_key` within one user.
 *
 * `metadata` is `jsonb`: `Record<string, unknown>` in Mongoose, composed by
 * whichever ingestion path wrote the node, and read by nothing in SQL.
 *
 * **The three score columns carry no CHECK, and that is deliberate.** They are
 * plainly intended to be 0..1 — every writer sets 0.4, 0.5, 0.85 or 0.9 — but
 * Mongoose declares no `min`/`max`, so this schema declares none either, per
 * the rule that where Mongoose validated nothing neither does the port. A CHECK
 * here would fail on whatever a non-validating write actually stored, in an
 * ingestion path that runs on every chat turn. It is an audit item.
 */
export const contextNodes = pgTable(
  'context_nodes',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    nodeKey: text().notNull(),
    type: text({ enum: CONTEXT_NODE_TYPES as unknown as [string, ...string[]] })
      .notNull()
      .default('unknown'),
    label: text().notNull(),
    metadata: jsonb(),
    freshnessScore: doublePrecision().notNull().default(0.5),
    precisionScore: doublePrecision().notNull().default(0.5),
    costScore: doublePrecision().notNull().default(0.5),
    lastSeenAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('context_nodes_oxy_user_node_key_key').on(t.oxyUserId, t.nodeKey),
    index('context_nodes_oxy_user_type_updated_at_idx').on(t.oxyUserId, t.type, t.updatedAt.desc()),
    checkOneOf('context_nodes_type_check', t.type, CONTEXT_NODE_TYPES),
  ],
);

/**
 * A directed, typed relation between two nodes.
 *
 * ## Both endpoints are REAL foreign keys, and this is the batch's one FK pair
 *
 * `plan_features` is the precedent: a child meaningless without its parent gets
 * a real constraint. An edge is quite literally a pair of node references plus
 * a type — there is nothing left of it once either endpoint is gone.
 *
 * The invariant is already maintained by hand, which is what makes the
 * constraint a statement of existing behaviour rather than a new rule:
 * `context-graph.ts:272` writes the edge only inside
 * `if (userNode && assistantNode)`, after both upserts have returned a
 * document. And nothing in the package deletes a node — all four call sites are
 * upserts — so `ON DELETE CASCADE` constrains nothing that happens today and
 * decides what SHOULD happen when a retention policy eventually does delete
 * one. An orphaned edge would be unreadable and unjoinable; cascading is the
 * only answer that leaves the graph consistent.
 *
 * **These FKs target the PRIMARY KEY, so the `unique()`-versus-`uniqueIndex()`
 * trap does not apply here.** drizzle-kit emits every `ADD CONSTRAINT … FOREIGN
 * KEY` before every `CREATE UNIQUE INDEX`, so an FK pointing at a
 * `uniqueIndex()` generates cleanly and fails at APPLY time with `42830`. A
 * primary key is emitted inline in `CREATE TABLE` and already exists. Stated so
 * nobody "fixes" this by adding a redundant `unique()`, and so the next author
 * pointing an FK at a NON-key column knows the rule still bites there.
 *
 * `oxy_user_id` is denormalised from the nodes, exactly as Mongo had it: it
 * carries the unique index and the browse index, and re-deriving it through two
 * joins to enforce the same uniqueness would be slower and no more correct.
 */
export const contextEdges = pgTable(
  'context_edges',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    fromNodeId: text()
      .notNull()
      .references(() => contextNodes.id, { onDelete: 'cascade' }),
    toNodeId: text()
      .notNull()
      .references(() => contextNodes.id, { onDelete: 'cascade' }),
    edgeType: text({ enum: CONTEXT_EDGE_TYPES as unknown as [string, ...string[]] })
      .notNull()
      .default('unknown'),
    weight: doublePrecision().notNull().default(0.5),
    metadata: jsonb(),
    lastSeenAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('context_edges_oxy_user_from_to_type_key').on(
      t.oxyUserId,
      t.fromNodeId,
      t.toNodeId,
      t.edgeType,
    ),
    index('context_edges_oxy_user_edge_type_updated_at_idx').on(
      t.oxyUserId,
      t.edgeType,
      t.updatedAt.desc(),
    ),
    // Mongo indexed each endpoint on its own. The unique above is prefixed by
    // `(oxy_user_id, from_node_id)` and serves that direction; `to_node_id` gets
    // its own, because the CASCADE has to find rows by it.
    index('context_edges_to_node_id_idx').on(t.toNodeId),
    checkOneOf('context_edges_edge_type_check', t.edgeType, CONTEXT_EDGE_TYPES),
  ],
);

/**
 * A place Alia can read from, and how well that has gone.
 *
 * The counters are `integer` (they are `$inc`-ed by one), the scores and the
 * latency are `double precision`. `avg_latency_ms` is an average and a plain
 * assignment rather than a running mean — `context-graph.ts:193` sets it to the
 * latest run's latency, so the column name is more ambitious than the value.
 * Ported as-is; correcting it is a call-site change, not a schema one.
 *
 * `last_success_at` / `last_error_at` are nullable, and the write path sets one
 * of them to `undefined` on each run. In Mongo `$set: {x: undefined}` leaves the
 * field alone; the same statement in Postgres would write NULL and erase the
 * other timestamp. That is a DESTINATION note for whoever ports the call site,
 * not something the schema can prevent.
 */
export const contextSources = pgTable(
  'context_sources',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    sourceKey: text().notNull(),
    kind: text({ enum: CONTEXT_SOURCE_KINDS as unknown as [string, ...string[]] })
      .notNull()
      .default('unknown'),
    label: text().notNull(),
    availability: text({ enum: CONTEXT_SOURCE_AVAILABILITIES as unknown as [string, ...string[]] })
      .notNull()
      .default('available'),
    freshnessScore: doublePrecision().notNull().default(0.5),
    precisionScore: doublePrecision().notNull().default(0.5),
    avgCostScore: doublePrecision().notNull().default(0.5),
    avgLatencyMs: doublePrecision().notNull().default(0),
    successfulReads: integer().notNull().default(0),
    failedReads: integer().notNull().default(0),
    lastSuccessAt: timestamptz(),
    lastErrorAt: timestamptz(),
    metadata: jsonb(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('context_sources_oxy_user_source_key_key').on(t.oxyUserId, t.sourceKey),
    index('context_sources_oxy_user_kind_updated_at_idx').on(t.oxyUserId, t.kind, t.updatedAt.desc()),
    checkOneOf('context_sources_kind_check', t.kind, CONTEXT_SOURCE_KINDS),
    checkOneOf('context_sources_availability_check', t.availability, CONTEXT_SOURCE_AVAILABILITIES),
  ],
);

/**
 * Which sources to consult for an intent, and how that has gone.
 *
 * ## `source_steps` is `jsonb`, and the reason is NOT that it lacks structure
 *
 * By CONVENTIONS.md's test an element looks like a child row: it has an
 * `order`, a `required` toggle and a `source_key` that names a
 * `context_sources` row. Three identity signals, and the `alia_model_provider_mappings`
 * shape almost exactly.
 *
 * It is `jsonb` because **nothing reads it.** The whole-package grep for
 * `sourceSteps` returns two sites and both are WRITES — `context-graph.ts:111`
 * inside a `create` and `:210` inside a `$setOnInsert` — each building the array
 * from the hardcoded `DEFAULT_SOURCE_PATHS` constant. `recallContextForIntent`
 * loads the strategy only to test that one EXISTS (`:102-103`, an early return
 * on the document) and then ranks sources from `context_sources` instead. So
 * the column is written once at creation from a constant, never updated, and
 * never consulted.
 *
 * A child table would therefore add three to five rows per strategy, a foreign
 * key and an index to model a copy of a compile-time constant that no query
 * touches. The identity signals are real but nothing exercises them, and
 * CONVENTIONS.md's test is about what the data DOES, not what its shape
 * suggests it might.
 *
 * **The trigger for revisiting is specific**, so this does not have to be
 * re-derived: the moment retrieval actually FOLLOWS a strategy — reads
 * `order`, honours `required`, falls back through `fallback_source_keys`, or
 * lets a user edit one — the elements acquire readers and this becomes a child
 * table with a foreign key to `context_sources(oxy_user_id, source_key)`. That
 * is plainly what the fields were designed for; it just has not been built.
 *
 * `unique(oxy_user_id, intent, name)` is Mongo's, kept. Note it does NOT say
 * one ACTIVE strategy per intent, and the write path assumes that: both
 * `ensureIntentStrategy` and `learnFromRun` filter on
 * `{oxyUserId, intent, active: true}`. Two active strategies under different
 * names would make which one they find arbitrary. Adding that partial unique is
 * a real tightening nothing has validated, so it is an audit item rather than a
 * constraint added on the way past — the `triggers.schedule` decision.
 */
export const retrievalStrategies = pgTable(
  'retrieval_strategies',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    intent: text({ enum: AUTONOMY_INTENTS as unknown as [string, ...string[]] }).notNull(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    /** Write-only today. See the table comment before changing this. */
    sourceSteps: jsonb().notNull().default([]),
    freshnessWeight: doublePrecision().notNull().default(0.4),
    precisionWeight: doublePrecision().notNull().default(0.4),
    costWeight: doublePrecision().notNull().default(0.2),
    successCount: integer().notNull().default(0),
    failureCount: integer().notNull().default(0),
    avgLatencyMs: doublePrecision().notNull().default(0),
    lastUsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('retrieval_strategies_oxy_user_intent_name_key').on(t.oxyUserId, t.intent, t.name),
    index('retrieval_strategies_oxy_user_intent_active_idx').on(t.oxyUserId, t.intent, t.active),
    checkOneOf('retrieval_strategies_intent_check', t.intent, AUTONOMY_INTENTS),
  ],
);
