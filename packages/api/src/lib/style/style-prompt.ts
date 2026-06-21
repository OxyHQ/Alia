/**
 * Writing Style Prompt Formatter
 * Converts a writing style profile into a system prompt section
 * for use when Alia composes on behalf of the user.
 */

import type { IWritingStyleProfile } from '../../models/user-memory.js';

const FORMALITY_LABELS: Record<string, string> = {
  very_informal: 'Very informal and casual',
  informal: 'Informal and relaxed',
  neutral: 'Neutral',
  formal: 'Formal and professional',
  very_formal: 'Very formal and polished',
};

const COMPLEXITY_LABELS: Record<string, string> = {
  simple: 'short and simple',
  moderate: 'moderate length',
  complex: 'long and complex',
};

const EMOJI_LABELS: Record<string, string> = {
  never: 'Does not use emoji',
  rare: 'Rarely uses emoji',
  moderate: 'Sometimes uses emoji',
  frequent: 'Frequently uses emoji',
};

const CAP_LABELS: Record<string, string> = {
  standard: 'Standard capitalization',
  all_lowercase: 'Writes mostly in lowercase',
  mixed: 'Mixed capitalization (sometimes all lowercase)',
};

/**
 * Format the writing style profile into a prompt block.
 * Returns empty string if profile is not ready.
 */
export function formatStyleForPrompt(profile: IWritingStyleProfile | null): string {
  if (!profile || !profile.isReady) return '';

  const lines: string[] = [];

  lines.push('## USER\'S WRITING STYLE');
  lines.push('');
  lines.push('When writing ON BEHALF of this user (composing emails, messages, replies, or drafts), match these patterns:');
  lines.push('');

  // Formality
  lines.push(`- **Formality**: ${FORMALITY_LABELS[profile.formality] || profile.formality}`);

  // Sentence structure
  lines.push(`- **Sentences**: Typically ${COMPLEXITY_LABELS[profile.sentenceComplexity] || profile.sentenceComplexity} (~${Math.round(profile.avgSentenceLength)} words per sentence)`);

  // Vocabulary
  lines.push(`- **Vocabulary**: ${profile.vocabularyLevel} level`);
  if (profile.commonWords.length > 0) {
    lines.push(`- **Characteristic words**: ${profile.commonWords.slice(0, 10).join(', ')}`);
  }

  // Capitalization
  lines.push(`- **Capitalization**: ${CAP_LABELS[profile.capitalizationStyle] || profile.capitalizationStyle}`);

  // Emoji
  lines.push(`- **Emoji**: ${EMOJI_LABELS[profile.emojiFrequency] || profile.emojiFrequency}`);
  if (profile.commonEmojis.length > 0) {
    lines.push(`  Common emoji: ${profile.commonEmojis.slice(0, 5).join(' ')}`);
  }

  // Exclamation / ellipsis
  if (profile.usesExclamationMarks) {
    lines.push('- Uses exclamation marks frequently');
  }
  if (profile.usesEllipsis) {
    lines.push('- Uses ellipsis (...) in writing');
  }

  // Greetings
  if (profile.greetingPatterns.length > 0) {
    lines.push(`- **Typical greetings**: ${profile.greetingPatterns.join(', ')}`);
  }

  // Closings / sign-off
  if (profile.closingPatterns.length > 0) {
    lines.push(`- **Typical closings**: ${profile.closingPatterns.join(', ')}`);
  }
  if (profile.signOff) {
    lines.push(`- **Preferred sign-off**: "${profile.signOff}"`);
  }

  // Language
  if (profile.primaryLanguage) {
    let langLine = `- **Primary language**: ${profile.primaryLanguage}`;
    if (profile.secondaryLanguages.length > 0) {
      langLine += `, also uses ${profile.secondaryLanguages.join(', ')}`;
    }
    if (profile.codeSwitch) {
      langLine += ' (sometimes mixes languages)';
    }
    lines.push(langLine);
  }

  // Tone descriptors (from LLM refinement)
  if (profile.toneDescriptors.length > 0) {
    lines.push(`- **Tone**: ${profile.toneDescriptors.join(', ')}`);
  }

  // LLM summary
  if (profile.llmSummary) {
    lines.push('');
    lines.push(`**Style summary**: "${profile.llmSummary}"`);
  }

  lines.push('');
  lines.push('IMPORTANT: Only apply this style when composing text that will be sent AS the user (emails, messages, replies). For your own responses to the user, use your normal Alia style.');

  return lines.join('\n');
}
