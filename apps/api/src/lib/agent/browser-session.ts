/**
 * Browser Session — Manus-Style Browser Automation
 *
 * Provides a persistent browser session for agent interactions.
 * Uses a hybrid approach for performance:
 *   - search: DuckDuckGo Lite scraping (instant, no browser needed)
 *   - goto + get_text: Readability extraction (fast, no browser needed)
 *   - goto + screenshot: Stagehand/Playwright (real browser)
 *   - click/type/scroll: Stagehand interactive actions
 *
 * Screenshots are returned as base64 for vision-capable models.
 * Falls back to text extraction when vision is unavailable.
 */

import { Stagehand } from '@browserbasehq/stagehand';
import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { validateUrl } from '../tools/sandbox.js';
import { withRetry } from '../retry.js';
import { log } from '../logger.js';

const MAX_CONTENT_CHARS = 12_000;
const SCREENSHOT_DIR = '/workspace/.alia/screenshots';
const PAGE_TIMEOUT = 15_000;

export type BrowserAction =
  | 'goto'
  | 'click'
  | 'type'
  | 'scroll_down'
  | 'scroll_up'
  | 'screenshot'
  | 'get_text'
  | 'search'
  | 'back'
  | 'wait';

export interface BrowserParams {
  url?: string;
  selector?: string;
  text?: string;
  query?: string;
}

export class BrowserSession {
  private stagehand: Stagehand | null = null;
  private page: Page | null = null;
  private currentUrl = '';
  private screenshotSeq = 0;

  /**
   * Execute a browser action. Initializes the browser lazily on first interactive action.
   */
  async execute(action: BrowserAction, params: BrowserParams): Promise<string> {
    try {
      switch (action) {
        case 'search':
          return await this.search(params.query || '');

        case 'goto':
          return await this.goto(params.url || '');

        case 'get_text':
          return await this.getText();

        case 'screenshot':
          return await this.screenshot();

        case 'click':
          return await this.click(params.selector || params.text || '');

        case 'type':
          return await this.type(params.selector || '', params.text || '');

        case 'scroll_down':
          return await this.scroll('down');

        case 'scroll_up':
          return await this.scroll('up');

        case 'back':
          return await this.back();

        case 'wait':
          await new Promise(r => setTimeout(r, 2000));
          return 'Waited 2 seconds.';

        default:
          return `Unknown browser action: ${action}`;
      }
    } catch (err: any) {
      log.agents.error({ err, action, params }, 'Browser session error');
      return `Browser error: ${err.message || 'Unknown error'}`;
    }
  }

  /** Close the browser session */
  async close(): Promise<void> {
    if (this.stagehand) {
      try {
        await this.stagehand.close();
      } catch { /* ignore */ }
      this.stagehand = null;
      this.page = null;
    }
  }

  /** Check if the browser is open */
  isOpen(): boolean {
    return this.stagehand !== null;
  }

  // ── Actions ──

