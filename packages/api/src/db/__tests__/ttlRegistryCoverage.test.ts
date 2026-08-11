import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import { sqlColumnName } from '@oxyhq/db';
import { EXPIRY_TARGETS } from '../expiryTargets';
import * as schema from '../schema';

/**
 * A Mongo TTL index that loses its Postgres sweep is the quietest failure in
 * this port. Mongo reaped; Postgres does not. The table simply grows, with no
 * error, no failing test and nothing removed from the diff for a reviewer to
 * notice — the thing doing the work was never in this codebase.
 *
 * So the source of truth is the MONGOOSE SCHEMAS, walked, not a list somebody
 * maintains. A hand-written list falls behind silently; a walk cannot.
 *
 * ## Two failure directions, and only one of them is loud
 *
 * A MISSING registry entry grows a table forever: eventually loud, and
 * recoverable. A WRONG one deletes live rows: silent, and not. So this checks
 * the RULE, not merely the presence of an entry — the retention seconds, the
 * column it is measured from, and above all whether the source declared a
 * `partialFilterExpression` that the flat registry type cannot express.
 *
 * ## Scope: PORTED tables only, deliberately
 *
 * The coverage assertion runs over the INTERSECTION of "declares a TTL" and
 * "has a Postgres table", so it tightens by itself as each batch lands and needs
 * no allow-list to prune. As of the chat/memory batch that intersection is
 * everything: all fourteen declarations are ported and registered.
 *
 * The scoping has a cost that took five batches to surface — it SKIPS whatever
 * is absent from the map, so a table ported without a map entry is invisible to
 * every check here. That is now a check of its own; see the residual below.
 *
 * The source-side walk is asserted non-vacuous independently, so this cannot
 * pass by finding nothing.
 */

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** Every TTL declaration in the Mongoose schemas, read off the schemas themselves. */
interface MongoTtl {
  readonly model: string;
  readonly collection: string;
  /** The Mongoose PATH the TTL is measured from (e.g. `createdAt`, `timestamp`). */
  readonly path: string;
  readonly expireAfterSeconds: number;
  /** Present when the TTL is CONDITIONAL — the case the flat registry cannot express. */
  readonly partialFilterExpression?: Record<string, unknown>;
}

function modelFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (f) =>
        /\.ts$/.test(f) &&
        !/__tests__|\.test\.ts$/.test(f) &&
        (f.startsWith('src/models/') ||
          f.startsWith('src/internal/providers/models/') ||
          f.startsWith('src/internal/providers/lib/') ||
          f.startsWith('src/lib/') ||
          f.startsWith('src/routes/')),
    );
}

const files = modelFiles();
await Promise.all(
  files.map((f) =>
    import(path.join(PACKAGE_ROOT, f.replace(/\.ts$/, '.js'))).catch(() => undefined),
  ),
);

/**
 * Walk every registered Mongoose schema for `expireAfterSeconds`.
 *
 * Read from `schema.indexes()` rather than from source text, so a TTL declared
 * in any spelling — inline options, a separate `.index()` call, a helper — is
 * seen. Source-grepping would miss whichever form nobody thought of.
 */
function declaredMongoTtls(): MongoTtl[] {
  const found: MongoTtl[] = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    for (const [fields, options] of model.schema.indexes()) {
      const opts = options as
        | { expireAfterSeconds?: unknown; partialFilterExpression?: Record<string, unknown> }
        | undefined;
      if (typeof opts?.expireAfterSeconds !== 'number') continue;
      const [ttlPath] = Object.keys(fields as Record<string, unknown>);
      if (!ttlPath) continue;
      found.push({
        model: name,
        collection: model.collection.name,
        path: ttlPath,
        expireAfterSeconds: opts.expireAfterSeconds,
        ...(opts.partialFilterExpression
          ? { partialFilterExpression: opts.partialFilterExpression }
          : {}),
      });
    }
  }
  return found;
}

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

