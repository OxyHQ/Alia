#!/usr/bin/env node
/**
 * The ONLY thing that seeds this service's reference data.
 *
 * Run as a one-shot task on the deploy boundary:
 * `node packages/api/dist/scripts/seed.js --target-database=alia`.
 *
 * ## Why a deploy one-shot and not boot, and not a migration
 *
 * The seeders were ported to Postgres one domain at a time. Their TRIGGER was
 * not ported with them, and that is the whole defect: five of them sat inside
 * `runStartupSeed()`, which had zero callers repo-wide, and the rest sat inside
 * `startBackgroundServices()`, reachable only from `connectDB().then(...)` —
 * a Mongo connection that no longer exists and never resolves. Both groups are
 * correct code wired to nothing, which is why production holds 0 `plans` and
 * every account falls to the free floor.
 *
 * Of the four places the trigger could go:
 *
 *  - **Boot, blocking.** A seed failure means `server.listen` is never reached,
 *    so `/health/live` never answers, so the target group never gets a healthy
 *    member. A transient database blip becomes a total outage instead of a
 *    degraded one — and liveness is the one signal the load balancer cannot
 *    route around. It also runs once per TASK and races every sibling.
 *  - **Boot, non-blocking.** What the code does today: `.catch(log)` after
 *    `listen`. A broken seed is then invisible, which is exactly how this was
 *    missed for the length of the port.
 *  - **A migration.** Seed data frozen in an append-only ledger cannot track
 *    constants that change, and it would break the measured invariant that NO
 *    migration seeds any of these tables — the positive control the
 *    fresh-schema column in `docs/migration/epic-139-status.md` rests on.
 *  - **This: a one-shot on the deploy boundary.** Runs exactly once per
 *    release rather than once per task, fails the deploy loudly with its
 *    CloudWatch logs rather than logging into the void, never gates the socket,
 *    and keeps migrations seed-free. The mechanism already exists and is proven
 *    at `desiredCount: 0` — it is what applies the post-phase migration.
 *
 * **The gap, stated rather than solved:** a deploy one-shot does not run if
 * somebody raises `desired_count` WITHOUT deploying. That is a real scenario
 * right now. An operator in that position runs this same command as a one-shot
 * task by hand — `aws ecs run-task` with a command override on the service's
 * current revision, which registers no task definition and writes nothing else.
 *
 * ## Re-running is safe
 *
 * Every seeder underneath is INSERT-IF-ABSENT except `skills`: `seedPlan`,
 * `seedFeature`, `seedCreditPackage` and `seedPlanFeatures` all use
 * `onConflictDoNothing`, and `db/billing/planRepository.ts` records that the
 * plan upsert was deliberately changed away from `onConflictDoUpdate({ set: {
 * modelIds } })`.
 *
 * The corollary matters more: **this does not re-assert configuration.** It
 * fills gaps. A wrong row already in the table stays wrong, and
 * `lib/routing/__tests__/routing-config-audit.test.ts` is the gate that keeps
 * that fact honest.
 *
 * ## `skills` reconciles, and the exception is NARROWER than the seeder
 *
 * `seedSkills` overwrites by design: Alia's built-in skill text is a release
 * artefact, not a hand-edited row, and freezing it at whatever shipped first
 * would defeat the seeder while satisfying the letter of the rule above.
 *
 * So the guarantee that survives is not "skills reconcile" — it is the narrower
 * and more useful one: **`upsertBuiltInSkill` may overwrite a row that is
 * already `is_built_in`, and can never touch a user-created one.** The conflict
 * target is `skill_id`, which users also mint, so the `DO UPDATE` carries
 * `setWhere: is_built_in = true` and DECLINES a colliding user row rather than
 * claiming it. Measured before that clause existed: a user's skill came back
 * with Alia's title and prompt, `is_built_in` flipped true and `oxy_user_id`
 * still naming the user — who is then locked out of it, because
 * `updateOwnedSkill` and `deleteOwnedSkill` both require `is_built_in = false`.
 *
 * ## What is ENFORCED here, and what is only prose
 *
 * Say this plainly rather than implying a coverage that does not exist. The
 * "insert-if-absent" property of the other six seeders is **prose** — nothing
 * asserts it, and a seeder switched to `onConflictDoUpdate` would contradict
 * this comment silently. The `skills` exception is the one that carries a gate:
 * `db/__tests__/skillRepository.pgdb.test.ts` asserts a user-created row
 * survives a seed run byte-identical and that a built-in one is refreshed, in
 * both mutation directions.
 *
 * ## What is deliberately NOT seeded here
 *
 *  - **`bots`.** `lib/seed-bots.ts` derives the bot id from
 *    `TELEGRAM_BOT_TOKEN` / `DISCORD_APP_ID`, and neither is set on the task
 *    definition. Run today it writes the literal placeholders `telegram-bot`
 *    and `discord-bot`, keyed on ids that change the moment real credentials
 *    arrive — a wrong row that looks right.
 *  - **`resetAllCircuitBreakers` / `resetAllKeyCooldowns`.** These were inside
 *    `runStartupSeed()` and are not seeds at all. Resetting a circuit breaker
 *    discards evidence that a provider is failing; a release boundary is not a
 *    reason for that to happen.
 */

