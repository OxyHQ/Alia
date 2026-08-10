/**
 * The migrator must run under NODE, not just under bun.
 *
 * ## The defect this exists to prevent, which shipped and was never noticed
 *
 * `migrate.ts` computed its migrations folder from `__dirname`. This package is
 * `"type": "module"` and `build.ts` bundles the entrypoint as `format: 'esm'`,
 * so the shipped artefact threw
 * `ReferenceError: __dirname is not defined in ES module scope` on IMPORT —
 * before a single statement ran, having touched no database.
 *
 * It survived every gate because **bun defines `__dirname` in ESM as a
 * compatibility shim and node does not** (measured on both runtimes with the
 * same file). Everything that exercises the migrator locally goes through bun:
 * `bun run db:migrate`, and `testDatabase.ts`, which shells out to this
 * entrypoint for every `*.pgdb.test.ts` suite. The runtime image is
 * `node:*-slim`. And `tsc` accepts `__dirname` because `@types/node` declares
 * it globally.
 *
 * So: 180 Postgres tests green, `typecheck` green, `Build API` green, and a
 * migrator that could not start in production. It was found by running a real
 * one-shot task against the real image, which is the only thing that could have
 * found it.
 *
 * ## Why this test builds
 *
 * The property under test belongs to the ARTEFACT, not the source — a source
 * grep for `__dirname` would pass the day somebody introduces the same class of
 * bug through a dependency or a different global. `build.ts` takes ~90ms, so the
 * honest gate is affordable: build with the REAL build script (never a second
 * copy of its esbuild options, which would drift from the thing that ships) and
 * execute the output with `node`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const artefact = fileURLToPath(new URL('../../../dist/db/migrate.js', import.meta.url));

/** What `node` printed, and the exit status, without throwing on a non-zero exit. */
function runUnderNode(args: string[]): { output: string; status: number } {
  try {
    const output = execFileSync('node', [artefact, ...args], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A migrator that reached its DATABASE_URL check has already proved the
      // point; nothing here should ever open a connection.
      env: { ...process.env, DATABASE_URL: '' },
    });
    return { output, status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { output: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? -1 };
  }
}

describe('the bundled migrator runs under node', () => {
  beforeAll(() => {
    execFileSync('bun', ['build.ts'], { cwd: packageRoot, stdio: 'pipe' });
  }, 120_000);

  /**
   * The vacuity floor. Everything below asserts the ABSENCE of an error, and an
   * absent artefact, an empty one, or a build that quietly wrote nothing would
   * satisfy an absence check just as well as a correct build does.
   */
  it('built an artefact that is actually the migrator', () => {
    const built = readFileSync(artefact, 'utf8');
    expect(built.length).toBeGreaterThan(1000);
    expect(built).toContain('DATABASE_URL is required to run migrations');
  });

  /**
   * The positive control, and it is the load-bearing half: "node printed no
   * ReferenceError" is also true of a file that fails to exist, so the run must
   * be shown to have reached the migrator's OWN first check. That message is
   * emitted after the module has fully evaluated, which is exactly what the
   * `__dirname` throw prevented.
   */
  it('gets far enough to make its own argument check, rather than dying on import', () => {
    const { output } = runUnderNode(['--target-database=alia', '--phase=pre']);
    expect(output).toContain('DATABASE_URL is required to run migrations');
  });

  it('does not throw a CommonJS-global ReferenceError under ESM', () => {
    const { output } = runUnderNode(['--target-database=alia', '--phase=pre']);
    expect(output).not.toContain('is not defined in ES module scope');
    expect(output).not.toContain('ReferenceError');
  });

  /**
   * The two CommonJS globals bun shims and node does not. Asserted against the
   * BUNDLE rather than the source, because the bundle is what the deploy runs
   * and a dependency inlined by esbuild can reintroduce either one.
   */
  it('leaves no CommonJS-only global in the bundle', () => {
    const built = readFileSync(artefact, 'utf8');
    expect(built).not.toMatch(/\b__dirname\b/);
    expect(built).not.toMatch(/\b__filename\b/);
  });
});
