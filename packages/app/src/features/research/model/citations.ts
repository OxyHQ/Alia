import { type CitationSource, domainOf as hostOf } from '@alia.onl/sdk/tools';

/**
 * Citations — the `[n]` markers in a research answer, resolved to the sources
 * they name, so the answer can link them.
 *
 * Pure: no React, no platform, nothing but strings and the persisted tool
 * invocations. `src/features/chat/ui/markdown.tsx` is the one renderer.
 *
 * ## Two halves
 *
 *  * `normalizeCitationMarkers` (the SDK's, so its chat links citations too) is a TWIN of the API's
 *    (`packages/api/src/lib/research/citations.ts`). The API normalises what
 *    it streams and saves now; this copy is for the messages saved before it
 *    did, which still carry `【1†L1-L3】` and `[1, 2]`. The two must agree, and
 *    the tests pin the same cases.
 *  * `extractCitationSources` reads the sources a message can cite out of its
 *    `toolInvocations`, which is the jsonb the message is stored with — so a
 *    thread reopened next month links the same sources it linked live. The
 *    research handler persists them as a finished `deepResearch` invocation
 *    (`lib/chat-modes/deep-research-handler.ts`).
 */

// One definition of the numbered sources, the SDK's, so its chat and this app agree.
export type { CitationSource } from '@alia.onl/sdk/tools';
export {
  citationLabel,
  extractCitationSources,
  linkifyCitations,
  normalizeCitationMarkers,
} from '@alia.onl/sdk/tools';

/** A source's site as a citation names it: the host without a leading `www.`. */
const domainOf = (url: string) => hostOf(url, { stripWww: true });

/** One entry of a rendered references section. */
export interface ReferenceEntry {
  id: number;
  title: string;
  url: string;
  domain: string;
}

/**
 * Where the references section starts: the API writes `## References` after a
 * rule; the app-side heading is matched loosely so an older answer, or one
 * written in Spanish by the model itself, splits the same way.
 */
const REFERENCES_HEADING_RE =
  /(?:^|\n)(?:---\s*\n+)?#{1,3}\s*(?:References|Referencias|Sources|Fuentes)\s*:?\s*(?:\n|$)/i;

/** `[n] [Title](url)` (new) or `[n] Title` + a URL line (legacy). */
const REFERENCE_LINE_RE = /^\s*\[(\d{1,3})\]\s*(.*)$/;
// The title may carry escaped brackets (`React \[Wikipedia\]`), which the
// API writes for a title that contains them.
const MARKDOWN_LINK_RE = /^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const URL_RE = /https?:\/\/[^\s)]+/;

/**
 * Split an answer into its body and the entries of its references section.
 *
 * `references` is `null` when the section is absent or none of its lines
 * parse, in which case the caller renders the whole text as Markdown and
 * nothing is lost. Known sources fill in a title or URL a legacy line lacks.
 */
export function splitReferences(
  text: string,
  sources: CitationSource[] = [],
): { body: string; references: ReferenceEntry[] | null } {
  const match = REFERENCES_HEADING_RE.exec(text);
  if (!match) return { body: text, references: null };

  const body = text.slice(0, match.index).replace(/\s+$/, '');
  const section = text.slice(match.index + match[0].length);
  const byId = new Map(sources.map((s) => [s.id, s]));

  const entries: ReferenceEntry[] = [];
  let current: { id: number; rest: string } | null = null;
  const flush = () => {
    if (!current) return;
    const known = byId.get(current.id);
    const rest = current.rest.trim();
    const link = MARKDOWN_LINK_RE.exec(rest);
    let url = link ? link[2] : (URL_RE.exec(rest)?.[0] ?? known?.url ?? '');
    let title = link ? link[1] : rest.replace(URL_RE, '').replace(/\s+/g, ' ').trim();
    if (!url && known) url = known.url;
    if (!title) title = known?.title ?? (url ? domainOf(url) : '');
    if (url)
      entries.push({
        id: current.id,
        title: title.replace(/\\([[\]])/g, '$1'),
        url,
        domain: domainOf(url),
      });
    current = null;
  };

  for (const line of section.split('\n')) {
    const m = REFERENCE_LINE_RE.exec(line);
    if (m) {
      flush();
      current = { id: Number(m[1]), rest: m[2] };
    } else if (current && line.trim().length > 0) {
      // A legacy entry's URL sits on the indented line after the title.
      current.rest += ` ${line.trim()}`;
    }
  }
  flush();

  return entries.length > 0 ? { body, references: entries } : { body: text, references: null };
}
