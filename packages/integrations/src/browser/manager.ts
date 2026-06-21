/**
 * Browser Manager — Playwright lifecycle management.
 * Lazy-launches Chromium on first use, manages a pool of browser contexts.
 */

import type { Browser, BrowserContext, Page } from 'playwright';

let browser: Browser | null = null;
const contexts = new Map<string, { context: BrowserContext; page: Page; lastUsed: number }>();

const MAX_CONTEXTS = 5;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function ensureBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;

  const { chromium } = await import('playwright');
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  console.log('[Browser] Chromium launched');
  return browser;
}

export async function getOrCreateContext(sessionId: string): Promise<{ context: BrowserContext; page: Page }> {
  const existing = contexts.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return { context: existing.context, page: existing.page };
  }

  // Evict oldest if at capacity
  if (contexts.size >= MAX_CONTEXTS) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, ctx] of contexts) {
      if (ctx.lastUsed < oldestTime) {
        oldestTime = ctx.lastUsed;
        oldest = id;
      }
    }
    if (oldest) await closeContext(oldest);
  }

  const b = await ensureBrowser();
  const context = await b.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  contexts.set(sessionId, { context, page, lastUsed: Date.now() });
  return { context, page };
}

export async function closeContext(sessionId: string): Promise<void> {
  const entry = contexts.get(sessionId);
  if (entry) {
    await entry.context.close().catch(() => {});
    contexts.delete(sessionId);
  }
}

export async function takeScreenshot(sessionId: string): Promise<Buffer | null> {
  const entry = contexts.get(sessionId);
  if (!entry) return null;
  return entry.page.screenshot({ type: 'jpeg', quality: 70 });
}

export async function shutdown(): Promise<void> {
  for (const [id] of contexts) {
    await closeContext(id);
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// Periodic cleanup of idle contexts
setInterval(() => {
  const now = Date.now();
  for (const [id, ctx] of contexts) {
    if (now - ctx.lastUsed > IDLE_TIMEOUT_MS) {
      closeContext(id).catch(() => {});
    }
  }
}, 60_000);
