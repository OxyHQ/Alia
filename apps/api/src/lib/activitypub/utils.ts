/**
 * Utility functions for ActivityPub
 */

const DOMAIN = process.env.ACTIVITYPUB_DOMAIN || 'alia.onl';

/**
 * Strip HTML tags from content
 * Mastodon sends content as HTML, we need plain text for AI processing
 *
 * @param html - HTML string
 * @returns Plain text
 */
export function stripHtml(html: string): string {
  if (!html) return '';

  return html
    // Remove script and style tags entirely
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Replace <br> and <p> tags with newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    // Remove all other HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Trim excessive whitespace
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Extract mentions from HTML content
 *
 * @param html - HTML content
 * @returns Array of mentioned handles
 */
export function extractMentions(html: string): string[] {
  const mentions: string[] = [];

  // Match mention links like:
  // <a href="https://mastodon.social/@alice" class="mention">@alice</a>
  // <span class="h-card"><a href="https://alia.onl/@alia">@<span>alia</span></a></span>
  const mentionRegex = /@<span>([^<]+)<\/span>|@(\w+)/g;
  let match;

  while ((match = mentionRegex.exec(html)) !== null) {
    const username = match[1] || match[2];
    if (username) {
      mentions.push(`@${username}`);
    }
  }

  return mentions;
}

/**
 * Check if our actor is mentioned in the content
 *
 * @param html - HTML content
 * @param content - Plain text content
 * @returns true if mentioned
 */
export function isMentioned(html: string, content?: string): boolean {
  const text = content || stripHtml(html);

  // Check for @alia mention
  return (
    text.includes('@alia') ||
    html.includes(`@${DOMAIN}/@alia`) ||
    html.includes('https://alia.onl/@alia') ||
    html.includes('https://alia.onl/actors/alia')
  );
}

/**
 * Remove our mention from the content
 *
 * @param text - Text content
 * @returns Text without our mention
 */
export function removeSelfMention(text: string): string {
  return text
    .replace(/@alia(@alia\.onl)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate text to fit character limit
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length (default: 480)
 * @returns Truncated text
 */
export function truncateText(text: string, maxLength: number = 480): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Try to truncate at sentence boundary
  const truncated = text.substring(0, maxLength - 3);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastExclamation = truncated.lastIndexOf('!');
  const lastQuestion = truncated.lastIndexOf('?');

  const lastSentence = Math.max(lastPeriod, lastExclamation, lastQuestion);

  if (lastSentence > maxLength * 0.7) {
    return truncated.substring(0, lastSentence + 1);
  }

  // Otherwise truncate at word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Extract actor handle from URI
 *
 * @param actorUri - Actor URI (e.g., https://mastodon.social/users/alice)
 * @returns Handle (e.g., alice@mastodon.social)
 */
export function getHandleFromUri(actorUri: string, preferredUsername?: string): string {
  try {
    const url = new URL(actorUri);
    const username = preferredUsername || url.pathname.split('/').pop() || 'unknown';
    return `${username}@${url.hostname}`;
  } catch (error) {
    return 'unknown@unknown';
  }
}

/**
 * Build actor URI from our domain
 */
export function getActorUri(): string {
  return `https://${DOMAIN}/actors/alia`;
}

/**
 * Build inbox URI
 */
export function getInboxUri(): string {
  return `https://${DOMAIN}/actors/alia/inbox`;
}

/**
 * Build outbox URI
 */
export function getOutboxUri(): string {
  return `https://${DOMAIN}/actors/alia/outbox`;
}

/**
 * Build followers URI
 */
export function getFollowersUri(): string {
  return `https://${DOMAIN}/actors/alia/followers`;
}

/**
 * Build following URI
 */
export function getFollowingUri(): string {
  return `https://${DOMAIN}/actors/alia/following`;
}

/**
 * ActivityStreams Public address
 */
export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
