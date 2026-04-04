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
  // Remove Telegram-specific tags and title tags
  const cleanedText = content
    .replace(/\[(?:CLARITY_)?REACT:[^\]]+\]\s*/g, '')
    .replace(/\[(?:CLARITY_)?TGIMAGE[^\]]*\]\s*/g, '')
    .replace(/\[(?:CLARITY_)?TGLINKS[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?TGLINKS\]\s*/g, '')
    .replace(/\[(?:CLARITY_)?TGDOC[^\]]*\]\s*/g, '')
    .replace(TITLE_STRIP_RE, '')
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
    .replace(/\[(?:CLARITY_)?COMPACTLIST[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?COMPACTLIST\]\s*/g, '')
    .replace(/\[(?:CLARITY_)?BANNER[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?BANNER\]\s*/g, '')
    .replace(/\[(?:CLARITY_)?COMPARISON[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?COMPARISON\]\s*/g, '')
    .replace(/\[(?:CLARITY_)?TIMELINE[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?TIMELINE\]\s*/g, '')
    .replace(/\[(?:CLARITY_)?IMAGE[^\]]*\]/g, '')
    .replace(/\[(?:CLARITY_)?CREDIBILITY[^\]]*\]/g, '')
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
          .replace(/\[(?:CLARITY_)?REACT:[^\]]+\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?TGIMAGE[^\]]*\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?TGLINKS[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?TGLINKS\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?TGDOC[^\]]*\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?COMPACTLIST[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?COMPACTLIST\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?BANNER[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?BANNER\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?COMPARISON[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?COMPARISON\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?TIMELINE[^\]]*\][\s\S]*?\[\/(?:CLARITY_)?TIMELINE\]\s*/g, '')
          .replace(/\[(?:CLARITY_)?IMAGE[^\]]*\]/g, '')
          .replace(/\[(?:CLARITY_)?CREDIBILITY[^\]]*\]/g, '')
          .replace(TITLE_STRIP_RE, '')
          .trim(),
      };
  }
}
