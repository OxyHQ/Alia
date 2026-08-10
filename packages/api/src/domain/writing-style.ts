/**
 * The analysed writing-style profile, and the thresholds that drive it.
 *
 * These lived in `models/user-memory.ts` alongside the Mongoose model, which is
 * why `lib/style/style-analyzer.ts`, `style-prompt.ts` and `style-refiner.ts`
 * imported a MODEL module while never touching the model. Nothing here is a
 * storage concern: `user_memories.writing_style` is `jsonb`, and this is the
 * shape the application puts in and takes out.
 */

// When a profile becomes usable, and how often the LLM refines it.
export const STYLE_MIN_MESSAGES = 15;
export const STYLE_LLM_REFINE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const STYLE_LLM_REFINE_MIN_MESSAGES = 50;
export const STYLE_RAW_ROLLING_WINDOW = 200;

/**
 * The raw counters the analyser accumulates.
 *
 * `wordFrequency` and `phraseFrequency` are keyed by the USER'S OWN words, so
 * the key set is unbounded and different for every account. That, plus the fact
 * that nothing queries a sub-field, is why the column is `jsonb` rather than a
 * set of columns — see `db/schema/memory.ts`.
 */
export interface IWritingStyleRaw {
  sentenceLengths: number[];
  messageLengths: number[];
  wordFrequency: Record<string, number>;
  phraseFrequency: Record<string, number>;
  emojiCount: number;
  exclamationCount: number;
  ellipsisCount: number;
  questionMarkCount: number;
  totalMessages: number;
  totalSentences: number;
  totalWords: number;
  greetingsFound: Record<string, number>;
  closingsFound: Record<string, number>;
  languageCounts: Record<string, number>;
  lowercaseMessages: number;
}

export interface IWritingStyleProfile {
  // Readiness
  messagesAnalyzed: number;
  isReady: boolean;
  lastAnalyzedAt: Date;
  lastLLMRefinedAt?: Date;

  // Vocabulary
  vocabularyLevel: 'basic' | 'intermediate' | 'advanced' | 'technical';
  commonWords: string[];
  commonPhrases: string[];
  jargonTerms: string[];

  // Sentence structure
  avgSentenceLength: number;
  sentenceComplexity: 'simple' | 'moderate' | 'complex';
  avgMessageLength: number;

  // Tone and formality
  formality: 'very_informal' | 'informal' | 'neutral' | 'formal' | 'very_formal';
  toneDescriptors: string[];

  // Punctuation and formatting
  usesEmoji: boolean;
  emojiFrequency: 'never' | 'rare' | 'moderate' | 'frequent';
  commonEmojis: string[];
  usesExclamationMarks: boolean;
  usesEllipsis: boolean;
  capitalizationStyle: 'standard' | 'all_lowercase' | 'mixed';

  // Greetings and closings
  greetingPatterns: string[];
  closingPatterns: string[];
  signOff?: string;

  // Language
  primaryLanguage: string;
  secondaryLanguages: string[];
  codeSwitch: boolean;

  // Raw analysis data
  _raw: IWritingStyleRaw;

  // LLM-generated summary
  llmSummary?: string;
}
