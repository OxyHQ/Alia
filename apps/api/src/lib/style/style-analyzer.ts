/**
 * Writing Style Heuristic Analyzer
 * Pure functions that analyze user messages and build a writing style profile.
 * No LLM calls — runs in O(n) time per message (~1-5ms).
 */

import {
  STYLE_MIN_MESSAGES,
  STYLE_RAW_ROLLING_WINDOW,
  type IWritingStyleProfile,
  type IWritingStyleRaw,
} from '../../models/user-memory.js';

// ── Stop words (EN + ES) ───────────────────────────────────────────────
const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'it',
  'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him',
  'his', 'she', 'her', 'they', 'them', 'their', 'this', 'that', 'these',
  'those', 'what', 'which', 'who', 'whom', 'am', 'also', 'get', 'got',
  'like', 'know', 'think', 'want', 'really', 'much', 'well',
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'en', 'con', 'por', 'para', 'es', 'son', 'fue', 'ser', 'estar',
  'tiene', 'hay', 'que', 'se', 'su', 'sus', 'al', 'lo', 'como', 'pero',
  'si', 'ya', 'yo', 'tu', 'mi', 'nos', 'le', 'les', 'me', 'te',
  'más', 'mas', 'muy', 'este', 'esta', 'esto', 'ese', 'esa', 'eso',
  'no', 'sí', 'también', 'porque', 'cuando', 'donde', 'qué', 'cómo',
  'todo', 'todos', 'toda', 'todas', 'otro', 'otra', 'otros', 'otras',
  'uno', 'dos', 'tres', 'bien', 'aquí', 'ahí', 'así', 'algo', 'nada',
]);

// ── Emoji regex ────────────────────────────────────────────────────────
const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu;

