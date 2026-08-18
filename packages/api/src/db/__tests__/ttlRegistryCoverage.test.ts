import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import { sqlColumnName } from '@oxyhq/db';
import { EXPIRY_TARGETS } from '../expiryTargets';
import * as schema from '../schema';

/**
 * A Mongo TTL index that lost its Postgres sweep is the quietest failure in this
 * port. Mongo reaped; Postgres does not. The table simply grows, with no error,
 * no failing test and nothing removed from the diff for a reviewer to notice —
 * the thing doing the work was never in this codebase.
 *
 * ## The source of truth used to be a WALK. It is now a RECORD, and that is final
 *
 * This file walked the live Mongoose schemas for `expireAfterSeconds`, because a
 * hand-written list falls behind silently and a walk cannot. Every slice of the
 * port then deleted models, the walk saw fewer of them, and each deleted
 * declaration was transcribed into a list so its rule survived its schema. The
 * organizations slice retired the last one; the walk has returned `[]` since.
 *
 * A walk over a permanently empty set is not a source of truth, it is a prop —
 * and keeping Mongoose installed to run it would have made "the driver is still
 * a dependency" self-justifying. So the walk is gone and {@link MONGO_TTLS} is
 * the whole subject: thirteen declarations, closed, each read off the source at
 * the commit that deleted it.
 *
 * **The record cannot grow.** No Mongoose model can be declared in this package
 * any more, and `db/__tests__/bootWiring.test.ts` asserts that as an exact set of
 * importers rather than leaving it to convention. That is what replaced the
 * walk: it goes red the day a model comes back, which is the only event that
 * could add a fourteenth row here.
 *
 * **The record must not shrink.** Every row is a LIVE retention requirement on
 * the Postgres sweep. Deleting one deletes the only surviving statement of what
 * Mongo did, and every assertion below is a check on `EXPIRY_TARGETS` and the
 * drizzle schema as they are today — a dropped table, a repointed sweep column
 * or an altered retention is red, with no Mongo anywhere.
 *
 * ## Two failure directions, and only one of them is loud
 *
 * A MISSING registry entry grows a table forever: eventually loud, and
 * recoverable. A WRONG one deletes live rows: silent, and not. So this checks
 * the RULE, not merely the presence of an entry — the retention seconds, the
 * column it is measured from, and above all whether the source declared a
 * `partialFilterExpression` that the flat registry type cannot express.
 */

/** A TTL index MongoDB enforced, as declared by the schema that has since been deleted. */
interface MongoTtl {
  readonly model: string;
  readonly collection: string;
  /** The Mongoose PATH the TTL was measured from (e.g. `createdAt`, `timestamp`). */
  readonly path: string;
  readonly expireAfterSeconds: number;
  /** Present when the TTL was CONDITIONAL — the case the flat registry cannot express. */
  readonly partialFilterExpression?: Record<string, unknown>;
  /** The slice that deleted the model, so an entry can be traced to the commit that transcribed it. */
  readonly retiredBy: string;
}

/**
 * Every TTL index this service ever declared in MongoDB.
 *
 * These are read off the source at the commit that removed each model and are
 * the last record of what Mongo did. The values are only as good as that
 * provenance, which is why each row cites the file and line it came from — those
 * citations are repo-rooted deliberately, so nothing mistakes them for live
 * module specifiers.
 */
