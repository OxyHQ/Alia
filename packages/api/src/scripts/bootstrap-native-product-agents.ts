#!/usr/bin/env node
/**
 * Apply Oxy's native product-agent manifest to Alia's `agents` table.
 *
 * ```
 * node packages/api/dist/scripts/bootstrap-native-product-agents.js --target-database=alia
 * APPLY=1 BOOTSTRAP_ACTOR=... BOOTSTRAP_REASON=... EXPECTED_PLAN_SHA256=... \
 *   node packages/api/dist/scripts/bootstrap-native-product-agents.js --target-database=alia
 * ```
 *
 * ## What it is for
 *
 * Oxy provisions the project, the bot account, the application and the service
 * credential for Sindi and for Clarity, and publishes the four ids that bind
 * them. Alia owns the `agents` row those ids describe, and nothing in Alia had
 * ever written one — so a correctly authenticated Homiio turn reached
 * `loadTurnAgent`, found no row, and was refused with `agent_unavailable`
 * after the model had already been reserved. This is the missing half.
 *
 * ## Dry run is the default, and it executes
 *
 * `APPLY` unset performs every statement the plan describes inside the same
 * transaction and then ROLLS IT BACK. That is not decoration: a dry run that
 * only prints has not met `agents_oxy_account_id_key`, the status and access
 * CHECKs, or the routing-profile CHECK, so the first time anybody learns the
 * plan is unwritable is during the apply. Here they are exercised against the
 * live schema and then discarded.
 *
 * ## Apply needs the EXACT hash of a plan somebody read
 *
 * `EXPECTED_PLAN_SHA256` must equal the hash this run computes from what it
 * observes NOW. So an apply cannot ride on a dry run taken against different
 * rows: if anything changed in between, the hashes differ and the run refuses
 * rather than writing a plan nobody reviewed. `BOOTSTRAP_REASON` and
 * `BOOTSTRAP_ACTOR` are required with it, because the audit line is the only
 * record this leaves.
 *
 * ## One writer at a time, in one transaction
 *
 * `pg_advisory_xact_lock` over a fixed name, taken as the first statement, so
 * two runs — or a run and a deploy's one-shot — serialize rather than interleave
 * a read-then-write. The lock is transaction-scoped, so it is released by the
 * same COMMIT or ROLLBACK that ends the plan, including the dry run's.
 *
 * ## It never touches another row
 *
 * Every statement is keyed on an exact primary key from the manifest. There is
 * no predicate over `application_id`, no `IN (select …)`, and no delete: the
 * failure mode this shape forecloses is a WHERE clause that matches more rows
 * next year than it did today.
 */

import { readTargetDatabase } from '@oxy.so/db/migrate';
import { eq, inArray, sql } from 'drizzle-orm';

import {
  assertWorkflowIdentityBindings,
  nativeProductAgentManifestSha256,
  NATIVE_PRODUCT_AGENT_MANIFEST_SHA256,
} from '../config/native-product-agents.js';
import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { agents } from '../db/schema/agents.js';
import { log } from '../lib/logger.js';
import {
  bootstrapPlanSha256,
  manifestAgents,
  planNativeProductAgentBootstrap,
  type BootstrapPlan,
  type FieldValue,
  type NativeAgentObservation,
  type NativeAgentRow,
  type Operation,
} from './native-product-agent-bootstrap-plan.js';

const logger = log.seed;

const LOCK_NAME = 'alia:native-product-agents:v1';
/** The line the workflow greps out of CloudWatch. One per run, last wins. */
const RESULT_MARKER = 'ALIA_NATIVE_PRODUCT_AGENTS_RESULT=';

interface RunReport {
  readonly mode: 'dry-run' | 'apply';
  readonly planSha256: string;
  readonly manifestSha256: string;
  readonly plan: BootstrapPlan;
  readonly counts: { readonly insert: number; readonly update: number; readonly unchanged: number };
}

