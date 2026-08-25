/**
 * Resolving an Oxy account id to something renderable.
 *
 * Alia stores `oxyUserId` / `userId` as a bare id and Oxy owns the identity
 * behind it. Several models declare `ref: 'User'` on those fields, which is a
 * Mongoose instruction to join against a model this service does not have and
 * never will — Oxy is a separate service reached over HTTP, and a local `User`
 * collection would be a cache free to disagree with it.
 *
 * `.populate()` on such a field throws `MissingSchemaError`, but ONLY once there
 * is at least one document to populate: with an empty result set Mongoose never
 * reaches for the model and the query resolves normally. That is why the fault
 * survived — a fresh organization and an unreviewed agent both work, and the
 * endpoint starts failing the moment the feature is used.
 *
 * This module is the replacement. It reads through `getUsersByIds`, the batch
 * endpoint built for exactly this fan-out, so a page of twenty reviews costs one
 * round trip rather than twenty.
 */

import { getNormalizedUserHandle, type User } from '@oxyhq/core';
import { oxyClient } from '../middleware/auth.js';
import { log } from './logger.js';
import { oxyServiceClient } from './oxy-service-client.js';

/**
 * What a caller may render for an account.
 *
 * `_id` rather than `id` because it stands where a populated Mongoose document
 * did, and the clients already read `.userId._id`.
 *
 * Deliberately NOT carrying `email`. The removed `.populate()` calls asked for
 * it, but `/users/by-ids` answers with the PUBLIC profile and does not serve
 * addresses to a third party — and a member list is read by every member of an
 * organization, so this is the correct projection rather than a limitation to
 * work around. Nothing regresses: the populate never once succeeded, so no
 * client has ever received an email from these endpoints.
 */
export interface HydratedOxyUser {
  readonly _id: string;
  readonly username: string;
  /** `name.displayName` when Oxy resolved one, else the normalized handle. */
  readonly displayName: string;
  readonly avatar?: string;
  /**
   * A Bloom colour preset KEY, not a hex — `"blue"`, `"lagoon"`. Oxy's own
   * `User.color`, which is where an ACCOUNT's colour lives for every consumer
   * in the ecosystem, so Alia reads it here rather than storing a second one.
   *
   * Absent when the account never set one, and absent for every account when a
   * deployment's Oxy is old enough not to serve the field. Both are the same
   * answer to a consumer: render your own fallback.
   */
  readonly color?: string;
}

function toHydrated(user: User): HydratedOxyUser | null {
  const id = typeof user.id === 'string' ? user.id : '';
  if (!id) return null;

  // The sanctioned coalesce. `name.displayName` is optional — federated and
  // unresolved actors routinely omit it — and recomposing a name from
  // `first`/`last`/`full` is what the contract forbids.
  const handle = getNormalizedUserHandle(user) ?? user.username;
  const displayName = user.name?.displayName?.trim() || handle;

  return {
    _id: id,
    username: user.username,
    displayName,
    ...(typeof user.avatar === 'string' && user.avatar ? { avatar: user.avatar } : {}),
    ...(typeof user.color === 'string' && user.color ? { color: user.color } : {}),
  };
}

/**
 * Resolve many account ids in one batch.
 *
 * **Fails OPEN.** An id Oxy cannot resolve — deleted, federated, or simply
 * unreachable because Oxy is having a bad afternoon — is absent from the map and
 * the caller renders its own fallback. The alternative is letting an identity
 * lookup decide whether a list of reviews or members can be displayed at all,
 * which makes an Oxy outage an Alia outage for pages whose actual subject is
 * stored right here. The identity is decoration on somebody else's row; the row
 * is the fact.
 *
 * ## The call is made AS ALIA, and it has to be
 *
 * `/users/by-ids` is a POST, so oxy-api's CSRF middleware refuses it unless the
 * request carries a bearer. `middleware/auth.ts`'s shared `oxyClient` carries
 * none — it exists to VERIFY inbound user tokens — so this read answered
 * `403 CSRF_TOKEN_MISSING` for every caller, and `@oxyhq/core` swallows a failed
 * chunk and returns the users that resolved. Zero of them. Failing open then did
 * exactly what it promises: every name, handle and avatar in the product
 * rendered as a client-side fallback, and a newly created agent came back with
 * no identity at all.
 *
 * So the batch goes through {@link oxyServiceClient}, which presents Alia's own
 * ApplicationCredential. NOT by giving the shared client `setTokens` or
 * `configureServiceAuth`: it is shared across concurrent requests, so one
 * caller's session would leak into another's, and arming service mode on it
 * would change what a dozen unrelated call sites send.
 *
 * A deployment with no credential falls back to the shared client, which is the
 * line this one replaced — same call, same failing-open result, no new failure
 * mode introduced where there was none. `oxy-service-client.ts` says once, at
 * warn, that identity will resolve nothing.
 *
 * The viewer is still nobody's business here: `/users/by-ids` answers every
 * caller with the same public profile, which is why one process-wide credential
 * can serve a read on behalf of any of them.
 */
export async function hydrateOxyUsers(
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, HydratedOxyUser>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
  const resolved = new Map<string, HydratedOxyUser>();
  if (wanted.length === 0) return resolved;

  try {
    // The SDK deduplicates and chunks; passing the whole list is intended use.
    const users = await (oxyServiceClient() ?? oxyClient).getUsersByIds(wanted);
    for (const user of users) {
      const hydrated = toHydrated(user);
      if (hydrated) resolved.set(hydrated._id, hydrated);
    }
    if (resolved.size === 0) {
      /**
       * The line this fault needed and did not have.
       *
       * `@oxyhq/core` catches a failed chunk itself and returns the users that
       * resolved, so an unauthenticated 403 arrives here as an empty array and
       * the `catch` below never runs. "Oxy refused us" and "none of these
       * accounts exist" are the same value at this seam; they are not the same
       * event, and only one of them is a deployment fault.
       */
      log.general.warn(
        { requested: wanted.length },
        'Oxy resolved none of the requested accounts',
      );
    }
  } catch (error: unknown) {
    // Counted, not swallowed: a persistent gap here shows as every author
    // rendering as a fallback, and this is the line that says why.
    log.general.warn(
      { err: error, requested: wanted.length },
      'Oxy user hydration failed; rendering ids without profiles',
    );
  }

  return resolved;
}
