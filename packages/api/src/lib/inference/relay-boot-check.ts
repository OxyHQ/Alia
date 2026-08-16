/**
 * The boot-time refusal — epic #139 workstream 2, *"Add startup validation that
 * production cannot boot without valid Oxy/Relay configuration once the
 * migration flag is enabled."*
 *
 * ## Why this is a separate module and not four lines in `src/index.ts`
 *
 * `src/index.ts` opens a socket, arms timers and connects a database on import,
 * so no test imports it (`db/__tests__/bootWiring.test.ts` says so, and reads its
 * source text instead). A refusal written there could only ever be gated by
 * grepping for the string that implements it, and the property that matters here
 * is not "the call exists" but **what it does with an environment** — including
 * the one case worth more than all the others, that with the flag off it does
 * nothing at all. That is a question about a function, so it is a function.
 *
 * `index.ts` keeps the part that is genuinely its own: the log line and the
 * `process.exit(1)`, in exactly the shape `connectPostgresOrExit` already uses.
 *
 * ## Why it is not in `relay-client.ts` either
 *
 * That module's own docs say "nothing in `packages/api` imports this module",
 * and `__tests__/relay-boundary.test.ts` holds it to an EXACT list of importers
 * so that wiring the client in is a reviewed diff rather than an accident.
 * Putting the check there would put `src/index.ts` on that list, which is the
 * one entry the freeze exists to keep off it. Nothing here constructs a
 * {@link import('./relay-client.js').RelayInferenceClient}, opens a transport or
 * mints a token; it reads five environment variables and asks the contract
 * whether they describe a principal.
 *
 * ## What "valid" means, and where it comes from
 *
 * Not invented here. `authenticatedPrincipalSchema` is the contract's, and
 * `assertPrincipalMatchesDeployment` is the client's own construction-time check
 * — the same two gates a request would meet, moved to the moment a deployment
 * mistake is cheap to see. Re-deriving either would produce a boot check that
 * agrees with a copy of the rules rather than with the rules.
 *
 * ## Why there is no second `NODE_ENV === 'production'` gate
 *
 * The requirement names production, and the environment-sensitivity it wants is
 * already inside `assertPrincipalMatchesDeployment`: that function returns early
 * on a development process, precisely so a local run may point at whichever
 * environment the engineer configured. Adding an independent `NODE_ENV` gate on
 * top would mean a STAGING task with unusable Relay configuration boots happily
 * and fails on live traffic, which is the failure this checkbox exists to
 * prevent. The shape rules are therefore enforced wherever the flag is on, and
 * the environment-match rule keeps the client's own relaxation.
 *
 * A developer who sets the flag and nothing else is refused, and told the five
 * variable names. That is a thirty-second fix with the answer in the message;
 * booting into a process whose every model call fails is not.
 */

import { authenticatedPrincipalSchema } from '@oxyhq/contracts';

import {
  assertPrincipalMatchesDeployment,
  isRelayClientEnabled,
  type RelayPrincipalConfig,
} from './relay-client.js';

/**
 * Which environment variable carries each field of the contract's principal.
 *
 * `satisfies Record<keyof RelayPrincipalConfig, string>` is load-bearing: a
 * field added to `authenticatedPrincipalSchema` upstream becomes a COMPILE error
 * here rather than a field this check silently never reads. `RelayPrincipalConfig`
 * is `z.input` of that schema, so the two cannot drift.
 */
export const RELAY_PRINCIPAL_ENV = {
  billing: 'ALIA_RELAY_ACCOUNT_ID',
  applicationId: 'ALIA_RELAY_APPLICATION_ID',
  credentialId: 'ALIA_RELAY_CREDENTIAL_ID',
  environment: 'ALIA_RELAY_ENVIRONMENT',
  inferenceScopes: 'ALIA_RELAY_INFERENCE_SCOPES',
} as const satisfies Record<keyof RelayPrincipalConfig, string>;

/** Field name -> variable name, for turning a zod issue path into something to set. */
const ENV_BY_FIELD: Readonly<Record<string, string | undefined>> = RELAY_PRINCIPAL_ENV;

/**
 * Why this process must not start, or `null` when it may.
 *
 * A returned reason rather than a throw: the caller is `src/index.ts`, which
 * wants to log and exit, and a `try`/`catch` around a boot step reads as if the
 * step could fail for reasons other than the one being checked.
 *
 * **With the flag off this reads exactly one variable and returns.** No principal
 * variable is consulted, no schema is run and no deployment is resolved — the
 * property `__tests__/relay-boot-check.test.ts` pins with a recording
 * environment, because "the flag-off path is unchanged" is the whole reason this
 * is safe to land before the cutover.
 */
export function relayBootConfigurationFailure(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isRelayClientEnabled(env)) return null;

  /**
   * Unset variables first, and ALL of them, before anything is parsed.
   *
   * Not an optimisation and not a duplicate of the schema. The unconfigured
   * deployment is the likeliest real failure, and reporting it through the
   * schema names only FOUR of the five: an empty scope list is a legal
   * `inferenceScopes` value, so that field parses and its absence surfaces one
   * layer down, in a sentence about scopes. An operator would set four
   * variables, redeploy, and be refused again for the fifth.
   *
   * Requiring the variable to be PRESENT invents nothing: four of the five
   * fields are `min(1)` in the contract and the fifth must carry
   * `inference:invoke` for the client to invoke anything.
   */
  const unset = Object.values(RELAY_PRINCIPAL_ENV)
    .filter((variable) => (env[variable] ?? '').trim().length === 0)
    .sort();
  if (unset.length > 0) {
    return `the Relay client is enabled but these variables are not set: ${unset.join(', ')}`;
  }

  const parsed = authenticatedPrincipalSchema.safeParse({
    billing: { accountId: env[RELAY_PRINCIPAL_ENV.billing] },
    applicationId: env[RELAY_PRINCIPAL_ENV.applicationId],
    credentialId: env[RELAY_PRINCIPAL_ENV.credentialId],
    environment: env[RELAY_PRINCIPAL_ENV.environment],
    // A list, because `inferenceScopes` is one.
    inferenceScopes: (env[RELAY_PRINCIPAL_ENV.inferenceScopes] ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  });

  if (!parsed.success) {
    // The variable NAMES, never their values. An operator needs to know which
    // one to set, and a zod message for a bad enum echoes what it received.
    const offenders = [
      ...new Set(
        parsed.error.issues.map(
          (issue) => ENV_BY_FIELD[String(issue.path[0])] ?? issue.path.join('.'),
        ),
      ),
    ].sort();
    return `the Relay client is enabled and these variables hold values the contract rejects: ${offenders.join(', ')}`;
  }

  try {
    assertPrincipalMatchesDeployment(parsed.data, env);
  } catch (cause) {
    /**
     * The client's own sentence, plus the two variables that produced it.
     *
     * Its messages name a SCOPE and an ENVIRONMENT, which is the right vocabulary
     * inside the client and the wrong one in a boot log: "missing the
     * inference:invoke scope" does not tell an operator which variable to set.
     *
     * Reachable with every variable set: a scope list that names real scopes but
     * not `inference:invoke`, or a principal environment that disagrees with the
     * process presenting it. Naming the check's INPUTS rather than guessing
     * which of them is at fault keeps this free of a second copy of the client's
     * rules — matching on its message text would be exactly that copy, and would
     * break silently the next time the wording changed.
     */
    const message = cause instanceof Error ? cause.message : String(cause);
    return `${message} — check ${RELAY_PRINCIPAL_ENV.inferenceScopes} and ${RELAY_PRINCIPAL_ENV.environment}`;
  }

  return null;
}