/** Thrown to roll a dry run back. Carries the report so the caller still has it. */
class DryRunRollback extends Error {
  constructor(readonly report: RunReport) {
    super('dry-run rollback');
  }
}

const AGENT_COLUMNS = {
  id: agents.id,
  oxyAccountId: agents.oxyAccountId,
  ownerOxyAccountId: agents.ownerOxyAccountId,
  applicationId: agents.applicationId,
  access: agents.access,
  status: agents.status,
  isPublished: agents.isPublished,
  routingProfileId: agents.routingProfileId,
  capabilityGrants: agents.capabilityGrants,
};

function requireApproval(): { actor: string; reason: string; expectedPlan: string } {
  const actor = process.env.BOOTSTRAP_ACTOR?.trim();
  const reason = process.env.BOOTSTRAP_REASON;
  const expectedPlan = process.env.EXPECTED_PLAN_SHA256?.trim();
  if (actor === undefined || actor === '') {
    throw new Error('APPLY requires BOOTSTRAP_ACTOR');
  }
  /**
   * Compared UNTRIMMED against its own trim, so a reason of spaces is refused
   * rather than silently recorded as one. An audit line nobody can act on is
   * the same as no audit line.
   */
  if (reason === undefined || reason.trim() === '' || reason !== reason.trim()) {
    throw new Error('APPLY requires a BOOTSTRAP_REASON with no leading or trailing whitespace');
  }
  if (expectedPlan === undefined || !/^[a-f0-9]{64}$/.test(expectedPlan)) {
    throw new Error('APPLY requires EXPECTED_PLAN_SHA256, the lowercase hex from its dry run');
  }
  return { actor, reason, expectedPlan };
}

