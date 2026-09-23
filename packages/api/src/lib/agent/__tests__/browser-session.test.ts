/**
 * The runner's `browser` primitive is Clarity-only, and this is the freeze.
 *
 * It used to fall back to Stagehand driving a local Chromium and to offer
 * screenshot, click, type, scroll and back on top of it. The runtime image
 * ships no Chromium, so every one of those failed at launch in production. What
 * is left must work in that image: three actions, each a Clarity call, with
 * `validateUrl` in front of anything a model hands it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clarity = vi.hoisted(() => ({
  search: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../clarity-client.js', () => ({
  clarityClient: () => ({ search: clarity.search, indexing: { resolve: clarity.resolve } }),
}));
// DNS is the network's, not this test's: every public name here resolves as
// public. The private-address case is refused by `validateUrl`'s own IP check,
// before any lookup.
vi.mock('../../public-host.js', async () => ({
  ...(await vi.importActual<typeof import('../../public-host.js')>('../../public-host.js')),
  classifyHost: vi.fn(async () => 'ok'),
}));
vi.mock('../../logger.js', () => ({ log: { agents: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } }));

const { BROWSER_ACTIONS, BrowserSession } = await import('../browser-session.js');

function document(url: string, content: string) {
  return { data: [{ document: { title: 'A page', canonicalUrl: url, content } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the Clarity-only browser', () => {
  it('offers exactly search, goto and get_text', () => {
    expect([...BROWSER_ACTIONS]).toEqual(['search', 'goto', 'get_text']);
  });

  it('searches through Clarity', async () => {
    clarity.search.mockResolvedValue({
      data: [{ title: 'Alia', canonicalUrl: 'https://alia.onl/', snippet: 'the assistant' }],
    });

    const result = await new BrowserSession().execute('search', { query: 'alia' });

    expect(clarity.search).toHaveBeenCalledWith({ query: 'alia', mode: 'hybrid', limit: 8 });
    expect(result).toContain('https://alia.onl/');
  });

  it('reads a page with goto and again with get_text, both through Clarity', async () => {
    clarity.resolve.mockResolvedValue(document('https://example.com/', 'hello world'));
    const session = new BrowserSession();

    expect(await session.execute('get_text', {})).toBe('No page loaded. Use goto first.');
    const first = await session.execute('goto', { url: 'https://example.com/' });
    const again = await session.execute('get_text', {});

    expect(first).toContain('hello world');
    expect(again).toBe(first);
    expect(clarity.resolve).toHaveBeenCalledTimes(2);
    expect(clarity.resolve).toHaveBeenCalledWith({ urls: ['https://example.com/'], waitMs: 8_000 });
  });

  it('refuses a private address before Clarity is asked anything', async () => {
    const result = await new BrowserSession().execute('goto', { url: 'http://169.254.169.254/latest/meta-data' });

    expect(result).toMatch(/^Error: URL blocked/);
    expect(clarity.resolve).not.toHaveBeenCalled();
  });

  it('says so when Clarity cannot read a page, rather than reaching for a browser', async () => {
    clarity.resolve.mockResolvedValue({ data: [{ status: 'failed' }] });

    const result = await new BrowserSession().execute('goto', { url: 'https://example.com/app' });

    expect(result).toContain('Clarity could not extract readable text');
  });

  it('answers an action it no longer has with the ones it does', async () => {
    const result = await new BrowserSession().execute('screenshot' as never, {});
    expect(result).toContain('Use search, goto or get_text');
  });

  it('depends on no local browser automation, in source or in the manifest', () => {
    const source = readFileSync(path.resolve(__dirname, '../browser-session.ts'), 'utf8');
    expect(source).not.toMatch(/from '@browserbasehq\/stagehand'|from 'playwright'/);

    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(declared)).not.toContain('@browserbasehq/stagehand');
    expect(Object.keys(declared)).not.toContain('playwright');
    // The floor: the manifest parsed and is the API's.
    expect(Object.keys(declared)).toContain('@clarity.surf/sdk');
  });
});
