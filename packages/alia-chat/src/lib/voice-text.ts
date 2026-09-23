/**
 * Text in and out of a voice call, as pure functions: what of an answer is
 * ready to be spoken, how it is made speakable, and whether what the
 * microphone just heard was the person or the call's own voice.
 *
 * Imports nothing, so every rule here is asserted directly
 * (`tests/lib/voice-text.test.ts`) rather than through a hook.
 */

// ============== TITLE TAGS ==============

const TAG = String.raw`ALIA_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;

const TITLE_STRIP_RE = new RegExp(
  String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi',
);

const TITLE_PARTIAL_RE = new RegExp(
  String.raw`\[(${TAG})\].*?(\[\/\1\])?$|<(${TAG})>.*?(<\/\3>)?$`, 'si',
);

/**
 * A settled answer without the conversation-title tag a model may append.
 *
 * `trim: false` keeps surrounding whitespace, which the speech chunker needs:
 * a trailing space is how it knows a period ended a sentence.
 */
export function stripTitleTags(content: string, { trim = true }: { trim?: boolean } = {}): string {
  const stripped = content.replace(TITLE_STRIP_RE, '');
  return trim ? stripped.trim() : stripped;
}

/** The same, for an answer still streaming: an opened tag hides the rest. */
export function stripTitleTagsPartial(content: string, { trim = true }: { trim?: boolean } = {}): string {
  const stripped = content.replace(TITLE_STRIP_RE, '').replace(TITLE_PARTIAL_RE, '');
  return trim ? stripped.trim() : stripped;
}

// ============== SPEAKABLE TEXT ==============

/**
 * Markdown and links read aloud are noise ("asterisk asterisk", a URL spelled
 * out). The voice prompt asks for none, but a model does not always listen, and
 * an agent's own prompt may not ask at all — so the formatting is taken off
 * here, at the last moment, and the transcript on screen keeps it.
 */
export function toSpeakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A sentence ends at terminal punctuation followed by whitespace, or at a line
 * break. Requiring the whitespace is what keeps `3.5` and a half-streamed
 * `e.g` whole: until the next character arrives, the period might not be one.
 */
const SENTENCE_END = /[.!?…。！？]+["'”’)\]]*\s+|\n+/g;

/** Past this, a run with no sentence end is cut at a pause anyway. */
const MAX_RUN_CHARS = 280;
/** After the first, chunks gather sentences until this long: fewer, fuller requests. */
const MIN_CHUNK_CHARS = 80;

export interface SpeechChunks {
  /** Ready to synthesize, in order, already speakable. */
  readonly chunks: string[];
  /** Not yet ready: the caller keeps it and passes it again with more text. */
  readonly rest: string;
}

/**
 * Split what has streamed so far into what can be spoken now and what must
 * wait.
 *
 * The FIRST chunk of an answer is a single sentence, however short: time to
 * first sound is the latency a person feels. Later chunks gather sentences up
 * to `MIN_CHUNK_CHARS`, because each chunk is a synthesis request and playback
 * of the one before covers the wait for the next. `final` flushes everything.
 */
export function takeSpeechChunks(
  pending: string,
  { final, isFirst }: { final: boolean; isFirst: boolean },
): SpeechChunks {
  const sentences: string[] = [];
  let cursor = 0;
  for (const match of pending.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    sentences.push(pending.slice(cursor, end));
    cursor = end;
  }
  let rest = pending.slice(cursor);

  if (final) {
    if (rest.trim() !== '') sentences.push(rest);
    rest = '';
  } else if (rest.length > MAX_RUN_CHARS) {
    const window = rest.slice(0, MAX_RUN_CHARS);
    const pause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    const cut = pause > 0 ? pause + 2 : Math.max(window.lastIndexOf(' '), 1);
    sentences.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  const chunks: string[] = [];
  let gathering = '';
  for (const sentence of sentences) {
    gathering += sentence;
    const threshold = chunks.length === 0 && isFirst ? 1 : MIN_CHUNK_CHARS;
    if (gathering.trim().length >= threshold) {
      chunks.push(gathering);
      gathering = '';
    }
  }
  if (gathering !== '') {
    if (final) chunks.push(gathering);
    else rest = gathering + rest;
  }

  return {
    chunks: chunks.map(toSpeakableText).filter((chunk) => chunk !== ''),
    rest,
  };
}

// ============== BARGE-IN ==============

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

export function wordCount(text: string): number {
  return words(text).length;
}

/** How many of the most recent words decide whether the person is talking. */
const INTERRUPTION_WINDOW = 6;

/**
 * Whether what the microphone heard is the person talking over the answer,
 * rather than the answer coming back through it.
 *
 * Voice mode keeps listening while it speaks so a person can interrupt, and on
 * a laptop speaker the recognizer can hear the answer. Where the platform
 * cancels echo that never reaches here; where it does not, the words give it
 * away. `spoken` is everything the call has said this turn, and the transcript
 * of one session keeps the echo it already heard, so only the latest words
 * are judged, from the first one the call did not say: at least `minWords` of
 * them — and at least half — must be new. A single misheard word of echo is
 * not the person; two new words in a row are.
 */
export function isInterruption(heard: string, spoken: string, minWords: number): boolean {
  const said = new Set(words(spoken));
  const tail = words(heard).slice(-INTERRUPTION_WINDOW);
  // Judge from the first word the call did not say: echo before it is echo.
  const first = tail.findIndex((word) => !said.has(word));
  if (first < 0) return false;
  const candidate = tail.slice(first);
  const novel = candidate.filter((word) => !said.has(word)).length;
  return novel >= minWords && novel * 2 >= candidate.length;
}

/**
 * The person's words without the echo the same session heard before them:
 * leading words the call itself had just said are dropped.
 */
export function dropEchoPrefix(heard: string, spoken: string): string {
  const said = new Set(words(spoken));
  if (said.size === 0) return heard.trim();
  const tokens = heard.trim().split(/\s+/);
  let start = 0;
  while (start < tokens.length) {
    const normalized = words(tokens[start] ?? '');
    if (normalized.length === 0 || normalized.every((word) => said.has(word))) start += 1;
    else break;
  }
  return tokens.slice(start).join(' ');
}
