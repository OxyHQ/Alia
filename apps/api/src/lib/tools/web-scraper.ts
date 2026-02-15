import { tool } from 'ai';
import { z } from 'zod';
import { validateUrl } from './sandbox.js';

export const webScraperTool = tool({
  description: 'Read and extract the main content from a web page URL. Use this when users share links or ask you to read a webpage.',
  inputSchema: z.object({
    url: z.string().url().describe('The URL of the web page to read'),
  }),
  execute: async ({ url }) => {
    try {
      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        return { error: `URL blocked: ${urlCheck.reason}` };
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AliaBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return { error: `Failed to fetch: ${response.status} ${response.statusText}` };
      }

      const html = await response.text();

      // Simple HTML to text extraction
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

      // Extract title
      const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : url;

      // Limit content length
      const maxLength = 8000;
      const content = text.length > maxLength ? text.slice(0, maxLength) + '...' : text;

      return { title, content, url, length: text.length };
    } catch (error: any) {
      return { error: `Failed to read page: ${error.message}` };
    }
  },
});