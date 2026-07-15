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
import { getErrorMessage } from '../errors/index.js';
import { emitAgentActivity } from '../../socket.js';

const MAX_CONTENT_CHARS = 12_000;
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

/** Actions that auto-capture a screenshot for model vision */
const INTERACTIVE_ACTIONS: ReadonlySet<BrowserAction> = new Set(['click', 'type', 'scroll_down', 'scroll_up', 'back', 'goto']);

export interface BrowserParams {
  url?: string;
  selector?: string;
  text?: string;
  query?: string;
}

export interface BrowserSessionOpts {
  agentId?: string;
  sessionId?: string;
}

export class BrowserSession {
  private stagehand: Stagehand | null = null;
  private page: Page | null = null;
  private currentUrl = '';
  private screenshotSeq = 0;
  private agentId?: string;
  private sessionId?: string;

  constructor(opts?: BrowserSessionOpts) {
    this.agentId = opts?.agentId;
    this.sessionId = opts?.sessionId;
  }

  /**
   * Pre-initialize the browser in the background.
   * Call this early when the task likely needs browser interaction.
   * Safe to call multiple times — only the first call initializes.
   */
  preInit(): void {
    this.ensureBrowser().catch(err =>
      log.agents.warn({ err }, 'Browser pre-init failed (will retry on first use)'),
    );
  }

