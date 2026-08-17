import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The boot wiring that nothing else can observe.
 *
 * `src/index.ts` opens a socket and starts timers on import, so no test imports
 * it. That is exactly why this gate exists: the expiry sweeper was written,
 * registered against fourteen targets and covered by real-database tests, and
 * **nothing ever called `startExpirySweeper()`**. Every one of those tests
 * invoked `runExpirySweep()` directly, so the whole mechanism was green and
 * inert at the same time — the sweep worked and was never run.
 *
 * A source-text assertion is weak evidence about behaviour, and it is the
 * strongest available here. It is the same shape `deployWorkflow.test.ts` uses
 * for the workflow YAML, and it fails for the one reason that actually occurred:
 * the call being absent.
 *
 * The vacuity floor matters more than usual. `readFileSync` of a path that
 * moved, or a file emptied by a bad merge, produces a string containing none of
 * these markers — which is indistinguishable from a correct file that lost the
 * call, and would report the same "not found" either way. So the file is
 * asserted to be recognisably `index.ts` first.
 */

const INDEX = join(__dirname, '..', '..', 'index.ts');
const source = readFileSync(INDEX, 'utf8');

describe('src/index.ts boot wiring', () => {
  it('read an index.ts that is really the server entrypoint', () => {
    // Vacuity floor: without this, every assertion below passes on an empty
    // read for reasons that have nothing to do with the wiring.
    expect(source.length).toBeGreaterThan(5_000);
    expect(source).toContain("server.listen(PORT");
    expect(source).toContain("import express from 'express'");
  });

  it('starts the expiry sweeper', () => {
    // The 14 TTL indexes this service used to have are now rows that only this
    // loop deletes. Without the call they are never deleted at all.
    expect(source).toContain('startExpirySweeper()');
  });

  it('stops the expiry sweeper on shutdown', () => {
    expect(source).toContain('stopExpirySweeper()');
  });

  it('runs every boot refusal before the socket opens', () => {
    /**
     * Order, not just presence: a refusal that happened inside the `listen`
     * callback would accept requests first and exit afterwards, which is the
     * half-configured state these guards exist to prevent.
     *
     * The leading newline is load-bearing, and the reason is worth keeping even
     * though the shape changed. `connectPostgresOrExit()` used to be a substring
     * of its own declaration — `function connectPostgresOrExit(): void` — so a
     * bare search found the declaration instead, 1141 characters earlier and
     * also before `listen`. That assertion passed with the CALL deleted, which
     * is the only way it could ever have failed. Anchoring on a top-level
     * statement is what makes it a check.
     *
     * WHICH refusals run, in WHAT order, and that each one TERMINATES is now
     * `lib/__tests__/boot-guards.test.ts`, against the real function. Four
     * source-text assertions used to stand here in its place, and they were
     * measurably not enough: the direct-provider guard was able to lose its
     * `process.exit` — reporting the problem and starting anyway — with every
     * suite in the repo green.
     */
    const guardsAt = source.indexOf('\nrunBootGuards({');
    const listenAt = source.indexOf('server.listen(PORT');
    expect(guardsAt).toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(guardsAt).toBeLessThan(listenAt);
  });

  it('hands the boot guards the REAL terminator and the real logger', () => {
    /*
     * The one thing only this file can see. `runBootGuards` takes `exit` as a
     * parameter so that a test can assert termination — which means a call site
     * passing a no-op would satisfy every behavioural assertion in
     * `lib/__tests__/boot-guards.test.ts` while the process started anyway.
     *
     * Still source text, and still not proof; it is the residue the extraction
     * could not remove, and it is smaller than the four assertions it replaced.
     */
    const guardsAt = source.indexOf('\nrunBootGuards({');
    const call = source.slice(guardsAt, guardsAt + 600);
    expect(call).toContain('process.exit(code)');
    expect(call).toContain('log.general.error');
    expect(call).toContain('log.general.info');
  });

  it('no longer runs the retired Mongo data-migration ledger', () => {
    // `lib/migrations/` is deleted; a reintroduced call would be a second
    // migration ledger beside `@oxyhq/db`'s, asserting history that never
    // happened. See CONVENTIONS.md, "Two migration ledgers must not both survive".
    expect(source).not.toContain('runPendingMigrations');
  });
});
