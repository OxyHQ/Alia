/**
 * The boot-time refusal — epic #139 workstream 2, *"Add startup validation that
 * production cannot boot without valid Oxy/Kaana configuration."*
 *
 * ## Why this is a separate module and not four lines in `src/index.ts`
 *
 * `src/index.ts` opens a socket, arms timers and connects a database on import,
 * so no test imports it (`db/__tests__/bootWiring.test.ts` says so, and reads its
 * source text instead). A refusal written there could only ever be gated by
 * grepping for the string that implements it, and the property that matters here
 * is not "the call exists" but **what it does with an environment**. That is a
 * question about a function, so it is a function.
 *
 * `index.ts` keeps the part that is genuinely its own: the log line and the
 * `process.exit(1)`, in exactly the shape `connectPostgresOrExit` already uses.
 *
 * ## Why it is not in `kaana-client.ts` either
 *
 * That module's own docs say "nothing in `packages/api` imports this module",
 * and `__tests__/kaana-boundary.test.ts` holds it to an EXACT list of importers
 * so that wiring the client in is a reviewed diff rather than an accident.
 * Putting the check there would put `src/index.ts` on that list, which is the
 * one entry the freeze exists to keep off it. Nothing here constructs a
 * {@link import('./kaana-client.js').KaanaInferenceClient}, opens a transport or
 * mints a token; it reads nine environment variables, asks the contract whether
 * five of them describe a principal, checks the base URL against the pinned
 * origins, and asks whether the last three are set at all.
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
 * top would mean a STAGING task with unusable Kaana configuration boots happily
 * and fails on live traffic, which is the failure this checkbox exists to
 * prevent. The shape rules are therefore enforced for every boot, and the
 * environment-match rule keeps the client's own relaxation.
 *
 * A developer with no Kaana configuration is refused and told every variable
 * name in one sentence. Booting into a process whose every model call fails is
 * not an accepted state.
 */

import { authenticatedPrincipalSchema } from '@oxyhq/contracts';

import {
  assertPrincipalMatchesDeployment,
  resolveDeploymentEnvironment,
  type KaanaPrincipalConfig,
} from './kaana-client.js';
import { unsetKaanaCredentialVariables } from './kaana-credential.js';
import { KAANA_BASE_URL_ENV, resolveKaanaEndpoint } from './kaana-endpoint.js';

/**
 * Which environment variable carries each field of the contract's principal.
 *
 * `satisfies Record<keyof KaanaPrincipalConfig, string>` is load-bearing: a
 * field added to `authenticatedPrincipalSchema` upstream becomes a COMPILE error
 * here rather than a field this check silently never reads. `KaanaPrincipalConfig`
 * is `z.input` of that schema, so the two cannot drift.
 *
 * These names are canonical and coordinated with the live task definition.
 * There is no compatibility read for a former spelling.
 */
export const KAANA_PRINCIPAL_ENV = {
  billing: 'ALIA_KAANA_ACCOUNT_ID',
  applicationId: 'ALIA_KAANA_APPLICATION_ID',
  credentialId: 'ALIA_KAANA_CREDENTIAL_ID',
  environment: 'ALIA_KAANA_ENVIRONMENT',
  inferenceScopes: 'ALIA_KAANA_INFERENCE_SCOPES',
} as const satisfies Record<keyof KaanaPrincipalConfig, string>;

/** Field name -> variable name, for turning a zod issue path into something to set. */
const ENV_BY_FIELD: Readonly<Record<string, string | undefined>> = KAANA_PRINCIPAL_ENV;

/**
 * Why this process must not start, or `null` when it may.
 *
 * A returned reason rather than a throw: the caller is `src/index.ts`, which
 * wants to log and exit, and a `try`/`catch` around a boot step reads as if the
 * step could fail for reasons other than the one being checked.
 *
 * Kaana is mandatory. Every deployment validates the complete configuration
 * before it can listen; there is no feature flag or direct-provider fallback.
 */
export function kaanaBootConfigurationFailure(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
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
   *
   * The service-token exchange's variables are folded into the SAME list, by
   * the same argument — this is the sentence that has to name everything.
   * A principal describes who this process claims to be and proves nothing: a
   * deployment with a contract-valid principal and no ApplicationCredential
   * mints no token at all, and every model call ends in `authentication_failed`
   * after the flag said the client was ready. Their names live in
   * `kaana-credential.ts` because that is the module that uses them; only the
   * presence question is asked here, and nothing is exchanged (#139 workstream
   * 2, *"Configure short-lived Oxy service-token exchange"*).
   */
  const unset = [
    ...[...Object.values(KAANA_PRINCIPAL_ENV), KAANA_BASE_URL_ENV].filter(
      (variable) => (env[variable] ?? '').trim().length === 0,
    ),
    ...unsetKaanaCredentialVariables(env),
  ].sort();
  if (unset.length > 0) {
    return `the Kaana client is required but these variables are not set: ${unset.join(', ')}`;
  }

  /**
   * Where it may send, before who it says it is.
   *
   * `KAANA_BASE_URL` is checked against
   * {@link import('./kaana-endpoint.js').KAANA_ALLOWED_ORIGINS} here — #139
   * workstream 15's *"pin allowed Kaana origins/endpoints"* — and this is the
   * FAIL-CLOSED half of it: a production task whose base URL was mistyped, or
   * whose SSM parameter was replaced, does not start. The alternative is a task
   * that starts and sends a service credential and a user's prompt to whatever
   * host the value names, once per request, until somebody notices.
   *
   * Ordered before the principal parse deliberately. Both can be wrong at once,
   * and of the two, "you are pointed at the wrong host" is the one an operator
   * must not act on a partial answer about.
   */
  const endpoint = resolveKaanaEndpoint(env, resolveDeploymentEnvironment(env));
  if (endpoint.kind === 'refused') return endpoint.reason;

  const parsed = authenticatedPrincipalSchema.safeParse({
    billing: { accountId: env[KAANA_PRINCIPAL_ENV.billing] },
    applicationId: env[KAANA_PRINCIPAL_ENV.applicationId],
    credentialId: env[KAANA_PRINCIPAL_ENV.credentialId],
    environment: env[KAANA_PRINCIPAL_ENV.environment],
    // A list, because `inferenceScopes` is one.
    inferenceScopes: (env[KAANA_PRINCIPAL_ENV.inferenceScopes] ?? '')
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
    return `the Kaana client is required and these variables hold values the contract rejects: ${offenders.join(', ')}`;
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
    return `${message} — check ${KAANA_PRINCIPAL_ENV.inferenceScopes} and ${KAANA_PRINCIPAL_ENV.environment}`;
  }

  return null;
}
