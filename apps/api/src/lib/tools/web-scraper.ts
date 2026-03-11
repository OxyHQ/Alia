import { tool } from 'ai';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { validateUrl } from './sandbox.js';
import { withRetry } from '../retry.js';
import { log } from '../logger.js';
import { getErrorMessage, getStatusCode } from '../errors/index.js';

// ── Types ──

interface LinkEntry {
  text: string;
  url: string;
}

interface CacheEntry {
  result: { title: string; content: string; url: string; length: number; links?: LinkEntry[] } | { error: string };
  fetchedAt: number;
}

// ── LRU Cache (100 entries, 10-min TTL) ──

const CACHE_MAX = 100;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map<string, CacheEntry>();

function getCached(cacheKey: string): CacheEntry['result'] | null {
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(cacheKey);
    return null;
  }
  // Move to end (LRU refresh)
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  return entry.result;
}

function setCache(cacheKey: string, result: CacheEntry['result']): void {
  // Evict oldest if at capacity
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(cacheKey, { result, fetchedAt: Date.now() });
}

// ── GitHub API Fallback ──
// GitHub pages are JS-heavy and block scrapers. For github.com URLs,
// use the public GitHub REST API (no auth needed, 60 req/hr) instead.

async function tryGitHubApiFallback(url: string): Promise<{ title: string; content: string; url: string; length: number } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
    return null;
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1];
  const GH = 'https://api.github.com';
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'AliaBot/1.0',
  };

  try {
    // File view: /owner/repo/blob/branch/path/to/file
    if (parts.length >= 4 && parts[2] === 'blob') {
      const branch = parts[3];
      const filePath = parts.slice(4).join('/');
      const res = await fetch(`${GH}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      let content = '';
      if (data.content && data.encoding === 'base64') {
        content = Buffer.from(data.content, 'base64').toString('utf-8');
        if (content.length > 8000) content = content.slice(0, 8000) + '\n\n[truncated]';
      }
      return { title: `${owner}/${repo} — ${filePath}`, content, url, length: content.length };
    }

    // Tree/directory view: /owner/repo/tree/branch/path
    if (parts.length >= 4 && parts[2] === 'tree') {
      const branch = parts[3];
      const dirPath = parts.slice(4).join('/');
      const apiPath = dirPath
        ? `${GH}/repos/${owner}/${repo}/contents/${encodeURIComponent(dirPath)}?ref=${encodeURIComponent(branch)}`
        : `${GH}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
      const res = await fetch(apiPath, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const data = await res.json();
      const entries = Array.isArray(data)
        ? data.map((e: any) => `${e.type === 'dir' ? 'd' : '-'} ${e.name}`).join('\n')
        : (data.tree || []).slice(0, 100).map((e: any) => `${e.type === 'tree' ? 'd' : '-'} ${e.path}`).join('\n');
      const title = `${owner}/${repo}${dirPath ? ` — ${dirPath}` : ''} (${branch})`;
      return { title, content: entries, url, length: entries.length };
    }

    // Repo root: /owner/repo — fetch repo info + README in parallel
    const [repoRes, readmeRes] = await Promise.all([
      fetch(`${GH}/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(10000) }),
      fetch(`${GH}/repos/${owner}/${repo}/readme`, {
        headers: { ...headers, Accept: 'application/vnd.github.v3.raw' },
        signal: AbortSignal.timeout(10000),
      }),
    ]);

    let content = '';
    if (repoRes.ok) {
      const d = await repoRes.json();
      content += `# ${d.full_name}\n\n${d.description || 'No description'}\n\n`;
      content += `Language: ${d.language || 'N/A'} | Stars: ${d.stargazers_count} | Forks: ${d.forks_count} | Issues: ${d.open_issues_count}\n`;
      content += `License: ${d.license?.spdx_id || 'N/A'} | Topics: ${(d.topics || []).join(', ') || 'N/A'}\n`;
      content += `Default branch: ${d.default_branch}\n\n---\n\n`;
    }

    if (readmeRes.ok) {
      let readme = await readmeRes.text();
      const budget = 8000 - content.length;
      if (readme.length > budget) readme = readme.slice(0, budget) + '\n\n[README truncated]';
      content += readme;
    }

    if (!content) return null;
    return { title: `${owner}/${repo}`, content, url, length: content.length };
  } catch {
    return null; // Fall through to standard HTML scraping
  }
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

// ── Link Extraction ──

function extractLinksFromHtml(html: string, baseUrl: string, maxLinks = 50): LinkEntry[] {
  try {
    const parsedBase = new URL(baseUrl);
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;
    const anchors = doc.querySelectorAll('a[href]');

    const seen = new Set<string>();
    const links: LinkEntry[] = [];

    for (const anchor of anchors) {
      if (links.length >= maxLinks) break;

      const href = anchor.getAttribute('href');
      if (!href) continue;

      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }

      const parsed = new URL(absoluteUrl);

      // Same domain only, HTTP(S) only
      if (parsed.hostname !== parsedBase.hostname) continue;
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

      // Normalize: remove fragment and trailing slash for dedup
      parsed.hash = '';
      const normalized = parsed.toString().replace(/\/$/, '');
      if (seen.has(normalized)) continue;
      if (normalized === baseUrl.replace(/\/$/, '')) continue; // skip self-link
      seen.add(normalized);

      const text = (anchor.textContent || '').trim().slice(0, 100) || parsed.pathname;
      links.push({ text, url: normalized });
    }

    return links;
  } catch {
    return [];
  }
}

// ── Tool ──

export const webScraperTool = tool({
  description: 'Read and extract the main content from a web page URL. Use this when users share links or ask you to read a webpage. Set extractLinks=true to also get a list of same-domain links found on the page, useful for crawling a website.',
  inputSchema: z.object({
    url: z.string().url().describe('The URL of the web page to read'),
    extractLinks: z.boolean().optional().default(false).describe(
      'When true, also return internal links found on the page. Use this to discover and crawl other pages on the same website.'
    ),
  }),
  execute: async ({ url, extractLinks }) => {
    const urlCheck = validateUrl(url);
    if (!urlCheck.valid) {
      return { error: `URL blocked: ${urlCheck.reason}` };
    }

    const cacheKey = extractLinks ? `${url}::links` : url;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      log.general.info({ url }, 'Web scraper cache hit');
      return cached;
    }

    // GitHub API fallback — GitHub pages are JS-heavy and block scrapers,
    // so use the public API for structured data instead.
    const ghResult = await tryGitHubApiFallback(url);
    if (ghResult) {
      log.general.info({ url }, 'Web scraper: GitHub API fallback used');
      setCache(cacheKey, ghResult);
      return ghResult;
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
            const status = getStatusCode(err);
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

      const result: { title: string; content: string; url: string; length: number; links?: LinkEntry[] } = {
        title: extracted.title, content, url, length: extracted.content.length,
      };

      if (extractLinks) {
        result.links = extractLinksFromHtml(html, url);
      }

      setCache(cacheKey, result);
      return result;
    } catch (error: unknown) {
      const errorResult = { error: `Failed to read page: ${getErrorMessage(error)}` };
      setCache(cacheKey, errorResult); // Cache errors too to avoid retrying broken URLs
      return errorResult;
    }
  },
});
