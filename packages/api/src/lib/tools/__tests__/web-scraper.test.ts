/**
 * `webScraper` used to fail 3 of 3 in production with "Clarity is still indexing
 * this page (operation …)": the operation is asynchronous and the tool returned
 * the first answer. It now waits for the operation, and only a deadline or a
 * failed operation is an error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const clarity = vi.hoisted(() => ({ resolve: vi.fn(), operationsGet: vi.fn(), byUrl: vi.fn() }));

vi.mock('../../clarity-client.js', () => ({
  clarityClient: () => ({
    indexing: { resolve: clarity.resolve },
    operations: { get: clarity.operationsGet },
    documents: { byUrl: clarity.byUrl },
  }),
}));
vi.mock('../sandbox.js', () => ({ validateUrl: vi.fn(async () => ({ valid: true })) }));
vi.mock('../../logger.js', () => ({ log: { tools: { error: vi.fn() } } }));

const { readWebPage, webScraperTool } = await import('../web-scraper.js');

const URL_ = 'https://example.com/a';
const document = {
  id: 'd1',
  title: 'A',
  canonicalUrl: URL_,
  content: 'body text',
  authors: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readWebPage', () => {
  it('returns the page once the indexing operation finishes', async () => {
    clarity.resolve.mockResolvedValue({
      data: [{ url: URL_, status: 'queued', operationId: 'op-1' }],
    });
    clarity.operationsGet
      .mockResolvedValueOnce({ id: 'op-1', status: 'running' })
      .mockResolvedValueOnce({ id: 'op-1', status: 'succeeded' });
    clarity.byUrl.mockResolvedValue(document);

    const result = await readWebPage(URL_);

    expect(result).toMatchObject({ documentId: 'd1', content: 'body text', url: URL_ });
    expect(clarity.operationsGet).toHaveBeenCalledTimes(2);
  });

  it('answers with a typed failure when the indexing operation fails', async () => {
    clarity.resolve.mockResolvedValue({
      data: [{ url: URL_, status: 'queued', operationId: 'op-1' }],
    });
    clarity.operationsGet.mockResolvedValue({ id: 'op-1', status: 'failed' });
    clarity.byUrl.mockRejectedValue(new Error('404'));

    const result = await readWebPage(URL_);

    expect(result).toMatchObject({ reason: 'operation_failed' });
    expect(JSON.stringify(result)).not.toContain('still indexing');
  });

  it('cancels with the turn: the tool passes the AI SDK abort signal down', async () => {
    const turn = new AbortController();
    clarity.resolve.mockImplementation(async (_req: unknown, options: { signal: AbortSignal }) => {
      turn.abort(new Error('turn cancelled'));
      if (options.signal.aborted) throw options.signal.reason;
      return { data: [] };
    });

    const result = await webScraperTool.execute?.(
      { url: URL_, extractLinks: false },
      { abortSignal: turn.signal, toolCallId: 't', messages: [] },
    );

    expect(result).toMatchObject({ error: expect.stringContaining('turn cancelled') });
  });
});
