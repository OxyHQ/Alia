/**
 * Resolving an Oxy account id to something renderable.
 *
 * Alia stores `oxyUserId` / `userId` as a bare id and Oxy owns the identity
 * behind it. There is no local `User` table to join against, and there never
 * will be — Oxy is a separate service reached over HTTP, and a local copy would
 * be a cache free to disagree with it.
 *
 * A join against such a table fails ONLY once there is at least one row to
 * join, which is why that kind of fault survives — a fresh organization and an
 * unreviewed agent both work, and the endpoint starts failing the moment the
 * feature is used.
 *
 * This module resolves accounts instead. It reads through `users.lookupMany`, the
 * batch endpoint built for exactly this fan-out, so a page of twenty reviews
 * costs one round trip rather than twenty — and it says which ids FAILED, apart
 * from the ones Oxy answered do not exist.
 */

import { getNormalizedUserHandle, type User } from '@oxy.so/core';
import { log } from './logger.js';
import { oxy } from './oxy.js';

/**
 * What a caller may render for an account.
 *
 * `_id` rather than `id` because the clients already read `.userId._id`.
 *
 * Deliberately NOT carrying `email`. `/users/by-ids` answers with the PUBLIC profile and does not serve
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
 * Resolve many account ids in one batch, for DISPLAY.
 *
 * An id Oxy does not resolve — deleted, federated, or in a chunk that failed —
 * is absent from the map and the caller renders its own fallback: the identity
 * is decoration on somebody else's row, and an Oxy outage must not decide
 * whether a list of reviews or members can be shown at all. That is the ONLY
 * thing this is for. Nothing may treat an absent id as "this account does not
 * exist" (authority, completeness, a cache of unknown ids); such a caller reads
 * `oxy.users.lookupMany` itself and handles `failed`.
 *
 * The read goes out through the one `OxyServer` (`lib/oxy.ts`), whose
 * `serviceIdentity: 'when-anonymous'` carries Alia's own service token:
 * `/users/by-ids` is a POST, which oxy-api refuses without a bearer, and its
 * public profiles are the same for every viewer, so one process-wide identity
 * serves every caller. A failed chunk is logged as a failure, never folded
 * into "not found".
 */
export async function hydrateOxyUsers(
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, HydratedOxyUser>> {
  const wanted = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '')),
  ];
  const resolved = new Map<string, HydratedOxyUser>();
  if (wanted.length === 0) return resolved;

  try {
    // The SDK deduplicates and chunks; passing the whole list is intended use.
    const { found, failed, error } = await oxy.users.lookupMany(wanted);
    for (const user of found) {
      const hydrated = toHydrated(user);
      if (hydrated) resolved.set(hydrated._id, hydrated);
    }
    if (failed.length > 0) {
      log.general.warn(
        { err: error, requested: wanted.length, failed: failed.length },
        'Oxy user hydration failed for some accounts; rendering them without profiles',
      );
    }
  } catch (error: unknown) {
    log.general.warn(
      { err: error, requested: wanted.length },
      'Oxy user hydration failed; rendering ids without profiles',
    );
  }

  return resolved;
}
