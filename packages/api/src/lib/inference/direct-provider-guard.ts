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
 * So the guard is conditioned on the CUTOVER, not on the environment: it asks
 * whether this process is configured to reach a model provider by a route that
 * is not Relay, and it only asks once `ALIA_RELAY_CLIENT_ENABLED` says Relay is
 * the route. Two configurations answer yes:
 *
 *  1. **`GATEWAY_API_URL`.** Setting it alongside `SERVICE_SECRET` flips
 *     `lib/gateway-client.ts` into remote mode, where every model call goes to
 *     an HTTP provider tier that is not Relay. It is read by nothing else except
 *     `lib/tools/gateway-admin.ts`, which administers that same tier — so its
 *     presence is unambiguous, which `SERVICE_SECRET`'s is not (that one also
 *     gates the browse tool, the browser session and service-to-service auth,
 *     and refusing on it would take out three unrelated features).
 *  2. **A provider credential in the environment.** #139's invariant is that no
 *     upstream provider secret remains in Alia's environment variables, and a
 *     credential that is present is a credential something can use.
 *
 * ## The cheapest way to make this pass
 *
 * With the flag ON: unset `GATEWAY_API_URL` and the provider credentials. That
 * is the migration's own end state, and it is not "turn inference off" — the
 * other half of boot, `relay-boot-check.ts`, refuses to start unless the five
 * `ALIA_RELAY_*` variables describe a principal the Oxy contract accepts. The
 * two checks together admit exactly one configuration: Relay configured,
 * provider configuration absent.
 *
 * With the flag OFF — every deployment that exists — the cheapest green is the
 * status quo, and this reads one variable and returns. It cannot make a live
 * deployment worse, because it changes nothing about one.
 *
 * The remaining escape is to turn the cutover flag back off, which is a rollback
 * to the pre-cutover configuration rather than a way to have both at once. That
 * is a deliberate, named, reviewable change to a variable that exists to be
 * flipped; the failure this guard exists to prevent is the SILENT one, where a
 * cutover deployment keeps a working provider route nobody noticed.
 */

import { PROVIDER_API_HOSTS } from './provider-egress-policy.js';
import { isRelayClientEnabled } from './relay-cutover.js';

/**
 * The variable whose presence means a non-Relay provider tier is configured.
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
 * no edit here. Both the singular and the plural spelling, because a key POOL is
 * how this codebase has always thought about provider credentials
 * (`key-manager.ts`, rotation, per-key rate limits) and `OPENAI_API_KEYS` is the
 * shape a pool would arrive in.
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
 * {@link import('./relay-boot-check.js').relayBootConfigurationFailure} returns
 * one: the caller is `src/index.ts`, which wants to log and exit.
 *
 * **With the flag off this reads exactly one variable and returns**, and the
 * test asserts that against a recording environment rather than by inspection —
 * "the pre-cutover boot is unchanged" is the property that makes this safe to
 * land while the in-process provider path is still serving every request.
 */
export function directProviderModeFailure(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isRelayClientEnabled(env)) return null;

  const offenders: string[] = [];
  if ((env[GATEWAY_URL_ENV] ?? '').trim().length > 0) offenders.push(GATEWAY_URL_ENV);
  for (const variable of PROVIDER_CREDENTIAL_ENV) {
    if ((env[variable] ?? '').trim().length > 0) offenders.push(variable);
  }

  if (offenders.length === 0) return null;

  // The variable NAMES, never their values: every one of these holds a
  // credential or a route to one, and a boot log is not a secret store.
  return `the Relay cutover is enabled and direct provider configuration is still present: ${offenders.join(', ')}`;
}
