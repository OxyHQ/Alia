import mongoose, { Schema, Model, Document } from 'mongoose';

// Validation constants
export const MAX_MEMORIES_FREE = 100;
export const MAX_MEMORIES_PRO = 1000;
export const MAX_MEMORIES_BUSINESS = -1; // Unlimited
export const MAX_MEMORY_VALUE_LENGTH = 10000;
export const MAX_MEMORY_KEY_LENGTH = 200;
export const MAX_CATEGORY_LENGTH = 50;

// Writing style constants
export const STYLE_MIN_MESSAGES = 15;
export const STYLE_LLM_REFINE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const STYLE_LLM_REFINE_MIN_MESSAGES = 50;
export const STYLE_RAW_ROLLING_WINDOW = 200;

// Writing style profile interface
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

// Helper to get memory limit based on plan name
export const getMemoryLimit = (planName?: string): number => {
  if (!planName) return MAX_MEMORIES_FREE;

  const plan = planName.toLowerCase();
  if (plan.includes('business') || plan.includes('enterprise')) {
    return MAX_MEMORIES_BUSINESS; // Unlimited
  }
  if (plan.includes('pro')) {
    return MAX_MEMORIES_PRO;
  }

  return MAX_MEMORIES_FREE;
};

export interface IUserMemory extends Document {
  oxyUserId: mongoose.Types.ObjectId;
  memories: {
    key: string;
    value: string;
    category?: string;
    createdAt: Date;
    updatedAt: Date;
  }[];
  preferences: {
    language?: string;
    tone?: string;
    responseLength?: 'short' | 'medium' | 'long';
    interests?: string[];
    [key: string]: any;
  };
  context: {
    occupation?: string;
    location?: string;
    timezone?: string;
    bio?: string;
    [key: string]: any;
  };
  writingStyle: IWritingStyleProfile | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserMemorySchema = new Schema<IUserMemory>({
  oxyUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  memories: [{
    key: { type: String, required: true },
    value: { type: String, required: true },
    category: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  }],
  preferences: {
    language: { type: String },
    tone: { type: String },
    responseLength: { type: String, enum: ['short', 'medium', 'long'] },
    interests: [{ type: String }]
  },
  context: {
    occupation: { type: String },
    location: { type: String },
    timezone: { type: String },
    bio: { type: String }
  },
  writingStyle: {
    type: Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true
});

// Performance indexes
// Text index for full-text search on memory keys and values
UserMemorySchema.index({ 'memories.key': 'text', 'memories.value': 'text' });

// Category index for filtering
UserMemorySchema.index({ 'memories.category': 1 });

// Timestamp index for sorting
UserMemorySchema.index({ 'memories.updatedAt': -1 });

export const UserMemory: Model<IUserMemory> =
  mongoose.models.UserMemory || mongoose.model<IUserMemory>('UserMemory', UserMemorySchema);