const MONGO_TTLS: readonly MongoTtl[] = [
  {
    model: 'ModerationOutbox',
    collection: 'moderation_outbox',
    // `models/moderation-outbox.ts:114  index({expiresAt: 1}, {expireAfterSeconds: 0})`,
    // verified against `d71f723b`.
    path: 'expiresAt',
    expireAfterSeconds: 0,
    retiredBy: 'S1 moderation',
  },
  {
    model: 'ModerationEvent',
    collection: 'moderation_events',
    // `models/moderation-event.ts:67  index({expiresAt: 1}, {expireAfterSeconds: 0})`,
    // verified against `d71f723b`. `models/report.ts` declared NO TTL, so its
    // deletion adds nothing here.
    path: 'expiresAt',
    expireAfterSeconds: 0,
    retiredBy: 'S1 moderation',
  },
  {
    model: 'AudioJob',
    collection: 'audiojobs',
    // `AudioJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 })`,
    // read off `src/models/audio-job.ts:40` before it was deleted.
    path: 'createdAt',
    expireAfterSeconds: 86400,
    retiredBy: 'S5 notifications — audio_jobs',
  },
  {
    model: 'McpOAuthState',
    collection: 'mcpoauthstates',
    /**
     * `McpOAuthStateSchema.index({ createdAt: 1 }, { expireAfterSeconds:
     * MCP_OAUTH_STATE_TTL_SECONDS })`, read off `src/models/mcp-oauth-state.ts:29`
     * before it was deleted, with the constant at `:12` — 10 minutes.
     *
     * Measured from CREATION, not from a deadline: the row is consumed by an
     * atomic delete when the callback lands, so the sweep only ever reaps
     * ABANDONED flows. That constant now lives on the column it describes, in
     * `db/schema/integrations.ts`, so the sweep's retention and the callback's
     * liveness check read the same number.
     */
    path: 'createdAt',
    expireAfterSeconds: 10 * 60,
    retiredBy: 'S4 integrations — mcp_oauth_states',
  },
  {
    model: 'OAuthState',
    collection: 'oauthstates',
    /**
     * `OAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })`,
     * read off `src/routes/integrations-oauth.ts:18` at `69d4b3d4`, the commit
     * before S4 removed it.
     *
     * **The one declared in a ROUTE file**, not under `src/models/` — which is
     * why the count moved when a route stopped declaring a model, and why the
     * walk that used to feed this list had to read `src/routes/` too.
     *
     * `expires_at` IS the deadline, so retention is ZERO. The sibling
     * `organization_invites` has a deadline column AND a 30-day retention; the
     * two look alike and are not.
     */
    path: 'expiresAt',
    expireAfterSeconds: 0,
    retiredBy: 'S4 integrations — oauth_states',
  },
  {
    model: 'Notification',
    collection: 'notifications',
    /**
     * `NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24
     * * 60 * 60, partialFilterExpression: { status: 'dismissed' } })`, read off
     * `src/models/notification.ts:82` before it was deleted.
     *
     * **The CONDITIONAL one**, and the reason this record matters more than a
     * count would. Every assertion about the partial TTL — that it is registered
     * against a DIFFERENT column, that the different column is `dismissed_at`,
     * that a conditional case exists at all — reads this
     * `partialFilterExpression`. Drop the row and all three quietly start
     * measuring an empty set while still passing.
     */
    path: 'createdAt',
    expireAfterSeconds: 90 * 24 * 60 * 60,
    partialFilterExpression: { status: 'dismissed' },
    retiredBy: 'S5 notifications — notifications',
  },
  {
    model: 'AuthHealthMetric',
    collection: 'authhealthmetrics',
    // `AuthHealthMetricSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 *
    // 24 * 60 * 60 })`, read off `src/lib/auth-health.ts:53` before the model —
    // which was declared INLINE in that module, beside the functions using it —
    // was deleted.
    path: 'createdAt',
    expireAfterSeconds: 7 * 24 * 60 * 60,
    retiredBy: 'S2 providers + telemetry — auth_health_metrics',
  },
  {
    model: 'FallbackEvent',
    collection: 'fallbackevents',
    // `FallbackEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 *
    // 24 * 60 * 60 })`, read off
    // `src/internal/providers/models/fallback-event.ts:46` before it was
    // deleted. Note the path is `timestamp`, NOT `createdAt` — the model set its
    // own event time and the sweep must keep measuring from that column.
    path: 'timestamp',
    expireAfterSeconds: 30 * 24 * 60 * 60,
    retiredBy: 'S2 providers + telemetry — fallback_events',
  },
  {
    model: 'RoutingLog',
    collection: 'routinglogs',
    // `RoutingLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 *
    // 60 * 60 })`, read off `src/models/routing-log.ts:56` before it was
    // deleted.
    path: 'createdAt',
    expireAfterSeconds: 90 * 24 * 60 * 60,
    retiredBy: 'S2 providers + telemetry — routing_logs',
  },
  {
    model: 'ApiKeyUsage',
    collection: 'apikeyusages',
    // `ApiKeyUsageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 *
    // 60 * 60 })`, read off `src/models/api-key-usage.ts:88` before it was
    // deleted.
    path: 'timestamp',
    expireAfterSeconds: 90 * 24 * 60 * 60,
    retiredBy: 'S2 providers + telemetry — api_key_usage',
  },
  {
    model: 'ApiUsage',
    collection: 'apiusages',
    // `ApiUsageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 48 * 60 *
    // 60 })`, read off `src/internal/providers/models/api-usage.ts:25` before it
    // was deleted. 48 hours — by far the shortest retention in the service, and
    // the one most obviously wrong to carry across as a default.
    path: 'timestamp',
    expireAfterSeconds: 48 * 60 * 60,
    retiredBy: 'S2 providers + telemetry — api_usage',
  },
  {
    model: 'TriggerExecution',
    collection: 'triggerexecutions',
    // `TriggerExecutionSchema.index({ startedAt: 1 }, { expireAfterSeconds: 30 *
    // 24 * 60 * 60 })`, read off `src/models/trigger-execution.ts:86` before it
    // was deleted. The ONLY TTL among S8's eight models — the other seven
    // declared none, so no entry is owed for them.
    //
    // It measures from `started_at` rather than a `created_at`, because the
    // model set `timestamps: false` and had no `created_at` to measure from;
    // `trigger_executions` carries none either, so the sweep reads the same
    // column the TTL index did.
    path: 'startedAt',
    expireAfterSeconds: 30 * 24 * 60 * 60,
    retiredBy: 'S8 automation — trigger_executions',
  },
  {
    model: 'OrganizationInvite',
    collection: 'organizationinvites',
    /**
     * `OrganizationInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30
     * * 24 * 60 * 60 })`, read off `src/models/organization-invite.ts:70` before
     * it was deleted. The collection name was MEASURED by registering the schema
     * (`mongoose.model('OrganizationInvite', …).collection.name`), not derived —
     * see {@link MONGO_MODEL_TO_TABLE} for why nothing computes one from the
     * other.
     *
     * **The LAST live TTL declaration in this service, and the only one measured
     * from a deadline with a NON-ZERO retention.** Every other `expires_at` TTL
     * here — `moderation_outboxes`, `moderation_events`, `oauth_states` — is
     * retention 0, so the pattern a reader arrives with deletes an invitation the
     * moment it expires and takes with it the window in which the UI can say
     * "this invitation expired" rather than 404ing somebody who followed a link
     * from their inbox.
     */
    path: 'expiresAt',
    expireAfterSeconds: 30 * 24 * 60 * 60,
    retiredBy: 'S9 organizations — organization_invites',
  },
];

