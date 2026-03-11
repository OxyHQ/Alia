/**
 * Web Search Tool
 *
 * Free web search via DuckDuckGo Lite scraping.
 * No API key required. Uses JSDOM to parse results.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import { withRetry } from '../retry.js';
import { log } from '../logger.js';

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

// ── DuckDuckGo Lite Parsing ──

function parseDDGLite(html: string): WebSearchResult[] {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const results: WebSearchResult[] = [];

  // DDG Lite uses table rows. Each organic result is a sequence of <tr>s:
  // 1. <tr> with <a class="result-link"> (title + href)
  // 2. <tr> with <td class="result-snippet"> (snippet)
  // Sponsored results have class="result-sponsored" — skip those.
  const allLinks = doc.querySelectorAll('a.result-link');

  for (const linkEl of allLinks) {
    // Skip sponsored results (parent <tr> has class="result-sponsored")
    const parentTr = linkEl.closest('tr');
    if (parentTr?.classList.contains('result-sponsored')) continue;

    const title = linkEl.textContent?.trim() || '';
    let url = linkEl.getAttribute('href') || '';

    // Extract real URL from DDG redirect wrapper
    if (url.includes('uddg=')) {
      try {
        const parsed = new URL(url, 'https://duckduckgo.com');
        url = decodeURIComponent(parsed.searchParams.get('uddg') || url);
      } catch {
        // Keep original
      }
    }

    if (!title || !url || !url.startsWith('http')) continue;

    // Find the snippet in a sibling <tr> with td.result-snippet
    let snippet = '';
    // Walk forward through sibling <tr>s to find the snippet
    let nextTr = parentTr?.nextElementSibling;
    while (nextTr) {
      const snippetTd = nextTr.querySelector('td.result-snippet');
      if (snippetTd) {
        snippet = snippetTd.textContent?.trim() || '';
        break;
      }
      // Stop if we hit another result link or an empty separator row
      if (nextTr.querySelector('a.result-link')) break;
      nextTr = nextTr.nextElementSibling;
    }

    results.push({ title, url, snippet });
  }

  return results;
}

// ── Tool ──

export const webSearchTool = tool({
  description: 'Search the web for current information, news, and facts. Use this when you need up-to-date information or are uncertain about something.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
  }),
  execute: async ({ query }: { query: string }): Promise<WebSearchResponse> => {
    try {
      log.tools.info({ query }, 'Web search executing');

      const cached = getCached(query);
      if (cached) {
        log.tools.info({ query, count: cached.count }, 'Web search cache hit');
        return cached;
      }

      const encodedQuery = encodeURIComponent(query);
      const url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;

      const html = await withRetry(
        async () => {
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) {
            throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
          }
          return response.text();
        },
        {
          maxAttempts: 2,
          minDelay: 500,
          shouldRetry: (err) => {
            const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : undefined;
            if (status && status >= 400 && status < 500 && status !== 429) return false;
            return true;
          },
        }
      );

      const results = parseDDGLite(html).slice(0, 10);

      log.tools.info({ query, count: results.length }, 'Web search found results');

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
