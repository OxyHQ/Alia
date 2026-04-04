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
      .replace(/\[(?:CLARITY_)?COMPACTLIST[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?COMPACTLIST\]\s*/g, '')
      .replace(/\[(?:CLARITY_)?BANNER[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?BANNER\]\s*/g, '')
      .replace(/\[(?:CLARITY_)?COMPARISON[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?COMPARISON\]\s*/g, '')
      .replace(/\[(?:CLARITY_)?TIMELINE[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?TIMELINE\]\s*/g, '')
      .replace(/\[(?:CLARITY_)?IMAGE[^\]]*\]/g, '')
      .replace(/\[(?:CLARITY_)?CREDIBILITY[^\]]*\]/g, '')
      .replace(/\[(?:CLARITY_)?TITLE[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?TITLE\]\s*/gi, '')
      .trim();
  } else {
    // platform === 'app'
    // Remove Telegram-specific tags (not supported in app)
    return content
      .replace(/\[(?:CLARITY_)?REACT:[^\]]+\]\s*/g, '')
      .replace(/\[(?:CLARITY_)?TGIMAGE[^\]]*\]\s*/g, '')
      .replace(/\[(?:CLARITY_)?TGLINKS[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?TGLINKS\]\s*/g, '')
      .replace(/\[(?:CLARITY_)?TGDOC[^\]]*\]\s*/g, '')
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
