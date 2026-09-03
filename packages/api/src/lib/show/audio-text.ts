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
