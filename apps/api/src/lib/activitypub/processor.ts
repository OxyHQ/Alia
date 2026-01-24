/**
 * Activity Processor
 * Processes incoming ActivityPub activities (Create, Follow, etc.)
 */

import { ActivityPubActivity } from '../../models/activitypub-activity.js';
import { ActivityPubFollower } from '../../models/activitypub-follower.js';
import { ActivityPubPost } from '../../models/activitypub-post.js';
import { fetchActor, fetchConversationContext } from './fetcher.js';
import { sendAcceptFollow, sendCreateNote } from './sender.js';
import {
  stripHtml,
  isMentioned,
  removeSelfMention,
  truncateText,
  getHandleFromUri,
  AS_PUBLIC,
  getActorUri,
  getFollowersUri,
} from './utils.js';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const MASTODON_BOT_SECRET = process.env.MASTODON_BOT_SECRET || 'secret';

/**
 * Process an incoming activity
 *
 * @param activity - Activity object
 */
export async function processActivity(activity: any): Promise<void> {
  try {
    // Log the activity
    const activityId = activity.id || `temp-${Date.now()}`;

    // Check if already processed
    const existing = await ActivityPubActivity.findOne({ activityId });
    if (existing && existing.processed) {
      console.log('[ActivityPub/Processor] Activity already processed:', activityId);
      return;
    }

    // Save activity to database
    await ActivityPubActivity.findOneAndUpdate(
      { activityId },
      {
        activityId,
        type: activity.type,
        actor: activity.actor,
        object: activity.object || activity,
        processed: false,
        createdAt: new Date(),
      },
      { upsert: true }
    );

    console.log(`[ActivityPub/Processor] Processing ${activity.type} activity from ${activity.actor}`);

    // Route to appropriate handler based on activity type
    switch (activity.type) {
      case 'Create':
        await handleCreate(activity);
        break;
      case 'Follow':
        await handleFollow(activity);
        break;
      case 'Undo':
        await handleUndo(activity);
        break;
      case 'Like':
      case 'Announce':
        // Log but don't process for now
        console.log(`[ActivityPub/Processor] Received ${activity.type} activity (not processed)`);
        break;
      default:
        console.log(`[ActivityPub/Processor] Unknown activity type: ${activity.type}`);
    }

    // Mark as processed
    await ActivityPubActivity.findOneAndUpdate(
      { activityId },
      {
        processed: true,
        processedAt: new Date(),
      }
    );
  } catch (error: any) {
    console.error('[ActivityPub/Processor] Error processing activity:', error);

    // Save error to database
    if (activity.id) {
      await ActivityPubActivity.findOneAndUpdate(
        { activityId: activity.id },
        {
          error: error.message,
          processedAt: new Date(),
        }
      );
    }
  }
}

/**
 * Handle Create activity (new post/note)
 */
async function handleCreate(activity: any): Promise<void> {
  try {
    const object = activity.object;

    if (!object || object.type !== 'Note') {
      console.log('[ActivityPub/Processor] Ignoring non-Note object');
      return;
    }

    const content = object.content || '';
    const cleanText = stripHtml(content);

    // Check if we're mentioned
    if (!isMentioned(content, cleanText)) {
      console.log('[ActivityPub/Processor] Not mentioned, ignoring');
      return;
    }

    console.log(`[ActivityPub/Processor] Mentioned in post: ${cleanText.substring(0, 100)}`);

    // Remove our mention from the text
    const userMessage = removeSelfMention(cleanText);

    if (!userMessage || userMessage.length < 2) {
      console.log('[ActivityPub/Processor] Empty message after removing mention, ignoring');
      return;
    }

    // Build conversation context if this is a reply
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (object.inReplyTo) {
      console.log('[ActivityPub/Processor] Fetching conversation context...');
      const context = await fetchConversationContext(object.inReplyTo, 10);

      // Convert context to message format
      const ourActorUri = getActorUri();
      for (const note of context) {
        const isOurs = note.attributedTo === ourActorUri;
        const noteText = stripHtml(note.content);

        messages.push({
          role: isOurs ? 'assistant' : 'user',
          content: isOurs ? noteText : removeSelfMention(noteText),
        });
      }

      console.log(`[ActivityPub/Processor] Loaded ${context.length} messages from context`);
    }

    // Add current message
    messages.push({
      role: 'user',
      content: userMessage,
    });

    // Call Alia API to generate response
    console.log('[ActivityPub/Processor] Calling Alia API...');
    const response = await callAliaAPI(messages);

    if (!response) {
      console.error('[ActivityPub/Processor] Failed to get response from Alia API');
      return;
    }

    // Truncate if needed
    const truncatedResponse = truncateText(response, 480);

    console.log(`[ActivityPub/Processor] Generated response: ${truncatedResponse.substring(0, 100)}...`);

    // Get actor info for mention
    const actor = await fetchActor(activity.actor);
    const handle = actor ? getHandleFromUri(activity.actor, actor.preferredUsername) : 'unknown';

    // Determine recipients (reply to original author + public)
    const to = object.to || [AS_PUBLIC];
    const cc = [activity.actor];

    // Add our followers to CC if original was public
    if (to.includes(AS_PUBLIC)) {
      cc.push(getFollowersUri());
    }

    // Send response
    const noteId = await sendCreateNote({
      content: `@${handle} ${truncatedResponse}`,
      inReplyTo: object.id,
      to,
      cc,
      mentions: [{ handle, uri: activity.actor }],
    });

    if (noteId) {
      // Save our post to database
      await ActivityPubPost.create({
        postId: noteId,
        content: truncatedResponse,
        inReplyTo: object.id,
        published: new Date(),
        to,
        cc,
        mentions: [{ handle, uri: activity.actor }],
      });

      console.log('[ActivityPub/Processor] Response sent successfully');
    }
  } catch (error) {
    console.error('[ActivityPub/Processor] Error handling Create activity:', error);
  }
}

