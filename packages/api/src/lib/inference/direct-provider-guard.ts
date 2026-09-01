/**
 * The production guard — epic #139 workstream 8, *"Add a production guard that
 * fails CI or startup when direct provider mode is enabled."*
 *
 * ## What "direct provider mode" means here, and why it is not `NODE_ENV`
 *
 * The obvious guard — refuse to boot in production when the provider path
 * exists — is unusable and dangerous. It would be red on `main` from the first
 * commit, because the in-process provider path is what serves every request
 * today; and the cheapest way to make it green would be to stop serving
 * inference, which is the hazard rather than the fix.
 *
 * Kaana is the only hosted inference route, so this guard is unconditional. It
 * rejects two kinds of retired configuration even though neither can enable an
 * inference branch in the current runtime:
 *
 *  1. **`GATEWAY_API_URL`.** The hosted gateway branch has been removed. Its
 *     presence now means deployment configuration still claims a route the
 *     process must never use.
 *  2. **A provider credential in the environment.** #139's invariant is that no
 *     upstream provider secret remains in Alia's environment variables. The
 *     process does not consume these credentials for inference; refusing boot
 *     makes stale secret injection visible instead of silently retaining it.
 *
 * ## The cheapest way to make this pass
 *
 * Unset `GATEWAY_API_URL` and provider credentials. That is the migration's own
 * end state, and it is not "turn inference off" — the
 * other half of boot, `kaana-boot-check.ts`, refuses to start unless the Kaana
 * endpoint, principal and token-exchange variables are complete. The
 * two checks together admit exactly one configuration: Kaana configured,
 * provider configuration absent.
 *
 * There is no cutover flag and no rollback branch that re-enables hosted direct
 * providers.
 */

import { PROVIDER_API_HOSTS } from './provider-egress-policy.js';

/**
 * The variable whose presence means a non-Kaana provider tier is configured.
 *
 * Named rather than inlined so the failure message and the test agree on it
 * without either of them restating a string.
 */
export const GATEWAY_URL_ENV = 'GATEWAY_API_URL';

/**
 * Credential variables that do not follow `<PROVIDER>_API_KEY`.
 *
 * Exactly one today: `GROK_API_KEY`, whose provider is registered as `xai`, so a
 * list derived purely from provider NAMES would miss it. That is the whole
 * reason this list exists and the reason `__tests__/direct-provider-guard.test.ts`
 * censuses the provider tree's own `process.env` reads rather than trusting the
 * derivation.
 *
 * **No code reads it any more** — `providers/grok-voice.ts` did, inside a
 * disjunction ending in `|| true`, and #139 ws2/ws15 deleted that read as the
 * *"Remove provider API keys from Alia deployment environments"* row. The entry
 * stays: this guard is about what the ENVIRONMENT carries, and an operator can
 * set a variable no code reads. Removing it would mean a cutover deployment
 * still holding that credential boots without a word.
 */
const UNDERIVABLE_CREDENTIAL_ENV: readonly string[] = ['GROK_API_KEY'];

/**
 * Every environment variable that would carry an upstream provider credential.
 *
 * Derived from the provider host map's keys, which gate 2 holds equal to
 * `PROVIDER_NAMES` — so registering a twentieth provider extends this guard with
 * no edit here. Both the singular and plural spelling are refused so a stale
 * single key or key pool cannot silently survive the Kaana cutover.
 */
export const PROVIDER_CREDENTIAL_ENV: readonly string[] = [
  ...Object.keys(PROVIDER_API_HOSTS).flatMap((provider) => {
    const stem = provider.toUpperCase();
    return [`${stem}_API_KEY`, `${stem}_API_KEYS`];
  }),
  ...UNDERIVABLE_CREDENTIAL_ENV,
].sort();

/**
 * Why this process must not start, or `null` when it may.
 *
 * A returned reason rather than a throw, for the same reason
 * {@link import('./kaana-boot-check.js').kaanaBootConfigurationFailure} returns
 * one: the caller is `src/index.ts`, which wants to log and exit.
 *
 * Kaana is the only hosted inference route, so this refusal is unconditional.
 */
export function directProviderModeFailure(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const offenders: string[] = [];
  if ((env[GATEWAY_URL_ENV] ?? '').trim().length > 0) offenders.push(GATEWAY_URL_ENV);
  for (const variable of PROVIDER_CREDENTIAL_ENV) {
    if ((env[variable] ?? '').trim().length > 0) offenders.push(variable);
  }

  if (offenders.length === 0) return null;

  // The variable NAMES, never their values: every one of these holds a
  // credential or a route to one, and a boot log is not a secret store.
  return `Kaana is the only hosted inference route and direct provider configuration is still present: ${offenders.join(', ')}`;
}

/** The exit code a refused boot uses, matching `connectPostgresOrExit`. */
export const DIRECT_PROVIDER_EXIT_CODE = 1;

/**
 * Refuse to start, or return — the decision itself, not just the reason.
 *
 * ## Why this lives here rather than in `src/index.ts`
 *
 * It used to be four lines there, and that made the only thing that matters —
 * **that a refusal actually terminates the process** — unassertable. Nothing
 * imports `src/index.ts`: it opens a socket, arms timers and connects a database
 * on import. So the guard was covered by a source-text assertion in
 * `db/__tests__/bootWiring.test.ts` that the call exists and precedes `listen`.
 *
 * Measured: with that assertion in place, changing the body from
 * `process.exit(1)` to a warning log left **both** suites green. A guard that
 * reports and then starts anyway is exactly the outcome the box forbids, and
 * nothing could see it.
 *
 * `report` and `exit` are parameters rather than direct calls to `log` and
 * `process.exit` for that one reason: a test can pass its own and assert the
 * termination happened. Injecting them is cheaper and less invasive than making
 * a test monkey-patch a global that every other suite in the process shares.
 *
 * What is STILL only source-text is that the real caller passes the real
 * `process.exit` — `bootWiring.test.ts` asserts that, and it is the residue that
 * cannot be closed without making `src/index.ts` importable.
 */
export function assertDirectProviderModeOrExit(
  report: (failure: string) => void,
  exit: (code: number) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const failure = directProviderModeFailure(env);
  if (failure === null) return;
  report(failure);
  exit(DIRECT_PROVIDER_EXIT_CODE);
}
