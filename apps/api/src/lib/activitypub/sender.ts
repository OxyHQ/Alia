/**
 * Sender for ActivityPub activities
 * Signs and sends activities to remote inboxes
 */

import { signRequest } from './signatures.js';
import { fetchActor } from './fetcher.js';
import { ACTOR_ACTOR_DOMAIN, ACTOR_URI } from './config.js';

/**
 * Send an activity to a remote inbox
 *
 * @param inboxUrl - URL of the remote inbox
 * @param activity - Activity object to send
 * @returns true if successful
 */
export async function sendToInbox(
  inboxUrl: string,
  activity: any
): Promise<boolean> {
  try {
    console.log(`[ActivityPub/Sender] Sending activity to: ${inboxUrl}`);
    console.log(`[ActivityPub/Sender] Activity type: ${activity.type}`);

    // Convert activity to JSON string
    const body = JSON.stringify(activity);

    // Sign the request
    const signatureHeaders = await signRequest(inboxUrl, 'POST', body);

    // Send request
    const response = await fetch(inboxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/activity+json',
        'Accept': 'application/activity+json',
        'User-Agent': 'Alia/1.0 (ActivityPub)',
        ...signatureHeaders,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ActivityPub/Sender] Failed to send activity: ${response.status} ${response.statusText}`);
      console.error(`[ActivityPub/Sender] Error response:`, errorText);
      return false;
    }

    console.log(`[ActivityPub/Sender] Activity sent successfully`);
    return true;
  } catch (error) {
    console.error('[ActivityPub/Sender] Error sending activity:', error);
    return false;
  }
}

/**
 * Send a Create activity (posting a note)
 *
 * @param content - Content of the note
 * @param inReplyTo - URI of the post this is replying to (optional)
 * @param to - Array of recipients (usually includes Public)
 * @param cc - Array of CC recipients
 * @param mentions - Array of mentioned actors
 * @returns Activity ID if successful
 */
export async function sendCreateNote(params: {
  content: string;
  inReplyTo?: string;
  to: string[];
  cc: string[];
  mentions?: Array<{ handle: string; uri: string }>;
}): Promise<string | null> {
  try {
    const { content, inReplyTo, to, cc, mentions = [] } = params;

    // Generate unique IDs
    const noteId = `https://${ACTOR_DOMAIN}/posts/${crypto.randomUUID()}`;
    const activityId = `${noteId}/activity`;

    // Create Note object
    const note = {
      id: noteId,
      type: 'Note',
      attributedTo: ACTOR_URI,
      content,
      published: new Date().toISOString(),
      to,
      cc,
      ...(inReplyTo ? { inReplyTo } : {}),
    };

    // Create Activity
    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Create',
      actor: ACTOR_URI,
      published: new Date().toISOString(),
      to,
      cc,
      object: note,
    };

    // Determine which inboxes to send to
    const inboxes = new Set<string>();

    // If replying to someone, send to their inbox
    if (inReplyTo) {
      try {
        // Extract actor URI from the parent post
        const parentPost = await import('./fetcher.js').then(m => m.fetchObject(inReplyTo));
        if (parentPost && parentPost.attributedTo) {
          const parentActor = await fetchActor(parentPost.attributedTo);
          if (parentActor) {
            // Prefer shared inbox if available
            const inbox = parentActor.endpoints?.sharedInbox || parentActor.inbox;
            inboxes.add(inbox);
          }
        }
      } catch (error) {
        console.error('[ActivityPub/Sender] Error fetching parent post:', error);
      }
    }

    // Add inboxes of mentioned actors
    for (const mention of mentions) {
      const actor = await fetchActor(mention.uri);
      if (actor) {
        const inbox = actor.endpoints?.sharedInbox || actor.inbox;
        inboxes.add(inbox);
      }
    }

    // Send to all inboxes
    const results = await Promise.allSettled(
      Array.from(inboxes).map(inbox => sendToInbox(inbox, activity))
    );

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
    console.log(`[ActivityPub/Sender] Sent to ${successCount}/${inboxes.size} inboxes`);

    return noteId;
  } catch (error) {
    console.error('[ActivityPub/Sender] Error sending Create activity:', error);
    return null;
  }
}

/**
 * Send an Accept activity (accepting a follow request)
 *
 * @param actor - URI of the actor who followed us
 * @param followActivityId - ID of the original Follow activity
 */
export async function sendAcceptFollow(
  actor: string,
  followActivityId: string
): Promise<boolean> {
  try {
    // Fetch the remote actor to get their inbox
    const remoteActor = await fetchActor(actor);
    if (!remoteActor) {
      console.error('[ActivityPub/Sender] Failed to fetch remote actor for Accept');
      return false;
    }

    // Create Accept activity
    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://${ACTOR_DOMAIN}/accepts/${crypto.randomUUID()}`,
      type: 'Accept',
      actor: ACTOR_URI,
      object: {
        id: followActivityId,
        type: 'Follow',
        actor,
        object: ACTOR_URI,
      },
    };

    // Send to their inbox
    const inbox = remoteActor.endpoints?.sharedInbox || remoteActor.inbox;
    return await sendToInbox(inbox, activity);
  } catch (error) {
    console.error('[ActivityPub/Sender] Error sending Accept activity:', error);
    return false;
  }
}
