#!/usr/bin/env node
/**
 * Read, and optionally correct, the model list a plan grants.
 *
 * ```
 * node packages/api/dist/scripts/plan-models.js --target-database=alia --plan=ultra
 * node packages/api/dist/scripts/plan-models.js --target-database=alia --plan=ultra --apply
 * ```
 *
 * ## Why this exists
 *
 * `plans.model_ids` is what `lib/plan-access.ts` turns into `allowedModelIds`,
 * and therefore what decides whether a request may name a model at all. It is
 * written in exactly two places: `seedPlan`, which is `onConflictDoNothing`, and
 * `setPlanModelIds`, which has no runtime caller — `inference-boundary.test.ts`
 * lists it as a writer with none and fails if a ROUTE acquires one.
 *
 * So a plan row created before a model existed grants that model forever after:
 * the seed will not touch an existing row, and nothing else can. Measured as the
 * symptom `Upgrade your plan to use this model.` on an account holding the most
 * expensive plan there is.
 *
 * The fix is not an admin API — `provider-key.ts` says the same thing about
 * credentials, for the same reason. It is a MECHANISM: an operator-issued
 * one-shot that re-asserts the list the code seeds, through the audited writer,
 * printing what it changed.
 *
 * ## It prints before it writes, and prints again after
 *
 * `--apply` is a separate flag from naming the plan, so the default is a READ.
 * A correction that cannot be inspected first is a correction taken on faith,
 * and the field being corrected is the one that decides who may use what.
 */

import { readTargetDatabase } from '@oxyhq/db/migrate';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { findPlanByPlanId, setPlanModelIds } from '../db/billing/planRepository.js';
import { seededModelIdsFor, seededPlanIds } from '../lib/seed-plans.js';
import type { ConfigAuditActor } from '../lib/security/config-audit.js';
import { log } from '../lib/logger.js';

const logger = log.seed;

/**
 * Named, like the seeder's. An audit record saying `system` is an audit record
 * nobody can act on: this change was made by a person running this command.
 */
const ACTOR: ConfigAuditActor = { kind: 'script', id: 'scripts/plan-models.ts' };

function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** The migrator's own guard: refuse a connection that is not the named database. */
async function assertTargetDatabase(expected: string): Promise<void> {
  const rows = await getDb().execute<{ current_database: string }>(sql`select current_database()`);
  const actual = rows[0]?.current_database;
  if (actual !== expected) {
    throw new Error(
      `refusing to touch plans: --target-database=${expected} but the connection is on ${actual ?? 'an unreadable database'}`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const expectedDatabase = readTargetDatabase(argv);
  const planId = flag(argv, 'plan');
  if (!planId) {
    throw new Error(`--plan is required. Seeded plans: ${seededPlanIds().join(', ')}`);
  }
  const apply = argv.includes('--apply');

  const seeded = seededModelIdsFor(planId);
  if (seeded === null) {
    throw new Error(`${planId} is not a plan this repository seeds. Seeded plans: ${seededPlanIds().join(', ')}`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!connectPostgres(databaseUrl)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);

  const before = await findPlanByPlanId(getDb(), planId);
  if (before === null) throw new Error(`no plan row for ${planId}`);

  const stored = [...before.modelIds].sort();
  const wanted = [...seeded].sort();
  const missing = wanted.filter((id) => !stored.includes(id));
  const extra = stored.filter((id) => !wanted.includes(id));

  logger.info({ planId, stored, wanted, missing, extra }, 'Plan model list');

  if (missing.length === 0 && extra.length === 0) {
    logger.info({ planId }, 'Plan model list already matches the seed, unchanged');
    return;
  }
  if (!apply) {
    logger.warn({ planId, missing, extra }, 'Plan model list DIFFERS from the seed — re-run with --apply to correct it');
    return;
  }

  const after = await setPlanModelIds(getDb(), planId, seeded, ACTOR);
  if (after === null) throw new Error(`update matched no row for ${planId}`);

  // Read back through the same function the check used, not the value returned
  // by the write: a write that reports success and a row that changed are two
  // different facts.
  const verified = await findPlanByPlanId(getDb(), planId);
  const nowStored = [...(verified?.modelIds ?? [])].sort();
  if (nowStored.join(',') !== wanted.join(',')) {
    throw new Error(`plan ${planId} still does not match the seed after the write`);
  }
  logger.info({ planId, modelIds: nowStored }, 'Plan model list corrected');
}

main().then(
  async () => {
    await closePostgres();
    process.exit(0);
  },
  async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    if (cause !== undefined) console.error(`cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    await closePostgres().catch(() => {});
    process.exit(1);
  },
);