  /** Search the web via DuckDuckGo Lite (no browser needed — fast) */
  private async search(query: string): Promise<string> {
    if (!query) return 'Error: query is required for search action';

    const encodedQuery = encodeURIComponent(query);
    const url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;

    const html = await withRetry(
      async () => {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      },
      { maxAttempts: 2, minDelay: 500 },
    );

    const results = parseDDGResults(html).slice(0, 8);
    if (results.length === 0) return 'No search results found.';

    return results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
    ).join('\n\n');
  }

  /** Navigate to a URL and return page text */
  private async goto(url: string): Promise<string> {
    if (!url) return 'Error: url is required for goto action';

    const check = validateUrl(url);
    if (!check.valid) return `Error: URL blocked — ${check.reason}`;

    this.currentUrl = url;

    // Try fast text extraction first (no browser needed)
    const text = await this.fetchAndExtract(url);
    if (text) return text;

    // Fall back to real browser
    await this.ensureBrowser();
    await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    return await this.extractPageText();
  }

  /** Get text content of the current page */
  private async getText(): Promise<string> {
    if (!this.page && this.currentUrl) {
      // If no browser, try scraping
      const text = await this.fetchAndExtract(this.currentUrl);
      return text || 'No page loaded. Use goto first.';
    }
    if (!this.page) return 'No page loaded. Use goto first.';
    return await this.extractPageText();
  }

  /** Take a screenshot of the current page (base64) */
  private async screenshot(): Promise<string> {
    if (!this.page && this.currentUrl) {
      await this.ensureBrowser();
      await this.page!.goto(this.currentUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    }
    if (!this.page) return 'No page loaded. Use goto first.';

    const buffer = await this.page.screenshot({ fullPage: false });
    const base64 = buffer.toString('base64');
    this.screenshotSeq++;

    return `[Screenshot captured (${Math.round(buffer.length / 1024)}KB). Current URL: ${this.page.url()}]`;
  }

  /** Click an element described by selector or natural language */
  private async click(target: string): Promise<string> {
    if (!target) return 'Error: selector or description required for click action';

    await this.ensureBrowser();
    if (!this.page) return 'No page loaded. Use goto first.';

    await this.stagehand!.act(`Click on "${target}"`);
    await this.page.waitForTimeout(1000);

    return `Clicked: "${target}". Current URL: ${this.page.url()}`;
  }

  /** Type text into a form field */
  private async type(selector: string, text: string): Promise<string> {
    if (!text) return 'Error: text is required for type action';

    await this.ensureBrowser();
    if (!this.page) return 'No page loaded. Use goto first.';

    if (selector) {
      await this.stagehand!.act(`Type "${text}" into the ${selector} field`);
    } else {
      await this.stagehand!.act(`Type "${text}" into the focused input`);
    }

    return `Typed: "${text}"`;
  }

  /** Scroll the page */
  private async scroll(direction: 'up' | 'down'): Promise<string> {
    await this.ensureBrowser();
    if (!this.page) return 'No page loaded. Use goto first.';

    const delta = direction === 'down' ? 600 : -600;
    await this.page.mouse.wheel(0, delta);
    await this.page.waitForTimeout(500);

    return `Scrolled ${direction}.`;
  }

  /** Go back in browser history */
  private async back(): Promise<string> {
    await this.ensureBrowser();
    if (!this.page) return 'No page loaded. Use goto first.';

    await this.page.goBack({ timeout: PAGE_TIMEOUT });
    return `Navigated back. Current URL: ${this.page.url()}`;
  }

  // ── Internal ──

  /** Initialize Stagehand/Playwright browser lazily */
  private async ensureBrowser(): Promise<void> {
    if (this.stagehand) return;

    const serviceSecret = process.env.SERVICE_SECRET;
    const aliaApiUrl = process.env.ALIA_API_URL || 'http://localhost:3001';

    this.stagehand = new Stagehand({
      env: 'LOCAL',
      localBrowserLaunchOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
      ...(serviceSecret ? {
        model: {
          modelName: 'openai/alia-lite',
          apiKey: serviceSecret,
          baseURL: `${aliaApiUrl}/v1`,
        },
      } : {}),
    });

    await this.stagehand.init();
    this.page = this.stagehand.context.pages()[0] as unknown as Page;

    log.agents.info('Browser session initialized');
  }

  /** Fast text extraction without browser (Readability + regex fallback) */
  private async fetchAndExtract(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AliaBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;

      const html = await response.text();

      // Try Readability first
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      if (article?.textContent && article.textContent.length > 100) {
        const content = truncate(article.textContent.trim(), MAX_CONTENT_CHARS);
        return `# ${article.title || url}\n\n${content}`;
      }

      // Fallback to regex extraction
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 100) {
        return truncate(text, MAX_CONTENT_CHARS);
      }

      return null; // Too little content — need real browser
    } catch {
      return null; // Fetch failed — try real browser
    }
  }

  /** Extract text from the current Playwright page */
  private async extractPageText(): Promise<string> {
    if (!this.page) return '';

    const title = await this.page.title();
    const text = await this.page.evaluate(() => {
      // Remove noise elements
      const remove = document.querySelectorAll('script, style, nav, footer, header, aside, [role="banner"], [role="navigation"]');
      remove.forEach(el => el.remove());
      return document.body?.innerText || '';
    });

    const content = truncate(text.trim(), MAX_CONTENT_CHARS);
    return `# ${title}\nURL: ${this.page.url()}\n\n${content}`;
  }
}

// ── Helpers ──

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n[Content truncated]';
}

/** Parse DuckDuckGo Lite HTML into search results */
function parseDDGResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  const allLinks = doc.querySelectorAll('a.result-link');
  for (const linkEl of allLinks) {
    const parentTr = linkEl.closest('tr');
    if (parentTr?.classList.contains('result-sponsored')) continue;

    const title = linkEl.textContent?.trim() || '';
    let url = linkEl.getAttribute('href') || '';

    if (url.includes('uddg=')) {
      try {
        const parsed = new URL(url, 'https://duckduckgo.com');
        url = decodeURIComponent(parsed.searchParams.get('uddg') || url);
      } catch { /* keep original */ }
    }

    if (!title || !url || !url.startsWith('http')) continue;

    let snippet = '';
    let nextTr = parentTr?.nextElementSibling;
    while (nextTr) {
      const snippetTd = nextTr.querySelector('td.result-snippet');
      if (snippetTd) {
        snippet = snippetTd.textContent?.trim() || '';
        break;
      }
      if (nextTr.querySelector('a.result-link')) break;
      nextTr = nextTr.nextElementSibling;
    }

    results.push({ title, url, snippet });
  }

  return results;
}
