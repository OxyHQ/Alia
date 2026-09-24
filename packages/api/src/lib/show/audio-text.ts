/**
 * Audio-stage directions supported by the show script contract.
 *
 * This is product prompt vocabulary, not provider routing. Kaana decides how a
 * hosted speech implementation renders the text when that capability lands.
 */
export const PERFORMABLE_AUDIO_TAGS: ReadonlySet<string> = new Set([
  'laughs',
  'whispers',
  'sighs',
  'sarcastic',
  'excited',
  'crying',
  'applause',
]);

/**
 * Remove stage directions a speech target cannot perform and normalize the
 * punctuation left behind. Callers supply the capability; this module does not
 * select a provider or inspect a credential.
 */
export function speakableText(text: string, options: { readonly audioTags: boolean }): string {
  const spoken = text
    .replace(/\[[^\]\n]*\]|[[\]]/g, (match) => {
      if (!options.audioTags) return '';
      const tag = match.slice(1, -1).trim().toLowerCase();
      return PERFORMABLE_AUDIO_TAGS.has(tag) ? `[${tag}]` : '';
    })
    .replace(/[ \t]+([,.;:!?…])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s,.;:…]+/, '')
    .trim();

  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : '';
}

/**
 * The most text one speech request may carry, in UTF-16 code units — the unit
 * Oxy and Kaana both measure (`String.prototype.length`). Kaana refuses a
 * longer input outright rather than truncating it.
 */
export const MAX_SPEECH_INPUT_CHARS = 15_000;

/**
 * Split `text` into pieces no longer than `max`, on sentence boundaries where
 * it can, then on whitespace, and only as a last resort mid-word (never inside
 * a surrogate pair). A show's dialogue lines are asked to be 80 words at most,
 * so this almost always answers `[text]`; it exists because the prompt is a
 * request and the ceiling is not.
 */
export function splitForSpeech(text: string, max: number = MAX_SPEECH_INPUT_CHARS): string[] {
  if (text.length <= max) return text.length === 0 ? [] : [text];

  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed !== '') pieces.push(trimmed);
    current = '';
  };

  for (const sentence of text.split(/(?<=[.!?…。！？])\s+/u)) {
    if (sentence.length > max) {
      flush();
      for (const word of hardSplit(sentence, max)) {
        if (current.length + word.length + 1 > max) flush();
        current = current === '' ? word : `${current} ${word}`;
      }
      continue;
    }
    if (current.length + sentence.length + 1 > max) flush();
    current = current === '' ? sentence : `${current} ${sentence}`;
  }
  flush();
  return pieces;
}

/** Words, with any single word longer than `max` cut at safe code-unit offsets. */
function hardSplit(sentence: string, max: number): string[] {
  const out: string[] = [];
  for (const word of sentence.split(/\s+/u)) {
    let rest = word;
    while (rest.length > max) {
      let cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest !== '') out.push(rest);
  }
  return out;
}
