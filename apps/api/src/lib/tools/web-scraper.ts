import { tool } from 'ai';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { validateUrl } from './sandbox.js';
import { withRetry } from '../retry.js';
import { log } from '../logger.js';

// ── LRU Cache (100 entries, 10-min TTL) ──

interface CacheEntry {
  result: { title: string; content: string; url: string; length: number } | { error: string };
  fetchedAt: number;
}

const CACHE_MAX = 100;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map<string, CacheEntry>();

function getCached(url: string): CacheEntry['result'] | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  // Move to end (LRU refresh)
  cache.delete(url);
  cache.set(url, entry);
  return entry.result;
}

function setCache(url: string, result: CacheEntry['result']): void {
  // Evict oldest if at capacity
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, { result, fetchedAt: Date.now() });
}

// ── Content Extraction ──

function extractWithReadability(html: string, url: string): { title: string; content: string } | null {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (article?.textContent && article.textContent.length > 100) {
      return { title: article.title || url, content: article.textContent.trim() };
    }
  } catch {
    // Readability failed — fall through to regex
  }
  return null;
}

function extractWithRegex(html: string, url: string): { title: string; content: string } {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return { title: titleMatch ? titleMatch[1].trim() : url, content: text };
}

// ── Tool ──

export const webScraperTool = tool({
  description: 'Read and extract the main content from a web page URL. Use this when users share links or ask you to read a webpage.',
  inputSchema: z.object({
    url: z.string().url().describe('The URL of the web page to read'),
  }),
  execute: async ({ url }) => {
    const urlCheck = validateUrl(url);
    if (!urlCheck.valid) {
      return { error: `URL blocked: ${urlCheck.reason}` };
    }

    // Check cache first
    const cached = getCached(url);
    if (cached) {
      log.general.info({ url }, 'Web scraper cache hit');
      return cached;
    }

    try {
      // Fetch with retry (3 attempts, exponential backoff)
      const html = await withRetry(
        async () => {
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; AliaBot/1.0)',
              'Accept': 'text/html,application/xhtml+xml',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) {
            throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), { status: response.status });
          }
          return response.text();
        },
        {
          maxAttempts: 3,
          minDelay: 500,
          shouldRetry: (err) => {
            const status = err?.status;
            // Don't retry 4xx client errors (except 429)
            if (status && status >= 400 && status < 500 && status !== 429) return false;
            return true;
          },
        }
      );

      // Extract content: try Readability first, fallback to regex
      const extracted = extractWithReadability(html, url) || extractWithRegex(html, url);

      const maxLength = 8000;
      const content = extracted.content.length > maxLength
        ? extracted.content.slice(0, maxLength) + '...'
        : extracted.content;

      const result = { title: extracted.title, content, url, length: extracted.content.length };
      setCache(url, result);
      return result;
    } catch (error: any) {
      const errorResult = { error: `Failed to read page: ${error.message}` };
      setCache(url, errorResult); // Cache errors too to avoid retrying broken URLs
      return errorResult;
    }
  },
});
