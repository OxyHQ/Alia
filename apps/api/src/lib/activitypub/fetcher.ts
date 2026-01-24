/**
 * Fetcher for remote ActivityPub actors and objects
 * Includes caching to avoid excessive requests
 */

export interface RemoteActor {
  id: string;
  type: string;
  preferredUsername: string;
  inbox: string;
  outbox?: string;
  followers?: string;
  following?: string;
  publicKey?: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
  endpoints?: {
    sharedInbox?: string;
  };
  name?: string;
  summary?: string;
  url?: string;
}

export interface RemoteNote {
  id: string;
  type: string;
  attributedTo: string;
  content: string;
  published: string;
  to: string[];
  cc: string[];
  inReplyTo?: string;
  conversation?: string;
}

// Simple in-memory cache with TTL
const actorCache = new Map<string, { actor: RemoteActor; expires: number }>();
const objectCache = new Map<string, { object: any; expires: number }>();

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch a remote actor by their URI
 *
 * @param actorUri - URI of the actor (e.g., https://mastodon.social/users/alice)
 * @returns Remote actor object
 */
export async function fetchActor(actorUri: string): Promise<RemoteActor | null> {
  try {
    // Check cache first
    const cached = actorCache.get(actorUri);
    if (cached && cached.expires > Date.now()) {
      console.log(`[ActivityPub/Fetcher] Actor cache hit: ${actorUri}`);
      return cached.actor;
    }

    console.log(`[ActivityPub/Fetcher] Fetching actor: ${actorUri}`);

    // Fetch actor
    const response = await fetch(actorUri, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
      },
    });

    if (!response.ok) {
      console.error(`[ActivityPub/Fetcher] Failed to fetch actor: ${response.status} ${response.statusText}`);
      return null;
    }

    const actor = await response.json() as RemoteActor;

    // Validate required fields
    if (!actor.id || !actor.inbox) {
      console.error('[ActivityPub/Fetcher] Invalid actor: missing required fields');
      return null;
    }

    // Cache the actor
    actorCache.set(actorUri, {
      actor,
      expires: Date.now() + CACHE_TTL,
    });

    return actor;
  } catch (error) {
    console.error('[ActivityPub/Fetcher] Error fetching actor:', error);
    return null;
  }
}

/**
 * Fetch a remote object (Note, Article, etc.)
 *
 * @param objectUri - URI of the object
 * @returns Remote object
 */
export async function fetchObject(objectUri: string): Promise<any | null> {
  try {
    // Check cache first
    const cached = objectCache.get(objectUri);
    if (cached && cached.expires > Date.now()) {
      console.log(`[ActivityPub/Fetcher] Object cache hit: ${objectUri}`);
      return cached.object;
    }

    console.log(`[ActivityPub/Fetcher] Fetching object: ${objectUri}`);

    // Fetch object
    const response = await fetch(objectUri, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json',
      },
    });

    if (!response.ok) {
      console.error(`[ActivityPub/Fetcher] Failed to fetch object: ${response.status} ${response.statusText}`);
      return null;
    }

    const object = await response.json();

    // Cache the object
    objectCache.set(objectUri, {
      object,
      expires: Date.now() + CACHE_TTL,
    });

    return object;
  } catch (error) {
    console.error('[ActivityPub/Fetcher] Error fetching object:', error);
    return null;
  }
}

/**
 * Fetch conversation context (ancestors of a post)
 *
 * @param noteUri - URI of the note
 * @param maxDepth - Maximum depth to fetch (default: 10)
 * @returns Array of notes in chronological order (oldest first)
 */
export async function fetchConversationContext(
  noteUri: string,
  maxDepth: number = 10
): Promise<RemoteNote[]> {
  const context: RemoteNote[] = [];

  try {
    let currentUri: string | undefined = noteUri;
    let depth = 0;

    while (currentUri && depth < maxDepth) {
      const note = await fetchObject(currentUri) as RemoteNote;
      if (!note) break;

      context.unshift(note); // Add to beginning (chronological order)

      currentUri = note.inReplyTo;
      depth++;
    }

    return context;
  } catch (error) {
    console.error('[ActivityPub/Fetcher] Error fetching conversation context:', error);
    return context;
  }
}

/**
 * Clear expired cache entries
 */
export function clearExpiredCache() {
  const now = Date.now();

  for (const [key, value] of actorCache.entries()) {
    if (value.expires < now) {
      actorCache.delete(key);
    }
  }

  for (const [key, value] of objectCache.entries()) {
    if (value.expires < now) {
      objectCache.delete(key);
    }
  }
}

// Clear cache every hour
setInterval(clearExpiredCache, 60 * 60 * 1000);
