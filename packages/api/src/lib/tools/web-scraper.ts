import { tool } from 'ai';
import { z } from 'zod';

import { describeClarityFailure, readClarityDocument } from '../clarity-read.js';
import { getErrorMessage } from '../errors/index.js';
import { log } from '../logger.js';
import { assertSafePublicUrl } from '@oxy.so/core/server';

const MAX_CONTENT_CHARS = 8_000;

/**
 * Read one public page through Clarity. Never throws; failures are `{ error }`.
 *
 * The URL is the model's, shaped by search results and by what the person
 * typed, and a URL is not trusted because Clarity is the one fetching it: it
 * must be a public http(s) URL whose name resolves ONLY to public addresses
 * (`assertSafePublicUrl`) before Clarity is asked anything.
 */
export async function readWebPage(url: string, signal?: AbortSignal) {
  const urlCheck = await assertSafePublicUrl(url, { signal });
  if (!urlCheck.ok) return { error: `URL blocked: ${urlCheck.reason}` };

  try {
    const read = await readClarityDocument(url, { signal });
    if (!read.ok) return { error: describeClarityFailure(read, url), reason: read.reason };
    const document = read.document;

    const content = (document.content || document.description || '').trim();
    return {
      documentId: document.id,
      title: document.title || document.canonicalUrl,
      content:
        content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}...` : content,
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
}

export const webScraperTool = tool({
  description:
    'Read the main content and citation metadata of a public web page. Pages that need JavaScript or interaction may be unreadable.',
  inputSchema: z.object({
    url: z.url().describe('The public URL to read'),
    extractLinks: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Retained in the tool input contract. Clarity owns crawl discovery; document reads do not expose raw outgoing-link graphs.',
      ),
  }),
  execute: async ({ url }, { abortSignal }) => readWebPage(url, abortSignal),
});