import { sql } from 'drizzle-orm';
import { readTargetDatabase } from '@oxyhq/db/migrate';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { log } from '../lib/logger.js';
import { seedCreditPackages } from '../internal/providers/lib/seed-credit-packages.js';
import { seedFeatures, seedPlanFeatures } from '../internal/providers/lib/seed-features.js';
import { seedAliaModels, seedModelConfigs } from '../internal/providers/lib/seed-model-configs.js';
import { seedCompedAccounts } from '../lib/seed-comped-accounts.js';
import { seedPlans } from '../lib/seed-plans.js';
import { seedSkills } from '../lib/skills/seed.js';
import { seedSuggestions } from '../lib/seed-suggestions.js';

const logger = log.seed;

/**
 * The order is a FOREIGN KEY constraint, not a preference.
 *
 * `plan_features` carries `plan_features_plan_id_fk` → `plans.plan_id` and
 * `plan_features_feature_id_fk` → `features.feature_id`
 * (`drizzle/0003_closed_black_queen.sql:364-365`), so both parents must exist
 * first. `runStartupSeed()` had `seedFeatures()` then `seedPlanFeatures()` with
 * no `seedPlans()` between them — that function moved to `src/index.ts` — so on
 * an EMPTY database it would have failed with a foreign-key violation. It never
 * did, only because it never ran.
 *
 * `alia_model_provider_mappings` has the same shape against `alia_models` and
 * `model_configs`, which is why `seedModelConfigs` precedes `seedAliaModels`.
 */
const SEEDERS: readonly { readonly name: string; readonly run: () => Promise<unknown> }[] = [
  { name: 'model_configs', run: seedModelConfigs },
  { name: 'alia_models', run: seedAliaModels },
  { name: 'features', run: seedFeatures },
  { name: 'plans', run: seedPlans },
  { name: 'plan_features', run: seedPlanFeatures },
  { name: 'credit_packages', run: seedCreditPackages },
  /**
   * After `plans`: it picks the most expensive plan out of the catalogue, so an
   * empty `plans` table makes it throw rather than comp nobody quietly.
   */
  { name: 'comped_accounts', run: seedCompedAccounts },
  { name: 'suggestions', run: seedSuggestions },
  /**
   * Last, and order-independent: `skills` is referenced by `agent_skills`, which
   * nothing here seeds, so it has no parent to wait for. Placed at the end so
   * the foreign-key-ordered prefix above stays readable as one sequence.
   */
  { name: 'skills', run: seedSkills },
];

/**
 * Refuse a database that is not the one the caller named.
 *
 * The same guard `db/migrate.ts` requires, for the same reason: `alia` shares
 * the `oxy-postgres` instance with five other services, so a mistyped
 * connection string has somewhere wrong to point — and unlike a migration, a
 * seed writes 174 feature rows before anything looks odd.
 *
 * `readTargetDatabase` is the migrator's own parser, so the flag cannot be
 * spelled differently here. The comparison is issued through drizzle rather
 * than through `assertMigrationTarget`, which needs the raw `postgres.js`
 * client that `db/index.ts` deliberately does not expose; reaching into the
 * handle for one script is the worse trade. It is the FIRST statement on the
 * connection, which is the property that matters.
 */
async function assertTargetDatabase(expected: string): Promise<void> {
  const rows = await getDb().execute<{ current_database: string }>(sql`select current_database()`);
  const actual = rows[0]?.current_database;
  if (actual !== expected) {
    throw new Error(
      `refusing to seed: --target-database=${expected} but the connection is on ${actual ?? 'an unreadable database'}`,
    );
  }
}

async function main(): Promise<void> {
  // Parsed before DATABASE_URL is read and before anything opens a socket, so an
  // operator who forgot the flag learns it instantly rather than after a connect.
  const expectedDatabase = readTargetDatabase(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to seed');
  }
  if (!connectPostgres(databaseUrl)) {
    throw new Error('DATABASE_URL is required to seed');
  }

  await assertTargetDatabase(expectedDatabase);

  for (const seeder of SEEDERS) {
    // Sequential, not `Promise.all`: the order above is a foreign-key
    // constraint. Nothing here is slow enough for the concurrency to be worth
    // the failure mode.
    await seeder.run();
    logger.info({ table: seeder.name }, 'Seeded');
  }

  logger.info({ tables: SEEDERS.length }, 'Seeding complete');
}

main().then(
  async () => {
    await closePostgres();
    process.exit(0);
  },
  async (error: unknown) => {
    // Non-zero, so `run_one_shot_command` fails the deploy and prints this
    // task's CloudWatch logs. A seed that reports and exits 0 is the shape this
    // entrypoint exists to replace.
    //
    // The CAUSE, not just the message. A drizzle error's message is the whole
    // failing SQL with its bind parameters, and its SQLSTATE is on `cause` — so
    // printing `error.message` alone hands an operator six hundred bind
    // parameters and no reason. Measured while building this file: a deliberate
    // foreign-key violation printed the entire `plan_features` insert and never
    // the words "violates foreign key constraint". With this, the same failure
    // reports `sqlstate: 23503` and `Key (plan_id)=(free) is not present in
    // table "plans"`.
    console.error(error instanceof Error ? error.message : error);
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    if (cause !== undefined) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : undefined;
      const detail =
        typeof cause === 'object' && cause !== null && 'detail' in cause ? String(cause.detail) : undefined;
      console.error(`cause: ${cause instanceof Error ? cause.message : String(cause)}`);
      if (code !== undefined) console.error(`sqlstate: ${code}`);
      if (detail !== undefined) console.error(`detail: ${detail}`);
    }
    await closePostgres().catch(() => {});
    process.exit(1);
  },
);
