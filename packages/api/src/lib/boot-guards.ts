/**
 * The four refusals that run before the socket opens.
 *
 * ## Why these five statements live here and the other 59 do not
 *
 * `src/index.ts` is 640 lines with 64 top-level side-effecting statements —
 * express mounts, socket.io, the MCP relay, queue and worker startup, timers,
 * `server.listen`. Nothing imports it, because importing it starts a server. So
 * everything written there could only ever be guarded by a source-text census:
 * `db/__tests__/bootWiring.test.ts` asserting that a call appears and precedes
 * `listen`.
 *
 * That proves a call exists. It cannot prove what the call does, or what the
 * caller does with its result — and the difference was measured, not supposed:
 * changing the direct-provider guard's body from `process.exit(1)` to a warning
 * log left every suite in the repo green, which is a guard that reports the
 * problem and then starts anyway.
 *
 * Moving the whole entrypoint would be a boot refactor on a production service,
 * which is not worth it. Moving these FOUR guards is not, because they are the
 * only top-level statements that touch none of `app`, `server` or `io` — grep
 * count zero across all four — so nothing about WHEN anything happens changes.
 * They read configuration, they report, and they terminate.
 *
 * ## What `exit` being a parameter buys
 *
 * The one property that matters about a refusal is that it STOPS the process.
 * With `process.exit` called directly there is no way to assert it without
 * killing the test runner. Injected, `__tests__/boot-guards.test.ts` asserts
 * both halves: that a bad configuration terminates, and that a good one does
 * not — the second being the more dangerous direction, since a guard that
 * exits unconditionally is a total outage.
 *
 * ## The `never` care point
 *
 * `process.exit` is typed `(code?: number) => never`, and the original
 * `connectPostgresOrExit` relied on that: after `process.exit(1)` the compiler
 * knew the success log was unreachable. An injected `(code: number) => void`
 * carries no such promise, so every refusal below RETURNS explicitly. The
 * control flow is now stated rather than inferred from a type annotation, which
 * is what makes it correct under a test double as well as in production.
 */

import { connectPostgres } from '../db/index.js';
import { assertDirectProviderModeOrExit } from './inference/direct-provider-guard.js';
import { relayBootConfigurationFailure } from './inference/kaana-boot-check.js';
import { installProviderEgressBlock } from './inference/provider-egress-policy.js';

/** The exit code every refusal here uses. */
export const BOOT_REFUSAL_EXIT_CODE = 1;

export interface BootGuardDeps {
  /** A misconfiguration that stops the process. */
  readonly reportFatal: (message: string, detail?: Record<string, unknown>) => void;
  /** An ordinary boot fact. */
  readonly reportInfo: (message: string) => void;
  /**
   * Terminates the process. Injected so a test can assert that a refusal
   * actually stops it — see the module comment.
   */
  readonly exit: (code: number) => void;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run every boot refusal, in order, stopping at the first one that terminates.
 *
 * The order is the order these statements have always had in `src/index.ts` and
 * it is load-bearing in one direction: the database is required by everything,
 * so a process with no `DATABASE_URL` should say THAT rather than a Relay
 * complaint it would also have. `__tests__/boot-guards.test.ts` asserts the
 * sequence rather than trusting the move.
 *
 * `terminated` exists because an injected `exit` returns. In production
 * `process.exit` does not, so the guard clauses below are invisible; under a
 * test double they are the difference between "the first failure stops the
 * boot" and "every guard runs and the last one wins".
 */
export function runBootGuards(deps: BootGuardDeps): void {
  const env = deps.env ?? process.env;
  let terminated = false;
  const terminate = (): void => {
    terminated = true;
    deps.exit(BOOT_REFUSAL_EXIT_CODE);
  };

  if (!connectPostgres(env.DATABASE_URL)) {
    deps.reportFatal("DATABASE_URL is required — Postgres is this service's database");
    terminate();
    /*
     * NOT REDUNDANT, and it looks it. In production `deps.exit` is
     * `process.exit`, which is typed `never` and does not return, so this line
     * appears to be unreachable dead code and reads as safe to delete.
     *
     * It is what makes the guard correct under an INJECTED exit, which returns.
     * Without it, a process that has already decided not to start goes on to run
     * the Relay check, the direct-provider check, and to ARM THE EGRESS POLICY.
     * `__tests__/boot-guards.test.ts` fails on exactly that deletion — see
     * "terminates, names the variable, and never reaches the egress policy".
     *
     * The same applies to every `return` after `terminate()` below.
     */
    return;
  }
  deps.reportInfo('Postgres connected');

  /*
   * #139 workstream 2. Half-configured has to be OFF rather than a service that
   * accepts requests and then fails every model call. What it costs when
   * `ALIA_RELAY_CLIENT_ENABLED` is not exactly `'true'` — which is everywhere
   * today — is one read of that one variable; `relayBootConfigurationFailure`
   * consults no Relay configuration at all on that path, which
   * `inference/__tests__/kaana-boot-check.test.ts` pins with a recording
   * environment rather than by inspection.
   */
  const relayFailure = relayBootConfigurationFailure(env);
  if (relayFailure !== null) {
    deps.reportFatal('Relay client configuration is invalid — refusing to start', {
      failure: relayFailure,
    });
    terminate();
    return;
  }

  /*
   * #139 workstream 8, and the other half of the same question: with the cutover
   * flag set, the check above requires Relay to be usable and this one requires
   * nothing else to be. With the flag off it reads that one variable and returns.
   */
  assertDirectProviderModeOrExit(
    (failure) => {
      deps.reportFatal('Direct provider mode is configured after the Relay cutover — refusing to start', {
        failure,
      });
    },
    terminate,
    env,
  );
  if (terminated) return;

  /*
   * Armed before the socket opens, so no request can be served by a process that
   * skipped it. With the cutover flag off this touches nothing at all and
   * returns `null`, which `inference/__tests__/provider-egress-policy.test.ts`
   * asserts by object identity rather than by behaviour.
   */
  if (installProviderEgressBlock(env) !== null) {
    deps.reportInfo('Provider egress policy armed — provider API hosts are unreachable from this process');
  }
}
