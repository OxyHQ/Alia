import type { ToolInvocation } from '../types';

export interface CitationSource {
  /** The citation number, as it appears in `[n]`. */
  id: number;
  url: string;
  title: string;
  domain: string;
}

interface PersistedResearchSource {
  id?: unknown;
  url?: unknown;
  title?: unknown;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The numbered sources of a research answer.
 *
 * Only `deepResearch` invocations carry NUMBERED sources; a `webSearch` result has URLs but
 * no `[n]` to stand for them, so it contributes nothing here. The first invocation to claim a
 * number wins, which is also the only one there is.
 */
export function extractCitationSources(
  toolInvocations?: readonly ToolInvocation[],
  /** `researchProgress.sources` of a live research answer, before it is persisted. */
  liveSources?: readonly PersistedResearchSource[] | null,
): CitationSource[] {
  const byId = new Map<number, CitationSource>();
  const take = (raw: PersistedResearchSource) => {
    if (!raw || typeof raw !== 'object') return;
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id);
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (!Number.isInteger(id) || id < 1 || url.length === 0 || byId.has(id)) return;
    const title =
      typeof raw.title === 'string' && raw.title.trim().length > 0
        ? raw.title.trim()
        : domainOf(url);
    byId.set(id, { id, url, title, domain: domainOf(url) });
  };

  for (const inv of toolInvocations ?? []) {
    if (inv.toolName !== 'deepResearch' || inv.state !== 'result') continue;
    const result = inv.result;
    const sources: unknown =
      result !== null && typeof result === 'object'
        ? (result as { sources?: unknown }).sources
        : undefined;
    if (!Array.isArray(sources)) continue;
    for (const raw of sources as PersistedResearchSource[]) take(raw);
  }
  for (const raw of liveSources ?? []) take(raw);

  return [...byId.values()].sort((a, b) => a.id - b.id);
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
      list
        .split(',')
        .map((n) => `[${n.trim()}]`)
        .join(''),
    );

  if (known && known.size > 0) {
    out = out.replace(SINGLE_MARKER_RE, (m, n: string) => (known.has(Number(n)) ? m : ''));
    out = out.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }

  return out;
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