/**
 * Mongoose collection name -> Postgres table name.
 *
 * Explicit rather than derived: Mongoose's name was a `pluralize()` artifact
 * (`authhealthmetrics`) and the Postgres name is a deliberate snake_case choice
 * (`auth_health_metrics`). Nothing can compute one from the other, so the pairing
 * is stated — and deriving it from names was tried and is not sound, because the
 * collection name was an arbitrary third argument to `mongoose.model()`
 * (`ModerationOutbox` stored in `moderation_outbox`, singular, while
 * `ModerationEvent` used `moderation_events`, plural).
 *
 * Every entry in {@link MONGO_TTLS} must appear here — an absence used to mean
 * "not ported yet" and silently excused a model from every check below, which is
 * how `moderation_events` and `moderation_outboxes` went five batches with a TTL
 * and no sweep. Nothing is unported now, so the classification check is an
 * exact one.
 */
const MONGO_MODEL_TO_TABLE: Readonly<Record<string, string>> = {
  AuthHealthMetric: 'auth_health_metrics',
  ApiUsage: 'api_usage',
  ApiKeyUsage: 'api_key_usage',
  FallbackEvent: 'fallback_events',
  RoutingLog: 'routing_logs',
  OrganizationInvite: 'organization_invites',
  McpOAuthState: 'mcp_oauth_states',
  OAuthState: 'oauth_states',
  TriggerExecution: 'trigger_executions',
  Notification: 'notifications',
  AudioJob: 'audio_jobs',
  ModerationOutbox: 'moderation_outboxes',
  ModerationEvent: 'moderation_events',
};

