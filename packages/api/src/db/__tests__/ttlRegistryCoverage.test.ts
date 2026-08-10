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
 * Ten of the fourteen TTL declarations belong to tables that do not exist in
 * Postgres yet. Listing them as known-missing would be a TODO in disguise that
 * somebody has to remember to prune. Instead the coverage assertion runs over
 * the INTERSECTION of "declares a TTL" and "has a Postgres table", so it
 * tightens by itself as each batch lands and needs no allow-list at all.
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
 * is stated — and a TTL-declaring model absent from here is simply not ported
 * yet, which is exactly what makes the coverage assertion tighten by itself.
 */
const MONGO_MODEL_TO_TABLE: Readonly<Record<string, string>> = {
  AuthHealthMetric: 'auth_health_metrics',
  ApiUsage: 'api_usage',
  ApiKeyUsage: 'api_key_usage',
  FallbackEvent: 'fallback_events',
  RoutingLog: 'routing_logs',
  CacheEntry: 'cache_entries',
  OrganizationInvite: 'organization_invites',
  McpOAuthState: 'mcp_oauth_states',
  OAuthState: 'oauth_states',
  TriggerExecution: 'trigger_executions',
  Notification: 'notifications',
  AudioJob: 'audio_jobs',
};

const ttls = declaredMongoTtls();
const tables = portedTables();

describe('every ported TTL index has a matching expiry-sweep target', () => {
  it('found the TTL declarations at all', () => {
    // Vacuity floor. An empty walk produces the same "no gaps" verdict as a
    // complete one, so the count is asserted rather than assumed. 14 measured;
    // this number goes DOWN only when a TTL is deliberately dropped.
    expect(ttls.length).toBeGreaterThanOrEqual(14);
    expect(tables.size).toBeGreaterThanOrEqual(5);
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
