/**
 * ActivityPub Configuration
 * Centralized configuration for ActivityPub server
 */

// Domain used in the handle (e.g., @alia@alia.onl)
export const ACTIVITYPUB_DOMAIN = process.env.ACTIVITYPUB_DOMAIN || 'alia.onl';

// Domain where the actor endpoints are hosted (e.g., api.alia.onl)
// If not set, defaults to ACTIVITYPUB_DOMAIN
export const ACTOR_DOMAIN = process.env.ACTOR_DOMAIN || process.env.ACTIVITYPUB_DOMAIN || 'api.alia.onl';

// Actor username
export const ACTOR_USERNAME = 'alia';

// Full actor URI (e.g., https://api.alia.onl/actors/alia)
export const ACTOR_URI = `https://${ACTOR_DOMAIN}/actors/${ACTOR_USERNAME}`;

// Actor profile URL - points to profile page
export const ACTOR_URL = `https://${ACTIVITYPUB_DOMAIN}/alia`;

// ActivityStreams Public address
export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

// Build URIs
export function getActorUri(): string {
  return ACTOR_URI;
}

export function getInboxUri(): string {
  return `${ACTOR_URI}/inbox`;
}

export function getOutboxUri(): string {
  return `${ACTOR_URI}/outbox`;
}

export function getFollowersUri(): string {
  return `${ACTOR_URI}/followers`;
}

export function getFollowingUri(): string {
  return `${ACTOR_URI}/following`;
}

export function getKeyId(): string {
  return `${ACTOR_URI}#main-key`;
}
