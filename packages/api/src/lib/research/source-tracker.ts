/**
 * Source Tracker — Manages citations and deduplication for deep research.
 *
 * Tracks URLs, assigns citation numbers, stores content excerpts,
 * and generates a formatted references section.
 */

export interface Source {
  id: number;
  url: string;
  title: string;
  excerpt: string;
  query: string;        // The search query that found this source
  addedAt: number;
}

export class SourceTracker {
  private sources: Source[] = [];
  private urlIndex = new Map<string, number>(); // url → source id

  /** Add a source, deduplicating by URL. Returns the citation number. */
  add(url: string, title: string, excerpt: string, query: string): number {
    const normalized = normalizeUrl(url);
    const existing = this.urlIndex.get(normalized);
    if (existing !== undefined) return existing;

    const id = this.sources.length + 1;
    this.sources.push({ id, url, title, excerpt: excerpt.slice(0, 500), query, addedAt: Date.now() });
    this.urlIndex.set(normalized, id);
    return id;
  }

  /** Get all sources in citation order. */
  getAll(): Source[] {
    return [...this.sources];
  }

  /** Get source by citation number. */
  get(id: number): Source | undefined {
    return this.sources[id - 1];
  }

  /** Number of unique sources. */
  count(): number {
    return this.sources.length;
  }

  /**
   * Format a references section for the final report.
   *
   * Each entry is a real Markdown link, `[n] [Title](url)`, rather than a
   * title with the URL on the next line: the report is rendered as Markdown,
   * and a bare URL under a title was plain text the reader had to copy out
   * (#540). The `[n]` prefix stays so the entry lines up with the inline
   * markers, and the app links it to the same source. A title that would break
   * the link syntax is escaped; an empty title falls back to the host.
   */
  formatReferences(): string {
    if (this.sources.length === 0) return '';

    const lines = this.sources.map(s => `[${s.id}] ${formatSourceLink(s)}`);

    return `\n\n---\n\n## References\n\n${lines.join('\n\n')}`;
  }

  /** Serialize for progress events. */
  toJSON(): Array<{ id: number; url: string; title: string }> {
    return this.sources.map(s => ({ id: s.id, url: s.url, title: s.title }));
  }
}

/**
 * One source as a Markdown link. Exported because the partial-result note in
 * the engine lists sources the same way, and the two must not drift.
 */
export function formatSourceLink(source: { url: string; title: string }): string {
  const title = source.title.replace(/\s+/g, ' ').trim().replace(/[[\]]/g, '\\$&');
  const label = title.length > 0 ? title : hostOf(source.url);
  // Parentheses inside the URL would close the link early.
  const href = source.url.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
  return `[${label}](${href})`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Normalize URL for deduplication (strip trailing slash, fragment, tracking params). */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove common tracking params
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'fbclid', 'gclid'].forEach(p => u.searchParams.delete(p));
    u.hash = '';
    return u.href.replace(/\/+$/, '');
  } catch {
    return url.replace(/\/+$/, '');
  }
}
