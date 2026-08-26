/**
 * The Oxy client that speaks as ALIA, rather than as whoever is calling.
 *
 * ## Why a second client exists at all
 *
 * `middleware/auth.ts` builds the process's `oxyClient` for VERIFYING inbound
 * user tokens, and it carries no credentials of any kind. That is correct for
 * what it does and wrong for anything Alia has to ask Oxy on its own account:
 * `POST /users/by-ids` is a state-changing method, so oxy-api's CSRF middleware
 * refuses it unless the request carries a bearer — measured against production
 * on 2026-08-25, an anonymous POST answers `403 CSRF_TOKEN_MISSING` while
 * `GET /users/:id` answers 200, and `@oxyhq/core`'s own `GET /csrf-token`
 * preflight does not rescue it, because the double-submit cookie it pairs with
 * cannot exist in a Node process.
 *
 * The two ways to carry a bearer are the caller's and Alia's own. The caller's
 * is unavailable on half the paths that need identity — the agent runner, the
 * trigger engine, the Telegram webhook and session handoff all hydrate an agent
 * with no request in scope — and would buy nothing where it IS available, since
 * `/users/by-ids` answers every caller with the same public profile. So: Alia's
 * own, which is what an ApplicationCredential is for.
 *
 * ## Why this is not `middleware/auth.ts`'s client with credentials added
 *
 * `configureServiceAuth` is instance state, and every method that has a
 * service-mode branch reads it. Arming it on the client that verifies inbound
 * user tokens would change what a dozen unrelated call sites send, as a side
 * effect of fixing identity hydration. `lib/inference/kaana-credential.ts`
 * refuses the same move for the same reason, and `lib/agent-account.ts` builds
 * its own per-caller client rather than mutating the shared one.
 *
 * ## The credential is Oxy's, not Kaana's
 *
 * `ALIA_RELAY_CREDENTIAL_KEY` / `_SECRET` are Alia's Oxy ApplicationCredential:
 * one record, one secret, seven scopes, of which `user:read` is the one read
 * here and `inference:*` are the ones `kaana-credential.ts` exchanges for. The
 * `RELAY` in the name is the working name Kaana shipped under (see ADR 0001) and is not a claim
 * about who may use it. Two modules therefore name the same two variables, which
 * is the same shape `OXY_API_URL` already has (`middleware/auth.ts`,
 * `lib/agent-account.ts`, `kaana-credential.ts`); gate 6 in
 * `__tests__/architectureGates.test.ts` records every file that reads each one.
 *
 * Nothing is shared with `kaana-credential.ts` beyond those names, deliberately:
 * its factory builds a client per call over an environment it is HANDED, so a
 * deployment can hold more than one credential, and it throws when the
 * environment configures none. Both are wrong here — this is one process-wide
 * client over one environment, and an unconfigured deployment must degrade
 * rather than fail.
 */

import { OxyServices } from '@oxyhq/core';

import { log } from './logger.js';

/**
 * Built at most once, on first use.
 *
 * `undefined` is "not yet attempted" and `null` is "attempted, no credential" —
 * a nullable alone would retry the environment read, and the warning below,
 * on every hydration. Not built at import: the environment is not read until
 * something asks, so importing this module opens nothing and warns about
 * nothing, and a test may stub the environment before the first call.
 *
 * One instance is the point rather than an accident. `@oxyhq/core` caches the
 * minted service token per `(apiKey, apiSecret)` pair on the INSTANCE, refreshes
 * it a minute before it expires and collapses concurrent callers onto one
 * in-flight exchange — all of which a fresh client per call would discard,
 * turning every identity read into two round trips.
 */
let client: OxyServices | null | undefined;

/**
 * Alia's own Oxy client, or `null` when this deployment configured no
 * credential.
 *
 * A caller that gets `null` is expected to degrade, not to throw: local
 * development and the test suite both run without one, and an identity lookup
 * is decoration on somebody else's row (`oxy-user-hydration.ts` says what that
 * costs and why it is the right trade).
 */
export function oxyServiceClient(): OxyServices | null {
  if (client === undefined) client = build();
  return client;
}

function build(): OxyServices | null {
  // Trimmed, and the presence check reads the trimmed value: a secret that
  // reached the environment from a file carries the file's trailing newline, and
  // a credential that differs by one invisible character fails with a 401 that
  // names nothing.
  const baseURL = (process.env.OXY_API_URL ?? '').trim();
  const apiKey = (process.env.ALIA_RELAY_CREDENTIAL_KEY ?? '').trim();
  const apiSecret = (process.env.ALIA_RELAY_CREDENTIAL_SECRET ?? '').trim();

  const unset = Object.entries({
    OXY_API_URL: baseURL,
    ALIA_RELAY_CREDENTIAL_KEY: apiKey,
    ALIA_RELAY_CREDENTIAL_SECRET: apiSecret,
  })
    .filter(([, value]) => value === '')
    .map(([variable]) => variable);

  if (unset.length > 0) {
    // Once per process, and it names the variables: the symptom at the other end
    // is every name and handle rendering blank, which says nothing about why.
    log.general.warn(
      { unset },
      'no Oxy service credential; identity lookups will resolve nothing',
    );
    return null;
  }

  const oxy = new OxyServices({ baseURL });
  oxy.configureServiceAuth(apiKey, apiSecret);
  return oxy;
}
