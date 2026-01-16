/**
 * Message Processor - Platform-specific message processing
 *
 * Processes messages on the backend based on the requesting platform.
 * This ensures:
 * 1. Clients only receive relevant content (no unnecessary data transfer)
 * 2. AI prompts don't include irrelevant tags (saves tokens)
 * 3. Centralized processing logic
 */

export type Platform = 'app' | 'telegram';

/**
 * Process message content for a specific platform
 * Removes platform-incompatible tags
 */
export function processMessageForPlatform(content: string, platform: Platform): string {
  if (platform === 'telegram') {
    // Remove app-specific visual components (not supported in Telegram)
    return content
      .replace(/\[COMPACTLIST[^\]]*\][\s\S]*?\[\/COMPACTLIST\]\s*/g, '')
      .replace(/\[BANNER[^\]]*\][\s\S]*?\[\/BANNER\]\s*/g, '')
      .replace(/\[COMPARISON[^\]]*\][\s\S]*?\[\/COMPARISON\]\s*/g, '')
      .replace(/\[TIMELINE[^\]]*\][\s\S]*?\[\/TIMELINE\]\s*/g, '')
      .replace(/\[IMAGE[^\]]*\]/g, '')
      .replace(/\[CREDIBILITY[^\]]*\]/g, '')
      .replace(/\[TITLE\][^\]]*\[\/TITLE\]\s*/g, '')
      .trim();
  } else {
    // platform === 'app'
    // Remove Telegram-specific tags (not supported in app)
    return content
      .replace(/\[REACT:[^\]]+\]\s*/g, '')
      .replace(/\[TGIMAGE[^\]]*\]\s*/g, '')
      .replace(/\[TGLINKS[^\]]*\][\s\S]*?\[\/TGLINKS\]\s*/g, '')
      .replace(/\[TGDOC[^\]]*\]\s*/g, '')
      .trim();
  }
}

/**
 * Process an array of messages for a specific platform
 */
export function processMessagesForPlatform(
  messages: Array<{ role: string; content: string }>,
  platform: Platform
): Array<{ role: string; content: string }> {
  return messages.map(msg => ({
    ...msg,
    content: processMessageForPlatform(msg.content, platform)
  }));
}
