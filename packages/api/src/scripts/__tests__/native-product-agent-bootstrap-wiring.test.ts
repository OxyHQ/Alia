/**
 * The bootstrap's three halves are one fact, and they live in three files.
 *
 * `build.ts` emits the bundle, the workflow invokes it by PATH, and the runtime
 * stage is `node:*-slim` with no bun and no `src/` — so a script that exists
 * only as TypeScript is a dispatch that cannot work. That failure is loud when
 * it happens and invisible until then, because nothing builds or runs the
 * one-shot on an ordinary day. The migrator and the seeder are asserted the
 * same way in `db/__tests__/deployWorkflow.test.ts`, for the same reason and
 * after the same outage.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUNDLE = 'dist/scripts/bootstrap-native-product-agents.js';

const build = readFileSync(fileURLToPath(new URL('../../../build.ts', import.meta.url)), 'utf8');
const workflow = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../.github/workflows/bootstrap-native-product-agents.yml',
      import.meta.url,
    ),
  ),
  'utf8',
);
const script = readFileSync(
  fileURLToPath(new URL('../bootstrap-native-product-agents.ts', import.meta.url)),
  'utf8',
);

describe('the bootstrap one-shot', () => {
  it('is an entrypoint build.ts actually emits', () => {
    expect(build).toContain("entryPoints: ['src/scripts/bootstrap-native-product-agents.ts']");
    expect(build).toContain(`outfile: '${BUNDLE}'`);
  });

  it('is invoked by the path that bundle lands at', () => {
    expect(workflow).toContain(`"node","packages/api/${BUNDLE}"`);
  });

  /**
   * `--target-database` has no default: a run that does not state its target
   * cannot be checked against the connection string it was handed, and a write
   * aimed at the wrong database does not fail — it reports success over one
   * nobody meant to touch.
   */
  it('states the database it means rather than letting it default', () => {
    expect(workflow).toContain('"--target-database=alia"');
    expect(script).toContain('assertTargetDatabase(expectedDatabase)');
  });

  it('runs the image production is serving, not whatever main built', () => {
    expect(workflow).toContain('aws ecs describe-services');
    expect(workflow).toContain(".taskDefinition' <<<\"$service_json\"");
    expect(workflow).not.toContain('register-task-definition');
    expect(workflow).not.toContain('update-service');
  });

  /**
   * Apply is gated on the hash of a plan somebody read. Both halves are stated:
   * the workflow refuses a malformed input before it starts a task, and the
   * script refuses again against what it observes at write time — the second is
   * the one that matters, because rows can change between the two runs.
   */
  it('cannot apply without the exact hash of a reviewed plan', () => {
    expect(workflow).toContain('^[a-f0-9]{64}$');
    expect(script).toContain('EXPECTED_PLAN_SHA256');
    expect(script).toContain('does not match the plan observed now');
  });

  it('cannot apply without an auditable actor and reason', () => {
    expect(script).toContain('APPLY requires BOOTSTRAP_ACTOR');
    expect(script).toContain('APPLY requires a BOOTSTRAP_REASON');
  });

  it('takes an advisory lock inside the transaction that writes', () => {
    expect(script).toContain('pg_advisory_xact_lock');
    expect(script).toContain('getDb().transaction');
  });

  /**
   * Every statement is keyed on an exact primary key from the manifest. The
   * shape this forecloses is a WHERE clause that matches more rows next year
   * than it does today — so a delete, or a predicate over `application_id`,
   * fails here rather than in production.
   */
  it('never deletes, and never writes by anything but an exact id', () => {
    expect(script).not.toContain('.delete(');
    expect(script).toContain('where(eq(agents.id, operation.agentId))');
  });

  it('reads the rows back inside the transaction rather than trusting the writes', () => {
    expect(script).toContain('the rows do not match the manifest after the plan ran');
  });

  it('emits one machine-readable result line the workflow greps for', () => {
    expect(script).toContain("'ALIA_NATIVE_PRODUCT_AGENTS_RESULT='");
    expect(workflow).toContain("grep '^ALIA_NATIVE_PRODUCT_AGENTS_RESULT='");
  });
});
