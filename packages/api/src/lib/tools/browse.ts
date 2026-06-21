/**
 * Browse Tool
 *
 * Real browser automation via Stagehand (Playwright + AI).
 * Use as fallback when webSearch/webScraper fail, or for JS-heavy pages.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { Stagehand } from '@browserbasehq/stagehand';
import { validateUrl } from './sandbox.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

export interface BrowseSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface BrowseResponse {
  action: 'search' | 'read';
  results?: BrowseSearchResult[];
  count?: number;
  title?: string;
  content?: string;
  url?: string;
  error?: string;
}

export const browseTool = tool({
  description:
    'Browse the web using a real browser. Use this when: (1) webSearch returns no results or fails, (2) a page requires JavaScript to render, (3) you need to interact with a webpage. This is slower than webSearch — prefer webSearch for simple queries.',
  inputSchema: z.object({
    action: z.enum(['search', 'read']).describe(
      'search: search the web for a query. read: navigate to a URL and extract its content.'
    ),
    query: z.string().optional().describe('Search query (required when action is search)'),
    url: z.string().optional().describe('URL to read (required when action is read)'),
  }),
  execute: async ({
    action,
    query,
    url,
  }: {
    action: 'search' | 'read';
    query?: string;
    url?: string;
  }): Promise<BrowseResponse> => {
    let stagehand: Stagehand | null = null;

    try {
      // Validate inputs
      if (action === 'search' && !query) {
        return { action, error: 'query is required for search action' };
      }
      if (action === 'read' && !url) {
        return { action, error: 'url is required for read action' };
      }
      if (url) {
        const check = validateUrl(url);
        if (!check.valid) return { action, error: `URL blocked: ${check.reason}` };
      }

      // Use the Alia API as LLM backend (OpenAI-compatible endpoint)
      const serviceSecret = process.env.SERVICE_SECRET;
      if (!serviceSecret) {
        return { action, error: 'SERVICE_SECRET not configured for browse tool' };
      }

      const aliaApiUrl = process.env.ALIA_API_URL || 'http://localhost:3001';

      log.tools.info({ action, query, url }, 'Browse tool starting');

      stagehand = new Stagehand({
        env: 'LOCAL',
        localBrowserLaunchOptions: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
        model: {
          modelName: 'openai/alia-lite',
          apiKey: serviceSecret,
          baseURL: `${aliaApiUrl}/v1`,
        },
      });
      await stagehand.init();
      const page = stagehand.context.pages()[0];

      if (action === 'search') {
        await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeoutMs: 15000 });
        await stagehand.act(`Type "${query}" into the search box and press Enter`);

        // Wait briefly for results
        await page.waitForTimeout(2000);

        const data = await stagehand.extract(
          'Extract the top search results. For each result get the title, URL, and a short description snippet.',
          z.object({
            results: z.array(
              z.object({
                title: z.string(),
                url: z.string(),
                snippet: z.string(),
              })
            ),
          })
        );

        const results: BrowseSearchResult[] = (data.results || []).slice(0, 8).map(r => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.snippet ?? '',
        }));
        log.tools.info({ query, count: results.length }, 'Browse search completed');
        return { action: 'search', results, count: results.length };
      }

      if (action === 'read') {
        await page.goto(url!, { waitUntil: 'domcontentloaded', timeoutMs: 15000 });

        const data = await stagehand.extract(
          'Extract the page title and the main text content of this page.',
          z.object({
            title: z.string().describe('The page title'),
            content: z.string().describe('The main article or page content as plain text'),
          })
        );

        const maxLen = 8000;
        const content =
          data.content.length > maxLen
            ? data.content.slice(0, maxLen) + '...'
            : data.content;

        log.tools.info({ url, titleLength: data.title.length, contentLength: content.length }, 'Browse read completed');
        return { action: 'read', title: data.title, content, url };
      }

      return { action, error: 'Invalid action' };
    } catch (err: unknown) {
      log.tools.error({ err, action, query, url }, 'Browse tool error');
      return { action, error: getErrorMessage(err) };
    } finally {
      if (stagehand) {
        try {
          await stagehand.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  },
});
