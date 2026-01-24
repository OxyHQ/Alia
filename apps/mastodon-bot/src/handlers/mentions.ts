import { callAliaChat, type ChatMessage } from '../services/alia-api.js';

/**
 * Handle a mention notification from Mastodon
 */
export async function handleMentions(
  masto: any,
  notification: any,
  botAccountId: string
) {
  const status = notification.status;

  if (!status) {
    console.log('[Mentions] Notification has no status, skipping');
    return;
  }

  const author = status.account;
  const authorHandle = author.acct;

  console.log(`[Mentions] Processing mention from @${authorHandle}`);

  try {
    // Extract and clean the text content
    const cleanText = stripHtmlAndMention(status.content, botAccountId);

    if (!cleanText || cleanText.trim().length === 0) {
      console.log(`[Mentions] Empty mention from @${authorHandle}, skipping`);
      return;
    }

    console.log(`[Mentions] Mention text: "${cleanText}"`);

    // Build conversation context
    const messages = await buildConversationContext(masto, status, botAccountId);

    // Add current mention
    messages.push({
      role: 'user',
      content: cleanText,
    });

    console.log(`[Mentions] Context: ${messages.length} messages`);

    // Generate response using Alia API
    const startTime = Date.now();
    const response = await callAliaChat({
      messages,
      model: 'alia-lite',
      stream: true,
    });

    const responseTime = Date.now() - startTime;
    console.log(`[Mentions] Generated response in ${responseTime}ms`);

    // Clean and truncate response for Mastodon's character limit
    let finalResponse = cleanResponse(response);

    // Mastodon default limit is 500 chars, but we'll keep it under 480 to be safe
    // and account for the @mention we're adding
    const maxLength = 450;
    if (finalResponse.length > maxLength) {
      finalResponse = finalResponse.substring(0, maxLength - 3) + '...';
      console.log(`[Mentions] Truncated response to ${maxLength} characters`);
    }

    // Post reply
    const replyStatus = await masto.v1.statuses.create({
      status: `@${authorHandle} ${finalResponse}`,
      inReplyToId: status.id,
      visibility: status.visibility, // Match original visibility
    });

    console.log(`[Mentions] Posted reply: ${replyStatus.url}`);
  } catch (error: any) {
    console.error(`[Mentions] Error processing mention from @${authorHandle}:`, error);

    // Try to send error message to user (only in direct or private visibility)
    try {
      if (status.visibility === 'direct' || status.visibility === 'private') {
        await masto.v1.statuses.create({
          status: `@${authorHandle} Lo siento, hubo un error procesando tu mensaje. Por favor intenta nuevamente.`,
          inReplyToId: status.id,
          visibility: 'direct',
        });
      }
    } catch (replyError) {
      console.error('[Mentions] Failed to send error message:', replyError);
    }
  }
}

/**
 * Strip HTML tags and bot mentions from content
 */
function stripHtmlAndMention(html: string, botAccountId: string): string {
  // Remove HTML tags
  let text = html.replace(/<[^>]*>/g, '');

  // Decode HTML entities
  text = text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Remove @alia mentions (case insensitive)
  // Handles both @alia and @alia@alia.onl formats
  text = text.replace(/@alia(@alia\.onl)?/gi, '');

  // Clean up extra whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Build conversation context from thread ancestors
 */
async function buildConversationContext(
  masto: any,
  status: any,
  botAccountId: string
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];

  // If this is a reply, get the conversation context
  if (status.inReplyToId) {
    try {
      const context = await masto.v1.statuses.$select(status.id).context.fetch();

      // Limit to last 15 messages to avoid token limits
      const ancestors = context.ancestors.slice(-15);

      for (const ancestor of ancestors) {
        const isBot = ancestor.account.id === botAccountId;
        const content = stripHtmlAndMention(ancestor.content, botAccountId);

        if (content && content.trim().length > 0) {
          messages.push({
            role: isBot ? 'assistant' : 'user',
            content: content,
          });
        }
      }

      console.log(`[Mentions] Loaded ${messages.length} ancestor messages from thread`);
    } catch (error) {
      console.error('[Mentions] Error fetching conversation context:', error);
      // Continue without context if fetch fails
    }
  }

  return messages;
}

/**
 * Clean response text
 */
function cleanResponse(text: string): string {
  // Remove any [TITLE]...[/TITLE] tags that might be in the response
  text = text.replace(/\[TITLE\].*?\[\/TITLE\]/gs, '');

  // Remove other special tags that don't make sense in Mastodon
  text = text.replace(/\[TGIMAGE[^\]]*\]/g, '');
  text = text.replace(/\[TGDOC[^\]]*\]/g, '');
  text = text.replace(/\[TGLINKS[^\]]*\].*?\[\/TGLINKS\]/gs, '');
  text = text.replace(/\[REACT:[^\]]*\]/g, '');

  // Clean up extra whitespace and newlines
  text = text.replace(/\n\n\n+/g, '\n\n'); // Max 2 consecutive newlines
  text = text.trim();

  return text;
}
