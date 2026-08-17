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

  it('requires Postgres before the socket opens', () => {
    /**
     * Order, not just presence: a connect that happens inside the `listen`
     * callback would accept requests first and exit afterwards, which is the
     * half-configured state this is meant to prevent.
     *
     * The leading newline is load-bearing. `connectPostgresOrExit()` is also a
     * substring of its own declaration — `function connectPostgresOrExit(): void`
     * — so a bare search found that instead, 1141 characters earlier and also
     * before `listen`. This assertion therefore used to pass with the CALL
     * deleted, which is the only way it could ever have failed. Anchoring on a
     * top-level statement is what makes it a check.
     */
    const connectAt = source.indexOf('\nconnectPostgresOrExit();');
    const listenAt = source.indexOf('server.listen(PORT');
    expect(connectAt).toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(connectAt).toBeLessThan(listenAt);
  });

  it('exits rather than continuing when DATABASE_URL is absent', () => {
    expect(source).toContain('process.exit(1)');
    expect(source).toContain('DATABASE_URL is required');
  });

  it('checks the Relay configuration before the socket opens', () => {
    /**
     * #139 workstream 2. Order again, and for the same reason as Postgres: a
     * check that ran inside the `listen` callback would accept requests first
     * and exit afterwards.
     *
     * WHAT the check does — and in particular that it consults nothing at all
     * while `ALIA_RELAY_CLIENT_ENABLED` is off, which is everywhere today — is
     * `lib/inference/__tests__/relay-boot-check.test.ts`. This assertion is only
     * that the entrypoint calls it, which is the failure mode a fully-tested
     * function reached by nobody produces — so it is anchored on the top-level
     * CALL, for the reason written above `connectPostgresOrExit`.
     */
    const checkAt = source.indexOf('\nassertRelayConfigurationOrExit();');
    const listenAt = source.indexOf('server.listen(PORT');
    expect(checkAt).toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(listenAt);
    expect(source).toContain('relayBootConfigurationFailure');
  });

  it('refuses direct provider configuration before the socket opens (#139 ws8)', () => {
    /**
     * Same shape and same reason as the Relay configuration check above: the
     * guard's BEHAVIOUR — and in particular that it reads one variable and
     * returns while `ALIA_RELAY_CLIENT_ENABLED` is off, which is everywhere
     * today — is `lib/inference/__tests__/direct-provider-guard.test.ts`. This
     * is only that the entrypoint calls it, anchored on the top-level CALL
     * because the name is also a substring of its own declaration.
     */
    const checkAt = source.indexOf('\nassertDirectProviderModeOrExit(');
    const listenAt = source.indexOf('server.listen(PORT');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(listenAt);

    /*
     * That the guard EXITS is now asserted behaviourally, in
     * `lib/inference/__tests__/direct-provider-guard.test.ts`, against the
     * exported function. What only this file can see is that the real caller
     * hands it the real terminator: the guard takes `exit` as a parameter, so a
     * call site passing a no-op would satisfy every behavioural test.
     */
    expect(source.slice(checkAt, checkAt + 400)).toContain('process.exit(code)');
  });

  it('arms the provider egress policy before the socket opens (#139 ws8)', () => {
    // A policy installed after `listen` would leave a window in which a request
    // could be served by a process that had not armed it. With the cutover flag
    // off the call installs nothing and returns null, which
    // `lib/inference/__tests__/provider-egress-policy.test.ts` asserts by object
    // identity.
    const installAt = source.indexOf('\nif (installProviderEgressBlock() !== null)');
    const listenAt = source.indexOf('server.listen(PORT');
    expect(installAt).toBeGreaterThan(-1);
    expect(installAt).toBeLessThan(listenAt);
  });

  it('no longer runs the retired Mongo data-migration ledger', () => {
    // `lib/migrations/` is deleted; a reintroduced call would be a second
    // migration ledger beside `@oxyhq/db`'s, asserting history that never
    // happened. See CONVENTIONS.md, "Two migration ledgers must not both survive".
    expect(source).not.toContain('runPendingMigrations');
  });
});