/**
 * Handle Follow activity
 */
async function handleFollow(activity: any): Promise<void> {
  try {
    const follower = activity.actor;

    console.log(`[ActivityPub/Processor] New follower: ${follower}`);

    // Fetch follower info
    const actor = await fetchActor(follower);
    if (!actor) {
      console.error('[ActivityPub/Processor] Failed to fetch follower actor');
      return;
    }

    const handle = getHandleFromUri(follower, actor.preferredUsername);

    // Save follower to database
    await ActivityPubFollower.findOneAndUpdate(
      { actorUri: follower },
      {
        actorUri: follower,
        handle,
        inbox: actor.inbox,
        sharedInbox: actor.endpoints?.sharedInbox,
        followedAt: new Date(),
        status: 'accepted',
      },
      { upsert: true }
    );

    // Send Accept activity
    const accepted = await sendAcceptFollow(follower, activity.id);

    if (accepted) {
      console.log(`[ActivityPub/Processor] Accepted follow from ${handle}`);
    } else {
      console.error(`[ActivityPub/Processor] Failed to send Accept to ${handle}`);
    }
  } catch (error) {
    console.error('[ActivityPub/Processor] Error handling Follow activity:', error);
  }
}

/**
 * Handle Undo activity (unfollow, etc.)
 */
async function handleUndo(activity: any): Promise<void> {
  try {
    const object = activity.object;

    if (object.type === 'Follow') {
      const follower = activity.actor;
      console.log(`[ActivityPub/Processor] Unfollowed by: ${follower}`);

      // Remove from database
      await ActivityPubFollower.deleteOne({ actorUri: follower });
    }
  } catch (error) {
    console.error('[ActivityPub/Processor] Error handling Undo activity:', error);
  }
}

/**
 * Call Alia Chat API to generate response
 */
async function callAliaAPI(messages: Array<{ role: string; content: string }>): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/alia/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mastodon-Bot-Secret': MASTODON_BOT_SECRET,
        'X-Source': 'mastodon',
      },
      body: JSON.stringify({
        messages,
        model: 'alia-lite',
        stream: true,
      }),
    });

    if (!response.ok) {
      console.error(`[ActivityPub/Processor] API error: ${response.status}`);
      return null;
    }

    // Process streaming response
    const reader = response.body?.getReader();
    if (!reader) {
      console.error('[ActivityPub/Processor] No response body');
      return null;
    }

    const decoder = new TextDecoder();
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();

          if (dataStr === '[DONE]') {
            return fullResponse;
          }

          try {
            const data = JSON.parse(dataStr);

            // Handle different response formats
            if (data.type === 'text-delta' && data.text) {
              fullResponse += data.text;
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
    }

    return fullResponse;
  } catch (error) {
    console.error('[ActivityPub/Processor] Error calling Alia API:', error);
    return null;
  }
}
