import type { ToolInvocation } from '@/lib/types/messages';

/**
 * Citations — the `[n]` markers in a research answer, resolved to the sources
 * they name, so the answer can link them.
 *
 * Pure: no React, no platform, nothing but strings and the persisted tool
 * invocations. `components/ui/markdown.tsx` is the one renderer.
 *
 * ## Two halves
 *
 *  * `normalizeCitationMarkers` is a TWIN of the API's
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

export interface CitationSource {
  /** The citation number, as it appears in `[n]`. */
  id: number;
  url: string;
  title: string;
  domain: string;
}

const FULLWIDTH_MARKER_RE = /【\s*(\d{1,3})\s*(?:†[^】]*)?】/g;
const ASCII_DAGGER_MARKER_RE = /\[(\d{1,3})†[^\]]*\]/g;
const COMMA_LIST_RE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})+)\](?![(:])/g;
const SINGLE_MARKER_RE = /\[(\d{1,3})\](?![(:])/g;

/**
 * Rewrite every citation marker into the `[n]` form; with `knownIds`, drop
 * the ones that name no source. See the API twin for the reasoning.
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
    out = out.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }

  return out;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** One persisted research source, as the handler saves it. */
interface PersistedResearchSource {
  id?: unknown;
  url?: unknown;
  title?: unknown;
}

/**
 * The sources a message's `[n]` markers can resolve to, by citation number.
 *
 * Only `deepResearch` invocations carry NUMBERED sources; a `webSearch`
 * result has URLs but no `[n]` to stand for them, so it contributes nothing
 * here (it still reaches the Sources row through `extractSources`). The first
 * invocation to claim a number wins, which is also the only one there is.
 */
export function extractCitationSources(
  toolInvocations?: ToolInvocation[],
  /** `researchProgress.sources` of a live research answer, before it is persisted. */
  liveSources?: Array<{ id?: unknown; url?: unknown; title?: unknown }> | null,
): CitationSource[] {
  const byId = new Map<number, CitationSource>();
  const take = (raw: PersistedResearchSource) => {
    if (!raw || typeof raw !== 'object') return;
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (!Number.isInteger(id) || id < 1 || url.length === 0 || byId.has(id)) return;
    const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : domainOf(url);
    byId.set(id, { id, url, title, domain: domainOf(url) });
  };

  for (const inv of toolInvocations ?? []) {
    if (inv.toolName !== 'deepResearch' || inv.state !== 'result') continue;
    const sources: unknown = inv.result?.sources;
    if (!Array.isArray(sources)) continue;
    for (const raw of sources as PersistedResearchSource[]) take(raw);
  }
  for (const raw of liveSources ?? []) take(raw);

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * The accessible name of one citation: what a screen reader says for the
 * link, and what `CustomMarkdown` puts in the link's title.
 */
export function citationLabel(source: CitationSource): string {
  return `Source ${source.id}: ${source.title}`;
}

/**
 * `[n]` markers that name a known source become Markdown links to it, so the
 * SDK's Markdown renderer makes them pressable. Markers with no source are
 * left as text: dropping them here would hide that the model cited something
 * the reader cannot check, and the API already drops them for new answers.
 *
 * Runs on the normalised text, so legacy `【n†…】` markers link too. The
 * link title carries the accessible name; a title containing quotes would end
 * it early, so those are folded to apostrophes.
 */
export function linkifyCitations(text: string, sources: CitationSource[]): string {
  if (sources.length === 0) return normalizeCitationMarkers(text);
  const byId = new Map(sources.map((s) => [s.id, s]));
  return normalizeCitationMarkers(text).replace(SINGLE_MARKER_RE, (m, n: string) => {
    const source = byId.get(Number(n));
    if (!source) return m;
    const title = citationLabel(source).replace(/"/g, "'");
    return `[${n}](${source.url} "${title}")`;
  });
}

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
const REFERENCES_HEADING_RE = /(?:^|\n)(?:---\s*\n+)?#{1,3}\s*(?:References|Referencias|Sources|Fuentes)\s*:?\s*(?:\n|$)/i;

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
    if (url) entries.push({ id: current.id, title: title.replace(/\\([[\]])/g, '$1'), url, domain: domainOf(url) });
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
