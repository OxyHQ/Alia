/**
 * Web Search Tool
 *
 * Public-web search provided by Clarity.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { log } from '../logger.js';
import { clarityClient } from '../clarity-client.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  count: number;
  error?: string;
}

// ── LRU Cache (100 entries, 10-min TTL) ──

interface CacheEntry {
  result: WebSearchResponse;
  fetchedAt: number;
}

const CACHE_MAX = 100;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function getCached(query: string): WebSearchResponse | null {
  const key = query.toLowerCase().trim();
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function setCache(query: string, result: WebSearchResponse): void {
  const key = query.toLowerCase().trim();
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { result, fetchedAt: Date.now() });
}

// ── Tool ──

export const webSearchTool = tool({
  description: 'Search the web for current information, news, and facts. Use this when you need up-to-date information or are uncertain about something.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
  }),
  execute: async ({ query }: { query: string }): Promise<WebSearchResponse> => {
    try {
      // A search query is model output derived from the user's prompt.
      log.tools.info({ queryLength: query.length }, 'Web search executing');

      const cached = getCached(query);
      if (cached) {
        log.tools.info({ count: cached.count }, 'Web search cache hit');
        return cached;
      }

      const searchResponse = await clarityClient().search({ query, mode: 'hybrid', limit: 10 });
      const results = searchResponse.data.map((result) => ({
        title: result.title || result.canonicalUrl,
        url: result.canonicalUrl,
        snippet: result.snippet || result.description || '',
      }));

      log.tools.info({ count: results.length }, 'Web search found results');

      const response: WebSearchResponse = { results, count: results.length };
      setCache(query, response);
      return response;
    } catch (error) {
      log.tools.error({ err: error }, 'Web search error');
      const errorMessage = error instanceof Error ? error.message : 'Web search failed';
      return { error: errorMessage, results: [], count: 0 };
    }
  },
});
