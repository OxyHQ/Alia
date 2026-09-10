import { tool } from 'ai';
import { z } from 'zod';

import { clarityClient } from '../clarity-client.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { validateUrl } from './sandbox.js';

const MAX_CONTENT_CHARS = 8_000;

export const webScraperTool = tool({
  description: 'Read the indexed main content and citation metadata for a public web page. Clarity performs safe fetching and extraction; use browse only when Clarity cannot represent an interactive page.',
  inputSchema: z.object({
    url: z.string().url().describe('The public URL to read'),
    extractLinks: z.boolean().optional().default(false).describe(
      'Retained in the tool input contract. Clarity owns crawl discovery; document reads do not expose raw outgoing-link graphs.',
    ),
  }),
  execute: async ({ url }) => {
    const urlCheck = await validateUrl(url);
    if (!urlCheck.valid) return { error: `URL blocked: ${urlCheck.reason}` };

    try {
      const resolution = await clarityClient().indexing.resolve({ urls: [url], waitMs: 8_000 });
      const item = resolution.data[0];
      const document = item?.document
        ?? (item?.status === 'indexed' || item?.status === 'extracted'
          ? await clarityClient().documents.byUrl(url)
          : undefined);

      if (!document) {
        return {
          error: item?.operationId
            ? `Clarity is still indexing this page (operation ${item.operationId})`
            : 'Clarity could not extract this page',
        };
      }

      const content = (document.content || document.description || '').trim();
      return {
        documentId: document.id,
        title: document.title || document.canonicalUrl,
        content: content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}...` : content,
        url: document.canonicalUrl,
        length: content.length,
        authors: document.authors,
        publisher: document.publisher,
        publishedAt: document.publishedAt,
        indexedAt: document.indexedAt,
        evidence: document.evidence,
      };
    } catch (error: unknown) {
      log.tools.error({ err: error }, 'Clarity document read failed');
      return { error: `Failed to read page: ${getErrorMessage(error)}` };
    }
  },
});
