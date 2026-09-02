/**
 * The Oxy service-token exchange — epic #139 workstream 2, *"Configure
 * short-lived Oxy service-token exchange through `@oxyhq/core`."*
 *
 * ## What this module is
 *
 * The adapter between an Oxy ApplicationCredential in the environment and the
 * published {@link OxyInferenceCredential} accepted by
 * {@link import('@oxyhq/core').OxyInferenceClient}. The credential is presented
 * only to Oxy; Oxy resolves the authenticated application identity and is the
 * only component that calls Kaana.
 *
 * ## What this module deliberately does NOT do
 *
 * **It mints nothing at import.** `createOxyInferenceCredential` is a function,
 * not a module-level constant, so importing this file opens no socket and reads
 * no credential. That is what lets `oxy-inference-boot-check.ts` depend on the variable
 * NAMES without putting a token exchange on the boot path.
 *
 * **It implements no caching, no refresh and no expiry arithmetic.** All three
 * live in `@oxyhq/core` (`getServiceToken` / `invalidateServiceToken`), which
 * caches per `(apiKey, apiSecret)` pair, refreshes 60 seconds BEFORE the token
 * expires, deduplicates concurrent callers onto one in-flight request, and
 * verifies the secret in constant time on every cache hit. Re-implementing any
 * of that here would be a second session mechanism in a consuming app, which is
 * exactly what the ecosystem rule forbids — and it would be a WORSE one, since
 * the token's real lifetime is the one the Oxy edge returns in `expiresIn` and
 * only the code that read that response knows it.
 *
 * `__tests__/oxy-inference.test.ts` therefore asserts the composition against
 * a real `OxyServices` and a real `/auth/service-token` round trip rather than
 * against a fake: "the token is short-lived" is a property of what this hands
 * back, not of any line in this file.
 *
 * ## Why a dedicated `OxyServices` instance
 *
 * `middleware/auth.ts` constructs the API's own `OxyServices` for VERIFYING
 * inbound user tokens, and it never configures service credentials. Calling
 * `configureServiceAuth` on that instance would arm `makeServiceRequest`
 * everywhere else in the process as a side effect of wiring Kaana, and would
 * make the inference layer import the Express middleware graph. One instance per
 * purpose is also what the SDK's per-credential cache is designed for.
 */

import { OxyServices, type OxyInferenceCredential } from '@oxyhq/core';

/**
 * The ApplicationCredential this deployment presents to mint service tokens.
 *
 * These two values describe one Oxy ApplicationCredential. The identifier and
 * account are resolved by Oxy from the minted service token; Alia neither
 * configures nor asserts them on an inference request.
 *
 * Separate credentials per environment are `#139` §2's own row, *"Create
 * separate development, staging and production ApplicationCredentials"*: these
 * variables are how a deployment carries whichever one it was issued.
 *
 * These names are coordinated with the task definition and repository secrets.
 * No former spelling is read; a partial rollout is a boot refusal.
 */
export const OXY_INFERENCE_CREDENTIAL_ENV = {
  apiKey: 'ALIA_KAANA_CREDENTIAL_KEY',
  apiSecret: 'ALIA_KAANA_CREDENTIAL_SECRET',
} as const;

/**
 * Where the token is minted.
 *
 * Not a Kaana variable and not new: this is the Oxy identity API the whole
 * process already talks to (`middleware/auth.ts`, `lib/tools/oxy-services.ts`),
 * and the token exchange is one more endpoint on it. Required rather than
 * defaulted here — inventing a base URL for a credential exchange is how a
 * staging deployment mints production tokens.
 */
export const OXY_API_URL_ENV = 'OXY_API_URL';

/** Every variable the exchange needs. */
export const OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV: readonly string[] = [
  OXY_INFERENCE_CREDENTIAL_ENV.apiKey,
  OXY_INFERENCE_CREDENTIAL_ENV.apiSecret,
  OXY_API_URL_ENV,
];

/**
 * Which of {@link OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV} this environment does not set.
 *
 * Presence only. Whether the credential is ACCEPTED is a question for the Oxy
 * edge and is answered on the first exchange — a check that tried to answer it
 * would either mint a token before the process serves anything or guess at a
 * format, and the format of an `oxy_dk_` key is the control plane's business,
 * not this deployment's.
 *
 * Returned as a LIST rather than as a sentence because
 * `oxyInferenceBootConfigurationFailure` folds it into the one message that names every
 * unset Oxy inference variable at once. Two messages would send an operator round the
 * deploy loop twice: once for the principal, once for the credential.
 */
export function unsetOxyInferenceCredentialVariables(env: NodeJS.ProcessEnv): readonly string[] {
  return OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV.filter(
    (variable) => (env[variable] ?? '').trim().length === 0,
  );
}

/**
 * The credential the Oxy inference client authenticates every call with.
 *
 * Throws when the environment cannot configure one, naming the variables that
 * are unset. A factory that returned a credential which failed on first use
 * instead would turn a deployment mistake into one `authentication_failed` per
 * user request, which is the failure {@link unsetOxyInferenceCredentialVariables}
 * exists to move to boot.
 *
 * The returned function delegates token minting and refresh to `OxyServices`,
 * retaining the SDK's cache and concurrent-call deduplication instead of
 * reimplementing either in Alia.
 */
export function createOxyInferenceCredential(
  env: NodeJS.ProcessEnv = process.env,
): OxyInferenceCredential {
  const unset = unsetOxyInferenceCredentialVariables(env);
  if (unset.length > 0) {
    throw new Error(
      `the Oxy inference service-token exchange has no credential: ${[...unset].sort().join(', ')} not set`,
    );
  }

  // Trimmed, and by the same expression the presence check uses. A secret that
  // reached the environment from a file carries the file's trailing newline, and
  // a credential that differs from the one the operator set by one invisible
  // character fails with a 401 that names nothing.
  const read = (variable: string): string => (env[variable] ?? '').trim();

  const oxy = new OxyServices({ baseURL: read(OXY_API_URL_ENV) });
  oxy.configureServiceAuth(
    read(OXY_INFERENCE_CREDENTIAL_ENV.apiKey),
    read(OXY_INFERENCE_CREDENTIAL_ENV.apiSecret),
  );
  return () => oxy.getServiceToken();
}
