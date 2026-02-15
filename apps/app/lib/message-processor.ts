/**
 * Message Processor - Platform-specific message processing
 *
 * This module handles platform-specific processing of AI responses.
 * Different platforms (Web/Mobile App vs Telegram) have different capabilities,
 * so we process messages differently for each.
 */

import { TITLE_STRIP_RE } from './utils/title-tags';

export type Platform = 'app' | 'telegram';

export interface ProcessedMessage {
  text: string;
  components?: any[]; // Visual components for the app (COMPACTLIST, BANNER, etc.)
  metadata?: Record<string, any>;
}

/**
 * Process a message for the Web/Mobile App
 * - Removes Telegram-specific tags ([REACT], [TGIMAGE], [TGLINKS], [TGDOC])
 * - Preserves app-specific components ([COMPACTLIST], [BANNER], [COMPARISON], etc.)
 */
function processForApp(content: string): ProcessedMessage {
  // Remove Telegram-specific tags
  const cleanedText = content
    .replace(/\[REACT:[^\]]+\]\s*/g, '')
    .replace(/\[TGIMAGE[^\]]*\]\s*/g, '')
    .replace(/\[TGLINKS[^\]]*\][\s\S]*?\[\/TGLINKS\]\s*/g, '')
    .replace(/\[TGDOC[^\]]*\]\s*/g, '')
    .trim();

  // App-specific components like [COMPACTLIST], [BANNER], etc. are kept
  // They will be rendered by the Markdown component
  return {
    text: cleanedText,
    components: [], // Could extract components here if needed
  };
}

/**
 * Process a message for Telegram
 * - Removes app-specific components ([COMPACTLIST], [BANNER], etc.)
 * - Preserves Telegram-specific tags for bot processing
 */
function processForTelegram(content: string): ProcessedMessage {
  // Remove app-specific visual components (not supported in Telegram)
  const cleanedText = content
    .replace(/\[COMPACTLIST[^\]]*\][\s\S]*?\[\/COMPACTLIST\]\s*/g, '')
    .replace(/\[BANNER[^\]]*\][\s\S]*?\[\/BANNER\]\s*/g, '')
    .replace(/\[COMPARISON[^\]]*\][\s\S]*?\[\/COMPARISON\]\s*/g, '')
    .replace(/\[TIMELINE[^\]]*\][\s\S]*?\[\/TIMELINE\]\s*/g, '')
    .replace(/\[IMAGE[^\]]*\]/g, '')
    .replace(/\[CREDIBILITY[^\]]*\]/g, '')
    .replace(TITLE_STRIP_RE, '')
    .trim();

  // Telegram tags like [REACT], [TGIMAGE], etc. are kept
  // They will be processed by the Telegram bot
  return {
    text: cleanedText,
  };
}

/**
 * Main message processor - Routes to platform-specific processor
 */
export function processMessage(content: string, platform: Platform): ProcessedMessage {
  switch (platform) {
    case 'app':
      return processForApp(content);
    case 'telegram':
      return processForTelegram(content);
    default:
      // Fallback: remove all special tags
      return {
        text: content
          .replace(/\[REACT:[^\]]+\]\s*/g, '')
          .replace(/\[TGIMAGE[^\]]*\]\s*/g, '')
          .replace(/\[TGLINKS[^\]]*\][\s\S]*?\[\/TGLINKS\]\s*/g, '')
          .replace(/\[TGDOC[^\]]*\]\s*/g, '')
          .replace(/\[COMPACTLIST[^\]]*\][\s\S]*?\[\/COMPACTLIST\]\s*/g, '')
          .replace(/\[BANNER[^\]]*\][\s\S]*?\[\/BANNER\]\s*/g, '')
          .replace(/\[COMPARISON[^\]]*\][\s\S]*?\[\/COMPARISON\]\s*/g, '')
          .replace(/\[TIMELINE[^\]]*\][\s\S]*?\[\/TIMELINE\]\s*/g, '')
          .replace(/\[IMAGE[^\]]*\]/g, '')
          .replace(/\[CREDIBILITY[^\]]*\]/g, '')
          .replace(TITLE_STRIP_RE, '')
          .trim(),
      };
  }
}
