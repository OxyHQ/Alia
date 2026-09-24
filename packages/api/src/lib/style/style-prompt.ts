/**
 * Writing Style Prompt Formatter
 * Converts a writing style profile into a system prompt section
 * for use when Alia composes on behalf of the user.
 */

import type { IWritingStyleProfile } from '../../domain/writing-style.js';

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
 * The most this block may add to a system message, in characters.
 *
 * It is appended to EVERY turn of a person who has a ready profile, so it is
 * paid for on every turn. Several of its fields are unbounded — `llmSummary` is
 * free model output, and `PUT /writing-style` accepts arrays and a sign-off of
 * any length — so without a ceiling one long edit would tax every later turn.
 * ~2000 characters is roughly 500 tokens.
 */
export const STYLE_PROMPT_MAX_CHARS = 2000;

/** Longest a single user-editable value may be before it is cut. */
const STYLE_FIELD_MAX_CHARS = 200;

const HEADER = [
  '## USER\'S WRITING STYLE',
  '',
  'When writing ON BEHALF of this user (composing emails, messages, replies, or drafts), match these patterns:',
  '',
];

const FOOTER = [
  '',
  'IMPORTANT: Only apply this style when composing text that will be sent AS the user (emails, messages, replies). For your own responses to the user, use your normal Alia style.',
];

function clip(value: string, max = STYLE_FIELD_MAX_CHARS): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clipList(values: readonly string[] | undefined, count: number): string[] {
  return (values ?? []).slice(0, count).map((v) => clip(String(v)));
}

/**
 * Format the writing style profile into a prompt block.
 * Returns empty string if profile is not ready.
 *
 * The result never exceeds {@link STYLE_PROMPT_MAX_CHARS}: body lines are
 * dropped from the END (the least essential ones — tone, summary) until it
 * fits, and the header and the "only when writing AS the user" footer are
 * always kept, because a style block without that footer would restyle Alia's
 * own answers.
 */
export function formatStyleForPrompt(profile: IWritingStyleProfile | null | undefined): string {
  if (!profile || !profile.isReady) return '';

  const lines: string[] = [];

  // Formality
  lines.push(`- **Formality**: ${FORMALITY_LABELS[profile.formality] || profile.formality}`);

  // Sentence structure
  lines.push(`- **Sentences**: Typically ${COMPLEXITY_LABELS[profile.sentenceComplexity] || profile.sentenceComplexity} (~${Math.round(profile.avgSentenceLength)} words per sentence)`);

  // Vocabulary
  lines.push(`- **Vocabulary**: ${profile.vocabularyLevel} level`);
  if ((profile.commonWords ?? []).length > 0) {
    lines.push(`- **Characteristic words**: ${clipList(profile.commonWords, 10).join(', ')}`);
  }

  // Capitalization
  lines.push(`- **Capitalization**: ${CAP_LABELS[profile.capitalizationStyle] || profile.capitalizationStyle}`);

  // Emoji
  lines.push(`- **Emoji**: ${EMOJI_LABELS[profile.emojiFrequency] || profile.emojiFrequency}`);
  if ((profile.commonEmojis ?? []).length > 0) {
    lines.push(`  Common emoji: ${clipList(profile.commonEmojis, 5).join(' ')}`);
  }

  // Exclamation / ellipsis
  if (profile.usesExclamationMarks) {
    lines.push('- Uses exclamation marks frequently');
  }
  if (profile.usesEllipsis) {
    lines.push('- Uses ellipsis (...) in writing');
  }

  // Greetings
  if ((profile.greetingPatterns ?? []).length > 0) {
    lines.push(`- **Typical greetings**: ${clipList(profile.greetingPatterns, 5).join(', ')}`);
  }

  // Closings / sign-off
  if ((profile.closingPatterns ?? []).length > 0) {
    lines.push(`- **Typical closings**: ${clipList(profile.closingPatterns, 5).join(', ')}`);
  }
  if (profile.signOff) {
    lines.push(`- **Preferred sign-off**: "${clip(profile.signOff)}"`);
  }

  // Language
  if (profile.primaryLanguage) {
    let langLine = `- **Primary language**: ${clip(profile.primaryLanguage)}`;
    if ((profile.secondaryLanguages ?? []).length > 0) {
      langLine += `, also uses ${clipList(profile.secondaryLanguages, 5).join(', ')}`;
    }
    if (profile.codeSwitch) {
      langLine += ' (sometimes mixes languages)';
    }
    lines.push(langLine);
  }

  // Tone descriptors (from LLM refinement)
  if ((profile.toneDescriptors ?? []).length > 0) {
    lines.push(`- **Tone**: ${clipList(profile.toneDescriptors, 8).join(', ')}`);
  }

  // LLM summary
  if (profile.llmSummary) {
    lines.push('');
    lines.push(`**Style summary**: "${clip(profile.llmSummary, 600)}"`);
  }

  const assemble = (body: readonly string[]) => [...HEADER, ...body, ...FOOTER].join('\n');
  let body = lines;
  while (body.length > 0 && assemble(body).length > STYLE_PROMPT_MAX_CHARS) {
    body = body.slice(0, -1);
  }
  // Nothing of the profile survived the budget: say nothing rather than a
  // header that promises a style and describes none.
  if (body.filter((l) => l !== '').length === 0) return '';
  return assemble(body);
}
