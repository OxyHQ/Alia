/**
 * Browser AI SDK tools — exposed to generateText() for web browsing during conversations.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getOrCreateContext, takeScreenshot, closeContext } from './manager';

/**
 * Get browser tools for a specific session.
 * Each session gets its own isolated browser context.
 */
export function getBrowserTools(sessionId: string) {
  return {
    web_navigate: tool({
      description: 'Navigate the browser to a URL. Returns the page title and a text summary of the page content.',
      inputSchema: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
      execute: async ({ url }) => {
        const { page } = await getOrCreateContext(sessionId);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const title = await page.title();
        const text = await page.evaluate(() => {
          const body = document.body;
          body.querySelectorAll('script, style, noscript').forEach((el: Element) => el.remove());
          return body.innerText.slice(0, 8000);
        });
        broadcastEvent(sessionId, 'browser', { action: 'navigate', url, title });
        return { title, url: page.url(), text };
      },
    }),

    web_click: tool({
      description: 'Click on an element on the page by CSS selector or text content.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or text to click on (e.g., "button.submit" or "text=Sign In")'),
      }),
      execute: async ({ selector }) => {
        const { page } = await getOrCreateContext(sessionId);
        await page.click(selector, { timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        broadcastEvent(sessionId, 'browser', { action: 'click', selector });
        return { clicked: selector, currentUrl: page.url() };
      },
    }),

    web_type: tool({
      description: 'Type text into an input field on the page.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector for the input element'),
        text: z.string().describe('Text to type'),
      }),
      execute: async ({ selector, text }) => {
        const { page } = await getOrCreateContext(sessionId);
        await page.fill(selector, text, { timeout: 5000 });
        broadcastEvent(sessionId, 'browser', { action: 'type', selector });
        return { typed: text.length + ' characters', selector };
      },
    }),

    web_extract: tool({
      description: 'Extract text content from the current page, optionally from a specific CSS selector.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector to extract from (defaults to full page body)'),
      }),
      execute: async ({ selector }) => {
        const { page } = await getOrCreateContext(sessionId);
        let text: string;
        if (selector) {
          text = await page.locator(selector).first().innerText({ timeout: 5000 });
        } else {
          text = await page.evaluate(() => {
            document.querySelectorAll('script, style, noscript').forEach((el: Element) => el.remove());
            return document.body.innerText.slice(0, 8000);
          });
        }
        return { text, url: page.url() };
      },
    }),

    web_screenshot: tool({
      description: 'Take a screenshot of the current browser page.',
      inputSchema: z.object({}),
      execute: async () => {
        const screenshot = await takeScreenshot(sessionId);
        if (!screenshot) return { error: 'No active browser session' };
        const base64 = screenshot.toString('base64');
        broadcastEvent(sessionId, 'screenshot', { data: base64 });
        return { screenshot: `data:image/jpeg;base64,${base64}`, url: '' };
      },
    }),

    web_close: tool({
      description: 'Close the browser session.',
      inputSchema: z.object({}),
      execute: async () => {
        await closeContext(sessionId);
        broadcastEvent(sessionId, 'browser', { action: 'close' });
        return { closed: true };
      },
    }),
  };
}

function broadcastEvent(sessionId: string, type: string, data: any) {
  const wss = (global as any).__wss;
  if (!wss) return;
  const message = JSON.stringify({ type, sessionId, ...data });
  for (const client of wss.clients) {
    if ((client as any).sessionId === sessionId && client.readyState === 1) {
      client.send(message);
    }
  }
}