  /**
   * Execute a browser action. Initializes the browser lazily on first interactive action.
   */
  async execute(action: BrowserAction, params: BrowserParams): Promise<string> {
    try {
      let result: string;
      switch (action) {
        case 'search':
          return await this.search(params.query || '');

        case 'goto':
          result = await this.goto(params.url || '');
          break;

        case 'get_text':
          return await this.getText();

        case 'screenshot':
          return await this.screenshot();

        case 'click':
          result = await this.click(params.selector || params.text || '');
          break;

        case 'type':
          result = await this.type(params.selector || '', params.text || '');
          break;

        case 'scroll_down':
          result = await this.scroll('down');
          break;

        case 'scroll_up':
          result = await this.scroll('up');
          break;

        case 'back':
          result = await this.back();
          break;

        case 'wait':
          await new Promise(r => setTimeout(r, 2000));
          return 'Waited 2 seconds.';

        default:
          return `Unknown browser action: ${action}`;
      }

      // Auto-screenshot after interactive actions so the model can see the result
      if (INTERACTIVE_ACTIONS.has(action) && this.page && !result.startsWith('Error')) {
        try {
          await this.screenshot();
          result += '\n[Auto-screenshot captured — visible in your next message as an image.]';
        } catch {
          // Non-critical — continue without screenshot
        }
      }

      return result;
    } catch (err: unknown) {
      log.agents.error({ err, action, params }, 'Browser session error');
      return `Browser error: ${getErrorMessage(err)}`;
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

  /** The most recent screenshot base64 — available for vision model injection */
  private _lastScreenshotBase64: string | null = null;

  /** Consume the last screenshot (returns it and clears the internal reference). */
  consumeLastScreenshot(): string | null {
    const shot = this._lastScreenshotBase64;
    this._lastScreenshotBase64 = null;
    return shot;
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
    this._lastScreenshotBase64 = base64;

    const pageUrl = this.page.url();

    // Stream screenshot to frontend via Socket.IO
    if (this.agentId && this.sessionId) {
      emitAgentActivity(this.agentId, {
        type: 'screenshot',
        content: `Screenshot of ${pageUrl}`,
        timestamp: Date.now(),
        sessionId: this.sessionId,
        data: { base64, url: pageUrl },
      });
    }

    return `[Screenshot captured (${Math.round(buffer.length / 1024)}KB). Current URL: ${pageUrl}]. The screenshot is included in your next message as an image.`;
  }

  /** Click an element described by selector or natural language */
  private async click(target: string): Promise<string> {
    if (!target) return 'Error: selector or description required for click action';

    await this.ensureBrowser();
    if (!this.page) return 'No page loaded. Use goto first.';

    // Try Stagehand NL action first, fall back to JS injection
    try {
      await this.stagehand!.act(`Click on "${target}"`);
      await this.page.waitForTimeout(1000);
      return `Clicked: "${target}". Current URL: ${this.page.url()}`;
    } catch (nlErr: unknown) {
      log.agents.warn({ err: nlErr, target }, 'Browser: Stagehand click failed, trying JS fallback');
      try {
        // Fallback: find element by text content, aria-label, or CSS selector
        const clicked = await this.page.evaluate((t: string) => {
          // Try as CSS selector first
          try {
            const el = document.querySelector(t) as HTMLElement;
            if (el) { el.click(); return true; }
          } catch { /* not a valid selector */ }
          // Try finding by text content
          const allElements = document.querySelectorAll('a, button, [role="button"], input[type="submit"], [onclick]');
          for (const el of allElements) {
            const text = (el as HTMLElement).innerText?.trim() || el.getAttribute('aria-label') || '';
            if (text.toLowerCase().includes(t.toLowerCase())) {
              (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, target);

        if (clicked) {
          await this.page.waitForTimeout(1000);
          return `Clicked (JS fallback): "${target}". Current URL: ${this.page.url()}`;
        }
        return `Failed to click "${target}": element not found (tried Stagehand NL + JS fallback)`;
      } catch (jsErr: unknown) {
        return `Browser error clicking "${target}": ${getErrorMessage(nlErr)}, JS fallback also failed: ${getErrorMessage(jsErr)}`;
      }
    }
  }

  /** Type text into a form field */
  private async type(selector: string, text: string): Promise<string> {
    if (!text) return 'Error: text is required for type action';

    await this.ensureBrowser();
    if (!this.page) return 'No page loaded. Use goto first.';

    // Try Stagehand NL action first, fall back to JS injection
    try {
      if (selector) {
        await this.stagehand!.act(`Type "${text}" into the ${selector} field`);
      } else {
        await this.stagehand!.act(`Type "${text}" into the focused input`);
      }
      return `Typed: "${text}"`;
    } catch (nlErr: unknown) {
      log.agents.warn({ err: nlErr, selector, text: text.slice(0, 50) }, 'Browser: Stagehand type failed, trying JS fallback');
      try {
        // Fallback: find input by selector, placeholder, or label
        const typed = await this.page.evaluate(({ sel, val }: { sel: string; val: string }) => {
          let input: HTMLElement | null = null;
          // Try CSS selector
          if (sel) {
            try { input = document.querySelector(sel) as HTMLElement; } catch { /* not valid */ }
          }
          // Try by placeholder or aria-label
          if (!input && sel) {
            const inputs = document.querySelectorAll('input, textarea, [contenteditable]');
            for (const el of inputs) {
              const placeholder = el.getAttribute('placeholder') || '';
              const label = el.getAttribute('aria-label') || '';
              if (placeholder.toLowerCase().includes(sel.toLowerCase()) || label.toLowerCase().includes(sel.toLowerCase())) {
                input = el as HTMLElement;
                break;
              }
            }
          }
          // Fallback to currently focused element
          if (!input) input = document.activeElement as HTMLElement;
          if (!input) return false;

          if ('value' in input) {
            (input as HTMLInputElement).value = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          if (input.isContentEditable) {
            input.textContent = val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
          return false;
        }, { sel: selector, val: text });

        if (typed) return `Typed (JS fallback): "${text}"`;
        return `Failed to type "${text}": no suitable input found`;
      } catch (jsErr: unknown) {
        return `Browser error typing "${text}": ${getErrorMessage(nlErr)}, JS fallback also failed: ${getErrorMessage(jsErr)}`;
      }
    }
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

    const sh = new Stagehand({
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

    await sh.init();
    // Only assign after successful init so failed attempts can be retried
    this.stagehand = sh;
    this.page = sh.context.pages()[0] as unknown as Page;

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
