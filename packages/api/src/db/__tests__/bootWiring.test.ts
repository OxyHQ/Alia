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
const code = stripComments(source);

/** Block comments and whole-line `//` comments, which name removed calls as prose. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

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
    expect(source).toContain('startExpirySweeper(');
  });

  it('starts the expiry sweeper UNDER the leader lease', () => {
    /**
     * `db/expirySweeper.ts` says the sweep "runs under the existing leader
     * election, beside the trigger engine". The call here was unconditional, so
     * with `desiredCount: N` every task ran the full delete across every target
     * every five minutes — N times the write load the module claims to avoid,
     * with N tasks contending on the same rows.
     *
     * Asserting the ARGUMENT rather than just the call, because
     * `startExpirySweeper()` with no predicate defaults to "always leader" and
     * would restore exactly the behaviour this exists to prevent.
     */
    expect(source).toContain('startExpirySweeper(isTriggerLeader)');
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

  it('runs no second migration ledger', () => {
    // `@oxy.so/db` owns the only migration ledger; a `runPendingMigrations`
    // call would be a second one. See CONVENTIONS.md, "One migration ledger".
    expect(source).not.toContain('runPendingMigrations');
  });

  it('starts the background services, unconditionally, from the listen callback', () => {
    /**
     * The defect this prevents, stated so the assertion is legible: a call
     * shaped `connectDB().then(() => startBackgroundServices())` behind a
     * connection that never resolves backs off forever, and the trigger engine,
     * the moderation-outbox dispatcher, both queues and the container pool never
     * start.
     *
     * WHAT starts, in what order, and that a rejecting starter cannot stop the
     * rest is `lib/__tests__/background-services.test.ts`, against the real
     * function. This is the residue only a census can see: that the call is here,
     * that it is inside `listen`, and that nothing gates it.
     */
    const listenAt = source.indexOf('server.listen(PORT');
    const startAt = source.indexOf('startBackgroundServices();');
    expect(listenAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(listenAt);

    /*
     * And nothing gates it. Anchored on the whole file rather than the window
     * between `listen` and the call, because a gate reintroduced ANYWHERE is the
     * same defect — and on comment-stripped source, because the comment above
     * that call names `connectDB()` as the thing that was removed. A census that
     * cannot tell prose from code fails on its own documentation.
     */
    expect(code).not.toMatch(/\bconnectWithRetry\b/);
    expect(code).not.toMatch(/\bconnectDB\b/);
    // Positive control on the stripper: it must not be eating the code as well.
    expect(code).toMatch(/\bstartBackgroundServices\(\)/);
  });

  it('stops the background services on shutdown', () => {
    // Started and never stopped is a leak on every SIGTERM, and for the trigger
    // engine specifically it strands the leadership lease — no other task
    // schedules anything until the TTL expires.
    expect(source).toContain('await stopBackgroundServices();');
  });
});
