import { describe, expect, it } from 'vitest';
import worker from '../worker/index.js';

/**
 * alia.onl was once the gemies' home too: a gemie's thread was `/@pepe`, its page `/@pepe/details`,
 * the catalogue `/agents`. The app is Alia's alone now (Gemies ADR 0034), so every one of those
 * addresses, in every link copied from them, moves permanently to the same path on gemies.ai.
 */

/** An asset server that serves the shell for every path, and records what it was asked for. */
function assets() {
  const asked: string[] = [];
  return {
    asked,
    binding: {
      async fetch(request: Request) {
        asked.push(new URL(request.url).pathname);
        return new Response('<!doctype html>shell', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
  };
}

const get = (path: string, method = 'GET') => new Request(`https://alia.onl${path}`, { method });

describe('the Worker and an address that lives in Gemies', () => {
  it.each([
    '/@pepe',
    '/@pepe?threadId=t1',
    '/@pepe/details',
    '/@pepe/edit',
    '/agents',
    '/agents/computer/a1',
    '/agents/session/s1',
  ])('sends %s to the same address on gemies.ai, permanently', async (path) => {
    const { binding, asked } = assets();
    const response = await worker.fetch(get(path), { ASSETS: binding });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(`https://gemies.ai${path}`);
    // Nothing of Alia's is served for it.
    expect(asked).toEqual([]);
  });

  it("leaves Alia's own paths to the asset server, a lookalike included", async () => {
    const { binding, asked } = assets();
    for (const path of ['/', '/c/abc', '/agentsx', '/settings/skills', '/shared/t1']) {
      const response = await worker.fetch(get(path), { ASSETS: binding });
      expect(response.status, path).toBe(200);
    }
    expect(asked).toEqual(['/', '/c/abc', '/agentsx', '/settings/skills', '/shared/t1']);
  });

  it('does not take over a request that is not a read', async () => {
    const { binding, asked } = assets();
    await worker.fetch(get('/@pepe', 'POST'), { ASSETS: binding });
    expect(asked).toEqual(['/@pepe']);
  });
});