/**
 * Mongoose collection name -> Postgres table name, for the tables ported so far.
 *
 * Explicit rather than derived: Mongoose's name is a `pluralize()` artifact
 * (`authhealthmetrics`) and the Postgres name is a deliberate snake_case choice
 * (`auth_health_metrics`). Nothing can compute one from the other, so the pairing
 * is stated. An absence used to MEAN "not ported yet"; it no longer gets to
 * assert that on its own, because two ported tables sat outside this map for
 * five batches with no sweep. The residual check below makes an absence prove
 * itself.
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

/**
 * TTL-declaring models deliberately NOT ported, so their absence from the map is
 * a decision rather than an oversight.
 *
 * EMPTY, and that is the current truth: all thirteen surviving TTL declarations
 * are ported and registered. A model belongs here only while its table genuinely
 * does not exist in Postgres — and it has to be moved to the map, not deleted,
 * when it lands.
 *
 * `CacheEntry` was the fourteenth. It is not listed here because it is not
 * unported — it is GONE: `lib/intelligent-cache.ts` declared it and had zero
 * importers in the whole repository, so the module, both its collections and
 * both its tables were deleted. A dead model in this set would have read as
 * "still to do" forever.
 */
const TTL_MODELS_NOT_PORTED: ReadonlySet<string> = new Set<string>();

/**
 * TTL declarations whose Mongoose model has been DELETED by the route switch.
 *
 * The route switch breaks this file's central assumption. Every assertion below
 * derives from walking the live Mongoose schemas, which is exactly right while
 * both stores exist — and the moment a slice deletes its models, that walk stops
 * seeing the TTLs those models declared. Nothing goes red: the walk simply
 * returns fewer rows, every downstream check SKIPS the tables it can no longer
 * see, and the retention of a still-swept table becomes unverified. Which is the
 * silent failure the file was written to prevent, reached through the file.
 *
 * So a deleted model's TTL is transcribed here rather than lost. These are read
 * off the source at the commit that removed them and are the last record of what
 * Mongo did — every column and retention check below runs against them exactly as
 * it did while the schema existed.
 *
 * Verified against `d71f723b`:
 *   models/moderation-outbox.ts:114  index({expiresAt: 1}, {expireAfterSeconds: 0})
 *   models/moderation-event.ts:67    index({expiresAt: 1}, {expireAfterSeconds: 0})
 * `models/report.ts` declared NO TTL, so its deletion adds nothing here.
 *
 * This list only ever GROWS, and an entry is never removed: the table it names
 * is still swept, so the rule it states is still live.
 *
 * `retiredBy` names the slice that deleted the model, so an entry can be traced
 * back to the commit that transcribed it — the values here are only as good as
 * that provenance, since the source they were read from no longer exists.
 */
