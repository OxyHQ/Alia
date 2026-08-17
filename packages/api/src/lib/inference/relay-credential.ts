/**
 * The Oxy service-token exchange — epic #139 workstream 2, *"Configure
 * short-lived Oxy service-token exchange through `@oxyhq/core`."*
 *
 * ## What this module is
 *
 * The adapter between an Oxy ApplicationCredential in the environment and
 * {@link RelayClientConfig.credential}, which is the only credential the Relay
 * client ever presents. `relay-client.ts` declares that field's interface and
 * says in its own docstring that it is *"structurally satisfied by
 * `@oxyhq/core`'s `OxyServices`"*; this is the module that performs the
 * satisfaction, and its return type is read off `RelayClientConfig` by indexed
 * access rather than written out, so a change to that field is a compile error
 * here rather than a second shape that drifts from the first.
 *
 * ## What this module deliberately does NOT do
 *
 * **It mints nothing at import.** `createRelayServiceCredential` is a function,
 * not a module-level constant, so importing this file opens no socket and reads
 * no credential. That is what lets `relay-boot-check.ts` depend on the variable
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
 * `__tests__/relay-credential.test.ts` therefore asserts the composition against
 * a real `OxyServices` and a real `/auth/service-token` round trip rather than
 * against a fake: "the token is short-lived" is a property of what this hands
 * back, not of any line in this file.
 *
 * ## Why a dedicated `OxyServices` instance
 *
 * `middleware/auth.ts` constructs the API's own `OxyServices` for VERIFYING
 * inbound user tokens, and it never configures service credentials. Calling
 * `configureServiceAuth` on that instance would arm `makeServiceRequest`
 * everywhere else in the process as a side effect of wiring Relay, and would
 * make the inference layer import the Express middleware graph. One instance per
 * purpose is also what the SDK's per-credential cache is designed for.
 */

import { OxyServices } from '@oxyhq/core';

import type { RelayClientConfig } from './relay-client.js';

/**
 * The ApplicationCredential this deployment presents to mint service tokens.
 *
 * Named beside `ALIA_RELAY_CREDENTIAL_ID` on purpose: all three describe the
 * SAME Oxy ApplicationCredential. The `_ID` is the record's own identifier and
 * rides on every request inside the contract's principal
 * (`relay-boot-check.ts`); these two are the secret material that proves the
 * process is entitled to act as it, and they never appear in a request — they
 * are exchanged for a short-lived token, once, and the token is what travels.
 *
 * Separate credentials per environment are `#139` §2's own row, *"Create
 * separate development, staging and production ApplicationCredentials"*: these
 * variables are how a deployment carries whichever one it was issued.
 */
export const RELAY_CREDENTIAL_ENV = {
  apiKey: 'ALIA_RELAY_CREDENTIAL_KEY',
  apiSecret: 'ALIA_RELAY_CREDENTIAL_SECRET',
} as const;

/**
 * Where the token is minted.
 *
 * Not a Relay variable and not new: this is the Oxy identity API the whole
 * process already talks to (`middleware/auth.ts`, `lib/tools/oxy-services.ts`),
 * and the token exchange is one more endpoint on it. Required rather than
 * defaulted here — inventing a base URL for a credential exchange is how a
 * staging deployment mints production tokens.
 */
export const OXY_API_URL_ENV = 'OXY_API_URL';

/** Every variable the exchange needs. */
export const RELAY_CREDENTIAL_REQUIRED_ENV: readonly string[] = [
  RELAY_CREDENTIAL_ENV.apiKey,
  RELAY_CREDENTIAL_ENV.apiSecret,
  OXY_API_URL_ENV,
];

/**
 * Which of {@link RELAY_CREDENTIAL_REQUIRED_ENV} this environment does not set.
 *
 * Presence only. Whether the credential is ACCEPTED is a question for the Oxy
 * edge and is answered on the first exchange — a check that tried to answer it
 * would either mint a token before the process serves anything or guess at a
 * format, and the format of an `oxy_dk_` key is the control plane's business,
 * not this deployment's.
 *
 * Returned as a LIST rather than as a sentence because
 * `relayBootConfigurationFailure` folds it into the one message that names every
 * unset Relay variable at once. Two messages would send an operator round the
 * deploy loop twice: once for the principal, once for the credential.
 */
export function unsetRelayCredentialVariables(env: NodeJS.ProcessEnv): readonly string[] {
  return RELAY_CREDENTIAL_REQUIRED_ENV.filter(
    (variable) => (env[variable] ?? '').trim().length === 0,
  );
}

/**
 * The credential the Relay client authenticates every call with.
 *
 * Throws when the environment cannot configure one, naming the variables that
 * are unset. A factory that returned a credential which failed on first use
 * instead would turn a deployment mistake into one `authentication_failed` per
 * user request, which is the failure {@link unsetRelayCredentialVariables}
 * exists to move to boot.
 *
 * The returned object IS the `@oxyhq/core` client, narrowed by the return type
 * to the two methods the Relay client may call. Narrowing by type rather than by
 * wrapping keeps the SDK's cache, its concurrent-call deduplication and its
 * constant-time secret check intact — a wrapper would have to forward all three
 * and could only get them wrong.
 */
export function createRelayServiceCredential(
  env: NodeJS.ProcessEnv = process.env,
): RelayClientConfig['credential'] {
  const unset = unsetRelayCredentialVariables(env);
  if (unset.length > 0) {
    throw new Error(
      `the Relay service-token exchange has no credential: ${[...unset].sort().join(', ')} not set`,
    );
  }

  // Trimmed, and by the same expression the presence check uses. A secret that
  // reached the environment from a file carries the file's trailing newline, and
  // a credential that differs from the one the operator set by one invisible
  // character fails with a 401 that names nothing.
  const read = (variable: string): string => (env[variable] ?? '').trim();

  const oxy = new OxyServices({ baseURL: read(OXY_API_URL_ENV) });
  oxy.configureServiceAuth(read(RELAY_CREDENTIAL_ENV.apiKey), read(RELAY_CREDENTIAL_ENV.apiSecret));
  return oxy;
}
