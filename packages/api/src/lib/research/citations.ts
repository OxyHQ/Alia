/**
 * Citation markers — one well-formed shape for the `[n]` the report carries.
 *
 * The synthesis model is asked for `[1]`, `[2]` and often writes something
 * else: the `【1†L1-L3】` form some providers use for their own retrieval tools,
 * comma lists like `[1, 2]`, and numbers that never had a source because the
 * model counted its own findings rather than the tracker (#540). The app turns
 * `[n]` into a link when `n` names a known source, so every other spelling is
 * a marker the reader sees raw.
 *
 * The app carries a twin of this function (`packages/app/lib/citations.ts`)
 * for messages persisted before the API normalised its output. The two must
 * agree; the app's tests pin the same cases.
 */

/** `【1†L1-L3】`, `【5†source】`, `【7】` — the bracketed form with an optional `†` tail. */
const FULLWIDTH_MARKER_RE = /【\s*(\d{1,3})\s*(?:†[^】]*)?】/g;
/** `[1†L1-L3]` — the same tail inside ASCII brackets. */
const ASCII_DAGGER_MARKER_RE = /\[(\d{1,3})†[^\]]*\]/g;
/** `[1, 2]`, `[1,2,3]` — a comma list that should be one marker per source. */
const COMMA_LIST_RE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})+)\](?![(:])/g;
/**
 * A single `[n]` that is a citation and not something else in square
 * brackets: not a link (`[1](url)`), not a reference-style definition
 * (`[1]: url`). `[2024]` is out of range and never touched.
 */
const SINGLE_MARKER_RE = /\[(\d{1,3})\](?![(:])/g;

/**
 * Rewrite every citation marker in `text` into the `[n]` form the app links.
 *
 * With `knownIds`, a marker whose number is not a source is REMOVED rather
 * than left as a dangling `[9]`: the report's references section is built from
 * the tracker, so a number outside it can never resolve to anything. Without
 * `knownIds` only the spelling is normalised, which is what a caller without
 * the source list (the app, for an old message) can do.
 */
export function normalizeCitationMarkers(text: string, knownIds?: Iterable<number>): string {
  const known = knownIds ? new Set(knownIds) : null;

  let out = text
    .replace(FULLWIDTH_MARKER_RE, '[$1]')
    .replace(ASCII_DAGGER_MARKER_RE, '[$1]')
    .replace(COMMA_LIST_RE, (_m, list: string) =>
      list.split(',').map((n) => `[${n.trim()}]`).join(''),
    );

  if (known && known.size > 0) {
    out = out.replace(SINGLE_MARKER_RE, (m, n: string) => (known.has(Number(n)) ? m : ''));
    // A dropped marker can leave "word ." or a doubled space behind it.
    out = out.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }

  return out;
}

/** The distinct source numbers a text cites, in order of first appearance. */
export function citedIds(text: string): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const m of normalizeCitationMarkers(text).matchAll(SINGLE_MARKER_RE)) {
    const id = Number(m[1]);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