interface RetiredMongoTtl extends MongoTtl {
  /** The slice that deleted the model. */
  readonly retiredBy: string;
}
const RETIRED_MONGO_TTLS: readonly RetiredMongoTtl[] = [
  {
    model: 'ModerationOutbox',
    collection: 'moderation_outbox',
    path: 'expiresAt',
    expireAfterSeconds: 0,
    retiredBy: 'S1 moderation',
  },
  {
    model: 'ModerationEvent',
    collection: 'moderation_events',
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
    model: 'Notification',
    collection: 'notifications',
    /**
     * `NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24
     * * 60 * 60, partialFilterExpression: { status: 'dismissed' } })`, read off
     * `src/models/notification.ts:82` before it was deleted.
     *
     * **The CONDITIONAL one**, and the reason this list matters more than a
     * decrement would. Every assertion about the partial TTL — that it is
     * registered against a DIFFERENT column, that the different column is
     * `dismissed_at`, that a conditional case exists at all — reads the source's
     * `partialFilterExpression`. Delete the model and decrement the floor and
     * all three quietly start measuring an empty set while still passing.
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
];

const walked = declaredMongoTtls();
const ttls = [...walked, ...RETIRED_MONGO_TTLS];
const tables = portedTables();

describe('every ported TTL index has a matching expiry-sweep target', () => {
  it('found the TTL declarations at all', () => {
    // Vacuity floor. An empty walk produces the same "no gaps" verdict as a
    // complete one, so the count is asserted rather than assumed. 14 measured
    // originally; 13 since `CacheEntry` was deleted with its dead module.
    //
    // This number does NOT move as models are deleted — a deletion moves the
    // declaration into `RETIRED_MONGO_TTLS` and the total is conserved. It goes
    // DOWN only when a TTL is deliberately dropped rather than ported, which has
    // to be written down rather than absorbed.
    expect(ttls.length).toBeGreaterThanOrEqual(13);
    expect(tables.size).toBeGreaterThanOrEqual(5);
  });

  it('the WALK itself is still non-vacuous, independently of the retired list', () => {
    /**
     * `RETIRED_MONGO_TTLS` props up the total, so the floor above would keep
     * passing on a walk that had broken ENTIRELY — a stale `dist/`, a rename
     * under `src/models/`, an import that silently threw. That is the same
     * "found less" / "there is less" collapse the floor exists to prevent, one
     * level up, and it arrives the moment a retired list exists at all.
     *
     * So the walk is floored on its own. This number goes DOWN by exactly as
     * many models as a slice deletes, and each of those must appear in
     * `RETIRED_MONGO_TTLS` in the same commit — which is what keeps the two
     * halves adding up to 13.
     *
     * 11 after S1 retired two; 9 once S5 retired `AudioJob` and `Notification`;
     * 8 once S2 retired `AuthHealthMetric`, 7 once it retired `FallbackEvent`, 6 once it retired `RoutingLog`, 5 once it retired `ApiKeyUsage`, 4 once it retired `ApiUsage`.
     * Lowering it is legitimate ONLY in the same change that adds the matching
     * retired entries, and the exact-sum assertion below is what makes that
     * mechanical rather than a judgement call — the two numbers cannot drift
     * apart without one of them going red.
     */
    expect(walked.length).toBeGreaterThanOrEqual(4);
    expect(walked.length + RETIRED_MONGO_TTLS.length).toBe(13);
  });

  it('a retired model is really gone, so its entry cannot double-count a live one', () => {
    // If a model came back — or was never deleted — its TTL would be counted
    // twice and the floors above would pass while measuring one table twice.
    const stillRegistered = RETIRED_MONGO_TTLS.filter((retired) =>
      walked.some((ttl) => ttl.model === retired.model),
    );
    expect(stillRegistered.map((t) => t.model)).toEqual([]);
  });

  it('every retired declaration still names a table that EXISTS', () => {
    /**
     * The third way this list can rot. A retired entry props up the total and
     * feeds the column and retention checks below — but those find their target
     * through `MONGO_MODEL_TO_TABLE`, and skip when there is none. So an entry
     * whose table was never mapped, or was later dropped, keeps the sum at 13
     * while asserting about nothing at all.
     */
    const orphaned = RETIRED_MONGO_TTLS.filter((t) => {
      const table = MONGO_MODEL_TO_TABLE[t.model];
      return !table || !tables.has(table);
    }).map((t) => t.model);

    expect(orphaned).toEqual([]);
  });

  it('every TTL-declaring model is CLASSIFIED, so an absence cannot mean nothing', () => {
    /**
     * The residual, and the check that was missing.
     *
     * `MONGO_MODEL_TO_TABLE` is hand-maintained and every other assertion here
     * SKIPS a model absent from it, on the stated assumption that absent means
     * "not ported yet". That assumption is not self-enforcing: port a table and
     * forget the map entry and the model becomes invisible to the whole gate —
     * no registry entry, no sweep, the table grows forever, and nothing says so.
     * Which is the failure this file exists to prevent, reached through the file.
     *
     * It happened. `moderation_events` and `moderation_outboxes` were ported in
     * batch 2 with TTL declarations and no registry entries, and were found only
     * by counting the targets by hand five batches later.
     *
     * So absence must now be a DECISION rather than a silence: every
     * TTL-declaring model is either mapped to a table or listed as deliberately
     * unported. Being in neither fails.
     *
     * Deriving the answer from names was tried first and is not sound — the
     * collection name is an arbitrary third argument to `mongoose.model()`
     * (`ModerationOutbox` stores in `moderation_outbox`, singular, while
     * `ModerationEvent` uses `moderation_events`, plural). The file comment
     * above always said nothing can compute one from the other; this is that,
     * enforced.
     */
    const classified = ttls.filter(
      (ttl) =>
        MONGO_MODEL_TO_TABLE[ttl.model] === undefined && !TTL_MODELS_NOT_PORTED.has(ttl.model),
    );

    expect(classified.map((ttl) => ttl.model)).toEqual([]);
  });

  it('no model is claimed as both ported and unported', () => {
    // The two lists partition; an overlap would let a ported table hide behind
    // its own exemption.
    const both = [...TTL_MODELS_NOT_PORTED].filter(
      (model) => MONGO_MODEL_TO_TABLE[model] !== undefined,
    );
    expect(both).toEqual([]);
  });

  it('every ported TTL-declaring model has a registry entry', () => {
    const byTable = new Map<string, ExpirySweepTarget>(
      EXPIRY_TARGETS.map((t) => [getTableName(t.table), t]),
    );

    const missing = ttls
      .filter((ttl) => MONGO_MODEL_TO_TABLE[ttl.model] !== undefined)
      .filter((ttl) => !byTable.has(MONGO_MODEL_TO_TABLE[ttl.model] ?? ''))
      .map((ttl) => `${ttl.model} -> ${String(MONGO_MODEL_TO_TABLE[ttl.model])}`);

    expect(missing).toEqual([]);
  });

  it('a CONDITIONAL TTL is registered only against a DIFFERENT column', () => {
    /**
     * The dangerous direction, and the reason this is not simply "conditional
     * models may not be registered" any more.
     *
     * `ExpirySweepTarget` has no predicate. Registering a partial TTL against the
     * column the source measured from therefore deletes rows the source
     * EXCLUDED — silently and unrecoverably. The sanctioned remedy is to make the
     * condition a COLUMN and sweep from that instead, which `notifications`
     * now does (`dismissed_at`, bound to `status` by a CHECK).
     *
     * So the property is no longer "absent from the registry"; it is "registered
     * against a column that is NOT the source's". A conditional TTL pointing at
     * its original column is exactly the flat registration this always forbade.
     */
    const offenders = ttls
      .filter((ttl) => ttl.partialFilterExpression !== undefined)
      .flatMap((ttl) => {
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
      });

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
    const conditional = ttls.filter((t) => t.partialFilterExpression !== undefined);
    expect(conditional.map((t) => t.model)).toContain('Notification');
  });

  it('each UNCONDITIONAL registry entry measures from the SAME column the source did', () => {
    const mismatched: string[] = [];
    for (const target of EXPIRY_TARGETS) {
      const table = getTableName(target.table);
      const ttl = ttls.find((t) => MONGO_MODEL_TO_TABLE[t.model] === table);
      if (!ttl) continue;
      // A CONDITIONAL TTL is required to measure from a DIFFERENT column — that
      // difference IS the condition made into one, and the check above enforces
      // it. Exempting it here is not a loophole: the two assertions together say
      // "same column unless conditional, different column when conditional",
      // which is stricter than either alone.
      if (ttl.partialFilterExpression !== undefined) continue;
      // `column.name` is the TypeScript property name; only sqlColumnName applies
      // the configured casing. Mongoose's path is camelCase, so compare there.
      const registeredPath = sqlColumnName(target.column);
      const sourcePath = ttl.path
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase();
      if (registeredPath !== sourcePath) {
        mismatched.push(`${table}: source measures from ${ttl.path} (${sourcePath}), registry from ${registeredPath}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('each registry entry keeps the SAME retention the source declared', () => {
    const mismatched: string[] = [];
    for (const target of EXPIRY_TARGETS) {
      const table = getTableName(target.table);
      const ttl = ttls.find((t) => MONGO_MODEL_TO_TABLE[t.model] === table);
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
