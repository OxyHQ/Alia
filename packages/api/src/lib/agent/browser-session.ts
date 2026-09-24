/**
 * Browser Session — the autonomous runner's `browser` primitive, through Clarity.
 *
 * Three actions, and all of them are Clarity calls:
 *   - search:   Clarity Search over its public web index
 *   - goto:     Clarity document extraction for one URL, remembered as current
 *   - get_text: the current URL's extracted text again
 *
 * ## There is no local browser, and that is the design
 *
 * This used to fall back to Stagehand driving a local Chromium for anything
 * Clarity could not represent, and to offer screenshot, click, type, scroll and
 * back on top of it. The runtime image ships no Chromium, so in production every
 * one of those failed at launch — the primitive worked exactly as far as Clarity
 * reached and no further. What cannot work was removed; what remains works in
 * the image as it is built.
 *
 * `validateUrl` still runs before Clarity is asked anything: Clarity fetches on
 * our behalf, and a URL a model produced is not trusted because it came back
 * through a service.
 *
 * The session holds nothing but the current URL, so there is nothing to open,
 * pre-warm or close.
 */

import { validateUrl } from '../tools/sandbox.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { clarityClient } from '../clarity-client.js';

const MAX_CONTENT_CHARS = 12_000;

export const BROWSER_ACTIONS = ['search', 'goto', 'get_text'] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export interface BrowserParams {
  url?: string;
  query?: string;
}

export class BrowserSession {
  private currentUrl = '';

  /** Run one browser action. Errors come back as text the model can act on. */
  async execute(action: BrowserAction, params: BrowserParams): Promise<string> {
    try {
      switch (action) {
        case 'search':
          return await this.search(params.query || '');
        case 'goto':
          return await this.goto(params.url || '');
        case 'get_text':
          return await this.getText();
        default:
          return `Unknown browser action: ${String(action)}. Use search, goto or get_text.`;
      }
    } catch (err: unknown) {
      // Neither the query nor the URL: both are chosen by the model from what
      // the person asked, and a URL identifies what someone is reading.
      log.agents.error({ err, action }, 'Browser session error');
      return `Browser error: ${getErrorMessage(err)}`;
    }
  }

  /** Search Clarity's public web index. */
  private async search(query: string): Promise<string> {
    if (!query) return 'Error: query is required for search action';
    const response = await clarityClient().search({ query, mode: 'hybrid', limit: 8 });
    const results = response.data;
    if (results.length === 0) return 'No search results found.';

    return results.map((r, i) =>
      `${i + 1}. ${r.title || r.canonicalUrl}\n   ${r.canonicalUrl}\n   ${r.snippet || r.description || ''}`
    ).join('\n\n');
  }

  /** Read a URL through Clarity and make it the current page. */
  private async goto(url: string): Promise<string> {
    if (!url) return 'Error: url is required for goto action';

    const check = await validateUrl(url);
    if (!check.valid) return `Error: URL blocked — ${check.reason}`;

    this.currentUrl = url;
    return await this.read(url);
  }

  /** The current page's text, read again. */
  private async getText(): Promise<string> {
    if (!this.currentUrl) return 'No page loaded. Use goto first.';
    return await this.read(this.currentUrl);
  }

  private async read(url: string): Promise<string> {
    const resolution = await clarityClient().indexing.resolve({ urls: [url], waitMs: 8_000 });
    const item = resolution.data[0];
    const document = item?.document;
    const content = document?.content?.trim();
    if (!document || !content) {
      return item?.operationId
        ? `Clarity is still indexing ${url}. Try get_text again shortly, or search for another source.`
        : `Clarity could not extract readable text from ${url}. Search for another source.`;
    }
    return `# ${document.title || document.canonicalUrl}\nURL: ${document.canonicalUrl}\n\n${truncate(content, MAX_CONTENT_CHARS)}`;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n[Content truncated]';
}