/** Postgres tables that exist today, by SQL table name. */
function portedTables(): Map<string, PgTable> {
  const tables = new Map<string, PgTable>();
  for (const value of Object.values(schema)) {
    // A drizzle table is the only export carrying the table-name symbol.
    if (value && typeof value === 'object' && Symbol.for('drizzle:Name') in value) {
      tables.set(getTableName(value as PgTable), value as PgTable);
    }
  }
  return tables;
}

const tables = portedTables();

describe('every TTL index Mongo enforced has a matching expiry-sweep target', () => {
  it('has the whole record, and read a real schema', () => {
    /**
     * Vacuity floor on both inputs. An empty record produces the same "no gaps"
     * verdict as a complete one, and a `schema` barrel that stopped exporting
     * tables would make every lookup below miss for a reason that has nothing to
     * do with the sweep.
     *
     * EXACT rather than a floor, in the direction that matters: the record is
     * CLOSED — no Mongoose model can be declared in this package, so a
     * fourteenth row is not possible without `bootWiring.test.ts` going red
     * first — and each row is a live retention requirement, so a twelfth is a
     * rule silently deleted.
     */
    expect(MONGO_TTLS.length).toBe(13);
    expect(tables.size).toBeGreaterThanOrEqual(5);
  });

  it('records each declaration exactly once', () => {
    // A repeated model or collection would let one rule stand in for another
    // while the count above still read 13.
    const models = MONGO_TTLS.map((t) => t.model);
    expect(new Set(models).size).toBe(models.length);
    const collections = MONGO_TTLS.map((t) => t.collection);
    expect(new Set(collections).size).toBe(collections.length);
    // Every entry says who retired it, so a row is auditable against history.
    expect(MONGO_TTLS.filter((t) => t.retiredBy.trim() === '')).toEqual([]);
  });

  it('every declaration names a table that EXISTS', () => {
    /**
     * The way this record rots. A row props the count up and feeds the column
     * and retention checks below — but those find their target through
     * {@link MONGO_MODEL_TO_TABLE}, and skip when there is none. So a row whose
     * table was never mapped, or was later dropped from the schema, keeps the
     * count at 13 while asserting about nothing at all.
     */
    const orphaned = MONGO_TTLS.filter((t) => {
      const table = MONGO_MODEL_TO_TABLE[t.model];
      return !table || !tables.has(table);
    }).map((t) => t.model);

    expect(orphaned).toEqual([]);
  });

  it('maps nothing that the record does not name', () => {
    // The other direction, so the map cannot carry a table no rule requires —
    // which would make the check above pass on a stale pairing.
    const recorded = new Set(MONGO_TTLS.map((t) => t.model));
    expect(Object.keys(MONGO_MODEL_TO_TABLE).filter((m) => !recorded.has(m))).toEqual([]);
  });

  it('every declaration has a registry entry', () => {
    const byTable = new Map<string, ExpirySweepTarget>(
      EXPIRY_TARGETS.map((t) => [getTableName(t.table), t]),
    );

    const missing = MONGO_TTLS.filter(
      (ttl) => !byTable.has(MONGO_MODEL_TO_TABLE[ttl.model] ?? ''),
    ).map((ttl) => `${ttl.model} -> ${String(MONGO_MODEL_TO_TABLE[ttl.model])}`);

    expect(missing).toEqual([]);
  });

  it('a CONDITIONAL TTL is registered only against a DIFFERENT column', () => {
    /**
     * The dangerous direction.
     *
     * `ExpirySweepTarget` has no predicate. Registering a partial TTL against the
     * column the source measured from therefore deletes rows the source
     * EXCLUDED — silently and unrecoverably. The sanctioned remedy is to make the
     * condition a COLUMN and sweep from that instead, which `notifications`
     * does (`dismissed_at`, bound to `status` by a CHECK).
     *
     * So the property is not "absent from the registry"; it is "registered
     * against a column that is NOT the source's". A conditional TTL pointing at
     * its original column is exactly the flat registration this forbids.
     */
    const offenders = MONGO_TTLS.filter((ttl) => ttl.partialFilterExpression !== undefined).flatMap(
      (ttl) => {
        const table = MONGO_MODEL_TO_TABLE[ttl.model];
        const target = EXPIRY_TARGETS.find((t) => getTableName(t.table) === table);
        if (!table || !target) return [];
        const registeredPath = sqlColumnName(target.column);
        const sourcePath = ttl.path.replace(/([A-Z])/g, '_$1').toLowerCase();
        return registeredPath === sourcePath
          ? [
              `${ttl.model}: TTL is conditional on ${JSON.stringify(ttl.partialFilterExpression)} ` +
                `but ${table} is swept from ${registeredPath}, the SAME column the source measured ` +
                'from — that deletes rows the condition excluded. Make the condition a column.',
            ]
          : [];
      },
    );

    expect(offenders).toEqual([]);
  });

  it('the conditional case really is registered against its condition column', () => {
    // The positive half. Without it the check above passes just as well when
    // `notifications` is absent from the registry entirely, which is the state
    // it used to be in — so this is what stops a silent regression to "not swept
    // at all" being read as compliance.
    const target = EXPIRY_TARGETS.find((t) => getTableName(t.table) === 'notifications');
    if (!target) throw new Error('notifications must be registered in EXPIRY_TARGETS');
    expect(sqlColumnName(target.column)).toBe('dismissed_at');
  });

  it('knows the conditional case exists, so the check above is not vacuous', () => {
    // If this ever finds nothing, the assertion above is measuring an empty set
    // and would pass however the registry were written.
    const conditional = MONGO_TTLS.filter((t) => t.partialFilterExpression !== undefined);
    expect(conditional.map((t) => t.model)).toContain('Notification');
  });

  it('each UNCONDITIONAL registry entry measures from the SAME column the source did', () => {
    const mismatched: string[] = [];
    for (const target of EXPIRY_TARGETS) {
      const table = getTableName(target.table);
      const ttl = MONGO_TTLS.find((t) => MONGO_MODEL_TO_TABLE[t.model] === table);
      if (!ttl) continue;
      // A CONDITIONAL TTL is required to measure from a DIFFERENT column — that
      // difference IS the condition made into one, and the check above enforces
      // it. Exempting it here is not a loophole: the two assertions together say
      // "same column unless conditional, different column when conditional",
      // which is stricter than either alone.
      if (ttl.partialFilterExpression !== undefined) continue;
      // `column.name` is the TypeScript property name; only sqlColumnName applies
      // the configured casing. Mongoose's path was camelCase, so compare there.
      const registeredPath = sqlColumnName(target.column);
      const sourcePath = ttl.path.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (registeredPath !== sourcePath) {
        mismatched.push(
          `${table}: source measures from ${ttl.path} (${sourcePath}), registry from ${registeredPath}`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('each registry entry keeps the SAME retention the source declared', () => {
    const mismatched: string[] = [];
    for (const target of EXPIRY_TARGETS) {
      const table = getTableName(target.table);
      const ttl = MONGO_TTLS.find((t) => MONGO_MODEL_TO_TABLE[t.model] === table);
      if (!ttl) continue;
      if (ttl.expireAfterSeconds !== target.retentionSeconds) {
        mismatched.push(
          `${table}: source ${ttl.expireAfterSeconds}s, registry ${target.retentionSeconds}s`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });
});