function counts(operations: readonly Operation[]): RunReport['counts'] {
  return {
    insert: operations.filter((operation) => operation.kind === 'insert').length,
    update: operations.filter((operation) => operation.kind === 'update').length,
    unchanged: operations.filter((operation) => operation.kind === 'unchanged').length,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const expectedDatabase = readTargetDatabase(argv);
  const apply = process.env.APPLY === '1';
  const approval = apply ? requireApproval() : null;

  /**
   * The image's own manifest is hashed and compared with the constant beside
   * it BEFORE anything is observed, so an edit to one without the other cannot
   * reach a database at all. Oxy asserts the same hex in its own suite; see
   * `config/native-product-agents.ts`.
   */
  const observedManifestSha256 = nativeProductAgentManifestSha256();
  if (observedManifestSha256 !== NATIVE_PRODUCT_AGENT_MANIFEST_SHA256) {
    throw new Error(
      `the pinned manifest hashes to ${observedManifestSha256}, not ${NATIVE_PRODUCT_AGENT_MANIFEST_SHA256}`,
    );
  }
  assertWorkflowIdentityBindings(process.env);

  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);

  const wanted = manifestAgents();
  const agentIds = wanted.map((agent) => agent.id);
  const accountIds = wanted.map((agent) => agent.oxyAccountId);

  let report: RunReport;
  try {
    report = await getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`);

      const [byId, byAccount] = await Promise.all([
        tx.select(AGENT_COLUMNS).from(agents).where(inArray(agents.id, agentIds)),
        tx.select(AGENT_COLUMNS).from(agents).where(inArray(agents.oxyAccountId, accountIds)),
      ]);
      const rowsById = new Map(byId.map((row) => [row.id, row as NativeAgentRow]));
      const rowsByAccount = new Map(
        byAccount.map((row) => [row.oxyAccountId, row as NativeAgentRow]),
      );

      const observations: NativeAgentObservation[] = wanted.map((agent) => ({
        agent,
        byId: rowsById.get(agent.id) ?? null,
        byOxyAccountId: rowsByAccount.get(agent.oxyAccountId) ?? null,
      }));

      const planned = planNativeProductAgentBootstrap(observations);
      if (!planned.ok) {
        logger.error({ refusals: planned.refusals }, 'Native product-agent bootstrap REFUSED');
        throw new Error(
          `refusing to bootstrap: ${planned.refusals.map((r) => `${r.agentId} ${r.reason}`).join(', ')}`,
        );
      }

      const planSha256 = bootstrapPlanSha256(planned.plan);
      const runReport: RunReport = {
        mode: apply ? 'apply' : 'dry-run',
        planSha256,
        manifestSha256: observedManifestSha256,
        plan: planned.plan,
        counts: counts(planned.plan.operations),
      };

      if (approval !== null && approval.expectedPlan !== planSha256) {
        throw new Error(
          `EXPECTED_PLAN_SHA256 ${approval.expectedPlan} does not match the plan observed now (${planSha256})`,
        );
      }

      for (const operation of planned.plan.operations) {
        if (operation.kind === 'insert') {
          await tx.insert(agents).values(operation.values);
        } else if (operation.kind === 'update') {
          const patch: Record<string, FieldValue> = {};
          for (const change of operation.changes) patch[change.field] = change.to;
          const updated = await tx
            .update(agents)
            .set(patch)
            .where(eq(agents.id, operation.agentId))
            .returning({ id: agents.id });
          // A write that reports success and a row that changed are two facts.
          if (updated.length !== 1) {
            throw new Error(`update for ${operation.agentId} matched ${updated.length} rows`);
          }
        }
      }

      /**
       * Read back INSIDE the transaction, through a fresh select rather than
       * through what the statements returned, and re-plan. A correct apply
       * leaves a plan with nothing but `unchanged` in it; anything else means a
       * statement did not do what the plan said it would.
       */
      const after = await tx.select(AGENT_COLUMNS).from(agents).where(inArray(agents.id, agentIds));
      const afterById = new Map(after.map((row) => [row.id, row as NativeAgentRow]));
      const afterByAccount = new Map(after.map((row) => [row.oxyAccountId, row as NativeAgentRow]));
      const verification = planNativeProductAgentBootstrap(
        wanted.map((agent) => ({
          agent,
          byId: afterById.get(agent.id) ?? null,
          byOxyAccountId: afterByAccount.get(agent.oxyAccountId) ?? null,
        })),
      );
      if (!verification.ok || verification.plan.operations.some((o) => o.kind !== 'unchanged')) {
        throw new Error('the rows do not match the manifest after the plan ran');
      }

      if (!apply) throw new DryRunRollback(runReport);
      return runReport;
    });
  } catch (error: unknown) {
    if (error instanceof DryRunRollback) {
      report = error.report;
    } else {
      throw error;
    }
  }

  /**
   * Flat keys, and NO SPREAD.
   *
   * `lib/__tests__/log-content.test.ts` reads every logger call in this package
   * with the TypeScript AST and refuses a spread it has not frozen, because a
   * spread hides its keys from the census that checks nothing content-shaped
   * reaches a log line. `...(approval !== null && { actor, reason })` is exactly
   * that shape, and it is also unnecessary: an optional property spells the
   * same thing where the checker can read it.
   *
   * The counts rather than the operations, too. The full diff is already on
   * stdout under {@link RESULT_MARKER}, which is what the workflow greps and
   * what an operator reads; repeating it here would put the seeded taglines
   * into the structured record for no reader.
   */
  logger.info(
    {
      mode: report.mode,
      planSha256: report.planSha256,
      manifestSha256: report.manifestSha256,
      inserted: report.counts.insert,
      updated: report.counts.update,
      unchanged: report.counts.unchanged,
      actor: approval?.actor,
      reason: approval?.reason,
    },
    report.mode === 'apply'
      ? 'Native product agents bootstrapped'
      : 'Native product-agent bootstrap plan (rolled back)',
  );
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(report)}\n`);
}

main().then(
  async () => {
    await closePostgres();
    process.exit(0);
  },
  async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(
      `${RESULT_MARKER}${JSON.stringify({ mode: process.env.APPLY === '1' ? 'apply' : 'dry-run', error: message })}\n`,
    );
    await closePostgres().catch(() => {});
    process.exit(1);
  },
);
