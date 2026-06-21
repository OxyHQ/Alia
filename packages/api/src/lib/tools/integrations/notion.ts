/**
 * Notion integration tools — search pages, read page content
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { safeExecute, authedFetch, assertUUID } from './shared.js';

export function buildNotionTools(userId: string): ToolSet {
  const notionHeaders = { 'Notion-Version': '2022-06-28' };

  return {
    searchNotionPages: tool({
      description: '[Notion] Search pages and databases in the user\'s workspace.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: async ({ query }) => safeExecute('Notion', async () => {
        const data = await authedFetch(userId, 'notion', 'https://api.notion.com/v1/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...notionHeaders },
          body: JSON.stringify({ query, page_size: 10 }),
        });
        return data.results.map((r: any) => ({
          id: r.id,
          type: r.object,
          title: r.properties?.title?.title?.[0]?.plain_text
            || r.properties?.Name?.title?.[0]?.plain_text
            || r.title?.[0]?.plain_text
            || 'Untitled',
          url: r.url,
          lastEdited: r.last_edited_time,
        }));
      }),
    }),

    getNotionPage: tool({
      description: '[Notion] Get the content of a specific Notion page by ID.',
      inputSchema: z.object({
        pageId: z.string().describe('The Notion page ID'),
      }),
      execute: async ({ pageId }) => safeExecute('Notion', async () => {
        assertUUID(pageId, 'Notion page ID');
        const [page, blocks] = await Promise.all([
          authedFetch(userId, 'notion', `https://api.notion.com/v1/pages/${pageId}`, {
            headers: notionHeaders,
          }),
          authedFetch(userId, 'notion', `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
            headers: notionHeaders,
          }),
        ]);

        // Extract text content from blocks
        const content = blocks.results.map((block: any) => {
          const type = block.type;
          const richText = block[type]?.rich_text || block[type]?.text;
          if (Array.isArray(richText)) {
            return richText.map((t: any) => t.plain_text).join('');
          }
          return '';
        }).filter(Boolean).join('\n');

        return {
          id: page.id,
          url: page.url,
          lastEdited: page.last_edited_time,
          content: content.slice(0, 3000),
        };
      }),
    }),
  };
}
