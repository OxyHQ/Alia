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
      .replace(/\[(?:ALIA_)?COMPACTLIST[^\]]*\][\s\S]*?\[\/(?:ALIA_)?COMPACTLIST\]\s*/g, '')
      .replace(/\[(?:ALIA_)?BANNER[^\]]*\][\s\S]*?\[\/(?:ALIA_)?BANNER\]\s*/g, '')
      .replace(/\[(?:ALIA_)?COMPARISON[^\]]*\][\s\S]*?\[\/(?:ALIA_)?COMPARISON\]\s*/g, '')
      .replace(/\[(?:ALIA_)?TIMELINE[^\]]*\][\s\S]*?\[\/(?:ALIA_)?TIMELINE\]\s*/g, '')
      .replace(/\[(?:ALIA_)?IMAGE[^\]]*\]/g, '')
      .replace(/\[(?:ALIA_)?CREDIBILITY[^\]]*\]/g, '')
      .replace(/\[(?:ALIA_)?TITLE[^\]]*\][\s\S]*?\[\/(?:ALIA_)?TITLE\]\s*/gi, '')
      .trim();
  } else {
    // platform === 'app'
    // Remove Telegram-specific tags (not supported in app)
    return content
      .replace(/\[(?:ALIA_)?REACT:[^\]]+\]\s*/g, '')
      .replace(/\[(?:ALIA_)?TGIMAGE[^\]]*\]\s*/g, '')
      .replace(/\[(?:ALIA_)?TGLINKS[^\]]*\][\s\S]*?\[\/(?:ALIA_)?TGLINKS\]\s*/g, '')
      .replace(/\[(?:ALIA_)?TGDOC[^\]]*\]\s*/g, '')
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
