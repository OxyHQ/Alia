import type { ToolInvocation } from '../types';
import { domainOf } from './domain';

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
        : domainOf(url, { stripWww: true });
    byId.set(id, { id, url, title, domain: domainOf(url, { stripWww: true }) });
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
