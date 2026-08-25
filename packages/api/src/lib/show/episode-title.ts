/**
 * What counts as a usable episode title, whatever a model actually replied.
 *
 * ## Naming an episode after it exists, not before
 *
 * The title used to be decided in the route, from the topic, before a word of
 * the episode was written — and it was decided there because Syra forced it:
 * `POST /:id/episodes/draft` requires `title`, and the ingest allowlist refused
 * one, so a name written later could never reach the published episode. The
 * ingest now accepts a title, which removes the constraint, so the name comes
 * off the finished script: the script model returns it as the last field it
 * writes, having produced the dialogue it is naming.
 *
 * That leaves this module with the half worth keeping. A model asked for a
 * title answers the instruction as well as obeying it — `Title: "Whatever"`,
 * with a full stop, sometimes three candidates on three lines — and none of
 * those shapes is observable through a live call. They are all cheap to assert
 * here.
 *
 * ## Nothing here is load-bearing
 *
 * `null` is a normal answer. The route inserted `Episode {n}` before the draft
 * was reserved, so an episode whose title cannot be read out of its script
 * keeps that: plain, true, and never a mangled paragraph. An episode with a
 * plain name is an episode.
 */

/** Matches `show_episodes.title` and Syra's own field; a longer one is refused. */
const MAX_TITLE_LENGTH = 200;

/**
 * Turn whatever a model returned into a usable title, or `null`.
 */
export function cleanTitle(raw: string): string | null {
  let title = raw.trim();

  // Models answer the instruction as well as obeying it, routinely.
  title = title.replace(/^(?:title|episode title)\s*:\s*/i, '');
  // Surrounding quotes of every kind a model reaches for.
  title = title.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '');
  // A title is not a sentence, but keep a question mark or an exclamation —
  // those are titles ("Is anything real?"), a full stop is a sentence.
  title = title.replace(/\.+$/, '');
  title = title.trim();

  if (title === '') return null;
  // A reply this long is an explanation, not a title. Truncating it would store
  // a mangled paragraph; refusing it lets the caller keep the placeholder,
  // which is at least true.
  if (title.length > MAX_TITLE_LENGTH) return null;
  // A newline means several candidates or a preamble. Take the first non-empty
  // line rather than the whole block.
  const [firstLine] = title.split('\n');
  const line = firstLine?.trim() ?? '';
  return line === '' ? null : line;
}
