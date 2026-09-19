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
 * `GET /users/:id` answers 200, and `@oxy.so/core`'s own `GET /csrf-token`
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
 * effect of fixing identity hydration. The inference credential factory keeps
 * its own client for the same reason, and `lib/agent-account.ts` builds its own
 * per-caller client rather than mutating the shared one.
 *
 * ## The credential is Oxy's, not Kaana's — and a deployment no longer has one
 *
 * `OXY_SERVICE_API_KEY` / `_SECRET` are Alia's Oxy ApplicationCredential: one
 * record, one secret and the scopes needed by this runtime. `user:read` is the
 * one read here and `inference:*` are used by the inference client. Two modules
 * therefore name the same two variables, which
 * is the same shape `OXY_API_URL` already has (`middleware/auth.ts`,
 * `lib/agent-account.ts`, `inference/oxy-inference-credential.ts`).
 *
 * Under oxy ADR 0026 a first-party service proves what it IS — a signed
 * `GetCallerIdentity` for its ECS task role, which Oxy replays to AWS — and gets
 * back the same short-lived service token the pair used to buy. `@oxy.so/core`
 * >= 1.6.1 takes that path inside `getServiceToken()` whenever no pair was
 * configured, so the pair became a LOCAL convenience: a checkout can attest
 * nothing, and this is how it borrows Alia's identity.
 *
 * Which is why nothing below treats an absent pair as "no identity" any more.
 * It stopped being the same question the day the task role could answer it, and
 * a warning telling an operator that a working deployment resolves no identities
 * is how the credential ends up being put back.
 *
 * Nothing is shared with the inference client beyond those names, deliberately:
 * hosted inference is a required boot-time contract, while identity hydration
 * is optional decoration. An unconfigured identity client must degrade rather
 * than turn every non-inference development task into a crash.
 */

import { OxyServices } from '@oxy.so/core';
import { canAttestWorkloadIdentity } from '@oxy.so/core/server';

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
 * One instance is the point rather than an accident. `@oxy.so/core` caches the
 * minted service token per `(apiKey, apiSecret)` pair on the INSTANCE, refreshes
 * it a minute before it expires and collapses concurrent callers onto one
 * in-flight exchange — all of which a fresh client per call would discard,
 * turning every identity read into two round trips.
 */
let client: OxyServices | null | undefined;

/**
 * Alia's own Oxy client, or `null` when this process has no Oxy identity at all.
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

/**
 * Whether this process can act as Alia against Oxy at all.
 *
 * Two ways, and a deployment has one of them without anybody configuring it: in
 * ECS the task role attests (oxy ADR 0026 — no secret anywhere) and elsewhere
 * the key pair does. A local checkout has neither, which is the honest answer to
 * "is this on here".
 *
 * A capability, not a variable. Every caller that used to read the pair was
 * asking this, and getting the right answer only while a secret was the only
 * identity there was; asked this way, removing the pair from the task definition
 * changes nothing.
 */
export function canAuthenticateAsOxyService(env: NodeJS.ProcessEnv = process.env): boolean {
  if (canAttestWorkloadIdentity(env)) return true;
  return (
    (env.OXY_SERVICE_API_KEY ?? '').trim() !== '' &&
    (env.OXY_SERVICE_API_SECRET ?? '').trim() !== ''
  );
}

/** A short-lived token for Alia's own Oxy identity. */
export async function oxyServiceToken(): Promise<string> {
  const oxy = oxyServiceClient();
  if (!oxy) throw new Error('Alia has no Oxy service identity: no credential pair and nothing to attest');
  return oxy.getServiceToken();
}

function build(): OxyServices | null {
  // Trimmed, and the presence check reads the trimmed value: a secret that
  // reached the environment from a file carries the file's trailing newline, and
  // a credential that differs by one invisible character fails with a 401 that
  // names nothing.
  const baseURL = (process.env.OXY_API_URL ?? '').trim();
  const apiKey = (process.env.OXY_SERVICE_API_KEY ?? '').trim();
  const apiSecret = (process.env.OXY_SERVICE_API_SECRET ?? '').trim();

  // Still required, and not part of the migration: attestation says what this
  // process IS, not where Oxy is. A client with no base URL has nowhere to
  // present the token it can now mint.
  if (baseURL === '') {
    log.general.warn(
      { unset: ['OXY_API_URL'] },
      'no Oxy API origin; identity lookups will resolve nothing',
    );
    return null;
  }

  if (apiKey === '' || apiSecret === '') {
    /**
     * Three outcomes, not two, because "no pair" and "no identity" stopped being
     * the same thing.
     *
     * On the infrastructure the SDK attests the task role inside
     * `getServiceToken()` and every call that wanted a service token still gets
     * one — so the client is BUILT, deliberately without `configureServiceAuth`.
     * Handing it half a pair instead would replace a working attestation with a
     * credential that cannot mint, which is why both-or-neither is the rule and
     * one alone counts as neither.
     *
     * Only the second branch describes a process that resolves nothing, and it
     * names both variables because setting them is still the thing to do there.
     */
    if (canAttestWorkloadIdentity()) {
      log.general.info(
        'no Oxy service key pair; the SDK attests this task role instead (oxy ADR 0026)',
      );
      return new OxyServices({ baseURL });
    }
    // Once per process, and it names the variables: the symptom at the other end
    // is every name and handle rendering blank, which says nothing about why.
    log.general.warn(
      { unset: ['OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET'] },
      'no Oxy service identity: neither a key pair nor an attestable task role; ' +
        'identity lookups will resolve nothing',
    );
    return null;
  }

  const oxy = new OxyServices({ baseURL });
  oxy.configureServiceAuth(apiKey, apiSecret);
  return oxy;
}