// ── Greeting patterns ──────────────────────────────────────────────────
const GREETING_PATTERNS: [RegExp, string][] = [
  [/^hey\b/i, 'Hey'],
  [/^hi\b/i, 'Hi'],
  [/^hello\b/i, 'Hello'],
  [/^good morning\b/i, 'Good morning'],
  [/^good afternoon\b/i, 'Good afternoon'],
  [/^good evening\b/i, 'Good evening'],
  [/^dear\b/i, 'Dear'],
  [/^hola\b/i, 'Hola'],
  [/^buenos días\b/i, 'Buenos días'],
  [/^buenas tardes\b/i, 'Buenas tardes'],
  [/^buenas noches\b/i, 'Buenas noches'],
  [/^buen día\b/i, 'Buen día'],
  [/^qué tal\b/i, 'Qué tal'],
  [/^saludos\b/i, 'Saludos'],
  [/^estimad[oa]\b/i, 'Estimado/a'],
  [/^querido[/a]?\b/i, 'Querido/a'],
  [/^what'?s up\b/i, "What's up"],
  [/^yo\b/i, 'Yo'],
  [/^sup\b/i, 'Sup'],
];

// ── Closing patterns ───────────────────────────────────────────────────
const CLOSING_PATTERNS: [RegExp, string][] = [
  [/\bbest\s*regards?\b/i, 'Best regards'],
  [/\bkind\s*regards?\b/i, 'Kind regards'],
  [/\bregards\b/i, 'Regards'],
  [/\bcheers\b/i, 'Cheers'],
  [/\bthanks\b/i, 'Thanks'],
  [/\bthank you\b/i, 'Thank you'],
  [/\bsincerely\b/i, 'Sincerely'],
  [/\bbest\b$/i, 'Best'],
  [/\btake care\b/i, 'Take care'],
  [/\bsaludos\b/i, 'Saludos'],
  [/\bun abrazo\b/i, 'Un abrazo'],
  [/\bgracias\b/i, 'Gracias'],
  [/\batentamente\b/i, 'Atentamente'],
  [/\bcordialmente\b/i, 'Cordialmente'],
  [/\bun saludo\b/i, 'Un saludo'],
];

// ── Language trigram profiles (simplified) ──────────────────────────────
const LANG_TRIGRAMS: Record<string, string[]> = {
  en: ['the', 'and', 'ing', 'tion', 'for', 'ent', 'ion', 'her', 'was', 'tha', 'ere', 'his', 'not', 'but', 'you'],
  es: ['que', 'los', 'las', 'por', 'con', 'una', 'del', 'est', 'ent', 'ión', 'ado', 'ara', 'cia', 'mos', 'com'],
  fr: ['les', 'des', 'que', 'ent', 'est', 'une', 'par', 'pas', 'ous', 'ait', 'eur', 'ion', 'ans', 'ont', 'ais'],
  pt: ['que', 'ção', 'dos', 'com', 'ent', 'ado', 'par', 'est', 'uma', 'não', 'são', 'mos', 'foi', 'tem', 'ele'],
  de: ['der', 'die', 'und', 'den', 'ein', 'das', 'ist', 'ich', 'cht', 'sch', 'ung', 'ber', 'ver', 'auf', 'eit'],
};

// ── Contraction indicators (informality markers) ───────────────────────
const CONTRACTIONS_RE = /\b(i'm|i've|i'll|i'd|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|couldn't|wouldn't|shouldn't|it's|that's|there's|here's|what's|who's|let's|we're|they're|you're|he's|she's|we've|they've|you've|we'll|they'll|you'll|we'd|they'd|you'd|gonna|wanna|gotta|kinda|sorta|ain't)\b/gi;

// ── Helper functions ───────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(EMOJI_RE, ' ')
    .replace(/[^\w\sáéíóúñüàèìòùâêîôûäëïöüç'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

function extractEmojis(text: string): string[] {
  return [...text.matchAll(EMOJI_RE)].map(m => m[0]);
}

function detectLanguage(text: string): string {
  const lower = text.toLowerCase();
  let bestLang = 'en';
  let bestScore = 0;

  for (const [lang, trigrams] of Object.entries(LANG_TRIGRAMS)) {
    let score = 0;
    for (const tri of trigrams) {
      const idx = lower.indexOf(tri);
      if (idx !== -1) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  return bestLang;
}

function estimateSyllables(word: string): number {
  const w = word.toLowerCase();
  if (w.length <= 3) return 1;
  let count = 0;
  const vowels = 'aeiouyáéíóúàèìòùâêîôûäëïöü';
  let prevVowel = false;
  for (const ch of w) {
    const isVowel = vowels.includes(ch);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }
  if (w.endsWith('e') && count > 1) count--;
  return Math.max(count, 1);
}

function pushRolling(arr: number[], value: number, maxLen: number): number[] {
  arr.push(value);
  if (arr.length > maxLen) {
    return arr.slice(arr.length - maxLen);
  }
  return arr;
}

function incrementMap(map: Record<string, number>, key: string, maxEntries: number): Record<string, number> {
  map[key] = (map[key] || 0) + 1;

  // Prune if exceeding max entries: remove lowest-count entries
  const keys = Object.keys(map);
  if (keys.length > maxEntries * 1.5) {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    const pruned: Record<string, number> = {};
    for (let i = 0; i < Math.min(maxEntries, entries.length); i++) {
      pruned[entries[i][0]] = entries[i][1];
    }
    return pruned;
  }

  return map;
}

function topEntries(map: Record<string, number> | null | undefined, n: number): string[] {
  if (!map) return [];
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── Default empty raw data ─────────────────────────────────────────────

function createEmptyRaw(): IWritingStyleRaw {
  return {
    sentenceLengths: [],
    messageLengths: [],
    wordFrequency: {},
    phraseFrequency: {},
    emojiCount: 0,
    exclamationCount: 0,
    ellipsisCount: 0,
    questionMarkCount: 0,
    totalMessages: 0,
    totalSentences: 0,
    totalWords: 0,
    greetingsFound: {},
    closingsFound: {},
    languageCounts: {},
    lowercaseMessages: 0,
  };
}

function createEmptyProfile(): IWritingStyleProfile {
  return {
    messagesAnalyzed: 0,
    isReady: false,
    lastAnalyzedAt: new Date(),

    vocabularyLevel: 'intermediate',
    commonWords: [],
    commonPhrases: [],
    jargonTerms: [],

    avgSentenceLength: 0,
    sentenceComplexity: 'moderate',
    avgMessageLength: 0,

    formality: 'neutral',
    toneDescriptors: [],

    usesEmoji: false,
    emojiFrequency: 'never',
    commonEmojis: [],
    usesExclamationMarks: false,
    usesEllipsis: false,
    capitalizationStyle: 'standard',

    greetingPatterns: [],
    closingPatterns: [],
    signOff: undefined,

    primaryLanguage: 'en',
    secondaryLanguages: [],
    codeSwitch: false,

    _raw: createEmptyRaw(),
  };
}

// ── Main analysis function ─────────────────────────────────────────────

/**
 * Analyze a single user message and return an updated writing style profile.
 * Pure function except for Date creation. ~1-5ms per call.
 */
export function analyzeMessage(
  message: string,
  currentProfile: IWritingStyleProfile | null,
): IWritingStyleProfile {
  const profile = currentProfile
    ? { ...currentProfile, _raw: { ...(currentProfile._raw || createEmptyRaw()) } }
    : createEmptyProfile();

  const raw = profile._raw;
  const trimmed = message.trim();
  if (trimmed.length < 3) return profile;

  // Skip messages that are just URLs or code blocks
  if (/^https?:\/\/\S+$/.test(trimmed)) return profile;
  if (/^```[\s\S]*```$/.test(trimmed)) return profile;

  // ── 1. Sentence tokenization ────────────────────────────────────
  const sentences = splitSentences(trimmed);
  const words = tokenizeWords(trimmed);

  raw.totalMessages++;
  raw.totalSentences += sentences.length;
  raw.totalWords += words.length;

  // ── 2. Sentence/message lengths ─────────────────────────────────
  for (const sentence of sentences) {
    const sentWords = tokenizeWords(sentence);
    raw.sentenceLengths = pushRolling(raw.sentenceLengths, sentWords.length, STYLE_RAW_ROLLING_WINDOW);
  }
  raw.messageLengths = pushRolling(raw.messageLengths, words.length, STYLE_RAW_ROLLING_WINDOW);

  // ── 3. Word frequency ───────────────────────────────────────────
  for (const word of words) {
    if (!STOP_WORDS.has(word) && word.length > 2) {
      raw.wordFrequency = incrementMap(raw.wordFrequency, word, 100);
    }
  }

  // ── 4. Phrase extraction (bigrams) ──────────────────────────────
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (!STOP_WORDS.has(words[i]) || !STOP_WORDS.has(words[i + 1])) {
      raw.phraseFrequency = incrementMap(raw.phraseFrequency, bigram, 50);
    }
  }

  // ── 5. Emoji detection ──────────────────────────────────────────
  const emojis = extractEmojis(trimmed);
  raw.emojiCount += emojis.length;

  // ── 6. Punctuation habits ───────────────────────────────────────
  raw.exclamationCount += (trimmed.match(/!/g) || []).length;
  raw.ellipsisCount += (trimmed.match(/\.{3}|…/g) || []).length;
  raw.questionMarkCount += (trimmed.match(/\?/g) || []).length;

  // ── 7. Capitalization ───────────────────────────────────────────
  const hasLetters = /[a-záéíóúñüàèìòùâêîôûäëïöüç]/i.test(trimmed);
  if (hasLetters && trimmed === trimmed.toLowerCase()) {
    raw.lowercaseMessages++;
  }

  // ── 8. Greeting detection ───────────────────────────────────────
  const firstLine = trimmed.split('\n')[0].trim();
  for (const [pattern, label] of GREETING_PATTERNS) {
    if (pattern.test(firstLine)) {
      raw.greetingsFound[label] = (raw.greetingsFound[label] || 0) + 1;
      break;
    }
  }

  // ── 9. Closing detection ────────────────────────────────────────
  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const lastLine = lines[lines.length - 1] || '';
  for (const [pattern, label] of CLOSING_PATTERNS) {
    if (pattern.test(lastLine)) {
      raw.closingsFound[label] = (raw.closingsFound[label] || 0) + 1;
      break;
    }
  }

  // ── 10. Language detection ──────────────────────────────────────
  if (words.length >= 3) {
    const lang = detectLanguage(trimmed);
    raw.languageCounts[lang] = (raw.languageCounts[lang] || 0) + 1;
  }

  // Update counters
  profile.messagesAnalyzed = raw.totalMessages;
  profile.isReady = raw.totalMessages >= STYLE_MIN_MESSAGES;
  profile.lastAnalyzedAt = new Date();

  // Derive display fields from raw data
  return deriveProfile(profile);
}

/**
 * Recompute all derived (display) fields from raw counters.
 */
export function deriveProfile(profile: IWritingStyleProfile): IWritingStyleProfile {
  const raw = profile._raw;
  if (!raw || raw.totalMessages === 0) return profile;

  // ── Averages ────────────────────────────────────────────────────
  profile.avgSentenceLength = Math.round(average(raw.sentenceLengths) * 10) / 10;
  profile.avgMessageLength = Math.round(average(raw.messageLengths) * 10) / 10;

  // ── Sentence complexity ─────────────────────────────────────────
  if (profile.avgSentenceLength <= 8) {
    profile.sentenceComplexity = 'simple';
  } else if (profile.avgSentenceLength <= 18) {
    profile.sentenceComplexity = 'moderate';
  } else {
    profile.sentenceComplexity = 'complex';
  }

  // ── Vocabulary level ────────────────────────────────────────────
  const topWords = topEntries(raw.wordFrequency, 50);
  if (topWords.length > 0) {
    const avgWordLen = topWords.reduce((sum, w) => sum + w.length, 0) / topWords.length;
    const avgSyllables = topWords.reduce((sum, w) => sum + estimateSyllables(w), 0) / topWords.length;

    if (avgSyllables >= 2.5 || avgWordLen >= 7) {
      profile.vocabularyLevel = 'advanced';
    } else if (avgSyllables >= 1.8 || avgWordLen >= 5.5) {
      profile.vocabularyLevel = 'intermediate';
    } else {
      profile.vocabularyLevel = 'basic';
    }
  }

  // ── Common words and phrases ────────────────────────────────────
  profile.commonWords = topEntries(raw.wordFrequency, 20);
  profile.commonPhrases = topEntries(raw.phraseFrequency, 10);

  // ── Emoji ───────────────────────────────────────────────────────
  const emojiRate = raw.emojiCount / raw.totalMessages;
  profile.usesEmoji = raw.emojiCount > 0;
  if (emojiRate === 0) profile.emojiFrequency = 'never';
  else if (emojiRate < 0.2) profile.emojiFrequency = 'rare';
  else if (emojiRate < 1) profile.emojiFrequency = 'moderate';
  else profile.emojiFrequency = 'frequent';

  // ── Punctuation ─────────────────────────────────────────────────
  profile.usesExclamationMarks = raw.exclamationCount / raw.totalMessages > 0.15;
  profile.usesEllipsis = raw.ellipsisCount / raw.totalMessages > 0.1;

  // ── Capitalization ──────────────────────────────────────────────
  const lowercaseRate = raw.lowercaseMessages / raw.totalMessages;
  if (lowercaseRate > 0.7) {
    profile.capitalizationStyle = 'all_lowercase';
  } else if (lowercaseRate > 0.3) {
    profile.capitalizationStyle = 'mixed';
  } else {
    profile.capitalizationStyle = 'standard';
  }

  // ── Greetings and closings ──────────────────────────────────────
  profile.greetingPatterns = topEntries(raw.greetingsFound, 5);
  profile.closingPatterns = topEntries(raw.closingsFound, 5);
  if (profile.closingPatterns.length > 0) {
    profile.signOff = profile.closingPatterns[0];
  }

  // ── Language ────────────────────────────────────────────────────
  const langEntries = Object.entries(raw.languageCounts || {}).sort((a, b) => b[1] - a[1]);
  if (langEntries.length > 0) {
    profile.primaryLanguage = langEntries[0][0];
    profile.secondaryLanguages = langEntries.slice(1).map(([lang]) => lang);
    // Code-switch if secondary languages make up > 15% of messages
    const total = langEntries.reduce((sum, [, count]) => sum + count, 0);
    const secondaryCount = total - langEntries[0][1];
    profile.codeSwitch = secondaryCount / total > 0.15;
  }

  // ── Formality ───────────────────────────────────────────────────
  let formalityScore = 50; // 0=very informal, 100=very formal

  // Contractions lower formality
  const avgContractions = (() => {
    // Sample from recent raw data: approximate from word patterns
    const contractionWords = profile.commonWords.filter(w =>
      /n't$|'m$|'re$|'ve$|'ll$|'d$|'s$/.test(w)
    );
    return contractionWords.length;
  })();
  formalityScore -= avgContractions * 5;

  // All lowercase lowers formality
  if (profile.capitalizationStyle === 'all_lowercase') formalityScore -= 15;
  if (profile.capitalizationStyle === 'mixed') formalityScore -= 5;

  // Emoji lowers formality
  if (profile.emojiFrequency === 'frequent') formalityScore -= 15;
  else if (profile.emojiFrequency === 'moderate') formalityScore -= 8;

  // Short sentences suggest informality
  if (profile.avgSentenceLength < 6) formalityScore -= 10;
  else if (profile.avgSentenceLength > 15) formalityScore += 10;

  // Formal greetings increase score
  const formalGreetings = ['Dear', 'Estimado/a', 'Good morning', 'Good afternoon', 'Buenos días'];
  const informalGreetings = ['Hey', 'Yo', 'Sup', "What's up", 'Qué tal'];
  for (const g of profile.greetingPatterns) {
    if (formalGreetings.includes(g)) formalityScore += 8;
    if (informalGreetings.includes(g)) formalityScore -= 8;
  }

  // Exclamation marks lower formality slightly
  if (profile.usesExclamationMarks) formalityScore -= 5;

  // Clamp and map to categories
  formalityScore = Math.max(0, Math.min(100, formalityScore));
  if (formalityScore <= 20) profile.formality = 'very_informal';
  else if (formalityScore <= 40) profile.formality = 'informal';
  else if (formalityScore <= 60) profile.formality = 'neutral';
  else if (formalityScore <= 80) profile.formality = 'formal';
  else profile.formality = 'very_formal';

  return profile;
}
